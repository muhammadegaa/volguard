# VolGuard Product Specification

## One sentence

VolGuard is an autonomous paper-trading options agent that buys defined-risk convexity only
when implied volatility is cheap against what the underlying actually delivers, and states a
specific reason every time it declines.

## Users and use cases

The dashboard is built so a first-time visitor can name all six in under a minute.

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
observe → measure volatility → score event risk → gate → select strategy →
build spread → size → risk-check → execute (paper) → monitor → exit → record
```

Position review runs **before** and independently of new-entry logic: exits are never
conditional on finding a fresh setup.

## Decision contract

Every run emits exactly one status:

| Status | Meaning |
|---|---|
| `TRADE_APPROVED` | All gates passed. Order submitted (paper) or withheld (dry-run). |
| `TRADE_REJECTED` | A blocking risk gate failed. The failing gates are named. |
| `NO_TRADE` | No symbol cleared the entry gate, or size rounds to zero, or the market is closed. The universe scan and per-symbol verdicts are published either way. |
| `DATA_UNAVAILABLE` | Alpaca returned no tradable spread for the chosen symbol. |
| `CONFIGURATION_REQUIRED` | Credentials, paper mode, or account ID verification failed. |
| `ERROR` | Unhandled failure; the message is recorded verbatim. |

Every run records: id, start/finish, duration, mode, trigger (`manual`/`scheduled`), the
full scan with a per-symbol verdict, the chosen observation, the thesis and its source, the
risk decision with all gates, the order intent, any Alpaca order IDs, and position reviews.

## Strategy policy

**Entry requires all of:**
- ATM implied volatility and jump-robust realized volatility both available
- Variance risk premium (ATM IV − bipower RV20) ≤ `VOLGUARD_MAX_ENTRY_VRP` (default 0)
- Jump share ≤ `VOLGUARD_MAX_JUMP_FRACTION` (default 0.35)
- Event score < `VOLGUARD_MAX_EVENT_SCORE` (default 60)
- Term structure not in backwardation beyond −2 vol points
- A tradable debit spread exists that clears every liquidity gate
- Position size ≥ 1 whole contract under all money limits

**Direction** comes from spot vs the 20-day average, confirmed by 25-delta skew.

**Structure is debit spreads only.** Maximum loss equals the premium paid and is known
before the order is built. VolGuard therefore cannot express a short-premium view; rich
implied volatility maps to abstain, which is a deliberate constraint, not an oversight.

**Universe selection:** all symbols are scanned; the most negative variance risk premium wins.

## Safety policy

- Paper trading only. The adapter refuses to contact a non-paper host at all, even for reads.
- The connected account ID must match `ALPACA_ACCOUNT_ID` before execution.
- Options trading level must be ≥ 3.
- Maximum loss per trade, as dollars and as a percentage of equity.
- Daily loss budget and portfolio exposure cap, both enforced before submission.
- Maximum open positions.
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
- Every risk gate is inspectable, with its detail on hover and failures listed explicitly.
- Wide tables scroll inside their own container; the page never scrolls horizontally.
- No secret ever reaches the browser (asserted in E2E).
