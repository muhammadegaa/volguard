import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { appendEvent } from "@/lib/audit-store";
import { getConfig } from "@/lib/config";
import { withRequestLog } from "@/lib/logger";
import { probeMcpServer } from "@/lib/mcp-bridge";
import { clientKey, rateLimit, rateLimitHeaders } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const WINDOW_MS = 60_000;

/**
 * Runs the official Alpaca MCP server and executes read-only tool calls against the paper
 * account. The result is written to the audit ledger so the integration is evidenced by a
 * recorded call, not by the presence of a config file.
 */
export async function POST(request: Request) {
  return withRequestLog("mcp.probe", request, async (requestId) => {
    // Each probe spawns a child process, so this is limited harder than the agent route.
    const max = getConfig().mcpRateLimitPerMinute;
    const limit = rateLimit(clientKey(request, "mcp"), max, WINDOW_MS);
    const headers = { ...rateLimitHeaders(limit, max), "x-request-id": requestId };

    if (!limit.allowed) {
      return NextResponse.json(
        { error: `Too many probes. Try again in ${limit.retryAfterSeconds}s.`, requestId },
        { status: 429, headers },
      );
    }

    const evidence = await probeMcpServer({
      tools: [
        { name: "get_clock", args: {} },
        { name: "get_account_info", args: {} },
      ],
    });

    await appendEvent({
      id: randomUUID(),
      runId: "mcp",
      createdAt: new Date().toISOString(),
      type: "MCP_CALL",
      message: evidence.message,
      data: { available: evidence.available, toolCount: evidence.toolCount, calls: evidence.calls, command: evidence.command },
    });

    return NextResponse.json(evidence, { headers });
  });
}
