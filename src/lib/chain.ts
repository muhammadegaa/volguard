import type { VolGuardConfig } from "./config";
import type { ExitPlan, OptionLeg, OrderIntent, StrategyKind } from "./types";
import type { ChainRow } from "./volatility";

export interface LiquidityReport {
  relativeSpread: number | null;
  quoteAgeSeconds: number | null;
  minQuoteSize: number | null;
  passed: boolean;
  detail: string;
}

export function quoteAgeSeconds(quoteTime: string | null, now: Date): number | null {
  if (!quoteTime) return null;
  const ts = Date.parse(quoteTime);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, (now.getTime() - ts) / 1000);
}

/** A row is only tradable if it is two-sided, fresh, reasonably tight and has size. */
export function assessLiquidity(row: ChainRow, config: VolGuardConfig, now: Date): LiquidityReport {
  const age = quoteAgeSeconds(row.quoteTime, now);
  const size = row.bidSize !== null && row.askSize !== null ? Math.min(row.bidSize, row.askSize) : null;
  const relativeSpread =
    row.bid !== null && row.ask !== null && row.mid !== null && row.mid > 0 ? (row.ask - row.bid) / row.mid : null;

  const problems: string[] = [];
  if (row.bid === null || row.ask === null || row.mid === null) problems.push("quote is not two-sided");
  if (row.bid !== null && row.bid <= 0) problems.push("bid is zero");
  if (relativeSpread === null) problems.push("relative spread unavailable");
  else if (relativeSpread > config.maxSpreadPercent) {
    problems.push(`spread ${(relativeSpread * 100).toFixed(1)}% > ${(config.maxSpreadPercent * 100).toFixed(1)}% limit`);
  }
  if (age === null) problems.push("quote timestamp missing");
  else if (age > config.maxQuoteAgeSeconds) problems.push(`quote is ${age.toFixed(0)}s old > ${config.maxQuoteAgeSeconds}s limit`);
  if (size === null) problems.push("quote size unavailable");
  else if (size < config.minQuoteSize) problems.push(`quote size ${size} < ${config.minQuoteSize} minimum`);

  return {
    relativeSpread,
    quoteAgeSeconds: age,
    minQuoteSize: size,
    passed: problems.length === 0,
    detail: problems.length === 0
      ? `spread ${(relativeSpread ?? 0) * 100 < 0.05 ? "<0.1" : ((relativeSpread ?? 0) * 100).toFixed(1)}%, ${age?.toFixed(0) ?? "?"}s old, size ${size}`
      : problems.join("; "),
  };
}

/** Rows closest to a target |delta|, nearest first. */
function nearestByDelta(rows: ChainRow[], target: number, take: number): ChainRow[] {
  return rows
    .filter((row) => row.delta !== null)
    .sort((a, b) => Math.abs(Math.abs(a.delta as number) - target) - Math.abs(Math.abs(b.delta as number) - target))
    .slice(0, take);
}

export interface SpreadCandidate {
  longLeg: ChainRow;
  shortLeg: ChainRow;
  longLiquidity: LiquidityReport;
  shortLiquidity: LiquidityReport;
  debit: number;
  width: number;
  rejection: string | null;
}

/**
 * Build a debit vertical from one expiry: long the ~0.55-delta contract, short the
 * ~0.27-delta contract further out of the money. Debit spreads are the only structure
 * VolGuard trades because the maximum loss equals the premium paid and is known here,
 * before the order is ever built.
 */
export function selectDebitSpread(input: {
  rows: ChainRow[];
  strategy: Exclude<StrategyKind, "no_trade">;
  config: VolGuardConfig;
  now: Date;
  /** How many strikes around each delta target to consider. */
  breadth?: number;
}): SpreadCandidate | null {
  const optionType = input.strategy === "bull_call_debit_spread" ? "call" : "put";
  const rows = input.rows.filter((row) => row.type === optionType);
  if (rows.length < 2) return null;

  const breadth = input.breadth ?? 4;
  const longCandidates = nearestByDelta(rows, input.config.longLegDelta, breadth);
  const shortCandidates = nearestByDelta(rows, input.config.shortLegDelta, breadth);
  if (longCandidates.length === 0 || shortCandidates.length === 0) return null;

  const evaluated: SpreadCandidate[] = [];
  for (const longLeg of longCandidates) {
    for (const shortLeg of shortCandidates) {
      if (longLeg.symbol === shortLeg.symbol) continue;
      evaluated.push(evaluatePair(longLeg, shortLeg, optionType, input.config, input.now));
    }
  }
  if (evaluated.length === 0) return null;

  // Prefer a pair that clears every gate, best reward-for-risk first. A single thin or
  // stale quote on the nearest strike should not veto an otherwise tradable expiry.
  const viable = evaluated.filter((candidate) => candidate.rejection === null);
  if (viable.length > 0) {
    return viable.sort(
      (a, b) => (b.width - b.debit) / b.debit - (a.width - a.debit) / a.debit,
    )[0];
  }

  // Nothing qualified: return the closest miss so the run reports a specific reason.
  return evaluated[0];
}

function evaluatePair(
  longLeg: ChainRow,
  shortLeg: ChainRow,
  optionType: "call" | "put",
  config: VolGuardConfig,
  now: Date,
): SpreadCandidate {
  // A call debit spread is long the lower strike; a put debit spread is long the higher.
  const correctlyOrdered =
    optionType === "call" ? longLeg.strike < shortLeg.strike : longLeg.strike > shortLeg.strike;

  const longLiquidity = assessLiquidity(longLeg, config, now);
  const shortLiquidity = assessLiquidity(shortLeg, config, now);
  const width = Math.abs(shortLeg.strike - longLeg.strike);

  // Pay the ask on the long leg, receive the bid on the short leg: the price we could
  // actually cross at, never the mid.
  const debit =
    longLeg.ask !== null && shortLeg.bid !== null ? Number((longLeg.ask - shortLeg.bid).toFixed(2)) : Number.NaN;

  let rejection: string | null = null;
  if (!correctlyOrdered) rejection = "delta targets did not produce a correctly ordered vertical";
  else if (!Number.isFinite(debit)) rejection = "one leg is missing a tradable side of the quote";
  else if (debit <= 0) rejection = `net debit ${debit} is not positive; this is not a debit spread`;
  else if (!(width > 0)) rejection = "both legs resolved to the same strike";
  else if (debit >= width) rejection = `debit ${debit.toFixed(2)} >= width ${width.toFixed(2)}; no profit is possible`;
  else if (debit / width > config.maxDebitToWidth) {
    rejection = `debit is ${((debit / width) * 100).toFixed(0)}% of width, above the ${(config.maxDebitToWidth * 100).toFixed(0)}% limit`;
  } else if (!longLiquidity.passed) rejection = `long leg: ${longLiquidity.detail}`;
  else if (!shortLiquidity.passed) rejection = `short leg: ${shortLiquidity.detail}`;

  return { longLeg, shortLeg, longLiquidity, shortLiquidity, debit, width, rejection };
}

function toLeg(
  row: ChainRow,
  side: "buy" | "sell",
  liquidity: LiquidityReport,
  openInterest: number | null,
): OptionLeg {
  return {
    symbol: row.symbol,
    side,
    positionIntent: side === "buy" ? "buy_to_open" : "sell_to_open",
    ratioQty: 1,
    strike: row.strike,
    expirationDate: row.expiry,
    type: row.type,
    bid: row.bid,
    ask: row.ask,
    mid: row.mid,
    delta: row.delta,
    impliedVol: row.impliedVol,
    quoteAgeSeconds: liquidity.quoteAgeSeconds,
    bidSize: row.bidSize,
    askSize: row.askSize,
    openInterest,
  };
}

/**
 * Size the position so the worst case respects every dollar limit at once, then build
 * the order intent. qty of 0 means no size clears the limits and the caller must abstain.
 */
export function buildOrderIntent(input: {
  symbol: string;
  strategy: Exclude<StrategyKind, "no_trade">;
  candidate: SpreadCandidate;
  equity: number;
  dailyLossRemaining: number;
  openInterest: { long: number | null; short: number | null };
  config: VolGuardConfig;
  clientOrderId: string;
}): OrderIntent {
  const { candidate, config } = input;
  const perSpreadRisk = candidate.debit * 100;
  const budget = Math.min(
    config.maxLossPerTrade,
    input.equity * config.maxRiskPercent,
    Math.max(0, input.dailyLossRemaining),
  );
  const qty = Math.max(0, Math.min(config.maxContracts, Math.floor(budget / perSpreadRisk)));

  const maxLoss = perSpreadRisk * qty;
  const maxProfit = (candidate.width - candidate.debit) * 100 * qty;
  const breakeven =
    input.strategy === "bull_call_debit_spread"
      ? candidate.longLeg.strike + candidate.debit
      : candidate.longLeg.strike - candidate.debit;

  const exitPlan: ExitPlan = {
    takeProfitDebit: Number((candidate.debit + (candidate.width - candidate.debit) * config.takeProfitPercent).toFixed(2)),
    stopLossDebit: Number((candidate.debit * (1 - config.stopLossPercent)).toFixed(2)),
    timeStopDte: config.timeStopDte,
    note: `Close at +${(config.takeProfitPercent * 100).toFixed(0)}% of max profit, at -${(config.stopLossPercent * 100).toFixed(0)}% of premium, or at ${config.timeStopDte} DTE, whichever comes first.`,
  };

  return {
    clientOrderId: input.clientOrderId,
    symbol: input.symbol,
    strategy: input.strategy,
    qty,
    type: "limit",
    timeInForce: "day",
    limitPrice: candidate.debit,
    width: candidate.width,
    maxLoss,
    maxProfit,
    rewardRisk: maxLoss > 0 ? maxProfit / maxLoss : 0,
    breakeven: Number(breakeven.toFixed(2)),
    legs: [
      toLeg(candidate.longLeg, "buy", candidate.longLiquidity, input.openInterest.long),
      toLeg(candidate.shortLeg, "sell", candidate.shortLiquidity, input.openInterest.short),
    ],
    exitPlan,
  };
}

/** Alpaca multi-leg payload. `limit_price` is the net debit for the whole spread. */
export function orderPayload(intent: OrderIntent): Record<string, unknown> {
  return {
    order_class: "mleg",
    qty: String(intent.qty),
    type: intent.type,
    time_in_force: intent.timeInForce,
    limit_price: intent.limitPrice.toFixed(2),
    client_order_id: intent.clientOrderId,
    legs: intent.legs.map((leg) => ({
      symbol: leg.symbol,
      ratio_qty: String(leg.ratioQty),
      side: leg.side,
      position_intent: leg.positionIntent,
    })),
  };
}
