import { z } from "zod";
import { classifyUrl } from "../security/url-guard.js";
import { errorResult, text, toolError, type ToolContext } from "./register.js";

const MAX_WAIT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;

/**
 * Interaction tools beyond click/type (Issue #4). Each one goes through the same
 * permission gate as the original tools and is recorded in the activity timeline.
 * Kept deliberately few: every tool adds fixed tokens to every session.
 */
export function registerActionTools(ctx: ToolContext): void {
  // AGENT_EYE_TOOLSET=core keeps the session's fixed tool-definition cost minimal (~780 fewer tokens).
  if (process.env.AGENT_EYE_TOOLSET === "core") return;
  const { server, policy, gate, artifacts, browser } = ctx;

  const guard = async (
    tool: string,
    category: "observe" | "interact" | "sideEffect",
    title: string
  ): Promise<ReturnType<typeof errorResult> | null> => {
    if (!ctx.ownsGlobals) return errorResult("Another Agent Eye instance owns the browser for this workspace.");
    const g = await gate.check(category, { tool, title, detail: "" });
    return g.ok ? null : errorResult(g.message);
  };

  server.registerTool(
    "browser_press_key",
    {
      title: "Press key",
      description: "Press a key or combo on the page (e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown', 'Control+A'). Enter may submit a form.",
      inputSchema: { key: z.string().min(1).max(40).describe("Playwright key name or combo.") },
    },
    async ({ key }) => {
      // Enter commits forms, so it is gated like browser_type(submit=true).
      const denied = await guard("browser_press_key", /(^|\+)Enter$/.test(key) ? "sideEffect" : "interact", `Press ${key}`);
      if (denied) return denied;
      try {
        await browser.setStatus(`Agent Eye｜pressing ${key}`);
        await browser.pressKey(key);
        artifacts.record({ type: "tool_call", tool: "browser_press_key", title: `Pressed ${key}`, status: "ok" });
        return text(`Pressed ${key}.`);
      } catch (err) {
        return toolError("browser_press_key", `Failed to press ${key}`, err, artifacts);
      }
    }
  );

  server.registerTool(
    "browser_hover",
    {
      title: "Hover element",
      description: "Hover an element by snapshot ref or Playwright selector (menus, tooltips).",
      inputSchema: { target: z.string().describe("Ref or selector.") },
    },
    async ({ target }) => {
      const denied = await guard("browser_hover", "interact", `Hover ${target}`);
      if (denied) return denied;
      try {
        await browser.hover(target);
        artifacts.record({ type: "tool_call", tool: "browser_hover", title: `Hovered ${target}`, status: "ok" });
        return text(`Hovered ${target}.`);
      } catch (err) {
        return toolError("browser_hover", `Failed to hover ${target}`, err, artifacts);
      }
    }
  );

  server.registerTool(
    "browser_select_option",
    {
      title: "Select option",
      description: "Choose option(s) in a <select> by value or label.",
      inputSchema: {
        target: z.string().describe("Ref or selector of the select."),
        values: z.array(z.string().max(500)).min(1).max(20).describe("Option values or labels."),
      },
    },
    async ({ target, values }) => {
      const denied = await guard("browser_select_option", "interact", `Select ${values.join(", ")} in ${target}`);
      if (denied) return denied;
      try {
        const chosen = await browser.selectOption(target, values);
        artifacts.record({ type: "tool_call", tool: "browser_select_option", title: `Selected ${chosen.join(", ")} in ${target}`, status: "ok" });
        return text(`Selected ${chosen.join(", ")}.`);
      } catch (err) {
        return toolError("browser_select_option", `Failed to select in ${target}`, err, artifacts);
      }
    }
  );

  server.registerTool(
    "browser_wait_for",
    {
      title: "Wait for text",
      description: "Wait until text appears or disappears, and/or pause briefly. Prefer this over re-polling snapshots.",
      inputSchema: {
        text: z.string().max(300).optional().describe("Wait until this text is visible."),
        textGone: z.string().max(300).optional().describe("Wait until this text is gone."),
        ms: z.number().int().min(0).max(MAX_WAIT_MS).optional().describe("Fixed pause first (max 10000)."),
        timeoutMs: z.number().int().min(100).max(MAX_TIMEOUT_MS).optional().describe("Give up after (default 10000)."),
      },
    },
    async ({ text: want, textGone, ms, timeoutMs }) => {
      if (!want && !textGone && !ms) return errorResult("Provide text, textGone and/or ms.");
      const denied = await guard("browser_wait_for", "observe", "Wait for page condition");
      if (denied) return denied;
      try {
        await browser.waitFor({ text: want, textGone, ms, timeoutMs: timeoutMs ?? 10_000 });
        return text("Done waiting.");
      } catch (err) {
        return toolError("browser_wait_for", "Condition not met in time", err, artifacts);
      }
    }
  );

  server.registerTool(
    "browser_history",
    {
      title: "Back / forward / reload",
      description: "Go back, forward, or reload the page (reload to re-verify after a code change).",
      inputSchema: { action: z.enum(["back", "forward", "reload"]).describe("History action.") },
    },
    async ({ action }) => {
      const denied = await guard("browser_history", "interact", `History: ${action}`);
      if (denied) return denied;
      try {
        const { url, title } = await browser.history(action);
        // Back/forward can land on an entry we never vetted; apply the navigation scope afterwards.
        const verdict = classifyUrl(url, policy.navigationAllowlist);
        if (action !== "reload" && url !== "about:blank" && verdict.verdict !== "allowlisted") {
          await browser.blank();
          artifacts.record({ type: "tool_call", tool: "browser_history", title: `Blocked ${action} to ${url}`, status: "denied" });
          return errorResult(`History ${action} landed on ${url}, which is outside the navigation allowlist; returned to a blank page.`);
        }
        artifacts.record({ type: "tool_call", tool: "browser_history", title: `${action} → ${title || url}`, detail: url, status: "ok" });
        return text(`${action}: ${url}\nPage title: ${title}`);
      } catch (err) {
        return toolError("browser_history", `Failed to go ${action}`, err, artifacts);
      }
    }
  );

  server.registerTool(
    "browser_resize",
    {
      title: "Resize viewport",
      description: "Resize the viewport (responsive/mobile checks). browser_click_at coordinates follow the new size.",
      inputSchema: {
        width: z.number().int().min(200).max(3840).describe("Width in CSS px."),
        height: z.number().int().min(200).max(2400).describe("Height in CSS px."),
      },
    },
    async ({ width, height }) => {
      const denied = await guard("browser_resize", "interact", `Resize to ${width}x${height}`);
      if (denied) return denied;
      try {
        await browser.resize(width, height);
        artifacts.record({ type: "tool_call", tool: "browser_resize", title: `Resized to ${width}x${height}`, status: "ok" });
        return text(`Viewport is now ${width}x${height}.`);
      } catch (err) {
        return toolError("browser_resize", "Failed to resize", err, artifacts);
      }
    }
  );
}
