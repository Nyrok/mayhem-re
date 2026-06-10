#!/usr/bin/env python3
"""
Independence tests on the Mayhem bot's buy/sell sequence.

Decomposes "is the sequence i.i.d. 50/50?" into three orthogonal questions:
  1. Marginal frequency  -> binomial test (per session + pooled)
  2. Serial independence -> Wald-Wolfowitz runs test per session,
                            then KS of the session Z-scores against N(0,1),
                            plus autocorrelation function
  3. Higher-order memory -> Markov order-1 and order-2 transition tables,
                            chi2 on order-1, G2 likelihood-ratio order-2 vs order-1

Sessions are NEVER concatenated: every statistic is computed within a session,
then aggregated across sessions (Z distribution, Stouffer, pooled transitions
that skip session boundaries).

Usage:
    .venv-stats/bin/python tools/independenceTests.py [--min-trades 20]
"""

import argparse
import glob
import json
import math
import os
import sys
from collections import Counter, defaultdict

import numpy as np
from scipy import stats

TOKENS_DIR = os.path.join(os.path.dirname(__file__), "..", "analysis", "tokens")
CHRONO_FILE = os.path.join(os.path.dirname(__file__), "..", "analysis", "chronological_trades.json")


# ───────────────────────────── data loading ─────────────────────────────

def load_sessions(min_trades):
    """One session per mint. Union of analysis/tokens/*.json and
    chronological_trades.json, keeping the longer record per mint."""
    sessions = {}  # mint -> list of 0/1 (1 = buy)

    for path in sorted(glob.glob(os.path.join(TOKENS_DIR, "*.json"))):
        d = json.load(open(path))
        bits = [1 if t["action"] == "buy" else 0 for t in d["trades"]]
        mint = d["mint"]
        if len(bits) > len(sessions.get(mint, [])):
            sessions[mint] = bits

    if os.path.exists(CHRONO_FILE):
        d = json.load(open(CHRONO_FILE))
        by_mint = defaultdict(list)
        for t in d["trades"]:
            by_mint[t["mint"]].append((t["slot"], 1 if t["action"] == "buy" else 0))
        for mint, rows in by_mint.items():
            bits = [b for _, b in sorted(rows, key=lambda r: r[0])]
            if len(bits) > len(sessions.get(mint, [])):
                sessions[mint] = bits

    kept = {m: np.array(b, dtype=int) for m, b in sessions.items() if len(b) >= min_trades}
    dropped = len(sessions) - len(kept)
    return kept, dropped


# ───────────────────────────── tests ─────────────────────────────

def runs_test(s):
    """Wald-Wolfowitz. Returns (n_runs, z, p) or None if degenerate."""
    n1 = int(s.sum())
    n2 = len(s) - n1
    if n1 == 0 or n2 == 0:
        return None
    runs = 1 + int((s[1:] != s[:-1]).sum())
    n = n1 + n2
    mu = 2 * n1 * n2 / n + 1
    var = 2 * n1 * n2 * (2 * n1 * n2 - n) / (n**2 * (n - 1))
    if var <= 0:
        return None
    z = (runs - mu) / math.sqrt(var)
    p = 2 * (1 - stats.norm.cdf(abs(z)))
    return runs, z, p


def acf(s, lags):
    x = 2 * s.astype(float) - 1
    x -= x.mean()
    denom = float(np.sum(x * x))
    if denom == 0:
        return [0.0] * lags
    return [float(np.sum(x[:-k] * x[k:]) / denom) for k in range(1, lags + 1)]


def transition_counts(sessions, order):
    """Pooled within-session k-gram transition counts: context tuple -> [n_sell, n_buy]."""
    counts = defaultdict(lambda: [0, 0])
    for s in sessions.values():
        for i in range(order, len(s)):
            ctx = tuple(s[i - order:i])
            counts[ctx][s[i]] += 1
    return counts


def loglik(counts):
    """Max log-likelihood of a Markov model given its transition counts."""
    ll = 0.0
    for (n0, n1) in counts.values():
        n = n0 + n1
        for c in (n0, n1):
            if c > 0:
                ll += c * math.log(c / n)
    return ll


# ───────────────────────────── main ─────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-trades", type=int, default=20)
    ap.add_argument("--lags", type=int, default=5)
    args = ap.parse_args()

    sessions, dropped = load_sessions(args.min_trades)
    n_sessions = len(sessions)
    total = sum(len(s) for s in sessions.values())
    total_buys = sum(int(s.sum()) for s in sessions.values())

    print(f"Sessions: {n_sessions} (>= {args.min_trades} trades; {dropped} dropped as too short)")
    print(f"Total trades: {total}  |  buys: {total_buys} ({100*total_buys/total:.2f}%)")
    print()

    # ── 1. Runs test per session + KS on Z's ──
    print("═" * 72)
    print("1. RUNS TEST (Wald-Wolfowitz) — per session, then KS of Z's vs N(0,1)")
    print("═" * 72)
    zs = []
    print(f"{'mint':<14}{'n':>5}{'buys':>6}{'runs':>6}{'E[R]':>8}{'Z':>8}{'p':>10}")
    for mint, s in sorted(sessions.items()):
        r = runs_test(s)
        if r is None:
            print(f"{mint[:12]:<14}{len(s):>5}  degenerate (all same direction)")
            continue
        runs, z, p = r
        n1 = int(s.sum())
        mu = 2 * n1 * (len(s) - n1) / len(s) + 1
        zs.append(z)
        flag = " *" if p < 0.05 else ""
        print(f"{mint[:12]:<14}{len(s):>5}{n1:>6}{runs:>6}{mu:>8.1f}{z:>8.2f}{p:>10.4f}{flag}")

    zs = np.array(zs)
    ks_stat, ks_p = stats.kstest(zs, "norm")
    stouffer_z = zs.sum() / math.sqrt(len(zs))
    stouffer_p = 2 * (1 - stats.norm.cdf(abs(stouffer_z)))
    n_sig = int((np.abs(zs) > 1.96).sum())
    print()
    print(f"Session Z's: mean={zs.mean():+.3f}  sd={zs.std(ddof=1):.3f}  "
          f"min={zs.min():+.2f}  max={zs.max():+.2f}")
    print(f"Significant sessions (|Z|>1.96): {n_sig}/{len(zs)} "
          f"(expect ~{0.05*len(zs):.1f} under H0)")
    print(f"KS vs N(0,1): D={ks_stat:.4f}  p={ks_p:.4f}")
    print(f"Stouffer combined: Z={stouffer_z:+.3f}  p={stouffer_p:.4f}")
    print("Sign: Z>0 = over-alternation (too many runs), Z<0 = streaks/clustering")

    # ── ACF aggregated across sessions ──
    print()
    print("─" * 72)
    print(f"Autocorrelation (mean across sessions, lags 1..{args.lags})")
    print("─" * 72)
    all_acf = np.array([acf(s, args.lags) for s in sessions.values()])
    mean_acf = all_acf.mean(axis=0)
    # se of the mean ACF across independent sessions
    se = all_acf.std(axis=0, ddof=1) / math.sqrt(n_sessions)
    for k in range(args.lags):
        z = mean_acf[k] / se[k] if se[k] > 0 else 0.0
        flag = " *" if abs(z) > 1.96 else ""
        print(f"  lag {k+1}: r={mean_acf[k]:+.4f}  (z={z:+.2f}){flag}")

    # ── 2. Binomial (marginal) ──
    print()
    print("═" * 72)
    print("2. BINOMIAL TEST — is the marginal 50/50?")
    print("═" * 72)
    p_pooled = stats.binomtest(total_buys, total, 0.5).pvalue
    phat = total_buys / total
    se_p = math.sqrt(0.25 / total)
    print(f"Pooled: {total_buys}/{total} buys = {100*phat:.2f}%  "
          f"(se={100*se_p:.2f}pp)  p={p_pooled:.4f}")
    per_sess_p = [stats.binomtest(int(s.sum()), len(s), 0.5).pvalue for s in sessions.values()]
    n_sig_b = sum(1 for p in per_sess_p if p < 0.05)
    print(f"Per-session significant at 0.05: {n_sig_b}/{n_sessions} "
          f"(expect ~{0.05*n_sessions:.1f})")

    # ── 3. Markov order 1 and order 2 ──
    print()
    print("═" * 72)
    print("3. MARKOV — order-1 chi2, order-2 vs order-1 G2 LRT")
    print("═" * 72)
    c1 = transition_counts(sessions, 1)
    table = np.array([c1[(0,)], c1[(1,)]], dtype=float)  # rows: prev sell/buy; cols: next sell/buy
    chi2, p1, dof, _ = stats.chi2_contingency(table, correction=False)
    p_bb = table[1, 1] / table[1].sum()
    p_bs = table[0, 1] / table[0].sum()
    print("Order-1 transition table (rows = previous, cols = next):")
    print(f"              next=sell   next=buy")
    print(f"  prev=sell {int(table[0,0]):>10} {int(table[0,1]):>10}   P(buy|sell)={p_bs:.4f}")
    print(f"  prev=buy  {int(table[1,0]):>10} {int(table[1,1]):>10}   P(buy|buy) ={p_bb:.4f}")
    print(f"  chi2={chi2:.3f}  dof={dof}  p={p1:.4f}")
    print(f"  effect: P(buy|buy) - P(buy|sell) = {p_bb - p_bs:+.4f}")

    # order-0 loglik (one global p per the pooled marginal over the same prediction set)
    c0 = transition_counts(sessions, 0) if False else None
    # order comparison via nested LRT on identical prediction sets:
    def ll_for_order(order):
        return loglik(transition_counts(sessions, order))

    # order0 vs order1: predictands differ by 1 obs/session; use same-order grams
    # build order-0 counts over positions >= 1 to match order-1's prediction set
    c0m = defaultdict(lambda: [0, 0])
    for s in sessions.values():
        for i in range(1, len(s)):
            c0m[()][s[i]] += 1
    ll0 = loglik(c0m)
    ll1 = loglik(transition_counts(sessions, 1))
    g2_01 = 2 * (ll1 - ll0)
    p_01 = 1 - stats.chi2.cdf(g2_01, df=1)
    print()
    print(f"Order-0 vs order-1: G2={g2_01:.3f}  df=1  p={p_01:.4f}")

    # order1 vs order2 on positions >= 2
    c1m = defaultdict(lambda: [0, 0])
    for s in sessions.values():
        for i in range(2, len(s)):
            c1m[tuple(s[i-1:i])][s[i]] += 1
    ll1m = loglik(c1m)
    c2 = transition_counts(sessions, 2)
    ll2 = loglik(c2)
    g2_12 = 2 * (ll2 - ll1m)
    p_12 = 1 - stats.chi2.cdf(g2_12, df=2)
    print(f"Order-1 vs order-2: G2={g2_12:.3f}  df=2  p={p_12:.4f}")
    print()
    print("Order-2 conditionals P(buy | last two):")
    for ctx in sorted(c2.keys()):
        n0, n1 = c2[ctx]
        n = n0 + n1
        lbl = "".join("B" if b else "S" for b in ctx)
        se_c = math.sqrt(0.25 / n)
        print(f"  after {lbl}: P(buy)={n1/n:.4f}  (n={n}, se={se_c:.4f})")

    # ── exploitability summary ──
    print()
    print("═" * 72)
    print("EFFECT SIZES vs ~2% round-trip fees")
    print("═" * 72)
    edge1 = abs(p_bb - p_bs) / 2  # rough per-trade predictive edge over coin flip
    print(f"Marginal bias:      |p-0.5| = {abs(phat-0.5)*100:.2f}pp")
    print(f"Order-1 edge:       |P(buy|buy)-P(buy|sell)|/2 = {edge1*100:.2f}pp over 50%")
    print(f"Runs-test signal:   mean session Z = {zs.mean():+.2f} "
          f"({'over-alternation' if zs.mean() > 0 else 'streaks'})")
    print("Rule of thumb: a directional edge below ~2pp per trade does not survive fees.")


if __name__ == "__main__":
    main()
