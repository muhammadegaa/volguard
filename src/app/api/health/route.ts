import { NextResponse } from "next/server";
import { AlpacaClient } from "@/lib/alpaca-api";
import { getConfig, isConfigured } from "@/lib/config";
import { withRequestLog } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

/**
 * Liveness and readiness in one document.
 *
 * `live` means the process is serving. `ready` additionally means the paper credentials work
 * and the paper lock holds, which is what a deploy check should gate on — a running instance
 * that cannot reach Alpaca is not actually useful, and one pointed at a live endpoint must
 * never be considered healthy.
 *
 * `?deep=1` performs a real authenticated Alpaca call. The default is dependency-free so an
 * uptime monitor polling every minute does not consume the API budget.
 */
export async function GET(request: Request) {
  return withRequestLog("health", request, async (requestId) => {
    const deep = new URL(request.url).searchParams.get("deep") === "1";
    const config = getConfig();
    const configured = isConfigured();

    const checks: Record<string, { ok: boolean; detail: string }> = {
      process: { ok: true, detail: "Serving requests" },
      credentials: {
        ok: configured,
        detail: configured ? "Alpaca paper credentials present" : "Alpaca credentials are not configured",
      },
      paper_lock: {
        ok: config.paperOnly,
        detail: config.paperOnly ? "Paper endpoint enforced" : "NON-PAPER ENDPOINT CONFIGURED",
      },
      kill_switch: {
        ok: true,
        detail: config.killSwitch ? "Engaged — all orders blocked" : "Clear",
      },
    };

    if (deep && configured) {
      try {
        const account = await new AlpacaClient().getAccount();
        const idVerified = [account.id, account.account_number].includes(config.accountId);
        checks.alpaca = {
          ok: account.status === "ACTIVE" && idVerified,
          detail: `Account ${account.status}, id ${idVerified ? "verified" : "MISMATCH"}, options L${account.options_trading_level ?? "?"}`,
        };
      } catch (error) {
        checks.alpaca = {
          ok: false,
          detail: error instanceof Error ? error.message : "Alpaca request failed",
        };
      }
    }

    // A failed paper lock is never "degraded" — it is a hard failure regardless of anything else.
    const ready = Object.values(checks).every((check) => check.ok);
    const status = !config.paperOnly ? 503 : ready ? 200 : 503;

    return NextResponse.json(
      {
        status: status === 200 ? "ready" : "not_ready",
        live: true,
        ready,
        paperOnly: config.paperOnly,
        deep,
        checks,
        requestId,
        at: new Date().toISOString(),
      },
      { status, headers: { "cache-control": "no-store" } },
    );
  });
}
