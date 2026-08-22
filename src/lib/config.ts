import type { AgentMode } from "./types";

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw === "true";
}

export function getConfig() {
  const baseUrl = process.env.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets";
  const paperOnly = baseUrl.includes("paper-api.alpaca.markets") && process.env.ALPACA_PAPER_TRADE !== "false";
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

    // Risk limits
    maxLossPerTrade: numberEnv("VOLGUARD_MAX_LOSS_PER_TRADE", 250),
    maxRiskPercent: numberEnv("VOLGUARD_MAX_RISK_PERCENT", 0.01),
    maxDailyLoss: numberEnv("VOLGUARD_MAX_DAILY_LOSS", 500),
    maxOpenPositions: numberEnv("VOLGUARD_MAX_OPEN_POSITIONS", 3),
    maxPortfolioRiskPercent: numberEnv("VOLGUARD_MAX_PORTFOLIO_RISK_PERCENT", 0.05),
    maxContracts: numberEnv("VOLGUARD_MAX_CONTRACTS", 5),

    // Liquidity and quote quality
    maxSpreadPercent: numberEnv("VOLGUARD_MAX_SPREAD_PERCENT", 0.08),
    maxQuoteAgeSeconds: numberEnv("VOLGUARD_MAX_QUOTE_AGE_SECONDS", 90),
    minQuoteSize: numberEnv("VOLGUARD_MIN_QUOTE_SIZE", 5),

    // Strategy shape
    minDte: numberEnv("VOLGUARD_MIN_DTE", 7),
    maxDte: numberEnv("VOLGUARD_MAX_DTE", 60),
    /** Preferred holding horizon. The chain expiry nearest this is the one traded. */
    targetDte: numberEnv("VOLGUARD_TARGET_DTE", 30),
    longLegDelta: numberEnv("VOLGUARD_LONG_LEG_DELTA", 0.55),
    shortLegDelta: numberEnv("VOLGUARD_SHORT_LEG_DELTA", 0.27),
    /** Reject a spread whose debit exceeds this fraction of the strike width. */
    maxDebitToWidth: numberEnv("VOLGUARD_MAX_DEBIT_TO_WIDTH", 0.7),

    // ── Selling premium ────────────────────────────────────────────────────
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
    /** Delta targets for a credit vertical: sell near the money, buy the far wing. */
    creditShortLegDelta: numberEnv("VOLGUARD_CREDIT_SHORT_LEG_DELTA", 0.25),
    creditLongLegDelta: numberEnv("VOLGUARD_CREDIT_LONG_LEG_DELTA", 0.10),
    /** Reject a credit spread paying less than this fraction of the width it risks. */
    minCreditToWidth: numberEnv("VOLGUARD_MIN_CREDIT_TO_WIDTH", 0.25),
    /**
     * Floor for selling premium. Between `maxEntryVrp` and this is a deliberate dead band:
     * the premium carries a couple of vol points of measurement error, and an agent that
     * flips between buying and selling on noise reads as incoherent.
     */
    minSellVrp: numberEnv("VOLGUARD_MIN_SELL_VRP", 0.03),
    /**
     * Selling into a known catalyst is categorically more dangerous than buying it — the
     * rich implied vol being sold IS the compensation for that catalyst. Every sell-side
     * gate is therefore stricter than its buy-side counterpart.
     */
    maxSellEventScore: numberEnv("VOLGUARD_MAX_SELL_EVENT_SCORE", 25),
    maxSellJumpFraction: numberEnv("VOLGUARD_MAX_SELL_JUMP_FRACTION", 0.25),
    /** Any backwardation at all blocks a sale: the front expiry is the one being sold. */
    sellMinTermSlope: numberEnv("VOLGUARD_SELL_MIN_TERM_SLOPE", 0.0),
    /**
     * Entry gate. VolGuard buys optionality only when implied vol is cheap relative to what
     * the underlying is expected to deliver: VRP = ATM IV - forecast vol must be below this.
     *
     * NOTE: this threshold was tuned against the old trailing baseline and has deliberately
     * NOT been re-tuned for the forecast. Changing the baseline and the threshold together
     * would make the before/after uninterpretable, and tuning it until more trades appear
     * would be fitting to the demo.
     */
    maxEntryVrp: numberEnv("VOLGUARD_MAX_ENTRY_VRP", 0.0),
    /** Abstain entirely when event risk scores at or above this level. */
    maxEventScore: numberEnv("VOLGUARD_MAX_EVENT_SCORE", 60),
    /** Abstain when this share of realized variance came from jumps rather than drift. */
    maxJumpFraction: numberEnv("VOLGUARD_MAX_JUMP_FRACTION", 0.35),
    minIvSamplesForRank: numberEnv("VOLGUARD_MIN_IV_SAMPLES", 20),
    /**
     * Daily bars fetched per symbol. The volatility forecast needs roughly two years:
     * walk-forward measured it as WORSE than the trailing estimator it replaces at 260
     * bars, and better at 520. Beyond ~520 there is no further gain.
     */
    barSessions: numberEnv("VOLGUARD_BAR_SESSIONS", 520),

    // Exits
    takeProfitPercent: numberEnv("VOLGUARD_TAKE_PROFIT_PERCENT", 0.5),
    stopLossPercent: numberEnv("VOLGUARD_STOP_LOSS_PERCENT", 0.5),
    timeStopDte: numberEnv("VOLGUARD_TIME_STOP_DTE", 7),

    // Autonomy
    scheduleEnabled: boolEnv("VOLGUARD_SCHEDULE_ENABLED", false),
    scheduleIntervalMinutes: numberEnv("VOLGUARD_SCHEDULE_INTERVAL_MINUTES", 15),
    scheduleMode: (process.env.VOLGUARD_SCHEDULE_MODE === "paper" ? "paper" : "dry-run") as AgentMode,
    /** Must stay under the route's maxDuration (60s) so the agent times out before the
     *  platform does, producing a recorded ERROR run rather than an opaque 504. */
    runTimeoutMs: numberEnv("VOLGUARD_RUN_TIMEOUT_MS", 45_000),

    // Request throttling, per client per minute. Bounds Alpaca API usage and accidental
    // hammering; it is not an authorization control, so it can be tuned per deployment.
    runRateLimitPerMinute: numberEnv("VOLGUARD_RUN_RATE_LIMIT", 30),
    mcpRateLimitPerMinute: numberEnv("VOLGUARD_MCP_RATE_LIMIT", 10),

    /**
     * Screened for options liquidity rather than name recognition: every symbol here clears
     * the 8% relative-spread gate on a majority of near-the-money contracts on the free
     * `indicative` feed. AAPL (47%) and MSFT (28%) were removed for failing it more often
     * than they passed, which was the cause of repeated "spread > 8% limit" rejections.
     * Reproduce with `node --env-file=.env.local scripts/screen-liquidity.mjs`.
     */
    symbols: (process.env.VOLGUARD_SYMBOLS ?? "SPY,QQQ,IWM,DIA,TLT,GLD,SLV,NVDA,TSLA,PLTR,AMZN,MU,NFLX,TSM")
      .split(",")
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean),
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
