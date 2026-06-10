# Mayhem State Decode — Project Summary

Reverse engineering the **Mayhem bot** on pump.fun / Solana: decode its on-chain state,
model its behavior, and build profitable counter-trading strategies.

> **Author:** Nyrok · **Period:** Jan–Feb 2026 · 1,184 trades analyzed · 25 live runs · 5+ strategies tested

This file is the master index. Deeper write-ups live where noted.

---

## Where everything is documented

| Document | Format | Covers |
|----------|--------|--------|
| `docs/rapport/rapport.typ` + `Projet Meyham.pdf` | Typst / PDF (FR) | **The full formal report** — on-chain RE, bot mechanics, all strategies |
| `STRATEGY.md` | Markdown | dipAccumulator TP=5 deep dive + bug fixes + architecture |
| `analysis/FLIPSCALPER_REPORT.md` | Markdown | flipScalper v2 deep dive (token-by-token run8 breakdown) |
| `docs/plans/2026-02-15-momentum-confirmed-*.md` | Markdown | momentumConfirmed design + impl plan |
| `memory/MEMORY.md` | Markdown | Persistent project memory (latest live findings) |
| **`SUMMARY.md`** (this file) | Markdown | Master index across all of the above |

The formal report (`rapport.typ`) is the canonical summary. This file exists because the report
is PDF/Typst — not skimmable inside the repo — and because the **PRNG-cracking line of work is not in it**.

---

## Part 1 — On-chain reverse engineering

Decoded the Mayhem program's accounts and events from raw mainnet data.

- **Decoders** (`decoders/`): `MayhemTradeEvent`, `TokenState` (per-session state),
  `GlobalState` (program config), `BondingCurve`, `CreateV2`, `MayhemIxData`,
  `MayhemVirtualParamsEvent`, `TradeEvent`.
- **Listeners** (`listen*.js`): live subscription to global state, sessions, single wallet, event counts.
- Mapped program instructions, custom errors, and the address referential.
- Captured raw datasets: `globalState.csv`, `logs.txt`, `analysis/tokens/` (26 token trade files),
  `analysis/tradeDataset.json`, `analysis/chronological_trades.json`.

## Part 2 — Bot mechanics

Modeled the Mayhem bot's session lifecycle and trade behavior.

- Session lifecycle: create → trade loop → `isRunning=false`.
- Observed buy/sell behavior and trade-size distribution (see report figures).
- **BondingCurve model** (`tools/monteCarloSimulation.js`): pump.fun virtual/real reserves,
  price impact, fees. Delta-overlay model reconstructs the curve per trade and overlays
  the player's cumulative SOL/token deltas — no on-chain mutation.
- **Critical fix**: `getSolForTokens`/`executeSell` cap sell at `realSolReserves` instead of
  returning `0` — previously caused phantom −80% P&L on big Phase-1 positions.

### PRNG / predictability investigation (not in the formal report)

Parallel line of work testing whether the bot's buy/sell decision sequence is predictable:
- `tools/analyzePrng.js` — statistical tests on the binary buy(0)/sell(1) sequence, cross-token continuity.
- `tools/crackPrngSeed.py`, `tools/satCracker.py`, `tools/algebraicCracker.py` — seed-recovery attempts.
- `tools/analyzeDecisionPatterns.js`, `analyzeNonAlternating.js`, `analyzeTimingChannel.js`,
  `predictAndValidate.js` — pattern / timing-channel analysis.

> Status: investigation tooling exists; outcome not folded into the report. Verify findings before
> relying on bot-decision predictability.

## Part 3 — Trading strategies

Built and live-tested counter-trading strategies via `tools/backtestMainnet.js`
(live streaming + historical replay). Results saved as JSONL in `analysis/live_runs/`.

### Two strategies that work

**dipAccumulator TP=5** — *consistency play (high win rate)*
- Buy 0.1 SOL on bot sell streaks; sell all on bot buy; TP +5%, SL −20%, max 10 buys.
- Live: ~67–75% WR, profitable. Edge = TP overshoot (target +5% exits avg +7.6%) beats
  rare-but-large SL losses (avg −16%, ~25% frequency).
- Config + full analysis: `STRATEGY.md`.

**flipScalper v2** — *asymmetry play (fat tail)*
- Persistent `onLogs` subscription across all tokens (no per-token subscribe race).
- Initial buy at bonding-curve defaults (earliest/cheapest entry, mcap ≈ 28), then flip
  buy/sell the flip portion on each bot sell; keep the initial position riding the pump.
- MCAP30 high-water-mark floor cuts losers; FLIP STOP caps flip losses.
- Live run8: ~36% WR but **net positive** — profitability is **fat-tail dependent**
  (top 2 of 89 tokens carry it; remove #22 +195% and it goes negative).
- Config + token-by-token: `analysis/FLIPSCALPER_REPORT.md`.

### Strategies that failed live

| Strategy | Why it failed |
|----------|---------------|
| **smartDipAccumulator** | Trailing-stop overshoot — discrete bonding-curve trades drop P&L 10%+ between checks; converted +7% winners into −2% losers. ~45% WR live. |
| **proportionalDip** | Proportional sizing amplifies losers (bigger buys into pumps that then dump). −50% wallet live. |
| **momentumConfirmed A/C** | Kill-switch variants; see `docs/plans/`. Did not beat the two winners. |

### The central lesson: offline bias

Offline datasets in `analysis/tokens/` are curated/volatile and **do not predict live WR**.
dipAccumulator shows ~46% WR offline but ~75% live; complex strategies that looked great
offline failed live. **Only live mainnet testing is trusted.**

---

## Numbers caveat

Headline live results differ by aggregation method:
- `STRATEGY.md` / `FLIPSCALPER_REPORT.md` quote **single best runs** (compounding wallet).
- `docs/rapport/report_data.json` quotes **aggregate across all 25 runs / 1,184 records**
  (e.g. dipAccumulator mean P&L is slightly negative over all records, median positive).

Single-run headlines are not the all-runs mean. Trust `report_data.json` for the aggregate picture.

---

## Tooling map

| Tool | Purpose |
|------|---------|
| `tools/backtestMainnet.js` | Live streaming + historical backtest engine (`--verbose`, `--save`, `--budget`) |
| `tools/monteCarloSimulation.js` | BondingCurve class + Monte Carlo simulation |
| `tools/offlineSweep.js` / `parameterSweep.js` | Fast offline parameter sweeps |
| `tools/collectTokenData.js` / `batchExtract.js` | Live + historical data collectors |
| `tools/generateReportData.js` / `generateCharts.py` | Build `report_data.json` + report figures |
| `tools/analyzePrng.js` + `*Cracker.py` | PRNG / predictability investigation |
| `bankRunSimulation.js`, `createTokenInLocalValidator.js`, `local-validator.sh` | Local validator harness |

---

*Index generated 2026-06-10. Source of truth for prose: `docs/rapport/`. Update this file when a new strategy or run materially changes the picture.*
