# Stub reward projection (paper, public data only)

## Purpose
Measure how much a passive maker could earn from Polymarket liquidity rewards, using live public order books and simulated resting quotes. The tool never sends an order, signs anything, or touches a wallet. It only issues GET requests to the public Gamma and CLOB endpoints.

It does not prove real payouts. Rewards go only to orders actually resting on the venue, so this is a projection to be tested, not a yield.

## Files
- `scripts/mm-reward-triage.mts`: one-shot read-only triage. Ranks reward-enabled markets by estimated share.
- `scripts/mm-reward-projection.mts`: stub runner. Samples books each minute, places simulated quotes at best bid and ask, scores them with the reward formula, and records projected reward per sample.
- Output: `tmp/commercial-evidence/mm-reward-projection/<run-id>/` containing `samples.jsonl`, `markets.json`, and `summary.json`.

## Method
1. Select open markets with `clobRewards` set, `rewardsMaxSpread > 0`, and an end date in the future. Take the top N by 24h volume.
2. Each sample: fetch both token books. Quote minSize shares at the best bid and at the best ask. Record the quotes locally; nothing is sent.
3. Score (per docs): `score = ((v - s) / v)^2 * size`, where `v` is the band (`rewardsMaxSpread`, converted from cents) and `s` is distance from midpoint. Bids and asks are summed separately; the smaller side counts (two-sided rule).
4. Share = our score / (our score + competing score in band), per side; the reported share is the minimum across sides.
5. Projected USD per sample = share × daily pool / 1440.

## Units
- `rewardsMaxSpread` is in cents. The runners divide by 100 to get price units. Triage and projection use the same convention.
- `minSize` is `rewardsMinSize` from Gamma, default 5 if absent.

## Results so far
| Run | Date (UTC) | Markets | Samples | Result |
|---|---|---|---|---|
| Triage snapshot | 2026-10-18 20:02 | 98 rewarded | 1 book per market | Estimated shares near 100% for some markets. **Withdrawn as an overstatement.** |
| Stub test | 2026-10-18 21:06 | 5 | 3 each (15) | Mean share 0.046–0.107% per market; about $0.03–0.46/day per market |
| Stub 60-minute run | 2026-10-18 21:07 | 8 | 60 each (480 total) | Complete. Projected reward $1.34/day across 8 markets; shares 0.03–0.27% |
| Markout test | 2026-10-18 22:35 | 4 | 3 min | Code path verified; 0 fills (too short) |
| 24-hour run | 2026-10-18 22:36 | 8 | 1,440 target | In progress; `run-24h.log` and its output directory |

The triage's near-100% figures came from a single snapshot in which competing score was near zero. Repeated sampling shows that competing size inside the band is large, so the earlier headline ($8,752/day) should not be used.

## Fills and markouts (added 2026-10-18)
- A stub quote is filled only by a public taker trade at its exact price on the opposite side, after the displayed queue at that price has been cleared. The queue is the book size at our price at placement, consumed by matching trades first.
- Each fill is marked against the midpoint `markoutMs` later (default 60 s). Markout P/L per share is favourable when positive. Adverse fills are those with negative markout.
- Output: `fills.jsonl` (raw), `fills_marked.json` (with markouts), and `summary.json` (fills, adverse count, markout P/L, reward projection).
- Limit: the trade feed returns up to 100 rows per request. Busy minutes hit that cap (logged as `trade_page_truncated`), so fills can be undercounted there. Undercounting understates both fill income and adverse selection.
- Still not modelled: fee on fills, partial queue loss on cancel, inventory mark-to-market beyond the markout.

## Snapshot bug in runs before 20 October (fixed)

Polymarket's book endpoint lists bids from the lowest price up and asks from the highest down. Runs before 20 October saved the first five levels of each side, which are the levels furthest from the touch, so their `snapshots.jsonl` cannot be used to re-score placements inside the reward band. Their `samples.jsonl` (best bid and ask via max and min, competition over all levels) are unaffected. From 20 October the recorder saves every level within twice the reward band of the midpoint, and takes books from the batch `/books` endpoint.

## Wider universe (20 October)

`scripts/mm-reward-scan.mts` reads every reward-eligible market from the CLOB `sampling-markets` endpoint (14,272 markets, about $155,000 per day in combined pools on 20 October), fetches books in batches, and ranks candidates by projected reward per $100. `--universe=<file>` makes the recorder use that list. The recording started 20 October 18:40 UTC covers 40 non-thin and 40 thin-book markets for 24 hours.

## Limitations
- Competitor orders are read from the public book only. Hidden or off-book makers and Polymarket's own sampling are unknown.
- Competing size can change within a minute, and Polymarket samples on its own schedule; per-minute projections are approximations.
- The reward formula is taken from Polymarket's docs. Actual per-market parameters can differ; check the live settings.
- No fills, adverse selection, or inventory are modelled here. Reward income can be positive while quotes lose money on fills.
- Eligibility: the readiness doc's region and account checks apply before any real order. This host's geoblock check failed earlier, so eligibility is unverified.

## Acceptance for a validation claim
At least 24 hours of minute samples across several markets, with the projected daily reward within a stated tolerance of the sampled one. Shorter runs are probes.

## Not done
- Real orders, wallet use, or any CLOB write. Out of scope without a separate approval and the readiness gates.
- Adverse-selection and fill modelling.
- Automated scheduling of repeat runs.
