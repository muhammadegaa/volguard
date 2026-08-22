# VolGuard — 90 second demo script

**Rule for this recording: nothing is staged.** If the agent abstains on the day you record,
record the abstain and say why it is the right answer. Do not re-run until you get a trade.
A judge who sees an honest `NO_TRADE` with a clear reason learns more about the product than
one who sees a trade that was fished for.

Record at 1440×900 or wider. Outside 09:30–16:00 ET the agent still scans the full universe
and publishes a ranked verdict per symbol on last-session data, then stops at the
`market_open` gate instead of constructing an order — so the analysis is demonstrable at any
hour. Only live quote ages and an actual submitted order need market hours.

---

## Before recording

```bash
npm run dev
curl -X POST localhost:3000/api/mcp                                     # populates MCP evidence
curl -X POST localhost:3000/api/agent/run -H 'content-type: application/json' -d '{"mode":"dry-run"}'
```

Reload the dashboard so the ledger has a decision and the MCP panel has a result. Have the
operator token on the clipboard if you intend to show paper execution.

---

## 0:00–0:12 — The problem

> "Most trading agents predict direction. Direction is a coin flip, and an options position
> that's really just a levered stock bet is a stock signal in an options costume.
> VolGuard trades what options actually price: the gap between what the market *charges*
> for movement and what the stock actually *delivers*."

*On screen: the hero. "Buy movement only when it's cheap."*

## 0:12–0:25 — A real Alpaca observation

*Scroll to the metric row.*

> "This is a live Alpaca paper account — equity, options level 3, account ID verified,
> market session, and the daily loss budget the agent is working inside. Every number here
> comes from Alpaca, and the panel says which endpoint it came from."

## 0:25–0:45 — Volatility and event reasoning

*Scroll to the expanded decision card.*

> "Here's the whole watchlist scanned in one pass, and every symbol gets a verdict.
> QQQ and NVDA — implied vol is rich, so we stand aside; we only ever buy premium.
> SPY — event risk 69 out of 100, a catalyst is priced in, stand aside.
> MSFT looks like the cheapest optionality on the board at minus 16 vol points — and it's
> rejected. Forty-nine percent of its realized variance is one earnings gap that already
> happened. We price against bipower variation, the jump-robust estimator, so a move that's
> already in the past can't make future optionality look cheap."

*Point at the IV vs realized headline.*

> "AAPL is the one that survives: 24.9% implied against 31.4% jump-robust realized. Minus
> 6.7 vol points. The market is charging less for movement than the stock has been
> delivering."

## 0:45–1:00 — The spread and the risk gates

> "The agent goes to the live chain, targets delta 0.55 long and 0.27 short at 30 days, and
> builds a defined-risk debit spread. Six dollars two cents debit, fifteen dollar width.
> Max loss $602 — and that's not a stop, it's arithmetic; it's the most this position can
> ever lose. Max profit $898. Quotes are two seconds old.
> Then twenty-seven deterministic gates run. Quote freshness, spread width, displayed depth,
> daily loss budget, portfolio exposure, duplicate order ID. The model can propose and it
> can veto. Only this engine can approve."

## 1:00–1:12 — Execution, exits, audit

> "Dry run stops here — it read everything and submitted nothing. In paper mode this
> submits one spread behind an operator token, idempotent by client order ID so a repeated
> run can't double-fill. Every run also reviews open positions and closes at +50% of max
> profit, −50% of premium, or seven days to expiry."

*Point at the audit ledger.*

> "And every observation, gate, order and skip lands in an append-only ledger — including
> the MCP call: the official Alpaca MCP server, 74 tools discovered, real read-only calls
> against this account."

## 1:12–1:22 — Autonomy and the kill switch

> "It's not a button. A cron hits the scheduled endpoint during market hours; the endpoint
> owns the interval gate, the market-hours check, a single-run lock so runs can't overlap,
> and a timeout. And the kill switch blocks every execution path at once."

## 1:22–1:30 — Why this is an agent

> "It decides *whether* to act, not just what to buy. On this run it looked at six symbols
> and said no to five of them, each for a different, stated reason. Forced activity is a
> bug. 'No trade' is the decision it's most often right about."

---

## If you show a paper order

Say the account is a paper account, show the Alpaca order ID on the card, and then show the
same order in the Alpaca dashboard. Do not describe an order as filled unless the position
appears in the position monitor with P&L sourced from Alpaca.

## Never say

- "Returns", "performance", or "backtest" — there is no backtest, and paper P&L is not a
  track record.
- Anything about profitability. The account is days old with a $0 P&L; say so if asked.
- "Live trading". It is paper only and the adapter refuses non-paper hosts outright.
