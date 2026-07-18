import type { BrowserContext, Page, ConsoleMessage } from "playwright";
import { log } from "../logger.js";
import { RingBuffer } from "./ring-buffer.js";

/** Lazily loads Playwright so the server still starts (and other tools work)
 * when the browser runtime isn't installed yet — the failure surfaces as a
 * clear tool error instead of a startup crash. */
async function loadChromium() {
  try {
    const pw = await import("playwright");
    return pw.chromium;
  } catch {
    throw new Error(
      "Playwright is not installed. Run the command \"Agent Eye: Install Browser Runtime\" " +
        "(or `npm i playwright && npx playwright install chromium`) and try again."
    );
  }
}

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
/** Injected into every page so the user can see where the agent is "pointing".
 * Playwright injects synthetic input and does NOT move the OS pointer, so this
 * overlay IS the visible cursor: a pulsing dot that follows the automated mouse
 * and shows a ripple on click. Renders on top of everything, intercepts nothing. */
const CURSOR_SCRIPT = `(() => {
  if (window.__agentEyeCursor) return;
  window.__agentEyeCursor = true;
  const install = () => {
    if (!document.body) { requestAnimationFrame(install); return; }
    const style = document.createElement('style');
    style.textContent =
      '@keyframes ae-pulse{0%{box-shadow:0 0 0 0 rgba(255,60,60,.55)}70%{box-shadow:0 0 0 16px rgba(255,60,60,0)}100%{box-shadow:0 0 0 0 rgba(255,60,60,0)}}' +
      '@keyframes ae-ripple{from{opacity:.85;transform:translate(-50%,-50%) scale(.3)}to{opacity:0;transform:translate(-50%,-50%) scale(2.6)}}';
    document.head.appendChild(style);
    const dot = document.createElement('div');
    dot.id = '__agent_eye_cursor';
    dot.style.cssText =
      'position:fixed;z-index:2147483647;left:50%;top:50%;width:24px;height:24px;border-radius:50%;' +
      'background:rgba(255,60,60,.7);border:2px solid #fff;pointer-events:none;' +
      'transform:translate(-50%,-50%);transition:left .12s ease-out,top .12s ease-out;' +
      'animation:ae-pulse 1.5s infinite;box-shadow:0 0 12px rgba(0,0,0,.5)';
    document.body.appendChild(dot);
    addEventListener('mousemove', (e) => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.style.cssText =
        'position:fixed;z-index:2147483646;left:' + e.clientX + 'px;top:' + e.clientY + 'px;' +
        'width:22px;height:22px;border-radius:50%;background:rgba(255,60,60,.45);pointer-events:none;' +
        'animation:ae-ripple .5s ease-out forwards';
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 520);
    }, true);
  };
  install();
})()`;

export class BrowserManager {
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private readonly consoleBuffer = new RingBuffer<ConsoleEntry>(CONSOLE_CAPACITY);
  private readonly networkBuffer = new RingBuffer<NetworkEntry>(NETWORK_CAPACITY);
  private readonly showCursor = process.env.AGENT_EYE_SHOW_CURSOR === "1";
  private readonly slowMo = Number(process.env.AGENT_EYE_SLOWMO) || 0;

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
      const chromium = await loadChromium();
      this.context = await chromium.launchPersistentContext(this.profileDir, {
        // Headed by default so the user can watch (the whole point). The env
        // knob enables headless for CI / remote environments (plan v1.1).
        headless: process.env.AGENT_EYE_HEADLESS === "1",
        // slowMo paces actions so a human can follow along when watching.
        slowMo: this.slowMo,
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

    const context = this.context;
    if (this.showCursor) {
      await context.addInitScript(CURSOR_SCRIPT);
    }

    const pages = context.pages();
    this.page = pages.length > 0 ? pages[0] : await context.newPage();
    this.attachListeners(this.page);
    return this.page;
  }

  /** Animate the (real) mouse to an element's centre so the visible cursor
   * glides there before acting — only when the watch-along cursor is enabled. */
  private async moveCursorTo(page: Page, locator: ReturnType<Page["locator"]>): Promise<void> {
    if (!this.showCursor) return;
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
      const box = await locator.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 });
      }
    } catch {
      /* cursor animation is best-effort; never block the real action */
    }
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
    if (this.showCursor) {
      // Nudge the mouse so the overlay cursor appears immediately, and glide it
      // in so the user can spot it before any interaction.
      const vp = page.viewportSize() ?? { width: 1280, height: 800 };
      await page.mouse.move(vp.width / 2, vp.height / 2, { steps: 12 }).catch(() => undefined);
    }
    return { url: page.url(), title: await page.title() };
  }

  async click(refOrSelector: string): Promise<void> {
    const page = await this.ensurePage();
    const locator = this.locate(page, refOrSelector);
    await this.moveCursorTo(page, locator);
    await locator.click({ timeout: 10_000 });
  }

  async type(refOrSelector: string, text: string, submit: boolean): Promise<void> {
    const page = await this.ensurePage();
    const locator = this.locate(page, refOrSelector);
    await this.moveCursorTo(page, locator);
    await locator.fill(text, { timeout: 10_000 });
    if (submit) await locator.press("Enter");
  }

  /** Click at absolute viewport coordinates. Essential for canvas-rendered UIs
   * (Flutter web / WebGL / games) where there is no DOM element to target — the
   * agent reads a screenshot, estimates the coordinate, and clicks it. */
  async clickAt(x: number, y: number): Promise<void> {
    const page = await this.ensurePage();
    if (this.showCursor) {
      await page.mouse.move(x, y, { steps: 20 }).catch(() => undefined);
    }
    await page.mouse.click(x, y);
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
