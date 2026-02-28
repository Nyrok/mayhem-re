#!/usr/bin/env node

/**
 * offlineSweep.js — Fast offline parameter sweep using saved trade datasets.
 * No RPC calls. Replays on-chain bot trades from JSON files and tests
 * hundreds of strategy configs in milliseconds.
 *
 * Usage:
 *   node tools/offlineSweep.js                          # sweep all datasets in analysis/
 *   node tools/offlineSweep.js --file=analysis/tradeDataset.json
 *   node tools/offlineSweep.js --top=20                 # show top 20 results
 */

import fs from 'fs';
import path from 'path';
import { BondingCurve } from './monteCarloSimulation.js';

// ═══════════════════════════════════════════════════════════════════════════
// Replay engine — replays bot trades from dataset, simulates player
// ═══════════════════════════════════════════════════════════════════════════

function replayDataset(trades, config) {
    const initialBudget = BigInt(Math.floor(config.budget * 1e9));
    const tradeSizeLamports = BigInt(Math.floor(config.tradeSize * 1e9));

    let solBalance = initialBudget;
    let tokenBalance = 0n;
    let tradeCount = 0;
    let consecutiveSells = 0;
    let consecutiveBuys = 0;
    let playerSolDelta = 0n;
    let playerTokenDelta = 0n;
    let exitReason = 'END';
    let sellCount = 0;
    let botBuys = 0;
    let botSells = 0;
    let mcEntered = false;
    let mcWatchStart = null;
    let flipBuyNext = true;
    let roundTripEntrySOL = 0n;
    let initialBuyDone = false;
    let initialTokens = 0n;
    let flipSkipBuy = false;
    let mcapPeaked = false;
    let holdEntryDone = false;
    let lastBotBuyMcap = null;

    // SmartDipAccumulator state
    let priceHistory = [];
    let peakPnlPct = 0;
    let trailingActive = false;
    let smartExit = false;

    // flipScalper: no initial buy — wait for mcap >= 30 then FLIP BUY on first bot sell
    if (config.strategy === 'flipScalper') {
        flipBuyNext = true;
    }

    for (let i = 0; i < trades.length; i++) {
        const trade = trades[i];
        flipSkipBuy = false; // reset per-trade flag
        if (trade.action === 'buy') botBuys++;
        else botSells++;
        const curve = new BondingCurve();
        curve.virtualSolReserves = BigInt(trade.virtualSolReserves) + playerSolDelta;
        curve.virtualTokenReserves = BigInt(trade.virtualTokenReserves) - playerTokenDelta;
        curve.realSolReserves = BigInt(trade.realSolReserves) + playerSolDelta;
        curve.realTokenReserves = BigInt(trade.realTokenReserves) - playerTokenDelta;

        // flipScalper/holdReversal: mcap tracking + exit (only after peaked above entry mcap)
        if (config.strategy === 'flipScalper' || config.strategy === 'holdReversal') {
            const mcap = Number(1_000_000_000_000_000n * curve.virtualSolReserves / curve.virtualTokenReserves) / 1e9;
            const entryMcap = config.flipEntryMcap || 30;
            if (mcap >= entryMcap) mcapPeaked = true;
            if (mcapPeaked && mcap < entryMcap) {
                exitReason = 'MCAP30';
                if (tokenBalance > 0n) { solBalance += curve.executeSell(tokenBalance); tokenBalance = 0n; }
                break;
            }
        }

        // Market cap floor: sell & exit if mcap drops below threshold
        if (config.mcapFloor > 0) {
            const mcapSol = Number(1_000_000_000_000_000n * curve.virtualSolReserves / curve.virtualTokenReserves) / 1e9;
            if (mcapSol < config.mcapFloor) {
                exitReason = 'MCAP';
                if (tokenBalance > 0n) {
                    solBalance += curve.executeSell(tokenBalance);
                    tokenBalance = 0n;
                }
                break;
            }
        }

        // holdReversal: track lastBotBuyMcap + reversal exit
        if (config.strategy === 'holdReversal') {
            const mcap = Number(1_000_000_000_000_000n * curve.virtualSolReserves / curve.virtualTokenReserves) / 1e9;
            if (trade.action === 'buy') lastBotBuyMcap = mcap;
            if (holdEntryDone && lastBotBuyMcap !== null && mcap < lastBotBuyMcap) {
                exitReason = 'REVERSAL';
                if (tokenBalance > 0n) {
                    const vSolBefore = curve.virtualSolReserves;
                    const vTokenBefore = curve.virtualTokenReserves;
                    solBalance += curve.executeSell(tokenBalance);
                    playerSolDelta += curve.virtualSolReserves - vSolBefore;
                    playerTokenDelta += vTokenBefore - curve.virtualTokenReserves;
                    tokenBalance = 0n;
                    sellCount++; tradeCount++;
                }
                break;
            }
        }

        // momentumConfirmed: kill switch
        if (config.strategy === 'momentumConfirmed' && mcEntered && tokenBalance > 0n && config.killSwitch > 0) {
            const excess = botSells - botBuys;
            if (excess >= config.killSwitch) {
                exitReason = 'KILL';
                solBalance += curve.executeSell(tokenBalance);
                tokenBalance = 0n;
                break;
            }
        }

        // flipScalper: stop if flip P&L < 0 — sell ALL tokens
        if (config.strategy === 'flipScalper' && tokenBalance > 0n && roundTripEntrySOL > 0n) {
            const flipValue = curve.getSolForTokens(tokenBalance);
            if (flipValue < roundTripEntrySOL) {
                const vSolBefore = curve.virtualSolReserves;
                const vTokenBefore = curve.virtualTokenReserves;
                solBalance += curve.executeSell(tokenBalance);
                playerSolDelta += curve.virtualSolReserves - vSolBefore;
                playerTokenDelta += vTokenBefore - curve.virtualTokenReserves;
                tokenBalance = 0n;
                sellCount++; tradeCount++;
                flipBuyNext = true;
                roundTripEntrySOL = 0n;
                flipSkipBuy = true;
            }
        }

        // Price tracking for smartDipAccumulator
        if (config.strategy === 'smartDipAccumulator') {
            const currentPrice = Number(curve.virtualSolReserves) / Number(curve.virtualTokenReserves);
            priceHistory.push(currentPrice);
            if (priceHistory.length > config.momentumWindow) priceHistory.shift();
        }

        if (trade.action === 'sell') { consecutiveSells++; consecutiveBuys = 0; }
        else { consecutiveBuys++; consecutiveSells = 0; }

        // Sell dominance early exit
        if (config.sellDomThreshold > 0 && config.sellDomMinTrades > 0
            && tokenBalance > 0n) {
            const totalBotTrades = botBuys + botSells;
            if (totalBotTrades >= config.sellDomMinTrades) {
                const sellPct = botSells / totalBotTrades * 100;
                if (sellPct >= config.sellDomThreshold) {
                    exitReason = 'SDOM';
                    const vSolBefore = curve.virtualSolReserves;
                    const vTokenBefore = curve.virtualTokenReserves;
                    solBalance += curve.executeSell(tokenBalance);
                    playerSolDelta += curve.virtualSolReserves - vSolBefore;
                    playerTokenDelta += vTokenBefore - curve.virtualTokenReserves;
                    tokenBalance = 0n;
                    sellCount++; tradeCount++;
                    break;
                }
            }
        }

        // === Strategy dispatch ===
        if (config.strategy === 'streakReversal') {
            // Sell on first bot buy after holding
            if (trade.action === 'buy' && tokenBalance > 0n) {
                const vSolBefore = curve.virtualSolReserves;
                const vTokenBefore = curve.virtualTokenReserves;
                solBalance += curve.executeSell(tokenBalance);
                playerSolDelta += curve.virtualSolReserves - vSolBefore;
                playerTokenDelta += vTokenBefore - curve.virtualTokenReserves;
                tokenBalance = 0n;
                sellCount++;
                tradeCount++;
            }
        } else if (config.strategy === 'momentumRider') {
            // Sell after N consecutive buys (momentum fading)
            if (trade.action === 'sell' && tokenBalance > 0n) {
                const vSolBefore = curve.virtualSolReserves;
                const vTokenBefore = curve.virtualTokenReserves;
                solBalance += curve.executeSell(tokenBalance);
                playerSolDelta += curve.virtualSolReserves - vSolBefore;
                playerTokenDelta += vTokenBefore - curve.virtualTokenReserves;
                tokenBalance = 0n;
                sellCount++;
                tradeCount++;
            }
        } else if (config.strategy === 'buyStreak') {
            // Buy after N consecutive BUYS (momentum), sell on first sell
            if (trade.action === 'sell' && tokenBalance > 0n) {
                const vSolBefore = curve.virtualSolReserves;
                const vTokenBefore = curve.virtualTokenReserves;
                solBalance += curve.executeSell(tokenBalance);
                playerSolDelta += curve.virtualSolReserves - vSolBefore;
                playerTokenDelta += vTokenBefore - curve.virtualTokenReserves;
                tokenBalance = 0n;
                sellCount++;
                tradeCount++;
            }
        } else if (config.strategy === 'scalper') {
            // Sell after ANY bot buy if holding (same as streakReversal but buy on every sell)
            if (trade.action === 'buy' && tokenBalance > 0n) {
                const vSolBefore = curve.virtualSolReserves;
                const vTokenBefore = curve.virtualTokenReserves;
                solBalance += curve.executeSell(tokenBalance);
                playerSolDelta += curve.virtualSolReserves - vSolBefore;
                playerTokenDelta += vTokenBefore - curve.virtualTokenReserves;
                tokenBalance = 0n;
                sellCount++;
                tradeCount++;
            }
        } else if (config.strategy === 'flipScalper') {
            if (trade.action === 'sell' && !flipBuyNext && tokenBalance > 0n) {
                // FLIP SELL — sell ALL tokens
                const vSolBefore = curve.virtualSolReserves;
                const vTokenBefore = curve.virtualTokenReserves;
                solBalance += curve.executeSell(tokenBalance);
                playerSolDelta += curve.virtualSolReserves - vSolBefore;
                playerTokenDelta += vTokenBefore - curve.virtualTokenReserves;
                tokenBalance = 0n;
                sellCount++; tradeCount++;
                flipBuyNext = true;
                roundTripEntrySOL = 0n;
            }
        } else if (config.strategy === 'smartDipAccumulator' && tokenBalance > 0n) {
            const tokenValue = curve.getSolForTokens(tokenBalance);
            const portfolio = solBalance + tokenValue;
            const pnlPct = Number(portfolio - initialBudget) / Number(initialBudget) * 100;
            if (pnlPct > peakPnlPct) peakPnlPct = pnlPct;

            // Reversal exit (in profit + sell streak)
            if (config.reversalExitStreak > 0 && pnlPct > 0
                && consecutiveSells >= config.reversalExitStreak) {
                exitReason = 'REV';
                const vSolBefore = curve.virtualSolReserves;
                const vTokenBefore = curve.virtualTokenReserves;
                solBalance += curve.executeSell(tokenBalance);
                playerSolDelta += curve.virtualSolReserves - vSolBefore;
                playerTokenDelta += vTokenBefore - curve.virtualTokenReserves;
                tokenBalance = 0n;
                sellCount++; tradeCount++;
                smartExit = true;
            }
            // Trailing stop
            if (!smartExit) {
                if (peakPnlPct >= config.trailActivation) trailingActive = true;
                if (trailingActive) {
                    const dynamicSL = peakPnlPct - config.trailDistance;
                    if (pnlPct <= dynamicSL) {
                        exitReason = 'TRAIL';
                        const vSolBefore = curve.virtualSolReserves;
                        const vTokenBefore = curve.virtualTokenReserves;
                        solBalance += curve.executeSell(tokenBalance);
                        playerSolDelta += curve.virtualSolReserves - vSolBefore;
                        playerTokenDelta += vTokenBefore - curve.virtualTokenReserves;
                        tokenBalance = 0n;
                        sellCount++; tradeCount++;
                        smartExit = true;
                    }
                }
            }
        }

        if (smartExit) break;

        // momentumConfirmed: watch phase + gated entry
        if (config.strategy === 'momentumConfirmed') {
            if (mcWatchStart === null) mcWatchStart = i;

            if (!mcEntered) {
                let shouldEnter = false;

                if (config.approach === 'A') {
                    if (botSells > 0) {
                        shouldEnter = (botBuys / botSells) >= config.entryRatio;
                    } else if (botBuys > 0) {
                        shouldEnter = true;
                    }
                } else if (config.approach === 'C') {
                    const totalBotTrades = botBuys + botSells;
                    const elapsed = (i - mcWatchStart) * 0.4;
                    if (totalBotTrades >= 2 && elapsed > 0) {
                        const direction = botBuys - botSells;
                        const speed = totalBotTrades / elapsed;
                        const score = direction * speed;
                        shouldEnter = score >= config.scoreThreshold;
                    }
                }

                if (shouldEnter && solBalance >= tradeSizeLamports) {
                    mcEntered = true;
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
            } else if (config.maxBuys > 1 && tradeCount < config.maxBuys
                && trade.action === 'sell' && solBalance >= tradeSizeLamports) {
                // Post-entry: additional buys on bot sells (like dipAccumulator)
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
        }

        // === Buy logic ===
        const shouldBuy = (() => {
            if (solBalance < tradeSizeLamports) return false;
            if (config.maxBuys > 0 && tradeCount >= config.maxBuys) return false;

            switch (config.strategy) {
                case 'proportionalDip':
                case 'dipAccumulator':
                case 'streakReversal':
                case 'scalper':
                    return trade.action === 'sell' && consecutiveSells >= config.sellStreak;
                case 'momentumRider':
                    return trade.action === 'buy' && consecutiveBuys >= config.buyStreak;
                case 'buyStreak':
                    return trade.action === 'buy' && consecutiveBuys >= config.buyStreak;
                case 'flipScalper': {
                    if (trade.action !== 'sell') return false;
                    if (flipSkipBuy) return false;
                    if (!flipBuyNext) return false;
                    const flipMcap = Number(1_000_000_000_000_000n * curve.virtualSolReserves / curve.virtualTokenReserves) / 1e9;
                    return flipMcap >= (config.flipEntryMcap || 30);
                }
                case 'holdReversal': {
                    if (holdEntryDone) return false;
                    const hrMcap = Number(1_000_000_000_000_000n * curve.virtualSolReserves / curve.virtualTokenReserves) / 1e9;
                    return hrMcap >= (config.flipEntryMcap || 60);
                }
                case 'momentumConfirmed':
                    return false;
                case 'smartDipAccumulator': {
                    if (trade.action !== 'sell') return false;
                    if (consecutiveSells < config.sellStreak) return false;

                    // Momentum filter
                    if (priceHistory.length >= config.momentumWindow) {
                        const oldPrice = priceHistory[0];
                        const currentPrice = priceHistory[priceHistory.length - 1];
                        const roc = (currentPrice - oldPrice) / oldPrice;
                        if (roc < -config.momentumThreshold) return false;
                    }

                    // Impact check
                    if (tokenBalance > 0n && curve.realTokenReserves > 0n) {
                        const share = Number(tokenBalance) / Number(curve.realTokenReserves) * 100;
                        if (share > config.maxImpactPct) return false;
                    }

                    return true;
                }
                default:
                    return false;
            }
        })();

        if (shouldBuy) {
            let buyAmount = tradeSizeLamports;
            // Adaptive sizing for smartDipAccumulator
            if (config.strategy === 'smartDipAccumulator') {
                const realSolFloat = Number(curve.realSolReserves) / 1e9;
                const scaleFactor = Math.min(1.0,
                    Math.max(config.minScaleFactor, realSolFloat / config.curveScaleThreshold));
                buyAmount = BigInt(Math.floor(Number(tradeSizeLamports) * scaleFactor));
            }
            // Proportional sizing for proportionalDip
            if (config.strategy === 'proportionalDip') {
                const realSolFloat = Number(curve.realSolReserves) / 1e9;
                const scale = Math.min(config.maxScale, Math.max(config.minScale, realSolFloat / config.scaleThreshold));
                buyAmount = BigInt(Math.floor(Number(tradeSizeLamports) * scale));
            }
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

                if (config.strategy === 'flipScalper') {
                    roundTripEntrySOL = buyAmount;
                    flipBuyNext = false;
                }
                if (config.strategy === 'holdReversal') {
                    holdEntryDone = true;
                }
            }
        }

        // Check TP/SL
        const tokenValue = tokenBalance > 0n ? curve.getSolForTokens(tokenBalance) : 0n;
        const portfolio = solBalance + tokenValue;
        const pnlPct = Number(portfolio - initialBudget) / Number(initialBudget) * 100;

        if (config.strategy !== 'flipScalper' && config.strategy !== 'holdReversal' && pnlPct >= config.takeProfit) {
            exitReason = 'TP';
            if (tokenBalance > 0n) {
                solBalance += curve.executeSell(tokenBalance);
                tokenBalance = 0n;
            }
            break;
        }
        if (config.strategy !== 'flipScalper' && config.strategy !== 'holdReversal' && pnlPct <= -config.stopLoss) {
            exitReason = 'SL';
            if (tokenBalance > 0n) {
                solBalance += curve.executeSell(tokenBalance);
                tokenBalance = 0n;
            }
            break;
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
        sellCount,
        exitReason,
        finalBalance: solBalance,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// Parameter grid
// ═══════════════════════════════════════════════════════════════════════════

function generateConfigs(strategyFilter) {
    const configs = [];

    if (!strategyFilter || (strategyFilter !== 'smartDipAccumulator' && strategyFilter !== 'proportionalDip' && strategyFilter !== 'momentumConfirmed' && strategyFilter !== 'flipScalper' && strategyFilter !== 'holdReversal')) {
        const strategies = ['dipAccumulator', 'streakReversal', 'scalper', 'momentumRider', 'buyStreak'];
        const filteredStrategies = strategyFilter ? strategies.filter(s => s === strategyFilter) : strategies;
        const tradeSizes = [0.001, 0.005, 0.01, 0.02, 0.05, 0.1];
        const budgets = [0.5, 1.0, 2.0];
        const sellStreaks = [1, 2, 3, 4, 5];
        const buyStreaks = [1, 2, 3, 4, 5];
        const takeProfits = [0.5, 1, 2, 3, 5, 10, 20];
        const stopLosses = [2, 5, 10, 20, 50];
        const maxBuysArr = [1, 2, 3, 5, 10, 0];
        const maxPosPcts = [50, 100, 200];

        for (const strategy of filteredStrategies) {
            for (const tradeSize of tradeSizes) {
                for (const budget of budgets) {
                    if (tradeSize > budget) continue;
                    for (const takeProfit of takeProfits) {
                        for (const stopLoss of stopLosses) {
                            for (const maxBuys of maxBuysArr) {
                                for (const maxPositionPct of maxPosPcts) {
                                    if (['momentumRider', 'buyStreak'].includes(strategy)) {
                                        for (const buyStreak of buyStreaks) {
                                            configs.push({
                                                strategy, tradeSize, budget, takeProfit, stopLoss,
                                                maxBuys, maxPositionPct, sellStreak: 1, buyStreak,
                                            });
                                        }
                                    } else {
                                        for (const sellStreak of sellStreaks) {
                                            configs.push({
                                                strategy, tradeSize, budget, takeProfit, stopLoss,
                                                maxBuys, maxPositionPct, sellStreak, buyStreak: 1,
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // SmartDipAccumulator configs — Phase 1 coarse grid
    // Fix base params, sweep new params only
    if (!strategyFilter || strategyFilter === 'smartDipAccumulator') {
        const sdaMomentumWindows = [3, 5, 7, 10];
        const sdaMomentumThresholds = [0.10, 0.20, 0.30, 0.50];
        const sdaMaxImpactPcts = [10, 30, 50, 100];
        const sdaCurveScaleThresholds = [0.3, 0.5, 1.0];
        const sdaMinScaleFactors = [0.1, 0.3];
        const sdaTrailActivations = [3, 5, 8];
        const sdaTrailDistances = [1, 3, 5];
        const sdaReversalExitStreaks = [0, 3, 4];

        for (const momentumWindow of sdaMomentumWindows) {
            for (const momentumThreshold of sdaMomentumThresholds) {
                for (const maxImpactPct of sdaMaxImpactPcts) {
                    for (const curveScaleThreshold of sdaCurveScaleThresholds) {
                        for (const minScaleFactor of sdaMinScaleFactors) {
                            for (const trailActivation of sdaTrailActivations) {
                                for (const trailDistance of sdaTrailDistances) {
                                    for (const reversalExitStreak of sdaReversalExitStreaks) {
                                        configs.push({
                                            strategy: 'smartDipAccumulator',
                                            tradeSize: 0.1, budget: 1.0,
                                            takeProfit: 10, stopLoss: 20,
                                            maxBuys: 10, maxPositionPct: 100,
                                            sellStreak: 1, buyStreak: 1,
                                            momentumWindow, momentumThreshold,
                                            maxImpactPct, curveScaleThreshold,
                                            minScaleFactor, trailActivation,
                                            trailDistance, reversalExitStreak,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // ProportionalDip configs — sweep proportional sizing params + mcap floor
    if (!strategyFilter || strategyFilter === 'proportionalDip') {
        const pdScaleThresholds = [0.3, 0.5, 1.0];
        const pdMinScales = [0.02, 0.05, 0.10];
        const pdMaxScales = [1.5, 2.0, 3.0];
        const pdTakeProfits = [5, 10];
        const pdStopLosses = [15, 20];
        const pdSellStreaks = [1, 2];
        const pdMaxBuysArr = [5, 10];
        const pdMcapFloors = [0, 12, 15, 18];

        for (const scaleThreshold of pdScaleThresholds) {
            for (const minScale of pdMinScales) {
                for (const maxScale of pdMaxScales) {
                    for (const takeProfit of pdTakeProfits) {
                        for (const stopLoss of pdStopLosses) {
                            for (const sellStreak of pdSellStreaks) {
                                for (const maxBuys of pdMaxBuysArr) {
                                    for (const mcapFloor of pdMcapFloors) {
                                        configs.push({
                                            strategy: 'proportionalDip',
                                            tradeSize: 0.1, budget: 1.0,
                                            takeProfit, stopLoss,
                                            maxBuys, maxPositionPct: 100,
                                            sellStreak, buyStreak: 1,
                                            scaleThreshold, minScale, maxScale,
                                            mcapFloor,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // MomentumConfirmed configs
    if (!strategyFilter || strategyFilter === 'momentumConfirmed') {
        for (const approach of ['A', 'C']) {
            for (const tradeSize of [0.1, 0.2, 0.3]) {
                for (const entryRatio of (approach === 'A' ? [0.8, 1.0, 1.2, 1.5] : [0])) {
                    for (const scoreThreshold of (approach === 'C' ? [0.5, 1.0, 2.0, 3.0] : [0])) {
                        for (const takeProfit of [5, 10, 15]) {
                            for (const maxBuys of [1, 2, 3]) {
                                for (const killSwitch of [0, 2, 3]) {
                                    configs.push({
                                        strategy: 'momentumConfirmed',
                                        tradeSize, budget: 1.0,
                                        takeProfit, stopLoss: 20,
                                        maxBuys, maxPositionPct: 100,
                                        sellStreak: 1, buyStreak: 1,
                                        approach, entryRatio, scoreThreshold, killSwitch,
                                        mcapFloor: 0,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // flipScalper configs
    if (!strategyFilter || strategyFilter === 'flipScalper') {
        for (const tradeSize of [0.05, 0.1, 0.2, 0.3]) {
            for (const budget of [0.5, 1.0]) {
                for (const flipEntryMcap of [30, 35, 40, 45, 50, 60]) {
                    configs.push({
                        strategy: 'flipScalper',
                        tradeSize, budget, flipEntryMcap,
                        takeProfit: 100, stopLoss: 100,  // effectively disabled
                        maxBuys: 0, maxPositionPct: 100,
                        sellStreak: 1, buyStreak: 1,
                        mcapFloor: 0,
                    });
                }
            }
        }
    }

    // holdReversal configs
    if (!strategyFilter || strategyFilter === 'holdReversal') {
        for (const tradeSize of [0.1, 0.2, 0.3]) {
            for (const budget of [0.5, 1.0]) {
                for (const flipEntryMcap of [30, 40, 50, 60, 70]) {
                    configs.push({
                        strategy: 'holdReversal',
                        tradeSize, budget, flipEntryMcap,
                        takeProfit: 100, stopLoss: 100,
                        maxBuys: 0, maxPositionPct: 100,
                        sellStreak: 1, buyStreak: 1,
                        mcapFloor: 0,
                    });
                }
            }
        }
    }

    return configs;
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

function parseArgs() {
    const args = process.argv.slice(2);
    const config = { files: [], top: 30, strategy: null };
    for (const arg of args) {
        if (arg.startsWith('--file=')) config.files.push(arg.split('=')[1]);
        else if (arg.startsWith('--top=')) config.top = parseInt(arg.split('=')[1]);
        else if (arg.startsWith('--strategy=')) config.strategy = arg.split('=')[1];
    }
    return config;
}

const cliConfig = parseArgs();

// Load datasets from analysis/ and analysis/tokens/
if (cliConfig.files.length === 0) {
    const dirs = [
        new URL('../analysis', import.meta.url).pathname,
        new URL('../analysis/tokens', import.meta.url).pathname,
    ];
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
            if (f.endsWith('.json')) cliConfig.files.push(path.join(dir, f));
        }
    }
}

if (cliConfig.files.length === 0) {
    console.error('No dataset files found. Run extractTradeDataset.js first.');
    process.exit(1);
}

const datasets = [];
for (const file of cliConfig.files) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    datasets.push({ mint: data.mint, trades: data.trades, file });
    console.log(`Loaded ${data.trades.length} trades from ${data.mint} (${path.basename(file)})`);
}

const configs = generateConfigs(cliConfig.strategy);
console.log(`\nSweeping ${configs.length.toLocaleString()} configs across ${datasets.length} dataset(s)...`);

const t0 = Date.now();
const results = [];

for (const config of configs) {
    let totalPnlPct = 0;
    let wins = 0;
    const perMint = [];
    let totalPnlSol = 0;

    // Wallet simulation: replay all tokens with running balance
    const walletStart = BigInt(Math.floor(config.budget * 1e9));
    let wallet = walletStart;
    const tradeSizeCheck = BigInt(Math.floor(config.tradeSize * 1e9));
    let walletDepleted = false;

    for (const ds of datasets) {
        const r = replayDataset(ds.trades, config);
        totalPnlPct += r.pnlPct;
        totalPnlSol += r.pnlSol;
        if (r.pnlPct > 0) wins++;
        perMint.push({ mint: ds.mint, ...r });

        // Track wallet evolution
        if (!walletDepleted && wallet >= tradeSizeCheck) {
            const tokenBudget = wallet < walletStart ? wallet : walletStart;
            // Simulate with this budget
            const wr = replayDataset(ds.trades, { ...config, budget: Number(tokenBudget) / 1e9 });
            wallet = wallet - tokenBudget + wr.finalBalance;
            if (wallet < tradeSizeCheck) walletDepleted = true;
        }
    }

    results.push({
        config,
        meanPnlPct: totalPnlPct / datasets.length,
        meanPnlSol: totalPnlSol / datasets.length,
        winRate: wins / datasets.length * 100,
        walletFinal: Number(wallet) / 1e9,
        walletReturn: (Number(wallet) - Number(walletStart)) / Number(walletStart) * 100,
        perMint,
    });
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
console.log(`Done in ${elapsed}s\n`);

// Sort by wallet return (real-world profitability)
results.sort((a, b) => b.walletReturn - a.walletReturn);

// Print top results
const top = results.slice(0, cliConfig.top);
const isSDA = cliConfig.strategy === 'smartDipAccumulator';
const isPD = cliConfig.strategy === 'proportionalDip';
const isMC = cliConfig.strategy === 'momentumConfirmed';
const isFlip = cliConfig.strategy === 'flipScalper' || cliConfig.strategy === 'holdReversal';
console.log(`TOP ${top.length} CONFIGS (by wallet return on ${datasets.length} tokens)`);
if (isSDA) {
    console.log('─'.repeat(180));
    console.log(` ${'#'.padStart(3)} | ${'Strategy'.padEnd(20)} | ${'MomW'.padStart(4)} | ${'MomT'.padStart(5)} | ${'MaxI'.padStart(4)} | ${'CrvS'.padStart(4)} | ${'MinS'.padStart(4)} | ${'TrlA'.padStart(4)} | ${'TrlD'.padStart(4)} | ${'RevS'.padStart(4)} | ${'MeanP&L'.padStart(9)} | ${'WinRate'.padStart(7)} | ${'Wallet'.padStart(8)} | ${'WalletRet'.padStart(10)} | ${'Exit'.padStart(6)}`);
    console.log('─'.repeat(180));
} else if (isPD) {
    console.log('─'.repeat(170));
    console.log(` ${'#'.padStart(3)} | ${'Strategy'.padEnd(16)} | ${'ScThr'.padStart(5)} | ${'MinS'.padStart(5)} | ${'MaxS'.padStart(5)} | ${'MCap'.padStart(4)} | ${'TP%'.padStart(5)} | ${'SL%'.padStart(5)} | ${'Strk'.padStart(4)} | ${'MaxB'.padStart(4)} | ${'MeanP&L'.padStart(9)} | ${'WinRate'.padStart(7)} | ${'Wallet'.padStart(8)} | ${'WalletRet'.padStart(10)} | ${'Exit'.padStart(6)}`);
    console.log('─'.repeat(170));
} else if (isMC) {
    console.log('─'.repeat(170));
    console.log(` ${'#'.padStart(3)} | ${'Appr'.padStart(4)} | ${'Size'.padStart(5)} | ${'Ratio'.padStart(5)} | ${'Score'.padStart(5)} | ${'TP%'.padStart(5)} | ${'MaxB'.padStart(4)} | ${'Kill'.padStart(4)} | ${'MeanP&L'.padStart(9)} | ${'WinRate'.padStart(7)} | ${'Wallet'.padStart(8)} | ${'WalletRet'.padStart(10)} | ${'Exit'.padStart(6)}`);
    console.log('─'.repeat(170));
} else if (isFlip) {
    console.log('─'.repeat(130));
    console.log(` ${'#'.padStart(3)} | ${'Size'.padStart(6)} | ${'Budget'.padStart(6)} | ${'Entry'.padStart(5)} | ${'MeanP&L'.padStart(9)} | ${'WinRate'.padStart(7)} | ${'Wallet'.padStart(8)} | ${'WalletRet'.padStart(10)} | ${'Exit'.padStart(6)}`);
    console.log('─'.repeat(140));
} else {
    console.log('─'.repeat(140));
    console.log(` ${'#'.padStart(3)} | ${'Strategy'.padEnd(16)} | ${'Size'.padStart(6)} | ${'Budget'.padStart(6)} | ${'TP%'.padStart(5)} | ${'SL%'.padStart(5)} | ${'Streak'.padStart(6)} | ${'MaxB'.padStart(4)} | ${'MaxP%'.padStart(5)} | ${'MeanP&L'.padStart(9)} | ${'WinRate'.padStart(7)} | ${'Wallet'.padStart(8)} | ${'WalletRet'.padStart(10)}`);
    console.log('─'.repeat(140));
}

for (let i = 0; i < top.length; i++) {
    const r = top[i];
    const c = r.config;
    const walletStr = r.walletFinal.toFixed(4);
    const walletRetStr = (r.walletReturn >= 0 ? '+' : '') + r.walletReturn.toFixed(2) + '%';

    if (isSDA) {
        // Tally exit reasons
        const exits = {};
        for (const m of r.perMint) { exits[m.exitReason] = (exits[m.exitReason] || 0) + 1; }
        const exitStr = Object.entries(exits).map(([k,v]) => `${k}:${v}`).join(' ');
        console.log(` ${String(i+1).padStart(3)} | ${c.strategy.padEnd(20)} | ${String(c.momentumWindow).padStart(4)} | ${c.momentumThreshold.toFixed(2).padStart(5)} | ${String(c.maxImpactPct).padStart(4)} | ${c.curveScaleThreshold.toFixed(1).padStart(4)} | ${c.minScaleFactor.toFixed(1).padStart(4)} | ${c.trailActivation.toString().padStart(4)} | ${c.trailDistance.toString().padStart(4)} | ${c.reversalExitStreak.toString().padStart(4)} | ${(r.meanPnlPct >= 0 ? '+' : '') + r.meanPnlPct.toFixed(4).padStart(8)}% | ${(r.winRate.toFixed(0) + '%').padStart(7)} | ${walletStr.padStart(8)} | ${walletRetStr.padStart(10)} | ${exitStr}`);
    } else if (isPD) {
        const exits = {};
        for (const m of r.perMint) { exits[m.exitReason] = (exits[m.exitReason] || 0) + 1; }
        const exitStr = Object.entries(exits).map(([k,v]) => `${k}:${v}`).join(' ');
        console.log(` ${String(i+1).padStart(3)} | ${c.strategy.padEnd(16)} | ${c.scaleThreshold.toFixed(1).padStart(5)} | ${c.minScale.toFixed(2).padStart(5)} | ${c.maxScale.toFixed(1).padStart(5)} | ${(c.mcapFloor || 0).toString().padStart(4)} | ${c.takeProfit.toString().padStart(5)} | ${c.stopLoss.toString().padStart(5)} | ${c.sellStreak.toString().padStart(4)} | ${c.maxBuys.toString().padStart(4)} | ${(r.meanPnlPct >= 0 ? '+' : '') + r.meanPnlPct.toFixed(4).padStart(8)}% | ${(r.winRate.toFixed(0) + '%').padStart(7)} | ${walletStr.padStart(8)} | ${walletRetStr.padStart(10)} | ${exitStr}`);
    } else if (isMC) {
        const exits = {};
        for (const m of r.perMint) { exits[m.exitReason] = (exits[m.exitReason] || 0) + 1; }
        const exitStr = Object.entries(exits).map(([k,v]) => `${k}:${v}`).join(' ');
        console.log(` ${String(i+1).padStart(3)} | ${c.approach.padStart(4)} | ${c.tradeSize.toFixed(1).padStart(5)} | ${(c.entryRatio || 0).toFixed(1).padStart(5)} | ${(c.scoreThreshold || 0).toFixed(1).padStart(5)} | ${c.takeProfit.toString().padStart(5)} | ${c.maxBuys.toString().padStart(4)} | ${c.killSwitch.toString().padStart(4)} | ${(r.meanPnlPct >= 0 ? '+' : '') + r.meanPnlPct.toFixed(4).padStart(8)}% | ${(r.winRate.toFixed(0) + '%').padStart(7)} | ${walletStr.padStart(8)} | ${walletRetStr.padStart(10)} | ${exitStr}`);
    } else if (isFlip) {
        const exits = {};
        for (const m of r.perMint) { exits[m.exitReason] = (exits[m.exitReason] || 0) + 1; }
        const exitStr = Object.entries(exits).map(([k,v]) => `${k}:${v}`).join(' ');
        console.log(` ${String(i+1).padStart(3)} | ${c.tradeSize.toString().padStart(6)} | ${c.budget.toString().padStart(6)} | ${(c.flipEntryMcap || 30).toString().padStart(5)} | ${(r.meanPnlPct >= 0 ? '+' : '') + r.meanPnlPct.toFixed(4).padStart(8)}% | ${(r.winRate.toFixed(0) + '%').padStart(7)} | ${walletStr.padStart(8)} | ${walletRetStr.padStart(10)} | ${exitStr}`);
    } else {
        const streakKey = ['momentumRider', 'buyStreak'].includes(c.strategy) ? c.buyStreak : c.sellStreak;
        console.log(` ${String(i+1).padStart(3)} | ${c.strategy.padEnd(16)} | ${c.tradeSize.toString().padStart(6)} | ${c.budget.toString().padStart(6)} | ${c.takeProfit.toString().padStart(5)} | ${c.stopLoss.toString().padStart(5)} | ${streakKey.toString().padStart(6)} | ${c.maxBuys.toString().padStart(4)} | ${c.maxPositionPct.toString().padStart(5)} | ${(r.meanPnlPct >= 0 ? '+' : '') + r.meanPnlPct.toFixed(4).padStart(8)}% | ${(r.winRate.toFixed(0) + '%').padStart(7)} | ${walletStr.padStart(8)} | ${walletRetStr.padStart(10)}`);
    }
}

console.log('─'.repeat(isSDA ? 180 : isPD ? 170 : isMC ? 170 : isFlip ? 130 : 140));

// Print summary
const profitable = results.filter(r => r.walletReturn > 0);
console.log(`\nWallet-profitable configs: ${profitable.length} / ${results.length} (${(profitable.length / results.length * 100).toFixed(1)}%)`);

if (top[0]) {
    const best = top[0];
    const c = best.config;
    console.log(`\nBest config:`);
    let cmdLine = `  --strategy=${c.strategy} --tradeSize=${c.tradeSize} --budget=${c.budget} --takeProfit=${c.takeProfit} --stopLoss=${c.stopLoss} --sellStreak=${c.sellStreak} --maxBuys=${c.maxBuys} --maxPositionPct=${c.maxPositionPct}`;
    if (c.strategy === 'smartDipAccumulator') {
        cmdLine += ` --momentumWindow=${c.momentumWindow} --momentumThreshold=${c.momentumThreshold} --maxImpactPct=${c.maxImpactPct} --curveScaleThreshold=${c.curveScaleThreshold} --minScaleFactor=${c.minScaleFactor} --trailActivation=${c.trailActivation} --trailDistance=${c.trailDistance} --reversalExitStreak=${c.reversalExitStreak}`;
    }
    if (c.strategy === 'proportionalDip') {
        cmdLine += ` --scaleThreshold=${c.scaleThreshold} --minScale=${c.minScale} --maxScale=${c.maxScale}`;
        if (c.mcapFloor > 0) cmdLine += ` --mcapFloor=${c.mcapFloor}`;
    }
    if (c.strategy === 'momentumConfirmed') {
        cmdLine += ` --approach=${c.approach} --entryRatio=${c.entryRatio} --scoreThreshold=${c.scoreThreshold} --killSwitch=${c.killSwitch}`;
    }
    console.log(cmdLine);
    console.log(`  Mean P&L: ${best.meanPnlPct >= 0 ? '+' : ''}${best.meanPnlPct.toFixed(4)}% | Wallet: ${best.walletFinal.toFixed(4)} SOL (${best.walletReturn >= 0 ? '+' : ''}${best.walletReturn.toFixed(2)}%)`);
}
