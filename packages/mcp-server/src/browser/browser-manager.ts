import type { BrowserContext, Page, ConsoleMessage } from "playwright";
import { log } from "../logger.js";
import { RingBuffer } from "./ring-buffer.js";
import { findPidsUsingDir } from "../reaper.js";
import { BLOCKED_HOST_RESOLVER_RULES } from "../security/url-guard.js";

interface Reaper {
  track(pid?: number): void;
  untrack(pid?: number): void;
}

/** Lazily loads Playwright so the server still starts (and other tools work)
 * when the browser runtime isn't installed yet — the failure surfaces as a
 * clear tool error instead of a startup crash.
 *
 * When packaged in the VS Code extension, Playwright is provisioned into a
 * runtime dir (globalStorage) and its location is passed as
 * AGENT_EYE_RUNTIME_DIR. We resolve it from there with createRequire (CJS
 * resolution), because the esbuild bundle emits a native `import("playwright")`
 * and ESM dynamic import does NOT honor NODE_PATH. In dev (running from the repo)
 * the env var is unset and the plain import resolves from node_modules normally. */
async function loadChromium() {
  const runtimeDir = process.env.AGENT_EYE_RUNTIME_DIR;
  if (runtimeDir) {
    try {
      const { createRequire } = await import("node:module");
      const path = await import("node:path");
      const req = createRequire(path.join(runtimeDir, "__agent_eye_resolve__.js"));
      return req("playwright").chromium;
    } catch {
      /* fall through to plain resolution / the friendly error below */
    }
  }
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
  /** Navigation generation the entry belongs to (see BrowserManager.epoch). */
  epoch: number;
  timestamp: string;
  type: string;
  text: string;
  location?: string;
}

export interface NetworkEntry {
  epoch: number;
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
  /** Pages we already attached console/network/dialog listeners to. */
  private readonly attached = new WeakSet<Page>();
  /** How confirm()/prompt() dialogs are answered. alert()/beforeunload are always
   * accepted (they only inform). Default "dismiss" = never auto-confirm a
   * destructive "Delete?" prompt. AGENT_EYE_DIALOG=accept to confirm them. */
  private readonly dialogMode = process.env.AGENT_EYE_DIALOG === "accept" ? "accept" : "dismiss";
  // Lock real user input while the agent drives (headed only, default on).
  // Cross-platform: uses CDP Input.setIgnoreInputEvents — blocks hardware
  // mouse/keyboard but lets the agent's dispatched events through.
  private readonly inputLock =
    process.env.AGENT_EYE_INPUT_LOCK === "1" ||
    (!isHeadless() && process.env.AGENT_EYE_INPUT_LOCK !== "0");
  // Auto-close the browser window after this many ms with no browser activity,
  // so it doesn't linger after the agent finishes (the MCP server itself stays
  // alive and relaunches the browser lazily on the next use). 0 disables.
  private readonly idleCloseMs =
    process.env.AGENT_EYE_IDLE_CLOSE_MS === undefined
      ? 180_000
      : Number(process.env.AGENT_EYE_IDLE_CLOSE_MS);
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped on every main-frame document navigation/reload. Console and network
   * entries are tagged with it so reads default to "this page load only" — after a
   * fix + reload the agent must not re-read the previous load's errors. */
  private epoch = 0;
  private lastSnapshot: { key: string; text: string } | undefined;

  /** Resets the idle-close countdown; call on every browser interaction. */
  private touch(): void {
    if (this.idleCloseMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      log.info("Closing idle browser window (no activity)", { idleCloseMs: this.idleCloseMs });
      void this.close();
    }, this.idleCloseMs);
    this.idleTimer.unref?.(); // don't keep the process alive just for this timer
  }

  /** OS PIDs of the browser processes this instance owns (discovered by the
   * unique per-instance profile dir), for strict accounting + reaping. */
  private ownedPids: number[] = [];

  constructor(
    private readonly profileDir: string,
    private readonly channel: string | undefined,
    private readonly reaper?: Reaper
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
        // Render at 2x so the app is crisp on HiDPI / scaled displays (default
        // dSF=1 makes canvas-rendered Flutter look blurry when the OS upscales
        // the window). Logical coords stay 1280x800; screenshots use scale:css.
        deviceScaleFactor: Number(process.env.AGENT_EYE_DEVICE_SCALE) || 2,
        // Harden the profile: no password manager, autofill, or account sync,
        // so the agent never gains access to saved credentials (plan 7.2).
        args: [
          "--no-first-run",
          // Page-initiated requests to cloud-metadata hosts can never resolve (SSRF defense).
          `--host-resolver-rules=${BLOCKED_HOST_RESOLVER_RULES}`,
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
      this.context?.on("close", () => {
        this.releaseOwnedPids();
        this.context = undefined;
        this.page = undefined;
      });
      // Popups / target=_blank tabs: follow the newest page so the agent keeps seeing
      // what the user would, and keep capturing its console/network.
      this.context?.on("page", (p) => {
        this.page = p;
        this.attachListeners(p);
        this.pushConsole("popup", `opened ${p.url() || "(new tab)"}`);
        void p.bringToFront().catch(() => undefined);
      });
      // Strict accounting: record exactly which OS processes this instance owns
      // (by our unique profile dir) and register them for reaping.
      this.ownedPids = findPidsUsingDir(this.profileDir);
      for (const pid of this.ownedPids) this.reaper?.track(pid);
      log.info("Browser opened", { profileDir: this.profileDir, ownedPids: this.ownedPids });
    }

    const context = this.context!;
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
    await this.forceWindowBounds(this.page);
    this.touch();
    return this.page;
  }

  /**
   * The persistent profile remembers the OS window's last size/position and
   * restores it on every launch — Chromium does this regardless of the
   * `viewport` launch option, which only controls the CDP-emulated viewport
   * used for layout/screenshots. Left unchecked, a window that was ever
   * resized small (by the user, a previous crash, whatever) stays small
   * forever, so the human watching the real window sees a cropped page while
   * our screenshots (captured against the emulated viewport) look fine. Force
   * the real window to match on every launch so what's on screen is what we
   * verify against.
   */
  private async forceWindowBounds(page: Page): Promise<void> {
    if (process.env.AGENT_EYE_HEADLESS === "1") return;
    try {
      const client = await page.context().newCDPSession(page);
      const { windowId } = await client.send("Browser.getWindowForTarget");
      await client.send("Browser.setWindowBounds", {
        windowId,
        bounds: { width: 1280, height: 800, windowState: "normal" },
      });
      await client.detach().catch(() => undefined);
    } catch (err) {
      log.debug("Failed to force window bounds", { error: String(err) });
    }
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

  private pushConsole(type: string, text: string): void {
    this.consoleBuffer.push({ epoch: this.epoch, timestamp: new Date().toISOString(), type, text: truncate(text, MAX_CONSOLE_TEXT) });
  }

  private attachListeners(page: Page): void {
    if (this.attached.has(page)) return;
    this.attached.add(page);

    // JS dialogs would otherwise hang or vanish unseen; answer per dialogMode and
    // record what happened so the agent can react.
    page.on("dialog", async (dialog) => {
      const type = dialog.type();
      const accept = type === "alert" || type === "beforeunload" || this.dialogMode === "accept";
      this.pushConsole("dialog", `${type}: "${dialog.message()}" -> ${accept ? "accepted" : "dismissed"}`);
      try {
        if (accept) await dialog.accept();
        else await dialog.dismiss();
      } catch {
        /* dialog may already be gone after a navigation */
      }
    });
    page.on("request", (request) => {
      try {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) this.epoch++;
      } catch {
        /* service-worker requests have no frame */
      }
    });

    page.on("console", (msg: ConsoleMessage) => {
      const loc = msg.location();
      this.consoleBuffer.push({
        epoch: this.epoch,
        timestamp: new Date().toISOString(),
        type: msg.type(),
        text: truncate(msg.text(), MAX_CONSOLE_TEXT),
        location: loc.url ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : undefined,
      });
    });

    page.on("pageerror", (err) => {
      this.consoleBuffer.push({
        epoch: this.epoch,
        timestamp: new Date().toISOString(),
        type: "error",
        text: truncate(`${err.name}: ${err.message}\n${err.stack ?? ""}`, MAX_CONSOLE_TEXT),
      });
    });

    page.on("requestfinished", async (request) => {
      try {
        const response = await request.response();
        this.networkBuffer.push({
          epoch: this.epoch,
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
        epoch: this.epoch,
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

  async pressKey(key: string): Promise<void> {
    const page = await this.ensurePage();
    await this.withUnlocked(page, () => page.keyboard.press(key));
  }

  async hover(refOrSelector: string): Promise<void> {
    const page = await this.ensurePage();
    const locator = this.locate(page, refOrSelector);
    await this.moveCursorTo(page, locator);
    await this.withUnlocked(page, () => locator.hover({ timeout: 10_000 }));
  }

  async selectOption(refOrSelector: string, values: string[]): Promise<string[]> {
    const page = await this.ensurePage();
    const locator = this.locate(page, refOrSelector);
    await this.moveCursorTo(page, locator);
    return await this.withUnlocked(page, () => locator.selectOption(values, { timeout: 10_000 }));
  }

  /** Waits for text to appear / disappear and/or a fixed pause (all bounded). */
  async waitFor(opts: { text?: string; textGone?: string; ms?: number; timeoutMs: number }): Promise<void> {
    const page = await this.ensurePage();
    if (opts.ms) await page.waitForTimeout(opts.ms);
    if (opts.text) await page.getByText(opts.text).first().waitFor({ state: "visible", timeout: opts.timeoutMs });
    if (opts.textGone) await page.getByText(opts.textGone).first().waitFor({ state: "hidden", timeout: opts.timeoutMs });
  }

  async history(action: "back" | "forward" | "reload"): Promise<{ url: string; title: string }> {
    const page = await this.ensurePage();
    if (action === "reload") return await this.reload();
    if (action === "back") await page.goBack({ waitUntil: "domcontentloaded" });
    else await page.goForward({ waitUntil: "domcontentloaded" });
    return { url: page.url(), title: await page.title() };
  }

  /** Leaves the current page (used when a history step lands somewhere not allowed). */
  async blank(): Promise<void> {
    const page = await this.ensurePage();
    await page.goto("about:blank").catch(() => undefined);
  }

  async resize(width: number, height: number): Promise<void> {
    const page = await this.ensurePage();
    await page.setViewportSize({ width, height });
    if (process.env.AGENT_EYE_HEADLESS === "1") return;
    try {
      const client = await page.context().newCDPSession(page);
      const { windowId } = await client.send("Browser.getWindowForTarget");
      await client.send("Browser.setWindowBounds", { windowId, bounds: { width, height, windowState: "normal" } });
      await client.detach().catch(() => undefined);
    } catch {
      /* the emulated viewport (what layout and screenshots use) is already set */
    }
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
   * Accessibility snapshot the agent uses to locate elements. Uses the public
   * AI-mode ARIA snapshot (Playwright >= 1.59), which emits stable [ref=eN]
   * handles that browser_click/browser_type resolve via `aria-ref=`. The private
   * `_snapshotForAI` (removed in 1.61) is kept as a fallback for older builds, and
   * the plain ARIA snapshot (no refs) as a last resort.
   */
  async snapshot(selector?: string): Promise<string> {
    const page = await this.ensurePage();
    // A selector scopes the snapshot to one subtree (far fewer tokens on big pages).
    const root = selector ? this.locate(page, selector).first() : page.locator("body");
    try {
      return await root.ariaSnapshot({ mode: "ai" });
    } catch (err) {
      log.debug("ariaSnapshot({mode:\"ai\"}) failed, trying legacy fallbacks", { error: String(err) });
    }
    const legacy = (page as unknown as { _snapshotForAI?: () => Promise<string> })._snapshotForAI;
    if (typeof legacy === "function") {
      try {
        return await legacy.call(page);
      } catch {
        /* fall through to the plain snapshot */
      }
    }
    return await root.ariaSnapshot();
  }

  /** Previous snapshot for `key` (url + options), for delta mode. */
  previousSnapshot(key: string): string | undefined {
    return this.lastSnapshot?.key === key ? this.lastSnapshot.text : undefined;
  }

  rememberSnapshot(key: string, text: string): void {
    this.lastSnapshot = { key, text };
  }

  async screenshot(fullPage: boolean, selector?: string): Promise<Buffer> {
    const page = await this.ensurePage();
    // An element screenshot is smaller in pixels, hence fewer image tokens.
    if (selector) {
      return await this.locate(page, selector).first().screenshot({ type: "png", scale: "css", timeout: 10_000 });
    }
    // scale:"css" keeps the screenshot at logical 1280x800 regardless of the
    // 2x deviceScaleFactor, so coordinates read off it match browser_click_at.
    return await page.screenshot({ fullPage, type: "png", scale: "css" });
  }

  /** Arbitrary JS execution — only reachable when policy permits highRisk. */
  async evaluate(expression: string): Promise<unknown> {
    const page = await this.ensurePage();
    return await page.evaluate(expression);
  }

  /** Console entries; by default only the current page load (see `epoch`). */
  getConsole(limit?: number, includeHistory = false): ConsoleEntry[] {
    const all = this.consoleBuffer.recent();
    const scoped = includeHistory ? all : all.filter((e) => e.epoch === this.epoch);
    return limit === undefined ? scoped : scoped.slice(-limit);
  }

  getNetwork(limit?: number, includeHistory = false): NetworkEntry[] {
    const all = this.networkBuffer.recent();
    const scoped = includeHistory ? all : all.filter((e) => e.epoch === this.epoch);
    return limit === undefined ? scoped : scoped.slice(-limit);
  }

  async title(): Promise<string> {
    return this.page && !this.page.isClosed() ? await this.page.title().catch(() => "") : "";
  }

  /** Origin of the current page (e.g. "http://localhost:3000"), for shortening URLs. */
  currentOrigin(): string | undefined {
    const u = this.currentUrl();
    try {
      return u ? new URL(u).origin : undefined;
    } catch {
      return undefined;
    }
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
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.releaseOwnedPids();
      this.context = undefined;
      this.page = undefined;
    }
  }

  private releaseOwnedPids(): void {
    for (const pid of this.ownedPids) this.reaper?.untrack(pid);
    this.ownedPids = [];
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
