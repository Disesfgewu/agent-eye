import { z } from "zod";
import { classifyUrl } from "../security/url-guard.js";
import { redactText } from "../security/redaction.js";
import { filterInteractive, formatHealth, truncateText } from "../browser/format.js";
import { errorResult, framedWebData, text, toolError, type ToolContext, type ToolResult } from "./register.js";

type Category = "observe" | "interact" | "sideEffect" | "highRisk";

const MAX_STEPS = 20;
const SNAPSHOT_CHARS = 4_000;

const ACTIONS = ["navigate", "click", "type", "press", "select", "hover", "wait"] as const;
type Action = (typeof ACTIONS)[number];

interface Step {
  action: Action;
  url?: string;
  target?: string;
  text?: string;
  submit?: boolean;
  key?: string;
  values?: string[];
  ms?: number;
  timeoutMs?: number;
}

/**
 * Composite tools (Issue #3): well-known sequences run server-side so the agent
 * pays for ONE round-trip and ONE small result instead of 4–10 LLM turns.
 * Safety: every step still passes the same permission gate and URL scope as the
 * single-step tools. browser_batch checks ALL steps before executing ANY of them,
 * so a denied step never leaves a flow half-run.
 */
export function registerCompositeTools(ctx: ToolContext): void {
  if (process.env.AGENT_EYE_TOOLSET === "core") return;
  const { server, policy, gate, artifacts, browser } = ctx;

  const gateCheck = async (tool: string, category: Category, title: string, detail = "") => {
    const g = await gate.check(category, { tool, title, detail });
    return g.ok ? null : g.message;
  };

  /** Same navigation rules as browser_navigate. Returns an error message or null. */
  const checkNavigation = async (tool: string, url: string): Promise<string | null> => {
    const verdict = classifyUrl(url, policy.navigationAllowlist);
    if (verdict.verdict === "blocked") {
      artifacts.record({ type: "tool_call", tool, title: `Blocked navigation to ${url}`, detail: verdict.reason, status: "denied" });
      return `Navigation blocked: ${verdict.reason}`;
    }
    return gateCheck(tool, verdict.verdict === "allowlisted" ? "interact" : "highRisk", `Navigate to ${url}`,
      verdict.verdict === "outside" ? verdict.reason : "Allowlisted host.");
  };

  const healthReport = async (snapshot: "none" | "interactive", maxLines: number): Promise<string> => {
    const url = browser.currentUrl() ?? "(no page)";
    const redact = policy.redactSensitiveHeaders;
    let out = formatHealth({
      url,
      title: await browser.title(),
      console: browser.getConsole(),
      network: browser.getNetwork(),
      origin: browser.currentOrigin(),
      redact: (u) => redactText(u, redact),
      maxLines,
    });
    if (snapshot === "interactive") {
      const raw = await browser.snapshot();
      const body = filterInteractive(raw) || "(no interactive elements; canvas UI? use browser_screenshot)";
      out += `\nInteractive elements:\n${truncateText(body, SNAPSHOT_CHARS, "Use browser_snapshot with selector for more.").text}`;
    }
    return out;
  };

  // ---- browser_verify_page -------------------------------------------------
  server.registerTool(
    "browser_verify_page",
    {
      title: "Verify page health",
      description:
        "One call: optionally navigate, wait for load, then report document status, console errors/warnings, failed requests and (optionally) the actionable elements. Use instead of navigate + snapshot + console + network.",
      inputSchema: {
        url: z.string().optional().describe("Navigate here first; omit to check the current page."),
        waitForText: z.string().max(300).optional().describe("Also wait until this text is visible."),
        snapshot: z.enum(["none", "interactive"]).optional().describe("Include actionable elements (default interactive)."),
        settleMs: z.number().int().min(0).max(5000).optional().describe("Extra wait for late async errors (default 500)."),
      },
    },
    async ({ url, waitForText, snapshot, settleMs }): Promise<ToolResult> => {
      const tool = "browser_verify_page";
      const denied = (url ? await checkNavigation(tool, url) : null) ?? (await gateCheck(tool, "observe", "Verify page health"));
      if (denied) return errorResult(denied);
      try {
        if (url) await browser.navigate(url);
        await browser.waitFor({ text: waitForText, ms: settleMs ?? 500, timeoutMs: 10_000 });
        const report = await healthReport(snapshot ?? "interactive", 10);
        artifacts.record({ type: "tool_call", tool, title: `Verified ${browser.currentUrl() ?? "page"}`, status: "ok" });
        return text(framedWebData(browser.currentUrl() ?? "", report));
      } catch (err) {
        return toolError(tool, "Failed to verify page", err, artifacts);
      }
    }
  );

  // ---- browser_batch -------------------------------------------------------
  const stepSchema = z.object({
    action: z.enum(ACTIONS),
    url: z.string().optional(),
    target: z.string().optional(),
    text: z.string().max(5000).optional(),
    submit: z.boolean().optional(),
    key: z.string().max(40).optional(),
    values: z.array(z.string().max(500)).max(20).optional(),
    ms: z.number().int().min(0).max(10_000).optional(),
    timeoutMs: z.number().int().min(100).max(30_000).optional(),
  });

  /** Static validation + the gate category a step needs. */
  const plan = (s: Step): { category: Category; title: string } | string => {
    switch (s.action) {
      case "navigate":
        return s.url ? { category: "interact", title: `Navigate to ${s.url}` } : "navigate needs url";
      case "click":
        return s.target ? { category: "interact", title: `Click ${s.target}` } : "click needs target";
      case "hover":
        return s.target ? { category: "interact", title: `Hover ${s.target}` } : "hover needs target";
      case "type":
        return s.target && s.text !== undefined
          ? { category: s.submit ? "sideEffect" : "interact", title: `Type into ${s.target}${s.submit ? " and submit" : ""}` }
          : "type needs target and text";
      case "press":
        return s.key ? { category: /(^|\+)Enter$/.test(s.key) ? "sideEffect" : "interact", title: `Press ${s.key}` } : "press needs key";
      case "select":
        return s.target && s.values?.length ? { category: "interact", title: `Select in ${s.target}` } : "select needs target and values";
      case "wait":
        return s.text || s.ms ? { category: "observe", title: "Wait" } : "wait needs text and/or ms";
    }
  };

  const run = async (s: Step): Promise<string> => {
    switch (s.action) {
      case "navigate": {
        const r = await browser.navigate(s.url as string);
        return `${r.url} "${r.title}"`;
      }
      case "click":
        await browser.click(s.target as string);
        return s.target as string;
      case "hover":
        await browser.hover(s.target as string);
        return s.target as string;
      case "type":
        await browser.type(s.target as string, s.text as string, s.submit === true);
        return s.target as string;
      case "press":
        await browser.pressKey(s.key as string);
        return s.key as string;
      case "select":
        return (await browser.selectOption(s.target as string, s.values as string[])).join(", ");
      case "wait":
        await browser.waitFor({ text: s.text, ms: s.ms, timeoutMs: s.timeoutMs ?? 10_000 });
        return s.text ?? `${s.ms}ms`;
    }
  };

  server.registerTool(
    "browser_batch",
    {
      title: "Run a scripted flow",
      description:
        `Run up to ${MAX_STEPS} steps in ONE call (navigate/click/type/press/select/hover/wait) and get per-step status plus a page-health summary. For known flows (login, add to cart). Every step is permission-checked before any runs; stops at the first failure.`,
      inputSchema: {
        steps: z.array(stepSchema).min(1).max(MAX_STEPS).describe("Steps; fields per action: navigate{url} click/hover{target} type{target,text,submit?} press{key} select{target,values} wait{text?|ms?,timeoutMs?}."),
        report: z.enum(["health", "none"]).optional().describe("Final summary (default health)."),
      },
    },
    async ({ steps, report }): Promise<ToolResult> => {
      const tool = "browser_batch";

      // Phase 1: validate and permission-check EVERY step before executing any.
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i] as Step;
        const p = plan(s);
        if (typeof p === "string") return errorResult(`Step ${i + 1}: ${p}. Nothing was executed.`);
        const denied = s.action === "navigate" ? await checkNavigation(tool, s.url as string) : await gateCheck(tool, p.category, p.title);
        if (denied) return errorResult(`Step ${i + 1} (${s.action}) not permitted: ${denied}\nNothing was executed.`);
      }

      // Phase 2: execute.
      const lines: string[] = [];
      let failed = false;
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i] as Step;
        if (failed) {
          lines.push(`${i + 1}. ${s.action} – skipped`);
          continue;
        }
        try {
          await browser.setStatus(`Agent Eye｜step ${i + 1}/${steps.length}: ${s.action}`);
          lines.push(`${i + 1}. ${s.action} ✓ ${await run(s)}`);
        } catch (err) {
          failed = true;
          lines.push(`${i + 1}. ${s.action} ✗ ${(err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 200)}`);
        }
      }
      artifacts.record({ type: "tool_call", tool, title: `Batch of ${steps.length} step(s)${failed ? " (stopped on failure)" : ""}`, detail: lines.join("\n"), status: failed ? "error" : "ok" });

      let out = lines.join("\n");
      if ((report ?? "health") === "health" && browser.currentUrl()) {
        out += `\n\n${framedWebData(browser.currentUrl() as string, await healthReport("none", 5))}`;
      }
      return failed ? errorResult(out) : text(out);
    }
  );
}
