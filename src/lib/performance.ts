import type { AgentRun, PerformanceSummary } from "./types";
import { parseOccSymbol } from "./volatility";

interface PortfolioHistory {
  timestamp?: number[];
  equity?: number[];
  profit_loss?: number[];
  base_value?: number;
}

function num(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const CONTRACT_MULTIPLIER = 100;

/**
 * Alpaca FILL activities report `side` as one of buy | sell | sell_short | buy_to_cover,
 * and carry no `position_intent`. Opening versus closing therefore cannot be read off a
 * single fill — it only emerges from the running position.
 */
function signedQty(side: string, qty: number): number {
  return side === "buy" || side === "buy_to_cover" ? qty : -qty;
}

interface Fill {
  symbol: string;
  side: string;
  price: number;
  qty: number;
  at: number;
}

function toFills(activities: Array<Record<string, unknown>>): Fill[] {
  return activities
    .flatMap((activity) => {
      const symbol = String(activity.symbol ?? "");
      const price = num(activity.price);
      const qty = num(activity.qty);
      // Options only: an OCC-21 symbol is the reliable discriminator.
      if (!parseOccSymbol(symbol) || price === null || qty === null) return [];
      return [{
        symbol,
        side: String(activity.side ?? ""),
        price,
        qty: Math.abs(qty),
        at: Date.parse(String(activity.transaction_time ?? "")) || 0,
      }];
    })
    .sort((a, b) => a.at - b.at);
}

/**
 * Realized P&L per contract, reconstructed by walking fills chronologically. A round trip
 * is closed when the running quantity for a contract returns to zero, and the cash
 * accumulated over that round trip is its realized result. This works for long and short
 * legs alike and does not depend on labels Alpaca does not send.
 */
function realizedRoundTrips(fills: Fill[]): { realized: number; wins: number; losses: number; count: number } {
  const open = new Map<string, { qty: number; cash: number }>();
  let realized = 0;
  let wins = 0;
  let losses = 0;
  let count = 0;

  for (const fill of fills) {
    const state = open.get(fill.symbol) ?? { qty: 0, cash: 0 };
    const delta = signedQty(fill.side, fill.qty);
    state.qty += delta;
    // Buying spends cash, selling receives it.
    state.cash -= delta * fill.price * CONTRACT_MULTIPLIER;

    if (state.qty === 0) {
      realized += state.cash;
      count += 1;
      if (state.cash >= 0) wins += 1;
      else losses += 1;
      open.delete(fill.symbol);
    } else {
      open.set(fill.symbol, state);
    }
  }

  return { realized, wins, losses, count };
}

/**
 * Slippage between the net debit VolGuard intended and the net debit Alpaca actually filled.
 * Multi-leg fills are reported per leg with their own order ids, so they are matched back to
 * the run by leg symbol rather than by the parent order id.
 */
function computeSlippage(fills: Fill[], runs: AgentRun[]): number | null {
  let total = 0;
  let matched = 0;

  for (const run of runs) {
    const intent = run.orderIntent;
    if (!run.alpacaOrderId || !intent) continue;
    const legSymbols = new Set(intent.legs.map((leg) => leg.symbol));
    const startedAt = Date.parse(run.startedAt) || 0;
    const relevant = fills.filter((fill) => legSymbols.has(fill.symbol) && fill.at >= startedAt);
    if (relevant.length < legSymbols.size) continue;

    // Net debit paid: long legs cost, short legs credit.
    const netDebit = relevant.reduce(
      (sum, fill) => sum + (signedQty(fill.side, fill.qty) > 0 ? fill.price : -fill.price) * fill.qty,
      0,
    ) / Math.max(1, intent.qty);

    total += Math.abs(netDebit - intent.limitPrice) * CONTRACT_MULTIPLIER * intent.qty;
    matched += 1;
  }

  return matched > 0 ? Number(total.toFixed(2)) : null;
}

/**
 * Loss consumed today, in dollars, as a positive number.
 *
 * Derived from Alpaca's own `equity` versus `last_equity` (equity at the previous close)
 * rather than from a locally persisted counter, so it cannot drift, cannot be stale, and
 * survives a restart. Includes both realized and mark-to-market losses, which is what a
 * daily risk budget should actually constrain. Returns 0 on a flat or profitable day.
 */
export function dailyLossUsed(account: { equity?: string; last_equity?: string }): number {
  const equity = num(account.equity);
  const lastEquity = num(account.last_equity);
  if (equity === null || lastEquity === null) return 0;
  return Math.max(0, lastEquity - equity);
}

/**
 * Everything here is derived from Alpaca responses. When the account has no history the
 * fields stay null and `source` says so, rather than showing a zero that reads as a result.
 */
export function summarizePerformance(input: {
  history: PortfolioHistory | null;
  fills: Array<Record<string, unknown>>;
  runs: AgentRun[];
}): PerformanceSummary {
  const equitySeries = (input.history?.equity ?? []).filter((value) => Number.isFinite(value) && value > 0);
  const baseValue = num(input.history?.base_value);
  const equity = equitySeries.length > 0 ? equitySeries[equitySeries.length - 1] : null;

  let maxDrawdownPct: number | null = null;
  if (equitySeries.length > 1) {
    let peak = equitySeries[0];
    let worst = 0;
    for (const value of equitySeries) {
      if (value > peak) peak = value;
      if (peak > 0) worst = Math.min(worst, value / peak - 1);
    }
    maxDrawdownPct = worst;
  }

  const fills = toFills(input.fills);
  const { realized, wins, losses, count } = realizedRoundTrips(fills);
  const totalFees = input.fills.reduce((sum, activity) => sum + Math.abs(num(activity.fee) ?? 0), 0);
  const totalPl = equity !== null && baseValue !== null ? equity - baseValue : null;

  return {
    equity,
    baseValue,
    totalPl,
    totalPlPct: totalPl !== null && baseValue ? totalPl / baseValue : null,
    maxDrawdownPct,
    closedTrades: count,
    wins,
    losses,
    realizedPl: count > 0 ? Number(realized.toFixed(2)) : null,
    totalFees: fills.length > 0 ? totalFees : null,
    slippage: computeSlippage(fills, input.runs),
    source: equitySeries.length > 0 ? "alpaca_portfolio_history" : "unavailable",
    note: equitySeries.length === 0
      ? "Alpaca returned no portfolio history for this account yet."
      : count > 0
        ? "Equity curve and drawdown from Alpaca portfolio history; realized P&L reconstructed from Alpaca fill activities."
        : "Equity curve and drawdown from Alpaca portfolio history. No option round trip has closed yet, so realized P&L is not shown.",
  };
}
