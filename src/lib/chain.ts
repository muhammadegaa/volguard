import { getConfig, type VolGuardConfig } from "./config";
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
  /** The leg bought. In a credit spread this is the far wing, not the valuable leg. */
  buyLeg: ChainRow;
  /** The leg sold. In a credit spread this is the near-the-money leg. */
  sellLeg: ChainRow;
  buyLiquidity: LiquidityReport;
  sellLiquidity: LiquidityReport;
  /** Signed net price per share: > 0 paid (debit), < 0 received (credit). */
  netPrice: number;
  width: number;
  rejection: string | null;
}

export interface SpreadGeometry {
  optionType: "call" | "put";
  /** True when we pay to open. False when we collect premium. */
  isDebit: boolean;
  /** |delta| target for the leg bought. */
  buyDelta: number;
  /** |delta| target for the leg sold. */
  sellDelta: number;
}

/**
 * The four defined-risk verticals differ only in a small geometry table. Deriving them from
 * one description keeps a single rejection ladder and a single sizing path, rather than four
 * copies to keep in step.
 */
export function structureGeometry(
  strategy: Exclude<StrategyKind, "no_trade">,
  config: VolGuardConfig,
): SpreadGeometry {
  switch (strategy) {
    case "bull_call_debit_spread":
      return { optionType: "call", isDebit: true, buyDelta: config.longLegDelta, sellDelta: config.shortLegDelta };
    case "bear_put_debit_spread":
      return { optionType: "put", isDebit: true, buyDelta: config.longLegDelta, sellDelta: config.shortLegDelta };
    case "bull_put_credit_spread":
      return { optionType: "put", isDebit: false, buyDelta: config.creditLongLegDelta, sellDelta: config.creditShortLegDelta };
    case "bear_call_credit_spread":
      return { optionType: "call", isDebit: false, buyDelta: config.creditLongLegDelta, sellDelta: config.creditShortLegDelta };
  }
}

/**
 * Build a defined-risk vertical from one expiry.
 *
 * Whichever of the four structures is asked for, the maximum loss is known here, before the
 * order exists: the premium paid for a debit, the strike width less the credit for a credit.
 * That is the property that makes any of this safe to automate.
 */
export function selectVerticalSpread(input: {
  rows: ChainRow[];
  strategy: Exclude<StrategyKind, "no_trade">;
  config: VolGuardConfig;
  now: Date;
  /** How many strikes around each delta target to consider. */
  breadth?: number;
}): SpreadCandidate | null {
  const geometry = structureGeometry(input.strategy, input.config);
  const rows = input.rows.filter((row) => row.type === geometry.optionType);
  if (rows.length < 2) return null;

  const breadth = input.breadth ?? 4;
  const buyCandidates = nearestByDelta(rows, geometry.buyDelta, breadth);
  const sellCandidates = nearestByDelta(rows, geometry.sellDelta, breadth);
  if (buyCandidates.length === 0 || sellCandidates.length === 0) return null;

  const evaluated: SpreadCandidate[] = [];
  for (const buyLeg of buyCandidates) {
    for (const sellLeg of sellCandidates) {
      if (buyLeg.symbol === sellLeg.symbol) continue;
      evaluated.push(evaluatePair(buyLeg, sellLeg, geometry, input.config, input.now));
    }
  }
  if (evaluated.length === 0) return null;

  // Prefer a pair that clears every gate, best reward-for-risk first. A single thin or
  // stale quote on the nearest strike should not veto an otherwise tradable expiry.
  const viable = evaluated.filter((candidate) => candidate.rejection === null);
  if (viable.length > 0) {
    // Debit ranks on reward:risk. Credit ranks on premium per dollar of width — both rise
    // with the premium at a fixed width, but they diverge across widths, and reward:risk
    // would push a seller toward the narrowest spread, which carries the worst fill quality
    // and the highest fee drag per dollar at risk. The delta target already pins the
    // probability of profit.
    const score = (c: SpreadCandidate) =>
      geometry.isDebit
        ? (c.width - c.netPrice) / c.netPrice
        : Math.abs(c.netPrice) / c.width;
    return viable.sort((a, b) => score(b) - score(a))[0];
  }

  // Nothing qualified: return the closest miss so the run reports a specific reason.
  return evaluated[0];
}

function evaluatePair(
  buyLeg: ChainRow,
  sellLeg: ChainRow,
  geometry: SpreadGeometry,
  config: VolGuardConfig,
  now: Date,
): SpreadCandidate {
  const { optionType, isDebit } = geometry;

  // A vertical is a debit when the leg bought is the nearer-the-money, more valuable one.
  // The strike ordering for a given option type therefore INVERTS between debit and credit:
  // call+debit buys the lower strike, call+credit buys the higher.
  const buyIsLowerStrike = optionType === "call" ? isDebit : !isDebit;
  const correctlyOrdered = buyIsLowerStrike
    ? buyLeg.strike < sellLeg.strike
    : buyLeg.strike > sellLeg.strike;

  const buyLiquidity = assessLiquidity(buyLeg, config, now);
  const sellLiquidity = assessLiquidity(sellLeg, config, now);
  const width = Math.abs(sellLeg.strike - buyLeg.strike);

  // Pay the ask on what we buy, receive the bid on what we sell — the price we could
  // actually cross at, never the mid. Worst case in both directions: for a credit spread
  // this is the least credit realistically obtainable.
  const netPrice =
    buyLeg.ask !== null && sellLeg.bid !== null
      ? Number((buyLeg.ask - sellLeg.bid).toFixed(2))
      : Number.NaN;
  const premium = Math.abs(netPrice);

  let rejection: string | null = null;
  if (!correctlyOrdered) rejection = "delta targets did not produce a correctly ordered vertical";
  else if (!Number.isFinite(netPrice)) rejection = "one leg is missing a tradable side of the quote";
  else if (isDebit && netPrice <= 0) rejection = `net debit ${netPrice} is not positive; this is not a debit spread`;
  else if (!isDebit && netPrice >= 0) rejection = `net credit ${(-netPrice).toFixed(2)} is not positive; this is not a credit spread`;
  else if (!(width > 0)) rejection = "both legs resolved to the same strike";
  else if (premium >= width) {
    rejection = isDebit
      ? `debit ${premium.toFixed(2)} >= width ${width.toFixed(2)}; no profit is possible`
      : `credit ${premium.toFixed(2)} >= width ${width.toFixed(2)}; the quote is not credible`;
  } else if (isDebit && premium / width > config.maxDebitToWidth) {
    rejection = `debit is ${((premium / width) * 100).toFixed(0)}% of width, above the ${(config.maxDebitToWidth * 100).toFixed(0)}% limit`;
  } else if (!isDebit && premium / width < config.minCreditToWidth) {
    rejection = `credit is ${((premium / width) * 100).toFixed(0)}% of width, below the ${(config.minCreditToWidth * 100).toFixed(0)}% minimum for the risk taken`;
  } else if (!buyLiquidity.passed) rejection = `buy leg: ${buyLiquidity.detail}`;
  else if (!sellLiquidity.passed) rejection = `sell leg: ${sellLiquidity.detail}`;

  return { buyLeg, sellLeg, buyLiquidity, sellLiquidity, netPrice, width, rejection };
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
  const geometry = structureGeometry(input.strategy, config);
  const isDebit = geometry.isDebit;
  const premium = Math.abs(candidate.netPrice);
  const width = candidate.width;

  // The one place the four structures differ arithmetically. Debit risks what it paid and
  // can win the rest of the width; credit risks the rest of the width and can win what it
  // collected. Both sum to the width, which is what "defined risk" means and what the
  // `max_loss_matches_width` gate independently verifies.
  const maxLossPerSpread = (isDebit ? premium : width - premium) * 100;
  const maxProfitPerSpread = (isDebit ? width - premium : premium) * 100;
  // Deliberately conservative for a credit: Alpaca nets the credit received against the
  // margin under the CBOE universal spread rule, so reserving the full width over-reserves.
  const marginPerSpread = (isDebit ? premium : width) * 100;

  const budget = Math.min(
    config.maxLossPerTrade,
    input.equity * config.maxRiskPercent,
    Math.max(0, input.dailyLossRemaining),
  );
  const qty = Math.max(0, Math.min(config.maxContracts, Math.floor(budget / maxLossPerSpread)));

  const maxLoss = maxLossPerSpread * qty;
  const maxProfit = maxProfitPerSpread * qty;

  // Breakeven is anchored on the leg that carries the position: the long leg of a debit
  // spread, the short leg of a credit spread.
  const breakeven = isDebit
    ? geometry.optionType === "call"
      ? candidate.buyLeg.strike + premium
      : candidate.buyLeg.strike - premium
    : geometry.optionType === "put"
      ? candidate.sellLeg.strike - premium
      : candidate.sellLeg.strike + premium;

  const exitPlan: ExitPlan = {
    takeProfitDebit: Number((isDebit ? premium + (width - premium) * config.takeProfitPercent : premium * (1 - config.takeProfitPercent)).toFixed(2)),
    stopLossDebit: Number((isDebit ? premium * (1 - config.stopLossPercent) : premium * (1 + config.stopLossPercent)).toFixed(2)),
    timeStopDte: config.timeStopDte,
    note: `Close at +${(config.takeProfitPercent * 100).toFixed(0)}% of max profit, at -${(config.stopLossPercent * 100).toFixed(0)}% of ${isDebit ? "premium" : "max loss"}, or at ${config.timeStopDte} DTE, whichever comes first.`,
  };

  return {
    clientOrderId: input.clientOrderId,
    symbol: input.symbol,
    strategy: input.strategy,
    qty,
    type: "limit",
    timeInForce: "day",
    limitPrice: premium,
    netPrice: candidate.netPrice,
    isCredit: !isDebit,
    marginRequired: marginPerSpread * qty,
    width,
    maxLoss,
    maxProfit,
    rewardRisk: maxLoss > 0 ? maxProfit / maxLoss : 0,
    breakeven: Number(breakeven.toFixed(2)),
    legs: [
      toLeg(candidate.buyLeg, "buy", candidate.buyLiquidity, input.openInterest.long),
      toLeg(candidate.sellLeg, "sell", candidate.sellLiquidity, input.openInterest.short),
    ],
    exitPlan,
  };
}

/**
 * Alpaca multi-leg payload.
 *
 * `limit_price` carries the premium for the whole spread. Alpaca does not document the sign
 * convention for a net credit — every example in their docs is a debit — so it is driven by
 * config rather than a constant, letting a live probe's answer be an environment change
 * rather than a code change the night before a demo.
 */
export function orderPayload(intent: OrderIntent, config: VolGuardConfig = getConfig()): Record<string, unknown> {
  const sign = intent.isCredit && config.creditLimitSign === "negative" ? -1 : 1;
  return {
    order_class: "mleg",
    qty: String(intent.qty),
    type: intent.type,
    time_in_force: intent.timeInForce,
    limit_price: (sign * Math.abs(intent.limitPrice)).toFixed(2),
    client_order_id: intent.clientOrderId,
    legs: intent.legs.map((leg) => ({
      symbol: leg.symbol,
      ratio_qty: String(leg.ratioQty),
      side: leg.side,
      position_intent: leg.positionIntent,
    })),
  };
}
