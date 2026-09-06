import { z } from "zod";

export type AgentMode = "dry-run" | "paper";
export type RunTrigger = "manual" | "scheduled";

export type DecisionStatus =
  | "TRADE_APPROVED"
  | "TRADE_REJECTED"
  | "NO_TRADE"
  | "CONFIGURATION_REQUIRED"
  | "DATA_UNAVAILABLE"
  | "ERROR";

export type AuditEventType =
  | "AGENT_STARTED"
  | "OBSERVATION"
  | "THESIS_GENERATED"
  | "RISK_REJECTED"
  | "ORDER_SUBMITTED"
  | "ORDER_SKIPPED"
  | "EXIT_SUBMITTED"
  | "EXIT_SKIPPED"
  | "POSITION_REVIEW"
  | "MCP_CALL"
  | "SCHEDULE_SKIPPED"
  | "AGENT_FINISHED"
  | "ERROR";

/**
 * Defined-risk verticals only. Every structure here has a maximum loss that is arithmetic
 * rather than a stop: the premium paid for a debit spread, the strike width less the credit
 * received for a credit spread. Nothing naked, nothing with unbounded risk, ever.
 */
export type StrategyKind =
  | "bull_call_debit_spread"
  | "bear_put_debit_spread"
  /** Sell the higher-strike put, buy a lower-strike wing. Bullish, collects premium. */
  | "bull_put_credit_spread"
  /** Sell the lower-strike call, buy a higher-strike wing. Bearish, collects premium. */
  | "bear_call_credit_spread"
  | "no_trade";

export const TradeThesisSchema = z.object({
  symbol: z.string().min(1).max(10),
  direction: z.enum(["bullish", "bearish", "neutral"]),
  thesis: z.string().min(1).max(1200),
  catalyst: z.string().min(1).max(500),
  invalidation: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
  // Omitting a strategy here makes the model's echo fail validation and silently degrade
  // to the rules fallback on every run of that type.
  strategy: z.enum([
    "bull_call_debit_spread",
    "bear_put_debit_spread",
    "bull_put_credit_spread",
    "bear_call_credit_spread",
    "no_trade",
  ]),
  source: z.enum(["anthropic", "rules_fallback"]),
});

export type TradeThesis = z.infer<typeof TradeThesisSchema>;

/**
 * Volatility state for one underlying. Every field carries its own provenance so the
 * dashboard can show where a number came from and never implies data we do not have.
 */
export interface VolatilityState {
  /** Annualized close-to-close realized volatility over N trading days. */
  realizedVol20: number | null;
  realizedVol10: number | null;
  realizedVol5: number | null;
  /** Jump-robust bipower variation over 20 days; the baseline the VRP is priced against. */
  bipowerVol20: number | null;
  /** Share of 20-day realized variance explained by jumps, 0..1. */
  jumpFraction: number | null;
  /** Parkinson high-low range estimator over 20 days; less noisy than close-to-close. */
  parkinsonVol20: number | null;
  /** Where realizedVol20 sits within its own trailing 1y range, 0..1. */
  realizedVolRank: number | null;
  /** ATM implied volatility for the target expiry, interpolated at |delta| ~= 0.50. */
  atmImpliedVol: number | null;
  /** ATM IV of the nearest listed expiry, used for the term-structure slope. */
  frontImpliedVol: number | null;
  /** ATM IV of a later expiry, used for the term-structure slope. */
  backImpliedVol: number | null;
  /** backImpliedVol - frontImpliedVol. Negative = backwardation = stress/event priced in. */
  termSlope: number | null;
  /**
   * Forecast realized volatility over the traded expiry's own horizon (HAR-RV), and how it
   * was produced. This is what implied volatility is priced against.
   */
  forecastVol: number | null;
  forecastSource: "har" | "trailing" | null;
  forecastHorizonDays: number | null;
  /** In-sample R² of the HAR fit; null when the forecast degraded to the trailing estimate. */
  forecastR2: number | null;
  /** atmImpliedVol - forecastVol. Positive = options rich, negative = options cheap. */
  varianceRiskPremium: number | null;
  /**
   * atmImpliedVol - bipowerVol20, the pre-forecast definition. Kept only so the change of
   * basis is auditable on screen and in the ledger; nothing decides on it.
   */
  trailingVarianceRiskPremium: number | null;
  /** 25-delta put IV minus 25-delta call IV. Positive = downside fear bid. */
  skew25: number | null;
  /**
   * IV rank requires an IV history Alpaca does not serve. VolGuard accumulates its own
   * daily ATM IV observations; this stays null until `ivSamples` reaches the minimum.
   */
  impliedVolRank: number | null;
  ivSamples: number;
}

export type EventSeverity = "none" | "low" | "elevated" | "high";

export interface EventRisk {
  severity: EventSeverity;
  score: number;
  /** Human-readable drivers, each traceable to a headline or corporate action. */
  drivers: string[];
  newsCount: number;
  /** Headlines matched against the event taxonomy, most recent first. */
  matchedHeadlines: Array<{ headline: string; source: string; createdAt: string; category: string }>;
  corporateActions: string[];
}

export interface MarketObservation {
  symbol: string;
  price: number;
  previousClose: number | null;
  dailyReturn: number | null;
  /** Close vs 20-day simple moving average; the directional filter. */
  trend: number | null;
  volatility: VolatilityState;
  event: EventRisk;
  /** Expiry the chain analysis targeted, and how many calendar days out it is. */
  targetExpiry: string | null;
  daysToExpiry: number | null;
  chainContracts: number;
  dataAsOf: string;
  source: "alpaca";
  /** Fields Alpaca did not return for this symbol, surfaced instead of silently defaulted. */
  unavailable: string[];
}

export interface OptionLeg {
  symbol: string;
  side: "buy" | "sell";
  positionIntent: "buy_to_open" | "sell_to_open" | "buy_to_close" | "sell_to_close";
  ratioQty: number;
  strike: number;
  expirationDate: string;
  type: "call" | "put";
  bid: number | null;
  ask: number | null;
  mid: number | null;
  delta: number | null;
  impliedVol: number | null;
  /** Age of the quote in seconds at the moment the candidate was built. */
  quoteAgeSeconds: number | null;
  bidSize: number | null;
  askSize: number | null;
  openInterest: number | null;
}

export interface OrderIntent {
  clientOrderId: string;
  symbol: string;
  strategy: Exclude<StrategyKind, "no_trade">;
  qty: number;
  type: "limit";
  timeInForce: "day";
  /** Absolute premium per spread — the magnitude sent as `limit_price`. */
  limitPrice: number;
  /** Signed net price per spread: > 0 we pay (debit), < 0 we receive (credit). */
  netPrice: number;
  /** True when the structure collects premium rather than paying it. */
  isCredit: boolean;
  /**
   * Buying power to reserve. For a debit that is the premium; for a credit it is the full
   * strike width, which is deliberately more conservative than Alpaca requires — they net
   * the credit received against the margin under the CBOE universal spread rule.
   */
  marginRequired: number;
  /** Strike distance between the legs, in dollars. */
  width: number;
  maxLoss: number;
  maxProfit: number;
  /** maxProfit / maxLoss. */
  rewardRisk: number;
  breakeven: number;
  legs: OptionLeg[];
  exitPlan: ExitPlan;
}

export interface ExitPlan {
  takeProfitDebit: number;
  stopLossDebit: number;
  timeStopDte: number;
  note: string;
}

export interface RiskCheck {
  name: string;
  passed: boolean;
  detail: string;
  /** A blocking check fails the order. Advisory checks are recorded but do not block. */
  blocking: boolean;
}

export interface RiskDecision {
  approved: boolean;
  reasons: string[];
  checks: RiskCheck[];
}

export interface PositionReview {
  symbol: string;
  underlying: string;
  qty: number;
  side: string;
  /** Absolute, for display. `costBasisSigned` carries the direction. */
  costBasis: number;
  /** Signed: positive for a long leg, negative for a short one. */
  costBasisSigned: number;
  strike: number | null;
  expiry: string | null;
  type: "call" | "put" | null;
  marketValue: number;
  unrealizedPl: number;
  unrealizedPlPct: number;
  daysToExpiry: number | null;
  action: "hold" | "close";
  reason: string;
}

/**
 * One symbol's outcome within a run. A run considers the whole ranked universe, so a run
 * has as many of these as it had candidates — not one.
 */
export interface Decision {
  symbol: string;
  status: DecisionStatus;
  observation: MarketObservation;
  thesis: TradeThesis;
  risk: RiskDecision | null;
  orderIntent: OrderIntent | null;
  alpacaOrderId: string | null;
  message: string;
}

export interface AgentRun {
  id: string;
  startedAt: string;
  finishedAt: string;
  mode: AgentMode;
  trigger: RunTrigger;
  status: DecisionStatus;
  symbol: string | null;
  /** Every symbol the scan looked at, with the reason each was or was not chosen. */
  scanned: Array<{
    symbol: string;
    verdict: string;
    varianceRiskPremium: number | null;
    /**
     * The full analysis for this symbol, including the ones not chosen. Without it the
     * dashboard can only ever explain the single symbol that won, which makes the scan
     * list unclickable for every other row.
     */
    observation: MarketObservation | null;
  }>;
  /**
   * Every candidate the allocator considered, in the order it spent the budget on them.
   * The singular `observation` / `thesis` / `risk` / `orderIntent` / `alpacaOrderId` fields
   * above are a view of the primary decision — the one the run's status came from.
   */
  decisions: Decision[];
  observation: MarketObservation | null;
  thesis: TradeThesis | null;
  risk: RiskDecision | null;
  orderIntent: OrderIntent | null;
  alpacaOrderId: string | null;
  positionReviews: PositionReview[];
  exitOrderIds: string[];
  durationMs: number;
  message: string;
}

export interface AuditEvent {
  id: string;
  runId: string;
  createdAt: string;
  type: AuditEventType;
  message: string;
  data?: Record<string, unknown>;
}

export interface PerformanceSummary {
  /** Sourced from Alpaca portfolio history; null when the account has no history yet. */
  equity: number | null;
  baseValue: number | null;
  totalPl: number | null;
  totalPlPct: number | null;
  maxDrawdownPct: number | null;
  /** Realized option P&L reconstructed from Alpaca fill activities. */
  closedTrades: number;
  wins: number;
  losses: number;
  realizedPl: number | null;
  totalFees: number | null;
  /** Sum of |fill price - intended limit| * 100 * qty across recorded submissions. */
  slippage: number | null;
  source: "alpaca_portfolio_history" | "unavailable";
  note: string;
}

export interface McpEvidence {
  configured: boolean;
  available: boolean;
  command: string;
  toolCount: number;
  /** Actual read-only tool calls made against the running server, with results. */
  calls: Array<{ tool: string; ok: boolean; summary: string }>;
  checkedAt: string | null;
  message: string;
}

export interface DashboardSnapshot {
  configured: boolean;
  paperOnly: boolean;
  killSwitch: boolean;
  schedule: { enabled: boolean; intervalMinutes: number; lastRunAt: string | null; nextEligibleAt: string | null };
  /** Where the ledger is kept and whether it survives a restart. Surfaced, never implied. */
  storage: { durable: boolean; ephemeral: boolean; lastError: string | null };
  /**
   * Settings that failed validation. Non-empty means the agent will refuse every run, so it
   * is shown rather than left to be discovered by a run that does nothing.
   */
  configIssues: Array<{ variable: string; detail: string }>;
  account: {
    id: string | null;
    accountNumber: string | null;
    status: string | null;
    equity: number | null;
    cash: number | null;
    buyingPower: number | null;
    optionsLevel: number | null;
    idVerified: boolean;
  };
  clock: { isOpen: boolean | null; nextOpen: string | null; nextClose: string | null };
  positions: PositionReview[];
  /** Distinct spreads held, not legs — this is what `maxOpenPositions` limits. */
  openPositionCount: number;
  performance: PerformanceSummary;
  dailyLossUsed: number;
  recentRuns: AgentRun[];
  auditEvents: AuditEvent[];
  mcp: McpEvidence;
  limits: {
    maxLossPerTrade: number;
    maxRiskPercent: number;
    maxDailyLoss: number;
    maxOpenPositions: number;
    maxSpreadPercent: number;
    maxQuoteAgeSeconds: number;
  };
  message: string;
}

export interface AlpacaAccount {
  id: string;
  account_number?: string;
  status: string;
  equity: string;
  cash: string;
  buying_power: string;
  options_approved_level?: number;
  options_trading_level?: number;
  last_equity?: string;
}

export interface AlpacaClock {
  is_open: boolean;
  next_open: string;
  next_close: string;
  timestamp?: string;
}

export interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface AlpacaOptionContract {
  symbol: string;
  status: string;
  tradable: boolean;
  expiration_date: string;
  underlying_symbol: string;
  type: "call" | "put";
  strike_price: string;
  open_interest?: string | null;
  close_price?: string | null;
}

export interface AlpacaQuote {
  bp?: number;
  bs?: number;
  ap?: number;
  as?: number;
  t?: string;
}

export interface AlpacaGreeks {
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
}

export interface AlpacaOptionSnapshot {
  latestQuote?: AlpacaQuote;
  latestTrade?: { p?: number; t?: string };
  dailyBar?: AlpacaBar;
  greeks?: AlpacaGreeks;
  impliedVolatility?: number;
}

export interface AlpacaNewsItem {
  headline: string;
  source: string;
  created_at: string;
  symbols: string[];
  summary?: string;
}
