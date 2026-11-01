/**
 * Browser engine / viewport / device selection (Issue #5). Pure helpers so the
 * rules are unit-tested without launching a browser.
 */
export type EngineName = "chromium" | "firefox" | "webkit";

const ENGINES: readonly EngineName[] = ["chromium", "firefox", "webkit"];

export function parseEngine(value: string | undefined): EngineName {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return "chromium";
  if ((ENGINES as readonly string[]).includes(v)) return v as EngineName;
  throw new Error(`AGENT_EYE_BROWSER="${value}" is not supported. Use one of: ${ENGINES.join(", ")}.`);
}

export interface Viewport {
  width: number;
  height: number;
}

export const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800 };

/** "1280x800" → {1280, 800}; undefined when unset; throws on malformed/out-of-range values. */
export function parseViewport(value: string | undefined): Viewport | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const m = /^(\d{3,4})x(\d{3,4})$/i.exec(value.trim());
  const width = m ? Number(m[1]) : NaN;
  const height = m ? Number(m[2]) : NaN;
  if (!m || width < 200 || width > 3840 || height < 200 || height > 2400) {
    throw new Error(`AGENT_EYE_VIEWPORT="${value}" is invalid. Use WIDTHxHEIGHT, e.g. 1280x800 (200–3840 x 200–2400).`);
  }
  return { width, height };
}

/** The subset of Playwright's device descriptor we apply to a context. */
export interface DeviceOptions {
  userAgent?: string;
  viewport?: Viewport;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
}

type DeviceTable = Record<string, DeviceOptions & { defaultBrowserType?: string }>;

/**
 * Looks a device up by name (case-insensitive) in Playwright's descriptor table.
 * `isMobile` is dropped for Firefox, which rejects it.
 */
export function resolveDevice(devices: DeviceTable, name: string, engine: EngineName): DeviceOptions {
  const wanted = name.trim().toLowerCase();
  const key = Object.keys(devices).find((k) => k.toLowerCase() === wanted);
  if (!key) {
    const near = Object.keys(devices)
      .filter((k) => k.toLowerCase().includes(wanted.split(/\s+/)[0] ?? ""))
      .slice(0, 6);
    throw new Error(
      `AGENT_EYE_DEVICE="${name}" is not a known Playwright device.` +
        (near.length ? ` Similar: ${near.join(", ")}.` : " See https://playwright.dev/docs/emulation#devices.")
    );
  }
  const d = devices[key];
  const out: DeviceOptions = {
    userAgent: d.userAgent,
    viewport: d.viewport,
    deviceScaleFactor: d.deviceScaleFactor,
    hasTouch: d.hasTouch,
  };
  if (engine !== "firefox") out.isMobile = d.isMobile;
  return out;
}

/** Turns Playwright's "Executable doesn't exist" into an actionable install hint. */
export function launchErrorHint(engine: EngineName, err: unknown): Error | undefined {
  const message = err instanceof Error ? err.message : String(err);
  if (/Executable doesn't exist|browserType\.launch.*install/i.test(message)) {
    return new Error(`The ${engine} browser is not installed. Run: npx playwright install ${engine}`);
  }
  return undefined;
}
