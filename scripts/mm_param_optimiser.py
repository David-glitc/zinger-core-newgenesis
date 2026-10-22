"""Offline parameter sweep for reward-band quoting, from a recorded projection run.

For every market-minute, and every (offset ticks behind the touch, size multiple of the reward minimum):
  reward  = share of the daily pool, scored with the quadratic rule against the recorded in-band book
            (two-sided: the smaller side's share counts), per minute
  adverse = conservative fill cost: a bid at b counts as filled only if the next minute's midpoint is at
            or below b (the market moved through it); it is marked at the midpoint 10 minutes later.
            Asks symmetric. Benign fills that would earn spread are ignored, so trading P/L is understated.
  capital = size x bid + size x (1 - ask)
Outputs per-market best parameters, a grid summary, and charts. Read-only; no network.

Usage: python3 scripts/mm_param_optimiser.py <projection-run-dir> [universe.json]
"""
from __future__ import annotations

import json
import math
import sys
from collections import defaultdict
from pathlib import Path

OFFSETS = [0, 1, 2, 3]
SIZE_MULTS = [1, 2, 4]
MARKOUT_MIN = 10


def score(levels, mid, v):
    return sum(l["size"] * ((v - abs(l["price"] - mid)) / v) ** 2 for l in levels if abs(l["price"] - mid) <= v)


def infer_tick(prices):
    return 0.001 if any(abs(p * 100 - round(p * 100)) > 1e-6 for p in prices) else 0.01


def main(run_dir: str, universe_path: str | None) -> None:
    run = Path(run_dir)
    samples = [json.loads(l) for l in open(run / "samples.jsonl")]
    meta = {}
    for s in samples:
        if "maxSpread" in s:
            meta.setdefault(s["market"], {"question": s.get("question", ""), "maxSpread": s["maxSpread"], "minSize": s["minSize"]})
    for m in json.load(open(run / "markets.json")):
        meta.setdefault(m["id"], {"question": m.get("question", ""), "maxSpread": m["maxSpread"], "minSize": m["minSize"]})
        meta[m["id"]]["dailyPool"] = m["dailyPool"]
        meta[m["id"]]["group"] = m.get("group")
    ticks, groups = {}, {}
    if universe_path:
        for c in json.load(open(universe_path))["selected"]:
            ticks[c["conditionId"]] = c.get("triage", {}).get("tick")
            groups[c["conditionId"]] = c.get("group") or ("thin" if c.get("triage", {}).get("thin") else "deep")

    snaps = defaultdict(list)
    for line in open(run / "snapshots.jsonl"):
        x = json.loads(line)
        if x.get("bids") and x.get("asks"):
            snaps[x["market"]].append(x)
    for v in snaps.values():
        v.sort(key=lambda x: x["at"])

    results = {}
    for mkt, rows in snaps.items():
        info = meta.get(mkt)
        if not info or not info.get("dailyPool") or len(rows) < MARKOUT_MIN + 2:
            continue
        v, min_size, pool = info["maxSpread"], info["minSize"], info["dailyPool"]
        tick = ticks.get(mkt) or infer_tick([l["price"] for r in rows[:50] for l in r["bids"] + r["asks"]])
        mids = []
        for r in rows:
            bb = max(l["price"] for l in r["bids"]); ba = min(l["price"] for l in r["asks"])
            mids.append((bb + ba) / 2)
        grid = {}
        for k in OFFSETS:
            for sm in SIZE_MULTS:
                size = min_size * sm
                reward = adverse = capital = 0.0
                fills = minutes = 0
                for i in range(len(rows) - MARKOUT_MIN - 1):
                    r = rows[i]
                    bb = max(l["price"] for l in r["bids"]); ba = min(l["price"] for l in r["asks"]); mid = mids[i]
                    if bb >= ba:
                        continue
                    bid, ask = round(bb - k * tick, 6), round(ba + k * tick, 6)
                    if bid <= 0 or ask >= 1:
                        continue
                    minutes += 1
                    capital += size * bid + size * (1 - ask)
                    ob = size * ((v - (mid - bid)) / v) ** 2 if mid - bid <= v else 0.0
                    oa = size * ((v - (ask - mid)) / v) ** 2 if ask - mid <= v else 0.0
                    if ob > 0 and oa > 0:
                        cb, ca = score(r["bids"], mid, v), score(r["asks"], mid, v)
                        reward += min(ob / (ob + cb), oa / (oa + ca)) * pool / 1440
                    nxt, later = mids[i + 1], mids[i + 1 + MARKOUT_MIN - 1]
                    if nxt <= bid:      # moved through our bid: we bought at bid
                        fills += 1; adverse += (later - bid) * size
                    if nxt >= ask:      # moved through our ask: we sold at ask
                        fills += 1; adverse += (ask - later) * size
                if minutes == 0:
                    continue
                per_day = 1440 / minutes
                cap = capital / minutes
                net = (reward + adverse) * per_day
                grid[f"{k}:{sm}"] = {"offsetTicks": k, "sizeMult": sm, "rewardUsdPerDay": reward * per_day,
                                     "adverseUsdPerDay": adverse * per_day, "netUsdPerDay": net,
                                     "fillsPerDay": fills * per_day, "capitalUsd": cap,
                                     "netPer100PerDay": net / cap * 100 if cap > 0 else 0, "minutes": minutes}
        if not grid:
            continue
        best = max(grid.values(), key=lambda g: g["netUsdPerDay"])
        results[mkt] = {"question": info["question"], "group": groups.get(mkt) or info.get("group"), "tick": tick,
                        "dailyPool": pool, "minSize": min_size, "maxSpread": v, "best": best, "grid": grid}

    out = run / "param-optimiser.json"
    agg = defaultdict(lambda: {"reward": 0.0, "adverse": 0.0, "capital": 0.0})
    for r in results.values():
        for key, g in r["grid"].items():
            agg[key]["reward"] += g["rewardUsdPerDay"]; agg[key]["adverse"] += g["adverseUsdPerDay"]; agg[key]["capital"] += g["capitalUsd"]
    grid_summary = {k: {**v, "net": v["reward"] + v["adverse"], "netPer100": (v["reward"] + v["adverse"]) / v["capital"] * 100 if v["capital"] else 0}
                    for k, v in agg.items()}
    best_total = {"markets": len(results), "netUsdPerDay": sum(r["best"]["netUsdPerDay"] for r in results.values()),
                  "capitalUsd": sum(r["best"]["capitalUsd"] for r in results.values())}
    json.dump({"run": str(run), "assumptions": __doc__, "gridSummary": grid_summary, "bestPerMarketTotal": best_total,
               "markets": results}, open(out, "w"), indent=1)
    print(json.dumps({"markets": len(results), "bestPerMarket": best_total,
                      "uniform": {k: {"net": round(v["net"], 2), "netPer100": round(v["netPer100"], 3)} for k, v in sorted(grid_summary.items())}}))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
