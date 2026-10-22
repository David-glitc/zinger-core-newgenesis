#!/usr/bin/env python3
"""Build an explanatory MM system and paper-replay report."""

from __future__ import annotations

import json
import textwrap
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch


ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "tmp/commercial-evidence/mm-execution-repair-20261016"
OUT = ROOT / "docs/reports/mm-evaluation-2026-10-16.pdf"
REPLAY = EVIDENCE / "continuation-05/mm-only-replay-20261016"

BG = "#0b1020"
PANEL = "#131b2e"
GRID = "#26334c"
TEXT = "#f2f5fb"
MUTED = "#a7b2c6"
RED = "#ff6978"
GREEN = "#56d6a0"
BLUE = "#74a7ff"
AMBER = "#ffc66d"


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def page(title: str, subtitle: str, number: int):
    fig = plt.figure(figsize=(13.3, 7.5), facecolor=BG)
    fig.text(0.055, 0.93, title, color=TEXT, fontsize=22, weight="bold")
    fig.text(0.056, 0.885, subtitle, color=MUTED, fontsize=10)
    fig.text(0.055, 0.035, "ZINGER  /  MM SYSTEM AND PAPER REPLAY  /  16 OCT 2026", color=MUTED, fontsize=7.5)
    fig.text(0.945, 0.035, f"{number} / 6", color=MUTED, fontsize=7.5, ha="right")
    return fig


def box(ax, x, y, w, h, title, body, edge=GRID, title_color=TEXT, body_color=MUTED, title_size=10, body_size=8.5):
    patch = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.012,rounding_size=0.012",
                           facecolor=PANEL, edgecolor=edge, linewidth=1.1, transform=ax.transAxes)
    ax.add_patch(patch)
    ax.text(x + .025, y + h - .08 * h, title, transform=ax.transAxes, color=title_color,
            fontsize=title_size, weight="bold", va="top")
    width_inches = ax.figure.get_figwidth() * ax.get_position().width * w
    line_width = max(18, int(width_inches * 72 / (body_size * .52)))
    wrapped = "\n".join(textwrap.fill(paragraph, width=line_width) if paragraph else ""
                         for paragraph in body.split("\n"))
    ax.text(x + .025, y + h - .38 * h, wrapped, transform=ax.transAxes, color=body_color,
            fontsize=body_size, va="top", linespacing=1.35)


def style(ax, ygrid=False):
    ax.set_facecolor(PANEL)
    ax.tick_params(colors=MUTED, labelsize=8)
    ax.xaxis.label.set_color(MUTED)
    ax.yaxis.label.set_color(MUTED)
    for spine in ax.spines.values():
        spine.set_color(GRID)
    ax.grid(axis="y" if ygrid else "x", color=GRID, linewidth=.8, alpha=.9)
    ax.set_axisbelow(True)


def main():
    c03 = load(EVIDENCE / "forward-capture-03/report.json")
    c03_comparison = load(EVIDENCE / "forward-capture-03/comparisons-provenance-v2/comparison.json")
    c04 = load(EVIDENCE / "continuation-04/report.json")
    replay = load(REPLAY / "comparison.json")
    replay_audits = {name: load(REPLAY / name / "independent-audit.json")
                     for name in ("ctf-touch-exact", "ctf-improve-through")}
    c05 = load(EVIDENCE / "continuation-05/report.json")
    post = load(EVIDENCE / "continuation-05/comparisons-placement-correction-01/comparison.json")

    assert replay["performanceClaimEligible"] is False and replay["actualSpendUsd"] == 0
    assert len(replay["variants"]) == 2 and replay["commonInputFrames"] > 0
    assert c04["performanceClaimEligible"] is False and c05["performanceClaimEligible"] is False
    assert all(a["status"] == "passed" and not a["finalValuationVerified"] for a in replay_audits.values())

    by_id = {v["id"]: v for v in replay["variants"]}
    source_by_id = {v["id"]: v for v in post["variants"]}
    # A replay must reproduce the preserved post-capture comparison before being presented.
    for key in ("ctf-touch-exact", "ctf-improve-through"):
        assert by_id[key]["fills"] == source_by_id[key]["fills"]
        assert abs(by_id[key]["realizedPnlUsd"] - source_by_id[key]["realizedPnlUsd"]) < 1e-8
        assert by_id[key]["liquidationPnlUsd"] is None

    with PdfPages(OUT, metadata={
        "Title": "Zinger Market Making System and Paper Replay",
        "Author": "Zinger research",
        "Subject": "Plain-language system description, execution rules and reproducible paper simulation",
    }) as pdf:
        # 1. Reader summary.
        fig = page("Zinger market making: system and results", "How the MM execution path works, which rules it follows, and what the paper evidence shows.", 1)
        cards = [
            ("LATEST MM MIDPOINT MARK", f"${c05['midPnlUsd']:+.2f}", "continuation 05; 25 cumulative receipts", RED),
            ("NEW MM-ONLY REPLAY", f"{replay['commonInputFrames']:,}", "recorded frames; two CTF quote policies", BLUE),
            ("REAL ORDERS / SPEND", "0 / $0", "all fills in this report are simulated", GREEN),
        ]
        for i, (label, value, detail, color) in enumerate(cards):
            x = .055 + i * .305
            box(ax := fig.add_axes([x, .69, .275, .14]), 0, 0, 1, 1, label, f"{value}\n{detail}", edge=GRID, title_color=MUTED, title_size=8, body_size=12 if i != 1 else 11)
            ax.set_axis_off()
        box(ax := fig.add_axes([.055, .30, .42, .31]), 0, 0, 1, 1, "What the system does",
            "It watches eligible Polymarket outcome books and places passive BUY and SELL quotes.\n\n"
            "It can quote both outcomes, but treats them as one portfolio: buys share a capital cap, sells need inventory, and paired asks must retain a complete-set cost reserve.\n\n"
            "It uses recent book prices and volatility to set a cautious quote center and width. It does not use a Gaussian process or a trained probability forecast.", edge="#3b4962", body_size=9)
        ax.set_axis_off()
        box(ax := fig.add_axes([.51, .30, .435, .31]), 0, 0, 1, 1, "What the latest evidence says",
            f"Continuation 04: 9 cumulative simulated fill receipts; midpoint P/L {c04['midPnlUsd']:+.2f}; final liquidation value unavailable.\n\n"
            f"Continuation 05: 25 cumulative receipts; midpoint P/L {c05['midPnlUsd']:+.2f}; original audit failed a stale-book placement check.\n\n"
            "The new replay also remains negative and lacks verified liquidation. No result demonstrates a positive MM edge.", edge="#64343d", body_size=9)
        ax.set_axis_off()
        fig.text(.055, .17, "This is a paper system. The research MM path has no funded CLOB order adapter; zero funds were spent.", color=AMBER, fontsize=10, weight="bold")
        fig.text(.055, .12, "Evidence sources: MM forward captures 03-05, replay journals and independent audit files under tmp/commercial-evidence/.", color=MUTED, fontsize=7.5)
        pdf.savefig(fig, facecolor=BG, bbox_inches="tight"); plt.close(fig)

        # 2. Architecture and lifecycle.
        fig = page("The MM path, from public book to paper fill", "Every arrow is an explicit stage; a quote intent is not an exchange order.", 2)
        ax = fig.add_axes([.055, .12, .89, .70]); ax.set_axis_off()
        steps = [
            (.015, .58, "1  Discover", "Find two-outcome markets with usable identity, fee, lifecycle and real two-sided depth."),
            (.215, .58, "2  Confirm books", "Track both outcome books, timestamps and revisions. Reject stale, crossed or unhealthy depth."),
            (.415, .58, "3  Plan quotes", "Estimate a reference and short-run volatility. Choose passive bids/asks and inventory skew."),
            (.615, .58, "4  Reserve risk", "Apply cash, market, event, portfolio, complete-set and net-outcome limits."),
            (.815, .58, "5  Simulate", "Model queue, latency, prints, fees, splits, merges, inventory and cancellations."),
        ]
        for x, y, title, body in steps:
            box(ax, x, y, .17, .24, title, body, body_size=7.2, title_size=9)
        for i in range(4):
            ax.add_patch(FancyArrowPatch((steps[i][0]+.171, .845), (steps[i+1][0]-.006, .845), arrowstyle="-|>", mutation_scale=12, color=BLUE, linewidth=1.1, transform=ax.transAxes))
        lower = [
            (.715, .17, "6  Record evidence", "Append quote, print, fill, cash, inventory, merge and cancel events to a sequenced journal."),
            (.415, .17, "7  Audit independently", "Rebuild depth, fills, exposure and cash from the journal; challenge final marks against public books."),
            (.115, .17, "8  Report honestly", "Show realized cash, midpoint equity and executable liquidation separately. Missing marks stay unavailable."),
        ]
        for x, y, title, body in lower:
            box(ax, x, y, .23, .25, title, body, edge="#3b4962", body_size=7.5, title_size=9)
        for start, end in [((.90,.57),(.83,.44)),((.715,.295),(.645,.295)),((.415,.295),(.345,.295))]:
            ax.add_patch(FancyArrowPatch(start, end, arrowstyle="-|>", mutation_scale=12, color=AMBER, linewidth=1.1, transform=ax.transAxes))
        fig.text(.07, .12, "Execution boundary: the research MM simulator never signs, submits or cancels a funded CLOB order.", color=AMBER, fontsize=9, weight="bold")
        pdf.savefig(fig, facecolor=BG, bbox_inches="tight"); plt.close(fig)

        # 3. Strategy and hard controls.
        fig = page("How the system decides what to quote", "The active MM policy is a book-and-inventory heuristic with hard execution gates, not an ML probability model.", 3)
        box(ax := fig.add_axes([.055, .49, .43, .31]), 0, 0, 1, 1, "Quote reference and width",
            "Reference = 80% book midpoint + 20% size-weighted microprice.\n\n"
            "Recent midpoint changes estimate sigma. Quote width grows with fees, a per-share reserve, volatility and quote lifetime.\n\n"
            "Inventory shifts the quote center to discourage adding more to the heavier outcome. This is a descriptive pricing heuristic, not a forecast of settlement probability.", edge="#3b4962", body_size=8.6)
        ax.set_axis_off()
        box(ax := fig.add_axes([.515, .49, .43, .31]), 0, 0, 1, 1, "Before any quote can be placed",
            "Require a usable book no older than 1,500 ms; both paired books must be synchronized.\n\n"
            "Pause if spread is crossed or wider than 12 cents, if the short history is missing/gapped, near the event cutoff, or after a 3-cent move in 5 seconds.\n\n"
            "Recheck freshness at placement. The original continuation 05 missed this last check once; the candidate fix is not retroactively applied.", edge="#64343d", body_size=8.4)
        ax.set_axis_off()
        limits = [
            ("Capital", "$100 portfolio; $10 per market; $20 per event"),
            ("Order / inventory", "5 shares max per order; 20 net outcome shares"),
            ("Timing", "10-second client quote lease; modeled 250 ms activation and cancel delay"),
            ("Lifecycle", "Funded paired inventory; 1-cent assumed split/merge cost; event buffer"),
            ("Loss / fills", "$50 loss stop when valued; same-price queue; exact-price vs through fills"),
        ]
        ax = fig.add_axes([.075, .17, .86, .23]); ax.set_axis_off()
        ax.text(.01, .97, "PAPER CONFIGURATION USED IN THE ONE-HOUR REPLAY", transform=ax.transAxes, color=AMBER, fontsize=8, weight="bold", va="top")
        for i, (k,v) in enumerate(limits):
            y=.78-i*.16
            ax.text(.02,y,k,transform=ax.transAxes,color=TEXT,fontsize=8.5,weight="bold",va="center")
            ax.text(.22,y,v,transform=ax.transAxes,color=MUTED,fontsize=8.5,va="center")
            ax.plot([.01,.99],[y-.07,y-.07],color=GRID,lw=.6,transform=ax.transAxes)
        fig.text(.055, .11, "Books and tape are public inputs. Paper queue priority, flow attribution, cancellation timing and fills are model assumptions.", color=MUTED, fontsize=8)
        pdf.savefig(fig, facecolor=BG, bbox_inches="tight"); plt.close(fig)

        # 4. Newly run offline replay.
        fig = page("New MM-only replay: two CTF quote policies", "Post-capture counterfactual replay on continuation 05, with the placement-freshness correction applied.", 4)
        exact = by_id["ctf-touch-exact"]
        through = by_id["ctf-improve-through"]
        ax = fig.add_axes([.08, .27, .48, .47]); style(ax, ygrid=True)
        labels = ["CTF touch / exact", "CTF improve / through"]
        realized = [exact["realizedPnlUsd"], through["realizedPnlUsd"]]
        bars = ax.bar(np.arange(2), realized, color=[BLUE, AMBER], width=.52)
        ax.axhline(0,color=TEXT,lw=.8,alpha=.7); ax.set_xticks(np.arange(2), labels, color=MUTED)
        ax.set_ylabel("Realized P/L (USD)"); ax.set_ylim(min(realized)-.6, .3)
        for b,v in zip(bars,realized): ax.text(b.get_x()+b.get_width()/2,v-.08,f"${v:+.2f}",ha="center",va="top",color=TEXT,fontsize=10,weight="bold")
        box(ax := fig.add_axes([.62,.56,.32,.20]),0,0,1,1,"Same account, same captured tape",
            f"Opening cash: ${replay['openingCashUsd']:,.2f}, plus inherited inventory.\n{replay['commonInputFrames']:,} common decision frames.\nEach variant has its own replay ledger.",edge="#3b4962",body_size=8.5)
        ax.set_axis_off()
        box(ax := fig.add_axes([.62,.32,.32,.20]),0,0,1,1,"Interpretation",
            f"Touch/exact: {exact['quotes']:,} quotes, {exact['fills']} cumulative receipts; realized ${exact['realizedPnlUsd']:+.2f}; midpoint unavailable.\n\nImprove/through: {through['quotes']:,} quotes, {through['fills']} receipts; realized ${through['realizedPnlUsd']:+.2f}; midpoint ${through['midPnlUsd']:+.2f}.\n\nBoth accounting/risk audits passed; neither liquidation is verified.",edge="#574a34",body_size=7.3)
        ax.set_axis_off()
        fig.text(.08,.16,"The original continuation 05 audit failed because one quote was placed on a 1,527 ms book; the limit is 1,500 ms. This replay rejects stale-at-placement intents.",color=AMBER,fontsize=8.2)
        fig.text(.08,.12,"Replay is post-capture diagnostic evidence, not a new forward test. The price-through fill rule assumes aggressive flow remains available.",color=MUTED,fontsize=7.5)
        pdf.savefig(fig,facecolor=BG,bbox_inches="tight"); plt.close(fig)

        # 5. Results across forward captures and diagnostic replays.
        fig = page("MM-only results across the paper sessions", "Quote volume grew, but complete, independently valued trading cycles did not.", 5)
        ax = fig.add_axes([.08,.28,.43,.47]); style(ax, ygrid=True)
        values=[c04["midPnlUsd"],c05["midPnlUsd"]]
        labels=["Continuation 04\nmidpoint mark","Continuation 05\nmidpoint mark"]
        ax.clear(); style(ax, ygrid=True)
        bars=ax.bar(np.arange(2),values,color=[AMBER,RED],width=.56)
        ax.axhline(0,color=TEXT,lw=.8,alpha=.7); ax.set_xticks(np.arange(2),labels,color=MUTED); ax.set_ylabel("Midpoint P/L (USD)")
        ax.set_ylim(min(values)-2,2)
        for b,v in zip(bars,values): ax.text(b.get_x()+b.get_width()/2,v-.35,f"${v:,.2f}",ha="center",va="top",color=TEXT,fontsize=9,weight="bold")
        c03_variants={v["id"]:v for v in c03_comparison["variants"]}
        box(ax := fig.add_axes([.56,.57,.39,.19]),0,0,1,1,"MM forward run facts",
            f"Forward 03: {c03['quotesPlaced']:,} quotes, {c03['simulatedFills']} receipts; two strict controls exited at -$0.60.\nContinuation 04: {c04['quotesPlaced']:,} quotes, {c04['simulatedFills']} cumulative receipts; midpoint -$1.97.\nContinuation 05: {c05['quotesPlaced']:,} quotes, {c05['simulatedFills']} receipts; midpoint -$9.47; original audit failed stale placement.",edge="#3b4962",body_size=7.7)
        ax.set_axis_off()
        diag = post["variants"]
        diag_good=sum(v["id"] in {"direct-touch-exact","direct-improve-through","ctf-touch-exact","ctf-improve-exact","ctf-improve-through","ctf-improve-through-slower"} and v["liquidationPnlUsd"] is None for v in diag)
        box(ax := fig.add_axes([.56,.33,.39,.19]),0,0,1,1,"Six post-capture diagnostics",
            "Four passed journal/risk/depth checks; two failed REST book-confirmation provenance.\n\n"
            "All six lack verified final liquidation and actual execution. They are replay diagnostics, not replacement forward trials.",edge="#64343d",body_size=8.3)
        ax.set_axis_off()
        fig.text(.08,.16,"Midpoint P/L is a mark, not cash available from selling inventory. Final liquidation is unavailable for continuation 04 and 05.",color=AMBER,fontsize=8.5)
        fig.text(.08,.12,"Positive realized P/L in a partial ledger cannot override a negative midpoint mark or missing executable exit value.",color=MUTED,fontsize=8)
        pdf.savefig(fig,facecolor=BG,bbox_inches="tight"); plt.close(fig)

        # 6. Evidence gates and honest conclusion.
        fig = page("What must pass before we claim a market-making edge", "Current paper evidence is useful for debugging execution; it is not yet a performance record.", 6)
        gates = [
            ("1  Repeatable fills", "At least 30 completed round trips across 10 independent market windows."),
            ("2  Account integrity", "Complete journal, cash, holdings, fees, reservations, merges and cancels reconcile independently."),
            ("3  Executable exits", "Fresh public depth supports legal full-size exits; liquidation P/L is independently verified."),
            ("4  Robust edge", "Positive clustered 95% lower bound after fees, adverse selection, slower latency and extra costs."),
            ("5  Operations", "Funded lifecycle, user-channel fills, cancel acknowledgments, restart recovery and compliance gates."),
        ]
        ax=fig.add_axes([.06,.25,.58,.53]); ax.set_axis_off()
        for i,(title,body) in enumerate(gates):
            y=.91-i*.19
            box(ax,.01,y-.13,.97,.15,title,body,edge="#3b4962",title_size=9,body_size=8)
        box(ax := fig.add_axes([.68,.51,.27,.27]),0,0,1,1,"Current decision",
            "No demonstrated positive MM edge.\n\nNo live MM orders were sent.\n\nDo not treat quote count, software tests or modeled fills as traction.",edge=RED,title_color=RED,body_size=9)
        ax.set_axis_off()
        box(ax := fig.add_axes([.68,.22,.27,.23]),0,0,1,1,"Known system gaps",
            "No funded MM adapter; real queue and execution unverified; liquidation marks missing; continuation 05 audit failed; new freshness fix has no forward trial yet.",edge="#64343d",body_size=8.2)
        ax.set_axis_off()
        fig.text(.06,.15,"The system’s research path is understandable and testable. The next evidence needed is clean forward paper execution with verified liquidation, not a new marketing claim.",color=AMBER,fontsize=8.5)
        fig.text(.06,.11,"Source notes: docs/MM_EXECUTION_REPAIR_2026-10-16.md, docs/MM_LIVE_READINESS_2026-10-16.md, docs/MM_QUOTE_LIFECYCLE_2026-10-16.md and preserved JSON journals/reports.",color=MUTED,fontsize=7.3)
        pdf.savefig(fig,facecolor=BG,bbox_inches="tight"); plt.close(fig)

    print(f"Wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
