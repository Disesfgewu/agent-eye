import { z } from "zod";
import { classifyUrl } from "../security/url-guard.js";
import { checkUploads, storageInputProblem, MAX_UPLOAD_FILES } from "../security/state-guard.js";
import { errorResult, text, toolError, type ToolContext, type ToolResult } from "./register.js";

/**
 * State tools (Issue #38): set cookies / web storage and attach files, so logged-in apps and
 * file-input forms can be tested. Write-only by design: values are never echoed back, logged or put
 * on the activity timeline (only names / file names are). Both are `sideEffect` actions and only
 * work on a page whose host is in the navigation allowlist. See security/state-guard.ts.
 */
export function registerStateTools(ctx: ToolContext): void {
  if (process.env.AGENT_EYE_TOOLSET === "core") return;
  const { server, policy, gate, artifacts, browser, workspaceRoot } = ctx;

  /** The current page, if (and only if) its host is allowlisted. */
  const allowlistedPage = (): { ok: true; url: string } | { ok: false; error: ToolResult } => {
    const url = browser.currentUrl();
    if (!url || url === "about:blank") return { ok: false, error: errorResult("Open a page first (browser_navigate).") };
    if (classifyUrl(url, policy.navigationAllowlist).verdict !== "allowlisted") {
      return { ok: false, error: errorResult("This tool only works on pages whose host is in the navigation allowlist.") };
    }
    return { ok: true, url };
  };

  server.registerTool(
    "browser_set_storage",
    {
      title: "Set cookies / storage",
      description:
        "Set cookies, localStorage or sessionStorage on the current (allowlisted) page, or clear them, e.g. to test a logged-in state with a test token. Write-only: values are never echoed or logged. Reload afterwards to apply.",
      inputSchema: {
        cookies: z
          .array(
            z.object({
              name: z.string(),
              value: z.string(),
              path: z.string().optional(),
              httpOnly: z.boolean().optional(),
              secure: z.boolean().optional(),
              sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
            })
          )
          .max(30)
          .optional(),
        localStorage: z.record(z.string()).optional(),
        sessionStorage: z.record(z.string()).optional(),
        clear: z.boolean().optional().describe("First clear this host's cookies and storage."),
      },
    },
    async ({ cookies, localStorage, sessionStorage, clear }): Promise<ToolResult> => {
      const page = allowlistedPage();
      if (!page.ok) return page.error;
      const problem = storageInputProblem({ cookies, localStorage, sessionStorage });
      if (problem) return errorResult(`Not set: ${problem}.`);
      const names = [
        ...(cookies ?? []).map((c) => `cookie:${c.name}`),
        ...Object.keys(localStorage ?? {}).map((k) => `localStorage:${k}`),
        ...Object.keys(sessionStorage ?? {}).map((k) => `sessionStorage:${k}`),
      ];
      if (!clear && !names.length) return errorResult("Nothing to do: pass cookies, localStorage, sessionStorage or clear.");
      const g = await gate.check("sideEffect", { tool: "browser_set_storage", title: `${clear ? "Clear + " : ""}set ${names.length} state value(s) on ${new URL(page.url).host}`, detail: names.join(", ") });
      if (!g.ok) return errorResult(g.message);
      try {
        if (clear) await browser.clearState();
        if (cookies?.length) await browser.setCookies(cookies);
        if (localStorage && Object.keys(localStorage).length) await browser.setWebStorage("localStorage", localStorage);
        if (sessionStorage && Object.keys(sessionStorage).length) await browser.setWebStorage("sessionStorage", sessionStorage);
        artifacts.record({ type: "tool_call", tool: "browser_set_storage", title: `Set state: ${names.join(", ") || "(cleared)"}`, status: "ok" });
        return text(`${clear ? "Cleared this host's cookies and storage. " : ""}${names.length ? `Set ${names.join(", ")}. ` : ""}Reload (browser_history reload) for the page to see it.`);
      } catch (err) {
        return toolError("browser_set_storage", "Failed to set storage", err, artifacts);
      }
    }
  );

  server.registerTool(
    "browser_upload_file",
    {
      title: "Upload file(s)",
      description:
        "Attach workspace files to a file input (ref or selector). Only regular files inside the workspace; secrets (.env, keys, .git, ...) and files over 25 MB are refused.",
      inputSchema: {
        target: z.string().describe("Ref or selector of the <input type=file>."),
        paths: z.array(z.string()).min(1).max(MAX_UPLOAD_FILES).describe("Workspace-relative file paths."),
      },
    },
    async ({ target, paths }): Promise<ToolResult> => {
      const page = allowlistedPage();
      if (!page.ok) return page.error;
      const checked = checkUploads(workspaceRoot, paths);
      if (!checked.ok) return errorResult(`Not uploaded: ${checked.reason}.`);
      const list = checked.files.map((f) => `${f.name} (${Math.max(1, Math.round(f.size / 1024))} KB)`).join(", ");
      const g = await gate.check("sideEffect", { tool: "browser_upload_file", title: `Attach ${checked.files.length} file(s) to ${target}`, detail: list });
      if (!g.ok) return errorResult(g.message);
      try {
        await browser.setInputFiles(target, checked.files.map((f) => f.abs));
        artifacts.record({ type: "tool_call", tool: "browser_upload_file", title: `Attached ${list}`, status: "ok" });
        return text(`Attached ${list} to ${target}.`);
      } catch (err) {
        return toolError("browser_upload_file", `Failed to attach files to ${target}`, err, artifacts);
      }
    }
  );
}
