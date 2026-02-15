# Momentum-Confirmed Strategy Design

## Problem

dipAccumulator (TP=5, maxBuys=10) achieves 67-75% WR live but loses ~22% on each loser because it buys into dying tokens. Analysis of 141 active tokens across 8 live runs revealed that bot buy/sell ratio is the strongest predictor of outcome: when botBuys >= botSells (B/S >= 1.0), 82% of tokens are winners.

## Core Insight

Winners and losers have distinct bot activity signatures:
- **Winners**: bot B/S ratio >= 1.0 (82% WR), exits in 1-3 player buys, bot sell excess <= -1 (86% WR)
- **Losers**: bot B/S ratio < 1.0, accumulate 5-10 buys, bot sell excess >= +2 (18% WR)

## Strategy: "momentumConfirmed"

Wait for bot momentum to confirm before entering. Single buy (or limited buys), fast exit.

### Two Variants for Live A/B Testing

**Variant A — Pure Gate (recommended for simplicity)**
- Monitor bot B/S ratio passively during watch phase
- Entry: when `botBuys / botSells >= entryRatio` (default 1.2)
- Single buy of configurable size (default 0.2 SOL)
- Exit: TP=15%, SL=20%
- Kill switch: if `botSells - botBuys >= killThreshold` after entry, sell immediately
- Offline result: +101.5% wallet, 50% WR (10W/10L on 26 datasets)

**Variant C — Momentum Score (higher ceiling, overfitting risk)**
- Compute `score = (botBuys - botSells) * (totalBotTrades / elapsed_seconds)`
- Entry: when score >= 2.0
- Up to 3 buys of 0.2 SOL each on subsequent dips
- Exit: TP=15%, SL=20%, kill switch on excess >= 2
- Offline result: +144.8% wallet, 71% WR (12W/5L on 26 datasets)

### Parameters

| Param | Default A | Default C | Description |
|-------|-----------|-----------|-------------|
| tradeSize | 0.2 | 0.2 | SOL per buy |
| entryRatio | 1.2 | - | Min B/S ratio to enter (A only) |
| scoreThreshold | - | 2.0 | Min momentum score to enter (C only) |
| takeProfit | 15 | 15 | TP % |
| stopLoss | 20 | 20 | SL % |
| maxBuys | 1 | 3 | Max player buys |
| killSwitch | 2 | 2 | Sell excess threshold for early exit (0=disabled) |

### Baseline Comparison

| Strategy | Wallet (offline) | WR | Trades/26 |
|----------|-----------------|------|-----------|
| dipAccumulator TP=5 | +61.5% | 81% | 26 |
| momentumConfirmed A | +101.5% | 50% | 20 |
| momentumConfirmed C | +144.8% | 71% | 17 |

### Implementation Scope

Add to: `backtestMainnet.js`, `offlineSweep.js`
- New strategy `momentumConfirmed` with `--approach=A|C` flag
- Watch phase: track botBuys/botSells before entering
- Entry gate: ratio check (A) or score computation (C)
- Post-entry: TP/SL + kill switch
- Verbose logging: show watch phase stats, entry signal, kill switch triggers

### Risks

- Offline datasets are biased. dipAccumulator has 46% WR offline but 75% live. These offline results may not predict live performance.
- Approach C uses a composite formula similar to smartDipAccumulator, which failed live due to overfitting.
- Lower trade frequency (skipping tokens) means fewer total trades live.

### Success Criteria

Live validation (20+ tokens each):
- Variant A or C achieves wallet > 1.0 SOL (net positive)
- WR >= 50% with avg win > avg loss
- Kill switch prevents at least some SL-level losses
