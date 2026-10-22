# Conservative complementary matching - October 16, 2026

The candidate MM paper path now supports direct, mint and merge matches through the explicit `ctf-max-transaction-volume-v1` option. This closes a model coverage gap; it does not establish real execution or a profitable strategy. Continuation 04 retains its original direct-only actor. Continuation 05 started its live-data paper phase at 10:45:53.672 UTC, with no additional deposit.

## Matching contract

The [official v1 trading contract](https://github.com/Polymarket/ctf-exchange/blob/main/src/exchange/mixins/Trading.sol) supports same-token BUY/SELL transfers, complementary BUY/BUY mint matches and SELL/SELL merge matches. Quantities use the six-decimal token units in the [official SDK configuration](https://github.com/Polymarket/clob-client/blob/main/src/config.ts).

```text
Public BUY YES can reach:
  owned SELL YES       -> direct sale
  collateral BUY NO   -> mint match

Public SELL YES can reach:
  collateral BUY YES  -> direct purchase
  owned SELL NO       -> merge match

Every route shares one native print-volume allowance.
Mirrored books are not two independent liquidity pools.
```

Both outcomes are represented on outcome zero's price axis. Only one resting representative is allowed per economic side/price. Existing priority wins; otherwise an owned sell is preferred. Synthetic self-crosses are rejected before reservations change. Pending cancellations continue to block overlapping replacements until acknowledgment.

The model converts queue consumption and fill allocation to integer microshares. It keeps the original public price for exact/through eligibility: rounding a nearby public price must not manufacture an exact-price fill. Every complementary fill requires native and counterpart book health linked to independently reconstructed public books. The receipt retains the raw print and separately names the filled token and direct/mint/merge route.

Within one condition and transaction hash, only an increase in the maximum observed share quantity grants more simulated volume. Additional token views cannot add the same volume again. This deliberately undercounts some transactions containing multiple independent trades; it is a conservative declared assumption, not a reconstruction of operator batching or venue FIFO. Recovery rebuilds those maxima from prior accepted native IDs.

## Accounting and evidence

Cross-token receipts update the bought/sold token's holdings, rather than the raw public print token. Stopped-producer recovery preserves cash, holdings, applied IDs and the transaction budget. A direct comparison can inherit earlier CTF receipts without replacing the bankroll. The independent Python auditor separately derives route eligibility, volume allocation, queue consumption, source-book health and money movements.

The extended real-data check exposed a recovery error in the analyzers: book revisions were retained across a producer restart even though the producer creates empty depth state. Both analyzers now clear volatile depth and confirmation leases at the recovery marker while preserving money and print-budget history. A regression covers a revision-one REST seed after an ancestor book. The repaired probe matched 45,109 applied snapshots across 1,870,409 actual journal records; that is a prefix reconstruction check, not a completed session audit.

Verification: the 687-test suite, four performance tests, and backend/frontend typechecks passed after placement-time freshness enforcement. Tests cover direct/mint/merge, finite shared volume, mirrored duplicates, native price precision, cancellation/quarantine boundaries, wrong token/route/budget, forged counterpart health, recovery, legal lease renewal, stale-at-placement rejection, and independently verified fixture valuation. A synthetic fixture's positive midpoint and negative executable liquidation remain distinct. These checks do not establish profitability.

## Isolated runtime and prospective experiment

Runtime: `~/.local/share/zinger/mm-runtime-20261016-ctf-v4`.

Manifest SHA-256: `799b8de07b4d253debc1a026876bf36284b99d0591cf35d59ff63a457db7a2d8`.

The runtime copies its Node executable, required dependencies, collector and analysis sources outside the worktree. All 105 manifested files are read-only and hash-verified. The 18 collector source identities match the tested candidate. Static import closure is checked with the TypeScript parser. No environment files, signers or funded adapters are copied. Node loader/path overrides are removed at launch and tsx disk cache is disabled.

The module smoke made zero network calls or orders. A separate read-only discovery preflight made 66 public HTTP reads and found an eligible deep crypto market. This verifies the isolated build and public API contract, not future universe coverage or trading profitability.

Continuation 05's plan preserves account `forward-capture-03`, original deposit $1,000, and the exact recovered cash/holdings from continuation 04. Launch requires a terminal producer and an independent accounting/risk pass whose report hash matches. Six predeclared controls compare direct touch/exact, direct improve/through, CTF touch/exact, CTF improve/exact, CTF improve/through and slower CTF improve/through. All controls inherit the same opening checkpoint and are independent counterfactual books; their balances cannot be added.

Plan and evidence: `tmp/commercial-evidence/mm-execution-repair-20261016/continuation-05/experiment-plan.json`, `ctf-runtime-stage-v4.json`, `ctf-runtime-v4-verification.json`, `ctf-runtime-v4-smoke.json`, `ctf-runtime-v4-public-discovery.json`, `ctf-runtime-v4-public-http.json`, and `continuation-04/native-book-prefix-ctf-probe-v2.json`.

## Remaining qualification

No new model is promoted from tests or quote counts. It needs fresh forward fills/cycles, complete accounting/risk and legal final valuation, direct and exact controls, cost/latency stress and independent market windows. Legacy numerical fill artifacts must remain separately counted. Untradable fractional inventory and unavailable marks can still prevent full liquidation valuation; a separately named conservative residual-value bound is further work. True exchange routing, priority, latency and funded lifecycle remain unverified. Performance eligibility stays false and real spending stays zero.

## Launch and deployed display

The parent completed with nine raw receipts, eight material fills and one numerical artifact. Its 2,151,435-row independent accounting/risk audit passed; final liquidation remained unverified. Cumulative midpoint P/L was -$1.97079364. Continuation 05 restored $986.56920568 cash plus unchanged holdings, verified the staged source against its plan, and is scheduled to end at 11:45:53.672 UTC. Producer PID 3055765 and completion worker PID 3074031 are separate from the preserved Core process.

The same Command Center now uses monitor/frontend v2 and displays original deposit, carried cash, inherited versus current-phase receipts, prior numerical artifacts and the matching assumption. Public/local role and write checks passed; desktop/mobile browser checks showed no overflow, page exceptions or failed app responses. Existing authentication and DNS were preserved. Latest observations and process identities are in `progress-snapshot.json`.

The completed continuation-05 trial produced 16 phase receipts, including a complementary merge receipt. Its independent capture audit failed before the six predeclared comparisons could run. The specific rejected order was placed 1,527ms after its native book receipt, beyond the configured 1,500ms maximum. Ending midpoint P/L was -$9.4697 and final liquidation was unavailable. These are not qualified performance results.

An earlier order sold 4.96468 shares at $0.78 and expired about 432ms later with 0.03532 shares remaining. The separately implemented lease candidate preserves such an existing legal remainder. A second independent issue was found at the end of continuation 05: a planner decision may have a fresh book, then become stale before order placement. `mmInputFreshAt` now rechecks receive, exchange and confirmation clocks at placement; both the live paper runner and comparison replay reject stale intents, and the split is deferred until that check passes. A 1,527ms replay regression verifies the order and split are rejected. This fix is not loaded into the completed trial and has no forward results yet.
