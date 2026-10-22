# Read-only MM monitor deployment - 2026-10-16

Live URL: https://zinger.kierkegaard.space/#paper-session

The existing Command Center now displays a separate current MM experiment and the older combined session's failed final accounting audit. Its totals continue to represent only the original two accounts. The new trial is not added to those totals. All trades remain simulated.

## Runtime

```text
Existing hostname / reverse proxy
  -> nginx zinger-command-center
       /api/research/mm-trial -> 127.0.0.1:3051, authenticated read-only monitor
       all other routes      -> existing Core backend :3050
                                  -> frontend/dist -> reviewed staged build

Monitor -> current MM report + source identity + final audit
        -> original combined manifest + automatic final audit
```

The original `zinger-combined-paper-20261013.service` and its PID 401366 were preserved. The ongoing MM producer PID 2544371 was preserved through a monitor restart. No account, wallet or trading engine is initialized by the monitor.

Monitor unit: `zinger-mm-research-20261016.service`, enabled under the existing user's systemd manager, bound to loopback, with restart on failure. It uses the existing private authentication environment file and the existing deployment's resolved Node executable. The initial assumption that Node existed at `/usr/bin/node` failed pre-publication; the unit was stopped, corrected and verified before routing traffic.

Immutable monitor code and frontend build: `tmp/commercial-evidence/mm-monitor-20261016-v1`.

Monitor build identity: `204d51f857d369b967aa259c371bd0a7e1660acf90096540d108bd3b30b9857e`.

Existing Cloudflare DNS, domain, credentials and upstream routing were unchanged. Only one nginx route and the staged frontend target changed. The main backend still runs its earlier source; frontend builds are served directly from `frontend/dist`, so ordinary builds in that directory also affect the live assets.

## Verification

- Public HTTPS serves the exact staged index SHA-256: `aa9cafaeaf59ffc2d95044c64cb4e84d7757071183f3924a9c4284b8c86626c9`.
- New API: unauthenticated 401, operator 200, viewer 403, writes 405; `Cache-Control: no-store`.
- The API continues to return the same monitor identity and current experiment after a monitor restart.
- Browser checks at 1440x1100 and 390x844 verified the independent $1,000 account label, two simulated fills at observation time, visible final accounting failure, no horizontal overflow, no page exceptions and no failed app responses during observation.
- Desktop and mobile screenshots were inspected. Evidence: `browser-verification.json`, `api-verification.json`, `trial-1440.png`, `trial-390.png`.
- Backend/frontend types, the staged production build, and the full 614-test unit suite passed. Existing frontend bundle-size warnings remain.

Observed MM liquidation P/L was approximately -$0.97 at the browser check. This is a preliminary simulated mark, not a completed performance result. The browser's two-fill count was a point-in-time observation, not the session's final count. Missing marks remain unavailable. There is no verified live profitability or qualified Sharpe estimate.

## Recovery

Monitor-only rollback:

```bash
systemctl --user stop zinger-mm-research-20261016.service
```

Restore `docker/command-center-nginx.conf` from the saved `previous-nginx.conf`, first confirm no later operator edits would be overwritten, validate with `docker exec zinger-command-center nginx -t`, then reload nginx. This removes only the added research route.

Frontend rollback: remove the `frontend/dist` symlink after verifying it still points to this deployment, then rename `frontend/dist.before-mm-monitor-20261016` back to `frontend/dist`. Do not reset the worktree, alter trading data, or restart a completed session with a fresh bankroll.

To display a different experiment, review its report/source identity first, change only the monitor unit's explicit trial-directory argument, and restart the read-only monitor. Preserve independent experiment balances and evidence. This monitor's restartability does not implement restart recovery for the trading worker.

## Current experiment pointer

At the October 16 09:51 UTC verification, the same v1 monitor serves `continuation-04`, account `forward-capture-03`. Only the explicit trial-directory argument and the read-only monitor were restarted; producer PID 2805067 and the original Core PID 401366 were preserved. Public/local access checks passed again. Its total three fills are inherited from capture 03; the current UI does not yet distinguish inherited and phase counters. This limitation is tracked in [Architecture status](ARCHITECTURE_STATUS_2026-10-16.md). The completed original combined totals remain separate.

## Version 2: account and phase attribution

Deployed v2 source: `tmp/commercial-evidence/mm-monitor-20261016-v2`; monitor identity `adb0a6240ce4caa1450952566d76072c47bad1ab466d1a5f261083c33d728884`. Frontend index SHA-256: `0a2d73316cdfa50a84743a547fd425e930090d11a345d9ba5ff9e60902050620`. It points to the running `continuation-05` account. Original deposit remains $1,000; carried opening cash is $986.56920568 with unchanged holdings. Nine inherited receipts include one numerical artifact excluded by the prior audit. Current-phase counts are displayed separately.

Opening values require a matching checkpoint/prefix; invalid or missing evidence displays unavailable. Material counts require a report-matching terminal audit. Current accounting and final valuation status remain separate. Four monitor/view-model tests and backend/frontend types passed; the staged build and 1440x1100/390x844 browser checks passed. The initial immediate post-restart probe hit the ordinary listen-readiness race; rechecking the same running unit passed without another restart.

The prior unit is saved as `previous-monitor.service`, and `deployment.json` records the previous frontend target. Rollback restores that exact unit/target after checking for later operator edits. Producer PID 3055765 and Core PID 401366 were preserved. No Cloudflare DNS changes or funded execution occurred.

At 10:56 UTC the new phase had one new material receipt: a direct 4.96468-share sale at $0.78. Complementary-route forward fills remain unproven. Its original five-share order expired about 432 ms after that partial fill, leaving 0.03532 shares. This observed lifecycle gap is the next prospective repair; the running trial is unchanged.
