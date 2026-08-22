# Final Submission Checklist

Status as of 2026-08-19. Event opens 28 Aug 2026; deadline **4 Sept 2026, 15:00 UTC**.

## Product — done

- [x] Autonomous agent loop with scheduled entry point, run lock, timeout, retries.
- [x] Options-first strategy: variance risk premium against jump-robust realized vol.
- [x] Real implied volatility, greeks, term structure and skew from Alpaca chain snapshots.
- [x] Jump-contamination gate (bipower variation).
- [x] Event-risk taxonomy over Alpaca news + corporate actions.
- [x] Delta-targeted defined-risk debit spread selection with candidate search.
- [x] 26-gate deterministic risk engine, every configured limit enforced.
- [x] Position monitoring and exits (profit target, stop, time stop).
- [x] Paper-only enforcement at the adapter; account-ID verification; kill switch.
- [x] Idempotent orders by deterministic client order ID.
- [x] Append-only audit ledger.
- [x] Performance sourced only from Alpaca portfolio history + fill activities.
- [x] Judge-facing dashboard with per-metric provenance.

## Alpaca — done

- [x] Trading API adapter with retry/backoff.
- [x] Account, clock, calendar, positions, orders, activities, portfolio history.
- [x] Stock snapshot + daily bars (with the `start`/`limit` pitfalls handled).
- [x] News and corporate actions.
- [x] Option contracts and chain snapshots (greeks + IV).
- [x] Multi-leg (`mleg`) order payload, validated against Alpaca's 422 leg rules.
- [x] Official MCP server: 74 tools discovered, real read-only calls, evidenced in ledger.
- [x] MCP restricted to a read-only allow-list; write tools refused.

## Quality — verified 2026-08-19

- [x] `npm run typecheck` — clean.
- [x] `npm run lint` — clean.
- [x] `npm test` — 171 passed.
- [x] `npm run build` — succeeds.
- [x] `npm run test:e2e` — 9 passed.
- [x] `npm audit` — 0 vulnerabilities (Next upgraded 15 → 16.3.1 to clear 3 high transitive advisories in postcss/sharp).
- [x] No secrets committed; `.env.local` gitignored and untracked.
- [x] No fabricated market data, P&L, or screenshots anywhere.

## Blocked on the operator

- [ ] **Create a fresh, dedicated Alpaca paper account.** The dev account is NOT eligible —
      lablab requires a brand-new account or the project is disqualified from judging.
- [ ] Put the new keys + account ID in `.env.local` / deployment env.
- [ ] Fund the Anthropic account (currently `400: credit balance is too low`), or accept the
      labelled rules-engine thesis for the demo.
- [ ] Run at least one controlled paper order on the fresh account and record the order ID.
      (Done on the DEV account: order `6231e8dd-3198-4b55-973b-d98c1f483d52`, filled 1 lot
      @ $5.65, idempotency re-verified. Must be repeated on the judging account.)
- [ ] Re-verify the official lablab page wording (SPA — see RESEARCH.md §1 caveat), in
      particular whether "Social Engagement" is a scored criterion.

## External actions requiring explicit approval

- [ ] Publish the GitHub repository.
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
- [ ] Cover image — prompt in `docs/SUBMISSION_COPY.md`.
- [ ] Public GitHub repository URL.
- [ ] Demo application URL.
- [ ] Video presentation URL.
- [ ] Slide presentation URL.
- [ ] Fresh Alpaca paper account ID.
- [ ] Up to five X/LinkedIn post URLs.
