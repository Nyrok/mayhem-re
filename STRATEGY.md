# Pump.fun Bonding Curve Trading Strategy

## Production Strategy: `dipAccumulator` TP=5%

### Configuration

```bash
node tools/backtestMainnet.js \
  --wallet=1 \
  --strategy=dipAccumulator \
  --tradeSize=0.1 \
  --budget=1 \
  --takeProfit=5 \
  --stopLoss=20 \
  --sellStreak=1 \
  --maxBuys=10 \
  --maxPositionPct=100 \
  --verbose \
  --save=analysis/live_runs/<run_name>.jsonl
```

| Parameter | Value | Description |
|-----------|-------|-------------|
| `strategy` | `dipAccumulator` | Buy on bot sell streaks, sell on bot buy |
| `budget` | 1.0 SOL | Total budget per token |
| `tradeSize` | 0.1 SOL | Fixed buy size per entry |
| `takeProfit` | 5% | Exit when portfolio hits +5% |
| `stopLoss` | 20% | Exit when portfolio hits -20% |
| `sellStreak` | 1 | Buy after 1 consecutive bot sell |
| `maxBuys` | 10 | Maximum 10 buy entries per token |
| `maxPositionPct` | 100% | No cap on position relative to pool |

---

## How It Works

### Entry Logic
1. Stream new pump.fun token launches via WebSocket
2. Watch the bonding curve for bot trades (buys/sells)
3. When a bot SELLS (price dips), place a BUY of 0.1 SOL
4. Accumulate up to 10 buy entries (max 1.0 SOL invested)

### Exit Logic
1. When a bot BUYS (price pumps), SELL entire token position
2. Check portfolio P&L after each trade:
   - **TP >= +5%**: Force sell everything, exit with profit
   - **SL <= -20%**: Force sell everything, cut losses
3. If no activity for 30 seconds, force sell and exit (END)

### Delta Overlay Model
- Each bot trade reconstructs a fresh `BondingCurve` from on-chain reserves
- Player's cumulative SOL/token deltas are overlaid on top
- This accurately models price impact without modifying on-chain state

---

## Live Mainnet Results

### Run 4 (Feb 15, 2026) — 38 tokens

| Metric | Value |
|--------|-------|
| **Wallet** | **1.515 SOL (+51.5%)** |
| **Total P&L** | +0.515 SOL |
| **TP Wins** | 24 |
| **SL Losses** | 5 |
| **END Exits** | 9 (6 no-trade) |
| **Traded Win Rate** | **75.0%** |
| **Avg Win** | +7.61% |
| **Avg Loss** | -15.98% |
| **Breakeven WR** | 67.7% |
| **Edge** | +7.3% above breakeven |
| **Win/Loss Ratio** | 0.48 |

### Previous Validation Run (Feb 14, 2026) — 20 tokens

| Metric | Value |
|--------|-------|
| **Wallet** | +2.47% |
| **Win Rate** | 75% |
| **Avg Win** | +7.6% |
| **Avg Loss** | -22.8% |

### Combined: 58 tokens, ~75% win rate, consistently profitable

---

## Key Insights

### 1. TP Overshoot Works In Your Favor

Target is +5% but actual TP exits average **+7.6%**. On bonding curves, price can jump significantly between discrete bot trades. This overshoot benefits TP exits because you sell at a higher price than your target.

- TP exit range: +5.01% to +13.26%
- Average TP trades: 3.4 buys (0.34 SOL invested)
- Average TP duration: 11 seconds

### 2. SL Losses Are Rare But Expensive

Only ~16% of traded tokens hit SL, but each loss costs ~3.5x a TP win.

- SL losses range: -20.17% to -26.69%
- Average SL trades: 6.6 buys (0.66 SOL invested)
- Losses accumulate more buys because the strategy DCA's into declining prices

### 3. Win/Loss Asymmetry

| | Wins | Losses |
|---|---|---|
| Avg P&L | +7.6% | -16.0% |
| Avg invested | 0.34 SOL | 0.66 SOL |
| Frequency | 75% | 25% |

The math works because wins are ~3x more frequent than losses.

### 4. No-Trade Tokens Are Free

~16% of tokens (6/38) had no dip detected within the timeout window. The strategy doesn't enter = zero risk. These dilute the overall WR but don't affect the wallet.

### 5. END Exits Are Neutral

Tokens that timeout without hitting TP/SL typically have small losses (-0.4% to -10.7%). They happen when the token goes sideways — not enough momentum in either direction.

---

## Why NOT SmartDipAccumulator (Trailing Stop)

The `smartDipAccumulator` strategy added entry filters and a trailing stop. It looked amazing offline (+11.37% mean P&L, 74% WR across 10,368 configs) but **failed catastrophically live** (~45% WR across 30 tokens, wallet dropped to 0.24 SOL).

### Root Cause: Trail Overshoot

On discrete bonding curves, the trailing stop can only check P&L when a new bot trade arrives. Between two consecutive trades, price can drop 10%+ in a single trade.

**Example (token EBjBk):**
- Trade 5: P&L = +7.26%, trail peak = +7.26%, dynamic SL = +3.26%
- Trade 6: P&L drops to -2.43% (9.7% drop in one trade)
- Trail triggers at -2.43% even though dynamic SL was +3.26%
- Result: A +7% winner becomes a -2.4% loser

In live run 3, **4 of 9 TRAIL exits were losses** despite all having peaks above +5%.

### Trail vs TP Comparison

| Exit Type | Overshoot Direction | Effect |
|-----------|-------------------|--------|
| **TP=5%** | Overshoots UP (+7.6% avg) | Beneficial — more profit |
| **Trail** | Overshoots DOWN (-2% to -10%) | Destructive — converts wins to losses |

### Offline Dataset Bias

The offline datasets (27 curated tokens in `analysis/tokens/`) are biased toward interesting/volatile tokens. dipAccumulator shows 46% WR offline but 75% WR live — random pump.fun tokens pump more often than curated datasets suggest.

This means **offline sweep results cannot be trusted** as predictors of live performance. Only live mainnet testing is reliable.

---

## Architecture

### Files

| File | Purpose |
|------|---------|
| `tools/backtestMainnet.js` | Live streaming + historical backtest engine |
| `tools/monteCarloSimulation.js` | BondingCurve class + Monte Carlo simulation |
| `tools/offlineSweep.js` | Fast offline parameter sweep across saved datasets |
| `tools/collectTokenData.js` | Live trade data collector |
| `tools/batchExtract.js` | Historical batch trade extractor |
| `analysis/tokens/` | Saved token trade datasets (27 files) |
| `analysis/live_runs/` | Live run results (JSONL) |

### BondingCurve Model

```
virtualSolReserves    = on-chain + playerSolDelta
virtualTokenReserves  = on-chain - playerTokenDelta
realSolReserves       = on-chain + playerSolDelta
realTokenReserves     = on-chain - playerTokenDelta
```

Key fix: `getSolForTokens()` and `executeSell()` cap at `realSolReserves` instead of returning 0 when the sell amount exceeds reserves. This prevents phantom -80% P&L in Phase 1 (tiny reserves).

### Modes

- **Live streaming** (`--wallet=1`): Subscribes to pump.fun WebSocket, processes tokens as they launch
- **Historical replay** (`--mint=<address>`): Fetches trades from RPC and replays with the strategy
- **Verbose** (`--verbose`): Logs every trade decision with reasoning
- **Save** (`--save=<path>`): Appends results as JSONL for analysis

---

## Bug Fixes Applied

### 1. Force-Sell on END Exit (Critical)
Streaming mode's `finishSession()` wasn't selling remaining tokens when exiting due to inactivity timeout. Tokens held at END exit were valued at 0, causing phantom losses.

### 2. getSolForTokens Guard (Critical)
BondingCurve returned 0 instead of capping at `realSolReserves` when sell amount exceeded reserves. Caused -80% phantom P&L on large positions in Phase 1.

### 3. Timer Reset Scope
`resetTimer()` was resetting for ALL wallet logs, not just the current mint. Fixed to only reset on matching mint trades.

### 4. Max Inactivity Timeout
Added 30-second maximum inactivity timer to prevent tokens from hanging indefinitely when no trades occur.

---

## Operating Notes

1. **Run during active hours** — more token launches = more opportunities
2. **Each token takes 5-30 seconds** — wins resolve fast (avg 11s), losses take longer (avg 14s)
3. **SL overshoot is acceptable** — max observed ~6% overshoot (-26.7% vs -20% target)
4. **No-trade tokens are noise** — they don't affect wallet, just dilute overall WR stats
5. **RPC rate limits** — avoid running multiple backtest instances simultaneously (429 errors)
6. **Wallet mode** (`--wallet=1`) uses running wallet balance per token — losses compound but so do wins
