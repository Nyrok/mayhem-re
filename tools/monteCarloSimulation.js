#!/usr/bin/env node

/**
 * Monte Carlo Simulation — Mayhem Bot Trading Strategies
 *
 * Simulates player strategies against the Mayhem bot's random 50/50 buy/sell behavior
 * on a Pump Fun bonding curve. All AMM math uses BigInt for on-chain precision (lamports).
 *
 * Usage:
 *   node tools/monteCarloSimulation.js                          # 10k sims, all strategies
 *   node tools/monteCarloSimulation.js -n 50000                 # 50k sims
 *   node tools/monteCarloSimulation.js --strategies=contrarian,quickFlip
 *   node tools/monteCarloSimulation.js --stopLoss=15 --takeProfit=30
 *   node tools/monteCarloSimulation.js --tradeSize=0.01         # position size in SOL
 *   node tools/monteCarloSimulation.js --seed=42                # deterministic
 *   node tools/monteCarloSimulation.js --json                   # JSON output
 */

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const LAMPORTS_PER_SOL = 1_000_000_000n;

// Pump Fun initial bonding curve state (before any trades)
const INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000_000_000n;
const INITIAL_VIRTUAL_SOL_RESERVES   = 30_000_000_000n;       // 30 SOL
const INITIAL_REAL_TOKEN_RESERVES    = 793_100_000_000_000n;
const INITIAL_REAL_SOL_RESERVES      = 0n;

const FEE_BASIS_POINTS = 100n;   // 1% fee
const BASIS_POINTS     = 10_000n;

const INITIAL_BUY_SOL = 60_000_000n; // 0.06 SOL — creator buy at token creation

const BOT_MAX_TRADES   = 50;
const BOT_TRADE_NUM    = 20n;  // numerator: 20%
const BOT_TRADE_DEN    = 100n; // denominator
const BOT_MAX_BUY_SOL  = 20_000_000_000n; // 20 SOL cap observed on-chain

const ALL_STRATEGIES = ['buyAndHold', 'followMomentum', 'contrarian', 'threshold', 'dca', 'quickFlip', 'dipAccumulator'];

// ═══════════════════════════════════════════════════════════════════════════
// SeededRandom — LCG 64-bit PRNG for deterministic results
// ═══════════════════════════════════════════════════════════════════════════

const LCG_A    = 6364136223846793005n;
const LCG_C    = 1442695040888963407n;
const MASK_64  = (1n << 64n) - 1n;

class SeededRandom {
    constructor(seed) {
        this.state = BigInt(seed) & MASK_64;
    }

    next() {
        this.state = (LCG_A * this.state + LCG_C) & MASK_64;
        return Number(this.state >> 33n) / 2147483648; // upper 31 bits → [0, 1)
    }

    nextBool() {
        return this.next() < 0.5;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// BondingCurve — Constant-product AMM (all BigInt)
// ═══════════════════════════════════════════════════════════════════════════

class BondingCurve {
    constructor() {
        this.virtualTokenReserves = INITIAL_VIRTUAL_TOKEN_RESERVES;
        this.virtualSolReserves   = INITIAL_VIRTUAL_SOL_RESERVES;
        this.realTokenReserves    = INITIAL_REAL_TOKEN_RESERVES;
        this.realSolReserves      = INITIAL_REAL_SOL_RESERVES;
    }

    getPriceFloat() {
        return Number(this.virtualSolReserves) / Number(this.virtualTokenReserves);
    }

    // Pure calculation: how many tokens would solAmount buy (after fee)
    getTokensForSol(solAmount) {
        const fee = solAmount * FEE_BASIS_POINTS / BASIS_POINTS;
        const solAfterFee = solAmount - fee;
        return solAfterFee * this.virtualTokenReserves / (this.virtualSolReserves + solAfterFee);
    }

    // Pure calculation: how much SOL would tokenAmount yield (after fee)
    getSolForTokens(tokenAmount) {
        if (tokenAmount <= 0n) return 0n;
        const solBeforeFee = tokenAmount * this.virtualSolReserves / (this.virtualTokenReserves + tokenAmount);
        const fee = solBeforeFee * FEE_BASIS_POINTS / BASIS_POINTS;
        return solBeforeFee - fee;
    }

    // Execute buy: solAmount is total SOL spent (fee deducted internally). Returns tokens received.
    executeBuy(solAmount) {
        if (solAmount <= 0n) return 0n;

        const fee = solAmount * FEE_BASIS_POINTS / BASIS_POINTS;
        const solAfterFee = solAmount - fee;
        const tokensOut = solAfterFee * this.virtualTokenReserves / (this.virtualSolReserves + solAfterFee);

        this.virtualSolReserves   += solAfterFee;
        this.virtualTokenReserves -= tokensOut;
        this.realSolReserves      += solAfterFee;
        this.realTokenReserves    -= tokensOut;

        return tokensOut;
    }

    // Execute sell: tokenAmount tokens sold. Returns SOL received (after fee).
    executeSell(tokenAmount) {
        if (tokenAmount <= 0n) return 0n;

        const solBeforeFee = tokenAmount * this.virtualSolReserves / (this.virtualTokenReserves + tokenAmount);

        // Guard: can't extract more SOL than the pool actually holds
        if (solBeforeFee > this.realSolReserves) return 0n;

        const fee = solBeforeFee * FEE_BASIS_POINTS / BASIS_POINTS;
        const solOut = solBeforeFee - fee;

        this.virtualTokenReserves += tokenAmount;
        this.virtualSolReserves   -= solBeforeFee;
        this.realTokenReserves    += tokenAmount;
        this.realSolReserves      -= solBeforeFee;

        return solOut;
    }

    // Reverse-calculate: how many tokens to sell to receive targetSolOut (after fee)
    getTokensToSellForSol(targetSolOut) {
        if (targetSolOut <= 0n) return -1n;

        // solOut = solBeforeFee * (BASIS_POINTS - FEE_BASIS_POINTS) / BASIS_POINTS
        // → solBeforeFee = solOut * BASIS_POINTS / (BASIS_POINTS - FEE_BASIS_POINTS)
        const solBeforeFee = targetSolOut * BASIS_POINTS / (BASIS_POINTS - FEE_BASIS_POINTS);

        if (solBeforeFee >= this.virtualSolReserves) return -1n;
        if (solBeforeFee > this.realSolReserves) return -1n;

        // tokenAmount = solBeforeFee * vTokenReserves / (vSolReserves - solBeforeFee)
        return solBeforeFee * this.virtualTokenReserves / (this.virtualSolReserves - solBeforeFee);
    }

    snapshot() {
        return {
            virtualTokenReserves: this.virtualTokenReserves,
            virtualSolReserves:   this.virtualSolReserves,
            realTokenReserves:    this.realTokenReserves,
            realSolReserves:      this.realSolReserves,
        };
    }

    restore(snap) {
        this.virtualTokenReserves = snap.virtualTokenReserves;
        this.virtualSolReserves   = snap.virtualSolReserves;
        this.realTokenReserves    = snap.realTokenReserves;
        this.realSolReserves      = snap.realSolReserves;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// BotAgent — Simulates the Mayhem bot (50/50 random buy/sell)
// ═══════════════════════════════════════════════════════════════════════════

class BotAgent {
    constructor(rng, buyBias = 0.5) {
        this.rng = rng;
        this.buyBias = buyBias;
        this.tokenBalance = 0n;
        this.tradeCount = 0;
        this.lastAction = null;
    }

    decideAction() {
        return this.rng.next() < this.buyBias ? 'buy' : 'sell';
    }

    // BUY amount = min(realSolReserves * 20%, 20 SOL cap)
    calculateBuyAmount(curve) {
        const amount = curve.realSolReserves * BOT_TRADE_NUM / BOT_TRADE_DEN;
        return amount > BOT_MAX_BUY_SOL ? BOT_MAX_BUY_SOL : amount;
    }

    // SELL target = (realSolReserves * 20%) - 1 lamport
    calculateSellTargetSol(curve) {
        const base = curve.realSolReserves * BOT_TRADE_NUM / BOT_TRADE_DEN;
        return base > 0n ? base - 1n : 0n;
    }

    shouldStop() {
        return this.tradeCount >= BOT_MAX_TRADES;
    }

    // Returns trade result or null if trade failed/skipped
    executeTrade(curve) {
        if (this.shouldStop()) return null;

        const action = this.decideAction();

        if (action === 'buy') {
            const solAmount = this.calculateBuyAmount(curve);
            if (solAmount === 0n) { this.tradeCount++; return null; }

            const tokensReceived = curve.executeBuy(solAmount);
            this.tokenBalance += tokensReceived;
            this.tradeCount++;
            this.lastAction = 'buy';
            return { action: 'buy', solAmount, tokensReceived };

        } else {
            const targetSol = this.calculateSellTargetSol(curve);
            if (targetSol <= 0n) { this.tradeCount++; return null; }

            const tokensNeeded = curve.getTokensToSellForSol(targetSol);
            if (tokensNeeded <= 0n) { this.tradeCount++; return null; }

            // Clamp to bot's actual balance
            const tokensToSell = tokensNeeded > this.tokenBalance
                ? this.tokenBalance
                : tokensNeeded;
            if (tokensToSell === 0n) { this.tradeCount++; return null; }

            const solReceived = curve.executeSell(tokensToSell);
            this.tokenBalance -= tokensToSell;
            this.tradeCount++;
            this.lastAction = 'sell';
            return { action: 'sell', tokenAmount: tokensToSell, solReceived };
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// NoiseActor — External market participant (perturbation)
// ═══════════════════════════════════════════════════════════════════════════

class NoiseActor {
    constructor(rng, tradeSize) {
        this.rng = rng;
        this.tradeSize = tradeSize;  // SOL per trade
        this.tokenBalance = 0n;
    }

    maybeTrade(curve, probability) {
        if (this.rng.next() >= probability) return null;

        if (this.tokenBalance > 0n && this.rng.nextBool()) {
            curve.executeSell(this.tokenBalance);
            this.tokenBalance = 0n;
            return 'sell';
        } else {
            const solAmount = BigInt(Math.floor(this.tradeSize * 1e9));
            const tokens = curve.executeBuy(solAmount);
            this.tokenBalance += tokens;
            return 'buy';
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// PlayerAgent — 6 trading strategies with risk management
// ═══════════════════════════════════════════════════════════════════════════

class PlayerAgent {
    constructor(strategy, config) {
        this.strategy = strategy;

        this.stopLoss       = config.stopLoss;
        this.takeProfit     = config.takeProfit;
        this.maxTrades      = config.maxTrades;
        this.maxPositionPct = config.maxPositionPct || 50;
        this.tradeSize      = config.tradeSize;
        this.entryTrade     = config.entryTrade;
        this.exitTrade      = config.exitTrade;
        this.buyThreshold   = config.buyThreshold;
        this.sellThreshold  = config.sellThreshold;

        this.budget        = config.budget || this.tradeSize;
        this.solBalance   = BigInt(Math.floor(this.budget * 1e9));
        this.initialSol   = this.solBalance;
        this.tokenBalance = 0n;
        this.tradeCount   = 0;
        this.entryPrice   = 0;
        this.referencePrice = 0;
        this.exited       = false;
    }

    // Portfolio value = SOL balance + current market value of tokens
    getPortfolioValue(curve) {
        const tokenValue = this.tokenBalance > 0n ? curve.getSolForTokens(this.tokenBalance) : 0n;
        return this.solBalance + tokenValue;
    }

    // Returns true if risk limit triggered (player exited or should stop trading)
    _checkRisk(curve) {
        if (this.exited) return true;
        if (this.tradeCount >= this.maxTrades) return true;
        if (this.tokenBalance === 0n) return false;

        const currentValue = this.getPortfolioValue(curve);
        const pnlPct = Number(currentValue - this.initialSol) / Number(this.initialSol) * 100;

        if (pnlPct <= -this.stopLoss) {
            this._sellAll(curve);
            return true;
        }
        if (pnlPct >= this.takeProfit) {
            this._sellAll(curve);
            return true;
        }
        return false;
    }

    _buy(curve, solAmount) {
        if (this.exited || solAmount <= 0n) return;
        if (solAmount > this.solBalance) solAmount = this.solBalance;
        if (solAmount <= 0n) return;

        // Max position: cap at maxPositionPct% of pool's real SOL reserves
        const maxSol = curve.realSolReserves * BigInt(this.maxPositionPct) / 100n;
        if (maxSol > 0n && solAmount > maxSol) solAmount = maxSol;
        if (solAmount > this.solBalance) solAmount = this.solBalance;
        if (solAmount <= 0n) return;

        const tokens = curve.executeBuy(solAmount);
        this.tokenBalance += tokens;
        this.solBalance -= solAmount;
        this.tradeCount++;

        if (this.entryPrice === 0) this.entryPrice = curve.getPriceFloat();
    }

    _sellAll(curve) {
        if (this.tokenBalance <= 0n) return;
        const sol = curve.executeSell(this.tokenBalance);
        this.solBalance += sol;
        this.tokenBalance = 0n;
        this.tradeCount++;
        this.exited = true;
    }

    // Called after each bot trade
    react(curve, botTradeIndex, botAction) {
        if (this.exited || this._checkRisk(curve)) return;

        const size = BigInt(Math.floor(this.tradeSize * 1e9));

        switch (this.strategy) {
            case 'buyAndHold':
                return this._buyAndHold(curve, botTradeIndex, size);
            case 'followMomentum':
                return this._followMomentum(curve, botAction, size);
            case 'contrarian':
                return this._contrarian(curve, botAction, size);
            case 'threshold':
                return this._threshold(curve, size);
            case 'dca':
                return this._dca(curve, botTradeIndex, size);
            case 'quickFlip':
                return this._quickFlip(curve, botAction, size);
            case 'dipAccumulator':
                return this._dipAccumulator(curve, botAction, size);
        }
    }

    // Strategy 1: Buy at trade N, sell at trade M
    _buyAndHold(curve, idx, size) {
        if (idx === this.entryTrade && this.tokenBalance === 0n) this._buy(curve, size);
        if (idx >= this.exitTrade) this._sellAll(curve);
    }

    // Strategy 2: Buy when bot buys (price rising), sell when bot sells
    _followMomentum(curve, botAction, size) {
        if (botAction === 'buy' && this.solBalance > 0n) this._buy(curve, size);
        if (botAction === 'sell' && this.tokenBalance > 0n) this._sellAll(curve);
    }

    // Strategy 3: Buy the dip (bot sells), sell the peak (bot buys)
    _contrarian(curve, botAction, size) {
        if (botAction === 'sell' && this.solBalance > 0n) this._buy(curve, size);
        if (botAction === 'buy' && this.tokenBalance > 0n) this._sellAll(curve);
    }

    // Strategy 4: Buy if price drops X%, sell if price rises Y%
    _threshold(curve, size) {
        const price = curve.getPriceFloat();
        if (this.referencePrice === 0) { this.referencePrice = price; return; }

        const changePct = (price - this.referencePrice) / this.referencePrice * 100;

        if (changePct <= this.buyThreshold && this.solBalance > 0n) {
            this._buy(curve, size);
            this.referencePrice = price;
        }
        if (changePct >= this.sellThreshold && this.tokenBalance > 0n) {
            this._sellAll(curve);
            this.referencePrice = price;
        }
    }

    // Strategy 5: Small buys spread between trade N and M, sell all at M
    _dca(curve, idx, size) {
        if (idx >= this.entryTrade && idx < this.exitTrade) {
            const numBuys = this.exitTrade - this.entryTrade;
            const dcaSize = size / BigInt(numBuys);
            if (dcaSize > 0n && this.solBalance >= dcaSize) this._buy(curve, dcaSize);
        }
        if (idx >= this.exitTrade) this._sellAll(curve);
    }

    // Strategy 6: Buy right after bot buys, sell at next bot sell
    _quickFlip(curve, botAction, size) {
        if (botAction === 'buy' && this.tokenBalance === 0n && this.solBalance > 0n) {
            this._buy(curve, size);
        }
        if (botAction === 'sell' && this.tokenBalance > 0n) {
            this._sellAll(curve);
        }
    }

    // Strategy 7: Accumulate on dips — buy when bot sells, never explicitly sell
    // Exits only via _checkRisk (takeProfit/stopLoss) or forceExit
    _dipAccumulator(curve, botAction, size) {
        if (botAction === 'sell' && this.solBalance > 0n) {
            this._buy(curve, size);
        }
    }

    forceExit(curve) {
        if (!this.exited && this.tokenBalance > 0n) this._sellAll(curve);
    }

    getPnL() {
        return {
            pnl: this.solBalance - this.initialSol,
            pnlPct: Number(this.solBalance - this.initialSol) / Number(this.initialSol) * 100,
            finalSol: this.solBalance,
            initialSol: this.initialSol,
            tradeCount: this.tradeCount,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SimulationEngine — Orchestrates one simulation run
// ═══════════════════════════════════════════════════════════════════════════

class SimulationEngine {
    constructor(strategy, config, seed) {
        this.strategy = strategy;
        this.config = config;
        this.seed = seed;
    }

    run() {
        const rng   = new SeededRandom(this.seed);
        const curve = new BondingCurve();

        // Initial buy (token creation) — tokens go to the bot (creator)
        const initialTokens = curve.executeBuy(INITIAL_BUY_SOL);

        const bot    = new BotAgent(rng, this.config.botBuyBias);
        bot.tokenBalance = initialTokens;

        const player = new PlayerAgent(this.strategy, this.config);

        // Player's initial buy at token creation (before bot starts)
        if (this.config.initialBuy > 0) {
            const initialBuyAmount = BigInt(Math.floor(this.config.initialBuy * 1e9));
            player._buy(curve, initialBuyAmount);
        }

        // Create noise actors (separate RNG to preserve backward compatibility)
        const noiseActors = [];
        if (this.config.noiseActors > 0) {
            const noiseRng = new SeededRandom(this.seed + 1_000_000);

            // Weighted random count: P(k) ∝ (maxN - k + 1) → favors fewer actors
            // For maxN=2: P(0)=50%, P(1)=33%, P(2)=17%
            const maxN = this.config.noiseActors;
            const totalWeight = (maxN + 1) * (maxN + 2) / 2;
            const r = noiseRng.next();
            let cumulative = 0, numActors = 0;
            for (let k = 0; k <= maxN; k++) {
                cumulative += (maxN - k + 1) / totalWeight;
                if (r < cumulative) { numActors = k; break; }
            }

            // Random trade size per actor: uniform [noiseSize, noiseSizeMax]
            const sizeMin = this.config.noiseSize;
            const sizeMax = this.config.noiseSizeMax;
            for (let i = 0; i < numActors; i++) {
                const size = sizeMin + noiseRng.next() * (sizeMax - sizeMin);
                noiseActors.push(new NoiseActor(noiseRng, size));
            }
        }

        const initialPrice = curve.getPriceFloat();
        let peakValue = player.getPortfolioValue(curve);
        let maxDrawdown = 0;

        let botTradeIndex = 0;
        while (!bot.shouldStop()) {
            const result = bot.executeTrade(curve);
            if (!result) { botTradeIndex++; continue; }

            // Noise actors perturb the market
            for (const actor of noiseActors) {
                actor.maybeTrade(curve, this.config.noiseProbability);
            }

            // Player observes and reacts
            player.react(curve, botTradeIndex, result.action);

            // Bot stops when player exits (sells)
            if (player.exited) break;

            // Track player drawdown
            const val = player.getPortfolioValue(curve);
            if (val > peakValue) peakValue = val;
            if (peakValue > 0n) {
                const dd = Number(peakValue - val) / Number(peakValue) * 100;
                if (dd > maxDrawdown) maxDrawdown = dd;
            }

            botTradeIndex++;
        }

        // Force player exit at end of bot session
        player.forceExit(curve);

        const pnl = player.getPnL();
        return {
            ...pnl,
            maxDrawdown,
            botTrades: bot.tradeCount,
            initialPrice,
            finalPrice: curve.getPriceFloat(),
            finalRealSolReserves: curve.realSolReserves,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MonteCarloRunner — N simulations, aggregate statistics
// ═══════════════════════════════════════════════════════════════════════════

class MonteCarloRunner {
    constructor(config) {
        this.numSimulations = config.numSimulations;
        this.baseSeed = config.seed;
        this.config = config;
    }

    runStrategy(strategy) {
        const results = [];
        for (let i = 0; i < this.numSimulations; i++) {
            const seed = this.baseSeed !== null
                ? this.baseSeed + i
                : Math.floor(Math.random() * 2 ** 32);
            const engine = new SimulationEngine(strategy, this.config, seed);
            results.push(engine.run());
        }
        return this._computeStats(results, strategy);
    }

    _computeStats(results, strategy) {
        const pnlPcts   = results.map(r => r.pnlPct).sort((a, b) => a - b);
        const drawdowns = results.map(r => r.maxDrawdown);
        const trades    = results.map(r => r.tradeCount);
        const n = pnlPcts.length;

        const wins = pnlPcts.filter(p => p > 0).length;
        const mean = pnlPcts.reduce((a, b) => a + b, 0) / n;
        const median = pnlPcts[Math.floor(n / 2)];
        const stdDev = Math.sqrt(pnlPcts.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
        const sharpe = stdDev > 0 ? mean / stdDev : 0;

        return {
            strategy,
            count: n,
            mean,
            median,
            stdDev,
            min: pnlPcts[0],
            max: pnlPcts[n - 1],
            winRate: wins / n * 100,
            sharpe,
            maxDrawdown: drawdowns.reduce((a, b) => a > b ? a : b, 0),
            avgDrawdown: drawdowns.reduce((a, b) => a + b, 0) / n,
            avgTrades: trades.reduce((a, b) => a + b, 0) / n,
            percentiles: {
                p5:  pnlPcts[Math.floor(n * 0.05)],
                p25: pnlPcts[Math.floor(n * 0.25)],
                p50: median,
                p75: pnlPcts[Math.floor(n * 0.75)],
                p95: pnlPcts[Math.floor(n * 0.95)],
            },
            pnlDistribution: pnlPcts,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Output Formatting
// ═══════════════════════════════════════════════════════════════════════════

function formatSign(val, decimals = 2) {
    return (val >= 0 ? '+' : '') + val.toFixed(decimals);
}

function formatStrategyResult(stats) {
    const lines = [];
    lines.push(`\n${'─'.repeat(70)}`);
    lines.push(`Strategy: ${stats.strategy}`);
    lines.push(`${'─'.repeat(70)}`);
    lines.push(`  Simulations: ${stats.count.toLocaleString()}`);
    lines.push(`  Win Rate:    ${stats.winRate.toFixed(1)}%`);
    lines.push(`  Mean P&L:    ${formatSign(stats.mean)}%`);
    lines.push(`  Median P&L:  ${formatSign(stats.median)}%`);
    lines.push(`  Std Dev:     ${stats.stdDev.toFixed(2)}%`);
    lines.push(`  Sharpe:      ${stats.sharpe.toFixed(3)}`);
    lines.push(`  Min:         ${stats.min.toFixed(2)}%`);
    lines.push(`  Max:         ${formatSign(stats.max)}%`);
    lines.push(`  Avg Trades:  ${stats.avgTrades.toFixed(1)}`);
    lines.push(`  Max DD:      ${stats.maxDrawdown.toFixed(2)}%`);
    lines.push(`  Avg DD:      ${stats.avgDrawdown.toFixed(2)}%`);
    lines.push(`  Percentiles:`);
    lines.push(`     5th:  ${formatSign(stats.percentiles.p5)}%`);
    lines.push(`    25th:  ${formatSign(stats.percentiles.p25)}%`);
    lines.push(`    50th:  ${formatSign(stats.percentiles.p50)}%`);
    lines.push(`    75th:  ${formatSign(stats.percentiles.p75)}%`);
    lines.push(`    95th:  ${formatSign(stats.percentiles.p95)}%`);
    lines.push(`\n  Distribution:`);
    lines.push(asciiHistogram(stats.pnlDistribution));
    return lines.join('\n');
}

function asciiHistogram(values, bins = 20, barWidth = 40) {
    if (values.length === 0) return '    (no data)';

    const min = values[0];
    const max = values[values.length - 1];
    const range = max - min || 1;
    const binSize = range / bins;

    const counts = new Array(bins).fill(0);
    for (const v of values) {
        let b = Math.floor((v - min) / binSize);
        if (b >= bins) b = bins - 1;
        counts[b]++;
    }

    const maxCount = Math.max(...counts);
    const lines = [];

    for (let i = 0; i < bins; i++) {
        const lo = (min + i * binSize).toFixed(1);
        const barLen = maxCount > 0 ? Math.round(counts[i] / maxCount * barWidth) : 0;
        lines.push(`    ${lo.padStart(8)}% |${'█'.repeat(barLen)} ${counts[i]}`);
    }
    return lines.join('\n');
}

function printComparisonTable(allStats) {
    console.log(`\n${'═'.repeat(94)}`);
    console.log(`STRATEGY COMPARISON`);
    console.log(`${'═'.repeat(94)}`);

    const cols = [
        { label: 'Strategy',  w: 16 },
        { label: 'Win%',      w: 7  },
        { label: 'Mean%',     w: 9  },
        { label: 'Med%',      w: 9  },
        { label: 'StdDev',    w: 8  },
        { label: 'Sharpe',    w: 8  },
        { label: 'MaxDD%',    w: 8  },
        { label: 'AvgTrd',    w: 7  },
    ];

    const header = cols.map(c => c.label.padStart(c.w)).join(' | ');
    console.log(header);
    console.log('─'.repeat(94));

    for (const s of allStats) {
        const row = [
            s.strategy.padEnd(16),
            s.winRate.toFixed(1).padStart(7),
            formatSign(s.mean).padStart(9),
            formatSign(s.median).padStart(9),
            s.stdDev.toFixed(2).padStart(8),
            s.sharpe.toFixed(3).padStart(8),
            s.maxDrawdown.toFixed(1).padStart(8),
            s.avgTrades.toFixed(0).padStart(7),
        ].join(' | ');
        console.log(row);
    }

    console.log(`${'═'.repeat(94)}`);

    const bestSharpe = allStats.reduce((a, b) => a.sharpe > b.sharpe ? a : b);
    const bestWin    = allStats.reduce((a, b) => a.winRate > b.winRate ? a : b);
    const bestMean   = allStats.reduce((a, b) => a.mean > b.mean ? a : b);

    console.log(`\nBest by Sharpe ratio: ${bestSharpe.strategy} (${bestSharpe.sharpe.toFixed(3)})`);
    console.log(`Best by Win Rate:     ${bestWin.strategy} (${bestWin.winRate.toFixed(1)}%)`);
    console.log(`Best by Mean P&L:     ${bestMean.strategy} (${formatSign(bestMean.mean)}%)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI Argument Parsing
// ═══════════════════════════════════════════════════════════════════════════

function parseArgs() {
    const args = process.argv.slice(2);
    const config = {
        numSimulations: 10_000,
        strategies: ALL_STRATEGIES,
        seed: null,
        json: false,
        stopLoss: 20,
        takeProfit: 50,
        tradeSize: 0.1,
        entryTrade: 5,
        exitTrade: 40,
        buyThreshold: -0.1,
        sellThreshold: 0.1,
        maxTrades: 20,
        maxPositionPct: 50,
        budget: 0,
        initialBuy: 0,
        botBuyBias: 0.5,
        noiseActors: 0,
        noiseProbability: 0.3,
        noiseSize: 0.1,
        noiseSizeMax: null,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-n' && i + 1 < args.length) {
            config.numSimulations = parseInt(args[++i]);
        } else if (arg.startsWith('-n=')) {
            config.numSimulations = parseInt(arg.slice(3));
        } else if (arg.startsWith('--strategies=')) {
            config.strategies = arg.split('=')[1].split(',');
        } else if (arg.startsWith('--seed=')) {
            config.seed = parseInt(arg.split('=')[1]);
        } else if (arg === '--json') {
            config.json = true;
        } else if (arg.startsWith('--stopLoss=')) {
            config.stopLoss = parseFloat(arg.split('=')[1]);
        } else if (arg.startsWith('--takeProfit=')) {
            config.takeProfit = parseFloat(arg.split('=')[1]);
        } else if (arg.startsWith('--tradeSize=')) {
            config.tradeSize = parseFloat(arg.split('=')[1]);
        } else if (arg.startsWith('--entryTrade=')) {
            config.entryTrade = parseInt(arg.split('=')[1]);
        } else if (arg.startsWith('--exitTrade=')) {
            config.exitTrade = parseInt(arg.split('=')[1]);
        } else if (arg.startsWith('--buyThreshold=')) {
            config.buyThreshold = parseFloat(arg.split('=')[1]);
        } else if (arg.startsWith('--sellThreshold=')) {
            config.sellThreshold = parseFloat(arg.split('=')[1]);
        } else if (arg.startsWith('--maxTrades=')) {
            config.maxTrades = parseInt(arg.split('=')[1]);
        } else if (arg.startsWith('--budget=')) {
            config.budget = parseFloat(arg.split('=')[1]);
        } else if (arg.startsWith('--initialBuy=')) {
            config.initialBuy = parseFloat(arg.split('=')[1]);
        } else if (arg.startsWith('--botBuyBias=')) {
            config.botBuyBias = parseFloat(arg.split('=')[1]);
        } else if (arg.startsWith('--noiseActors=')) {
            config.noiseActors = parseInt(arg.split('=')[1]);
        } else if (arg.startsWith('--noiseProbability=')) {
            config.noiseProbability = parseFloat(arg.split('=')[1]);
        } else if (arg.startsWith('--noiseSize=')) {
            config.noiseSize = parseFloat(arg.split('=')[1]);
        } else if (arg.startsWith('--noiseSizeMax=')) {
            config.noiseSizeMax = parseFloat(arg.split('=')[1]);
        }
    }

    // Default noiseSizeMax to noiseSize for backward compat
    if (config.noiseSizeMax === null) config.noiseSizeMax = config.noiseSize;

    return config;
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

function main() {
    const config = parseArgs();

    if (!config.json) {
        console.log(`\n${'═'.repeat(70)}`);
        console.log(`MONTE CARLO SIMULATION — Mayhem Bot Trading Strategies`);
        console.log(`${'═'.repeat(70)}`);
        console.log(`Simulations per strategy: ${config.numSimulations.toLocaleString()}`);
        console.log(`Trade size: ${config.tradeSize} SOL${config.budget ? ` | Budget: ${config.budget} SOL` : ''}`);
        console.log(`Stop loss: ${config.stopLoss}% | Take profit: ${config.takeProfit}%`);
        if (config.initialBuy > 0) console.log(`Initial buy: ${config.initialBuy} SOL (at token creation)`);
        if (config.botBuyBias !== 0.5) console.log(`Bot buy bias: ${config.botBuyBias} (${(config.botBuyBias * 100).toFixed(0)}% buy / ${((1 - config.botBuyBias) * 100).toFixed(0)}% sell)`);
        if (config.seed !== null) console.log(`Seed: ${config.seed} (deterministic)`);
        console.log(`Strategies: ${config.strategies.join(', ')}`);
        if (config.noiseActors > 0) {
            const sizeStr = config.noiseSizeMax !== config.noiseSize
                ? `size=${config.noiseSize}-${config.noiseSizeMax} SOL`
                : `size=${config.noiseSize} SOL`;
            console.log(`Noise: 0..${config.noiseActors} actors (weighted→0), prob=${config.noiseProbability}, ${sizeStr}`);
        }
    }

    const runner = new MonteCarloRunner(config);
    const allStats = [];

    for (const strategy of config.strategies) {
        if (!config.json) process.stdout.write(`\nRunning ${strategy}...`);

        const t0 = Date.now();
        const stats = runner.runStrategy(strategy);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

        if (!config.json) {
            console.log(` done (${elapsed}s)`);
            console.log(formatStrategyResult(stats));
        }

        allStats.push(stats);
    }

    if (config.json) {
        const output = allStats.map(({ pnlDistribution, ...rest }) => rest);
        console.log(JSON.stringify(output, null, 2));
    } else {
        printComparisonTable(allStats);
    }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''))) {
    main();
}

export { SeededRandom, BondingCurve, BotAgent, NoiseActor, PlayerAgent, SimulationEngine, MonteCarloRunner };
