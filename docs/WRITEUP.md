# VolGuard — one-page write-up

**AI logic · risk gates · Alpaca infrastructure**

VolGuard is an autonomous options agent that trades the *price* of movement rather than its
direction. It compares what the option market charges for movement (ATM implied volatility)
against what the underlying is forecast to deliver over that same option's life, and acts only
when the two disagree. Every run either opens defined-risk positions or states, per symbol,
why it did not.

## AI logic

The signal is the **variance risk premium**: ATM implied volatility minus a horizon-matched
forecast of realized volatility. Getting the second term right is where the work is.

The forecast is **HAR-RV** (Corsi, 2009) fitted on daily, weekly and monthly components of
**bipower variation** (Barndorff-Nielsen & Shephard), which is jump-robust — one earnings gap
three weeks old should not read as a forecast of future movement. The fit is horizon-matched:
the forecast is made over the exact number of days to the expiry being traded, not over a
fixed 20-day window, so the two sides of the subtraction describe the same period. When the
fit is weak the forecast is shrunk toward the trailing estimate in proportion to how little it
explains. This is validated **walk-forward and strictly out of sample** — at every cutoff the
model sees only prior bars and is scored against volatility it has never seen — and it beats
the trailing estimators it replaced by 6.1% / 3.0% / 10.0% RMSE at 7 / 14 / 30 sessions
(`npm run backtest`, `docs/evidence/forecast-validation.md`).

Two more gates sit on top: a **jump-contamination** limit, which rejects a symbol whose
apparent cheap optionality is mostly one gap that already happened, and an **event-risk
taxonomy** over Alpaca news and corporate actions — weighted by category, discounted by
recency and by whether a headline names the symbol, because twenty analyst notes are not the
same risk as one FDA decision. A known catalyst inside the holding window means expensive
premium is *compensation*, not mispricing.

**Claude's role is bounded and the boundary is enforced in code.** The model receives the
structured observation and the engine's decision. It may narrate, stress-test and **veto** a
trade down to no-trade. It may not change the symbol, change the strategy, or turn an abstain
into a trade — each violation falls back to a labelled rules-engine thesis, and each has a
unit test. A missing key, an outage, a refusal or malformed output all degrade to
`rules_fallback` rather than blocking the run. The agent never stops because the model did.

## Risk gates

**Maximum loss is arithmetic, not a stop.** Every structure is a defined-risk vertical — the
premium paid for a debit, the strike width less the credit for a credit — known before the
order exists, with no gap risk and no assignment tail. The engine verifies this
independently of the selector: `max_loss + max_profit` must equal the strike width, and both
legs must trade in equal size, so a mis-sized or ratio structure is rejected however it was
labelled.

**Thirty deterministic checks run before submission, twenty-seven of which block.**
Environment (paper endpoint, kill switch, account status, market open, options level),
structure (two legs, one bought and one sold, same expiry, same type, price below width,
equal ratios), liquidity (quote freshness with a missing timestamp failing closed, relative
spread, displayed depth), and money (per-trade cap, equity percentage, daily loss budget,
portfolio exposure, open position count, buying power, duplicate client order ID).

**The allocator is where the portfolio limits actually bind.** Every money gate compares one
order against one limit, so several orders measured against the same starting state each pass
while the portfolio breaches all of them together. VolGuard ranks the qualifying candidates
and works down the list spending a *single* budget, carrying the remaining daily loss
allowance, the open position count and the open risk, so each position is sized against what
the earlier ones left. A property test asserts the invariant the per-trade gates cannot.

**Every configured limit is range-checked when it is read.** A value that is malformed, out
of range, or inconsistent with another refuses the whole run and names the variable. A limit
that does not mean what was written is worse than no limit, because the gates report it as
passed.

Exits run **first** each cycle and independently of whether anything new qualifies: +50% of
maximum profit, −50% of premium, or 7 DTE, whichever comes first. A spread closes as **one
multi-leg order**, never leg by leg, because a partial fill across two separate orders can
close the hedge and leave the short option naked.

## Alpaca infrastructure

**Trading API (REST)** is the execution path: account, clock, calendar, positions, orders,
activities and portfolio history, plus stock snapshots and daily bars, news, corporate
actions, option contracts and chain snapshots with greeks and implied volatility. Entries and
grouped exits both go as `mleg` multi-leg orders. Retry with backoff throughout, and the
chain is paginated — without following `next_page_token`, a liquid underlying returns only
the front weeklies, and the agent would trade 8-day options believing it had targeted 30.

**The official Alpaca MCP server** runs over stdio for read-only account and market
inspection: 74 tools discovered, real calls recorded in the audit ledger, restricted to an
allow-list that refuses every write tool. It is an inspection channel and is never on the
order path.

**Paper is enforced at the adapter**, which refuses to contact a non-paper host at all, even
for a read. The account ID is verified before execution, a kill switch blocks every execution
path, orders are idempotent by a client order ID deterministic in symbol, strategy and date,
and paper execution requires an operator token. Autonomy runs through a scheduled endpoint
that owns its own guards — interval gate, market-hours check, single-run lock, authoritative
timeout that aborts before submission — so it is safe to call twice at once.

**Nothing is simulated.** P&L comes only from Alpaca portfolio history and fill activities;
unavailable data renders as unavailable rather than as zero. There is no trade-level
backtest, and that is a measured conclusion rather than an omission: historical option bars
carry trade OHLC only — no bid, no ask, no greeks, no implied volatility — and expired
contracts return no data at all, so there is neither an entry signal to reconstruct nor a
known outcome to score it against (`docs/evidence/backtest-feasibility.md`).
