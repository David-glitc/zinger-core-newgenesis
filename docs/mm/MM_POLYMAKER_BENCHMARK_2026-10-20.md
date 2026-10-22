# Zinger vs poly-maker: paper benchmark (20 October 2026)

Paper only, zero orders, no keys. Same 7 reward markets (`mm-reward-universe-2026-10-20.json`), same hour (07:45–08:45 UTC).

- **Zinger:** `scripts/paper-mm.ts` with resting quotes (1-tick tolerance), connection-health freshness, reward-sized orders, quoting at the touch. Evidence: `tmp/commercial-evidence/mm-bench-polymaker-20261020/`.
- **poly-maker:** commit `4f32103`, `run --paper`, profile `zinger-bench` (a copy of its `romania-pm` profile, the minimum-reward-size setup). Clone and logs: `~/polymaker-bench/`. Its Anthropic market did not resolve by slug, so it quoted 6 of 7 live.
- **Replay:** `~/polymaker-bench/harness/replay_zinger.py` feeds Zinger's recorded websocket messages through poly-maker's own parser, order books, estimators, regime machine, `construct_quotes` and `reconcile`, tracking its live orders. Output: `harness/bench-replay.json`.

## Results

| Measure | Zinger (paper run) | poly-maker (replay on Zinger's feed) |
|---|---|---|
| Orders placed / cancelled in the hour | 280 / 265 (plus 47,004 keeps) | 56 / 42 |
| Main cancel reason | strategy dropped a side (`no_target`) | target moved beyond 2 ticks or size beyond 20% |
| YES bid distance from mid (median) | at the touch (about 0.5 tick on 1-tick spreads) | 1.5 ticks (0.5 on one market) |
| Order size vs reward minimum | exactly the minimum on both sides | YES at or above the minimum; NO about 13 shares (replay) or 26 (live) in 4–5 markets where the minimum is 200 |
| Markets two-sided reward-eligible | 7 of 7 (52–59 of 59 samples each) | 2 of 7 (Israel × Iran 95%, Bab el-Mandeb 100%) |
| Projected reward | $0.033 for the hour (≈ $0.80/day) | not computed |
| Regimes | not modelled | mostly QUIET, 2–7% TRENDING; no EVENT pulls |
| Fills | 1 | none possible in paper mode |
| Stale books | 0.7% of market-seconds | n/a (connection-gated) |

## What this shows

- **Zinger churns more.** It placed 5× as many orders. Almost all its cancellations come from its own strategy briefly returning no quote for a side (history gaps or a missing fair value), not from price moves. poly-maker holds through such moments because its reconcile keeps orders within 2 ticks and 20% size.
- **poly-maker's copied profile under-sizes the NO side.** In markets priced around 0.15, the NO bid sits near 0.85 and is sized from a dollar budget, so it lands at about 13–26 shares against a 200-share reward minimum. Under the two-sided rule those markets score nothing. This is a profile setting, not a flaw in its design; a fair comparison needs `base_size_usdc` raised to roughly 200 × 0.85 ≈ $170 per side.
- **Placement differs.** Zinger quotes at the touch, which maximises reward score but takes more fill risk. poly-maker sits 1.5 ticks back.
- **Neither result is P/L.** poly-maker's paper mode never fills, and Zinger had one fill in the hour. Both systems' reward figures use a two-sided rule; Polymarket also scores single-sided quotes at one third when the midpoint is between 0.10 and 0.90, which this benchmark does not count.

## poly-maker paper-mode caveat

Paper mode does not record its own orders as live, so every requote places again: about 2 "placements" per requote, roughly 1,600 in the hour. Churn must be read from the replay, which tracks live orders.

## Candidate changes for Zinger

1. Keep resting orders through short strategy gaps (for example, require two consecutive no-target cycles or a few seconds before cancelling), as poly-maker's reconcile effectively does.
2. Add a 20% size tolerance alongside the 1-tick price tolerance.
3. Test placement 1–1.5 ticks back from the touch against the touch, for reward score against fill risk.
4. Add single-sided reward scoring (one third) to both projections, so they match Polymarket's published rule.
