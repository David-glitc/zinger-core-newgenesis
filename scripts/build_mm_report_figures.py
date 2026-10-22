"""Build clean figures for the Polymarket MM report from recorded run data."""
import json, pathlib
from collections import defaultdict
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/reports/figures"
OUT.mkdir(parents=True, exist_ok=True)
RUN = ROOT / "tmp/commercial-evidence/mm-reward-projection/2026-10-18T21-07-24-302Z"
TRIAGE = ROOT / "tmp/commercial-evidence/mm-triage/reward-triage-2026-10-18T2002.json"
CAPTURE = ROOT / "tmp/commercial-evidence/mm-forward-lease-20261018/capture/report.json"

NAVY, TEAL, GREY, RED, GOLD = "#1f3a5f", "#2a9d8f", "#8d99ae", "#c8553d", "#e9c46a"
plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 10, "axes.spines.top": False, "axes.spines.right": False,
    "axes.edgecolor": "#444", "axes.titleweight": "bold", "axes.titlesize": 12, "axes.titlelocation": "left",
    "figure.dpi": 150, "savefig.dpi": 300, "savefig.bbox": "tight",
})

def save(fig, name):
    fig.savefig(OUT / f"{name}.png"); plt.close(fig)

# ---- Data: 60-minute stub run --------------------------------------------
recs = [json.loads(l) for l in open(RUN / "samples.jsonl")]
samples = [r for r in recs if "share" in r]
pools = {m["id"]: m for m in json.load(open(RUN / "markets.json"))}
by = defaultdict(list)
for r in samples: by[r["market"]].append(r)
rows = []
for k, v in by.items():
    share = np.mean([x["share"] for x in v])
    pool = pools[k]["dailyPool"]
    minsize = v[0]["minSize"]
    price = np.mean([(x["bestBid"] + x["bestAsk"]) / 2 for x in v])
    capital = minsize * price * 2
    name = v[0]["question"]
    rows.append(dict(name=name, share=share, pool=pool, usd=share * pool, minsize=minsize, capital=capital, per100=share * pool / capital * 100))
rows.sort(key=lambda r: -r["usd"])
import textwrap
short = lambda s: "\n".join(textwrap.wrap(s, 34))

# Fig 1: projected reward by market (USD/day)
fig, ax = plt.subplots(figsize=(7.5, 5.0))
names = [short(r["name"]) for r in rows][::-1]
vals = [r["usd"] for r in rows][::-1]
ax.barh(names, vals, color=NAVY)
for i, v in enumerate(vals): ax.text(v + 0.01, i, f"${v:.3f}", va="center", fontsize=8.5, color="#333")
ax.set_xlabel("Projected reward (USD per day, mean of minute samples)")
ax.set_title("Projected maker reward by market, 60-minute stub run")
ax.set_xlim(0, max(vals) * 1.25)
save(fig, "fig1_reward_by_market")

# Fig 2: reward per $100 of capital (ranking for capital allocation)
fig, ax = plt.subplots(figsize=(7.5, 4.2))
ordered = sorted(rows, key=lambda r: -r["per100"])
names = [short(r["name"]) for r in ordered][::-1]
vals = [r["per100"] for r in ordered][::-1]
colors = [TEAL if v >= 0.4 else GREY for v in vals]
ax.barh(names, vals, color=colors)
for i, v in enumerate(vals): ax.text(v + 0.01, i, f"{v:.2f}%", va="center", fontsize=8.5, color="#333")
ax.axvline(1.37, color=RED, ls="--", lw=1.2)
ax.text(1.38, -0.9, "10%/week needs 1.37%/day", color=RED, fontsize=8.5, ha="right")
ax.set_xlabel("Reward per day, % of capital at minimum size (both sides)")
ax.set_title("Return on capital by market (before adverse selection)")
ax.set_xlim(0, 1.8)
save(fig, "fig2_return_on_capital")

# Fig 3: size sweep (linear in size, capital scales with it)
mult = np.array([1, 2, 5, 10])
base = sum(r["usd"] for r in rows)
capital = sum(r["capital"] for r in rows)
fig, ax1 = plt.subplots(figsize=(7.5, 3.8))
ax1.bar(mult.astype(str), base * mult, color=NAVY, width=0.55, label="Reward (USD/day)")
for i, m in enumerate(mult): ax1.text(i, base * m + 0.2, f"${base*m:.2f}", ha="center", fontsize=9)
ax1.set_ylabel("Reward (USD/day)")
ax1.set_xlabel("Order size, multiple of minimum")
ax2 = ax1.twinx(); ax2.spines["right"].set_visible(True)
ax2.plot(mult.astype(str), capital * mult, color=RED, marker="o", lw=2, label="Capital tied up (USD)")
ax2.set_ylabel("Capital tied up (USD)", color=RED)
ax1.set_title("Reward and capital both scale linearly with order size")
save(fig, "fig3_size_sweep")

# Fig 4: 10%/week target versus measured rates
fig, ax = plt.subplots(figsize=(7.5, 3.6))
labels = ["Blended, 8 markets", "Best single market\n(Fed rates)", "Required for\n10% per week"]
blended = sum(r["usd"] for r in rows) / capital * 100
best = max(r["per100"] for r in rows)
vals = [blended, best, 1.37]
cols = [GREY, TEAL, RED]
bars = ax.bar(labels, vals, color=cols, width=0.55)
for b, v in zip(bars, vals): ax.text(b.get_x() + b.get_width() / 2, v + 0.03, f"{v:.2f}%/day", ha="center", fontsize=9)
ax.set_ylabel("% of capital per day (before adverse selection)")
ax.set_title("The 10%-per-week target is about 14× the blended reward rate")
save(fig, "fig4_target_gap")

# ---- Data: reward-band triage (single snapshot) ---------------------------
tri = json.load(open(TRIAGE))["rows"]
fig, ax = plt.subplots(figsize=(7.5, 4.2))
x = np.array([r["rewardsMaxSpreadCents"] for r in tri])
y = np.array([r["spreadTicks"] for r in tri])
s = np.clip(np.array([r["volume24hr"] for r in tri]) / 4000, 8, 400)
v = np.array([r["volume24hr"] for r in tri])
sc = ax.scatter(x + np.random.default_rng(1).uniform(-0.15, 0.15, len(x)), y, s=s, c=np.log10(v + 1), cmap="viridis", alpha=0.75, edgecolor="white", lw=0.4)
cb = fig.colorbar(sc, ax=ax, shrink=0.8); cb.set_label("log10 24h volume (USD)")
ax.set_xlabel("Reward band (cents from midpoint)"); ax.set_ylabel("Current spread (ticks)")
ax.set_title(f"{sum(1 for r in tri if r['spreadTicks']<=2)} of {len(tri)} rewarded markets are two ticks or tighter")
ax.text(0.99, 0.02, "bubble size and colour = 24h volume", transform=ax.transAxes, ha="right", fontsize=8, color="#555")
save(fig, "fig5_band_vs_spread")

# ---- Data: forward capture (lease experiment, control arm) ----------------
cap = json.load(open(CAPTURE))
fig, axes = plt.subplots(1, 2, figsize=(8.5, 3.6), gridspec_kw={"width_ratios": [1.3, 1]})
ax = axes[0]
labels = ["Quotes\nplaced", "Quotes\ncancelled", "Simulated\nfills", "Prints\nseen"]
vals = [cap["quotesPlaced"], cap["quotesCancelled"], cap["simulatedFills"], cap["printsSeen"]]
bars = ax.bar(labels, vals, color=[NAVY, GREY, RED, TEAL], width=0.6)
for b, v in zip(bars, vals): ax.text(b.get_x() + b.get_width() / 2, v + 40, f"{v:,}", ha="center", fontsize=9)
ax.set_title("Forward paper capture, one hour")
ax.set_yscale("symlog", linthresh=10)
ax = axes[1]
pl = {"Mid": cap["midPnlUsd"], "Liquidation": cap["liquidationPnlUsd"], "Realised": cap["realizedPnlUsd"]}
ax.bar(list(pl.keys()), list(pl.values()), color=[GREY, RED, TEAL], width=0.55)
for i, v in enumerate(pl.values()): ax.text(i, v - 0.12 if v < 0 else v + 0.05, f"${v:.2f}", ha="center", fontsize=9)
ax.axhline(0, color="#333", lw=0.8)
ax.set_title("P/L by measure (USD)")
fig.tight_layout()
save(fig, "fig6_forward_capture")

# ---- Pipeline diagram ------------------------------------------------------
from matplotlib.patches import FancyBboxPatch
fig, ax = plt.subplots(figsize=(8.5, 2.6)); ax.axis("off"); ax.set_xlim(0, 10); ax.set_ylim(0, 3)
steps = [("Public data\nGamma · CLOB · trades", NAVY), ("Market filter\nreward band · depth\nthin-book floor", TEAL),
         ("Stub quotes\nno orders · no keys", GREY), ("Scoring\nreward share · fills\nmarkouts", TEAL), ("Report\nJSON · CSV · PDF", NAVY)]
for i, (t, col) in enumerate(steps):
    x0 = 0.1 + i * 2.0
    ax.add_patch(FancyBboxPatch((x0, 0.6), 1.7, 1.8, boxstyle="round,pad=0.04,rounding_size=0.12", fc=col, ec="none", alpha=0.92))
    ax.text(x0 + 0.85, 1.5, t, ha="center", va="center", color="white", fontsize=8.2)
    if i < len(steps) - 1: ax.annotate("", xy=(x0 + 2.0, 1.5), xytext=(x0 + 1.72, 1.5), arrowprops=dict(arrowstyle="->", color="#444", lw=1.2))
ax.set_title("Measurement pipeline: read-only, paper, no order path", loc="left", fontsize=11, fontweight="bold")
save(fig, "fig0_pipeline")
print("figures:", sorted(p.name for p in OUT.glob("*.png")))
print("totals: usd/day", round(base, 3), "capital", round(capital), "blended %/day", round(blended, 3), "best %/day", round(best, 3))
