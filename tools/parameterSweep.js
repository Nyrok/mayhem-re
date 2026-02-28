#!/usr/bin/env node

/**
 * Parameter Sweep — Exhaustive search for winRate >= 50%
 *
 * Sweeps all strategy×parameter combinations using worker_threads parallelism.
 * Each combo runs N Monte Carlo simulations to estimate win rate and mean P&L.
 *
 * Usage:
 *   node tools/parameterSweep.js                                    # full sweep, 1000 sims/combo
 *   node tools/parameterSweep.js -n 2000                            # 2000 sims per combo
 *   node tools/parameterSweep.js --seed=42                          # reproducible
 *   node tools/parameterSweep.js --target=30                        # target winRate >= 30%
 *   node tools/parameterSweep.js --json                             # JSON output
 *   node tools/parameterSweep.js --strategies=buyAndHold,dca        # specific strategies
 */

import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import os from 'os';

// ═══════════════════════════════════════════════════════════════════════════
// Constants (duplicated from monteCarloSimulation.js for worker isolation)
// ═══════════════════════════════════════════════════════════════════════════

const LAMPORTS_PER_SOL = 1_000_000_000n;
const INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000_000_000n;
const INITIAL_VIRTUAL_SOL_RESERVES   = 30_000_000_000n;
const INITIAL_REAL_TOKEN_RESERVES    = 793_100_000_000_000n;
const INITIAL_REAL_SOL_RESERVES      = 0n;
const FEE_BASIS_POINTS = 100n;
const BASIS_POINTS     = 10_000n;
const INITIAL_BUY_SOL  = 60_000_000n;
const BOT_MAX_TRADES   = 50;
const BOT_TRADE_NUM    = 20n;
const BOT_TRADE_DEN    = 100n;
const BOT_MAX_BUY_SOL  = 20_000_000_000n;

const LCG_A   = 6364136223846793005n;
const LCG_C   = 1442695040888963407n;
const MASK_64 = (1n << 64n) - 1n;

// ═══════════════════════════════════════════════════════════════════════════
// Core classes (inlined for worker_threads compatibility)
// ═══════════════════════════════════════════════════════════════════════════

class SeededRandom {
    constructor(seed) { this.state = BigInt(seed) & MASK_64; }
    next() {
        this.state = (LCG_A * this.state + LCG_C) & MASK_64;
        return Number(this.state >> 33n) / 2147483648;
    }
    nextBool() { return this.next() < 0.5; }
}

class BondingCurve {
    constructor() {
        this.virtualTokenReserves = INITIAL_VIRTUAL_TOKEN_RESERVES;
        this.virtualSolReserves   = INITIAL_VIRTUAL_SOL_RESERVES;
        this.realTokenReserves    = INITIAL_REAL_TOKEN_RESERVES;
        this.realSolReserves      = INITIAL_REAL_SOL_RESERVES;
    }
    getPriceFloat() { return Number(this.virtualSolReserves) / Number(this.virtualTokenReserves); }
    getSolForTokens(tokenAmount) {
        if (tokenAmount <= 0n) return 0n;
        let solBeforeFee = tokenAmount * this.virtualSolReserves / (this.virtualTokenReserves + tokenAmount);
        if (solBeforeFee > this.realSolReserves) solBeforeFee = this.realSolReserves;
        const fee = solBeforeFee * FEE_BASIS_POINTS / BASIS_POINTS;
        return solBeforeFee - fee;
    }
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
    executeSell(tokenAmount) {
        if (tokenAmount <= 0n) return 0n;
        let solBeforeFee = tokenAmount * this.virtualSolReserves / (this.virtualTokenReserves + tokenAmount);
        if (solBeforeFee > this.realSolReserves) solBeforeFee = this.realSolReserves;
        const fee = solBeforeFee * FEE_BASIS_POINTS / BASIS_POINTS;
        const solOut = solBeforeFee - fee;
        this.virtualTokenReserves += tokenAmount;
        this.virtualSolReserves   -= solBeforeFee;
        this.realTokenReserves    += tokenAmount;
        this.realSolReserves      -= solBeforeFee;
        return solOut;
    }
    getTokensToSellForSol(targetSolOut) {
        if (targetSolOut <= 0n) return -1n;
        const solBeforeFee = targetSolOut * BASIS_POINTS / (BASIS_POINTS - FEE_BASIS_POINTS);
        if (solBeforeFee >= this.virtualSolReserves) return -1n;
        if (solBeforeFee > this.realSolReserves) return -1n;
        return solBeforeFee * this.virtualTokenReserves / (this.virtualSolReserves - solBeforeFee);
    }
}

class BotAgent {
    constructor(rng, buyBias = 0.5) { this.rng = rng; this.buyBias = buyBias; this.tokenBalance = 0n; this.tradeCount = 0; }
    shouldStop() { return this.tradeCount >= BOT_MAX_TRADES; }
    executeTrade(curve) {
        if (this.shouldStop()) return null;
        const action = this.rng.next() < this.buyBias ? 'buy' : 'sell';
        if (action === 'buy') {
            const amount = curve.realSolReserves * BOT_TRADE_NUM / BOT_TRADE_DEN;
            const solAmount = amount > BOT_MAX_BUY_SOL ? BOT_MAX_BUY_SOL : amount;
            if (solAmount === 0n) { this.tradeCount++; return null; }
            const tokensReceived = curve.executeBuy(solAmount);
            this.tokenBalance += tokensReceived;
            this.tradeCount++;
            return { action: 'buy', solAmount, tokensReceived };
        } else {
            const base = curve.realSolReserves * BOT_TRADE_NUM / BOT_TRADE_DEN;
            const targetSol = base > 0n ? base - 1n : 0n;
            if (targetSol <= 0n) { this.tradeCount++; return null; }
            const tokensNeeded = curve.getTokensToSellForSol(targetSol);
            if (tokensNeeded <= 0n) { this.tradeCount++; return null; }
            const tokensToSell = tokensNeeded > this.tokenBalance ? this.tokenBalance : tokensNeeded;
            if (tokensToSell === 0n) { this.tradeCount++; return null; }
            const solReceived = curve.executeSell(tokensToSell);
            this.tokenBalance -= tokensToSell;
            this.tradeCount++;
            return { action: 'sell', tokenAmount: tokensToSell, solReceived };
        }
    }
}

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
        this.solBalance   = BigInt(Math.floor(this.tradeSize * 1e9));
        this.initialSol   = this.solBalance;
        this.tokenBalance = 0n;
        this.tradeCount   = 0;
        this.entryPrice   = 0;
        this.referencePrice = 0;
        this.exited       = false;
    }
    getPortfolioValue(curve) {
        const tokenValue = this.tokenBalance > 0n ? curve.getSolForTokens(this.tokenBalance) : 0n;
        return this.solBalance + tokenValue;
    }
    _checkRisk(curve) {
        if (this.exited) return true;
        if (this.tradeCount >= this.maxTrades) return true;
        if (this.tokenBalance === 0n) return false;
        const currentValue = this.getPortfolioValue(curve);
        const pnlPct = Number(currentValue - this.initialSol) / Number(this.initialSol) * 100;
        if (pnlPct <= -this.stopLoss) { this._sellAll(curve); return true; }
        if (pnlPct >= this.takeProfit) { this._sellAll(curve); return true; }
        return false;
    }
    _buy(curve, solAmount) {
        if (this.exited || solAmount <= 0n) return;
        if (solAmount > this.solBalance) solAmount = this.solBalance;
        if (solAmount <= 0n) return;
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
    react(curve, botTradeIndex, botAction) {
        if (this.exited || this._checkRisk(curve)) return;
        const size = BigInt(Math.floor(this.tradeSize * 1e9));
        switch (this.strategy) {
            case 'buyAndHold': return this._buyAndHold(curve, botTradeIndex, size);
            case 'followMomentum': return this._followMomentum(curve, botAction, size);
            case 'contrarian': return this._contrarian(curve, botAction, size);
            case 'threshold': return this._threshold(curve, size);
            case 'dca': return this._dca(curve, botTradeIndex, size);
            case 'quickFlip': return this._quickFlip(curve, botAction, size);
            case 'dipAccumulator': return this._dipAccumulator(curve, botAction, size);
        }
    }
    _buyAndHold(curve, idx, size) {
        if (idx === this.entryTrade && this.tokenBalance === 0n) this._buy(curve, size);
        if (idx >= this.exitTrade) this._sellAll(curve);
    }
    _followMomentum(curve, botAction, size) {
        if (botAction === 'buy' && this.solBalance > 0n) this._buy(curve, size);
        if (botAction === 'sell' && this.tokenBalance > 0n) this._sellAll(curve);
    }
    _contrarian(curve, botAction, size) {
        if (botAction === 'sell' && this.solBalance > 0n) this._buy(curve, size);
        if (botAction === 'buy' && this.tokenBalance > 0n) this._sellAll(curve);
    }
    _threshold(curve, size) {
        const price = curve.getPriceFloat();
        if (this.referencePrice === 0) { this.referencePrice = price; return; }
        const changePct = (price - this.referencePrice) / this.referencePrice * 100;
        if (changePct <= this.buyThreshold && this.solBalance > 0n) {
            this._buy(curve, size); this.referencePrice = price;
        }
        if (changePct >= this.sellThreshold && this.tokenBalance > 0n) {
            this._sellAll(curve); this.referencePrice = price;
        }
    }
    _dca(curve, idx, size) {
        if (idx >= this.entryTrade && idx < this.exitTrade) {
            const numBuys = this.exitTrade - this.entryTrade;
            const dcaSize = size / BigInt(numBuys);
            if (dcaSize > 0n && this.solBalance >= dcaSize) this._buy(curve, dcaSize);
        }
        if (idx >= this.exitTrade) this._sellAll(curve);
    }
    _quickFlip(curve, botAction, size) {
        if (botAction === 'buy' && this.tokenBalance === 0n && this.solBalance > 0n) this._buy(curve, size);
        if (botAction === 'sell' && this.tokenBalance > 0n) this._sellAll(curve);
    }
    _dipAccumulator(curve, botAction, size) {
        if (botAction === 'sell' && this.solBalance > 0n) this._buy(curve, size);
    }
    forceExit(curve) { if (!this.exited && this.tokenBalance > 0n) this._sellAll(curve); }
    getPnL() {
        return {
            pnlPct: Number(this.solBalance - this.initialSol) / Number(this.initialSol) * 100,
            finalSol: this.solBalance,
            initialSol: this.initialSol,
        };
    }
}

class NoiseActor {
    constructor(rng, tradeSize) {
        this.rng = rng;
        this.tradeSize = tradeSize;
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
// Simulation runner (single sim)
// ═══════════════════════════════════════════════════════════════════════════

function runOneSim(strategy, config, seed, noiseConfig) {
    const rng   = new SeededRandom(seed);
    const curve = new BondingCurve();
    const initialTokens = curve.executeBuy(INITIAL_BUY_SOL);
    const bot = new BotAgent(rng, noiseConfig ? noiseConfig.botBuyBias || 0.5 : 0.5);
    bot.tokenBalance = initialTokens;
    const player = new PlayerAgent(strategy, config);

    // Player's initial buy at token creation
    if (config.initialBuy > 0) {
        const initialBuyAmount = BigInt(Math.floor(config.initialBuy * 1e9));
        player._buy(curve, initialBuyAmount);
    }

    const noiseActors = [];
    if (noiseConfig && noiseConfig.noiseActors > 0) {
        const noiseRng = new SeededRandom(seed + 1_000_000);

        // Weighted random count: P(k) ∝ (maxN - k + 1) → favors fewer actors
        const maxN = noiseConfig.noiseActors;
        const totalWeight = (maxN + 1) * (maxN + 2) / 2;
        const r = noiseRng.next();
        let cumulative = 0, numActors = 0;
        for (let k = 0; k <= maxN; k++) {
            cumulative += (maxN - k + 1) / totalWeight;
            if (r < cumulative) { numActors = k; break; }
        }

        // Random trade size per actor: uniform [noiseSize, noiseSizeMax]
        const sizeMin = noiseConfig.noiseSize;
        const sizeMax = noiseConfig.noiseSizeMax;
        for (let i = 0; i < numActors; i++) {
            const size = sizeMin + noiseRng.next() * (sizeMax - sizeMin);
            noiseActors.push(new NoiseActor(noiseRng, size));
        }
    }

    let botTradeIndex = 0;
    while (!bot.shouldStop()) {
        const result = bot.executeTrade(curve);
        if (!result) { botTradeIndex++; continue; }
        for (const actor of noiseActors) {
            actor.maybeTrade(curve, noiseConfig ? noiseConfig.noiseProbability : 0);
        }
        player.react(curve, botTradeIndex, result.action);
        if (player.exited) break;
        botTradeIndex++;
    }
    player.forceExit(curve);
    return player.getPnL().pnlPct;
}

// ═══════════════════════════════════════════════════════════════════════════
// Parameter grid
// ═══════════════════════════════════════════════════════════════════════════

const PARAM_GRID = {
    tradeSize:      [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0],
    stopLoss:       [0.1, 0.5, 1, 2, 5, 10, 20, 50],
    takeProfit:     [0.1, 0.5, 1, 2, 5, 10, 50],
    entryTrade:     [0, 1, 5, 10, 20, 30, 40, 45],
    exitTrade:      [5, 10, 20, 30, 40, 49],
    buyThreshold:   [-0.02, -0.05, -0.1, -0.2, -0.5],
    sellThreshold:  [0.02, 0.05, 0.1, 0.2, 0.5],
    maxPositionPct: [10, 50, 100, 200, 500],
    initialBuy:     [0, 0.1, 0.5, 1.0, 2.0],
};

function generateCombos(strategy, initialBuyValues) {
    const combos = [];

    for (const initialBuy of initialBuyValues) {
        const base = { maxTrades: 100, initialBuy };

        switch (strategy) {
            case 'buyAndHold':
            case 'dca':
                for (const tradeSize of PARAM_GRID.tradeSize) {
                    if (initialBuy > tradeSize) continue;
                    for (const stopLoss of PARAM_GRID.stopLoss)
                    for (const takeProfit of PARAM_GRID.takeProfit)
                    for (const entryTrade of PARAM_GRID.entryTrade)
                    for (const exitTrade of PARAM_GRID.exitTrade) {
                        if (entryTrade >= exitTrade) continue;
                        combos.push({
                            ...base, strategy, tradeSize, stopLoss, takeProfit,
                            entryTrade, exitTrade,
                            buyThreshold: -0.1, sellThreshold: 0.1, maxPositionPct: 50,
                        });
                    }
                }
                break;

            case 'followMomentum':
            case 'contrarian':
            case 'quickFlip':
            case 'dipAccumulator':
                for (const tradeSize of PARAM_GRID.tradeSize) {
                    if (initialBuy > tradeSize) continue;
                    for (const stopLoss of PARAM_GRID.stopLoss)
                    for (const takeProfit of PARAM_GRID.takeProfit)
                    for (const maxPositionPct of PARAM_GRID.maxPositionPct) {
                        combos.push({
                            ...base, strategy, tradeSize, stopLoss, takeProfit, maxPositionPct,
                            entryTrade: 5, exitTrade: 40,
                            buyThreshold: -0.1, sellThreshold: 0.1,
                        });
                    }
                }
                break;

            case 'threshold':
                for (const tradeSize of PARAM_GRID.tradeSize) {
                    if (initialBuy > tradeSize) continue;
                    for (const stopLoss of PARAM_GRID.stopLoss)
                    for (const takeProfit of PARAM_GRID.takeProfit)
                    for (const buyThreshold of PARAM_GRID.buyThreshold)
                    for (const sellThreshold of PARAM_GRID.sellThreshold) {
                        combos.push({
                            ...base, strategy, tradeSize, stopLoss, takeProfit,
                            buyThreshold, sellThreshold,
                            entryTrade: 5, exitTrade: 40, maxPositionPct: 50,
                        });
                    }
                }
                break;
        }
    }
    return combos;
}

// ═══════════════════════════════════════════════════════════════════════════
// Worker thread code
// ═══════════════════════════════════════════════════════════════════════════

if (!isMainThread) {
    const { combos, numSims, baseSeed, noiseConfig } = workerData;
    const results = [];

    for (const combo of combos) {
        let wins = 0;
        let totalPnl = 0;

        for (let i = 0; i < numSims; i++) {
            const seed = baseSeed !== null ? baseSeed + i : Math.floor(Math.random() * 2 ** 32);
            const pnlPct = runOneSim(combo.strategy, combo, seed, noiseConfig);
            if (pnlPct > 0) wins++;
            totalPnl += pnlPct;
        }

        results.push({
            strategy: combo.strategy,
            winRate: (wins / numSims) * 100,
            meanPnl: totalPnl / numSims,
            params: {
                tradeSize: combo.tradeSize,
                stopLoss: combo.stopLoss,
                takeProfit: combo.takeProfit,
                entryTrade: combo.entryTrade,
                exitTrade: combo.exitTrade,
                buyThreshold: combo.buyThreshold,
                sellThreshold: combo.sellThreshold,
                maxPositionPct: combo.maxPositionPct,
                initialBuy: combo.initialBuy,
            },
        });
    }

    parentPort.postMessage(results);
    process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// Main thread — CLI & orchestration
// ═══════════════════════════════════════════════════════════════════════════

const ALL_STRATEGIES = ['buyAndHold', 'dca', 'followMomentum', 'contrarian', 'quickFlip', 'threshold', 'dipAccumulator'];

function parseArgs() {
    const args = process.argv.slice(2);
    const config = {
        numSims: 1_000,
        seed: null,
        target: 50,
        json: false,
        strategies: ALL_STRATEGIES,
        topN: 30,
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
            config.numSims = parseInt(args[++i]);
        } else if (arg.startsWith('-n=')) {
            config.numSims = parseInt(arg.slice(3));
        } else if (arg.startsWith('--seed=')) {
            config.seed = parseInt(arg.split('=')[1]);
        } else if (arg.startsWith('--target=')) {
            config.target = parseFloat(arg.split('=')[1]);
        } else if (arg === '--json') {
            config.json = true;
        } else if (arg.startsWith('--strategies=')) {
            config.strategies = arg.split('=')[1].split(',');
        } else if (arg.startsWith('--top=')) {
            config.topN = parseInt(arg.split('=')[1]);
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

function formatParamsSummary(strategy, params) {
    const parts = [];
    if (['buyAndHold', 'dca'].includes(strategy)) {
        parts.push(`entry=${params.entryTrade}`, `exit=${params.exitTrade}`);
    }
    if (['threshold'].includes(strategy)) {
        parts.push(`buyTh=${params.buyThreshold}`, `sellTh=${params.sellThreshold}`);
    }
    if (['followMomentum', 'contrarian', 'quickFlip'].includes(strategy)) {
        parts.push(`maxPos=${params.maxPositionPct}%`);
    }
    parts.push(`sl=${params.stopLoss}`, `tp=${params.takeProfit}`, `size=${params.tradeSize}`);
    if (params.initialBuy > 0) parts.push(`ib=${params.initialBuy}`);
    return parts.join(' ');
}

async function main() {
    const config = parseArgs();
    const numWorkers = os.availableParallelism ? os.availableParallelism() : os.cpus().length;

    // Generate all combos
    // CLI --initialBuy=X sweeps only that value; omitted sweeps full grid
    const initialBuyValues = config.initialBuy > 0
        ? [config.initialBuy]
        : PARAM_GRID.initialBuy;
    let allCombos = [];
    for (const strategy of config.strategies) {
        const combos = generateCombos(strategy, initialBuyValues);
        allCombos = allCombos.concat(combos);
    }

    const totalCombos = allCombos.length;

    if (!config.json) {
        console.log(`\n${'═'.repeat(55)}`);
        console.log(`PARAMETER SWEEP — Target: winRate >= ${config.target}%`);
        console.log(`${'═'.repeat(55)}`);
        console.log(`Combos: ${totalCombos.toLocaleString()} | Sims/combo: ${config.numSims.toLocaleString()} | Workers: ${numWorkers}`);
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
        console.log();
    }

    // Distribute combos across workers
    const batchSize = Math.ceil(totalCombos / numWorkers);
    const workerPromises = [];
    const t0 = Date.now();

    let completedBatches = 0;

    for (let i = 0; i < numWorkers; i++) {
        const start = i * batchSize;
        const end = Math.min(start + batchSize, totalCombos);
        if (start >= totalCombos) break;

        const batch = allCombos.slice(start, end);
        const promise = new Promise((resolve, reject) => {
            const worker = new Worker(new URL(import.meta.url), {
                workerData: {
                    combos: batch,
                    numSims: config.numSims,
                    baseSeed: config.seed,
                    noiseConfig: {
                        noiseActors: config.noiseActors,
                        noiseProbability: config.noiseProbability,
                        noiseSize: config.noiseSize,
                        noiseSizeMax: config.noiseSizeMax,
                        botBuyBias: config.botBuyBias,
                    },
                },
            });
            worker.on('message', (results) => {
                completedBatches++;
                if (!config.json) {
                    const pct = Math.round((completedBatches / Math.min(numWorkers, Math.ceil(totalCombos / batchSize))) * 100);
                    const barLen = Math.round(pct / 2.5);
                    const bar = '█'.repeat(barLen) + '░'.repeat(40 - barLen);
                    process.stdout.write(`\rProgress: [${bar}] ${pct}%`);
                }
                resolve(results);
            });
            worker.on('error', reject);
            worker.on('exit', (code) => {
                if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
            });
        });
        workerPromises.push(promise);
    }

    // Collect all results
    const batches = await Promise.all(workerPromises);
    const allResults = batches.flat();

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (!config.json) {
        process.stdout.write(`\rProgress: [${'█'.repeat(40)}] 100% (${elapsed}s)\n`);
    }

    // Sort by winRate desc, then by meanPnl desc
    allResults.sort((a, b) => b.winRate - a.winRate || b.meanPnl - a.meanPnl);

    const topResults = allResults.slice(0, config.topN);
    const bestResult = allResults[0];
    const hasTarget = bestResult && bestResult.winRate >= config.target;

    if (config.json) {
        console.log(JSON.stringify({
            totalCombos,
            simsPerCombo: config.numSims,
            elapsed: parseFloat(elapsed),
            targetWinRate: config.target,
            targetReached: hasTarget,
            bestWinRate: bestResult ? bestResult.winRate : 0,
            top: topResults,
        }, null, 2));
        return;
    }

    // Pretty output
    console.log(`\nTOP ${topResults.length} RESULTS (sorted by win rate)`);
    console.log('─'.repeat(90));
    console.log(` ${'#'.padStart(2)} | ${'Strategy'.padEnd(16)} | ${'WinRate'.padStart(7)} | ${'Mean%'.padStart(8)} | Params`);
    console.log('─'.repeat(90));

    for (let i = 0; i < topResults.length; i++) {
        const r = topResults[i];
        const marker = r.winRate >= config.target ? ' ✓' : '';
        const num = String(i + 1).padStart(2);
        const strat = r.strategy.padEnd(16);
        const wr = (r.winRate.toFixed(1) + '%').padStart(7);
        const mp = ((r.meanPnl >= 0 ? '+' : '') + r.meanPnl.toFixed(2) + '%').padStart(8);
        const params = formatParamsSummary(r.strategy, r.params);
        console.log(` ${num} | ${strat} | ${wr} | ${mp} | ${params}${marker}`);
    }

    console.log('═'.repeat(90));

    if (hasTarget) {
        console.log(`\n>>> WIN RATE >= ${config.target}% FOUND! <<<`);
        console.log(`Best: ${bestResult.strategy} at ${bestResult.winRate.toFixed(1)}%`);
        console.log(`Params: ${formatParamsSummary(bestResult.strategy, bestResult.params)}`);
    } else {
        console.log(`\nNo combination achieved >= ${config.target}% win rate.`);
        if (bestResult) {
            console.log(`Best: ${bestResult.strategy} at ${bestResult.winRate.toFixed(1)}% (${formatParamsSummary(bestResult.strategy, bestResult.params)})`);
        }
        console.log(`\nMATHEMATICAL EXPLANATION:`);
        console.log(`  Round-trip fee: ~2% (1% buy + 1% sell)`);
        console.log(`  Price move per bot trade: ~0.04% (0.012 SOL vs 30 SOL virtual reserves)`);
        console.log(`  Max cumulative move (50 trades same dir): ~2%`);
        console.log(`  → Fee ≈ max possible profit. Negative expected value.`);
    }
    console.log();
}

main().catch(err => { console.error(err); process.exit(1); });
