#!/usr/bin/env node

/**
 * testMomentumApproaches.js — Tests 3 momentum-confirmed strategy approaches
 * against all saved datasets to pick the best one for live A/B testing.
 *
 * Approach A: Pure Gate — wait for B/S >= threshold, single buy, TP/SL + kill switch
 * Approach B: Staged Confirmation — wait for N bot trades, then check B/S >= threshold
 * Approach C: Momentum Score — enter when (botBuys - botSells) * botSpeed > threshold
 */

import fs from 'fs';
import path from 'path';
import { BondingCurve } from './monteCarloSimulation.js';

// ═══════════════════════════════════════════════════════════════════════════
// Core simulation — shared by all approaches
// ═══════════════════════════════════════════════════════════════════════════

function simulate(trades, config) {
    const initialBudget = BigInt(Math.floor(config.budget * 1e9));
    const tradeSizeLamports = BigInt(Math.floor(config.tradeSize * 1e9));

    let solBalance = initialBudget;
    let tokenBalance = 0n;
    let tradeCount = 0;
    let playerSolDelta = 0n;
    let playerTokenDelta = 0n;
    let exitReason = 'END';
    let botBuys = 0;
    let botSells = 0;
    let entered = false;       // has the entry gate been passed?
    let entryTradeIdx = -1;    // which bot trade triggered entry
    let watchStartTime = null; // for timing

    for (let i = 0; i < trades.length; i++) {
        const trade = trades[i];
        if (trade.action === 'buy') botBuys++;
        else botSells++;

        const curve = new BondingCurve();
        curve.virtualSolReserves = BigInt(trade.virtualSolReserves) + playerSolDelta;
        curve.virtualTokenReserves = BigInt(trade.virtualTokenReserves) - playerTokenDelta;
        curve.realSolReserves = BigInt(trade.realSolReserves) + playerSolDelta;
        curve.realTokenReserves = BigInt(trade.realTokenReserves) - playerTokenDelta;

        if (!watchStartTime) watchStartTime = trade.blockTime || 0;
        const elapsed = (trade.blockTime || 0) - watchStartTime;

        // ─── KILL SWITCH: if entered and excess hits threshold, bail ───
        if (entered && tokenBalance > 0n && config.killSwitch > 0) {
            const excess = botSells - botBuys;
            if (excess >= config.killSwitch) {
                exitReason = 'KILL';
                solBalance += curve.executeSell(tokenBalance);
                tokenBalance = 0n;
                break;
            }
        }

        // ─── ENTRY GATE: strategy-specific ───
        if (!entered) {
            let shouldEnter = false;

            if (config.approach === 'A') {
                // Pure Gate: enter when B/S >= threshold
                if (botSells > 0) {
                    const ratio = botBuys / botSells;
                    shouldEnter = ratio >= config.entryRatio;
                } else if (botBuys > 0) {
                    // All buys, no sells yet — ratio is infinite, passes any threshold
                    shouldEnter = true;
                }
            } else if (config.approach === 'B') {
                // Staged: wait for N bot trades, then check ratio
                const totalBotTrades = botBuys + botSells;
                if (totalBotTrades >= config.minBotTrades) {
                    if (botSells > 0) {
                        const ratio = botBuys / botSells;
                        shouldEnter = ratio >= config.entryRatio;
                    } else {
                        shouldEnter = true; // all buys
                    }
                    if (!shouldEnter) {
                        // Failed the check after enough trades — skip this token
                        exitReason = 'SKIP';
                        break;
                    }
                }
            } else if (config.approach === 'C') {
                // Momentum Score: (botBuys - botSells) * botSpeed > threshold
                const totalBotTrades = botBuys + botSells;
                if (totalBotTrades >= 2 && elapsed > 0) {
                    const direction = botBuys - botSells;
                    const speed = totalBotTrades / Math.max(elapsed, 1);
                    const score = direction * speed;
                    shouldEnter = score >= config.scoreThreshold;
                }
            }

            if (shouldEnter) {
                entered = true;
                entryTradeIdx = i;

                // Make the buy
                let buyAmount = tradeSizeLamports;
                const maxSol = curve.realSolReserves * BigInt(config.maxPositionPct) / 100n;
                if (maxSol > 0n && buyAmount > maxSol) buyAmount = maxSol;
                if (buyAmount > solBalance) buyAmount = solBalance;

                if (buyAmount > 0n) {
                    const vSolBefore = curve.virtualSolReserves;
                    const vTokenBefore = curve.virtualTokenReserves;
                    const tokensReceived = curve.executeBuy(buyAmount);
                    playerSolDelta += curve.virtualSolReserves - vSolBefore;
                    playerTokenDelta += vTokenBefore - curve.virtualTokenReserves;
                    tokenBalance += tokensReceived;
                    solBalance -= buyAmount;
                    tradeCount++;
                }
            }
            continue; // don't check TP/SL until entered
        }

        // ─── POST-ENTRY: additional buys (if maxBuys > 1) ───
        if (config.maxBuys > 1 && tradeCount < config.maxBuys
            && trade.action === 'sell' && solBalance >= tradeSizeLamports) {
            let buyAmount = tradeSizeLamports;
            const maxSol = curve.realSolReserves * BigInt(config.maxPositionPct) / 100n;
            if (maxSol > 0n && buyAmount > maxSol) buyAmount = maxSol;
            if (buyAmount > solBalance) buyAmount = solBalance;

            if (buyAmount > 0n) {
                const vSolBefore = curve.virtualSolReserves;
                const vTokenBefore = curve.virtualTokenReserves;
                const tokensReceived = curve.executeBuy(buyAmount);
                playerSolDelta += curve.virtualSolReserves - vSolBefore;
                playerTokenDelta += vTokenBefore - curve.virtualTokenReserves;
                tokenBalance += tokensReceived;
                solBalance -= buyAmount;
                tradeCount++;
            }
        }

        // ─── TP / SL check ───
        if (tokenBalance > 0n) {
            const tokenValue = curve.getSolForTokens(tokenBalance);
            const portfolio = solBalance + tokenValue;
            const pnlPct = Number(portfolio - initialBudget) / Number(initialBudget) * 100;

            if (pnlPct >= config.takeProfit) {
                exitReason = 'TP';
                solBalance += curve.executeSell(tokenBalance);
                tokenBalance = 0n;
                break;
            }
            if (pnlPct <= -config.stopLoss) {
                exitReason = 'SL';
                solBalance += curve.executeSell(tokenBalance);
                tokenBalance = 0n;
                break;
            }
        }
    }

    // Force exit remaining tokens
    if (tokenBalance > 0n && trades.length > 0) {
        const last = trades[trades.length - 1];
        const curve = new BondingCurve();
        curve.virtualSolReserves = BigInt(last.virtualSolReserves) + playerSolDelta;
        curve.virtualTokenReserves = BigInt(last.virtualTokenReserves) - playerTokenDelta;
        curve.realSolReserves = BigInt(last.realSolReserves) + playerSolDelta;
        curve.realTokenReserves = BigInt(last.realTokenReserves) - playerTokenDelta;
        solBalance += curve.executeSell(tokenBalance);
        tokenBalance = 0n;
    }

    return {
        pnlPct: Number(solBalance - initialBudget) / Number(initialBudget) * 100,
        pnlSol: Number(solBalance - initialBudget) / 1e9,
        tradeCount,
        exitReason,
        entered,
        finalBalance: solBalance,
        botBuys,
        botSells,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// Parameter grids for each approach
// ═══════════════════════════════════════════════════════════════════════════

function generateConfigs() {
    const configs = [];
    const common = {
        budget: 1.0,
        stopLoss: 20,
        maxPositionPct: 100,
    };

    // ─── Approach A: Pure Gate ───
    for (const tradeSize of [0.1, 0.2, 0.3]) {
        for (const entryRatio of [0.8, 1.0, 1.2, 1.5]) {
            for (const takeProfit of [5, 10, 15]) {
                for (const maxBuys of [1, 2, 3]) {
                    for (const killSwitch of [0, 2, 3]) {
                        configs.push({
                            ...common, approach: 'A',
                            tradeSize, entryRatio, takeProfit, maxBuys, killSwitch,
                            minBotTrades: 0, scoreThreshold: 0,
                        });
                    }
                }
            }
        }
    }

    // ─── Approach B: Staged Confirmation ───
    for (const tradeSize of [0.1, 0.2, 0.3]) {
        for (const minBotTrades of [3, 5, 7, 10]) {
            for (const entryRatio of [0.8, 1.0, 1.2, 1.5]) {
                for (const takeProfit of [5, 10, 15]) {
                    for (const maxBuys of [1, 2, 3]) {
                        for (const killSwitch of [0, 2, 3]) {
                            configs.push({
                                ...common, approach: 'B',
                                tradeSize, entryRatio, takeProfit, maxBuys, killSwitch,
                                minBotTrades, scoreThreshold: 0,
                            });
                        }
                    }
                }
            }
        }
    }

    // ─── Approach C: Momentum Score ───
    for (const tradeSize of [0.1, 0.2, 0.3]) {
        for (const scoreThreshold of [0.5, 1.0, 2.0, 3.0]) {
            for (const takeProfit of [5, 10, 15]) {
                for (const maxBuys of [1, 2, 3]) {
                    for (const killSwitch of [0, 2, 3]) {
                        configs.push({
                            ...common, approach: 'C',
                            tradeSize, takeProfit, maxBuys, killSwitch,
                            scoreThreshold, entryRatio: 0, minBotTrades: 0,
                        });
                    }
                }
            }
        }
    }

    return configs;
}

// Also add baseline dipAccumulator for comparison
function generateBaseline() {
    const configs = [];
    for (const tradeSize of [0.1, 0.2, 0.3]) {
        for (const takeProfit of [5, 10]) {
            for (const maxBuys of [1, 3, 5, 10]) {
                configs.push({
                    approach: 'BASELINE',
                    strategy: 'dipAccumulator',
                    budget: 1.0, tradeSize, takeProfit, stopLoss: 20,
                    maxBuys, maxPositionPct: 100, sellStreak: 1,
                    killSwitch: 0, entryRatio: 0, minBotTrades: 0, scoreThreshold: 0,
                });
            }
        }
    }
    return configs;
}

// Baseline replay uses existing dipAccumulator logic
function replayBaseline(trades, config) {
    const initialBudget = BigInt(Math.floor(config.budget * 1e9));
    const tradeSizeLamports = BigInt(Math.floor(config.tradeSize * 1e9));
    let solBalance = initialBudget;
    let tokenBalance = 0n;
    let tradeCount = 0;
    let consecutiveSells = 0;
    let playerSolDelta = 0n;
    let playerTokenDelta = 0n;
    let exitReason = 'END';
    let botBuys = 0, botSells = 0;

    for (const trade of trades) {
        if (trade.action === 'buy') botBuys++;
        else botSells++;

        const curve = new BondingCurve();
        curve.virtualSolReserves = BigInt(trade.virtualSolReserves) + playerSolDelta;
        curve.virtualTokenReserves = BigInt(trade.virtualTokenReserves) - playerTokenDelta;
        curve.realSolReserves = BigInt(trade.realSolReserves) + playerSolDelta;
        curve.realTokenReserves = BigInt(trade.realTokenReserves) - playerTokenDelta;

        if (trade.action === 'sell') { consecutiveSells++; } else { consecutiveSells = 0; }

        // Buy on bot sell
        if (trade.action === 'sell' && consecutiveSells >= 1
            && solBalance >= tradeSizeLamports
            && (config.maxBuys === 0 || tradeCount < config.maxBuys)) {
            let buyAmount = tradeSizeLamports;
            const maxSol = curve.realSolReserves * BigInt(config.maxPositionPct) / 100n;
            if (maxSol > 0n && buyAmount > maxSol) buyAmount = maxSol;
            if (buyAmount > solBalance) buyAmount = solBalance;
            if (buyAmount > 0n) {
                const vSolBefore = curve.virtualSolReserves;
                const vTokenBefore = curve.virtualTokenReserves;
                tokenBalance += curve.executeBuy(buyAmount);
                playerSolDelta += curve.virtualSolReserves - vSolBefore;
                playerTokenDelta += vTokenBefore - curve.virtualTokenReserves;
                solBalance -= buyAmount;
                tradeCount++;
            }
        }

        // TP/SL
        if (tokenBalance > 0n) {
            const tokenValue = curve.getSolForTokens(tokenBalance);
            const portfolio = solBalance + tokenValue;
            const pnlPct = Number(portfolio - initialBudget) / Number(initialBudget) * 100;
            if (pnlPct >= config.takeProfit) {
                exitReason = 'TP';
                solBalance += curve.executeSell(tokenBalance);
                tokenBalance = 0n;
                break;
            }
            if (pnlPct <= -config.stopLoss) {
                exitReason = 'SL';
                solBalance += curve.executeSell(tokenBalance);
                tokenBalance = 0n;
                break;
            }
        }
    }

    if (tokenBalance > 0n && trades.length > 0) {
        const last = trades[trades.length - 1];
        const curve = new BondingCurve();
        curve.virtualSolReserves = BigInt(last.virtualSolReserves) + playerSolDelta;
        curve.virtualTokenReserves = BigInt(last.virtualTokenReserves) - playerTokenDelta;
        curve.realSolReserves = BigInt(last.realSolReserves) + playerSolDelta;
        curve.realTokenReserves = BigInt(last.realTokenReserves) - playerTokenDelta;
        solBalance += curve.executeSell(tokenBalance);
        tokenBalance = 0n;
    }

    return {
        pnlPct: Number(solBalance - initialBudget) / Number(initialBudget) * 100,
        pnlSol: Number(solBalance - initialBudget) / 1e9,
        tradeCount, exitReason, entered: tradeCount > 0,
        finalBalance: solBalance, botBuys, botSells,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

// Load datasets
const tokensDir = new URL('../analysis/tokens', import.meta.url).pathname;
const files = fs.readdirSync(tokensDir).filter(f => f.endsWith('.json'));
const datasets = files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(tokensDir, f), 'utf8'));
    return { mint: data.mint, trades: data.trades, file: f };
});
console.log(`Loaded ${datasets.length} datasets`);

// Generate all configs
const momentumConfigs = generateConfigs();
const baselineConfigs = generateBaseline();
console.log(`Testing ${momentumConfigs.length} momentum configs + ${baselineConfigs.length} baseline configs...`);

const t0 = Date.now();

// Run all configs
function runSweep(configs, replayFn) {
    const results = [];
    for (const config of configs) {
        let totalPnlSol = 0;
        let wins = 0, losses = 0, skips = 0;
        const exits = {};
        const walletStart = BigInt(Math.floor(config.budget * 1e9));
        let wallet = walletStart;
        const tradeSizeCheck = BigInt(Math.floor(config.tradeSize * 1e9));
        let walletDepleted = false;

        for (const ds of datasets) {
            const r = replayFn(ds.trades, config);
            totalPnlSol += r.pnlSol;
            if (r.exitReason === 'SKIP') { skips++; }
            else if (r.pnlSol > 0.001) { wins++; }
            else if (r.pnlSol < -0.001) { losses++; }
            exits[r.exitReason] = (exits[r.exitReason] || 0) + 1;

            // Wallet simulation
            if (!walletDepleted && wallet >= tradeSizeCheck) {
                const tokenBudget = wallet < walletStart ? wallet : walletStart;
                const wr = replayFn(ds.trades, { ...config, budget: Number(tokenBudget) / 1e9 });
                wallet = wallet - tokenBudget + wr.finalBalance;
                if (wallet < tradeSizeCheck) walletDepleted = true;
            }
        }

        const active = wins + losses;
        results.push({
            config,
            totalPnlSol,
            meanPnlSol: totalPnlSol / datasets.length,
            winRate: active > 0 ? wins / active * 100 : 0,
            wins, losses, skips,
            walletFinal: Number(wallet) / 1e9,
            walletReturn: (Number(wallet) - Number(walletStart)) / Number(walletStart) * 100,
            exits,
        });
    }
    return results;
}

const momentumResults = runSweep(momentumConfigs, simulate);
const baselineResults = runSweep(baselineConfigs, replayBaseline);
const allResults = [...momentumResults, ...baselineResults];

const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
console.log(`Done in ${elapsed}s\n`);

// Sort by wallet return
allResults.sort((a, b) => b.walletReturn - a.walletReturn);

// ─── Print top results per approach ───
for (const approach of ['A', 'B', 'C', 'BASELINE']) {
    const filtered = allResults.filter(r => r.config.approach === approach);
    filtered.sort((a, b) => b.walletReturn - a.walletReturn);
    const top = filtered.slice(0, 10);

    console.log(`\n${'═'.repeat(80)}`);
    console.log(`APPROACH ${approach}${approach === 'BASELINE' ? ' (dipAccumulator reference)' : approach === 'A' ? ' (Pure Gate)' : approach === 'B' ? ' (Staged Confirmation)' : ' (Momentum Score)'}`);
    console.log(`${'═'.repeat(80)}`);

    if (approach === 'A') {
        console.log(` ${'#'.padStart(2)} | ${'Size'.padStart(4)} | ${'Ratio'.padStart(5)} | ${'TP'.padStart(3)} | ${'MaxB'.padStart(4)} | ${'Kill'.padStart(4)} | ${'WR%'.padStart(5)} | ${'W'.padStart(3)} | ${'L'.padStart(3)} | ${'Wallet'.padStart(8)} | ${'WalRet'.padStart(8)} | Exits`);
    } else if (approach === 'B') {
        console.log(` ${'#'.padStart(2)} | ${'Size'.padStart(4)} | ${'MinT'.padStart(4)} | ${'Ratio'.padStart(5)} | ${'TP'.padStart(3)} | ${'MaxB'.padStart(4)} | ${'Kill'.padStart(4)} | ${'WR%'.padStart(5)} | ${'W'.padStart(3)} | ${'L'.padStart(3)} | ${'Skip'.padStart(4)} | ${'Wallet'.padStart(8)} | ${'WalRet'.padStart(8)} | Exits`);
    } else if (approach === 'C') {
        console.log(` ${'#'.padStart(2)} | ${'Size'.padStart(4)} | ${'Score'.padStart(5)} | ${'TP'.padStart(3)} | ${'MaxB'.padStart(4)} | ${'Kill'.padStart(4)} | ${'WR%'.padStart(5)} | ${'W'.padStart(3)} | ${'L'.padStart(3)} | ${'Wallet'.padStart(8)} | ${'WalRet'.padStart(8)} | Exits`);
    } else {
        console.log(` ${'#'.padStart(2)} | ${'Size'.padStart(4)} | ${'TP'.padStart(3)} | ${'MaxB'.padStart(4)} | ${'WR%'.padStart(5)} | ${'W'.padStart(3)} | ${'L'.padStart(3)} | ${'Wallet'.padStart(8)} | ${'WalRet'.padStart(8)} | Exits`);
    }
    console.log('─'.repeat(80));

    for (let i = 0; i < top.length; i++) {
        const r = top[i];
        const c = r.config;
        const exitStr = Object.entries(r.exits).map(([k,v]) => `${k}:${v}`).join(' ');
        const walRet = (r.walletReturn >= 0 ? '+' : '') + r.walletReturn.toFixed(1) + '%';

        if (approach === 'A') {
            console.log(` ${String(i+1).padStart(2)} | ${c.tradeSize.toFixed(1).padStart(4)} | ${c.entryRatio.toFixed(1).padStart(5)} | ${c.takeProfit.toString().padStart(3)} | ${c.maxBuys.toString().padStart(4)} | ${c.killSwitch.toString().padStart(4)} | ${r.winRate.toFixed(0).padStart(4)}% | ${r.wins.toString().padStart(3)} | ${r.losses.toString().padStart(3)} | ${r.walletFinal.toFixed(3).padStart(8)} | ${walRet.padStart(8)} | ${exitStr}`);
        } else if (approach === 'B') {
            console.log(` ${String(i+1).padStart(2)} | ${c.tradeSize.toFixed(1).padStart(4)} | ${c.minBotTrades.toString().padStart(4)} | ${c.entryRatio.toFixed(1).padStart(5)} | ${c.takeProfit.toString().padStart(3)} | ${c.maxBuys.toString().padStart(4)} | ${c.killSwitch.toString().padStart(4)} | ${r.winRate.toFixed(0).padStart(4)}% | ${r.wins.toString().padStart(3)} | ${r.losses.toString().padStart(3)} | ${r.skips.toString().padStart(4)} | ${r.walletFinal.toFixed(3).padStart(8)} | ${walRet.padStart(8)} | ${exitStr}`);
        } else if (approach === 'C') {
            console.log(` ${String(i+1).padStart(2)} | ${c.tradeSize.toFixed(1).padStart(4)} | ${c.scoreThreshold.toFixed(1).padStart(5)} | ${c.takeProfit.toString().padStart(3)} | ${c.maxBuys.toString().padStart(4)} | ${c.killSwitch.toString().padStart(4)} | ${r.winRate.toFixed(0).padStart(4)}% | ${r.wins.toString().padStart(3)} | ${r.losses.toString().padStart(3)} | ${r.walletFinal.toFixed(3).padStart(8)} | ${walRet.padStart(8)} | ${exitStr}`);
        } else {
            console.log(` ${String(i+1).padStart(2)} | ${c.tradeSize.toFixed(1).padStart(4)} | ${c.takeProfit.toString().padStart(3)} | ${c.maxBuys.toString().padStart(4)} | ${r.winRate.toFixed(0).padStart(4)}% | ${r.wins.toString().padStart(3)} | ${r.losses.toString().padStart(3)} | ${r.walletFinal.toFixed(3).padStart(8)} | ${walRet.padStart(8)} | ${exitStr}`);
        }
    }
}

// ─── Overall comparison ───
console.log(`\n${'═'.repeat(80)}`);
console.log('OVERALL: BEST CONFIG PER APPROACH');
console.log(`${'═'.repeat(80)}`);

for (const approach of ['BASELINE', 'A', 'B', 'C']) {
    const filtered = allResults.filter(r => r.config.approach === approach);
    filtered.sort((a, b) => b.walletReturn - a.walletReturn);
    const best = filtered[0];
    if (!best) continue;
    const c = best.config;
    const label = approach === 'BASELINE' ? 'BASELINE (dipAccumulator)' :
                  approach === 'A' ? 'A (Pure Gate)' :
                  approach === 'B' ? 'B (Staged Confirmation)' :
                  'C (Momentum Score)';
    const exitStr = Object.entries(best.exits).map(([k,v]) => `${k}:${v}`).join(' ');
    console.log(`\n  ${label}:`);
    console.log(`    Wallet: ${best.walletFinal.toFixed(4)} SOL (${best.walletReturn >= 0 ? '+' : ''}${best.walletReturn.toFixed(1)}%)`);
    console.log(`    WR: ${best.winRate.toFixed(0)}% (${best.wins}W/${best.losses}L${best.skips ? `/${best.skips}Skip` : ''})`);
    console.log(`    Exits: ${exitStr}`);
    console.log(`    Config: size=${c.tradeSize} TP=${c.takeProfit} maxBuys=${c.maxBuys} kill=${c.killSwitch}` +
        (c.entryRatio ? ` ratio=${c.entryRatio}` : '') +
        (c.minBotTrades ? ` minTrades=${c.minBotTrades}` : '') +
        (c.scoreThreshold ? ` score=${c.scoreThreshold}` : ''));
}

console.log(`\n${'═'.repeat(80)}`);
console.log('NOTE: Offline datasets are biased. Use these results to pick the best');
console.log('approach for live A/B testing, NOT to predict absolute live performance.');
console.log(`${'═'.repeat(80)}`);
