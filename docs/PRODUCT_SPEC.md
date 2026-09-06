# VolGuard Product Specification

## One sentence

VolGuard is an autonomous paper-trading options agent that buys defined-risk convexity only
when implied volatility is cheap against what the underlying actually delivers, and states a
specific reason every time it declines.

## Users and use cases

The interface ships two views. **Guided** is the default: light, single-column, plain
language, and deliberately has *no execution control at all*. **Pro** is the dense terminal
with the full numeric detail and the paper-execution controls. A first-time visitor should be
able to name all six use cases from Guided in under a minute.

| # | Use case | Where it is visible |
|---|---|---|
| 1 | Evaluate an event/volatility setup | Scan row + volatility evidence panel |
| 2 | Propose a defined-risk options spread | Spread panel with legs, greeks, economics |
| 3 | Reject unsafe or weak setups | Risk gate grid + the abstain verdict per symbol |
| 4 | Execute only approved paper trades | Mode toggle, operator token, Alpaca order ID |
| 5 | Monitor positions and exits | Position monitor table with action + reason |
| 6 | Explain every decision | Append-only audit ledger |

## Agent loop

```
observe → measure volatility → score event risk → gate → rank →
  for each candidate: select strategy → build spread → size → risk-check → commit budget →
execute (paper) → monitor → exit → record
```

Position review runs **before** and independently of new-entry logic: exits are never
conditional on finding a fresh setup.

The per-candidate loop is sequential because it carries three accumulators — the remaining
daily loss budget, the open position count, and the open risk — and each approval spends
them before the next candidate is measured. Every money limit in the risk engine compares a
single intent against a limit, so candidates measured against the same starting state would
each pass while the portfolio breached all three together.

## Decision contract

A run holds one decision per candidate it considered, each with its own status, thesis,
order intent and risk record. The run's own status is the aggregate, in this precedence:
a submission failure outranks a success, a success outranks a rejection, a rejection outranks
missing data. The dashboard's headline fields are a view of whichever decision the run's
status came from; the rest are reachable by selecting the symbol.

The statuses a run or a decision can carry:

| Status | Meaning |
|---|---|
| `TRADE_APPROVED` | All gates passed. Order submitted (paper) or withheld (dry-run). |
| `TRADE_REJECTED` | A blocking risk gate failed. The failing gates are named. |
| `NO_TRADE` | No symbol cleared the entry gate, or size rounds to zero under what the budget has left, or the market is closed. The universe scan and per-symbol verdicts are published either way. |
| `DATA_UNAVAILABLE` | Alpaca returned no tradable spread for any candidate that reached the chain. |
| `CONFIGURATION_REQUIRED` | Credentials, paper mode, or account ID verification failed. |
| `ERROR` | Unhandled failure; the message is recorded verbatim. |

Every run records: id, start/finish, duration, mode, trigger (`manual`/`scheduled`), the
full scan with a per-symbol verdict, the chosen observation, the thesis and its source, the
risk decision with all gates, the order intent, any Alpaca order IDs, and position reviews.

## Strategy policy

**Entry requires all of:**
- ATM implied volatility and a horizon-matched realized-vol forecast both available
- Variance risk premium (ATM IV − forecast realized vol over the traded expiry's horizon) ≤ `VOLGUARD_MAX_ENTRY_VRP` (default 0)
- Jump share ≤ `VOLGUARD_MAX_JUMP_FRACTION` (default 0.35)
- Event score < `VOLGUARD_MAX_EVENT_SCORE` (default 60)
- Term structure not in backwardation beyond −2 vol points
- A tradable debit spread exists that clears every liquidity gate
- Position size ≥ 1 whole contract under all money limits

**Direction** comes from spot vs the 20-day average, confirmed by 25-delta skew.

**Structure is defined-risk verticals only** — a debit spread when premium is cheap, a credit
spread when it is rich. Maximum loss is the premium paid or the strike width less the credit
collected, known before the order is built and verified arithmetically by the risk engine:
`max_loss + max_profit` must equal the strike width, and both legs must trade in equal size.
Nothing naked, no ratio spreads, no undefined risk in any regime.

Sell-side gates are strictly tighter than buy-side ones, because the rich implied volatility
being sold is compensation for a catalyst rather than a mispricing: event risk blocks at 25
rather than 60, any backwardation blocks rather than two vol points, and the jump limit
tightens to 25%.

Premium selling sits behind `VOLGUARD_SELL_PREMIUM_ENABLED`, enforced in both the strategy
layer and the risk engine, and is **off** pending verification of Alpaca's undocumented sign
convention for a net-credit multi-leg limit price.

**Universe selection:** all symbols are scanned, and the universe is screened for options
liquidity before a symbol enters the watchlist at all. Candidates are ranked by variance risk
premium, most negative first on the buy side, and the allocator works down that list until a
budget runs out. One position per underlying per day, enforced by a client order id that is
deterministic in symbol, strategy and date.

## Safety policy

- Paper trading only. The adapter refuses to contact a non-paper host at all, even for reads.
- The connected account ID must match `ALPACA_ACCOUNT_ID` before execution.
- Options trading level must be ≥ 3.
- Maximum loss per trade, as dollars and as a percentage of equity.
- Daily loss budget and portfolio exposure cap, both enforced before submission.
- Maximum open positions, counted against positions this run has already opened as well as
  those already held.
- Whole-number quantities; `day` time-in-force.
- Quotes must be fresh, two-sided, tight, and show depth. A missing timestamp fails closed.
- The global kill switch rejects every execution path.
- Duplicate client order IDs are rejected against Alpaca before submission.
- Paper execution requires the operator token; scheduled runs require the token or cron secret.
- MCP is restricted to a read-only allow-list and refuses any other tool.

## AI boundary

The model receives the structured observation and the engine's decision. It may rephrase,
explain, and **downgrade to `no_trade`**. It may **not**:

- change the symbol,
- change the strategy,
- upgrade an abstain into a trade,
- emit anything that fails schema validation.

Each violation falls back to the labelled rules-engine thesis, and each has a unit test.
A missing key, an outage, a refusal, a billing failure or malformed output all degrade to
`rules_fallback` rather than blocking the run — the agent never stops because the model did.

## Data honesty rules

- Every dashboard number names its source.
- Unavailable data renders as `—` or `building (n obs)`, never as `0`.
- `MarketObservation.unavailable` lists anything Alpaca did not return, and the UI shows it.
- P&L comes only from Alpaca portfolio history and fill activities.
- Realized P&L stays `null` until a closing fill exists — it is never inferred.
- No replay or fixture data is presented as live. If replay is ever added it must be
  labelled in the UI, and no such path currently exists.

## Dashboard acceptance criteria

- A visitor understands the product from the hero alone.
- The current mode is always visible; DRY RUN and PAPER are visually and textually distinct,
  each stating what it will do.
- Paper execution is disabled, with the reason shown, when the token is absent, the kill
  switch is on, or the account ID does not match.
- Loading, empty, disconnected, error and no-trade states all render meaningfully.
- Every risk gate is inspectable and failures are listed explicitly. Pro shows all gates
  with detail on hover; Guided summarises the count and folds the passing ones away, since a
  wall of green ticks is reassurance rather than information.
- Wide tables scroll inside their own container; the page never scrolls horizontally.
- No secret ever reaches the browser (asserted in E2E).
