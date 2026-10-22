# $500 forward paper MM session

Started October 13, 2026 at 12:00:40 UTC / 14:00:40 Europe/Berlin. Scheduled
duration: one hour, ending around 13:00:40 UTC / 15:00:40 Europe/Berlin.

This is an isolated simulation on current public Polymarket data. It does not
load funded account settings, sign orders, or submit transactions.

## Archived dashboard and completed session

This one-hour $500 experiment completed on October 13. Its final report records
876 quotes placed and zero simulated fills; cash remained $500. Quoting activity
is not trading profit. The independent journal/accounting audit passed.

The permanent hostname now hosts the original authenticated Command Center and
[the new concurrent $2,000 paper session](COMBINED_PAPER_SESSION_2026-10-13.md).
The former `zinger-paper-dashboard` container is stopped. Its standalone assets,
compose file, report and browser-validation evidence remain archived. Do not
start the old compose service while the current Command Center uses port 3000.
The existing Cloudflare DNS and shared Traefik route were preserved.

## Session settings

| Setting | Value |
|---|---:|
| Starting paper cash | $500 |
| Maximum inventory cost plus pending bid reservations | $50 |
| Per-market commitment cap | $10 |
| Per-event commitment cap | $20 |
| Maximum order size | 5 shares, subject to exchange minimum |
| Net outcome exposure limit | 20 shares |
| Quote activation latency | 250 ms |
| Quote lifetime | 2 seconds |
| Drawdown stop | $25, when a fresh complete liquidation mark is available |
| Starting universe | 8 markets / 16 outcome books |

The universe was refreshed from public wallet trading activity on October 13;
the expired October 10 sports markets were not reused. The universe is fixed
for this first one-hour baseline. Quoting pauses ten minutes before game start.

## Fill and valuation model

Identified native `last_trade_price` events consume displayed queue ahead at
exactly the resting quote price, with the reported side interpreted as the
aggressor side. That interpretation has not been independently reconciled
against exchange fills. Both this attribution and queue priority remain model
assumptions; all reported executions are simulated.

Touches, cancellations, unidentified trades, duplicate prints, future or stale
timestamps, expired quotes and unhealthy depth cannot create fills. An unchanged
quote retains its original queue and expiration. The account starts without
tokens, so asks require inventory acquired by simulated fills.

Passive maker fills pay zero fees under the current [public fee policy](https://docs.polymarket.com/trading/fees).
Quote admission still reserves the existing conservative entry/exit fee curves.
Forced-liquidation valuations consume finite visible bid depth and subtract the
current taker fee curve. Incentive income is zero.

Standard binary complete sets can be merged after both simulated fills, with an
explicit one-cent cost per merge. Negative-risk merges remain disabled. Open
inventory is retained and marked at session end; settlement payouts are not
invented. Midpoint equity and liquidation equity are reported separately. Stale
or missing inventory marks produce null equity, not a fabricated loss or gain.

## Archived artifacts and reproduction

- Process PID at launch: `93732`; detached from the command session.
- Live status and account: `tmp/commercial-evidence/mm-paper-500-20261013/report.json`.
- Launch command and PID: `tmp/commercial-evidence/mm-paper-500-20261013/launch.json`.
- Process output: `tmp/commercial-evidence/mm-paper-500-20261013/process.log`.
- Replay journal: `tmp/commercial-evidence/mm-paper-500-20261013/events.jsonl.gz`.
- Source copies and hashes: the same directory's `sources/` and `source.json`.

The report is replaced atomically every second. Confirm both process liveness
and a recent `updatedAt` before describing the session as running. The gzip
journal is complete only after the process exits. This session has already exited. Do not send a signal to its historic PID.
Audit its complete journal:

```sh
python3 scripts/audit-mm-paper.py tmp/commercial-evidence/mm-paper-500-20261013
```

For a later session, first discover a current eligible universe, then choose a
new output directory:

```sh
npm run paper:mm -- --universe=PATH_TO_FRESH_UNIVERSE_JSON --bankroll=500 --seconds=3600 --out=tmp/mm-paper-new
```

## Verification before launch

Repository typechecking passed. All 495 unit tests across 56 files passed,
including 11 new paper-session tests. A 45-second live-data smoke session
completed and its full gzip journal independently passed the Python accounting
audit: starting cash $500, ending cash $500, no simulated fills, and no actual
spending. This completed session had no simulated fills; no portfolio Sharpe or
verified profitability is claimed.
