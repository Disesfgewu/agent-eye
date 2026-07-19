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
      'transform:translate(-50%,-50%);transition:left .25s ease-out,top .25s ease-out;' +
      'animation:ae-pulse 1.5s infinite;box-shadow:0 0 12px rgba(0,0,0,.5)';
    document.body.appendChild(dot);
    // The dot represents the AGENT's cursor. It is driven ONLY by explicit
    // agent moves — deliberately NOT by 'mousemove', so it never chases the
    // real user's mouse. CSS transition makes each set glide smoothly.
    window.__agentEyeMoveCursor = (x, y) => { dot.style.left = x + 'px'; dot.style.top = y + 'px'; };
    window.__agentEyeRipple = (x, y) => {
      const r = document.createElement('div');
      r.style.cssText =
        'position:fixed;z-index:2147483646;left:' + x + 'px;top:' + y + 'px;' +
        'width:22px;height:22px;border-radius:50%;background:rgba(255,60,60,.45);pointer-events:none;' +
        'animation:ae-ripple .5s ease-out forwards';
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 520);
    };
  };
  install();
})()`;

/** Live status banner: shows what the agent is doing right now, so the user can
 * follow the work as it happens (Antigravity-style narration). Exposes
 * window.__agentEyeSetStatus(text); auto-fades after a few seconds. */
const STATUS_SCRIPT = `(() => {
  if (window.__agentEyeStatusInstalled) return;
  window.__agentEyeStatusInstalled = true;
  let hideTimer;
  const ensure = () => {
    let el = document.getElementById('__agent_eye_status');
    if (el) return el;
    if (!document.body) return null;
    el = document.createElement('div');
    el.id = '__agent_eye_status';
    el.style.cssText =
      'position:fixed;z-index:2147483647;bottom:20px;left:50%;transform:translateX(-50%);' +
      'max-width:80vw;padding:8px 18px;border-radius:999px;background:rgba(15,23,42,.92);' +
      'color:#fff;font:600 13px/1.4 system-ui,sans-serif;letter-spacing:.2px;' +
      'box-shadow:0 4px 18px rgba(0,0,0,.35);pointer-events:none;display:flex;gap:8px;align-items:center;' +
      'opacity:0;transition:opacity .18s ease';
    el.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#f43f5e;flex:none;animation:aeStatusPulse 1.2s infinite"></span><span id="__agent_eye_status_text"></span>';
    const style = document.createElement('style');
    style.textContent = '@keyframes aeStatusPulse{0%,100%{opacity:1}50%{opacity:.35}}';
    document.head.appendChild(style);
    document.body.appendChild(el);
    return el;
  };
  window.__agentEyeSetStatus = (text) => {
    const el = ensure();
    if (!el) return;
    const t = document.getElementById('__agent_eye_status_text');
    if (t) t.textContent = String(text);
    el.style.opacity = '1';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { el.style.opacity = '0'; }, 5000);
  };
})()`;

/** Input lock: a transparent overlay + keyboard trap that blocks the real user
 * while the agent drives, plus a "🔒 controlled" ribbon. Exposes
 * window.__agentEyeUnlock()/__agentEyeLock() so the agent can momentarily lift
 * the lock for its OWN dispatched action (which would otherwise hit the overlay)
 * and restore it immediately after. Starts locked. */
const LOCK_SCRIPT = `(() => {
  if (window.__agentEyeLockInstalled) return;
  window.__agentEyeLockInstalled = true;
  let locked = true;
  const install = () => {
    if (!document.body) { requestAnimationFrame(install); return; }
    const ov = document.createElement('div');
    ov.id = '__agent_eye_lock_overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483645;background:transparent;cursor:not-allowed';
    document.body.appendChild(ov);
    const badge = document.createElement('div');
    badge.id = '__agent_eye_lock';
    badge.style.cssText = 'position:fixed;z-index:2147483646;top:12px;left:12px;padding:6px 12px;border-radius:8px;background:rgba(244,63,94,.95);color:#fff;font:700 12px/1 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.4);pointer-events:none;display:flex;gap:6px;align-items:center';
    badge.innerHTML = '<span>🔒</span><span>Agent Eye 控制中·請勿操作</span>';
    document.body.appendChild(badge);
    const apply = () => { ov.style.pointerEvents = locked ? 'auto' : 'none'; badge.style.opacity = locked ? '1' : '.4'; };
    apply();
    const trap = (e) => { if (locked) { e.preventDefault(); e.stopImmediatePropagation(); } };
    for (const t of ['keydown','keyup','keypress']) window.addEventListener(t, trap, true);
    window.__agentEyeLock = () => { locked = true; apply(); };
    window.__agentEyeUnlock = () => { locked = false; apply(); };
  };
  install();
})()`;

const isHeadless = () => process.env.AGENT_EYE_HEADLESS === "1";

export class BrowserManager {
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private readonly consoleBuffer = new RingBuffer<ConsoleEntry>(CONSOLE_CAPACITY);
  private readonly networkBuffer = new RingBuffer<NetworkEntry>(NETWORK_CAPACITY);
  private readonly showCursor = process.env.AGENT_EYE_SHOW_CURSOR === "1";
  private readonly slowMo = Number(process.env.AGENT_EYE_SLOWMO) || 0;
  // Lock real user input while the agent drives (headed only, default on).
  // Cross-platform: uses CDP Input.setIgnoreInputEvents — blocks hardware
  // mouse/keyboard but lets the agent's dispatched events through.
  private readonly inputLock =
    process.env.AGENT_EYE_INPUT_LOCK === "1" ||
    (!isHeadless() && process.env.AGENT_EYE_INPUT_LOCK !== "0");

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
      // If the user closes the browser window (or it crashes), the context
      // object we're holding is now dead but stays non-undefined — without
      // this, every future call would keep reusing it and fail with "Target
      // page, context or browser has been closed". Drop our refs so the next
      // ensurePage() relaunches a fresh browser instead.
      this.context.on("close", () => {
        this.context = undefined;
        this.page = undefined;
      });
    }

    const context = this.context;
    if (this.showCursor) {
      await context.addInitScript(CURSOR_SCRIPT);
      await context.addInitScript(STATUS_SCRIPT);
    }
    if (this.inputLock) {
      await context.addInitScript(LOCK_SCRIPT);
      log.info("User input locked (agent-only control)");
    }

    const pages = context.pages();
    this.page = pages.length > 0 ? pages[0] : await context.newPage();
    this.attachListeners(this.page);
    return this.page;
  }

  /**
   * Lifts the input lock for the duration of one agent action (so the agent's
   * own dispatched click/keys reach the page instead of the blocking overlay),
   * then restores it. No-op when the lock is disabled.
   */
  private async withUnlocked<T>(page: Page, fn: () => Promise<T>): Promise<T> {
    if (!this.inputLock) return fn();
    await page.evaluate("window.__agentEyeUnlock && window.__agentEyeUnlock()").catch(() => undefined);
    try {
      return await fn();
    } finally {
      await page.evaluate("window.__agentEyeLock && window.__agentEyeLock()").catch(() => undefined);
    }
  }

  /**
   * Shows a live status banner in the page describing what the agent is doing
   * right now. Best-effort: no-op when watch-along is off or no page is open
   * (never force-launches the browser just to narrate).
   */
  async setStatus(text: string): Promise<void> {
    if (!this.showCursor) return;
    const page = this.page;
    if (!page || page.isClosed()) return;
    try {
      // String-form evaluate: runs in the page, avoids needing DOM types here.
      await page.evaluate(
        `window.__agentEyeSetStatus && window.__agentEyeSetStatus(${JSON.stringify(text)})`
      );
    } catch {
      /* narration must never break the real action */
    }
  }

  /** Sets the AGENT cursor dot to (x, y). Explicit — the dot never tracks the
   * real user's mouse. CSS transition makes it glide. */
  private async setCursor(page: Page, x: number, y: number): Promise<void> {
    if (!this.showCursor) return;
    await page
      .evaluate(`window.__agentEyeMoveCursor && window.__agentEyeMoveCursor(${x}, ${y})`)
      .catch(() => undefined);
  }

  private async ripple(page: Page, x: number, y: number): Promise<void> {
    if (!this.showCursor) return;
    await page
      .evaluate(`window.__agentEyeRipple && window.__agentEyeRipple(${x}, ${y})`)
      .catch(() => undefined);
  }

  /** Glides the cursor dot to an element's centre before acting; returns the
   * centre so the caller can ripple there on click. */
  private async moveCursorTo(
    page: Page,
    locator: ReturnType<Page["locator"]>
  ): Promise<{ x: number; y: number } | undefined> {
    if (!this.showCursor) return undefined;
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
      const box = await locator.boundingBox();
      if (box) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        await this.setCursor(page, cx, cy);
        await page.waitForTimeout(260); // let the dot glide before clicking
        return { x: cx, y: cy };
      }
    } catch {
      /* cursor animation is best-effort; never block the real action */
    }
    return undefined;
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
    // Surface the window so the user actually sees the session start (headed
    // mode exists precisely to be watched).
    await page.bringToFront().catch(() => undefined);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    if (this.showCursor) {
      // Place the agent cursor at centre so it's visible immediately.
      const vp = page.viewportSize() ?? { width: 1280, height: 800 };
      await this.setCursor(page, vp.width / 2, vp.height / 2);
    }
    return { url: page.url(), title: await page.title() };
  }

  async click(refOrSelector: string): Promise<void> {
    const page = await this.ensurePage();
    const locator = this.locate(page, refOrSelector);
    const centre = await this.moveCursorTo(page, locator);
    await this.withUnlocked(page, () => locator.click({ timeout: 10_000 }));
    if (centre) await this.ripple(page, centre.x, centre.y);
  }

  async type(refOrSelector: string, text: string, submit: boolean): Promise<void> {
    const page = await this.ensurePage();
    const locator = this.locate(page, refOrSelector);
    await this.moveCursorTo(page, locator);
    await this.withUnlocked(page, async () => {
      await locator.fill(text, { timeout: 10_000 });
      if (submit) await locator.press("Enter");
    });
  }

  /** Click at absolute viewport coordinates. Essential for canvas-rendered UIs
   * (Flutter web / WebGL / games) where there is no DOM element to target — the
   * agent reads a screenshot, estimates the coordinate, and clicks it. */
  async clickAt(x: number, y: number): Promise<void> {
    const page = await this.ensurePage();
    if (this.showCursor) {
      await this.setCursor(page, x, y);
      await page.waitForTimeout(260); // let the dot glide to the target first
    }
    await this.withUnlocked(page, () => page.mouse.click(x, y));
    await this.ripple(page, x, y);
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
