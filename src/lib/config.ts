import type { AgentMode } from "./types";

export interface ConfigIssue {
  variable: string;
  detail: string;
}

interface NumberSpec {
  env: string;
  fallback: number;
  min: number;
  max: number;
  integer?: boolean;
}

/**
 * Every numeric setting with the range that makes it meaningful.
 *
 * The ranges are the point. Reading these used to mean "parse the variable, and on anything
 * unparseable use the default", which turns a typo into a silently different limit — a
 * thousand-dollar cap written `1,000` became the $250 default with nothing said. Nor did
 * anything reject a negative limit, a delta above 1, or a debit-to-width above 1, each of
 * which sizes a position against arithmetic that no longer means what it says.
 *
 * A value that parses but is out of range is kept rather than replaced. Substituting a
 * default is the behaviour being fixed here; the run is refused instead, naming the variable.
 */
const NUMBERS = {
  // Risk limits
  maxLossPerTrade: { env: "VOLGUARD_MAX_LOSS_PER_TRADE", fallback: 250, min: 1, max: 1_000_000 },
  maxRiskPercent: { env: "VOLGUARD_MAX_RISK_PERCENT", fallback: 0.01, min: 0, max: 1 },
  maxDailyLoss: { env: "VOLGUARD_MAX_DAILY_LOSS", fallback: 500, min: 1, max: 10_000_000 },
  maxOpenPositions: { env: "VOLGUARD_MAX_OPEN_POSITIONS", fallback: 5, min: 1, max: 100, integer: true },
  maxPortfolioRiskPercent: { env: "VOLGUARD_MAX_PORTFOLIO_RISK_PERCENT", fallback: 0.05, min: 0, max: 1 },
  maxContracts: { env: "VOLGUARD_MAX_CONTRACTS", fallback: 5, min: 1, max: 1000, integer: true },

  // Liquidity and quote quality
  maxSpreadPercent: { env: "VOLGUARD_MAX_SPREAD_PERCENT", fallback: 0.08, min: 0, max: 1 },
  maxQuoteAgeSeconds: { env: "VOLGUARD_MAX_QUOTE_AGE_SECONDS", fallback: 90, min: 1, max: 86_400 },
  minQuoteSize: { env: "VOLGUARD_MIN_QUOTE_SIZE", fallback: 5, min: 0, max: 10_000, integer: true },

  // Strategy shape
  minDte: { env: "VOLGUARD_MIN_DTE", fallback: 7, min: 0, max: 365, integer: true },
  maxDte: { env: "VOLGUARD_MAX_DTE", fallback: 60, min: 1, max: 730, integer: true },
  /** Preferred holding horizon. The chain expiry nearest this is the one traded. */
  targetDte: { env: "VOLGUARD_TARGET_DTE", fallback: 30, min: 1, max: 730, integer: true },
  longLegDelta: { env: "VOLGUARD_LONG_LEG_DELTA", fallback: 0.55, min: 0.01, max: 0.99 },
  shortLegDelta: { env: "VOLGUARD_SHORT_LEG_DELTA", fallback: 0.27, min: 0.01, max: 0.99 },
  /** Reject a spread whose debit exceeds this fraction of the strike width. */
  maxDebitToWidth: { env: "VOLGUARD_MAX_DEBIT_TO_WIDTH", fallback: 0.7, min: 0.01, max: 1 },

  /** Delta targets for a credit vertical: sell near the money, buy the far wing. */
  creditShortLegDelta: { env: "VOLGUARD_CREDIT_SHORT_LEG_DELTA", fallback: 0.25, min: 0.01, max: 0.99 },
  creditLongLegDelta: { env: "VOLGUARD_CREDIT_LONG_LEG_DELTA", fallback: 0.10, min: 0.01, max: 0.99 },
  /** Reject a credit spread paying less than this fraction of the width it risks. */
  minCreditToWidth: { env: "VOLGUARD_MIN_CREDIT_TO_WIDTH", fallback: 0.25, min: 0.01, max: 0.99 },
  /**
   * Floor for selling premium. Between `maxEntryVrp` and this is a deliberate dead band:
   * the premium carries a couple of vol points of measurement error, and an agent that
   * flips between buying and selling on noise reads as incoherent.
   */
  minSellVrp: { env: "VOLGUARD_MIN_SELL_VRP", fallback: 0.03, min: -1, max: 1 },
  /**
   * Selling into a known catalyst is categorically more dangerous than buying it — the
   * rich implied vol being sold IS the compensation for that catalyst. Every sell-side
   * gate is therefore stricter than its buy-side counterpart.
   */
  maxSellEventScore: { env: "VOLGUARD_MAX_SELL_EVENT_SCORE", fallback: 25, min: 0, max: 100 },
  maxSellJumpFraction: { env: "VOLGUARD_MAX_SELL_JUMP_FRACTION", fallback: 0.25, min: 0, max: 1 },
  /** Any backwardation at all blocks a sale: the front expiry is the one being sold. */
  sellMinTermSlope: { env: "VOLGUARD_SELL_MIN_TERM_SLOPE", fallback: 0.0, min: -1, max: 1 },
  /**
   * Entry gate. VolGuard buys optionality only when implied vol is cheap relative to what
   * the underlying is expected to deliver: VRP = ATM IV - forecast vol must be below this.
   *
   * NOTE: this threshold was tuned against the old trailing baseline and has deliberately
   * NOT been re-tuned for the forecast. Changing the baseline and the threshold together
   * would make the before/after uninterpretable, and tuning it until more trades appear
   * would be fitting to the demo.
   */
  maxEntryVrp: { env: "VOLGUARD_MAX_ENTRY_VRP", fallback: 0.0, min: -1, max: 1 },
  /** Abstain entirely when event risk scores at or above this level. */
  maxEventScore: { env: "VOLGUARD_MAX_EVENT_SCORE", fallback: 60, min: 0, max: 100 },
  /** Abstain when this share of realized variance came from jumps rather than drift. */
  maxJumpFraction: { env: "VOLGUARD_MAX_JUMP_FRACTION", fallback: 0.35, min: 0, max: 1 },
  minIvSamplesForRank: { env: "VOLGUARD_MIN_IV_SAMPLES", fallback: 20, min: 1, max: 1000, integer: true },
  /**
   * Daily bars fetched per symbol. The volatility forecast needs roughly two years:
   * walk-forward measured it as WORSE than the trailing estimator it replaces at 260
   * bars, and better at 520. Beyond ~520 there is no further gain.
   */
  barSessions: { env: "VOLGUARD_BAR_SESSIONS", fallback: 520, min: 21, max: 5000, integer: true },

  // Exits
  takeProfitPercent: { env: "VOLGUARD_TAKE_PROFIT_PERCENT", fallback: 0.5, min: 0.01, max: 1 },
  stopLossPercent: { env: "VOLGUARD_STOP_LOSS_PERCENT", fallback: 0.5, min: 0.01, max: 1 },
  timeStopDte: { env: "VOLGUARD_TIME_STOP_DTE", fallback: 7, min: 0, max: 365, integer: true },

  // Autonomy
  scheduleIntervalMinutes: { env: "VOLGUARD_SCHEDULE_INTERVAL_MINUTES", fallback: 15, min: 1, max: 1440 },
  /**
   * Must stay under the route's maxDuration (60s) so the agent times out before the platform
   * does, producing a recorded ERROR run rather than an opaque 504.
   */
  runTimeoutMs: { env: "VOLGUARD_RUN_TIMEOUT_MS", fallback: 45_000, min: 1000, max: 59_000 },

  // Request throttling, per client per minute. Bounds Alpaca API usage and accidental
  // hammering; it is not an authorization control, so it can be tuned per deployment.
  runRateLimitPerMinute: { env: "VOLGUARD_RUN_RATE_LIMIT", fallback: 30, min: 1, max: 10_000, integer: true },
  mcpRateLimitPerMinute: { env: "VOLGUARD_MCP_RATE_LIMIT", fallback: 10, min: 1, max: 10_000, integer: true },
} satisfies Record<string, NumberSpec>;

type NumberKey = keyof typeof NUMBERS;

function readNumbers(issues: ConfigIssue[]): Record<NumberKey, number> {
  const values = {} as Record<NumberKey, number>;
  for (const [key, spec] of Object.entries(NUMBERS) as Array<[NumberKey, NumberSpec]>) {
    const raw = process.env[spec.env];
    if (raw === undefined || raw.trim() === "") {
      values[key] = spec.fallback;
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      issues.push({ variable: spec.env, detail: `"${raw}" is not a number` });
      values[key] = spec.fallback;
      continue;
    }
    if (value < spec.min || value > spec.max) {
      issues.push({ variable: spec.env, detail: `${value} is outside the allowed range ${spec.min} to ${spec.max}` });
    } else if (spec.integer && !Number.isInteger(value)) {
      issues.push({ variable: spec.env, detail: `${value} must be a whole number` });
    }
    values[key] = value;
  }
  return values;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw === "true";
}

/**
 * Relationships between settings that each look reasonable alone. A target expiry outside
 * the window the chain is fetched over, or a short leg further into the money than the long
 * one, builds a structure whose maximum loss is not the number the risk engine checks.
 */
function crossChecks(config: Record<NumberKey, number> & { symbols: string[] }, issues: ConfigIssue[]) {
  if (config.minDte > config.maxDte) {
    issues.push({ variable: "VOLGUARD_MIN_DTE", detail: `${config.minDte} is above VOLGUARD_MAX_DTE ${config.maxDte}, so no expiry can qualify` });
  }
  if (config.targetDte < config.minDte || config.targetDte > config.maxDte) {
    issues.push({ variable: "VOLGUARD_TARGET_DTE", detail: `${config.targetDte} is outside the fetched window ${config.minDte} to ${config.maxDte}` });
  }
  if (config.shortLegDelta >= config.longLegDelta) {
    issues.push({ variable: "VOLGUARD_SHORT_LEG_DELTA", detail: `${config.shortLegDelta} is not below VOLGUARD_LONG_LEG_DELTA ${config.longLegDelta}; a debit spread buys the nearer-the-money leg` });
  }
  if (config.creditLongLegDelta >= config.creditShortLegDelta) {
    issues.push({ variable: "VOLGUARD_CREDIT_LONG_LEG_DELTA", detail: `${config.creditLongLegDelta} is not below VOLGUARD_CREDIT_SHORT_LEG_DELTA ${config.creditShortLegDelta}; a credit spread sells the nearer-the-money leg` });
  }
  if (config.maxEntryVrp >= config.minSellVrp) {
    issues.push({ variable: "VOLGUARD_MAX_ENTRY_VRP", detail: `${config.maxEntryVrp} is not below VOLGUARD_MIN_SELL_VRP ${config.minSellVrp}, so one premium would qualify to both buy and sell` });
  }
  if (config.symbols.length === 0) {
    issues.push({ variable: "VOLGUARD_SYMBOLS", detail: "resolved to an empty watchlist, so no symbol can be scanned" });
  }
}

export function getConfig() {
  const issues: ConfigIssue[] = [];
  const numbers = readNumbers(issues);
  const baseUrl = process.env.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets";
  const paperOnly = baseUrl.includes("paper-api.alpaca.markets") && process.env.ALPACA_PAPER_TRADE !== "false";

  const symbols = (process.env.VOLGUARD_SYMBOLS ?? "SPY,QQQ,IWM,DIA,TLT,GLD,SLV,NVDA,TSLA,PLTR,AMZN,MU,NFLX,TSM")
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);

  crossChecks({ ...numbers, symbols }, issues);

  return {
    apiKey: process.env.ALPACA_API_KEY ?? "",
    secretKey: process.env.ALPACA_SECRET_KEY ?? "",
    accountId: process.env.ALPACA_ACCOUNT_ID ?? "",
    baseUrl,
    dataUrl: process.env.ALPACA_DATA_URL ?? "https://data.alpaca.markets",
    /** Free indicative feed. `opra` requires a signed OPRA agreement this account does not have. */
    optionFeed: process.env.ALPACA_OPTION_FEED ?? "indicative",
    stockFeed: process.env.ALPACA_STOCK_FEED ?? "iex",
    paperOnly,
    killSwitch: boolEnv("VOLGUARD_KILL_SWITCH", false),

    ...numbers,

    /**
     * Master switch for credit spreads, enforced in BOTH the strategy layer and the risk
     * engine. A flag honoured in only one place is bypassable by any path that builds an
     * intent directly, and the cost of doubling it is ten lines.
     */
    sellPremiumEnabled: boolEnv("VOLGUARD_SELL_PREMIUM_ENABLED", false),
    /**
     * Sign convention Alpaca expects for a net-credit multi-leg limit price. UNVERIFIED —
     * the docs contain no credit example. Driven by config so the answer from a live probe
     * is an environment change rather than a redeploy. Sending the wrong sign positive
     * would pay to open a position whose max profit is that same amount.
     */
    creditLimitSign: (process.env.VOLGUARD_CREDIT_LIMIT_SIGN === "positive" ? "positive" : "negative") as "positive" | "negative",

    scheduleEnabled: boolEnv("VOLGUARD_SCHEDULE_ENABLED", false),
    scheduleMode: (process.env.VOLGUARD_SCHEDULE_MODE === "paper" ? "paper" : "dry-run") as AgentMode,

    /**
     * Screened for options liquidity rather than name recognition: every symbol here clears
     * the 8% relative-spread gate on a majority of near-the-money contracts on the free
     * `indicative` feed. AAPL (47%) and MSFT (28%) were removed for failing it more often
     * than they passed, which was the cause of repeated "spread > 8% limit" rejections.
     * Reproduce with `node --env-file=.env.local scripts/screen-liquidity.mjs`.
     */
    symbols,

    /**
     * Settings that are malformed, out of range, or inconsistent with one another. A
     * non-empty list means no order may be built: `runAgent` refuses the run and names them,
     * rather than sizing a position against a limit that does not mean what was written.
     */
    issues,
  };
}

export type VolGuardConfig = ReturnType<typeof getConfig>;

export function isConfigured(): boolean {
  const config = getConfig();
  return Boolean(config.apiKey && config.secretKey && config.paperOnly);
}

export function modeIsAllowed(mode: AgentMode): boolean {
  if (mode === "dry-run") return true;
  const config = getConfig();
  return isConfigured() && config.paperOnly && Boolean(config.accountId);
}
