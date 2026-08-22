import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { runAgent } from "@/lib/agent";
import { AlpacaClient } from "@/lib/alpaca-api";
import { appendEvent, getScheduleState, markScheduledRun } from "@/lib/audit-store";
import { hasScheduleAuthorization } from "@/lib/auth";
import { getConfig, isConfigured } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

async function note(message: string, data?: Record<string, unknown>) {
  await appendEvent({
    id: randomUUID(),
    runId: "scheduler",
    createdAt: new Date().toISOString(),
    type: "SCHEDULE_SKIPPED",
    message,
    data,
  });
}

/**
 * Scheduled entry point for the autonomous loop.
 *
 * Serverless functions cannot hold a background timer between requests, so autonomy is
 * driven by an external clock (Vercel Cron, GitHub Actions, or any scheduler) calling this
 * endpoint. Every guard that matters lives here rather than in the caller: the endpoint is
 * safe to call more often than intended, and safe to call twice at once.
 */
export async function POST(request: Request) {
  const config = getConfig();

  if (!hasScheduleAuthorization(request)) {
    return NextResponse.json(
      { error: "Scheduled runs require the operator token or a valid cron secret." },
      { status: 403 },
    );
  }
  if (!config.scheduleEnabled) {
    await note("Scheduled run rejected: VOLGUARD_SCHEDULE_ENABLED is false");
    return NextResponse.json({ skipped: "schedule_disabled" }, { status: 200 });
  }
  if (config.killSwitch) {
    await note("Scheduled run rejected: kill switch is enabled");
    return NextResponse.json({ skipped: "kill_switch" }, { status: 200 });
  }
  if (!isConfigured()) {
    await note("Scheduled run rejected: Alpaca paper credentials are not configured");
    return NextResponse.json({ skipped: "not_configured" }, { status: 200 });
  }

  // Rate gate: honour the configured interval even if the external clock fires early.
  const { lastScheduledRunAt } = await getScheduleState();
  if (lastScheduledRunAt) {
    const elapsedMinutes = (Date.now() - Date.parse(lastScheduledRunAt)) / 60_000;
    if (elapsedMinutes < config.scheduleIntervalMinutes) {
      await note(`Scheduled run skipped: only ${elapsedMinutes.toFixed(1)}m since the last run, interval is ${config.scheduleIntervalMinutes}m`);
      return NextResponse.json({ skipped: "interval_not_elapsed", elapsedMinutes }, { status: 200 });
    }
  }

  // Observe only while the market is open. This is a cheap call and it keeps the agent
  // from burning chain requests overnight.
  try {
    const clock = await new AlpacaClient().getClock();
    if (!clock.is_open) {
      await markScheduledRun(new Date().toISOString());
      await note(`Scheduled run skipped: market is closed, next open ${clock.next_open}`);
      return NextResponse.json({ skipped: "market_closed", nextOpen: clock.next_open }, { status: 200 });
    }
  } catch (error) {
    await note(`Scheduled run could not read the Alpaca clock: ${error instanceof Error ? error.message : "unknown"}`);
    return NextResponse.json({ skipped: "clock_unavailable" }, { status: 200 });
  }

  await markScheduledRun(new Date().toISOString());
  const run = await runAgent(config.scheduleMode, "scheduled");
  return NextResponse.json(run, { status: run.status === "ERROR" ? 502 : 200 });
}

export async function GET(request: Request) {
  return POST(request);
}
