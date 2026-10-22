"""Charts for scripts/mm_param_optimiser.py output. Usage: python3 scripts/plot_param_optimiser.py <param-optimiser.json> <out-prefix>"""
import json, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

NAVY, TEAL, GREY, RED = "#1f3a5f", "#2a9d8f", "#8d99ae", "#c8553d"
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.spines.top": False, "axes.spines.right": False,
                     "axes.titleweight": "bold", "axes.titlelocation": "left", "savefig.dpi": 200, "savefig.bbox": "tight"})
o = json.load(open(sys.argv[1])); pre = sys.argv[2]
offs, mults = [0, 1, 2, 3], [1, 2, 4]

for group in ("deep", "thin"):
    mk = [m for m in o["markets"].values() if (m.get("group") or "deep") == group]
    if not mk:
        continue
    net = np.zeros((len(offs), len(mults))); cap = np.zeros_like(net)
    for m in mk:
        for i, k in enumerate(offs):
            for j, s in enumerate(mults):
                g = m["grid"].get(f"{k}:{s}")
                if g: net[i, j] += g["netUsdPerDay"]; cap[i, j] += g["capitalUsd"]
    per100 = np.divide(net, cap, out=np.zeros_like(net), where=cap > 0) * 100
    fig, ax = plt.subplots(figsize=(5.8, 3.8))
    im = ax.imshow(per100, cmap="RdYlGn", aspect="auto", vmin=-max(abs(per100).max(), 1e-9), vmax=max(abs(per100).max(), 1e-9))
    for i in range(len(offs)):
        for j in range(len(mults)):
            ax.text(j, i, f"{per100[i, j]:.2f}%\n${net[i, j]:.2f}", ha="center", va="center", fontsize=8)
    ax.set_xticks(range(len(mults))); ax.set_xticklabels([f"{s}x min" for s in mults])
    ax.set_yticks(range(len(offs))); ax.set_yticklabels([f"{k} tick{'s' if k != 1 else ''} back" for k in offs])
    ax.set_title(f"{group.capitalize()} markets ({len(mk)}): net per $100 per day, and $ per day")
    fig.colorbar(im, ax=ax, shrink=0.8, label="net % of capital per day")
    fig.savefig(f"{pre}-heatmap-{group}.png"); plt.close(fig)

rows = sorted(o["markets"].values(), key=lambda m: -m["best"]["netUsdPerDay"])[:20]
fig, ax = plt.subplots(figsize=(8.5, 6))
y = np.arange(len(rows))
ax.barh(y, [m["best"]["rewardUsdPerDay"] for m in rows], color=TEAL, label="Reward")
ax.barh(y, [min(0, m["best"]["adverseUsdPerDay"]) for m in rows], color=RED, label="Adverse fills (conservative)")
for i, m in enumerate(rows):
    b = m["best"]
    ax.text(max(b["rewardUsdPerDay"], 0) + 0.05, i, f"net ${b['netUsdPerDay']:.2f}/d  off{b['offsetTicks']} x{b['sizeMult']}  cap ${b['capitalUsd']:.0f}  [{m.get('group') or '?'}]", va="center", fontsize=7)
ax.set_yticks(y); ax.set_yticklabels([m["question"][:42] for m in rows], fontsize=7.5); ax.invert_yaxis()
ax.axvline(0, color="#333", lw=0.8); ax.set_xlabel("USD per day at each market's best setting")
ax.set_title("Top 20 markets at their best offset and size"); ax.legend(frameon=False, loc="lower right", fontsize=8)
fig.savefig(f"{pre}-top-markets.png"); plt.close(fig)
print("charts written")
