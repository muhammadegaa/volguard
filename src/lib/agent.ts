import { randomUUID } from "node:crypto";
import {
  acquireRunLock,
  appendEvent,
  getIvHistory,
  recordIvObservation,
  releaseRunLock,
  saveRun,
} from "./audit-store";
import { AlpacaClient } from "./alpaca-api";
import { buildOrderIntent, orderPayload, selectDebitSpread } from "./chain";
import { getConfig, isConfigured, modeIsAllowed, type VolGuardConfig } from "./config";
import { classifyEventRisk } from "./events";
import { closePayload, countOpenPositions, openRiskDollars, reviewPositions } from "./positions";
import { dailyLossUsed as dailyLossFromAccount } from "./performance";
import { evaluateRisk } from "./risk";
import { decideStrategy, type StrategyVerdict } from "./strategy";
import { generateThesis } from "./thesis";
import type {
  AgentMode,
  AgentRun,
  AlpacaAccount,
  AuditEventType,
  MarketObservation,
  PositionReview,
  RunTrigger,
} from "./types";
import { buildVolatilityState, daysBetween, toChainRows, type ChainRow } from "./volatility";

function event(runId: string, type: AuditEventType, message: string, data?: Record<string, unknown>) {
  return appendEvent({ id: randomUUID(), runId, createdAt: new Date().toISOString(), type, message, data });
}

function isoDate(offsetDays = 0): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

/** Group chain rows by expiry so the term structure can be measured across expiries. */
function byExpiry(rows: ChainRow[]): Map<string, ChainRow[]> {
  const map = new Map<string, ChainRow[]>();
  for (const row of rows) {
    const list = map.get(row.expiry);
    if (list) list.push(row);
    else map.set(row.expiry, [row]);
  }
  return map;
}

export interface SymbolAnalysis {
  observation: MarketObservation;
  verdict: StrategyVerdict;
  rows: ChainRow[];
}

/**
 * Gather everything needed to price movement for one underlying: daily bars for realized
 * volatility, the option chain for implied volatility and greeks, and news plus corporate
 * actions for event risk.
 */
export async function analyzeSymbol(
  client: AlpacaClient,
  symbol: string,
  config: VolGuardConfig,
  now = new Date(),
): Promise<SymbolAnalysis> {
  const unavailable: string[] = [];

  const [snapshot, bars, news, corporateActions] = await Promise.all([
    client.getStockSnapshot(symbol).catch(() => ({}) as Record<string, unknown>),
    client.getStockBars(symbol, config.barSessions).catch(() => []),
    client.getNews([symbol], 25).catch(() => []),
    client.getCorporateActions(symbol, isoDate(-5), isoDate(config.maxDte)),
  ]);

  const price = Number(
    (snapshot.latestTrade as { p?: number } | undefined)?.p ??
      (snapshot.dailyBar as { c?: number } | undefined)?.c ??
      bars[bars.length - 1]?.c ??
      0,
  );
  const previousClose = Number((snapshot.prevDailyBar as { c?: number } | undefined)?.c ?? 0) || null;
  if (!(price > 0)) unavailable.push("underlying price");
  if (bars.length < 21) unavailable.push("sufficient daily bars for realized volatility");

  // Pull a strike band around spot wide enough to contain both legs and the 25-delta
  // wings used for skew, across the whole DTE window so term structure is measurable.
  const chain = price > 0
    ? await client
        .getOptionChain({
          symbol,
          strikeGte: price * 0.85,
          strikeLte: price * 1.15,
          expirationGte: isoDate(config.minDte),
          expirationLte: isoDate(config.maxDte),
          // 1000 is the largest page Alpaca honours here (5000 returns an empty set), and
          // halving the page count matters: 14 symbols paging a liquid chain approaches the
          // 200 req/min account limit.
          limit: 1000,
          targetDte: config.targetDte,
        })
        .catch(() => ({}))
    : {};

  const rows = toChainRows(chain);
  if (rows.length === 0) unavailable.push("option chain snapshots");

  const grouped = byExpiry(rows);
  const expiries = [...grouped.keys()].sort();
  const today = isoDate();
  // Trade the expiry nearest the target horizon rather than the nearest listed one. The
  // front weekly has the widest relative spreads and the most gamma. Whichever expiry wins,
  // the volatility forecast is made over that same horizon.
  const targetExpiry = expiries.length > 0
    ? expiries.reduce((best, expiry) =>
        Math.abs(daysBetween(`${today}T00:00:00Z`, `${expiry}T00:00:00Z`) - config.targetDte) <
        Math.abs(daysBetween(`${today}T00:00:00Z`, `${best}T00:00:00Z`) - config.targetDte)
          ? expiry
          : best)
    : null;
  const targetRows = targetExpiry ? (grouped.get(targetExpiry) ?? []) : [];
  // Term structure is measured across the widest span the window offers.
  const frontRows = expiries.length > 0 ? (grouped.get(expiries[0]) ?? []) : [];
  const backExpiry = expiries[expiries.length - 1] ?? null;
  const backRows = backExpiry && backExpiry !== expiries[0] ? (grouped.get(backExpiry) ?? []) : [];
  if (backRows.length === 0) unavailable.push("a second expiry for the term-structure slope");

  const daysToExpiry = targetExpiry ? daysBetween(`${today}T00:00:00Z`, `${targetExpiry}T00:00:00Z`) : null;

  const ivHistory = await getIvHistory(symbol);
  const volatility = buildVolatilityState({
    bars,
    targetRows,
    frontRows,
    backRows,
    ivHistory,
    minIvSamples: config.minIvSamplesForRank,
    horizonDays: daysToExpiry ?? config.targetDte,
  });
  if (volatility.atmImpliedVol === null) unavailable.push("at-the-money implied volatility");

  // Persist today's ATM IV so implied-vol rank becomes available as history accrues.
  if (volatility.atmImpliedVol !== null) {
    const series = await recordIvObservation(symbol, volatility.atmImpliedVol, isoDate());
    volatility.ivSamples = series.length;
  }

  const trend = bars.length >= 20
    ? price / (bars.slice(-20).reduce((sum, bar) => sum + bar.c, 0) / 20) - 1
    : null;

  const observation: MarketObservation = {
    symbol,
    price,
    previousClose,
    dailyReturn: price && previousClose ? price / previousClose - 1 : null,
    trend,
    volatility,
    event: classifyEventRisk({ symbol, news, corporateActions, now }),
    targetExpiry,
    daysToExpiry: targetExpiry ? daysBetween(`${isoDate()}T00:00:00Z`, `${targetExpiry}T00:00:00Z`) : null,
    chainContracts: rows.length,
    dataAsOf: now.toISOString(),
    source: "alpaca",
    unavailable,
  };

  return { observation, verdict: decideStrategy(observation, config), rows: targetRows };
}

async function reviewAndExit(input: {
  client: AlpacaClient;
  runId: string;
  mode: AgentMode;
  config: VolGuardConfig;
  positions: Array<Record<string, unknown>>;
}): Promise<{ reviews: PositionReview[]; exitOrderIds: string[] }> {
  const reviews = reviewPositions(input.positions, input.config);
  const toClose = reviews.filter((review) => review.action === "close");
  if (reviews.length > 0) {
    await event(input.runId, "POSITION_REVIEW", `Reviewed ${reviews.length} open option leg(s); ${toClose.length} flagged to close`, {
      reviews,
    });
  }

  const exitOrderIds: string[] = [];
  for (const review of toClose) {
    // Deterministic per leg per day: a repeated run cannot double-close a position.
    const clientOrderId = `volguard-exit-${isoDate()}-${review.symbol}`.toLowerCase();
    if (input.mode === "dry-run") {
      await event(input.runId, "EXIT_SKIPPED", `Dry-run would close ${review.symbol}: ${review.reason}`, closePayload(review, clientOrderId));
      continue;
    }
    const existing = await input.client.findOrderByClientId(clientOrderId).catch(() => null);
    if (existing) {
      await event(input.runId, "EXIT_SKIPPED", `Exit for ${review.symbol} already submitted today`, { clientOrderId });
      continue;
    }
    try {
      const order = await input.client.submitOrder(closePayload(review, clientOrderId));
      if (typeof order.id === "string") exitOrderIds.push(order.id);
      await event(input.runId, "EXIT_SUBMITTED", `Closed ${review.symbol}: ${review.reason}`, order);
    } catch (error) {
      await event(input.runId, "ERROR", `Exit for ${review.symbol} failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
  return { reviews, exitOrderIds };
}

export async function runAgent(mode: AgentMode, trigger: RunTrigger = "manual"): Promise<AgentRun> {
  const runId = randomUUID();
  const startedAt = new Date();
  const config = getConfig();

  const finish = async (
    partial: Partial<AgentRun> & Pick<AgentRun, "status" | "message">,
  ): Promise<AgentRun> => {
    const result: AgentRun = {
      id: runId,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      mode,
      trigger,
      symbol: null,
      scanned: [],
      observation: null,
      thesis: null,
      risk: null,
      orderIntent: null,
      alpacaOrderId: null,
      positionReviews: [],
      exitOrderIds: [],
      durationMs: Date.now() - startedAt.getTime(),
      ...partial,
    };
    await saveRun(result);
    await event(runId, "AGENT_FINISHED", result.message, { status: result.status, mode, trigger, durationMs: result.durationMs });
    await releaseRunLock(runId);
    return result;
  };

  if (!(await acquireRunLock(runId, config.runTimeoutMs))) {
    await event(runId, "SCHEDULE_SKIPPED", "Another agent run is already in flight");
    return finish({ status: "NO_TRADE", message: "Another agent run is already in flight; this run was skipped to avoid duplicate orders." });
  }

  await event(runId, "AGENT_STARTED", `Agent run started in ${mode} mode (${trigger})`, { mode, trigger });

  if (!modeIsAllowed(mode)) {
    return finish({
      status: "CONFIGURATION_REQUIRED",
      message: mode === "paper"
        ? "Paper mode requires configured paper credentials and a verified account ID."
        : "Agent mode is not allowed.",
    });
  }
  if (config.killSwitch) {
    return finish({ status: "TRADE_REJECTED", message: "Global kill switch is enabled; no order can be considered." });
  }
  if (!isConfigured()) {
    return finish({
      status: "CONFIGURATION_REQUIRED",
      message: "Configure Alpaca paper credentials before running the agent.",
    });
  }

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Agent run exceeded the ${config.runTimeoutMs}ms timeout`)), config.runTimeoutMs),
  );

  try {
    return await Promise.race([execute(), timeout]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown agent error";
    await event(runId, "ERROR", message);
    return finish({ status: "ERROR", message });
  }

  async function execute(): Promise<AgentRun> {
    const client = new AlpacaClient();
    const account: AlpacaAccount = await client.getAccount();
    const accountIds = [account.id, account.account_number].filter((value): value is string => Boolean(value));
    if (!accountIds.includes(config.accountId)) {
      return finish({
        status: "CONFIGURATION_REQUIRED",
        message: "Configured account ID does not match the connected Alpaca paper account.",
      });
    }

    const [clock, positions] = await Promise.all([client.getClock(), client.getPositions()]);

    // Position management runs whether or not a new entry is available: exits are not
    // conditional on finding a fresh setup.
    const { reviews, exitOrderIds } = await reviewAndExit({ client, runId, mode, config, positions });

    // Scan the whole universe, then act on the single best mispricing. The scan runs whether
    // or not the market is open — the analysis is the product, and a closed market is an
    // execution gate (`market_open` in the risk engine), not a reason to show nothing.
    const analyses = await Promise.all(
      config.symbols.map((symbol) =>
        analyzeSymbol(client, symbol, config).catch((error): SymbolAnalysis | null => {
          void event(runId, "ERROR", `Analysis failed for ${symbol}: ${error instanceof Error ? error.message : "unknown"}`);
          return null;
        }),
      ),
    );
    const usable = analyses.filter((item): item is SymbolAnalysis => item !== null);
    const scanned = usable.map((item) => ({
      symbol: item.observation.symbol,
      verdict: item.verdict.verdict,
      varianceRiskPremium: item.observation.volatility.varianceRiskPremium,
      // Headlines are trimmed because six full news payloads per run would dominate the
      // ledger; three is what the interface renders.
      observation: {
        ...item.observation,
        event: { ...item.observation.event, matchedHeadlines: item.observation.event.matchedHeadlines.slice(0, 3) },
      },
    }));
    await event(runId, "OBSERVATION", `Scanned ${usable.length} symbol(s) for volatility mispricing`, {
      scanned: scanned.map(({ symbol, verdict, varianceRiskPremium }) => ({ symbol, verdict, varianceRiskPremium })),
    });

    // Most negative variance risk premium is the cheapest optionality on offer.
    const tradable = usable
      .filter((item) => item.verdict.strategy !== "no_trade")
      .sort((a, b) =>
        (a.observation.volatility.varianceRiskPremium ?? 0) - (b.observation.volatility.varianceRiskPremium ?? 0),
      );

    if (tradable.length === 0) {
      const best = usable[0];
      return finish({
        status: "NO_TRADE",
        symbol: best?.observation.symbol ?? null,
        scanned,
        observation: best?.observation ?? null,
        thesis: best ? await generateThesis(best.observation, best.verdict) : null,
        positionReviews: reviews,
        exitOrderIds,
        message: usable.length === 0
          ? "No symbol returned usable Alpaca data this run."
          : `No symbol cleared the entry gate. ${scanned.map((s) => `${s.symbol}: ${s.verdict}`).join(" · ")}`,
      });
    }

    const chosen = tradable[0];
    const { observation, verdict } = chosen;
    const thesis = await generateThesis(observation, verdict);
    await event(runId, "THESIS_GENERATED", `Generated ${thesis.source} thesis for ${observation.symbol}`, { ...thesis });

    // The model is allowed to veto. It is not allowed to create a trade.
    if (thesis.strategy === "no_trade") {
      return finish({
        status: "NO_TRADE",
        symbol: observation.symbol,
        scanned,
        observation,
        thesis,
        positionReviews: reviews,
        exitOrderIds,
        message: `Thesis review downgraded ${observation.symbol} to no trade: ${thesis.catalyst}`,
      });
    }

    // Outside regular hours every quote is stale by definition, so spread selection would
    // reject on quote age and report it as missing data. Say the real reason instead.
    if (!clock.is_open) {
      return finish({
        status: "NO_TRADE",
        symbol: observation.symbol,
        scanned,
        observation,
        thesis,
        positionReviews: reviews,
        exitOrderIds,
        message: `Market is closed, so no order was constructed. ${observation.symbol} is the standing candidate on last-session data; next open ${clock.next_open}. ${reviews.length} open leg(s) reviewed.`,
      });
    }

    const candidate = selectDebitSpread({ rows: chosen.rows, strategy: thesis.strategy, config, now: new Date() });
    if (!candidate || candidate.rejection) {
      return finish({
        status: "DATA_UNAVAILABLE",
        symbol: observation.symbol,
        scanned,
        observation,
        thesis,
        positionReviews: reviews,
        exitOrderIds,
        message: candidate?.rejection ?? "Alpaca did not return two contracts that form a tradable debit spread.",
      });
    }

    const today = isoDate();
    // Sourced from Alpaca equity vs previous close, so the budget reflects real drawdown.
    const dailyLossUsed = dailyLossFromAccount(account);
    // Deterministic within a symbol/strategy/day: replaying a run cannot double-submit.
    const clientOrderId = `volguard-${today}-${observation.symbol}-${thesis.strategy}`.toLowerCase();
    const intent = buildOrderIntent({
      symbol: observation.symbol,
      strategy: thesis.strategy,
      candidate,
      equity: Number(account.equity),
      dailyLossRemaining: config.maxDailyLoss - dailyLossUsed,
      openInterest: { long: null, short: null },
      config,
      clientOrderId,
    });

    if (intent.qty < 1) {
      return finish({
        status: "NO_TRADE",
        symbol: observation.symbol,
        scanned,
        observation,
        thesis,
        orderIntent: intent,
        positionReviews: reviews,
        exitOrderIds,
        message: `A single spread costs $${(candidate.debit * 100).toFixed(2)}, which exceeds the remaining risk budget. No position was opened.`,
      });
    }

    const duplicate = mode === "paper"
      ? Boolean(await client.findOrderByClientId(clientOrderId).catch(() => null))
      : false;

    const risk = evaluateRisk({
      account,
      openPositionCount: countOpenPositions(reviews.filter((review) => review.action === "hold")),
      openRiskDollars: openRiskDollars(reviews),
      dailyLossUsed,
      intent,
      duplicateClientOrderId: duplicate,
      marketOpen: clock.is_open,
    });

    if (!risk.approved) {
      await event(runId, "RISK_REJECTED", "Risk engine rejected the candidate order", { reasons: risk.reasons, checks: risk.checks });
      return finish({
        status: "TRADE_REJECTED",
        symbol: observation.symbol,
        scanned,
        observation,
        thesis,
        risk,
        orderIntent: intent,
        positionReviews: reviews,
        exitOrderIds,
        message: risk.reasons.join("; "),
      });
    }

    if (mode === "dry-run") {
      await event(runId, "ORDER_SKIPPED", "Dry-run approved the order but did not submit it", orderPayload(intent));
      return finish({
        status: "TRADE_APPROVED",
        symbol: observation.symbol,
        scanned,
        observation,
        thesis,
        risk,
        orderIntent: intent,
        positionReviews: reviews,
        exitOrderIds,
        message: `Dry-run approved a ${intent.qty}-lot ${thesis.strategy.replace(/_/g, " ")} on ${observation.symbol} at a $${intent.limitPrice.toFixed(2)} debit. No order was submitted.`,
      });
    }

    const order = await client.submitOrder(orderPayload(intent));
    await event(runId, "ORDER_SUBMITTED", "Paper order submitted to Alpaca", order);
    return finish({
      status: "TRADE_APPROVED",
      symbol: observation.symbol,
      scanned,
      observation,
      thesis,
      risk,
      orderIntent: intent,
      alpacaOrderId: typeof order.id === "string" ? order.id : null,
      positionReviews: reviews,
      exitOrderIds,
      message: `Paper order submitted: ${intent.qty}-lot ${thesis.strategy.replace(/_/g, " ")} on ${observation.symbol} at a $${intent.limitPrice.toFixed(2)} debit, risking $${intent.maxLoss.toFixed(2)}.`,
    });
  }
}
