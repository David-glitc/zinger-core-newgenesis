# Quote lifecycle repair - October 16, 2026

Candidate implementation is tested but not loaded into the ongoing continuation-05 experiment. The original account, captures, failed experiments and financial history are preserved. Real orders submitted and real spending remain zero.

## Observed defect

Continuation 05's first new five-share order sold 4.96468 shares at $0.78. Its fixed ten-second lifetime expired approximately 432ms later, cancelling the remaining 0.03532 shares. Across capture 03 the median initial displayed queue was 11,105.70 shares and the median effective lifetime 9.746 seconds. Frequent expiration discards accumulated queue progress. The planner also treated a valid partial order's remaining size as though it were a new order and could remove it for being below the market minimum.

Evidence: `continuation-05/first-partial-order-lifecycle.json` and `continuation-05/first-forward-matching-receipt-observation.json` under the execution-repair evidence directory. These are timestamped observations, not final performance audits.

The venue's [order documentation](https://docs.polymarket.com/trading/place-orders) distinguishes GTC orders from timed GTD orders. The candidate models its short watchdog as client cancellation of GTC, with an explicit acknowledgment delay. The [management documentation](https://docs.polymarket.com/trading/manage-orders) preserves the distinction between an order's original and filled quantities. An existing partial remainder is not a newly submitted undersized order.

## Implementation contract

| Boundary | Candidate behavior | Enforcement |
| --- | --- | --- |
| Planner | Retain only the same supported price/side and exact remaining quantity; bind maintenance to original ID; preserve real minimum for new orders | `mmQuoteLease.test.ts`; price, stale-book, inventory and complete-set guards |
| Actor | Explicit opt-in `renewable-client-lease-v1`; preserve ID, priority estimate and remaining quantity across timely renewal | Legal original size, hard event deadline, cash/inventory/net-risk checks |
| Cancellation | Lease expiry requests cancellation; retain order risk and possible fills through modeled acknowledgment | Before/at acknowledgment boundary fixtures; fixed-expiry control retained |
| Journal/recovery | Durable renewal events and restored deadlines/counters; exact integer microshare remainder; cancel recovered uncertain orders | Recovery fixture for observed 0.03532 shares and quarantine |
| Replay | Each comparison plans from its own working orders and preserves declared expiry policy | Common-input fixed/lease integration and independent final audit |
| Independent audit | Rebuild native books; reject altered identity/price/quantity/deadline, stale source, renewal after cancel, counter drift and unsupported fills | Six forged-renewal cases plus legal final fixture |

The option is available in `scripts/paper-mm.ts` as `--expiry-policy=renewable-client-lease-v1`. It requires joint CTF matching and positive cancellation latency. Fixed expiry remains the default for historical compatibility. No running actor is hot patched.

## Verification

685 unit tests in 79 files passed, plus four performance tests and backend/frontend typechecks. The common-input lease fixture fills the same legal five-share original order in two receipts, including the second receipt after the original expiry. The fixed-expiry control has only the first receipt and leaves an untradable residual. Its full liquidation remains null; the lease fixture's legal final valuation passes an independent audit. Neither synthetic fixture is evidence of a market edge.

Logs: `tmp/commercial-evidence/mm-execution-repair-20261016/full-suite-lease-final.log`, `perf-suite-lease-final.log`, `typecheck-lease-final.log`, `frontend-typecheck-lease-final.log`, `lease-independent-audit.log`, `lease-replay-integration-final.log`.

## Remaining acceptance and rollout

1. Complete continuation 05 and its six predeclared controls unchanged. The scheduled live phase ends at 11:45:53.672 UTC; independent audits follow.
2. Resolve disk capacity before another long capture: inherited journal/public-input duplication currently multiplies storage across comparisons. Keep original evidence and capital.
3. Freeze the tested candidate, dependency identity and new prospective comparison plan. Resume only the terminal, independently reconciled same account, with no new deposit.
4. Measure queue residence, material fills, complete inventory cycles, cost/latency sensitivity, adverse selection and legal final portfolio value. Renewing a quote can increase adverse selection; additional fills alone are not success.
5. Late prints received after modeled cancel acknowledgment, real venue FIFO/routing, integer cash accounting and full legal treatment of residual holdings remain unqualified. A conservative residual-value bound must be separately named and independently checked.

No funded MM adapter is connected. Core's older deployment and ML/accounting/auth gaps remain separately tracked in [Architecture status](ARCHITECTURE_STATUS_2026-10-16.md). Rollback for a future candidate means restoring the prior immutable runtime while recovering the same ledger and cancelling uncertain outstanding orders; it must never allocate a replacement bankroll.
