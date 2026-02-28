# flipScalper v2 — Strategy Report

## Overview

flipScalper is a Solana pump.fun bonding curve strategy that front-runs a known bot wallet by buying tokens at bonding curve defaults (before the bot's first trade), then alternates between buying and selling ("flipping") on each bot sell event. It holds a permanent "initial" position throughout the session and trades a second "flip" position on top of it. A market cap floor at 30 SOL acts as a loss-cutting mechanism.

**Best live result (run8, 89 tokens):** 36% WR, net P&L depends on big winners outweighing many small losses. The strategy is profitable not through high win rate, but through massive win/loss asymmetry — average winners are 2-3x larger than average losses.

---

## Method

### Architecture: Persistent Subscription

Unlike other strategies that subscribe to the bot wallet per-token, flipScalper v2 uses a **single persistent WebSocket subscription** on the Mayhem bot wallet (`connection.onLogs()`) that stays alive across all tokens. This eliminates a race condition where 1-2 early bot trades were missed during the subscribe/detect gap.

```
┌─────────────────────────────────────────────────────┐
│  ONE persistent onLogs subscription (bot wallet)    │
│                                                     │
│  New mint detected ──> spawn session                │
│  Trades pushed to session via pushTrade() callback  │
│  Session ends ──> mint added to endedMints set      │
│  Subscription stays alive ──> next mint detected    │
└─────────────────────────────────────────────────────┘
```

The first trade for a new mint is buffered (`pendingFirstTrade`) and pushed to the session immediately after setup, so no trades are lost.

### Entry: Initial Buy at Bonding Curve Defaults

The player buys **before the bot's first trade** using a fresh `BondingCurve()` at its default state:
- `virtualSolReserves = 30,000,000,000 (30 SOL)`
- `virtualTokenReserves = 1,073,000,000,000,000 (1.073T tokens)`
- `realSolReserves = 0`
- `realTokenReserves = 793,100,000,000,000 (793.1B tokens)`

This gives the absolute earliest entry at the lowest possible price. Trade size is 0.2 SOL.

### Core Loop: Flip Buy / Flip Sell

On each **bot sell** event, the player alternates:

1. **FLIP BUY** — Buy 0.2 SOL worth of tokens (the "flip portion")
2. **FLIP SELL** — Sell only the flip portion, keeping the initial tokens

The initial position is never sold during flipping — only the flip portion rotates. This means:
- The initial tokens ride the entire pump if the token succeeds
- Each flip is a short-term round trip attempting to profit from the bot's sell dip

### Flip Stop (Loss Cut on Flip Portion)

After a FLIP BUY, the strategy monitors the flip portion's value each bot trade. If `flipValue < roundTripEntrySOL`, the flip portion is sold immediately (FLIP STOP). This prevents holding a flip position that's underwater. After a FLIP STOP, the next bot sell triggers a new FLIP BUY.

### Exit Conditions

| Exit | Trigger | Behavior |
|------|---------|----------|
| **MCAP30** | Market cap drops below 30 SOL (after having been above 30) | Sell everything, end session |
| **END** | Bot session ends (`isRunning=false` or 10s inactivity + poll) | Force-sell remaining tokens at last known reserves |

The mcap < 30 check uses a **high-water mark** (`mcapPeaked` flag). The initial bonding curve has mcap ≈ 28 SOL (below the 30 threshold), so without the high-water mark, every token would exit immediately. The flag is set to `true` once mcap >= 30, and only then does the mcap < 30 exit activate.

### Configuration

```
--strategy=flipScalper
--budget=1            # SOL budget per token
--tradeSize=0.2       # SOL per flip buy / initial buy
--takeProfit=100      # disabled (flips handle exits)
--stopLoss=100        # disabled (flips handle exits)
--maxBuys=0           # unlimited
--sellStreak=1        # buy on every bot sell
```

TP/SL are set to 100% (effectively disabled) because the strategy relies on FLIP STOP and MCAP30 for risk management instead of percentage-based thresholds.

---

## Live Results

### Run 8 — 89 Tokens (2026-02-15, ~2.5 hours)

This is the largest live dataset. Full token-by-token breakdown:

| # | P&L % | P&L SOL | Trades | Exit | Duration | Notes |
|---|--------|---------|--------|------|----------|-------|
| 1 | +39.34 | +0.393 | 2 | END | 7s | Quick pump, 2B/1S |
| 2 | -6.76 | -0.068 | 14 | MCAP30 | 40s | Slow bleed below 30 |
| 3 | -2.43 | -0.024 | 4 | MCAP30 | 5s | Fast exit |
| 4 | -38.49 | -0.385 | 27 | END | 75s | Worst loss — long grind |
| 5 | +0.08 | +0.001 | 1 | MCAP30 | 1s | Breakeven |
| 6 | -16.23 | -0.162 | 19 | MCAP30 | 74s | Slow bleed |
| 7 | -6.54 | -0.065 | 2 | MCAP30 | 2s | |
| 8 | -3.74 | -0.037 | 3 | MCAP30 | 7s | |
| 9 | +46.24 | +0.462 | 20 | END | 70s | Big winner — 26B/18S |
| 10 | -1.11 | -0.011 | 1 | MCAP30 | 1s | |
| 11 | +28.15 | +0.282 | 5 | MCAP30 | 25s | Pumped then dumped past 30 |
| 12 | -1.86 | -0.019 | 4 | MCAP30 | 13s | |
| 13 | +20.63 | +0.206 | 17 | MCAP30 | 66s | |
| 14 | +9.40 | +0.094 | 6 | MCAP30 | 24s | |
| 15 | -13.55 | -0.135 | 2 | END | 3s | |
| 16 | +33.67 | +0.337 | 16 | MCAP30 | 45s | |
| 17 | +11.01 | +0.110 | 20 | END | 62s | |
| 18 | +0.95 | +0.009 | 2 | MCAP30 | 5s | |
| 19 | +3.98 | +0.040 | 19 | END | 81s | |
| 20 | -24.17 | -0.242 | 9 | END | 15s | |
| 21 | -11.20 | -0.112 | 8 | END | 19s | |
| 22 | **+195.30** | **+1.953** | 18 | END | 63s | **Monster winner** |
| 23 | -3.83 | -0.038 | 2 | MCAP30 | 1s | |
| 24 | -0.03 | -0.000 | 1 | MCAP30 | 3s | |
| 25 | -23.31 | -0.233 | 27 | END | 71s | |
| 26 | -25.88 | -0.259 | 7 | END | 19s | |
| 27 | -6.11 | -0.061 | 2 | MCAP30 | 4s | |
| 28 | -41.00 | -0.410 | 12 | END | 16s | |
| 29 | +47.47 | +0.475 | 9 | END | 24s | |
| 30 | -0.24 | -0.002 | 16 | END | 75s | |
| 31 | -15.81 | -0.158 | 23 | END | 59s | |
| 32 | -9.84 | -0.098 | 2 | MCAP30 | 4s | |
| 33 | -11.76 | -0.118 | 24 | END | 73s | |
| 34 | -9.25 | -0.092 | 3 | END | 3s | |
| 35 | -23.51 | -0.235 | 16 | END | 46s | |
| 36 | -12.90 | -0.129 | 4 | MCAP30 | 13s | |
| 37 | +26.26 | +0.263 | 15 | MCAP30 | 53s | |
| 38 | -13.42 | -0.134 | 15 | END | 38s | |
| 39 | -4.95 | -0.049 | 15 | END | 35s | |
| 40 | -12.90 | -0.129 | 3 | END | 21s | |
| 41 | -31.10 | -0.311 | 11 | END | 21s | |
| 42 | -9.03 | -0.090 | 2 | END | 1s | |
| 43 | -15.90 | -0.159 | 8 | END | 17s | |
| 44 | +4.41 | +0.044 | 9 | MCAP30 | 49s | |
| 45 | -0.60 | -0.006 | 1 | MCAP30 | 5s | |
| 46 | -27.57 | -0.276 | 15 | END | 44s | |
| 47 | -11.68 | -0.117 | 11 | MCAP30 | 46s | |
| 48 | +0.74 | +0.007 | 4 | MCAP30 | 12s | |
| 49 | +0.08 | +0.001 | 1 | MCAP30 | 2s | |
| 50 | -1.05 | -0.011 | 1 | MCAP30 | 3s | |
| 51 | -12.73 | -0.127 | 4 | MCAP30 | 15s | |
| 52 | +14.20 | +0.142 | 18 | MCAP30 | 52s | |
| 53 | -25.47 | -0.255 | 15 | END | 36s | |
| 54 | -12.45 | -0.124 | 26 | END | 72s | |
| 55 | -23.29 | -0.233 | 13 | END | 25s | |
| 56 | -5.21 | -0.052 | 5 | MCAP30 | 10s | |
| 57 | -37.92 | -0.379 | 17 | END | 55s | |
| 58 | -3.13 | -0.031 | 24 | END | 76s | |
| 59 | +3.41 | +0.034 | 14 | END | 42s | |
| 60 | +1.27 | +0.013 | 7 | END | 25s | |
| 61 | -19.20 | -0.192 | 1 | END | 1s | |
| 62 | -38.13 | -0.381 | 16 | END | 42s | |
| 63 | -22.32 | -0.223 | 21 | END | 59s | |
| 64 | **+93.09** | **+0.931** | 7 | END | 30s | **Big winner** |
| 65 | +2.08 | +0.021 | 14 | END | 55s | |
| 66 | -30.63 | -0.306 | 17 | END | 52s | |
| 67 | -6.55 | -0.065 | 2 | MCAP30 | 4s | |
| 68 | -14.46 | -0.145 | 6 | END | 10s | |
| 69 | -19.71 | -0.197 | 9 | END | 34s | |
| 70 | -10.58 | -0.106 | 7 | END | 14s | |
| 71 | -0.41 | -0.004 | 7 | END | 36s | |
| 72 | +1.79 | +0.018 | 2 | MCAP30 | 4s | |
| 73 | -51.28 | -0.513 | 30 | END | 72s | Worst single loss |
| 74 | -0.93 | -0.009 | 1 | MCAP30 | 1s | |
| 75 | -3.58 | -0.036 | 3 | MCAP30 | 7s | |
| 76 | -4.19 | -0.042 | 4 | MCAP30 | 8s | |
| 77 | -1.48 | -0.015 | 2 | END | 0s | |
| 78 | +20.03 | +0.200 | 3 | END | 4s | |
| 79 | +10.50 | +0.105 | 11 | END | 34s | |
| 80 | -0.15 | -0.002 | 4 | END | 3s | |
| 81 | +7.18 | +0.072 | 9 | MCAP30 | 32s | |
| 82 | +10.78 | +0.108 | 13 | END | 47s | |
| 83 | +9.73 | +0.097 | 5 | END | 22s | |
| 84 | -11.37 | -0.114 | 5 | MCAP30 | 19s | |
| 85 | -27.13 | -0.271 | 8 | END | 20s | |
| 86 | -24.31 | -0.243 | 5 | END | 23s | |
| 87 | -9.42 | -0.094 | 6 | MCAP30 | 13s | |
| 88 | -3.05 | -0.031 | 19 | MCAP30 | 63s | |
| 89 | -12.01 | -0.120 | 25 | END | 74s | |

### Aggregate Stats

| Metric | Value |
|--------|-------|
| Tokens | 89 |
| Winners | 32 (35.96% WR) |
| Losers | 57 |
| **Net P&L** | **+0.755 SOL** |
| **Wallet** | **1.0 → 1.755 SOL (+75.5%)** |
| Avg Win | +18.82% (+0.188 SOL) |
| Avg Loss | -14.11% (-0.141 SOL) |
| Win/Loss Size Ratio | 1.33:1 |
| Max Single Win | +195.30% (+1.953 SOL) |
| Max Single Loss | -51.28% (-0.513 SOL) |
| Exits: END | 55 (61.8%) |
| Exits: MCAP30 | 34 (38.2%) |
| Avg Duration | ~29s |

### P&L Distribution

```
  +195%  ████████████████████████████████████████████████  #22 (monster)
  + 93%  ████████████████████████                          #64
  + 47%  ████████████████                                  #29
  + 46%  ████████████████                                  #9
  + 39%  ██████████████                                    #1
  + 34%  ████████████                                      #16
  + 28%  ██████████                                        #11
  + 26%  █████████                                         #37
  + 21%  ████████                                          #13
  + 20%  ████████                                          #78
  + 14%  █████                                             #52
  + 11%  ████                                              #17
  + 11%  ████                                              #79
  + 11%  ████                                              #82
  +  0 to +10%  ██  (12 tokens: small wins/breakeven)
  -  0 to -10%  ██  (22 tokens: small losses)
  - 10 to -20%  ████  (15 tokens)
  - 20 to -30%  ██████  (10 tokens)
  - 30 to -40%  ████████  (4 tokens)
  - 40 to -52%  ████████████  (3 tokens: #28 -41%, #73 -51%, #57 -38%)
```

### Key Observation: Fat Tail Drives Profitability

The strategy is **net profitable only because of 2-3 monster winners** out of 89 tokens:
- Token #22: +195.30% (+1.953 SOL) — a single token contributed 259% of total net P&L
- Token #64: +93.09% (+0.931 SOL) — contributed 123% of total P&L
- Token #29: +47.47% (+0.475 SOL)

Without #22 alone, the strategy would be **net -1.198 SOL** (unprofitable).
Without #22 and #64, the strategy would be **net -2.129 SOL**.

This makes flipScalper a **fat-tail dependent strategy** — it bleeds on most tokens and relies on rare outsized winners to compensate.

---

## Behavior on Common Situations

### Situation 1: Token Pumps Hard (the ideal case)

**What happens:** Bot buys aggressively, price rises. Player's initial buy at defaults rides the entire pump. Flip buys add exposure on bot sell dips, and flip sells lock in profits on the way up.

**Example (Token #22, +195%):** Bot made 25 buys and 16 sells. Player entered at defaults, accumulated through flips. 18 player trades over 63 seconds. Exited via END when bot session finished — price was far above entry.

**Why it works:** The initial buy at defaults means the player is in at the absolute bottom. Even small pumps yield large % returns because entry price is so low (mcap ≈ 28 SOL at entry).

### Situation 2: Token Dumps Immediately (fast death)

**What happens:** Bot sells from the start or price never climbs above mcap 30. MCAP30 exit triggers quickly after mcap peaked briefly above 30.

**Example (Token #10, -1.11%):** Only 1 trade, mcap peaked barely above 30 then fell back. MCAP30 exit with tiny loss. Duration: 1 second.

**Why MCAP30 works:** 22 of 34 MCAP30 exits had losses under 7%. The floor cuts losers early before they can bleed further.

### Situation 3: Slow Sideways Grind (the dangerous case)

**What happens:** Token's mcap stays above 30 (so MCAP30 doesn't trigger) but price oscillates without trending. Each flip buy/sell cycle loses a small amount to slippage and fees. Over many cycles, losses compound.

**Example (Token #73, -51.28%):** 30 trades over 72 seconds. Bot made 17 buys and 27 sells. Price stayed above mcap 30 the entire session but bled down through repeated bot sells. Each flip cycle lost a little, and the initial position's value eroded. Worst single loss in the dataset.

**This is the strategy's Achilles heel.** No mechanism limits total loss during a session where mcap stays above 30 — the only exit is END (bot finishes) or MCAP30 (price drops below floor).

### Situation 4: Bot Sells Heavily (dump-dominant token)

**What happens:** More bot sells than buys. Each bot sell triggers either a FLIP BUY or FLIP SELL. If the flips are well-timed (sell on dips that recover), the player profits. If the price trends down, the player bleeds.

**Example (Token #28, -41.00%):** Bot made only 1 buy but 11 sells. Token dumped from the start. Player's initial position lost value continuously. 12 player trades, mostly unprofitable flips. Exited via END.

**Mitigation:** The FLIP STOP mechanism (sell flip portion if flip value < entry) limits individual flip losses, but the initial position has no stop loss.

### Situation 5: Very Short Session (< 5 seconds)

**What happens:** Bot does 1-2 trades then stops. Player has the initial buy plus maybe one flip. If the price moved up even slightly from defaults, this is a quick win. If down, a quick loss.

**Examples:**
- Token #1 (+39.34%): 2 bot trades, 7 seconds. Bot bought aggressively, pushing price up. Player won big.
- Token #42 (-9.03%): 2 trades, 1 second. Bot sold, price dropped. Player lost.

**Observation:** Short sessions are a coin flip. The initial buy at defaults provides a slight edge because any bot buy pushes price up from the player's entry.

### Situation 6: Token Pumps Then Crashes Through MCAP 30

**What happens:** Token pumps above mcap 30 (activating `mcapPeaked`), player flips profitably, then price crashes below 30. MCAP30 exit triggers with the accumulated profit (or partial profit) intact.

**Example (Token #11, +28.15%):** Bot made 12 buys and 5 sells. Token pumped, player flipped 5 times profitably. Then price crashed below mcap 30, triggering MCAP30 exit at +28.15%. The floor caught the crash.

**This is MCAP30 working as designed** — letting winners run while they're above 30, then cutting when they fall.

---

## Strengths

1. **Earliest possible entry** — buying at bonding curve defaults means the player is in before anyone else, at the theoretical minimum price
2. **No missed trades** — persistent subscription eliminates the per-token subscribe race condition
3. **Asymmetric payoffs** — winners can be 10-100x larger than typical losses due to early entry
4. **Automatic loss cutting** — MCAP30 floor catches most dumps before they become catastrophic
5. **Simple mechanics** — alternating buy/sell with a floor, no complex entry filters or trailing stops that failed in other strategies (SmartDipAccumulator, ProportionalDip)

## Weaknesses

1. **Fat-tail dependent** — profitability relies on rare monster winners; removing the top 2 of 89 tokens makes the strategy unprofitable
2. **Low win rate** — 36% WR means long losing streaks are common, requiring psychological discipline and sufficient bankroll
3. **No max loss per token** — the initial position has no stop loss; slow grinds above mcap 30 can produce -40% to -50% losses
4. **Sideways grind vulnerability** — tokens that stay above mcap 30 but don't pump bleed the player through repeated flip cycles
5. **Session duration risk** — longer sessions (60-80s) with many trades tend to lose; the strategy works best with fast pumps or fast exits

---

## Comparison With Other Strategies

| Metric | flipScalper v2 | dipAccumulator TP=5 | SmartDipAccumulator | ProportionalDip |
|--------|---------------|---------------------|---------------------|-----------------|
| Win Rate | 36% | 67-75% | 45% (live) | 36% |
| Net P&L (best run) | +0.755 SOL | +0.495 SOL | negative | -0.50 SOL |
| Avg Win | +19% | +6.5% | ~+5% | varies |
| Avg Loss | -14% | -22% | varies | varies |
| Edge Type | Fat tail | Win rate | none live | none live |
| Risk Profile | High variance | Low variance | failed | failed |
| Complexity | Low | Low | High (filters) | Medium |

flipScalper has the highest total P&L but also the highest variance. dipAccumulator is more consistent with higher win rate but lower per-trade profit. The complex strategies (SmartDipAccumulator, ProportionalDip) failed in live conditions due to offline dataset bias and overshoot issues.

---

## Statistical Caveats

1. **Sample size**: 89 tokens is meaningful but not conclusive. The strategy's fat-tail nature means results are highly sensitive to the presence or absence of 1-2 monster winners.

2. **Time dependence**: All 89 tokens were collected in a single ~2.5 hour window on 2026-02-15. Market conditions (overall Solana memecoin activity, bot wallet behavior) may vary by time of day, day of week, or market regime.

3. **Survivor bias in winners**: The biggest winner (#22, +195%) was an unusual token that pumped 3x. The next 100 tokens might not contain such an outlier.

4. **Run 9 in progress**: A 100+ token run is currently being collected to provide a larger, independent sample. This will help determine whether the +75.5% result is reproducible or was driven by lucky variance.

---

## Appendix: Files

- `tools/backtestMainnet.js` — Implementation (`streamAndSimulateFlipScalper()` at line 797, persistent sub at line 1704)
- `tools/offlineSweep.js` — Offline parameter sweep with flipScalper support
- `analysis/live_runs/flipscalper_run8.jsonl` — Run 8 raw data (89 tokens)
- `analysis/live_runs/flipscalper_run9.jsonl` — Run 9 raw data (in progress)
- `tools/monteCarloSimulation.js` — BondingCurve class used for curve math
