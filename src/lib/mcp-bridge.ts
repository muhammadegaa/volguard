import { spawn } from "node:child_process";
import { getConfig } from "./config";
import type { McpEvidence } from "./types";

interface JsonRpcResponse {
  id?: number;
  result?: { tools?: Array<{ name: string }>; content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { message?: string };
}

function commandConfig() {
  return {
    command: process.env.ALPACA_MCP_COMMAND ?? "uvx",
    args: (process.env.ALPACA_MCP_ARGS ?? "alpaca-mcp-server").split(" ").filter(Boolean),
  };
}

export function getMcpBridgeStatus(): McpEvidence {
  const { command, args } = commandConfig();
  return {
    configured: Boolean(process.env.ALPACA_MCP_COMMAND),
    available: false,
    command: `${command} ${args.join(" ")}`.trim(),
    toolCount: 0,
    calls: [],
    checkedAt: null,
    message: "Not probed in this request.",
  };
}

/** Read-only calls only. Order placement stays on the deterministic REST adapter. */
const READ_ONLY_TOOLS = new Set([
  "get_account_info",
  "get_clock",
  "get_all_positions",
  "get_portfolio_history",
  "get_option_chain",
  "get_option_snapshot",
  "get_stock_snapshot",
  "get_orders",
  "get_news",
]);

/**
 * Start the official Alpaca MCP server over stdio, discover its tools, and run a set of
 * read-only calls against the live paper account.
 *
 * The server reads credentials from its own process environment, so they must be passed
 * to the child explicitly; without that the process exits before the handshake completes.
 */
export async function probeMcpServer(
  options: { timeoutMs?: number; tools?: Array<{ name: string; args: Record<string, unknown> }> } = {},
): Promise<McpEvidence> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const requested = options.tools ?? [
    { name: "get_clock", args: {} },
    { name: "get_account_info", args: {} },
  ];
  const config = getConfig();
  const { command, args } = commandConfig();
  const base = getMcpBridgeStatus();

  if (!config.apiKey || !config.secretKey) {
    return { ...base, checkedAt: new Date().toISOString(), message: "Alpaca credentials are not configured; MCP was not started." };
  }
  const disallowed = requested.filter((tool) => !READ_ONLY_TOOLS.has(tool.name));
  if (disallowed.length > 0) {
    return { ...base, checkedAt: new Date().toISOString(), message: `Refusing non-read-only MCP tools: ${disallowed.map((t) => t.name).join(", ")}` };
  }

  return new Promise<McpEvidence>((resolve) => {
    // The MCP server is an external binary resolved at runtime (`uvx`), not a bundled
    // module, so the bundler must not try to trace it.
    const child = spawn(/* turbopackIgnore: true */ command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ALPACA_API_KEY: config.apiKey,
        ALPACA_SECRET_KEY: config.secretKey,
        ALPACA_PAPER_TRADE: "true",
      },
    });

    const calls: McpEvidence["calls"] = [];
    const pending = [...requested];
    let toolCount = 0;
    let buffer = "";
    let settled = false;
    let nextId = 10;

    const finish = (message: string, available: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve({
        ...base,
        available,
        toolCount,
        calls,
        checkedAt: new Date().toISOString(),
        message,
      });
    };

    const timer = setTimeout(() => finish("MCP probe timed out", calls.length > 0), timeoutMs);

    const send = (payload: Record<string, unknown>) => {
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch {
        finish("MCP stdin closed before the request was written", false);
      }
    };

    const callNext = () => {
      const tool = pending.shift();
      if (!tool) {
        finish(
          `Discovered ${toolCount} tools and completed ${calls.filter((c) => c.ok).length}/${calls.length} read-only calls against the paper account.`,
          calls.some((call) => call.ok),
        );
        return;
      }
      send({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: tool.name, arguments: tool.args } });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let response: JsonRpcResponse;
        try {
          response = JSON.parse(line) as JsonRpcResponse;
        } catch {
          continue; // The server also prints a banner; ignore non-JSON lines.
        }
        if (response.id === 2) {
          if (response.error) {
            finish(response.error.message ?? "MCP tool discovery failed", false);
            return;
          }
          toolCount = response.result?.tools?.length ?? 0;
          callNext();
        } else if (typeof response.id === "number" && response.id >= 10) {
          const tool = requested[response.id - 10];
          const text = (response.result?.content ?? []).map((item) => item.text ?? "").join("");
          const ok = !response.result?.isError && !response.error;
          calls.push({
            tool: tool?.name ?? `id-${response.id}`,
            ok,
            summary: summarize(tool?.name ?? "", text, ok),
          });
          callNext();
        }
      }
    });

    child.on("error", (error) => finish(`Failed to start MCP server: ${error.message}`, false));
    child.on("exit", (code) => {
      if (!settled) finish(`MCP process exited with code ${code ?? "unknown"} before completing the probe`, false);
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "volguard", version: "0.2.0" } },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/list" }), 400);
  });
}

/** Condense a tool result into one auditable line. Never echoes credentials. */
function summarize(tool: string, text: string, ok: boolean): string {
  if (!ok) return text.slice(0, 160) || "tool reported an error";
  try {
    const parsed = JSON.parse(text) as { data?: Record<string, unknown> };
    const data = parsed.data ?? {};
    if (tool === "get_clock") {
      return `market ${data.is_open ? "open" : "closed"}, next close ${String(data.next_close ?? "?")}`;
    }
    if (tool === "get_account_info") {
      return `account ${String(data.account_number ?? data.id ?? "?")} status ${String(data.status ?? "?")}, equity ${String(data.equity ?? "?")}, options level ${String(data.options_trading_level ?? "?")}`;
    }
    return `${Object.keys(data).length} fields returned`;
  } catch {
    return text.slice(0, 160);
  }
}
