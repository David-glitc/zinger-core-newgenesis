# MM revalidation and upside experiments

The original 24-hour combined paper session keeps its launch sources, account
balances and deadline. Changes below run in separately recorded simulations;
they have not been loaded into that running MM process. Every experimental
account starts with $1,000 paper cash. Their balances are not added to the
original $2,000 combined portfolio. Actual spending is zero.

## Findings

A frozen, contiguous 1.80-hour prefix contained 193,552 journal records and
43,232 decisions. Replaying the legacy configuration reproduced all 116 orders
and zero fills, with no crossing-book reconstruction errors. Only 98 decisions
(0.23%) were eligible to quote. Seven predeclared variants all produced zero
fills and passed separate Python journal/accounting audits. No eligible print
matched an active order at its quoted price.

The queue model previously counted all better-priced depth against a quote,
but depleted it only with exact-price prints. The corrected model uses the
existing queue at that price. Better-price prints cannot fill it, cancellations
cannot create fills, and the activation delay and duplicate-print guards remain.
The legacy model is available explicitly for comparisons.

The market samples were also thin in executed flow: 163 observed native prints
across 49 unique markets, with prints in 15 markets. These are observed public
stream events over varying subscription periods, not an exhaustive exchange
trade history. Wallet turnover alone does not establish fillable MM flow.

Book-change time differs from confirmation time. Twelve direct, uncached REST
probes returned in 67-155 ms while their book timestamps were 1.7-42 seconds old.
Some successive responses had identical hashes and timestamps. The original
1.5-second timestamp rule therefore rejects many recently confirmed unchanged
books. This is an observed inference, not a guarantee that every old timestamp
represents a current book.

## Implemented experimental controls

- Same-price queue accounting, with recorded depth and independent verification.
- Configurable 2-, 10- and 30-second quote lifetimes; volatility allowance grows
  with the square root of the lifetime.
- One emergency taker-exit fee reserve for model pricing, while passive fills
  use zero maker fees and no assumed incentives.
- Independent outcome quoting: an individually fresh book can quote without
  requiring the complement to have updated within 250 ms. Shared capital,
  exposure limits, inventory-backed asks and complete-set cost checks remain.
- Verified REST confirmation as an explicit experimental freshness policy.
  It preserves the original server timestamp and records a separate confirmation.
  It rejects cache hits, positive cache age, old HTTP Date headers, slow requests,
  token/market mismatches, future timestamps, invalid books and changed revisions.
  A confirmation expires after 1.5 seconds; a heartbeat or trade cannot renew it.
  Periodic REST confirmation runs on a one-second interval.
- Optional touch pricing posts at best bid/ask, with inventory skew, a minimum
  spread/volatility allowance and post-only validation. Maker complete-set prices
  use actual zero entry fees; admission still reserves emergency taker costs.
  Outcome fills are independent, so a paired quote is not locked arbitrage.

Default pricing and freshness settings remain conservative and explicit.
These experiments are not automatically promoted to the running portfolio.

## Forward checks

Three 180-second runs with the original timestamp freshness rule completed with
no errors, no quotes and no fills. With verified confirmation and independent
model pricing, the next 180-second runs placed 242 orders at a 10-second lifetime
and 96 at a 30-second lifetime. Both had zero fills and passed independent
Python audits. All those orders were behind the current touch, motivating the
separate touch-pricing run. Longer lifetime alone is not evidence of better P&L.

The completed 120-second touch run placed 116 orders, all at the current best
bid or ask. It observed two native prints and zero fills, with cash unchanged
at $1,000. One fetch failure was logged; the independent audit passed. The final
checks passed: 530 unit tests across 59 files, four performance tests and
typechecking. Detailed results are recorded in the summary artifact below. A zero-fill run has no execution return sample or measurable portfolio
Sharpe. Open inventory, when present, is retained and valued with current finite
depth; missing marks remain unavailable rather than implying zero exposure.

## Reproduction and evidence

Evidence directory: `tmp/commercial-evidence/mm-revalidation-20261013`.

- `baseline-prefix.jsonl.gz` and `baseline-prefix.jsonl`: frozen input prefix;
  the copied gzip has no final trailer because the original session is ongoing.
  Extraction keeps only complete lines and verifies contiguous sequence numbers.
- `replay/comparison.json`: source hash, legacy reproduction, variant outcomes
  and replay limitations. Original readiness decisions and print health are held
  fixed; the replay cannot establish real exchange execution.
- `replay/*/independent-audit.json`: completed variant journal/cash audits.
- `flow-audit.json`: bounded observed trade-flow evidence.
- `book-clock-probe.json`: uncached response timing and unchanged-state evidence.
- `forward-*`, `confirmed-maker-*`, `confirmed-touch-10s`: independent forward
  runs, source copies, launch commands, complete journals and audits.
- `summary.json`: final verification and experiment outcomes.

Replay a frozen prefix into a new directory:

```sh
node --import tsx scripts/revalidate-mm.ts PATH_TO_PREFIX_JSONL NEW_REPLAY_DIRECTORY
```

For another touch experiment, first discover a fresh eligible universe and use
an unused output directory. This command is simulation-only:

```sh
npm run paper:mm -- --universe=FRESH_UNIVERSE_JSON --bankroll=1000 --seconds=180 --out=NEW_DIRECTORY --queue-model=same-price --quote-lifetime-ms=10000 --fee-reserve-legs=1 --quote-scope=independent --book-freshness=verified-snapshot --quote-pricing=touch
python3 scripts/audit-mm-paper.py NEW_DIRECTORY
```

The Python audit independently checks queue initialization, print timing,
confirmation provenance constraints, cash, holdings, fills, merges and source
hashes. Regression tests reject tampered cached responses, old dates, changed
revisions and inflated queues. Public print aggressor attribution and actual
queue priority remain simulation assumptions, not reconciled live account fills.

## Improving upside after costs

For crypto, the next experiment should isolate a consistent 20% stop policy,
disable governor/heuristic exit overrides that violate it, add a per-window
reentry cooldown after a stop, and require expected gains to exceed fees, spread
and slippage. The current trade log cannot backtest a different holding policy
because future prices after each recorded exit are incomplete. A model confidence
score must not be treated as a calibrated settlement probability.

For MM, evaluate competitive passive quotes using observed flow, time at the
touch, same-price queue clearance, inventory and post-fill price movement.
Measure realized and executable liquidation P&L after costs. Select markets by
actual flow at reachable prices, not quote count or wallet name. Keep capital
limits fixed while comparing candidates; no profitable configuration has yet
been demonstrated.

References: [Polymarket fees](https://docs.polymarket.com/trading/fees),
[market-making guidance](https://docs.polymarket.com/trading/market-making),
[public market-stream schema](https://docs.polymarket.com/market-data/realtime-data),
[order-book hashes](https://docs.polymarket.com/market-data/prices-order-books).
