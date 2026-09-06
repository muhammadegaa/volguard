import { buildOrderIntent, selectVerticalSpread } from "./chain";
import { evaluateRisk } from "./risk";
import type { VolGuardConfig } from "./config";
import type { StrategyVerdict } from "./strategy";
import type {
  AlpacaAccount,
  Decision,
  MarketObservation,
  StrategyKind,
  TradeThesis,
} from "./types";
import type { ChainRow } from "./volatility";

export interface AllocationCandidate {
  observation: MarketObservation;
  verdict: StrategyVerdict;
  rows: ChainRow[];
  thesis: TradeThesis;
}

export interface AllocationInput {
  /** Ranked best-first. The allocator spends the budget in this order. */
  candidates: AllocationCandidate[];
  account: AlpacaAccount;
  config: VolGuardConfig;
  marketOpen: boolean | null;
  /** Portfolio state before this run opens anything. */
  openPositionCount: number;
  openRiskDollars: number;
  dailyLossUsed: number;
  /** Client order ids Alpaca already holds, so a replayed run cannot double-submit. */
  duplicateClientOrderIds?: Set<string>;
  today: string;
  now?: Date;
}

/**
 * Deterministic within a symbol, strategy and day. Two runs on the same day propose the
 * same id for the same underlying, so Alpaca's duplicate rejection is what enforces one
 * position per underlying per day.
 */
export function clientOrderIdFor(
  today: string,
  symbol: string,
  strategy: Exclude<StrategyKind, "no_trade">,
): string {
  return `volguard-${today}-${symbol}-${strategy}`.toLowerCase();
}

/**
 * Spend one run's risk budget across the ranked candidates.
 *
 * The reason this is a sequential loop rather than a filter is the three accumulators. Every
 * money limit in the risk engine is a *per-trade* comparison: max loss against the per-trade
 * cap, against the daily budget, against the portfolio cap. Evaluate N candidates against the
 * same starting state and all N pass individually while the portfolio breaches every one of
 * those limits together. Each approval here therefore commits its maximum loss before the
 * next candidate is measured, so the budget a candidate sees is what the earlier ones left.
 *
 * Pure: no network, no clock beyond `now`. Submission is the caller's job.
 */
export function planAllocation(input: AllocationInput): Decision[] {
  const { config, account } = input;
  const duplicates = input.duplicateClientOrderIds ?? new Set<string>();
  const now = input.now ?? new Date();

  let openPositionCount = input.openPositionCount;
  let openRiskDollars = input.openRiskDollars;
  let dailyLossUsed = input.dailyLossUsed;

  const decisions: Decision[] = [];

  for (const candidate of input.candidates) {
    const { observation, thesis } = candidate;
    const base = {
      symbol: observation.symbol,
      observation,
      thesis,
      risk: null,
      orderIntent: null,
      alpacaOrderId: null,
    };

    // The model is allowed to veto. It is not allowed to create a trade.
    if (thesis.strategy === "no_trade") {
      decisions.push({
        ...base,
        status: "NO_TRADE",
        message: `Thesis review downgraded ${observation.symbol} to no trade: ${thesis.catalyst}`,
      });
      continue;
    }

    const spread = selectVerticalSpread({ rows: candidate.rows, strategy: thesis.strategy, config, now });
    if (!spread || spread.rejection) {
      decisions.push({
        ...base,
        status: "DATA_UNAVAILABLE",
        message: spread?.rejection ?? `Alpaca did not return two ${observation.symbol} contracts that form a tradable spread.`,
      });
      continue;
    }

    const clientOrderId = clientOrderIdFor(input.today, observation.symbol, thesis.strategy);
    const intent = buildOrderIntent({
      symbol: observation.symbol,
      strategy: thesis.strategy,
      candidate: spread,
      equity: Number(account.equity),
      // What earlier approvals in this same run left, not what the account started with.
      dailyLossRemaining: config.maxDailyLoss - dailyLossUsed,
      openInterest: { long: null, short: null },
      config,
      clientOrderId,
    });

    if (intent.qty < 1) {
      decisions.push({
        ...base,
        orderIntent: intent,
        status: "NO_TRADE",
        // Max loss, not premium: for a credit spread the risk is the width less the credit,
        // which is the number the budget is actually measured against.
        message: `A single ${observation.symbol} spread risks $${(intent.maxLoss || Math.abs(spread.netPrice) * 100).toFixed(2)}, which exceeds the remaining risk budget. No position was opened.`,
      });
      continue;
    }

    const risk = evaluateRisk({
      account,
      config,
      openPositionCount,
      openRiskDollars,
      dailyLossUsed,
      intent,
      duplicateClientOrderId: duplicates.has(clientOrderId),
      marketOpen: input.marketOpen,
      now,
    });

    if (!risk.approved) {
      decisions.push({
        ...base,
        risk,
        orderIntent: intent,
        status: "TRADE_REJECTED",
        message: `${observation.symbol}: ${risk.reasons.join("; ")}`,
      });
      continue;
    }

    // Commit before the next candidate is measured. This is the whole point of the loop.
    openPositionCount += 1;
    openRiskDollars += intent.maxLoss;
    dailyLossUsed += intent.maxLoss;

    decisions.push({
      ...base,
      risk,
      orderIntent: intent,
      status: "TRADE_APPROVED",
      message: `${intent.qty}-lot ${thesis.strategy.replace(/_/g, " ")} on ${observation.symbol} at $${intent.limitPrice.toFixed(2)}, risking $${intent.maxLoss.toFixed(2)}.`,
    });
  }

  return decisions;
}
