import { env } from "@/lib/env";

/**
 * Thin client for the Arbor MCP server (Railway). This app does NOT hold
 * Google/Meta/HCP/QBO credentials — every ad-spend and revenue read goes through
 * the MCP `execute_tools` calls-array, which already brokers those integrations.
 *
 * The MCP server speaks the standard MCP JSON-RPC protocol over HTTP. We call the
 * `tools/call` method with `execute_tools` and a `calls` array so multiple
 * platform reads batch into one round-trip (the established Arbor pattern).
 */

export interface McpToolCall {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface McpCallResult {
  tool: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

class McpError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "McpError";
  }
}

let rpcId = 0;

async function rpc(method: string, params: unknown): Promise<unknown> {
  if (!env.ARBOR_MCP_TOKEN) {
    throw new McpError("ARBOR_MCP_TOKEN is not set — cannot reach the MCP server");
  }

  const res = await fetch(env.ARBOR_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${env.ARBOR_MCP_TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    // Spend/HCP syncs are background jobs; allow a generous ceiling.
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    throw new McpError(`MCP HTTP ${res.status}: ${await res.text()}`, res.status);
  }

  const json = (await res.json()) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (json.error) throw new McpError(`MCP RPC error: ${json.error.message}`);
  return json.result;
}

/**
 * Run a single MCP tool. Returns the unwrapped tool result.
 */
export async function executeTool(
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await rpc("tools/call", {
    name: "execute_tool",
    arguments: { tool, arguments: args },
  });
  return unwrapToolResult(result);
}

/**
 * Run many MCP tools in one round-trip (the standard Arbor multi-platform pattern).
 * Results come back positionally aligned with `calls`.
 */
export async function executeTools(calls: McpToolCall[]): Promise<McpCallResult[]> {
  const result = await rpc("tools/call", {
    name: "execute_tools",
    arguments: { calls },
  });
  const unwrapped = unwrapToolResult(result);

  // The execute_tools payload is an array (one entry per call). Be defensive
  // about both `{results: [...]}` and bare-array shapes.
  const arr = Array.isArray(unwrapped)
    ? unwrapped
    : ((unwrapped as { results?: unknown[] })?.results ?? []);

  return calls.map((c, i) => {
    const r = (arr as Array<Record<string, unknown>>)[i] ?? {};
    const error = (r.error ?? r.isError) as string | boolean | undefined;
    return {
      tool: c.tool,
      ok: !error,
      data: r.data ?? r.result ?? r,
      error: typeof error === "string" ? error : error ? "tool error" : undefined,
    };
  });
}

/**
 * MCP tool results arrive as `{ content: [{ type: "text", text: "..." }] }`.
 * Unwrap to the parsed JSON payload when possible.
 */
function unwrapToolResult(result: unknown): unknown {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("");
    if (text) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  return result;
}

export { McpError };
