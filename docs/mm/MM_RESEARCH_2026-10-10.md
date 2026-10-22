# Market-making research and public-wallet audit

## Context and constraints

Zinger now has a separate public-data market-making research path. The existing
instant-arbitrage observation found no executable after-fee edge in its short
BTC/ETH sample. This change investigates passive quoting and inventory handling
across a wider market universe. It does not change the funded bot's configuration
or start an order-submission process.

The public-wallet audit covers **2026-10-09 13:34:30 UTC through 2026-10-10
13:34:30 UTC**. All six matching-window trade feeds reached their terminal
cursors. The three accounts are public wallet names selected from an earlier
monthly volume leaderboard, with no independent verification of professional MM
identities, linked wallets, or off-venue hedges.

## Findings

| Wallet name | Execution rows | Markets | Maker row share | Maker notional share | Leading discovery families |
|---|---:|---:|---:|---:|---|
| ferrariChampions2026 | 9,439 | 476 | 94.2% | 68.4% | Tennis, American football, esports |
| RN1 | 8,678 | 1,321 | 91.7% | 86.7% | Soccer, tennis, other sports |
| Flaznorp | 30,670 | 5,474 | 23.1% | 20.3% | Soccer, other sports, tennis |

There are **48,787 all-role executions across 5,830 unique conditions**. Maker
shares are aggregate differences between the complete all-role and taker-only
feeds using identical wallet and timestamp filters. They describe attributed
executions, not continuous quoting, ownership of posted orders, or queue priority.
Both streams together contain 73,635 rows; that total includes taker rows a second
time and must not be reported as distinct executions.

Gross traded notional is approximately $2.084m, $1.879m, and $3.238m respectively.
It is turnover, not profit or capital. Title/slug family labels are heuristics;
some soccer markets remain labelled `sports-other`. No crypto executions were
classified in this window. That is a window-specific observation.

Ferrari's leading traded markets include Wyoming–San Jose State, Ducks–Jets,
Palermo tennis, Grizzlies–Bulls, and Iowa–Washington. Tennis accounts for roughly
44% of its sampled notional. RN1's leading markets include Shanghai tennis,
Counter-Strike fnatic–K27, Arsenal's match result, Palermo and Suzhou tennis.
Soccer and tennis account for approximately 35% and 24% of its sampled notional.
Flaznorp's leading markets include Al Nassr–Al Diraiyah first-half totals,
Arsenal, Dortmund, Brentford, and Amed Sportif match results.

All captured trade rows report `BUY`. Several conditions contain purchases of
both outcomes. Lifecycle feeds are therefore essential to understanding exits:

| Wallet | Merge records | Redeem records | Split records |
|---|---:|---:|---:|
| ferrariChampions2026 | 313 | 250 | 0 |
| RN1 | 0 | 665 | 0 |
| Flaznorp | 49 | 3,173 | 0 |

Merge and redemption cash includes inventory acquired before the audit window.
Subtracting current-window buys from these receipts would not establish profit.
The observed behavior supports investigating Ferrari as a passive acquisition
and merge example, RN1 as a maker-heavy acquisition and settlement example, and
Flaznorp as a taker-heavy comparison. These are hypotheses about behavior, not
recovered proprietary strategies.

Current-position pagination also reached its terminal cursor: 31,345, 27,500,
and 7,773 rows respectively. These pages are not an atomic snapshot and can
change during collection. The audit reports holdings value separately from
idle collateral; it does not call that value portfolio equity.

Public PnL series yielded 29 complete daily increments, September 11 through
October 10 at UTC midnight. The provider-reported economic PnL changes were
$441,492, $596,001, and $677,796 respectively. These are reported cumulative
series differences, not independently reconstructed or audited fund returns.
Daily dollar-PnL consistency is reported without annualization. Portfolio
Sharpe remains unavailable because historical equity and complete external-flow
classification have not been established. Deposit/withdrawal/tip histories are
captured separately; historical chart cashflow fields were null.

## Repo shape and module contracts

The existing repository shape is retained. No framework, dependency, database,
or deployment target was added.

| Module | Responsibility | Enforcement |
|---|---|---|
| `src/research/mm/publicData.ts` | GET-only public transport and bounded cursor pagination | Endpoint allowlist, explicit method, pagination tests |
| `src/research/mm/walletAudit.ts` | Wallet/window validation, market aggregation, role estimates, PnL coverage | Independent Python reconstruction and fixture tests |
| `src/research/mm/strategy.ts` | Quote regimes, inventory skew, fee/capital/event guards | Quote and reservation tests; independent live-journal checks |
| `src/research/mm/paperInventory.ts` | Isolated paper fills, inventory, merges, resolution and queue model | Overdraft, oversell, duplicate, unrelated-token and losing-leg tests |
| `scripts/audit-public-mm.ts` | CLI orchestration, public-page journal, metadata enrichment | No funded imports; raw-page audit |
| `scripts/observe-mm.ts` | Continuous depth capture and hypothetical quote planning | No funded imports; complete gzip/sequence audit |

The highest-value domain change is separating passive liquidity provision from
immediate arbitrage in `src/polymarket/arbEngine.ts`. A resting bid has an unknown
fill probability and can acquire an isolated directional leg. It must not inherit
an instant-arbitrage label or a guaranteed-payout assumption before both fills.
The existing two-state volatility signal in `regimeSignal.ts` is also distinct
from the new operational quote regimes.

## Strategy and operational regimes

The initial policy uses a conservative book reference: 80% midpoint and 20%
top-level microprice. It is not a calibrated outcome probability. Recent book
midpoint changes estimate probability volatility; no BTC/ETH ATR or ADX signal
is reused for unrelated sports markets.

| Regime | Trigger | Behavior |
|---|---|---|
| Warmup | Fewer than eight observations, less than 20 seconds, or a history gap | Observe without quoting |
| Paused | Unusable/stale book, probability shock, wide/crossed spread, event guard, or invalid state | Remove quote intentions |
| Two-sided | Valid reference, recent synchronized complementary books, available capital | Plan passive quotes with fees and inventory skew |
| Reduce inventory | Net outcome exposure reaches its limit | Stop adding to the overweight outcome; offer an owned-position reduction |

With zero inventory, two-sided binary exposure is expressed as bids on both
complementary outcomes. Asks require owned tokens. Every quote is post-only and
expires after two seconds. New bid commitments share a $10 market cap, $20 event
cap, and $100 portfolio cap against $1,000 hypothetical cash. Maximum order size
is five shares, subject to the actual exchange minimum. Net outcome exposure
is capped at 20 shares. Fees are reserved conservatively for entry and exit;
no incentive income is assumed.

Paired bid costs must pass the complete-set cost guard. Matching prices below a
$1 payout do not imply available executable asks or simultaneous fills. After
both fills, the paper ledger can merge the registered complete set or settle it
against explicitly supplied resolution payouts. An unpaired losing outcome is
booked as a loss. The queue model consumes identified exact-price aggressor
volume ahead of our order; book touches and cancellations never create fills.

The observer currently records quote intentions only. The queue and inventory
models are tested building blocks and are **not connected to a live fill
simulation or an order-submission adapter**.

## Request context and middleware policy

These are bounded command-line research jobs. Their explicit context is the
wallet/window or audited universe, output directory, timestamp, and public-data
coverage. They do not load `.env`, account state, signing keys, the funded ledger,
or bot settings. Public reads require no authentication. Network/storage failure
marks the job failed; capped pagination is reported as incomplete.

## Frontend boundaries

No frontend change. JSON reports and raw compressed journals are the current
review surface. A dashboard must keep quote intentions, simulated fills and
actual fills separate if integrated later.

## Testing strategy and observed run

The relevant test run passed **60 tests across five files**, including the
existing depth reconstruction and fee arithmetic. The complete root unit suite
then passed **484 tests across 55 files**, and all **four performance checks**
passed. Repository typechecking passed. Independent Python reconstruction checked trade counts, market counts,
turnover, lifecycle receipts, PnL differences, and archived source hashes.

The successful three-minute shadow run monitored eight pre-event markets and
16 outcome books: **4,559 wire messages, 3,106 depth updates, 1,424 evaluations,
and 88 hypothetical quote observations**. Eighty-five qualifying observations
were in Brentford's match-result market and three were in Bodø/Glimt's spread.
There were no reconnects or recorded errors. Maximum end-of-cycle quote capital
reservation was $4.76988.

There were **zero actual orders, zero actual spend and zero simulated fills**.
P&L and portfolio Sharpe remain null. The first exploratory capture failed
during journal shutdown and is marked failed; only the repeat is the validated
shadow artifact.

## Rollout and rollback plan

Run an account audit, inspect its completeness, then pass its output directory
to the observer. Both jobs terminate; neither starts the funded bot.

```sh
npm run audit:mm -- --hours=24 --pages=100 --position-pages=100 --out=tmp/mm-audit-new
python3 scripts/audit-mm-evidence.py tmp/mm-audit-new
npm run observe:mm -- --audit=tmp/mm-audit-new --seconds=180 --markets=8 --out=tmp/mm-shadow-new
python3 scripts/audit-mm-shadow.py tmp/mm-shadow-new
```

Use new output directories; raw journals are not overwritten. SIGINT/SIGTERM
stops the observer and marks the report interrupted. To roll back this slice,
stop using the two npm commands and remove these research modules, tests and
scripts. The existing bot has no dependency on the new modules.

## Evidence and open risks

- Wallet artifact: `tmp/commercial-evidence/mm-wallet-audit-20261010-final/`.
  The independent audit verified 180 saved HTTP responses and 52 assertions.
- Validated shadow artifact: `tmp/commercial-evidence/mm-shadow-20261010-verified/`.
  The independent check verified 6,060 consecutive journal records, quote
  freshness, grid prices, minimum sizes, complete-set costs, capital caps and
  source hashes. Archived source files and full compressed journals accompany
  both runs.
- Public account history cannot reveal quote cancellations, queue placement,
  hidden hedges, or linked-account capital. Position pagination is not atomic.
- The default universe is selected from leading traded conditions and holdings;
  it is not a complete census of all markets those wallets have ever traded.
- Event grouping removes known Gamma submarket suffixes. Cross-event
  correlations and missed aliases still need portfolio stress scenarios.
- Six of the eight observed markets were soccer-related despite some heuristic
  `sports-other` labels. The implemented watchlist is not evidence of balanced
  exposure across sports families.
- Most evaluations were denied by freshness/history gates. Quiet pre-event
  books and connection health need separate future analysis before changing
  those thresholds. Thresholds were not relaxed to manufacture more quotes.
- Before performance claims: connect a replayable passive queue model using
  verified aggressor attribution, charge realized fees, mark every inventory
  position, test isolated-leg losses and latency/depth stresses, and evaluate
  event-separated chronological holdouts over multiple days.
- External sports fair-value feeds, the live order adapter, production regime
  migration, and GP-based sports probabilities are deferred because their data
  and execution semantics have not been established. No funded deployment was
  requested or performed.

Primary references: [public trades](https://docs.polymarket.com/api-reference/feeds/list-trades),
[wallet activity](https://docs.polymarket.com/api-reference/feeds/list-account-activity),
[PnL history](https://docs.polymarket.com/api-reference/wallet/get-a-users-pnl-series),
[portfolio value](https://docs.polymarket.com/api-reference/wallet/get-portfolio-value),
[market making](https://docs.polymarket.com/trading/market-making),
[real-time data](https://docs.polymarket.com/market-data/realtime-data),
and [public-fill attribution limits](https://arxiv.org/abs/2605.11640v2).
