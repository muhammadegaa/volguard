# Why VolGuard publishes no trade-level backtest

**Measured 6 Sept 2026.** Reproduce with `node --env-file=.env.local scripts/probe-option-history.mjs`.

A trade-level backtest of this agent needs three things at a past date:

1. the **implied volatility** that produced the entry signal — the variance risk premium is
   ATM IV minus a forecast of realized vol, so without IV there is no signal to test;
2. a **two-sided quote** to cross at, because the selector prices every spread at the ask on
   what it buys and the bid on what it sells, never the mid;
3. a contract that has **since expired**, so the outcome is known.

None of the three is available on this account.

## What the probe found

**A historical option bar carries `c,h,l,n,o,t,v,vw`.** Trade open/high/low/close, trade
count, timestamp, volume, volume-weighted price. There is no bid, no ask, no greeks and no
implied volatility on any historical endpoint. Coverage itself is fine — 21 long-dated SPY
calls returned 2,008 daily bars over roughly 130 sessions — so this is not a sparsity
problem. The fields simply are not there.

**Expired contracts return nothing.** `/v2/options/contracts` for a past expiry returns zero
rows under the default listing, `status=inactive`, and `status=active` alike. Constructing the
OCC symbols by hand and asking the bars endpoint directly returns zero series for all 25
strikes sampled. So a contract whose outcome is known cannot be read at all.

Those two findings close the loop in both directions. To measure an outcome you need a
contract that has expired, and those return no data. To get data you need a contract still
listed, and those have not expired yet.

**Greeks and implied volatility exist only in the live feed.** Of 100 live SPY snapshots
sampled on the free `indicative` feed, 36 carried `greeks` and `impliedVolatility`. These are
exactly the inputs the entry signal and the delta-targeted leg selection depend on, and there
is no historical equivalent of this endpoint.

## What could have been published instead, and why it was not

A study could pick strikes by fixed moneyness rather than by delta, use trade closes as fills,
and hold to expiry. Every one of those substitutions changes the thing being measured:

- **Moneyness is not delta.** The agent buys the 0.55-delta leg and sells the 0.27-delta leg.
  A fixed-moneyness proxy is a different strategy that happens to share a shape.
- **A trade close is not a fill.** It is not the worst-case cross the live engine prices
  against, and it exists only for strikes that traded — which biases toward the liquid ones.
- **Holding to expiry ignores the exit rules entirely** — the take-profit, the stop and the
  7-DTE time stop are three of the agent's most consequential behaviours.
- **And the entry signal could not be applied at all**, because IV is unavailable. The result
  would be an unconditional debit-spread study, not a measurement of this agent's edge.

A number carrying four substitutions of that size would be presented as evidence for a claim
it cannot support. The forecast validation in `forecast-validation.md` is a real out-of-sample
measurement on data that genuinely exists, and it does not need a weak companion.

## What is measured instead

- **`forecast-validation.md`** — walk-forward, strictly out-of-sample validation of the HAR-RV
  volatility forecast against the trailing estimators it replaced. This is the one component
  of the edge that daily bars *can* test, and it is tested honestly.
- **`liquidity-screen.md`** — the measured options liquidity of every candidate symbol, which
  is why the watchlist is what it is.
- **The audit ledger** — every live run, every gate, every abstention, with its reason.
