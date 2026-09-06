# VolGuard

**An autonomous options agent that buys movement only when it's cheap.**

VolGuard compares what the option market *charges* for movement (implied volatility) against
what the underlying has actually *delivered* (realized volatility). When premium is cheap
and no known catalyst explains it, the agent buys a defined-risk vertical spread on Alpaca
paper. Any other time it does the harder thing and stays out — and writes down why.

Built for the [Alpaca AI Trading Agents Hackathon](https://lablab.ai/ai-hackathons/alpaca-ai-trading-agents-hackathon),
volatility track. **Paper trading only. No real capital. Not investment advice.**

---

## The thesis in one paragraph

Most trading agents predict direction. Direction is close to a coin flip, and an options
position that is merely a levered directional bet is a stock signal wearing an options
costume. VolGuard trades the quantity options actually price: **the variance risk premium**,
the gap between implied and realized volatility. That premium is usually positive — options
are typically expensive — which is why most people sell it. VolGuard only ever *buys*
premium, and only on the comparatively rare occasions when it is negative. When premium is
rich, the honest options are to abstain or to sell it inside a *defined* risk — never to
take on a risk that cannot be bounded before the order exists. This is why "no trade" is the
most common output, and why that is a feature rather than a bug.

The selector, the strategy layer and the risk engine all handle credit verticals, with
strictly tighter gates on that side because the rich implied volatility being sold is
compensation for a catalyst rather than a mispricing. It ships **off**
(`VOLGUARD_SELL_PREMIUM_ENABLED=false`) pending a live check of Alpaca's undocumented sign
convention for a net-credit multi-leg limit price, so as configured the agent is buy-only.

## What it does, every run

| # | Job | Detail |
|---|---|---|
| 1 | **Evaluate** | Scores volatility and event risk across the whole watchlist |
| 2 | **Propose** | Selects delta-targeted, defined-risk vertical spreads from the live chain |
| 3 | **Reject** | Blocks weak, illiquid, stale or over-sized setups before they exist |
| 4 | **Allocate** | Works down the ranked candidates, spending one budget until a limit binds |
| 5 | **Execute** | Submits only approved orders, paper-only, idempotent by client order ID |
| 6 | **Monitor** | Reviews open positions each run; closes whole spreads on profit target, stop, or time stop |
| 7 | **Explain** | Writes every observation, gate and order to an append-only ledger |

## The volatility engine

Everything is computed from Alpaca data. Nothing is fabricated; anything unavailable is
reported as unavailable.

- **Realized volatility** — annualized close-to-close over 20 / 10 / 5 days.
- **Bipower variation** — the jump-robust estimator (Barndorff-Nielsen & Shephard). It
  supplies the jump share below and the components the forecast is fit on, so a gap that
  *already happened* cannot make future optionality look cheap. See below.
- **Forecast realized volatility** — a HAR-RV fit over the traded expiry's own horizon. This
  is the baseline the premium is priced against, and it reports its method, horizon,
  in-sample R² and how far it was shrunk toward the trailing estimate. See below.
- **Jump share** — the fraction of realized variance attributable to jumps. Above 35%, the
  agent abstains outright.
- **Parkinson estimator** — high-low intraday range, as a cross-check on close-to-close.
- **ATM implied volatility** — interpolated at |delta| ≈ 0.50 from Alpaca's chain snapshot,
  which serves real greeks and IV.
- **Term structure** — front-expiry vs back-expiry ATM IV. Backwardation means the curve is
  pricing a near-dated shock the news scan did not name, so the agent stands aside.
- **25-delta skew** — put IV minus call IV, used to confirm direction.
- **Realized-vol rank** — where 20-day realized sits in its own trailing 1-year range.
- **Implied-vol rank** — Alpaca serves no IV history, so VolGuard accumulates its own daily
  observation per symbol and shows `building (n obs)` until 20 samples exist. It never
  invents a rank.
- **Event risk** — a weighted taxonomy over Alpaca news (earnings, regulatory, M&A, macro,
  policy, legal, leadership, ratings) scored by recency and by whether the headline actually
  names the symbol, plus corporate actions in the window. Headline *count* is deliberately
  not the signal: twenty rating notes are not the same risk as one FDA decision.

### Why jump-robust volatility matters

On 2026-08-19, MSFT showed 20-day realized volatility of **57.7%** against 24.7% implied —
an apparently huge mispricing. It was one **+15.5%** earnings gap on 2026-07-30 carrying the
entire signal. Raw realized volatility said "cheapest optionality available"; the move had
already happened.

| Symbol | RV20 (raw) | BV20 (jump-robust) | Jump share |
|---|---|---|---|
| SPY | 13.5% | 13.9% | 0% |
| QQQ | 23.7% | 23.4% | 2% |
| AAPL | 35.3% | 31.4% | 21% |
| **MSFT** | **57.7%** | **41.4%** | **49%** |

VolGuard rejects MSFT as `jump-contaminated (49%)` on the bipower-derived jump share, and
prices the premium against a forecast rather than any trailing window at all — see
**The volatility forecast** below.

### Why the premium is priced against a forecast, not a trailing window

Implied volatility is forward-looking over the life of the option. Comparing it against a
*trailing* 20-day realized number is not like for like, and the mismatch is not academic —
measured across the watchlist on 2026-08-20, every symbol's 10-day realized vol sat far below
its 20-day, because the window still held a volatility episode that had already decayed.
Bipower strips *jumps*, but not a genuinely elevated stretch sitting in the older half of the
window.

VolGuard therefore prices the premium against a **HAR-RV forecast** (Corsi 2009) of realized
volatility over the traded expiry's own horizon, fit on the symbol's own history from
jump-robust components:

```
VRP = ATM implied vol − forecast realized vol over `daysToExpiry`
```

The pre-forecast number is kept and displayed beside it as `trailingVarianceRiskPremium`, so
the change of basis is auditable rather than asserted.

**It is validated, not assumed.** `npm run backtest` runs a walk-forward comparison, strictly
out of sample — at every origin the model sees only prior bars and is scored against a window
it has never seen:

| horizon | HAR | trailing bipower | RMSE | bias |
|---|---|---|---|---|
| 7 sessions | 13.96 | 14.87 | **6.1% better** | −0.61 vs −0.06 |
| 14 sessions | 13.07 | 13.48 | **3.0% better** | −1.06 vs −1.35 |
| 30 sessions | 11.37 | 12.63 | **10.0% better** | −1.56 vs −1.94 |

The honest headline is **calibration, not accuracy** — a 3% RMSE gain at the horizon actually
traded is modest. Two things this exercise falsified, both of which had been asserted
confidently beforehand, are recorded in `docs/evidence/forecast-validation.md`.

The forecast needs history: at 260 bars it measured **worse** than the estimator it replaces,
so `VOLGUARD_BAR_SESSIONS` defaults to **520**. Beyond ~520 there is no further gain. When the
fit is weak the forecast is shrunk toward the trailing estimate in proportion to how little it
explains, which also measured better.

### Both sides of the premium, both defined-risk

The variance risk premium is *positive* most of the time for large-cap equities — that is
why option selling is profitable on average. An agent that only ever buys premium therefore
abstains in the common regime and trades only a rare tail, which is where VolGuard started.

It now trades either side, and never with undefined risk:

| Regime | Structure | Maximum loss |
|---|---|---|
| Premium cheap (`VRP ≤ 0`) | Bull call / bear put **debit** spread | the premium paid |
| Dead band | no trade | — |
| Premium rich (`VRP ≥ +3 vol pts`) | Bull put / bear call **credit** spread | strike width − credit |

The dead band between the thresholds is deliberate: the premium carries a couple of vol
points of measurement error, and an agent that flips between buying and selling on
consecutive runs is reading noise, not being decisive.

**The sell-side gates are strictly tighter**, because selling into a known catalyst is
categorically worse than buying into one — the rich implied volatility being sold *is* the
compensation for that catalyst, and a binary event is exactly what breaches a short strike:

| Gate | Buying | Selling |
|---|---|---|
| Event score | blocks at 60 | **blocks at 25**, and `elevated`/`high` severity blocks at any score |
| Term structure | blocks below −2 vol pts | **blocks below 0** — any backwardation at all |
| Jump share | blocks above 35% | **blocks above 25%** |

Two properties make this safe to automate rather than merely intended to be. The risk engine
*verifies* definedness arithmetically — `max_loss + max_profit` must equal the strike width,
and both legs must trade in equal size, so a naked or ratio'd structure fails even if the
selector produced one. And premium selling is behind `VOLGUARD_SELL_PREMIUM_ENABLED`,
enforced in **both** the strategy layer and the risk engine, because a flag honoured in one
place is bypassable by any path that builds an order directly.

> **Not yet enabled.** Alpaca does not document the sign convention for a net-credit
> multi-leg `limit_price` — every example in their docs is a debit. Sending the wrong sign
> positive would pay to open a position whose maximum profit is that same amount: a silent,
> guaranteed loss that looks like ordinary slippage. The convention is read from
> `VOLGUARD_CREDIT_LIMIT_SIGN` so a live probe's answer is an environment change, and the
> flag stays off until that probe has run.

### The universe is screened, not chosen by reputation

The risk engine rejects any leg whose relative bid–ask spread exceeds 8%, so a symbol whose
options rarely clear that gate is not tradable however well known it is. Screening 61
candidates on the same free `indicative` feed the agent trades found only **14** clearing it on a
majority of near-the-money contracts — and that AAPL cleared it on 47% and MSFT on 28%, which
was the cause of repeated `spread > 8% limit` rejections. Both were removed.

The watchlist is therefore `SPY, QQQ, IWM, DIA, TLT, GLD, SLV, NVDA, TSLA, PLTR, AMZN, MU,
NFLX, TSM` — indices, rates, metals and single names, so the bets are less correlated than a
list of mega-cap tech would be. Override with `VOLGUARD_SYMBOLS`.

Reproduce with `node --env-file=.env.local scripts/screen-liquidity.mjs`; the result is
committed at `docs/evidence/liquidity-screen.md`.

## The risk engine

Twenty-seven deterministic gates run before any order. The model can propose and can veto;
**only this engine can approve.**

**Environment** — paper URL enforced · kill switch · account `ACTIVE` · options level ≥ 3 ·
market open
**Structure** — exactly 2 legs · one long + one short · same expiry · same option type · all
option legs · debit < strike width · positive debit · whole quantity · `day` time-in-force
**Quote quality** — max quote age (90s, missing timestamp fails) · max relative spread (8%) ·
minimum displayed depth · order size vs depth *(advisory)*
**Money** — max loss per trade · max % of equity · **daily loss budget** · portfolio exposure
cap · max open positions · buying power
**Idempotency** — duplicate client order ID blocked against Alpaca
**Advisory** — reward:risk · open interest

Position sizing takes the tightest binding limit of per-trade cap, equity percentage and
remaining daily budget. If no whole number of contracts fits, the run reports `NO_TRADE`
rather than shrinking a limit.

## Exits

Every run reviews open option legs and closes on whichever comes first: **+50%** of max
profit, **−50%** of premium paid, or **≤7 days to expiry** (before gamma and pin risk
dominate). Exit orders are idempotent per leg per day.

## Architecture

```
                        ┌──────────────────────────────────────────┐
   Alpaca paper API ───▶│  observe   bars · chain(greeks+IV) ·      │
   (REST, read)         │            news · corp actions · account  │
                        └───────────────────┬──────────────────────┘
                                            ▼
                        ┌──────────────────────────────────────────┐
                        │  volatility.ts   RV · bipower · jump      │
                        │                  share · HAR forecast ·   │
                        │                  ATM IV · term · skew ·   │
                        │                  ranks                    │
                        │  events.ts       weighted news taxonomy   │
                        └───────────────────┬──────────────────────┘
                                            ▼
                        ┌──────────────────────────────────────────┐
                        │  strategy.ts   VRP gate · event gate ·    │
                        │                jump gate · backwardation  │
                        │                gate → strategy or abstain │
                        └───────────────────┬──────────────────────┘
                                            ▼
                        ┌──────────────────────────────────────────┐
   Anthropic (optional)▶│  thesis.ts   narrate + stress-test.       │
                        │              May veto. May NEVER upgrade  │
                        │              an abstain into a trade.     │
                        └───────────────────┬──────────────────────┘
                                            ▼
                        ┌──────────────────────────────────────────┐
                        │  chain.ts    delta-targeted candidate     │
                        │              search → vertical spread     │
                        │  allocation  spend one budget down the    │
                        │              ranked list, then commit it  │
                        │  risk.ts     30 checks, 27 of them        │
                        │              blocking                     │
                        └───────────────────┬──────────────────────┘
                                            ▼
                        ┌──────────────────────────────────────────┐
   Alpaca paper API ◀───│  execute (paper only, idempotent)         │
   (REST, write)        │  positions.ts  monitor + exit             │
                        │  audit-store   append-only ledger         │
                        └──────────────────────────────────────────┘

   Alpaca MCP server ──▶  read-only inspection (get_clock, get_account_info).
   (official, stdio)      Never on the order path. Evidenced in the ledger.
```

**The AI boundary is a hard one.** The model receives the structured observation and the
engine's decision. It may rephrase, explain, and downgrade to `no_trade`. It may not change
the symbol, change the strategy, or turn an abstain into a trade — each of those is checked
and falls back to the rules engine, and each is covered by a test.

## Two audiences, one set of numbers

The interface opens in **Guided** mode and can be switched to **Pro** at any time; the choice
is remembered.

Guided mode never hides a number — it fronts each one with a sentence. The scan reads
`Candidate` / `Event soon` / `Distorted` instead of `IV cheap (-4.1v)`; the volatility
comparison reads *"Options are charging 25.2%"* against *"The stock actually delivers 31.7%"*
equals *"6.5 pts cheaper"*; the risk gates read *"Paper account only, never real money"*
instead of `paper_environment`. Every term of art is a clickable definition, and **Show the
full numbers** expands the complete Pro view inline.

Pro mode is the dense terminal: raw verdicts, the full 12-field volatility grid, the leg
table with deltas and quote ages, and gate names as the engine emits them.

The translation layer is `src/lib/explain.ts` — pure functions, unit-tested, because a wrong
explanation is a correctness bug. One test asserts that every gate the risk engine emits has
a plain-language label, so a new limit cannot ship without one.

## Production hardening

| Concern | What is in place |
|---|---|
| Transport | CSP with `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, strict referrer policy, HSTS in production, no `X-Powered-By` |
| Caching | Every `/api/*` response is `no-store` and `noindex`; account data is never cached or indexed |
| Input | Zod-validated request bodies; an invalid mode is rejected with 400 before the agent is reached |
| Abuse | Per-client fixed-window rate limiting with `Retry-After` and `X-RateLimit-*` headers |
| Observability | Structured JSON logs with a request id, duration and outcome; the id is returned to the client |
| Secrets | Log fields are redacted by name *and* by value shape, so an Alpaca or Anthropic key cannot reach a log line |
| Failure | Route-level error boundary that states plainly that a render error cannot cause a trade |
| Health | `GET /api/health` for liveness/readiness; `?deep=1` performs a real authenticated Alpaca call |
| Storage | The ledger is written under `.volguard/` locally and `/tmp/volguard/` on serverless, where the working directory is read-only. Writes are fail-soft: a storage error degrades to the in-process copy rather than killing a trading run, and the dashboard reports whether history is durable or per-instance |
| Accessibility | Keyboard-operable scan list, visible focus rings, skip link, live regions, `progressbar` semantics, reduced-motion support |

`/api/health` returns 503 whenever the paper lock does not hold, so a misconfigured instance
can never be considered healthy by a deploy check or an uptime monitor.

## Setup

Requires Node 20+. For the MCP bridge, also [`uv`](https://docs.astral.sh/uv/getting-started/installation/).

```bash
git clone <repo-url> && cd volguard
npm install
cp .env.example .env.local     # then fill in your Alpaca paper keys
npm run dev                    # http://localhost:3000
```

Get paper keys at <https://app.alpaca.markets/paper/dashboard/overview>. Options trading is
enabled by default on paper accounts at level 3.

Set `ALPACA_ACCOUNT_ID` to your account **number** (e.g. `PA…`) or account UUID — VolGuard
verifies the connected account matches before it will place anything, and the dashboard
shows `ID MISMATCH` if it does not.

> **Size your limits to your account.** `VOLGUARD_MAX_LOSS_PER_TRADE` below the cost of one
> at-the-money spread means the agent can never size a position and will always abstain. The
> defaults assume the standard $100k paper account. Note `.env.example` sets `1000` while the
> code default is `250`, so omitting the variable gives a four-times tighter limit than the
> example implies.

## Deploying

```bash
vercel                      # or connect the repo in the Vercel dashboard
```

**Required environment variables.** Everything else has a working default.

| Variable | Why |
|---|---|
| `ALPACA_API_KEY` · `ALPACA_SECRET_KEY` | Paper credentials |
| `ALPACA_ACCOUNT_ID` | Verified against the connected account before any execution |
| `VOLGUARD_OPERATOR_TOKEN` | Without it, paper execution is unreachable — dry run still works |
| `CRON_SECRET` | Vercel sends `Authorization: Bearer $CRON_SECRET`; without it every scheduled run is rejected 403 |
| `ANTHROPIC_API_KEY` | Optional. Absent or unfunded, the thesis degrades to a labelled rules-engine fallback rather than failing the run |

**Three platform constraints worth knowing before you deploy:**

- **History is per-instance.** The working directory is read-only on serverless, so the
  ledger is written to `/tmp` and resets on a cold start. The System panel reports which.
  Point `VOLGUARD_STORE_PATH` at a persistent volume, or run it on a host with a disk, if you
  need the ledger to survive.
- **Vercel Hobby runs cron once per day.** `vercel.json` is therefore set to `0 14 * * 1-5`
  — one run per weekday shortly after the US open — because anything more frequent is
  rejected at deploy time with *"Hobby accounts are limited to daily cron jobs."*
  Once a day is not an autonomous loop, so the real cadence lives in
  `.github/workflows/scheduled-run.yml`: GitHub Actions schedules are free on public repos
  and hit the same endpoint every 15 minutes during market hours. Set the `VOLGUARD_URL` and
  `CRON_SECRET` repository secrets to enable it. On Pro, restore `*/15 13-21 * * 1-5` in
  `vercel.json` and disable the workflow.
  Hobby also caps a function at 60s, which is why `maxDuration` is 60 and the agent's own
  timeout is 45s beneath it.

  Either way the endpoint owns every guard — interval gate, kill switch, market hours, run
  lock — so it is safe to call more often than intended, and safe to call twice at once.
- **The MCP bridge cannot run on serverless.** It spawns `uvx`, which is not in the runtime
  image. It degrades to "not probed" rather than failing anything; the REST adapter is the
  execution path in every environment. Run locally to demonstrate MCP.

Check a deployment with `GET /api/health?deep=1` — it performs a real authenticated Alpaca
call and returns 503 if the paper lock does not hold.

## Running the agent

- **DRY RUN** — reads live Alpaca data end to end, builds the candidate, runs every gate,
  and stops before the order endpoint. This is the default and it submits nothing.
- **PAPER** — submits one defined-risk spread. Requires `VOLGUARD_OPERATOR_TOKEN` in the
  `x-volguard-token` header; the UI collects it as a password field.

```bash
# Dry run
curl -X POST localhost:3000/api/agent/run \
  -H 'content-type: application/json' -d '{"mode":"dry-run"}'

# Verify the MCP integration (starts the official server, runs read-only tools)
curl -X POST localhost:3000/api/mcp
```

## Autonomy

Serverless functions cannot hold a timer between requests, so autonomy is driven by an
external clock calling `POST /api/agent/scheduled`. Every guard lives in the endpoint, so it
is safe to call more often than intended and safe to call twice at once:

- operator token **or** Vercel `Authorization: Bearer $CRON_SECRET`
- `VOLGUARD_SCHEDULE_ENABLED` must be true · kill switch must be clear
- interval rate-gate, enforced server-side regardless of caller
- market-hours check before any chain request
- single-run lock with a stale-lock timeout, so runs cannot overlap
- run timeout, retries with backoff, and an audit event for every outcome including skips

`vercel.json` ships a daily cron at `0 14 * * 1-5`, because Vercel's Hobby plan permits only
one run per day. The real cadence lives in `.github/workflows/scheduled-run.yml`, which calls
the same endpoint every 15 minutes during US market hours — the endpoint owns the interval
gate, the run lock and every other guard, so the scheduler is interchangeable. Any of them
works: GitHub Actions, a container cron, or `watch curl`.

## Testing

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest — 308 unit tests across 15 files
npm run build       # next build
npm run test:e2e    # playwright — 36 tests (some skip when the market is closed)
npm run backtest    # walk-forward validation of the volatility forecast
```

If port 3000 is occupied: `PLAYWRIGHT_PORT=3457 npm run test:e2e`.

## Honest limitations

These are real, verified, and none of them are worked around by faking data.

- **Options data is the free `indicative` feed.** This account has no signed OPRA agreement
  (`403 "OPRA agreement is not signed"`), so quotes are modified and trades delayed.
- **No VIX.** Alpaca index data returns `403 "insufficient grants"` on this plan. VolGuard
  computes its own ATM IV term structure from the chain instead.
- **Open interest is frequently `null`** from Alpaca, so it is an advisory check only.
  Liquidity gating uses quote size and relative spread, which are always present.
- **No P&L backtest.** Measured, not assumed: a historical option bar carries trade OHLC
  only — no bid, no ask, no greeks, no implied volatility — and expired contracts return no
  data at all, so there is neither an entry signal nor a known outcome to score it against.
  The probe and the full reasoning are in `docs/evidence/backtest-feasibility.md`
  (`node --env-file=.env.local scripts/probe-option-history.mjs`). No simulated P&L is
  claimed anywhere. The volatility *forecast* is a different matter: it is validated walk-forward,
  strictly out of sample, and the evidence is committed (`npm run backtest`,
  `docs/evidence/forecast-validation.md`). Reported P&L comes only from the live paper account via
  Alpaca portfolio history and fill activities. There are no simulated results anywhere.
- **Paper fills are optimistic.** Alpaca paper fills do not model real queue position, so
  live slippage would be worse than shown. The one live paper fill so far came in $0.05
  *better* than the limit, which is exactly the kind of optimism not to extrapolate from.
- **No track record.** One filled paper spread is not performance. The account is days old.
- **Serverless history is per-instance.** With no external store configured, the ledger lives
  in `/tmp` for the life of the instance and resets on a cold start. The System panel says
  which. Set `VOLGUARD_STORE_PATH` to a persistent volume, or run it on a host with a disk.
- **The run lock is process-local.** It does not prevent two serverless instances running
  concurrently; the deterministic client order ID is what actually stops a duplicate order
  reaching Alpaca.
- **Implied-vol rank needs 20 trading days** of self-collected observations, so on a fresh
  deployment it shows a sample count rather than a percentile — and on ephemeral storage it
  may never reach the threshold at all.
- **The MCP bridge spawns `uvx`** and cannot run on serverless. It degrades to "not probed"
  rather than failing the run. The REST adapter is the execution path in every environment.
- **Rate limiting is process-local.** In memory, so across several serverless instances the
  effective limit is the configured limit times the instance count. It bounds accidental
  hammering and API usage; it is not, and is not used as, an authorization control.
- **Most E2E tests touch the live Alpaca API.** Every page load fetches `/api/dashboard`,
  which reads the account, clock, positions and portfolio history, so the browser suite would
  fail during an Alpaca outage. The unit suite is fully hermetic; `npm run backtest` is
  deliberately a script rather than a test so no network dependency enters `npm test`.

## Safety

Paper URL is enforced at the adapter — the client refuses to call a non-paper host at all,
even for a read. Account ID is verified before execution. The kill switch blocks every
execution path. Secrets are server-side only and never reach the browser (asserted in E2E).
`.env.local` is gitignored. Order submission is idempotent by deterministic client order ID.
MCP is restricted to an allow-list of read-only tools and refuses anything else.

## License

MIT.
