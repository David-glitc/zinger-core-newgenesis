# Polymarket market-making research: where it stands and where to go next

Paper trading and public data only. Nothing here places live orders or spends funds.

## What is in this branch

| Area | Files |
|---|---|
| Strategy, paper session, inventory, recovery, journal | `src/research/mm/*`, `src/research/bookArbitrage.ts`, `src/research/depthState.ts` |
| Paper runner (resting quotes, connection-health freshness, reward accrual, caps, watchdogs, single-run lock) | `scripts/paper-mm.ts` |
| Reward-market scan, triage, universe, 24 h projection recorder | `scripts/mm-reward-{scan,triage,universe,projection}.mts` |
| Offline parameter sweep, walk-forward and capital simulation | `scripts/mm_param_optimiser.py`, `scripts/mm_walkforward_capital.py` |
| Independent auditors | `scripts/audit-mm-*.py`, `scripts/mm_*_audit.py` |
| Charts | `scripts/plot_*.py`, `scripts/build_mm_*.py` |
| Tests (227) | `tests/unit/mm*.test.ts`, `tests/unit/researchDepth.test.ts` |
| Reports | `docs/reports/ZINGER_MM_REPORT_2026-10-22.pdf` (positives first), `..._2026-10-21.pdf` (full 24 h + capital simulation), LaTeX sources in `docs/reports/latex/` |
| Design notes and run logs | `docs/mm/MM_*.md` |

## Results so far (24 h recording, 80 reward markets, split into train and test halves)

What worked:
- Reward qualification: our quotes were eligible for rewards in 7 of 7 markets; poly-maker managed 2 of 7 on the same data (`MM_POLYMAKER_BENCHMARK_2026-10-20.md`).
- Quote freshness: stale time fell from 72% to 0.7% after adding resting quotes and connection-health freshness.
- Positive markets: 29 of 40 liquid markets were positive on the test half, +$44.61/day on $9,874. These were selected after the fact.
- Spread of results: the median market made +$0.53/day. Settings with fewer than 0.5 fills/day were positive in 95% of markets.
- Small budgets: $100 to $1,000 allocations were positive in the capital simulation, but they rest on only 2 to 9 markets.

What did not:
- The liquid portfolio on the test half lost $42.44/day (−0.33%/day) on $12,975. Three markets with sharp price moves lost $71.44; the other 37 together made $29.00.
- A single setting applied to every market was negative at every quote distance.
- Thin-book markets lost 2.77%/day.
- Budgets of $2,500 and above were negative in the capital simulation.

There is no portfolio-level edge yet. There is a reward-capture edge, but adverse fills on sharp moves eat it.

## Directions (in order)

1. **Jump/news filter.** Pull quotes when the midpoint moves more than a set number of ticks inside a short window, or the touch empties. Rerun `mm_walkforward_capital.py` on the same split. Pass bar: the test-half portfolio is ≥ 0 with no single market below −$10/day.
2. **Multi-day out-of-sample test.** Record at least three more 24 h days with `mm-reward-projection.mts` and choose settings on day N, then test them on day N+1. One day is not enough to choose markets.
3. **Market selection rule set before testing.** Turn the low-interaction finding (under 0.5 fills/day) and the thin-book floor (competition ≥ 10,000) into a fixed filter, chosen before any test data is seen.
4. **Two-outcome quoting.** Quote YES and NO bids (and merge pairs), as poly-maker does, and model single-sided scoring at 1/3 when the midpoint is between 0.1 and 0.9.
5. **Auditor update.** Teach `audit-mm-paper.py` the `resting-tolerance-v1` expiry policy and `connection-health` freshness.
6. **Forward paper run.** Only after 1 to 3 pass: a predeclared paper run (plan created before capture) with a $1,000 baseline, then $5,000.

Real capital stays conditional on a positive multi-day out-of-sample portfolio result. The risks are set out in the 2026-10-22 report.

## Reproduce

```bash
npx tsx scripts/mm-reward-scan.mts
npx tsx scripts/mm-reward-projection.mts --universe=<universe.json>
python3 scripts/mm_param_optimiser.py <run-dir> <universe.json>   # run on train-half and test-half dirs
python3 scripts/mm_walkforward_capital.py <dir-with-train-and-test> <run-dir>
npx vitest run tests/unit/mm*.test.ts
```
