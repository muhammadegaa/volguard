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
import { orderPayload } from "./chain";
import { clientOrderIdFor, planAllocation, type AllocationCandidate } from "./allocation";
import { getConfig, isConfigured, modeIsAllowed, type VolGuardConfig } from "./config";
import { classifyEventRisk } from "./events";
import { closePayload, closeSpreadPayload, countOpenPositions, groupVerticals, openRiskDollars, reviewPositions, reviewSpreads } from "./positions";
import { dailyLossUsed as dailyLossFromAccount } from "./performance";
import { decideStrategy, type StrategyVerdict } from "./strategy";
import { generateThesis } from "./thesis";
import type {
  AgentMode,
  AgentRun,
  AlpacaAccount,
  AuditEventType,
  Decision,
  DecisionStatus,
  MarketObservation,
  PositionReview,
  RunTrigger,
  StrategyKind,
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
  // Group-level decisions: judging legs individually would close a credit spread's cheap
  // wing on its own and leave a naked short.
  const reviews = reviewSpreads(reviewPositions(input.positions, input.config), input.config);
  const toClose = reviews.filter((review) => review.action === "close");
  if (reviews.length > 0) {
    await event(input.runId, "POSITION_REVIEW", `Reviewed ${reviews.length} open option leg(s); ${toClose.length} flagged to close`, {
      reviews,
    });
  }

  const exitOrderIds: string[] = [];

  // Close whole positions, not legs. reviewSpreads already decides at group level, but
  // submitting one single-leg order per leg reopens the hazard it exists to prevent: if the
  // second submission fails, the short leg is left unhedged. One multi-leg order per group
  // cannot be half-filled in that way.
  for (const group of groupVerticals(reviews.filter((review) => review.action === "close"))) {
    const single = group.legs.length === 1;
    const clientOrderId = `volguard-exit-${isoDate()}-${single ? group.legs[0].symbol : group.key}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");
    const payload = single
      ? closePayload(group.legs[0], clientOrderId)
      : closeSpreadPayload(group, clientOrderId);
    const label = single ? group.legs[0].symbol : `${group.legs.length}-leg ${group.key}`;
    const reason = group.legs[0].reason;

    if (input.mode === "dry-run") {
      await event(input.runId, "EXIT_SKIPPED", `Dry-run would close ${label}: ${reason}`, payload);
      continue;
    }
    const existing = await input.client.findOrderByClientId(clientOrderId).catch(() => null);
    if (existing) {
      await event(input.runId, "EXIT_SKIPPED", `Exit for ${label} already submitted today`, { clientOrderId });
      continue;
    }
    try {
      const order = await input.client.submitOrder(payload);
      if (typeof order.id === "string") exitOrderIds.push(order.id);
      await event(input.runId, "EXIT_SUBMITTED", `Closed ${label}: ${reason}`, order);
    } catch (error) {
      await event(input.runId, "ERROR", `Exit for ${label} failed: ${error instanceof Error ? error.message : "unknown"}`, { clientOrderId });
    }
  }

  return { reviews, exitOrderIds };
}

export async function runAgent(mode: AgentMode, trigger: RunTrigger = "manual"): Promise<AgentRun> {
  const runId = randomUUID();
  const startedAt = new Date();
  const config = getConfig();

  // Losing the timeout race must stop the run from acting, not merely stop the caller from
  // waiting. Without this, a timed-out run kept executing and could still place a real order
  // after the caller had been told it failed.
  const abort = new AbortController();

  // Work already done is carried into whatever terminal record the run ends up with. An
  // ERROR that reset these to defaults erased exits that had genuinely been submitted.
  const progress: Pick<AgentRun, "scanned" | "positionReviews" | "exitOrderIds"> = {
    scanned: [],
    positionReviews: [],
    exitOrderIds: [],
  };

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
      decisions: [],
      observation: null,
      thesis: null,
      risk: null,
      orderIntent: null,
      alpacaOrderId: null,
      ...progress,
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

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Signal first: the losing branch must be prevented from submitting anything.
      abort.abort();
      reject(new Error(`Agent run exceeded the ${config.runTimeoutMs}ms timeout`));
    }, config.runTimeoutMs);
  });

  try {
    return await Promise.race([execute(), timeout]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown agent error";
    await event(runId, "ERROR", message);
    return finish({ status: "ERROR", message });
  } finally {
    // An uncleared timer holds the event loop for the full timeout after every fast run.
    if (timer) clearTimeout(timer);
    abort.abort();
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
    progress.positionReviews = reviews;
    progress.exitOrderIds = exitOrderIds;

    // Scan the whole universe, then act on the single best mispricing. The scan runs whether
    // or not the market is open — the analysis is the product, and a closed market is an
    // execution gate (`market_open` in the risk engine), not a reason to show nothing.
    const analyses = await Promise.all(
      config.symbols.map((symbol) =>
        analyzeSymbol(client, symbol, config).catch(async (error): Promise<SymbolAnalysis | null> => {
          // Awaited, not fired and forgotten: an unhandled rejection here would surface as
          // an isolate-level crash rather than a recorded per-symbol failure.
          await event(runId, "ERROR", `Analysis failed for ${symbol}: ${error instanceof Error ? error.message : "unknown"}`)
            .catch(() => undefined);
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
    progress.scanned = scanned;
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
      const thesis = best ? await generateThesis(best.observation, best.verdict) : null;
      const message = usable.length === 0
        ? "No symbol returned usable Alpaca data this run."
        : `No symbol cleared the entry gate. ${scanned.map((s) => `${s.symbol}: ${s.verdict}`).join(" · ")}`;
      return finish({
        status: "NO_TRADE",
        symbol: best?.observation.symbol ?? null,
        scanned,
        decisions: best && thesis
          ? [{ symbol: best.observation.symbol, status: "NO_TRADE", observation: best.observation, thesis, risk: null, orderIntent: null, alpacaOrderId: null, message }]
          : [],
        observation: best?.observation ?? null,
        thesis,
        positionReviews: reviews,
        exitOrderIds,
        message,
      });
    }

    // Outside regular hours every quote is stale by definition, so spread selection would
    // reject on quote age and report it as missing data. Say the real reason instead — and
    // only for the leading candidate, since nothing can be allocated either way.
    if (!clock.is_open) {
      const best = tradable[0];
      const thesis = await generateThesis(best.observation, best.verdict);
      const message = `Market is closed, so no order was constructed. ${best.observation.symbol} is the standing candidate on last-session data; next open ${clock.next_open}. ${reviews.length} open leg(s) reviewed.`;
      return finish({
        status: "NO_TRADE",
        symbol: best.observation.symbol,
        scanned,
        decisions: [{ symbol: best.observation.symbol, status: "NO_TRADE", observation: best.observation, thesis, risk: null, orderIntent: null, alpacaOrderId: null, message }],
        observation: best.observation,
        thesis,
        positionReviews: reviews,
        exitOrderIds,
        message,
      });
    }

    // Theses are generated for every candidate at once. The allocator below must be
    // sequential because each approval spends budget the next candidate can no longer see,
    // but nothing about a thesis depends on the budget — running them in series would put
    // several model round trips on the critical path of a 45-second run.
    const theses = await Promise.all(tradable.map((item) => generateThesis(item.observation, item.verdict)));
    const candidates: AllocationCandidate[] = tradable.map((item, index) => ({ ...item, thesis: theses[index] }));
    for (const candidate of candidates) {
      await event(runId, "THESIS_GENERATED", `Generated ${candidate.thesis.source} thesis for ${candidate.observation.symbol}`, { ...candidate.thesis });
    }

    const today = isoDate();
    // Checked up front so the allocator itself stays pure and synchronous. Only paper mode
    // can collide with a real order.
    const duplicateClientOrderIds = new Set<string>();
    if (mode === "paper") {
      const ids = candidates
        .filter((candidate) => candidate.thesis.strategy !== "no_trade")
        .map((candidate) => clientOrderIdFor(today, candidate.observation.symbol, candidate.thesis.strategy as Exclude<StrategyKind, "no_trade">));
      const found = await Promise.all(ids.map((id) => client.findOrderByClientId(id).catch(() => null)));
      found.forEach((order, index) => { if (order) duplicateClientOrderIds.add(ids[index]); });
    }

    const decisions = planAllocation({
      candidates,
      account,
      config,
      marketOpen: clock.is_open,
      openPositionCount: countOpenPositions(reviews.filter((review) => review.action === "hold")),
      openRiskDollars: openRiskDollars(reviews, config.maxLossPerTrade),
      // Sourced from Alpaca equity vs previous close, so the budget reflects real drawdown.
      dailyLossUsed: dailyLossFromAccount(account),
      duplicateClientOrderIds,
      today,
    });

    for (const decision of decisions.filter((item) => item.status === "TRADE_REJECTED")) {
      await event(runId, "RISK_REJECTED", `Risk engine rejected ${decision.symbol}`, { reasons: decision.risk?.reasons, checks: decision.risk?.checks });
    }

    for (const decision of decisions) {
      if (decision.status !== "TRADE_APPROVED" || !decision.orderIntent) continue;
      const intent = decision.orderIntent;

      if (mode === "dry-run") {
        await event(runId, "ORDER_SKIPPED", `Dry-run approved ${decision.symbol} but did not submit it`, orderPayload(intent));
        continue;
      }

      // The last gate, and the only one about this process rather than the market: a run
      // that already lost the timeout race must not place an order the caller was told did
      // not happen. Later candidates are abandoned for the same reason.
      if (abort.signal.aborted) {
        decision.status = "ERROR";
        decision.message = "The run exceeded its timeout before this order could be submitted. Nothing was sent.";
        await event(runId, "ORDER_SKIPPED", `Run timed out before ${decision.symbol} was submitted; no order was placed`, { clientOrderId: intent.clientOrderId });
        continue;
      }

      try {
        const order = await client.submitOrder(orderPayload(intent));
        decision.alpacaOrderId = typeof order.id === "string" ? order.id : null;
        await event(runId, "ORDER_SUBMITTED", `Paper order submitted for ${decision.symbol}`, order);
      } catch (error) {
        // Alpaca may have accepted the order before the failure — a network timeout after
        // acceptance looks identical here. The intent and the client order id are what make
        // that recoverable, so they are recorded rather than lost to a bare ERROR.
        const detail = error instanceof Error ? error.message : "unknown submission error";
        decision.status = "ERROR";
        decision.message = `Order submission failed: ${detail}. Alpaca may still have accepted it — reconcile against client order id ${intent.clientOrderId} before retrying.`;
        await event(runId, "ERROR", `Order submission failed for ${decision.symbol}: ${detail}`, { clientOrderId: intent.clientOrderId, intent });
      }
    }

    return finish({
      ...runView(decisions, mode),
      scanned,
      decisions,
      positionReviews: reviews,
      exitOrderIds,
    });
  }
}

/**
 * Collapse the per-symbol decisions into the single status and message the run reports, and
 * project the primary decision onto the singular fields the ledger and dashboard read.
 *
 * A submission failure outranks a success: a run that opened two positions and then failed
 * on a third has an order that may exist at the broker, and that needs attention more than
 * the two that worked.
 */
function runView(decisions: Decision[], mode: AgentMode): Pick<AgentRun, "status" | "message" | "symbol" | "observation" | "thesis" | "risk" | "orderIntent" | "alpacaOrderId"> {
  const has = (status: DecisionStatus) => decisions.some((decision) => decision.status === status);
  const status: DecisionStatus = has("ERROR")
    ? "ERROR"
    : has("TRADE_APPROVED")
      ? "TRADE_APPROVED"
      : has("TRADE_REJECTED")
        ? "TRADE_REJECTED"
        : has("DATA_UNAVAILABLE")
          ? "DATA_UNAVAILABLE"
          : "NO_TRADE";

  const primary = decisions.find((decision) => decision.status === status) ?? decisions[0] ?? null;
  const opened = decisions.filter((decision) => decision.status === "TRADE_APPROVED");
  const declined = decisions.length - opened.length;

  const summary = opened.length > 0
    ? `${mode === "dry-run" ? "Dry-run approved" : "Opened"} ${opened.length} position(s): ${opened.map((decision) => decision.message).join(" · ")}`
    : primary?.message ?? "No candidate reached the allocator.";
  const tail = declined > 0 && opened.length > 0 ? ` ${declined} further candidate(s) declined.` : "";

  return {
    status,
    message: `${summary}${tail}`,
    symbol: primary?.symbol ?? null,
    observation: primary?.observation ?? null,
    thesis: primary?.thesis ?? null,
    risk: primary?.risk ?? null,
    orderIntent: primary?.orderIntent ?? null,
    alpacaOrderId: primary?.alpacaOrderId ?? null,
  };
}
