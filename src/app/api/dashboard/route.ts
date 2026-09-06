import { NextResponse } from "next/server";
import { getEvents, getRuns, getScheduleState, storageStatus } from "@/lib/audit-store";
import { AlpacaClient } from "@/lib/alpaca-api";
import { getConfig, isConfigured } from "@/lib/config";
import { getMcpBridgeStatus } from "@/lib/mcp-bridge";
import { dailyLossUsed, summarizePerformance } from "@/lib/performance";
import { countOpenPositions, reviewPositions } from "@/lib/positions";
import type { DashboardSnapshot } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const config = getConfig();
  const [recentRuns, auditEvents, schedule] = await Promise.all([
    getRuns(10),
    getEvents(60),
    getScheduleState(),
  ]);

  const nextEligibleAt = schedule.lastScheduledRunAt
    ? new Date(Date.parse(schedule.lastScheduledRunAt) + config.scheduleIntervalMinutes * 60_000).toISOString()
    : null;

  const snapshot: DashboardSnapshot = {
    configured: isConfigured(),
    paperOnly: config.paperOnly,
    killSwitch: config.killSwitch,
    schedule: {
      enabled: config.scheduleEnabled,
      intervalMinutes: config.scheduleIntervalMinutes,
      lastRunAt: schedule.lastScheduledRunAt,
      nextEligibleAt,
    },
    account: {
      id: null,
      accountNumber: null,
      status: null,
      equity: null,
      cash: null,
      buyingPower: null,
      optionsLevel: null,
      idVerified: false,
    },
    clock: { isOpen: null, nextOpen: null, nextClose: null },
    positions: [],
    openPositionCount: 0,
    performance: {
      equity: null,
      baseValue: null,
      totalPl: null,
      totalPlPct: null,
      maxDrawdownPct: null,
      closedTrades: 0,
      wins: 0,
      losses: 0,
      realizedPl: null,
      totalFees: null,
      slippage: null,
      source: "unavailable",
      note: "Connect the paper account to load performance from Alpaca.",
    },
    dailyLossUsed: 0,
    // Only the newest run is ever rendered in detail, and per-symbol observations are the
    // bulk of a run record — sending them for all ten made this an 84 KB response polled
    // every thirty seconds.
    recentRuns: recentRuns.map((run, index) =>
      index === 0 ? run : { ...run, scanned: run.scanned.map((s) => ({ ...s, observation: null })) },
    ),
    auditEvents,
    storage: (() => {
      const status = storageStatus();
      return { durable: status.durable, ephemeral: status.ephemeral, lastError: status.lastError };
    })(),
    configIssues: config.issues,
    mcp: getMcpBridgeStatus(),
    limits: {
      maxLossPerTrade: config.maxLossPerTrade,
      maxRiskPercent: config.maxRiskPercent,
      maxDailyLoss: config.maxDailyLoss,
      maxOpenPositions: config.maxOpenPositions,
      maxSpreadPercent: config.maxSpreadPercent,
      maxQuoteAgeSeconds: config.maxQuoteAgeSeconds,
    },
    message: isConfigured()
      ? "Loading live account state from Alpaca."
      : "Add Alpaca paper credentials to .env.local to enable live account state. Dry-run still exercises the control path.",
  };

  if (!isConfigured()) return NextResponse.json(snapshot);

  try {
    const client = new AlpacaClient();
    const [account, clock, positions, history, fills] = await Promise.all([
      client.getAccount(),
      client.getClock(),
      client.getPositions(),
      client.getPortfolioHistory().catch(() => null),
      client.getActivities("FILL", 100).catch(() => []),
    ]);

    const idVerified = [account.id, account.account_number].filter(Boolean).includes(config.accountId);
    snapshot.account = {
      id: account.id,
      accountNumber: account.account_number ?? null,
      status: account.status,
      equity: Number(account.equity),
      cash: Number(account.cash),
      buyingPower: Number(account.buying_power),
      optionsLevel: account.options_trading_level ?? null,
      idVerified,
    };
    snapshot.clock = { isOpen: clock.is_open, nextOpen: clock.next_open, nextClose: clock.next_close };
    snapshot.positions = reviewPositions(positions, config);
    snapshot.openPositionCount = countOpenPositions(snapshot.positions);
    snapshot.performance = summarizePerformance({ history, fills, runs: recentRuns });
    snapshot.dailyLossUsed = dailyLossUsed(account);
    snapshot.message = idVerified
      ? "Connected to the configured Alpaca paper account; account ID verified."
      : "Connected to Alpaca, but ALPACA_ACCOUNT_ID does not match this account. Paper execution is blocked.";
  } catch (error) {
    snapshot.message = error instanceof Error ? `Alpaca connection error: ${error.message}` : "Alpaca connection error";
  }

  return NextResponse.json(snapshot);
}
