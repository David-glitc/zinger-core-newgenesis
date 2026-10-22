# Proposal: 24-hour reward-band paper run (for review, not started)

Date: 20 October 2026 (updated after the resting-quote work). Status: **proposal only**. No capture has been started, and no plan file has been declared. Paper only: zero orders, zero spend.

## Hypothesis

Minimum-size two-sided quotes, refreshed on book updates by the full runner, in long-dated non-sports markets with deep queues, earn maker rewards that exceed adverse selection on the fills they get.

This is a learning run, not an income test. Even if it works, the projected reward is small (see below).

## What is ready

| Component | Status |
|---|---|
| Reward accrual in `scripts/paper-mm.ts` | Added. Samples once a minute; quadratic score within the band; two-sided rule (smaller side counts); orders below the reward minimum score zero; outcome-0 book only, so mirrored books are not double counted. Reported as `projectedRewards`, never credited to cash. |
| Reward-sized quoting (`--reward-sized=true`) | Added. Quotes each market at its reward minimum; markets whose minimum exceeds `--max-order-shares` are not quoted (`reward_min_size_above_cap`). |
| Universe builder `scripts/mm-reward-universe.mts` | Added. Reward-paying, non-negative-risk, non-sports, ending at least 7 days out, midpoint 0.10–0.90, reward minimum ≤ 200 shares, in-band competition ≥ 10,000 per side, one market per event. |
| Hardened harness | Lock, startup deadline, data watchdog, hard stop, book coverage (see `docs/MM_RESET_2026-10-20.md`). |

## Current universe (built 20 Oct)

600 markets scanned. 7 qualified: Israel × Iran ceasefire (Oct 31), Russia × Ukraine ceasefire 2026, Anthropic bankruptcy by 2028, Indiana data-center moratorium, Strait of Hormuz traffic, U.S. invades Iran before 2027, and Bab el-Mandeb closure.

| Projection at minimum size | Value |
|---|---|
| Projected reward, all 7 markets | about $0.86/day |
| Capital resting at minimum size (both sides) | about $1,060 |
| Reward rate | about 0.08% of resting capital per day |

The universe should be rebuilt immediately before the run.

## Book freshness and resting quotes (implemented 20 Oct)

The first smoke test found books stale 72% of the time and 970 placements blocked, because freshness required a REST re-check every second per book. Two changes are now in the runner, both opt-in:

| Change | Flag | Behaviour |
|---|---|---|
| Resting quotes with churn tolerance | `--expiry-policy=resting-tolerance-v1 --rest-tolerance-ticks=1` | An order keeps its id and queue position while the new target is within 1 tick and the order does not cross the book. It is cancelled when the target moves further, the strategy drops that side, the book would be crossed, risk is no longer valid, or the market's quote deadline arrives. No 10-second client expiry. |
| Connection-health freshness | `--book-freshness=connection-health` | A book is fresh while its websocket is open and has answered within 1.5 s (heartbeat every second), the book is structurally sound, and a REST snapshot arrived within 30 s (seeded every 10 s with a normal read timeout). Replaces the per-second REST check. |

Tests: 6 new unit tests for resting quotes (`tests/unit/mmRestingQuotes.test.ts`); full unit suite 701 passed across 81 files. The independent auditor (`scripts/audit-mm-paper.py`) still accepts only the two older expiry policies and must be updated before an audited run.

### Smoke tests on the 7-market universe (5 minutes each)

| Run | Stale share | Placed / kept | Markets scoring rewards |
|---|---|---|---|
| Before (1.5 s REST rule, 10 s expiry) | 72% | 38 placed | 1 of 7 |
| Resting + connection-health, final | 3–11% | 34 placed, 2,778 kept | 7 of 7 |

The last two smoke runs differed mainly through network reconnects (8 and 10). Zero fills in both, as expected over five minutes.

One parameter matters: the runner's cash floor is bankroll minus `--max-cash-loss-usd`. Funding a 200-share split moves about $200 of cash into inventory, so a $250 limit allows only one market. With $2,500, all 7 markets quote. Losses are still capped separately by the −5% liquidation stop.

Measured reward shares in the final smoke test imply about **$0.70/day** across the 7 markets, consistent with the universe projection.

## Proposed run parameters

| Setting | Value |
|---|---|
| Duration | 24 hours, one capture, alone under the lock |
| Bankroll (paper) | $5,000 |
| Universe | `mm-reward-universe` rebuilt at start; discovery `file` |
| Quote pricing | `touch` (no inside-spread improvement) |
| Size | `--reward-sized=true`, `--max-order-shares=200` |
| Caps | net 400 shares; $250 per market; $500 per event; $2,500 portfolio; `--max-cash-loss-usd=2500` (cash deployment); liquidation stop at −$250 (5%) |
| Fill rule | `exact-price` (qualifying rule) |
| Quotes | `resting-tolerance-v1`, 1-tick tolerance; cancel and activation latency 250 ms |
| Book freshness | `connection-health` |
| Inventory | split (charged $0.01 per split/merge) |
| Event cutoff | 10 minutes before each market's end |

## What will be reported

- Projected reward accrued, per market and total, with eligible-sample counts.
- Fills, notional, 60-second and 10-minute markouts, adverse-fill share.
- Realised, mid-marked and liquidation P/L; fees; net = liquidation P/L + projected reward, labelled as projection.
- Book coverage (stale share), error counts, reconnects, and any watchdog events.

## Stop rules

- Liquidation P/L at or below −$250 (5% of bankroll): stop.
- Watchdog failure (no market data, stall, hard deadline): the run fails; no restart within the same plan.
- Stale share above 25% after the first hour: report it as a coverage failure rather than a result.

## Before starting

- Update the independent auditor to accept `resting-tolerance-v1` and `connection-health`, with checks that a kept order never crosses the book and never outlives its quote deadline.
- Rebuild the universe and declare the plan with source hashes immediately before the capture.

## Pass and fail

- **Pass (worth a second run):** at least 20 fills, mean 10-minute markout ≥ 0, and net (liquidation P/L plus projected reward) ≥ 0, with stale share under 25%.
- **Fail:** fewer than 20 fills, or net below zero. Either way the result is one window, so it cannot qualify an edge on its own.

## Not in scope

Real orders, wallets or deposits; larger sizes; the price-through rule; parallel captures.
