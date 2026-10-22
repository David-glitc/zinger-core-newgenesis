# Execution repair and forward paper experiment - 2026-10-16

Verdict: several execution and accounting defects have been repaired in the candidate source, but no profitable MM edge is established. The existing Core backend is preserved. A new authenticated read-only monitor and reviewed frontend now show the separate MM experiment on the existing domain, with $1,000 simulated capital and zero real orders.

The complete current finding disposition is in [Architecture status](ARCHITECTURE_STATUS_2026-10-16.md). This supplements [the architecture audit](ARCHITECTURE_AUDIT_2026-10-16.md) and [the results audit](RESULTS_AUDIT_2026-10-16.md). Those documents describe the original evidence; no original trade, balance, or journal was rewritten.

Complementary matching, its independent audit, and the isolated candidate runtime are tracked in [Conservative CTF matching](MM_CTF_MATCHING_2026-10-16.md). Captures 04 and 05 are complete and preserved. Current live blockers and collateral checks are tracked in [MM live readiness](MM_LIVE_READINESS_2026-10-16.md).

The next tested candidate addresses lost queue priority, legal partial-order remainders and stale-at-placement quotes; see [Quote lifecycle repair](MM_QUOTE_LIFECYCLE_2026-10-16.md). It was not loaded into phase 05. After subsequent live-readiness geoblock fixes, the full unit suite passes 695 tests in 80 files and backend typechecks pass. The source-only candidate archive is `placement-freshness-candidate-02`; it is not a deployed runtime or performance result.

## Verified results

| Experiment | Result | Interpretation |
| --- | --- | --- |
| Original combined 24-hour session | $2,000 -> $1,905.48; -$94.52 | Failed performance; directional -$105.63, reverse-arb +$11.11, MM zero fills |
| Original final combined audit | Failed by $3.78 | Exported reverse-arbitrage legs omitted fees already charged to cash |
| Deep-book candidate smoke, 5 minutes | 226 quotes, 60 BUY / 166 SELL, zero fills | Accounting passed; execution coverage failed |
| Journal repair smoke, 3 minutes | 220 quotes, 102 BUY / 118 SELL, zero fills; -$0.08 | 58,202 records independently audited; four charged splits and four merges; no execution edge |
| Forward capture 01 | Failed on evidence backpressure; incomplete gzip | Retained as failed; excluded from comparison and performance claims |
| Forward capture 02 | Failed after about 12 minutes at the gzip memory cap; 770 quotes, one hypothetical fill | Complete 279,990-record journal; forensic accounting/risk reconciliation succeeded; the run remains failed and final valuation unavailable |
| Forward capture 03, 30 minutes | Completed: 2,447 quotes, three hypothetical SELL fills, zero BUY fills; cash $993.69984168 and three holdings | 610,088-row accounting/risk audit passed; final portfolio valuation unavailable |
| Continuation 04, one hour | Completed; nine raw receipts, eight material, one numerical artifact; cash $986.56920568; cumulative midpoint P/L -$1.97079364 | Complete 2,151,435-row accounting/risk audit passed; full liquidation unverified |
| Continuation 05, one hour | Completed 10:45:53-11:45:53 UTC; 9,076 quotes and 16 phase receipts, plus nine inherited; midpoint P/L -$9.4697; final liquidation unavailable | Original audit failed: one quote was placed on a 1,527ms-old book with a 1,500ms limit. Six labeled post-capture diagnostics were later audited: four passed journal/risk/depth checks, two failed REST confirmation provenance; all lack verified liquidation and actual execution. Performance remains unqualified. |

Capture 02 started at 08:05:56.983 UTC and failed before its scheduled end. Its diagnostic audit is explicitly `reconciled_failed_run`, saved to `failed-accounting-audit.json`; it cannot substitute for a passing session audit. Cash alone is not portfolio P/L.

Capture 03 completed its scheduled 08:25:58.174-08:55:58.174 UTC window. Its initial data, fixed parameter plan, complete journal and final report are preserved. The independent audit passed cash, holdings and risk checks but could not verify final valuation: two closing confirmations were just outside the 1,500ms freshness limit. The later continuation explicitly refreshes closing snapshots, preserves exchange clocks, and rejects unsupported full-exit quantities. Missing marks remain null.

Continuation 04 restores the same original $1,000 account from $993.69984168 cash and three holdings, copies the ancestor journal with its original sequence/timestamps, and records the prefix hash and recovery gap. It is not another $1,000 deposit. It prospectively tests the combined ask-price reserve, retained working inventory, conservative cash-spending guard and final-exit checks. Its seven completion checks passed; full liquidation remained unavailable.

The first hypothetical fill was an owned five-share ask at $0.06, inferred from an identified public BUY print at $0.07. This uses the explicitly declared price-through assumption. It is not an exchange fill. Public RPC and explorer receipt reads returned HTTP 403, so that settlement was not independently verified.

## Candidate changes and remaining limits

| Boundary | Implemented and tested | Remaining qualification |
| --- | --- | --- |
| Reverse-arbitrage accounting | Fee-complete leg receipts with exact cent allocation; cash drift rejects unexplained differences | Old incomplete exports remain failed; live/non-atomic execution unqualified |
| Core entry sizing | Certainty no longer bypasses the ordinary cap; final debit includes fees; minimum-order inflation rejects | Fee-aware sizing could fit a smaller valid order instead of rejecting; live reconciliation remains separate |
| Core concurrent entries | Stable intent deduplication and serialized capacity checks; final paper policy recheck after async reads; live mode/token checks | Process-local only; durable intent recovery and cross-document transactions remain open |
| Operator stop | Fixed price-relative stop survives heuristic and adaptive overlays | Not a net-liquidation-loss trigger; a stop does not guarantee a realized loss ceiling |
| Paper spending boundary | Swap, deposit, merge and legacy launch/sell adapters reject paper-only execution before wallet/network access | Paper server still constructs legacy account components; capability removal is unfinished |
| MM universe | Public recent tape plus metadata and actual two-sided depth; explicit fee/lifecycle/identity checks; bounded refresh | Bounded venue coverage; negative-risk inventory excluded |
| MM inventory | Paid split enables owned asks; retained working reserve avoids merging/cancelling every partial cycle; release at retirement/end; charged merge and resolution handling | First forward qualification of the working-reserve fix is continuation 04; lifecycle timing/cost remain assumptions |
| MM cancellations | Exposure stays reserved until cancel acknowledgment; no overlapping replacements or self-crosses | True exchange priority and routing remain unobserved |
| MM receipt counts | Candidate suppresses sub-microshare subtraction residue; per-order threshold independently checked; legacy artifacts separately counted | Continuation 04 predates the fix and recorded one numerical-dust receipt; complete integer arithmetic remains open |
| MM directional exposure | Candidate now reserves worst-case fills across both outcome books, including pending cancels | Capture 02 started before this later fix; its archived actor remains unchanged and must pass the independent risk audit |
| MM freshness | Original exchange clocks retained; REST confirmation requires current uncached matching revision; per-token refresh prevents batch starvation | Some held inventory can still lack fresh marks; unavailable values stay null |
| Evidence | Bounded-memory disk-backed chunks; synced financial receipts/raw tail; stopped-producer recovery restores identical cash, holdings, IDs and counters; active producers and corrupt prefixes rejected | Recovery gaps invalidate performance claims; Core transaction/recovery remains open |
| Comparison | Predeclared touch/improve, exact/through, slower-latency variants; independent balances; archived strategy execution | Counterfactual flow cannot prove real execution; a small sample cannot qualify an edge |
| Adverse selection | Reporting-only 1s / 5s / 30s midpoint and fee/depth-aware executable markouts | Missing future observations remain missing; never feed future values into quotes |
| Independent auditor | Native print linkage, money movements, worst-case reservations, continuation prefix/cash, cash floor and independent native/REST final depth reconstruction | Real-data strict controls now verify final valuation and lose $0.60; candidate final valuation and true exchange execution remain unverified |
| Command Center | Deployed final-audit failure display, separate current MM trial, stale-mark handling and source identity | Existing Core backend remains its older build; new monitor never creates accounts or imports wallet/trading clients |
| Runtime transport | Missing `sseLine` import repaired | Authenticated compressed-stream integration coverage still needs expansion |

## Forward comparison contract

`forward-capture-02/experiment-plan.json` was written before capture. The five fixed variants are touch-exact, touch-through, improve-exact, improve-through, and improve-through-slower. Each is an independent $1,000 hypothetical account evaluated on the same captured input frames and identified native tape. Their balances must never be summed into one advertised portfolio.

Capture 03 has its own plan, source identities and unchanged parameter values. A later workspace fix retains a complete-set reserve when improving both asks: capture 02 contained 146 of 1,313 two-ask decisions at a combined price of $1.00, which would not cover a newly split pair's assumed one-cent cost. This pricing fix was made after capture 03 started and is absent from its completed actor. Continuation 04 is the subsequent frozen forward test; it has not completed qualification.

Activation/cancel latency is 250ms, with 500ms for the slower variant; quote lifetime is 10 seconds. Limits are $100 portfolio, $10 market, $20 correlated event, five shares per order, and 20 net shares. Incentives are zero. Splits and merges each charge an assumed cent. These values are experiment inputs, not externally verified execution costs.

Promotion requires more than positive midpoint P/L: net executable liquidation, independent accounting/risk/valuation evidence, baseline comparisons, adverse-selection measurements, cost and latency stress, and enough completed round trips and independent market windows. The plan's screening targets are 30 completed round trips and ten independent market windows, with a positive clustered lower bound. Those targets have not been met. Portfolio Sharpe and performance eligibility remain unqualified.

The completion worker waits for capture termination, refuses failed captures, runs the independent audit, replays the predeclared variants, and independently audits every variant. The continuation-05 capture is terminal, but its original independent audit failed on a stale-at-placement quote, so the worker correctly refused the original comparisons. A separately planned post-capture correction replay was audited afterward; four of six pass the journal/risk/depth controls and two fail confirmation provenance. All six report missing final valuation and actual execution verification. The placement-time freshness fix is tested for a future candidate and does not rewrite the completed run. The worker cannot start a new account or spend funds. Core recovery remains incomplete.

## Validation

- Previous suite: 687 tests across 79 files, four performance tests, and backend/frontend typechecks passed after MM freshness work. After direct-region geoblock changes, the full unit suite passes 695 tests across 80 files and backend typechecks pass. Frontend code was not changed; its last production build/typecheck remains the earlier verified artifact.
- Performance suite: four tests passed.
- Backend and frontend typechecks passed; frontend production build passed, with existing large-bundle warnings.
- New comparison integration fixture verifies independent capital, strict versus price-through fills, midpoint profit versus executable liquidation loss, native print evidence, and rejection of future parameter plans or modified archived sources.
- A burst over 32 MB completes with bounded RAM, complete concatenated gzip output, and retained over-budget disk records. Live capture 03 initially kept disk backlog below 13 MB while recording over 265 MB of raw inputs.
- Final-valuation fixtures reject invented depth, missing source messages, stale books, unsupported confirmations and incorrect P/L, and independently charge taker fees and reject insufficient liquidation depth. A real-data prefix probe matched 3,346 decision books with zero mismatches across 110,464 scanned records; that probe was not a final session audit.
- Adversarial independent-audit fixtures reject reconciled but over-limit positions, overlapping orders and invented prints/prices.

These gates verify implementation behavior, not profitable trading. Capture 03 completion supervision finished all seven checks successfully. A second, separately preserved provenance-aware replay independently passed all five accounting/risk audits; strict touch/exact and improve/exact final valuations are verified at -$0.60188 each. The three price-through variants have unavailable final valuations, and the older slower control lacks a complete cancel observation tail. Continuation 04 passed all seven completion checks, including its five variant accounting/risk audits; full liquidation remains unverified. Continuation 05's original completion audit failed. Its post-capture diagnostics finished four passes and two depth-provenance failures, with no eligible performance claim.

## Evidence and commands

Evidence directory: `tmp/commercial-evidence/mm-execution-repair-20261016`.

```text
progress-snapshot.json
journal-fixed-smoke/report.json
journal-fixed-smoke/independent-audit.json
forward-capture-01/                 retained failure
forward-capture-02/                 retained failure and forensic accounting
forward-capture-03/report.json      completed 30-minute run
forward-capture-03/experiment-plan.json
forward-capture-03/completion-status.json
forward-capture-03/comparisons/     original derived comparison
forward-capture-03/comparisons-provenance-v2/  independently audited final-depth replay
forward-capture-03/flow-diagnostics-v1.json
continuation-04/report.json         current account continuation
continuation-04/opening-account.json
continuation-04/completion-status.json
unit-tests-dust-final.log
typecheck-dust-final.log
perf-tests-current.log
frontend-build.log
```

```bash
python3 scripts/audit-mm-paper.py CAPTURE_DIRECTORY
node --import tsx scripts/replay-mm-inputs.ts CAPTURE_DIRECTORY PREDECLARED_PLAN_JSON NEW_OUTPUT_DIRECTORY
```

Do not rerun a worker into an existing evidence directory or initialize a fresh bankroll to represent a resumed session. Capture 04 and earlier loaded archived-at-launch workspace modules. Continuation 05 and its completion worker instead execute from the isolated hash-verified runtime described in the CTF matching document. Later workspace fixes do not update that runtime or retroactively apply to its data. Immutable Core execution identity remains open.

## Still open before a trustworthy release

1. Core durable execution identities, transactional cash/position projections, and restart without fresh bankroll. MM has tested receipt recovery and an actual same-account continuation; gaps and producer supervision still need qualification.
2. Candidate legal final liquidation/settlement, shared complementary-match volume/priority, and latency/expiry semantics. Independent final-depth checks now pass on two losing real-data comparison controls.
3. Net-of-fee stop semantics, entry fee-aware sizing, and remaining Core read-side mutation.
4. ML causality, double-shifted labels, untrained confidence head, duplicate sigmoid and return-target defects. No current MM experiment uses those outputs.
5. Public account-route authorization, key-storage boundaries, immutable release identity and clean deployment qualification.
6. Continue verifying the deployed read-only monitor, expose inherited versus current-phase counters, and preserve the completed combined session. The main Core backend has not been upgraded.
7. Sufficient forward execution and stress evidence. No current result supports a profitable-strategy or live-performance claim.
