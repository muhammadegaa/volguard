import { NextResponse } from "next/server";
import { z } from "zod";
import { runAgent } from "@/lib/agent";
import { hasOperatorToken } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { withRequestLog } from "@/lib/logger";
import { clientKey, rateLimit, rateLimitHeaders } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel's Hobby plan caps a function at 60s and rejects a higher value at deploy time.
// VOLGUARD_RUN_TIMEOUT_MS must stay below this or the platform kills the run before the
// agent's own timeout can produce a clean, recorded ERROR result.
export const maxDuration = 60;

const BodySchema = z.object({ mode: z.enum(["dry-run", "paper"]).default("dry-run") });

const WINDOW_MS = 60_000;

export async function POST(request: Request) {
  return withRequestLog("agent.run", request, async (requestId) => {
    // A full run makes dozens of Alpaca calls, so it is throttled per client.
    const max = getConfig().runRateLimitPerMinute;
    const limit = rateLimit(clientKey(request, "agent-run"), max, WINDOW_MS);
    const headers = { ...rateLimitHeaders(limit, max), "x-request-id": requestId };

    if (!limit.allowed) {
      return NextResponse.json(
        { error: `Too many runs. Try again in ${limit.retryAfterSeconds}s.`, requestId },
        { status: 429, headers },
      );
    }

    const parsed = BodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "mode must be 'dry-run' or 'paper'.", requestId },
        { status: 400, headers },
      );
    }
    const { mode } = parsed.data;

    // Dry-run never touches the order endpoint, so it stays open. Paper execution is the
    // only path that can spend money, and it requires the operator token.
    if (mode === "paper" && !hasOperatorToken(request)) {
      return NextResponse.json(
        { error: "Paper execution requires the operator token.", requestId },
        { status: 403, headers },
      );
    }

    try {
      const run = await runAgent(mode, "manual");
      return NextResponse.json(run, { status: run.status === "ERROR" ? 502 : 200, headers });
    } catch (error) {
      // The message can carry upstream detail, so it is logged rather than returned verbatim.
      return NextResponse.json(
        {
          error: "The agent run failed. See the audit ledger for what was recorded.",
          detail: error instanceof Error ? error.message : "Unknown agent error",
          requestId,
        },
        { status: 500, headers },
      );
    }
  });
}
