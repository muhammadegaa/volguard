# Final Submission Checklist

Status as of **6 Sept 2026**. Event deadline was 4 Sept 2026, 15:00 UTC — see
"Timing" at the bottom.

## Product — done

- [x] Autonomous agent loop with scheduled entry point, run lock, authoritative timeout, retries.
- [x] Options-first strategy: variance risk premium against a horizon-matched realized-vol forecast.
- [x] Real implied volatility, greeks, term structure and skew from Alpaca chain snapshots.
- [x] Jump-contamination gate (bipower variation).
- [x] Event-risk taxonomy over Alpaca news + corporate actions.
- [x] Delta-targeted defined-risk vertical selection — debit when premium is cheap, credit
      when it is rich, both with maximum loss known before the order exists.
- [x] 30-check deterministic risk engine, 27 of them blocking; every configured limit enforced.
- [x] Portfolio allocator: one budget spent down the ranked candidates, carrying the daily
      loss budget, the open position count and the open risk, so the portfolio limits bind
      rather than being passed N times over.
- [x] Position monitoring and exits (profit target, stop, time stop), closed as whole spreads
      in one multi-leg order so a fill can never leave a naked short.
- [x] Paper-only enforcement at the adapter; account-ID verification; kill switch.
- [x] Settings validated on read — a malformed, out-of-range or self-contradictory limit
      refuses the run and names the variable rather than falling back to a default.
- [x] Idempotent orders by deterministic client order ID.
- [x] Append-only audit ledger, preserved across the error path.
- [x] Performance sourced only from Alpaca portfolio history + fill activities.
- [x] Judge-facing dashboard with per-metric provenance, in a Guided and a Pro view; every
      scanned symbol opens its own spread, thesis and gates.
- [x] Horizon-matched HAR-RV volatility forecast, validated walk-forward (`npm run backtest`).
- [x] Universe screened on measured options liquidity, not name recognition.
- [x] Option chain paginated so the targeted expiry is actually reachable.
- [x] Deployable: fail-soft storage, serverless-writable ledger path, honest durability reporting.

## Alpaca — done

- [x] Trading API adapter with retry/backoff.
- [x] Account, clock, calendar, positions, orders, activities, portfolio history.
- [x] Stock snapshot + daily bars (with the `start`/`limit` pitfalls handled).
- [x] News and corporate actions.
- [x] Option contracts and chain snapshots (greeks + IV).
- [x] Multi-leg (`mleg`) order payload, validated against Alpaca's 422 leg rules, used for
      both entries and grouped exits.
- [x] Official MCP server: 74 tools discovered, real read-only calls, evidenced in ledger.
- [x] MCP restricted to a read-only allow-list; write tools refused.

## Quality — verified 6 Sept 2026

- [x] `npm run typecheck` — clean.
- [x] `npm run lint` — clean.
- [x] `npm test` — 308 passed across 15 files.
- [x] `npm run build` — succeeds.
- [x] `npm run test:e2e` — 36 tests, 0 failed (some skip when the market is closed and the
      live scan legitimately has nothing to assert on).
- [x] `npm audit` — 0 vulnerabilities (Next upgraded 15 → 16.3.1 to clear 3 high transitive
      advisories in postcss/sharp).
- [x] No secrets committed; `.env.local` gitignored and untracked.
- [x] No fabricated market data, P&L, screenshots or account results anywhere.

## Deliberately not shipped

- [ ] **Trade-level backtest.** Not deferred — measured as impossible on this data and
      documented in `docs/evidence/backtest-feasibility.md`, reproducible with
      `scripts/probe-option-history.mjs`. Historical option bars carry trade OHLC only (no
      bid, ask, greeks or implied volatility) and expired contracts return no data at all, so
      there is neither an entry signal nor a known outcome to score it against. The
      volatility *forecast* is validated walk-forward, which is the part of the edge daily
      bars can honestly test.

## Blocked on the operator

- [ ] Confirm whether a fresh, dedicated Alpaca paper account is required. The rule was
      recorded from the lablab page in `RESEARCH.md` §1, which is a SPA and was read once;
      it has not been re-checked and the current dev account is not a fresh one.
- [ ] If it is required: create it, put the new keys + account ID in `.env.local` and the
      deployment env, and repeat a controlled paper order on it.
      (Done on the DEV account: order `6231e8dd-3198-4b55-973b-d98c1f483d52`, filled 1 lot
      @ $5.65, idempotency re-verified.)
- [ ] Fund the Anthropic account, or accept the labelled rules-engine thesis for the demo.
      Every model failure already degrades to `rules_fallback` rather than blocking a run.
- [ ] Verify Alpaca's sign convention for a net-credit multi-leg `limit_price` with one
      controlled probe, then set `VOLGUARD_SELL_PREMIUM_ENABLED=true`. Until then the agent
      is buy-only by configuration.

## External actions requiring explicit approval

- [x] Publish the GitHub repository — <https://github.com/muhammadegaa/volguard>.
- [ ] Deploy to Vercel (set env vars + `CRON_SECRET`; note MCP needs a container host).
- [ ] Record and upload the video.
- [ ] Publish slides.
- [ ] Publish social posts.
- [ ] Submit the lablab entry.

## Submission fields

- [x] Title: **VolGuard**
- [x] Tagline: *Buy movement only when it's cheap.*
- [x] Short + long description — see `docs/SUBMISSION_COPY.md`.
- [x] Track: Volatility trading (options).
- [x] Tags: AI Agents · Algorithmic Trading · Options Trading · FinTech · Alpaca · Next.js · TypeScript · Anthropic · MCP
- [x] Public GitHub repository URL — <https://github.com/muhammadegaa/volguard>.
- [ ] Cover image — prompt in `docs/SUBMISSION_COPY.md`.
- [ ] Demo application URL.
- [ ] Video presentation URL.
- [ ] Slide presentation URL.
- [ ] Alpaca paper account ID for judging.
- [ ] Up to five X/LinkedIn post URLs.

## Timing

The deadline recorded in `RESEARCH.md` §1 is **4 Sept 2026, 15:00 UTC**, which has passed.
Nothing in this repository depends on that date — the agent, the evidence and the dashboard
stand on their own — but the submission fields above cannot be completed against a closed
entry. Re-check the event page before spending time on the video, slides and social posts.
