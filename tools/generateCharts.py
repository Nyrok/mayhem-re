#!/usr/bin/env python3
"""
generateCharts.py — Generate matplotlib charts for the Mayhem report.

Reads docs/rapport/report_data.json and produces ~8 PNG figures in docs/rapport/figures/.

Usage: python3 tools/generateCharts.py
"""

import json
import os
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.ticker as ticker
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(ROOT, 'docs', 'rapport', 'report_data.json')
FIG_DIR = os.path.join(ROOT, 'docs', 'rapport', 'figures')
os.makedirs(FIG_DIR, exist_ok=True)

# ── Style ──────────────────────────────────────────────────────────────────

PRIMARY = '#003366'
ACCENT = '#0066CC'
RED = '#CC3333'
GREEN = '#339933'
ORANGE = '#CC6600'
GRAY = '#666666'

plt.rcParams.update({
    'font.family': 'Helvetica Neue',
    'font.size': 9,
    'axes.titlesize': 11,
    'axes.labelsize': 10,
    'axes.edgecolor': PRIMARY,
    'axes.labelcolor': PRIMARY,
    'xtick.color': GRAY,
    'ytick.color': GRAY,
    'figure.facecolor': 'white',
    'axes.facecolor': 'white',
    'axes.grid': True,
    'grid.alpha': 0.3,
    'grid.color': '#CCCCCC',
})

FIGSIZE = (7, 4)  # ~17cm wide at 300 DPI
DPI = 300


def save(fig, name):
    path = os.path.join(FIG_DIR, name)
    fig.savefig(path, dpi=DPI, bbox_inches='tight', facecolor='white')
    plt.close(fig)
    print(f'  Saved {name}')


# ── Chart 1: Bonding curve price vs trade (3 scenarios) ───────────────────

def chart_bonding_curve(data):
    scenarios = data['bondingCurveScenarios']
    fig, ax = plt.subplots(figsize=FIGSIZE)

    for key, label, color, ls in [
        ('allBuy', 'Tous achats', GREEN, '-'),
        ('allSell', 'Tous ventes (après 10 achats)', RED, '-'),
        ('random5050', 'Random 50/50', ACCENT, '--'),
    ]:
        pts = scenarios[key]
        trades = [p['trade'] for p in pts]
        prices = [p['price'] for p in pts]
        ax.plot(trades, prices, color=color, linestyle=ls, linewidth=1.5, label=label)

    ax.set_xlabel('Numéro de trade')
    ax.set_ylabel('Prix (lamports/token × 10⁹)')
    ax.set_title('Courbe de prix selon le scénario de trading', color=PRIMARY, fontweight='bold')
    ax.legend(loc='upper left', framealpha=0.9)
    ax.ticklabel_format(style='scientific', axis='y', scilimits=(0, 0))
    fig.tight_layout()
    save(fig, '01_bonding_curve_price.png')


# ── Chart 2: dipAccumulator P&L distribution ──────────────────────────────

def chart_dipaccum_pnl(data):
    pnls = data['strategyStats'].get('dipAccumulator', {}).get('pnlDistribution', [])
    if not pnls:
        return

    fig, ax = plt.subplots(figsize=FIGSIZE)
    bins = np.arange(min(pnls) - 2, max(pnls) + 2, 2)
    colors = [GREEN if x > 0 else RED for x in bins[:-1]]

    n, _, patches = ax.hist(pnls, bins=bins, edgecolor='white', linewidth=0.5)
    for patch, b in zip(patches, bins[:-1]):
        patch.set_facecolor(GREEN if b >= 0 else RED)
        patch.set_alpha(0.8)

    ax.axvline(0, color=PRIMARY, linewidth=1, linestyle='--', alpha=0.7)
    mean_pnl = np.mean(pnls)
    ax.axvline(mean_pnl, color=ORANGE, linewidth=1.5, linestyle='-', label=f'Moyenne: {mean_pnl:.1f}%')

    ax.set_xlabel('P&L (%)')
    ax.set_ylabel('Nombre de tokens')
    ax.set_title('dipAccumulator — Distribution des P&L', color=PRIMARY, fontweight='bold')
    ax.legend()
    fig.tight_layout()
    save(fig, '02_dipaccum_pnl_dist.png')


# ── Chart 3: dipAccumulator wallet curve ──────────────────────────────────

def chart_dipaccum_wallet(data):
    # Find dipaccum run files
    curves = data['walletCurves']
    dipaccum_keys = [k for k in curves if 'dipaccum' in k.lower()]
    # Also include live_stream runs that contain dipAccumulator
    summaries = data.get('runSummaries', {})
    for k, v in summaries.items():
        if v.get('strategy') == 'dipAccumulator' and k not in dipaccum_keys:
            dipaccum_keys.append(k)

    if not dipaccum_keys:
        return

    fig, ax = plt.subplots(figsize=FIGSIZE)

    # Concatenate all dipaccum runs into one curve
    balance = 1.0
    all_points = [balance]
    for key in sorted(dipaccum_keys):
        pts = curves.get(key, [])
        for p in pts[1:]:  # skip initial point
            balance += (p.get('pnlPct', 0) / 100.0) * (p['balance'] - (p['balance'] - balance))
            # Simpler: just use pnlSol from the sequential curve
            all_points.append(p['balance'])

    # Use the first found run's wallet curve directly
    main_key = sorted(dipaccum_keys)[0]
    pts = curves[main_key]
    indices = [p['idx'] for p in pts]
    balances = [p['balance'] for p in pts]

    ax.plot(indices, balances, color=PRIMARY, linewidth=1.5)
    ax.fill_between(indices, 1.0, balances, alpha=0.15, color=PRIMARY)
    ax.axhline(1.0, color=GRAY, linewidth=0.8, linestyle='--', alpha=0.5)

    # Annotate final balance
    final = balances[-1]
    ax.annotate(f'{final:.3f} SOL', xy=(indices[-1], final),
                fontsize=8, color=PRIMARY, fontweight='bold',
                textcoords='offset points', xytext=(-40, 10))

    ax.set_xlabel('Token #')
    ax.set_ylabel('Solde (SOL)')
    ax.set_title(f'dipAccumulator — Wallet Curve ({main_key})', color=PRIMARY, fontweight='bold')
    fig.tight_layout()
    save(fig, '03_dipaccum_wallet.png')


# ── Chart 4: flipScalper P&L distribution ─────────────────────────────────

def chart_flipscalper_pnl(data):
    pnls = data['strategyStats'].get('flipScalper', {}).get('pnlDistribution', [])
    if not pnls:
        return

    fig, ax = plt.subplots(figsize=FIGSIZE)

    # Clip extreme outliers for display, but show them as annotation
    clip_max = 100
    clipped = [min(p, clip_max) for p in pnls]
    bins = np.arange(min(clipped) - 5, clip_max + 5, 5)

    n, _, patches = ax.hist(clipped, bins=bins, edgecolor='white', linewidth=0.5)
    for patch, b in zip(patches, bins[:-1]):
        patch.set_facecolor(GREEN if b >= 0 else RED)
        patch.set_alpha(0.8)

    ax.axvline(0, color=PRIMARY, linewidth=1, linestyle='--', alpha=0.7)

    # Annotate fat tails
    big_wins = [p for p in pnls if p > clip_max]
    if big_wins:
        ax.annotate(f'{len(big_wins)} tokens > +{clip_max}%\n(max: +{max(pnls):.0f}%)',
                     xy=(clip_max, 0), fontsize=7, color=GREEN,
                     textcoords='offset points', xytext=(-10, 30),
                     arrowprops=dict(arrowstyle='->', color=GREEN, lw=0.8))

    ax.set_xlabel('P&L (%)')
    ax.set_ylabel('Nombre de tokens')
    ax.set_title('flipScalper — Distribution des P&L (fat tail)', color=PRIMARY, fontweight='bold')
    fig.tight_layout()
    save(fig, '04_flipscalper_pnl_dist.png')


# ── Chart 5: flipScalper wallet curve (run8) ──────────────────────────────

def chart_flipscalper_wallet(data):
    curves = data['walletCurves']
    # Use run8 as the canonical run (or largest available)
    key = 'flipscalper_run8.jsonl'
    if key not in curves:
        # fallback to largest flipscalper run
        fs_keys = sorted([k for k in curves if 'flipscalper' in k],
                         key=lambda k: len(curves[k]), reverse=True)
        if not fs_keys:
            return
        key = fs_keys[0]

    pts = curves[key]
    indices = [p['idx'] for p in pts]
    balances = [p['balance'] for p in pts]

    fig, ax = plt.subplots(figsize=FIGSIZE)
    ax.plot(indices, balances, color=PRIMARY, linewidth=1.2)
    ax.fill_between(indices, 1.0, balances, where=[b >= 1.0 for b in balances],
                    alpha=0.15, color=GREEN)
    ax.fill_between(indices, 1.0, balances, where=[b < 1.0 for b in balances],
                    alpha=0.15, color=RED)
    ax.axhline(1.0, color=GRAY, linewidth=0.8, linestyle='--', alpha=0.5)

    # Annotate biggest jumps
    for i, p in enumerate(pts[1:], 1):
        pnl = p.get('pnlPct', 0)
        if pnl > 30:
            ax.annotate(f'+{pnl:.0f}%', xy=(i, balances[i]),
                        fontsize=6, color=GREEN, fontweight='bold',
                        textcoords='offset points', xytext=(2, 5))

    final = balances[-1]
    ax.annotate(f'{final:.3f} SOL', xy=(indices[-1], final),
                fontsize=8, color=PRIMARY, fontweight='bold',
                textcoords='offset points', xytext=(-50, 10))

    ax.set_xlabel('Token #')
    ax.set_ylabel('Solde (SOL)')
    ax.set_title(f'flipScalper — Wallet Curve ({key.replace(".jsonl","")})', color=PRIMARY, fontweight='bold')
    fig.tight_layout()
    save(fig, '05_flipscalper_wallet.png')


# ── Chart 6: Offline vs Live WR ──────────────────────────────────────────

def chart_offline_vs_live(data):
    items = data.get('offlineVsLive', [])
    if not items:
        return

    fig, ax = plt.subplots(figsize=(7, 3.5))
    labels = [i['label'] for i in items]
    x = np.arange(len(labels))
    width = 0.35

    offline_vals = [i.get('offlineWR') for i in items]
    live_vals = [i.get('liveWR') for i in items]

    # Plot offline bars (skip None)
    offline_bars = ax.bar(x - width/2, [v if v is not None else 0 for v in offline_vals],
                          width, label='Offline (datasets)', color=ACCENT, alpha=0.8)
    live_bars = ax.bar(x + width/2, [v if v is not None else 0 for v in live_vals],
                       width, label='Live (mainnet)', color=ORANGE, alpha=0.8)

    # Gray out missing offline bars
    for i, v in enumerate(offline_vals):
        if v is None:
            offline_bars[i].set_alpha(0.1)
            offline_bars[i].set_edgecolor(GRAY)
            offline_bars[i].set_linewidth(0.5)

    # Value labels
    for bar_group, vals in [(offline_bars, offline_vals), (live_bars, live_vals)]:
        for bar, v in zip(bar_group, vals):
            if v is not None and v > 0:
                ax.text(bar.get_x() + bar.get_width()/2., bar.get_height() + 1,
                        f'{v:.0f}%', ha='center', va='bottom', fontsize=8, fontweight='bold')

    ax.set_ylabel('Win Rate (%)')
    ax.set_title('Biais des datasets : WR Offline vs Live', color=PRIMARY, fontweight='bold')
    ax.set_xticks(x)
    ax.set_xticklabels(labels, fontsize=8)
    ax.legend()
    ax.set_ylim(0, 100)
    fig.tight_layout()
    save(fig, '06_offline_vs_live_wr.png')


# ── Chart 7: Exit reasons pie charts ─────────────────────────────────────

def chart_exit_reasons(data):
    stats = data['strategyStats']
    strats = ['dipAccumulator', 'flipScalper']
    titles = ['dipAccumulator', 'flipScalper']

    fig, axes = plt.subplots(1, 2, figsize=(7, 3.5))

    exit_colors = {
        'TP': GREEN, 'SL': RED, 'END': GRAY, 'MCAP30': ORANGE,
        'FLIP': ACCENT, 'TRAIL': '#9933CC', 'KILL': '#333333',
    }

    for ax, strat, title in zip(axes, strats, titles):
        s = stats.get(strat, {})
        exits = s.get('exitReasons', {})
        if not exits:
            ax.text(0.5, 0.5, 'Pas de données', ha='center', va='center')
            continue

        labels = list(exits.keys())
        values = list(exits.values())
        colors = [exit_colors.get(l, '#AAAAAA') for l in labels]

        wedges, texts, autotexts = ax.pie(
            values, labels=labels, colors=colors, autopct='%1.0f%%',
            pctdistance=0.8, startangle=90, textprops={'fontsize': 7}
        )
        for t in autotexts:
            t.set_fontsize(7)
            t.set_fontweight('bold')
        ax.set_title(title, fontsize=10, color=PRIMARY, fontweight='bold')

    fig.suptitle('Raisons de sortie par stratégie', fontsize=11, color=PRIMARY, fontweight='bold', y=1.02)
    fig.tight_layout()
    save(fig, '07_exit_reasons.png')


# ── Chart 8: Bot trade amounts per trade ──────────────────────────────────

def chart_bot_amounts(data):
    pts = data.get('botAmounts', [])
    if not pts:
        return

    fig, ax1 = plt.subplots(figsize=FIGSIZE)

    trades = [p['trade'] for p in pts]
    buy_amts = [p['buyAmtSol'] for p in pts]
    real_sol = [p['realSolReserves'] for p in pts]

    ax1.bar(trades, buy_amts, color=ACCENT, alpha=0.7, label='Montant achat bot (SOL)')
    ax1.set_xlabel('Numéro de trade')
    ax1.set_ylabel('Montant achat (SOL)', color=ACCENT)
    ax1.tick_params(axis='y', labelcolor=ACCENT)

    ax2 = ax1.twinx()
    ax2.plot(trades, real_sol, color=RED, linewidth=1.5, label='realSolReserves')
    ax2.set_ylabel('realSolReserves (SOL)', color=RED)
    ax2.tick_params(axis='y', labelcolor=RED)

    # Annotate 20 SOL cap
    cap_trades = [t for t, a in zip(trades, buy_amts) if a >= 19.9]
    if cap_trades:
        ax1.axhline(20, color=ORANGE, linewidth=1, linestyle=':', alpha=0.8)
        ax1.annotate('Cap 20 SOL', xy=(cap_trades[0], 20),
                     fontsize=7, color=ORANGE,
                     textcoords='offset points', xytext=(5, 5))

    ax1.set_title('Montant des trades du bot (règle 20% + cap 20 SOL)', color=PRIMARY, fontweight='bold')

    # Combined legend
    lines1, labels1 = ax1.get_legend_handles_labels()
    lines2, labels2 = ax2.get_legend_handles_labels()
    ax1.legend(lines1 + lines2, labels1 + labels2, loc='upper left', fontsize=8)

    fig.tight_layout()
    save(fig, '08_bot_trade_amounts.png')


# ── Main ──────────────────────────────────────────────────────────────────

def main():
    print('Loading report data...')
    with open(DATA_PATH) as f:
        data = json.load(f)

    print(f'Generating charts ({data["totalRecords"]} records)...')
    chart_bonding_curve(data)
    chart_dipaccum_pnl(data)
    chart_dipaccum_wallet(data)
    chart_flipscalper_pnl(data)
    chart_flipscalper_wallet(data)
    chart_offline_vs_live(data)
    chart_exit_reasons(data)
    chart_bot_amounts(data)
    print('Done! All charts saved to docs/rapport/figures/')


if __name__ == '__main__':
    main()
