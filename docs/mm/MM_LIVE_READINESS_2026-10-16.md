# MM live readiness - 16 October 2026

## Decision

**No-go for a funded MM launch tomorrow.** Zinger has no demonstrated MM edge and the research MM has no funded order lifecycle. No deposit or live order was made during this preparation. A new wallet balance would not address either blocker.

This is a readiness assessment, not a profitability claim. The paper MM and Core live trader are separate execution paths; the Core trader is not a substitute for a market-making adapter.

## Evidence

- Continuation 05 completed with 9,076 quote placements and 16 phase receipts, but its original independent audit failed on a quote placed against a book 1,527 ms old, above the 1,500 ms limit.
- Six later replays were explicitly created after the capture as diagnostics. Four journals passed accounting/risk/depth checks; two failed CLOB depth provenance because their confirmation proof did not match a captured REST book record.
- All six diagnostic reports mark performance claims ineligible. Every report has `finalValuationVerified: false` and `actualExecutionVerified: false`; the original capture remains failed. These runs do not establish a positive net edge.
- The earlier 24-hour combined run lost $94.52 overall. MM had zero simulated fills. More recent MM captures have too few complete, independently valued cycles to overcome that result.

Evidence is under `tmp/commercial-evidence/mm-execution-repair-20261016/continuation-05/`. Preserve the original capture, failed audit and six post-capture variants as separate evidence.

## Live path gaps

1. `src/research/mm/*` intentionally has no funded CLOB client. It lacks live submit/cancel acknowledgments, user-channel fill processing, duplicate/late-event handling, open-order and balance reconciliation, and crash/restart recovery for live orders.
2. The existing Core path in `src/polymarket/trade.ts` uses the legacy `@polymarket/clob-client-v2` package. Polymarket's current integration docs describe unified clients and Deposit Wallets. Compatibility with the current wallet type, SDK, collateral and account approvals has not been verified.
3. The region gate previously allowed CLOB authentication to override a blocked-region result. It now fails closed on blocked or unavailable direct geoblock checks and when CLOB traffic is configured through a proxy/relay. Seven regression tests cover these cases. The full suite passes 695 tests across 80 files, and `npm run typecheck` passes. This fixes readiness reporting; it does not add a live MM adapter or independently make the Core order path safe to trade.
4. The current host's direct request to Polymarket's geoblock endpoint returned HTTP 403, so the host's present eligibility cannot be verified here. Polymarket's current docs classify Germany and France as close-only for new orders. Do not route around the venue's region controls. Eligibility must be checked from the actual operator/deployment egress before any future live use.
5. Collateral docs now identify pUSD as the Polygon trading collateral (6 decimals), backed by USDC. The documented manual onramp wraps USDC.e; the current local deposit scanner instead watches the configured USDC token and sends it through a 0x swap before transferring pUSD. That local flow has not been verified against the current official deposit/onramp path. Do not use it for a first funding transaction. No collateral amount, wallet address, approval, or transfer was selected or submitted.
6. The exchange's market-maker quoting, fill, cancellation, and balance lifecycle has not been connected to the paper actor. Simulated fills and visible queue depth cannot show actual queue priority or a live fill edge.

## Evidence required before a controlled live canary

- Legal/geographic eligibility confirmed by the official endpoint from the exact order egress, with no proxy or relay mismatch.
- Current official wallet and SDK integration selected and tested for the account's wallet type. Deposit address, signer and trading wallet ownership must reconcile.
- pUSD deposit route confirmed from official current instructions; on-chain receipt, spendable CLOB balance and required allowance must reconcile exactly. Test this read-only first; submit no approval, transfer, swap or order as part of preflight.
- A separate MM live adapter implements idempotent submit/cancel, user WebSocket fills, partial-fill accounting, order reconciliation, cancel/fill races, process restart, kill switch and verified exit path.
- Paper and captured-input replay reports have complete liquidation values, no unexplained cash/position drift, no failed provenance checks, and positive net executable results after fees and adverse selection across predeclared baselines and independent market windows. Do not count maker rewards unless actually received and reconciled.
- Only after these gates pass, define a small explicit funded-canary cap and order limits. The cap, asset, chain and wallet must be confirmed before any deposit or live order.

Polymarket's official documentation: [geographic restrictions](https://docs.polymarket.com/api-reference/geoblock), [pUSD collateral](https://docs.polymarket.com/concepts/pusd), [wallets and authentication](https://docs.polymarket.com/trading/wallets-auth), and [market making](https://docs.polymarket.com/trading/market-making).
