import {
  chromium,
  type BrowserContext,
  type Page,
  type ConsoleMessage,
} from "playwright";
import { log } from "../logger.js";
import { RingBuffer } from "./ring-buffer.js";

export interface ConsoleEntry {
  timestamp: string;
  type: string;
  text: string;
  location?: string;
}

export interface NetworkEntry {
  timestamp: string;
  method: string;
  url: string;
  status: number;
  resourceType: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  failure?: string;
}

const CONSOLE_CAPACITY = 500;
const NETWORK_CAPACITY = 500;
/** Truncate any single console message so one huge log can't blow the buffer. */
const MAX_CONSOLE_TEXT = 4000;

/**
 * Owns the headed Playwright browser (plan 7.2: dedicated profile, never the
 * user's real one). Launches lazily on first use, captures console + network
 * into bounded ring buffers, and exposes an accessibility snapshot as the
 * agent's primary "eyes" (structured, cheap, no vision model needed).
 */
export class BrowserManager {
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private readonly consoleBuffer = new RingBuffer<ConsoleEntry>(CONSOLE_CAPACITY);
  private readonly networkBuffer = new RingBuffer<NetworkEntry>(NETWORK_CAPACITY);

  constructor(
    private readonly profileDir: string,
    private readonly channel: string | undefined
  ) {}

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;

    if (!this.context) {
      log.info("Launching browser", {
        profileDir: this.profileDir,
        channel: this.channel ?? "bundled-chromium",
      });
      this.context = await chromium.launchPersistentContext(this.profileDir, {
        // Headed by default so the user can watch (the whole point). The env
        // knob enables headless for CI / remote environments (plan v1.1).
        headless: process.env.AGENT_EYE_HEADLESS === "1",
        channel: this.channel,
        viewport: { width: 1280, height: 800 },
        // Harden the profile: no password manager, autofill, or account sync,
        // so the agent never gains access to saved credentials (plan 7.2).
        args: [
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-save-password-bubble",
          "--disable-features=PasswordManager,AutofillServerCommunication,Translate,AccountConsistency,SyncDisabledTests",
        ],
        ignoreDefaultArgs: ["--enable-automation"],
      });
    }

    const pages = this.context.pages();
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
    this.attachListeners(this.page);
    return this.page;
  }

  private attachListeners(page: Page): void {
    page.on("console", (msg: ConsoleMessage) => {
      const loc = msg.location();
      this.consoleBuffer.push({
        timestamp: new Date().toISOString(),
        type: msg.type(),
        text: truncate(msg.text(), MAX_CONSOLE_TEXT),
        location: loc.url ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : undefined,
      });
    });

    page.on("pageerror", (err) => {
      this.consoleBuffer.push({
        timestamp: new Date().toISOString(),
        type: "error",
        text: truncate(`${err.name}: ${err.message}\n${err.stack ?? ""}`, MAX_CONSOLE_TEXT),
      });
    });

    page.on("requestfinished", async (request) => {
      try {
        const response = await request.response();
        this.networkBuffer.push({
          timestamp: new Date().toISOString(),
          method: request.method(),
          url: request.url(),
          status: response ? response.status() : 0,
          resourceType: request.resourceType(),
          requestHeaders: safeHeaders(request.headers()),
          responseHeaders: response ? safeHeaders(response.headers()) : {},
        });
      } catch {
        /* request/response may be gone after navigation */
      }
    });

    page.on("requestfailed", (request) => {
      this.networkBuffer.push({
        timestamp: new Date().toISOString(),
        method: request.method(),
        url: request.url(),
        status: 0,
        resourceType: request.resourceType(),
        requestHeaders: safeHeaders(request.headers()),
        responseHeaders: {},
        failure: request.failure()?.errorText ?? "failed",
      });
    });
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    const page = await this.ensurePage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return { url: page.url(), title: await page.title() };
  }

  async click(refOrSelector: string): Promise<void> {
    const page = await this.ensurePage();
    await this.locate(page, refOrSelector).click({ timeout: 10_000 });
  }

  async type(refOrSelector: string, text: string, submit: boolean): Promise<void> {
    const page = await this.ensurePage();
    const locator = this.locate(page, refOrSelector);
    await locator.fill(text, { timeout: 10_000 });
    if (submit) await locator.press("Enter");
  }

  async reload(): Promise<{ url: string; title: string }> {
    const page = await this.ensurePage();
    await page.reload({ waitUntil: "domcontentloaded" });
    return { url: page.url(), title: await page.title() };
  }

  /**
   * Accessibility snapshot the agent uses to locate elements. Prefers
   * Playwright's AI snapshot (emits stable [ref=eN] handles) and falls back to
   * the public ARIA snapshot on older builds.
   */
  async snapshot(): Promise<string> {
    const page = await this.ensurePage();
    const forAi = (page as unknown as { _snapshotForAI?: () => Promise<string> })._snapshotForAI;
    if (typeof forAi === "function") {
      try {
        return await forAi.call(page);
      } catch (err) {
        log.debug("_snapshotForAI failed, falling back to ariaSnapshot", { error: String(err) });
      }
    }
    return await page.locator("body").ariaSnapshot();
  }

  async screenshot(fullPage: boolean): Promise<Buffer> {
    const page = await this.ensurePage();
    return await page.screenshot({ fullPage, type: "png" });
  }

  /** Arbitrary JS execution — only reachable when policy permits highRisk. */
  async evaluate(expression: string): Promise<unknown> {
    const page = await this.ensurePage();
    return await page.evaluate(expression);
  }

  getConsole(limit?: number): ConsoleEntry[] {
    return this.consoleBuffer.recent(limit);
  }

  getNetwork(limit?: number): NetworkEntry[] {
    return this.networkBuffer.recent(limit);
  }

  currentUrl(): string | undefined {
    return this.page && !this.page.isClosed() ? this.page.url() : undefined;
  }

  private locate(page: Page, refOrSelector: string) {
    const trimmed = refOrSelector.trim();
    const refMatch = /^(?:ref=|aria-ref=)?(e\d+)$/.exec(trimmed);
    if (refMatch) {
      return page.locator(`aria-ref=${refMatch[1]}`);
    }
    return page.locator(trimmed);
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = undefined;
      this.page = undefined;
    }
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… <truncated ${text.length - max} chars>` : text;
}

function safeHeaders(headers: Record<string, string>): Record<string, string> {
  // Headers arrive already redaction-free here; redaction is applied at read
  // time so the policy toggle takes effect without re-capturing.
  return headers;
}
