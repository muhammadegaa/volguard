import { getConfig } from "./config";
import type { AlpacaAccount, OrderIntent, RiskCheck, RiskDecision } from "./types";

export interface RiskInput {
  account: AlpacaAccount;
  openPositionCount: number;
  /** Sum of remaining defined risk across open VolGuard spreads, in dollars. */
  openRiskDollars: number;
  /** Realized loss already taken today, as a positive number. */
  dailyLossUsed: number;
  intent: OrderIntent;
  /** True when Alpaca already has an order with this client order id. */
  duplicateClientOrderId: boolean;
  /** Alpaca's own clock. null means the clock could not be read, which blocks. */
  marketOpen: boolean | null;
  now?: Date;
}

/**
 * Deterministic pre-trade gate. The model can propose; only this function can approve.
 * Every configured limit is checked here — a limit that exists in config but not in this
 * list is a bug, and the unit tests assert the full set is present.
 */
export function evaluateRisk(input: RiskInput): RiskDecision {
  const config = getConfig();
  const checks: RiskCheck[] = [];
  const add = (name: string, passed: boolean, detail: string, blocking = true) =>
    checks.push({ name, passed, detail, blocking });

  const { intent, account } = input;
  const equity = Number(account.equity);
  const buyingPower = Number(account.buying_power);
  const cash = Number(account.cash);

  // --- Environment -------------------------------------------------------
  add("paper_environment", config.paperOnly, config.paperOnly
    ? "Paper Alpaca base URL confirmed"
    : "Live trading base URL is not allowed");
  add("kill_switch", !config.killSwitch, config.killSwitch
    ? "Global kill switch is enabled"
    : "Kill switch is clear");
  add("account_status", account.status === "ACTIVE", `Account status: ${account.status}`);
  // The agent analyses the universe around the clock, but only this gate lets an order
  // through, so a closed market must fail here rather than upstream.
  add("market_open", input.marketOpen === true, input.marketOpen === null
    ? "Alpaca clock unavailable"
    : input.marketOpen
      ? "Alpaca reports the market is open"
      : "Market is closed; orders are only submitted during regular hours");
  add("options_level", (account.options_trading_level ?? 0) >= 3,
    `Options trading level ${account.options_trading_level ?? "unknown"}; multi-leg spreads require level 3`);

  // --- Structure ---------------------------------------------------------
  const twoLegs = intent.legs.length === 2;
  add("two_leg_spread", twoLegs, `${intent.legs.length} legs; Alpaca multi-leg orders accept 2 to 4`);
  add("defined_risk",
    twoLegs && intent.legs.some((leg) => leg.side === "buy") && intent.legs.some((leg) => leg.side === "sell"),
    "Requires one long and one short leg so maximum loss is the net debit");
  add("same_expiry",
    twoLegs && intent.legs[0].expirationDate === intent.legs[1].expirationDate,
    twoLegs ? `Both legs expire ${intent.legs[0].expirationDate}` : "Cannot compare expiries");
  add("same_option_type",
    twoLegs && intent.legs[0].type === intent.legs[1].type,
    twoLegs ? `Both legs are ${intent.legs[0].type}s` : "Cannot compare option types");
  add("all_option_legs", intent.legs.every((leg) => leg.type === "call" || leg.type === "put"),
    "Every leg is an option contract; equity legs are not supported in multi-leg orders");
  add("debit_below_width", intent.width > 0 && intent.limitPrice < intent.width,
    `Debit $${intent.limitPrice.toFixed(2)} vs width $${intent.width.toFixed(2)}`);
  add("positive_debit", intent.limitPrice > 0 && Number.isFinite(intent.limitPrice),
    `Net debit $${intent.limitPrice.toFixed(2)}`);
  add("whole_quantity", Number.isInteger(intent.qty) && intent.qty > 0, `Quantity: ${intent.qty}`);
  add("time_in_force", intent.timeInForce === "day",
    `Time in force ${intent.timeInForce}; options accept day or gtc only`);

  // --- Quote quality -----------------------------------------------------
  const ages = intent.legs.map((leg) => leg.quoteAgeSeconds);
  const stalest = ages.every((age) => age !== null) ? Math.max(...(ages as number[])) : null;
  add("quote_freshness", stalest !== null && stalest <= config.maxQuoteAgeSeconds,
    stalest === null
      ? "At least one leg is missing a quote timestamp"
      : `Stalest leg quote is ${stalest.toFixed(0)}s old (limit ${config.maxQuoteAgeSeconds}s)`);
  const worstSpread = Math.max(...intent.legs.map((leg) =>
    leg.bid !== null && leg.ask !== null && leg.mid && leg.mid > 0 ? (leg.ask - leg.bid) / leg.mid : Number.POSITIVE_INFINITY));
  add("spread_quality", worstSpread <= config.maxSpreadPercent,
    Number.isFinite(worstSpread)
      ? `Widest leg spread ${(worstSpread * 100).toFixed(1)}% (limit ${(config.maxSpreadPercent * 100).toFixed(1)}%)`
      : "A leg is missing a two-sided quote");
  const worstSize = Math.min(...intent.legs.map((leg) =>
    leg.bidSize !== null && leg.askSize !== null ? Math.min(leg.bidSize, leg.askSize) : 0));
  add("quote_depth", worstSize >= config.minQuoteSize,
    `Thinnest leg shows ${worstSize} contracts (minimum ${config.minQuoteSize})`);
  add("size_vs_depth", intent.qty <= Math.max(1, worstSize),
    `Order size ${intent.qty} against displayed depth ${worstSize}`, false);

  // --- Money -------------------------------------------------------------
  add("max_loss_per_trade", intent.maxLoss <= config.maxLossPerTrade,
    `Max loss $${intent.maxLoss.toFixed(2)} / limit $${config.maxLossPerTrade.toFixed(2)}`);
  add("equity_risk", Number.isFinite(equity) && intent.maxLoss <= equity * config.maxRiskPercent,
    `Max loss $${intent.maxLoss.toFixed(2)} / ${(config.maxRiskPercent * 100).toFixed(2)}% of equity $${(equity * config.maxRiskPercent).toFixed(2)}`);
  const dailyRemaining = config.maxDailyLoss - input.dailyLossUsed;
  add("daily_loss_limit", intent.maxLoss <= dailyRemaining,
    `$${input.dailyLossUsed.toFixed(2)} of the $${config.maxDailyLoss.toFixed(2)} daily loss budget is used; $${dailyRemaining.toFixed(2)} remains against a $${intent.maxLoss.toFixed(2)} risk`);
  add("portfolio_exposure",
    Number.isFinite(equity) && input.openRiskDollars + intent.maxLoss <= equity * config.maxPortfolioRiskPercent,
    `Open risk $${input.openRiskDollars.toFixed(2)} + $${intent.maxLoss.toFixed(2)} vs ${(config.maxPortfolioRiskPercent * 100).toFixed(1)}% cap $${(equity * config.maxPortfolioRiskPercent).toFixed(2)}`);
  add("open_positions", input.openPositionCount < config.maxOpenPositions,
    `${input.openPositionCount} open / ${config.maxOpenPositions} max`);
  add("buying_power",
    Number.isFinite(buyingPower) ? intent.maxLoss <= buyingPower : Number.isFinite(cash) && intent.maxLoss <= cash,
    `Debit $${intent.maxLoss.toFixed(2)} against buying power $${Number.isFinite(buyingPower) ? buyingPower.toFixed(2) : "unknown"}`);

  // --- Idempotency -------------------------------------------------------
  add("no_duplicate_order", !input.duplicateClientOrderId,
    input.duplicateClientOrderId
      ? `Alpaca already has an order with client id ${intent.clientOrderId}`
      : `Client order id ${intent.clientOrderId} is unused`);

  // --- Advisory ----------------------------------------------------------
  add("reward_risk", intent.rewardRisk >= 0.4,
    `Reward:risk ${intent.rewardRisk.toFixed(2)}:1 (max profit $${intent.maxProfit.toFixed(2)})`, false);
  add("open_interest",
    intent.legs.every((leg) => leg.openInterest === null || leg.openInterest >= 10),
    intent.legs.map((leg) => `${leg.symbol} OI ${leg.openInterest ?? "not published by Alpaca"}`).join("; "), false);

  const blocking = checks.filter((check) => check.blocking && !check.passed);
  return {
    approved: blocking.length === 0,
    reasons: blocking.map((check) => `${check.name}: ${check.detail}`),
    checks,
  };
}
