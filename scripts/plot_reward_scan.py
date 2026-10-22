"""Charts for the full reward-market scan and the running recording.
Usage: python3 scripts/plot_reward_scan.py <scan.json> <recording-dir> <out-prefix>"""
import json, sys
from collections import defaultdict
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

NAVY, TEAL, GREY, RED, GOLD = "#1f3a5f", "#2a9d8f", "#8d99ae", "#c8553d", "#e9c46a"
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.spines.top": False, "axes.spines.right": False,
                     "axes.titleweight": "bold", "axes.titlelocation": "left", "savefig.dpi": 200, "savefig.bbox": "tight"})
scan = json.load(open(sys.argv[1])); rec = sys.argv[2]; pre = sys.argv[3]
v = lambda c, k: c["triage"].get(k) or 0

# 1. Funnel: from all reward markets to scored, by reason removed.
rej = scan["rejected"]
steps = [("Reward-eligible markets", scan["rewardMarkets"])]
left = scan["rewardMarkets"]
labels = {"small_pool": "Pool under $5/day", "sports_event": "Sports / live events", "ends_too_soon": "Ends within 7 days",
          "touch_outside_band": "Spread wider than reward band", "extreme_price": "Price below 0.10 or above 0.90",
          "empty_book": "Empty book", "not_open": "Not open", "reward_min_size_too_large": "Reward minimum > 1,000 shares"}
for k, n in sorted(rej.items(), key=lambda x: -x[1]):
    left -= n; steps.append((f"− {labels.get(k, k)}", n))
fig, ax = plt.subplots(figsize=(8, 4.2))
names = [s[0] for s in steps] + ["Scored", "  of which thin books", "  of which non-thin"]
vals = [s[1] for s in steps] + [scan["scored"], scan["thin"], scan["scored"] - scan["thin"]]
cols = [NAVY] + [GREY] * (len(steps) - 1) + [TEAL, GOLD, TEAL]
y = np.arange(len(names))
ax.barh(y, vals, color=cols)
for i, n in enumerate(vals): ax.text(n + 80, i, f"{n:,}", va="center", fontsize=8)
ax.set_yticks(y); ax.set_yticklabels(names, fontsize=8.5); ax.invert_yaxis()
ax.set_xlabel("Markets"); ax.set_title(f"From {scan['rewardMarkets']:,} reward markets (${scan['totalDailyPoolUsd']:,}/day in pools) to {scan['scored']:,} scored")
fig.savefig(f"{pre}-funnel.png"); plt.close(fig)

# 2. Pool vs competition, coloured by group, sized by projected $/day.
c = scan["candidates"]
fig, ax = plt.subplots(figsize=(8, 4.8))
for group, col, lab in ((False, TEAL, "Non-thin"), (True, GOLD, "Thin book")):
    pts = [x for x in c if x["triage"]["thin"] == group]
    comp = [max(1, min(x["triage"]["competitionBid"], x["triage"]["competitionAsk"])) for x in pts]
    pool = [x["rewards"]["dailyPoolUsd"] for x in pts]
    size = [min(300, 8 + 40 * v(x, "estUsdPerDay")) for x in pts]
    ax.scatter(comp, pool, s=size, c=col, alpha=0.5, edgecolor="white", lw=0.4, label=f"{lab} ({len(pts):,})")
ax.axvline(10_000, color=RED, ls="--", lw=1); ax.text(10_500, ax.get_ylim()[1] * 0.6 if ax.get_ylim()[1] > 0 else 1, "thin-book floor", color=RED, fontsize=8)
ax.set_xscale("log"); ax.set_yscale("log")
ax.set_xlabel("Competing reward score inside the band (smaller side, log)"); ax.set_ylabel("Daily reward pool, USD (log)")
ax.set_title("Where the reward is: big pools with little competition sit top-left"); ax.legend(frameon=False, fontsize=8, markerscale=0.6)
fig.savefig(f"{pre}-pool-vs-competition.png"); plt.close(fig)

# 3. Capital efficiency frontier: cumulative $/day against cumulative capital, best markets first.
fig, ax = plt.subplots(figsize=(8, 4.2))
for group, col, lab in ((False, TEAL, "Non-thin"), (True, GOLD, "Thin book (unverified)")):
    pts = sorted([x for x in c if x["triage"]["thin"] == group], key=lambda x: -v(x, "estUsdPerDayPer100"))[:100]
    cap = np.cumsum([v(x, "capitalUsd") for x in pts]); usd = np.cumsum([v(x, "estUsdPerDay") for x in pts])
    ax.plot(cap, usd, color=col, lw=2, label=lab)
    for n in (10, 40, 100):
        if len(pts) >= n: ax.annotate(f"{n} mkts: ${usd[n-1]:.0f}/d on ${cap[n-1]:,.0f}", (cap[n-1], usd[n-1]), fontsize=7, xytext=(5, -10), textcoords="offset points", color=col)
ax.set_xlabel("Capital at minimum size, both sides (USD)"); ax.set_ylabel("Projected reward, USD per day")
ax.set_yscale("symlog", linthresh=1); ax.legend(frameon=False, fontsize=8)
ax.set_title("Projected reward as capital is added, best markets first (single snapshot)")
fig.savefig(f"{pre}-frontier.png"); plt.close(fig)

# 4. Recording so far: projected reward per minute by group, and competition stability on thin markets.
samples = [json.loads(l) for l in open(f"{rec}/samples.jsonl")]
markets = {m["id"]: m for m in json.load(open(f"{rec}/markets.json"))}
by_t = defaultdict(lambda: {"deep": 0.0, "thin": 0.0})
comp_t = defaultdict(list)
for s in samples:
    if "share" not in s: continue
    g = markets.get(s["market"], {}).get("group") or "deep"
    by_t[s["at"]][g] += (s.get("projectedUsd") or 0) * 1440
    if g == "thin" and s.get("competitionBid") is not None: comp_t[s["at"]].append(min(s["competitionBid"], s["competitionAsk"]))
ts = sorted(by_t); t0 = ts[0] if ts else 0
fig, (a1, a2) = plt.subplots(1, 2, figsize=(10, 3.6))
a1.plot([(t - t0) / 60000 for t in ts], [by_t[t]["deep"] for t in ts], color=TEAL, label="Non-thin (40)")
a1.plot([(t - t0) / 60000 for t in ts], [by_t[t]["thin"] for t in ts], color=GOLD, label="Thin (40)")
a1.set_yscale("symlog", linthresh=1); a1.set_xlabel("Minutes since start"); a1.set_ylabel("Projected reward, USD/day (rate)")
a1.set_title("Projected reward rate, recording so far"); a1.legend(frameon=False, fontsize=8)
tt = sorted(comp_t)
a2.plot([(t - t0) / 60000 for t in tt], [np.median(comp_t[t]) for t in tt], color=GOLD)
a2.set_xlabel("Minutes since start"); a2.set_ylabel("Median competing score (thin markets)")
a2.set_title("Is competition staying thin?")
fig.tight_layout(); fig.savefig(f"{pre}-recording.png"); plt.close(fig)
print("charts written", len(ts), "minutes recorded")
