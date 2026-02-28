#!/usr/bin/env node

/**
 * generateReportData.js — Extract and aggregate live run data for the PDF report.
 *
 * Reads all JSONL files from analysis/live_runs/, computes per-strategy stats,
 * simulates bonding curve price scenarios, and outputs docs/rapport/report_data.json.
 *
 * Usage: node tools/generateReportData.js
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const LIVE_RUNS_DIR = join(ROOT, 'analysis', 'live_runs');
const OUTPUT_PATH = join(ROOT, 'docs', 'rapport', 'report_data.json');

// ── Constants (mirroring monteCarloSimulation.js) ──────────────────────────

const LAMPORTS_PER_SOL = 1_000_000_000n;
const INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000_000_000n;
const INITIAL_VIRTUAL_SOL_RESERVES   = 30_000_000_000n;
const INITIAL_REAL_TOKEN_RESERVES    = 793_100_000_000_000n;
const INITIAL_REAL_SOL_RESERVES      = 0n;
const FEE_BASIS_POINTS = 100n;
const BASIS_POINTS     = 10_000n;
const INITIAL_BUY_SOL  = 60_000_000n;
const BOT_TRADE_NUM    = 20n;
const BOT_TRADE_DEN    = 100n;
const BOT_MAX_BUY_SOL  = 20_000_000_000n;

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

    getTokensForSol(solAmount) {
        const fee = solAmount * FEE_BASIS_POINTS / BASIS_POINTS;
        const solAfterFee = solAmount - fee;
        return solAfterFee * this.virtualTokenReserves / (this.virtualSolReserves + solAfterFee);
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

    calculateBotBuyAmount() {
        const amount = this.realSolReserves * BOT_TRADE_NUM / BOT_TRADE_DEN;
        return amount > BOT_MAX_BUY_SOL ? BOT_MAX_BUY_SOL : amount;
    }

    calculateBotSellTargetSol() {
        const base = this.realSolReserves * BOT_TRADE_NUM / BOT_TRADE_DEN;
        return base > 0n ? base - 1n : 0n;
    }

    getTokensToSellForSol(targetSolOut) {
        if (targetSolOut <= 0n) return -1n;
        const solBeforeFee = targetSolOut * BASIS_POINTS / (BASIS_POINTS - FEE_BASIS_POINTS);
        if (solBeforeFee >= this.virtualSolReserves) return -1n;
        if (solBeforeFee > this.realSolReserves) return -1n;
        return solBeforeFee * this.virtualTokenReserves / (this.virtualSolReserves - solBeforeFee);
    }
}

// ── Load all JSONL data ────────────────────────────────────────────────────

function loadAllRuns() {
    const files = readdirSync(LIVE_RUNS_DIR).filter(f => f.endsWith('.jsonl'));
    const allRecords = [];
    const runsByFile = {};

    for (const file of files) {
        const content = readFileSync(join(LIVE_RUNS_DIR, file), 'utf-8');
        const records = content.trim().split('\n').filter(Boolean).map(line => {
            const r = JSON.parse(line);
            r._file = file;
            return r;
        });
        allRecords.push(...records);
        runsByFile[file] = records;
    }

    return { allRecords, runsByFile };
}

// ── Aggregate stats per strategy ───────────────────────────────────────────

function aggregateByStrategy(records) {
    const grouped = {};
    for (const r of records) {
        const strat = r.config?.strategy || 'unknown';
        if (!grouped[strat]) grouped[strat] = [];
        grouped[strat].push(r);
    }

    const stats = {};
    for (const [strat, recs] of Object.entries(grouped)) {
        const wins = recs.filter(r => r.pnlPct > 0);
        const losses = recs.filter(r => r.pnlPct <= 0);
        const pnls = recs.map(r => r.pnlPct).sort((a, b) => a - b);
        const solPnls = recs.map(r => r.pnlSol);
        const totalSol = solPnls.reduce((s, v) => s + v, 0);

        // Exit reason breakdown
        const exitCounts = {};
        for (const r of recs) {
            exitCounts[r.exitReason] = (exitCounts[r.exitReason] || 0) + 1;
        }

        stats[strat] = {
            count: recs.length,
            winRate: recs.length > 0 ? (wins.length / recs.length * 100) : 0,
            wins: wins.length,
            losses: losses.length,
            meanPnlPct: recs.length > 0 ? pnls.reduce((s, v) => s + v, 0) / recs.length : 0,
            medianPnlPct: pnls.length > 0 ? pnls[Math.floor(pnls.length / 2)] : 0,
            totalPnlSol: totalSol,
            avgWinPct: wins.length > 0 ? wins.reduce((s, r) => s + r.pnlPct, 0) / wins.length : 0,
            avgLossPct: losses.length > 0 ? losses.reduce((s, r) => s + r.pnlPct, 0) / losses.length : 0,
            maxWinPct: pnls.length > 0 ? pnls[pnls.length - 1] : 0,
            maxLossPct: pnls.length > 0 ? pnls[0] : 0,
            avgDurationSec: recs.reduce((s, r) => s + (r.durationSec || 0), 0) / recs.length,
            exitReasons: exitCounts,
            pnlDistribution: pnls,
        };
    }
    return stats;
}

// ── Wallet curves per run file ─────────────────────────────────────────────

function computeWalletCurves(runsByFile) {
    const curves = {};
    for (const [file, records] of Object.entries(runsByFile)) {
        let balance = 1.0; // Start at 1 SOL
        const points = [{ idx: 0, balance: 1.0 }];
        for (let i = 0; i < records.length; i++) {
            balance += records[i].pnlSol;
            points.push({ idx: i + 1, balance, pnlPct: records[i].pnlPct, exit: records[i].exitReason });
        }
        curves[file] = points;
    }
    return curves;
}

// ── Bonding curve simulation: 3 scenarios ──────────────────────────────────

function simulateBondingCurveScenarios() {
    const NUM_TRADES = 50;
    const scenarios = {};

    // Scenario 1: All buys
    {
        const curve = new BondingCurve();
        curve.executeBuy(INITIAL_BUY_SOL); // creator buy
        const points = [{ trade: 0, price: curve.getPriceFloat() * 1e9, realSol: Number(curve.realSolReserves) / 1e9 }];
        let botTokens = 0n;
        for (let i = 1; i <= NUM_TRADES; i++) {
            const buyAmt = curve.calculateBotBuyAmount();
            botTokens += curve.executeBuy(buyAmt);
            points.push({
                trade: i,
                price: curve.getPriceFloat() * 1e9,
                realSol: Number(curve.realSolReserves) / 1e9,
                buyAmtSol: Number(buyAmt) / 1e9,
            });
        }
        scenarios.allBuy = points;
    }

    // Scenario 2: All sells (after initial buys to build reserves)
    {
        const curve = new BondingCurve();
        curve.executeBuy(INITIAL_BUY_SOL);
        let botTokens = 0n;
        // First 10 buys to accumulate
        for (let i = 0; i < 10; i++) {
            botTokens += curve.executeBuy(curve.calculateBotBuyAmount());
        }
        const points = [{ trade: 0, price: curve.getPriceFloat() * 1e9, realSol: Number(curve.realSolReserves) / 1e9 }];
        for (let i = 1; i <= 40; i++) {
            const targetSol = curve.calculateBotSellTargetSol();
            const tokensToSell = curve.getTokensToSellForSol(targetSol);
            if (tokensToSell <= 0n || tokensToSell > botTokens) break;
            curve.executeSell(tokensToSell);
            botTokens -= tokensToSell;
            points.push({
                trade: i,
                price: curve.getPriceFloat() * 1e9,
                realSol: Number(curve.realSolReserves) / 1e9,
            });
        }
        scenarios.allSell = points;
    }

    // Scenario 3: Random 50/50 (seeded)
    {
        const curve = new BondingCurve();
        curve.executeBuy(INITIAL_BUY_SOL);
        let botTokens = 0n;
        const points = [{ trade: 0, price: curve.getPriceFloat() * 1e9, realSol: Number(curve.realSolReserves) / 1e9 }];
        // Simple LCG for deterministic results
        let seed = 42;
        for (let i = 1; i <= NUM_TRADES; i++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            const isBuy = seed % 2 === 0;
            if (isBuy) {
                const buyAmt = curve.calculateBotBuyAmount();
                botTokens += curve.executeBuy(buyAmt);
            } else {
                const targetSol = curve.calculateBotSellTargetSol();
                const tokensToSell = curve.getTokensToSellForSol(targetSol);
                if (tokensToSell > 0n && tokensToSell <= botTokens) {
                    curve.executeSell(tokensToSell);
                    botTokens -= tokensToSell;
                }
            }
            points.push({
                trade: i,
                price: curve.getPriceFloat() * 1e9,
                realSol: Number(curve.realSolReserves) / 1e9,
            });
        }
        scenarios.random5050 = points;
    }

    return scenarios;
}

// ── Bot trade amount data (buy/sell amounts per trade in all-buy scenario) ─

function simulateBotAmounts() {
    const curve = new BondingCurve();
    curve.executeBuy(INITIAL_BUY_SOL);
    const points = [];
    for (let i = 1; i <= 50; i++) {
        const buyAmt = curve.calculateBotBuyAmount();
        curve.executeBuy(buyAmt);
        points.push({
            trade: i,
            buyAmtSol: Number(buyAmt) / 1e9,
            realSolReserves: Number(curve.realSolReserves) / 1e9,
        });
    }
    return points;
}

// ── Per-run summaries for tables ───────────────────────────────────────────

function computeRunSummaries(runsByFile) {
    const summaries = {};
    for (const [file, records] of Object.entries(runsByFile)) {
        const strat = records[0]?.config?.strategy || 'unknown';
        const wins = records.filter(r => r.pnlPct > 0).length;
        const totalSol = records.reduce((s, r) => s + r.pnlSol, 0);
        const wr = records.length > 0 ? (wins / records.length * 100) : 0;

        // Exit reason counts
        const exits = {};
        for (const r of records) {
            exits[r.exitReason] = (exits[r.exitReason] || 0) + 1;
        }

        summaries[file] = {
            strategy: strat,
            tokens: records.length,
            wins,
            losses: records.length - wins,
            winRate: wr,
            totalPnlSol: totalSol,
            finalWallet: 1.0 + totalSol,
            exitReasons: exits,
            config: records[0]?.config || {},
        };
    }
    return summaries;
}

// ── Offline vs Live WR comparison data ─────────────────────────────────────

function offlineVsLiveData() {
    // Hardcoded from MEMORY.md and documented results
    return [
        { strategy: 'dipAccumulator', offlineWR: 46, liveWR: 75, label: 'dipAccum TP=5' },
        { strategy: 'smartDipAccumulator', offlineWR: 85, liveWR: 45, label: 'smartDipAccum' },
        { strategy: 'flipScalper', offlineWR: null, liveWR: 36, label: 'flipScalper v2' },
        { strategy: 'proportionalDip', offlineWR: null, liveWR: 36, label: 'proportionalDip' },
    ];
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
    console.log('Loading live run data...');
    const { allRecords, runsByFile } = loadAllRuns();
    console.log(`  ${allRecords.length} total records from ${Object.keys(runsByFile).length} files`);

    console.log('Aggregating stats per strategy...');
    const strategyStats = aggregateByStrategy(allRecords);

    console.log('Computing wallet curves...');
    const walletCurves = computeWalletCurves(runsByFile);

    console.log('Simulating bonding curve scenarios...');
    const bondingCurveScenarios = simulateBondingCurveScenarios();

    console.log('Simulating bot trade amounts...');
    const botAmounts = simulateBotAmounts();

    console.log('Computing run summaries...');
    const runSummaries = computeRunSummaries(runsByFile);

    const reportData = {
        generated: new Date().toISOString(),
        totalRecords: allRecords.length,
        totalFiles: Object.keys(runsByFile).length,
        strategyStats,
        walletCurves,
        bondingCurveScenarios,
        botAmounts,
        runSummaries,
        offlineVsLive: offlineVsLiveData(),
        constants: {
            initialVirtualSol: 30,
            initialVirtualTokens: 1073000000000,
            initialRealTokens: 793100000000,
            feePercent: 1,
            botMaxTrades: 50,
            botTradePercent: 20,
            botMaxBuySol: 20,
            creatorBuySol: 0.06,
        },
    };

    writeFileSync(OUTPUT_PATH, JSON.stringify(reportData, null, 2));
    console.log(`\nReport data written to ${OUTPUT_PATH}`);
    console.log(`  Strategies: ${Object.keys(strategyStats).join(', ')}`);
    for (const [s, st] of Object.entries(strategyStats)) {
        console.log(`    ${s}: ${st.count} tokens, WR=${st.winRate.toFixed(1)}%, total=${st.totalPnlSol.toFixed(3)} SOL`);
    }
}

main();
