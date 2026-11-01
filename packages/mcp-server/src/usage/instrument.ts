import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodTypeAny } from "zod";
import type { UsageLedger } from "./ledger.js";
import { estimateResultTokens, estimateTextTokens } from "./estimate.js";

type ToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: Record<string, ZodTypeAny>;
};

/** Rough serialized size of one tool definition as an MCP client sends it to the model. */
export function estimateToolDefinitionTokens(name: string, cfg: ToolConfig): number {
  const props: Record<string, { type: string; description?: string }> = {};
  const required: string[] = [];
  for (const [key, schema] of Object.entries(cfg.inputSchema ?? {})) {
    const typeName = (schema._def as { typeName?: string }).typeName ?? "ZodString";
    props[key] = { type: typeName.replace(/^Zod/, "").toLowerCase(), description: schema.description };
    if (!schema.isOptional()) required.push(key);
  }
  // Mirrors the shape the SDK serializes for tools/list (incl. its fixed boilerplate).
  return estimateTextTokens(
    JSON.stringify({
      name,
      title: cfg.title,
      description: cfg.description ?? "",
      inputSchema: {
        type: "object",
        properties: props,
        required,
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
      },
    })
  );
}

/**
 * Wraps `server.registerTool` so every handler registered AFTER this call is
 * measured by the ledger. Purely observational: the handler's arguments and
 * result pass through untouched, and measurement failures never affect a call.
 */
export function instrumentTools(server: McpServer, ledger: UsageLedger): void {
  const original = server.registerTool.bind(server) as (
    name: string,
    cfg: ToolConfig,
    handler: (...args: unknown[]) => unknown
  ) => unknown;
  let defTokens = 0;
  let count = 0;

  (server as unknown as { registerTool: typeof original }).registerTool = (name, cfg, handler) => {
    defTokens += estimateToolDefinitionTokens(name, cfg);
    count++;
    ledger.setToolDefinitionOverhead(defTokens, count);

    return original(name, cfg, async (...args: unknown[]) => {
      const started = Date.now();
      let inTokens = 0;
      try {
        if (cfg.inputSchema && args[0] && typeof args[0] === "object") {
          inTokens = estimateTextTokens(JSON.stringify(args[0]));
        }
      } catch {
        /* measurement only */
      }
      try {
        const result = (await handler(...args)) as { content?: never[]; isError?: boolean } | undefined;
        let out = 0;
        try {
          out = estimateResultTokens(result?.content);
        } catch {
          /* measurement only */
        }
        ledger.record(name, inTokens, out, Date.now() - started, !result?.isError);
        return result;
      } catch (err) {
        ledger.record(name, inTokens, 0, Date.now() - started, false);
        throw err;
      }
    });
  };
}
