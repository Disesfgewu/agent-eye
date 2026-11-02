/**
 * Pure helpers for the browser-related extension settings (Issue #30). No `vscode`
 * import on purpose, so they are unit-tested under plain Node.
 */
export const ENGINES = ["chromium", "firefox", "webkit"] as const;
export type Engine = (typeof ENGINES)[number];

export function isEngine(value: string): value is Engine {
  return (ENGINES as readonly string[]).includes(value);
}

/** Keeps only known engines (deduplicated, canonical order). Empty input falls back to Chromium. */
export function normalizeEngines(input: readonly string[]): Engine[] {
  const picked = ENGINES.filter((e) => input.includes(e));
  return picked.length ? [...picked] : ["chromium"];
}

/**
 * Arguments for `npx playwright install`. The runtime installer runs through a shell
 * (Windows `.cmd` shims), so engine names are ONLY ever taken from the fixed list above.
 */
export function playwrightInstallArgs(engines: readonly string[], withDeps: boolean): string[] {
  return ["playwright", "install", ...(withDeps ? ["--with-deps"] : []), ...normalizeEngines(engines)];
}

export interface BrowserSettings {
  browser?: string;
  device?: string;
  viewport?: string;
  channel?: string;
}

/** A device name is passed to the server as data; accept short plain names only ("iPhone 15", "Pixel 7"). */
const DEVICE_NAME = /^[A-Za-z0-9][\w .()+-]{0,39}$/;
const VIEWPORT = /^(\d{3,4})x(\d{3,4})$/i;

/**
 * Environment for the MCP server derived from the settings, plus human-readable warnings
 * for values that were ignored (so a typo is explained instead of failing at launch).
 */
export function browserServerEnv(s: BrowserSettings): { env: Record<string, string>; warnings: string[] } {
  const env: Record<string, string> = {};
  const warnings: string[] = [];
  const browser = (s.browser ?? "").trim().toLowerCase();
  if (browser && !isEngine(browser)) {
    warnings.push(`agentEye.browser "${s.browser}" is not one of ${ENGINES.join(", ")}; using chromium.`);
  }
  const engine: Engine = isEngine(browser) ? browser : "chromium";
  if (engine !== "chromium") env.AGENT_EYE_BROWSER = engine;

  const channel = (s.channel ?? "").trim();
  if (channel) {
    if (engine === "chromium") env.AGENT_EYE_BROWSER_CHANNEL = channel;
    else warnings.push(`agentEye.browserChannel "${channel}" only applies to chromium and is ignored for ${engine}.`);
  }

  const device = (s.device ?? "").trim();
  if (device) {
    if (DEVICE_NAME.test(device)) env.AGENT_EYE_DEVICE = device;
    else warnings.push(`agentEye.device "${device}" is not a plain device name (e.g. "iPhone 15"); ignored.`);
  }

  const viewport = (s.viewport ?? "").trim();
  if (viewport) {
    const m = VIEWPORT.exec(viewport);
    const w = m ? Number(m[1]) : 0;
    const h = m ? Number(m[2]) : 0;
    if (m && w >= 200 && w <= 3840 && h >= 200 && h <= 2400) env.AGENT_EYE_VIEWPORT = `${w}x${h}`;
    else warnings.push(`agentEye.viewport "${viewport}" must look like 1280x800 (200-3840 x 200-2400); ignored.`);
  }
  return { env, warnings };
}

/** Where Playwright keeps its browser downloads (PLAYWRIGHT_BROWSERS_PATH wins). */
export function playwrightBrowsersDir(env: NodeJS.ProcessEnv, platform: string, home: string): string {
  const override = env.PLAYWRIGHT_BROWSERS_PATH;
  if (override && override !== "0") return override;
  if (platform === "win32") return `${env.LOCALAPPDATA ?? `${home}\\AppData\\Local`}\\ms-playwright`;
  if (platform === "darwin") return `${home}/Library/Caches/ms-playwright`;
  return `${home}/.cache/ms-playwright`;
}

/** Which engines have a download in the browsers directory, from its entry names (e.g. "firefox-1495"). */
export function enginesFromListing(entries: readonly string[]): Engine[] {
  return ENGINES.filter((e) => entries.some((n) => n === e || n.startsWith(`${e}-`) || n.startsWith(`${e}_`)));
}
