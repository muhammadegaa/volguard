# VolGuard — slide outline (10 slides, ~90s of talk track)

Design: near-black (#0b0d0d), acid-lime accent (#d9f05d), mint (#77e6bd) for confirmations,
red (#ff817d) for blocks. Space Grotesk headings, DM Mono for data. One idea per slide.

---

## 1 — Title
**VolGuard**
*Buy movement only when it's cheap.*
Autonomous options agent · Alpaca paper · volatility track
Footer: paper trading only · no real capital · not investment advice

## 2 — The problem
> Most trading agents predict direction.

- Direction is close to a coin flip
- An options position that is really a levered stock bet is **a stock signal in an options costume**
- The volatility track asks a different question: is the *premium* right?

## 3 — The thesis
**Variance risk premium = implied volatility − realized volatility**

- Implied = what the market **charges** for movement
- Realized = what the underlying actually **delivered**
- Usually positive → options are usually expensive → most people sell it
- VolGuard only ever **buys** premium, and only when it is cheap
- Rich premium → **abstain**, never invert into undefined risk

## 4 — The bug that became the strategy
Two-column, before/after.

| | Raw realized | Jump-robust (bipower) |
|---|---|---|
| MSFT RV20 | **57.7%** | **41.4%** |
| Verdict | "cheapest optionality on the board" | **rejected — 49% jump** |

One +15.5% earnings gap, three weeks old, carrying the whole signal.
**The estimator you choose is the strategy.**

## 5 — What it measures
Grid of eight, all from Alpaca:
realized 20/10/5d · bipower + jump share · Parkinson range · ATM implied (delta-interpolated)
· term-structure slope · 25Δ skew · realized-vol rank · self-collected implied-vol rank

Callout: *Alpaca serves no IV history — VolGuard builds its own and says `building (n obs)`
rather than inventing a rank.*

## 6 — Event gate
Weighted taxonomy over Alpaca news, not headline count.
`earnings · regulatory · M&A · macro · policy · legal · leadership · ratings`
Discounted by recency and by whether the headline names the symbol. Plus corporate actions.

> Twenty analyst notes are not the same risk as one FDA decision.
> A known catalyst means expensive premium is **compensation**, not mispricing.

## 7 — The trade
AAPL 2026-09-18 · long 315C (Δ0.53, IV 25.3%) / short 330C (Δ0.28, IV 24.5%)

| Debit | Width | Max loss | Max profit | R:R | Breakeven |
|---|---|---|---|---|---|
| $6.02 | $15 | **$602** | $898 | 1.49:1 | $321.02 |

**Max loss is arithmetic, not a stop.** It is known before the order exists.

## 8 — The risk engine
**27 deterministic gates.** The model may propose and may veto. Only the engine approves.
environment · structure · quote freshness · spread · depth · per-trade cap · equity % ·
daily loss budget · portfolio exposure · position count · buying power · duplicate order ID

Live scan: 6 symbols → **5 abstentions, each with a stated reason** → 1 trade.

## 9 — Agent, not chatbot
- Decides **whether** to act, not just what to buy
- Scheduled loop: interval gate · market-hours check · single-run lock · timeout · kill switch
- Idempotent orders by deterministic client order ID
- Monitors positions and exits at +50% / −50% / 7 DTE
- Official Alpaca **MCP server**: 74 tools, read-only, evidenced in the ledger
- Append-only audit ledger on every observation, gate, order and skip

## 10 — Honest close
**What is real:** live Alpaca paper data · real IV and greeks · every number sourced
**What is not claimed:** no backtest · no track record · paper fills are optimistic
**What is disclosed:** indicative feed (no OPRA) · no VIX on this plan · open interest often null

> The hardest thing an agent can do is decline to act.
> **"No trade" is a decision. Forced activity is a bug.**

Demo · Repo · Account ID
