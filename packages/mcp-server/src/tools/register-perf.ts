import { z } from "zod";
import { formatPerf } from "../browser/perf.js";
import { classifyUrl } from "../security/url-guard.js";
import { errorResult, framedWebData, text, toolError, type ToolContext, type ToolResult } from "./register.js";

/**
 * browser_perf_summary (Issue #39): a few lines of lab performance data instead of a raw trace.
 * It reloads the page (or navigates to an allowlisted URL), so it is an `interact` action.
 */
export function registerPerfTools(ctx: ToolContext): void {
  if (process.env.AGENT_EYE_TOOLSET === "core") return;
  const { server, policy, gate, artifacts, browser } = ctx;

  server.registerTool(
    "browser_perf_summary",
    {
      title: "Performance summary",
      description:
        "Reload the page (or open an allowlisted url) and report TTFB/FCP/LCP/CLS/TBT with web.dev ratings, the LCP element, slowest and largest requests in a few lines. One lab run, not Lighthouse; all metrics on chromium.",
      inputSchema: {
        url: z.string().optional().describe("Allowlisted URL to measure; default: reload the current page."),
        cpuSlowdown: z.number().int().min(1).max(6).optional().describe("CPU throttle factor, chromium only (4 = mid-range phone)."),
      },
    },
    async ({ url, cpuSlowdown }): Promise<ToolResult> => {
      if (url !== undefined && classifyUrl(url, policy.navigationAllowlist).verdict !== "allowlisted") {
        return errorResult("browser_perf_summary only measures allowlisted URLs; open other pages with browser_navigate first (it asks for approval).");
      }
      const g = await gate.check("interact", { tool: "browser_perf_summary", title: `Measure performance of ${url ?? "the current page"}`, detail: "" });
      if (!g.ok) return errorResult(g.message);
      try {
        await browser.setStatus("Agent Eye｜measuring performance");
        const { raw, ...ctxInfo } = await browser.measurePerformance(url, cpuSlowdown ?? 1);
        artifacts.record({ type: "tool_call", tool: "browser_perf_summary", title: "Performance summary", detail: ctxInfo.url, status: "ok" });
        // URLs of requests come from the page: frame them like other page-derived data.
        return text(framedWebData(ctxInfo.url, formatPerf(raw, ctxInfo)));
      } catch (err) {
        return toolError("browser_perf_summary", "Failed to measure performance", err, artifacts);
      }
    }
  );
}
