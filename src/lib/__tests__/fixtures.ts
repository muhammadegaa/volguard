import type { AlpacaAccount, AlpacaBar, OptionLeg, OrderIntent } from "../types";
import type { ChainRow } from "../volatility";

export const account: AlpacaAccount = {
  id: "121bfdea-b171-4d6e-a34b-000000000000",
  account_number: "PA3TESTACCOUNT",
  status: "ACTIVE",
  equity: "100000",
  cash: "100000",
  buying_power: "400000",
  options_approved_level: 3,
  options_trading_level: 3,
};

/** Deterministic bar series: `dailyMove` controls the realized volatility exactly. */
export function bars(count: number, start = 100, dailyMove = 0.01): AlpacaBar[] {
  const out: AlpacaBar[] = [];
  let close = start;
  for (let i = 0; i < count; i += 1) {
    const direction = i % 2 === 0 ? 1 : -1;
    close = close * (1 + direction * dailyMove);
    out.push({
      t: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      o: close,
      h: close * 1.005,
      l: close * 0.995,
      c: close,
      v: 1_000_000,
    });
  }
  return out;
}

export function chainRow(overrides: Partial<ChainRow> & { symbol: string }): ChainRow {
  return {
    strike: 100,
    expiry: "2026-09-18",
    type: "call",
    delta: 0.55,
    impliedVol: 0.2,
    bid: 3.0,
    ask: 3.05,
    mid: 3.025,
    bidSize: 50,
    askSize: 50,
    quoteTime: new Date().toISOString(),
    ...overrides,
  };
}

export function leg(overrides: Partial<OptionLeg> & { symbol: string }): OptionLeg {
  return {
    side: "buy",
    positionIntent: "buy_to_open",
    ratioQty: 1,
    strike: 100,
    expirationDate: "2026-09-18",
    type: "call",
    bid: 3.0,
    ask: 3.05,
    mid: 3.025,
    delta: 0.55,
    impliedVol: 0.2,
    quoteAgeSeconds: 5,
    bidSize: 50,
    askSize: 50,
    openInterest: 500,
    ...overrides,
  };
}

/** A clean, fully compliant 1-lot call debit spread: $1.00 debit, $5 wide. */
export function intent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    clientOrderId: "volguard-2026-08-19-spy-bull_call_debit_spread",
    symbol: "SPY",
    strategy: "bull_call_debit_spread",
    qty: 1,
    type: "limit",
    timeInForce: "day",
    limitPrice: 1.0,
    width: 5,
    maxLoss: 100,
    maxProfit: 400,
    rewardRisk: 4,
    breakeven: 101,
    legs: [
      leg({ symbol: "SPY260918C00100000", side: "buy", positionIntent: "buy_to_open", strike: 100 }),
      leg({ symbol: "SPY260918C00105000", side: "sell", positionIntent: "sell_to_open", strike: 105, delta: 0.27, bid: 1.0, ask: 1.05, mid: 1.025 }),
    ],
    exitPlan: { takeProfitDebit: 3, stopLossDebit: 0.5, timeStopDte: 7, note: "test plan" },
    ...overrides,
  };
}

export const riskBase = {
  account,
  openPositionCount: 0,
  openRiskDollars: 0,
  dailyLossUsed: 0,
  duplicateClientOrderId: false,
  marketOpen: true,
};

/** Config env for a compliant paper account. Callers are responsible for restoring env. */
export function paperEnv(extra: Record<string, string> = {}) {
  process.env.ALPACA_BASE_URL = "https://paper-api.alpaca.markets";
  process.env.ALPACA_PAPER_TRADE = "true";
  process.env.VOLGUARD_KILL_SWITCH = "false";
  process.env.VOLGUARD_MAX_LOSS_PER_TRADE = "250";
  process.env.VOLGUARD_MAX_RISK_PERCENT = "0.01";
  process.env.VOLGUARD_MAX_DAILY_LOSS = "500";
  process.env.VOLGUARD_MAX_OPEN_POSITIONS = "3";
  process.env.VOLGUARD_MAX_PORTFOLIO_RISK_PERCENT = "0.05";
  process.env.VOLGUARD_MAX_SPREAD_PERCENT = "0.08";
  process.env.VOLGUARD_MAX_QUOTE_AGE_SECONDS = "90";
  process.env.VOLGUARD_MIN_QUOTE_SIZE = "5";
  Object.assign(process.env, extra);
}
