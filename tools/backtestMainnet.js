#!/usr/bin/env node

/**
 * backtestMainnet.js
 *
 * Backtest the dipAccumulator strategy against real Mayhem bot trades on mainnet.
 *
 * Live mode: listens for new Mayhem token creation, attaches to bot wallet logs,
 * filters for the discovered mint, and simulates the player in real-time.
 *
 * Mint mode: fetches historical trades for a specific token and replays.
 *
 * The player impacts the bonding curve via a delta overlay: each bot trade provides
 * on-chain reserves, and the player's cumulative SOL/token deltas are applied on top.
 *
 * Usage:
 *   node tools/backtestMainnet.js                              # live: stream new tokens
 *   node tools/backtestMainnet.js --mint=<address>             # backtest specific token
 *   node tools/backtestMainnet.js --budget=0.5 --tradeSize=0.1
 *   node tools/backtestMainnet.js --takeProfit=10 --stopLoss=20
 *   node tools/backtestMainnet.js --json                       # JSON output
 */

import { connection } from "../utils/rpc.js";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "fs";
import path from "path";
import { decodeMayhemTradeEvent } from "../decoders/decodeMayhemTradeEvent.js";
import { decodeCreateV2 } from "../decoders/decodeCreateV2.js";
import { decodeTokenState } from "../decoders/decodeTokenState.js";
import { MAYHEM_TRADING_WALLET, MAYHEM_PROGRAM_ID, PUMP_FUN_PROGRAM } from "../utils/constants.js";
import { BondingCurve } from "./monteCarloSimulation.js";

// ═══════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════

function parseArgs() {
    const args = process.argv.slice(2);
    const config = {
        budget: 1.0,
        tradeSize: 0.1,
        takeProfit: 20,
        stopLoss: 20,
        maxBuys: 10,
        sellStreak: 1,
        maxPositionPct: 100,
        strategy: 'dipAccumulator',
        mint: null,
        json: false,
        verbose: false,
        save: null,
        wallet: null, // running wallet mode: initial balance in SOL
        momentumWindow: 5,
        momentumThreshold: 0.50,
        maxImpactPct: 10,
        curveScaleThreshold: 1.0,
        minScaleFactor: 0.3,
        trailActivation: 5,
        trailDistance: 4,
        reversalExitStreak: 0,
        scaleThreshold: 0.5,
        minScale: 0.05,
        maxScale: 2.0,
        mcapFloor: 0, // market cap floor in SOL — sell & stop if mcap drops below
        approach: 'A',
        entryRatio: 1.2,
        scoreThreshold: 2.0,
        killSwitch: 2,
    };

    for (const arg of args) {
        if (arg === '--json') config.json = true;
        else if (arg === '--verbose') config.verbose = true;
        else if (arg.startsWith('--save=')) config.save = arg.split('=')[1];
        else if (arg.startsWith('--budget=')) config.budget = parseFloat(arg.split('=')[1]);
        else if (arg.startsWith('--tradeSize=')) config.tradeSize = parseFloat(arg.split('=')[1]);
        else if (arg.startsWith('--takeProfit=')) config.takeProfit = parseFloat(arg.split('=')[1]);
        else if (arg.startsWith('--stopLoss=')) config.stopLoss = parseFloat(arg.split('=')[1]);
        else if (arg.startsWith('--maxBuys=')) config.maxBuys = parseInt(arg.split('=')[1]);
        else if (arg.startsWith('--sellStreak=')) config.sellStreak = parseInt(arg.split('=')[1]);
        else if (arg.startsWith('--maxPositionPct=')) config.maxPositionPct = parseInt(arg.split('=')[1]);
        else if (arg.startsWith('--strategy=')) config.strategy = arg.split('=')[1];
        else if (arg.startsWith('--mint=')) config.mint = arg.split('=')[1];
        else if (arg.startsWith('--wallet=')) config.wallet = parseFloat(arg.split('=')[1]);
        else if (arg.startsWith('--momentumWindow=')) config.momentumWindow = parseInt(arg.split('=')[1]);
        else if (arg.startsWith('--momentumThreshold=')) config.momentumThreshold = parseFloat(arg.split('=')[1]);
        else if (arg.startsWith('--maxImpactPct=')) config.maxImpactPct = parseInt(arg.split('=')[1]);
        else if (arg.startsWith('--curveScaleThreshold=')) config.curveScaleThreshold = parseFloat(arg.split('=')[1]);
        else if (arg.startsWith('--minScaleFactor=')) config.minScaleFactor = parseFloat(arg.split('=')[1]);
        else if (arg.startsWith('--trailActivation=')) config.trailActivation = parseFloat(arg.split('=')[1]);
        else if (arg.startsWith('--trailDistance=')) config.trailDistance = parseFloat(arg.split('=')[1]);
        else if (arg.startsWith('--reversalExitStreak=')) config.reversalExitStreak = parseInt(arg.split('=')[1]);
        else if (arg.startsWith('--scaleThreshold=')) config.scaleThreshold = parseFloat(arg.split('=')[1]);
        else if (arg.startsWith('--minScale=')) config.minScale = parseFloat(arg.split('=')[1]);
        else if (arg.startsWith('--maxScale=')) config.maxScale = parseFloat(arg.split('=')[1]);
        else if (arg.startsWith('--mcapFloor=')) config.mcapFloor = parseFloat(arg.split('=')[1]);
        else if (arg.startsWith('--approach=')) config.approach = arg.split('=')[1];
        else if (arg.startsWith('--entryRatio=')) config.entryRatio = parseFloat(arg.split('=')[1]);
        else if (arg.startsWith('--scoreThreshold=')) config.scoreThreshold = parseFloat(arg.split('=')[1]);
        else if (arg.startsWith('--killSwitch=')) config.killSwitch = parseInt(arg.split('=')[1]);
    }

    return config;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

// Serialize RPC calls to avoid 429 rate limits
const rpcQueue = (() => {
    let pending = Promise.resolve();
    const MIN_GAP_MS = 250; // max ~4 req/s
    return (fn) => {
        pending = pending
            .then(() => fn())
            .then(result => new Promise(resolve =>
                setTimeout(() => resolve(result), MIN_GAP_MS)
            ));
        return pending;
    };
})();

async function fetchTxWithRetry(signature, maxRetries = 5) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const tx = await rpcQueue(() =>
            connection.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed',
            })
        );
        if (tx) return tx;
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
    return null;
}

function decodeBotTrade(tx) {
    const isBotTx = tx.transaction.message.accountKeys.some(
        ({ pubkey, signer }) => pubkey.toBase58() === MAYHEM_TRADING_WALLET && signer
    );
    if (!isBotTx) return null;
    if (!tx.meta?.innerInstructions?.length) return null;

    for (const innerSet of tx.meta.innerInstructions) {
        const lastIx = innerSet.instructions[innerSet.instructions.length - 1];
        if (!lastIx?.data) continue;

        try {
            const decoded = decodeMayhemTradeEvent(bs58.decode(lastIx.data));
            if (decoded.virtualSolReserves && decoded.virtualTokenReserves) {
                return {
                    slot: tx.slot,
                    blockTime: tx.blockTime,
                    mint: decoded.mint,
                    action: decoded.actionType === 0 ? 'buy' : 'sell',
                    solAmount: decoded.solAmount,
                    tokenAmount: decoded.tokenAmount,
                    virtualSolReserves: decoded.virtualSolReserves,
                    virtualTokenReserves: decoded.virtualTokenReserves,
                    realSolReserves: decoded.realSolReserves,
                    realTokenReserves: decoded.realTokenReserves,
                };
            }
        } catch {
            // Not a trade event
        }
    }
    return null;
}

function formatDuration(seconds) {
    if (seconds < 0) seconds = 0;
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m < 60) return `${m}m ${s}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}

function formatSign(val, decimals = 2) {
    return (val >= 0 ? '+' : '') + val.toFixed(decimals);
}

// ═══════════════════════════════════════════════════════════════════════════
// Detect new Mayhem token creation via WebSocket
// ═══════════════════════════════════════════════════════════════════════════

function waitForNewMint(log) {
    return new Promise((resolve) => {
        if (log) console.log(`\nListening for new Mayhem token creation...`);

        let resolved = false;

        const logsId = connection.onLogs(
            new PublicKey(MAYHEM_PROGRAM_ID),
            async (logs) => {
                if (logs.err || resolved) return;

                const isCreateLog = logs.logs?.some(l => l.includes('Instruction: CreateV2'));
                if (!isCreateLog) return;

                try {
                    const tx = await fetchTxWithRetry(logs.signature);
                    if (!tx || resolved) return;

                    let createIx = null;
                    for (const ix of tx.transaction.message.instructions) {
                        const programId = ix.programId?.toBase58?.() || ix.programId?.toString?.();
                        if (programId !== PUMP_FUN_PROGRAM || !ix.data) continue;
                        try {
                            const ixBuffer = Buffer.from(bs58.decode(ix.data));
                            if (decodeCreateV2(ixBuffer).isMayhemMode) { createIx = ix; break; }
                        } catch {}
                    }

                    if (!createIx || resolved) return;

                    resolved = true;
                    await connection.removeOnLogsListener(logsId);

                    const stateAccountKey = tx.transaction.message.accountKeys[6];
                    const stateAccountData = await connection.getAccountInfo(stateAccountKey.pubkey);
                    const mintAddress = decodeTokenState(stateAccountData.data).targetMint;

                    if (log) console.log(`  New Mayhem token: ${mintAddress}`);
                    resolve(mintAddress);
                } catch (e) {
                    if (log && e.message) console.log(`  (detection error: ${e.message})`);
                }
            },
            'processed'
        );
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Live streaming: attach to bot, simulate player in real-time
// ═══════════════════════════════════════════════════════════════════════════

function streamAndSimulate(mintAddress, config, log, walletBalance) {
    return new Promise((resolve) => {
        const INACTIVITY_MS = 10_000;
        const POLL_INTERVAL_MS = 3_000;
        const MAX_INACTIVITY_MS = 120_000; // Force-end session after 2 min no trades
        const initialBudget = walletBalance ?? BigInt(Math.floor(config.budget * 1e9));
        const tradeSizeLamports = BigInt(Math.floor(config.tradeSize * 1e9));

        // Derive the Mayhem state PDA for this mint
        const [statePDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("mayhem-state"), new PublicKey(mintAddress).toBuffer()],
            new PublicKey(MAYHEM_PROGRAM_ID)
        );

        let solBalance = initialBudget;
        let tokenBalance = 0n;
        let playerTradeCount = 0;
        let botTradeCount = 0;
        let botBuys = 0;
        let botSells = 0;
        let exitReason = 'END';
        let startTime = null;
        let lastTradeTime = null;
        let consecutiveSells = 0;
        let exited = false;
        let playerSolDelta = 0n;
        let playerTokenDelta = 0n;
        let timer = null;
        let pollInterval = null;
        let maxTimer = null;
        let priceHistory = [];
        let peakPnlPct = 0;
        let trailingActive = false;
        let lastTradeReserves = null; // Track last trade reserves for force sell
        let mcEntered = false;
        let mcWatchStart = null;

        // Set of already-processed signatures to avoid duplicates
        const processed = new Set();

        function finishSession() {
            if (exited) return;
            exited = true;
            if (timer) clearTimeout(timer);
            if (pollInterval) clearInterval(pollInterval);
            if (maxTimer) clearTimeout(maxTimer);

            // Force sell remaining tokens at last known curve state
            if (tokenBalance > 0n && lastTradeReserves) {
                const curve = new BondingCurve();
                curve.virtualSolReserves = lastTradeReserves.virtualSolReserves + playerSolDelta;
                curve.virtualTokenReserves = lastTradeReserves.virtualTokenReserves - playerTokenDelta;
                curve.realSolReserves = lastTradeReserves.realSolReserves + playerSolDelta;
                curve.realTokenReserves = lastTradeReserves.realTokenReserves - playerTokenDelta;
                solBalance += curve.executeSell(tokenBalance);
                tokenBalance = 0n;
                if (log) console.log(`  Force-sold remaining tokens at END`);
            }

            const pnlPct = Number(solBalance - initialBudget) / Number(initialBudget) * 100;
            const durationSec = (startTime && lastTradeTime) ? lastTradeTime - startTime : 0;

            const result = {
                mint: mintAddress,
                pnlPct,
                pnlSol: Number(solBalance - initialBudget) / 1e9,
                tradeCount: playerTradeCount,
                totalInvested: playerTradeCount * config.tradeSize,
                botBuys,
                botSells,
                exitReason,
                durationSec,
                finalBalance: solBalance,
            };

            resolve(result);
        }

        async function checkIsRunning() {
            if (exited) return;
            try {
                const accountData = await rpcQueue(() => connection.getAccountInfo(statePDA));
                if (!accountData) {
                    // Account closed/gone — session is over
                    if (pollInterval) clearInterval(pollInterval);
                    await connection.removeOnLogsListener(logsId);
                    if (log) console.log(`  Session ended (state account closed).`);
                    finishSession();
                    return;
                }
                const state = decodeTokenState(accountData.data);
                if (!state.isRunning) {
                    if (pollInterval) clearInterval(pollInterval);
                    await connection.removeOnLogsListener(logsId);
                    if (log) console.log(`  Session ended (isRunning=false).`);
                    finishSession();
                }
            } catch (e) {
                // Decode error likely means the account structure changed or was closed
                if (log) console.log(`  (isRunning check error: ${e.message})`);
                if (pollInterval) clearInterval(pollInterval);
                await connection.removeOnLogsListener(logsId);
                finishSession();
            }
        }

        function resetTimer() {
            if (timer) clearTimeout(timer);
            if (pollInterval) clearInterval(pollInterval);
            if (maxTimer) clearTimeout(maxTimer);
            timer = setTimeout(() => {
                if (exited) return;
                // After 10s inactivity, start polling isRunning
                if (log) console.log(`  (10s inactivity, polling isRunning...)`);
                checkIsRunning();
                pollInterval = setInterval(checkIsRunning, POLL_INTERVAL_MS);
            }, INACTIVITY_MS);
            // Hard timeout: force-end if no trades for 2 min
            maxTimer = setTimeout(async () => {
                if (exited) return;
                if (log) console.log(`  (Max inactivity timeout — force-ending session)`);
                if (pollInterval) clearInterval(pollInterval);
                try { await connection.removeOnLogsListener(logsId); } catch {}
                finishSession();
            }, MAX_INACTIVITY_MS);
        }

        if (log) console.log(`  Attached to bot wallet, streaming trades for ${mintAddress}...`);

        const logsId = connection.onLogs(
            new PublicKey(MAYHEM_TRADING_WALLET),
            async (logs) => {
                if (logs.err || exited) return;
                if (processed.has(logs.signature)) return;
                processed.add(logs.signature);

                try {
                    const tx = await fetchTxWithRetry(logs.signature);
                    if (!tx || exited) return;

                    const trade = decodeBotTrade(tx);
                    if (!trade || trade.mint !== mintAddress || exited) return;

                    resetTimer(); // Only reset for OUR mint

                    botTradeCount++;
                    if (trade.action === 'buy') botBuys++;
                    else botSells++;

                    if (!startTime) startTime = trade.blockTime;
                    lastTradeTime = trade.blockTime;
                    lastTradeReserves = {
                        virtualSolReserves: BigInt(trade.virtualSolReserves),
                        virtualTokenReserves: BigInt(trade.virtualTokenReserves),
                        realSolReserves: BigInt(trade.realSolReserves),
                        realTokenReserves: BigInt(trade.realTokenReserves),
                    };

                    // Reconstruct curve from post-trade reserves + player delta overlay
                    const curve = new BondingCurve();
                    curve.virtualSolReserves = BigInt(trade.virtualSolReserves) + playerSolDelta;
                    curve.virtualTokenReserves = BigInt(trade.virtualTokenReserves) - playerTokenDelta;
                    curve.realSolReserves = BigInt(trade.realSolReserves) + playerSolDelta;
                    curve.realTokenReserves = BigInt(trade.realTokenReserves) - playerTokenDelta;

                    // Market cap floor: sell & exit if mcap drops below threshold
                    if (config.mcapFloor > 0) {
                        const mcapSol = Number(1_000_000_000_000_000n * curve.virtualSolReserves / curve.virtualTokenReserves) / 1e9;
                        if (mcapSol < config.mcapFloor) {
                            exitReason = 'MCAP';
                            if (tokenBalance > 0n) {
                                solBalance += curve.executeSell(tokenBalance);
                                tokenBalance = 0n;
                            }
                            await connection.removeOnLogsListener(logsId);
                            if (log) console.log(`  >>> MCAP FLOOR HIT: ${mcapSol.toFixed(1)} SOL < ${config.mcapFloor} SOL`);
                            finishSession();
                            return;
                        }
                    }

                    // momentumConfirmed: kill switch
                    if (config.strategy === 'momentumConfirmed' && mcEntered && tokenBalance > 0n && config.killSwitch > 0) {
                        const excess = botSells - botBuys;
                        if (excess >= config.killSwitch) {
                            exitReason = 'KILL';
                            solBalance += curve.executeSell(tokenBalance);
                            tokenBalance = 0n;
                            await connection.removeOnLogsListener(logsId);
                            if (log) console.log(`  >>> KILL SWITCH: excess=${excess} >= ${config.killSwitch} | ${botBuys}B/${botSells}S`);
                            finishSession();
                            return;
                        }
                    }

                    // Price tracking for smartDipAccumulator
                    if (config.strategy === 'smartDipAccumulator') {
                        const currentPrice = Number(curve.virtualSolReserves) / Number(curve.virtualTokenReserves);
                        priceHistory.push(currentPrice);
                        if (priceHistory.length > config.momentumWindow) priceHistory.shift();
                    }

                    // Track consecutive sells
                    if (trade.action === 'sell') consecutiveSells++;
                    else consecutiveSells = 0;

                    // streakReversal: sell all on first bot buy after we hold tokens
                    if (config.strategy === 'streakReversal'
                        && trade.action === 'buy' && tokenBalance > 0n) {
                        const vSolBefore = curve.virtualSolReserves;
                        const vTokenBefore = curve.virtualTokenReserves;
                        solBalance += curve.executeSell(tokenBalance);
                        playerSolDelta += curve.virtualSolReserves - vSolBefore;
                        playerTokenDelta += vTokenBefore - curve.virtualTokenReserves;
                        tokenBalance = 0n;
                        playerTradeCount++;
                    }

                    // smartDipAccumulator exit checks
                    if (config.strategy === 'smartDipAccumulator' && tokenBalance > 0n) {
                        const tokenValue = curve.getSolForTokens(tokenBalance);
                        const portfolio = solBalance + tokenValue;
                        const sdaPnlPct = Number(portfolio - initialBudget) / Number(initialBudget) * 100;

                        if (sdaPnlPct > peakPnlPct) peakPnlPct = sdaPnlPct;

                        // Reversal exit
                        if (config.reversalExitStreak > 0 && sdaPnlPct > 0
                            && consecutiveSells >= config.reversalExitStreak) {
                            exitReason = 'REV';
                            if (tokenBalance > 0n) {
                                solBalance += curve.executeSell(tokenBalance);
                                tokenBalance = 0n;
                            }
                            await connection.removeOnLogsListener(logsId);
                            if (log) console.log(`  >>> REVERSAL EXIT: ${formatSign(sdaPnlPct)}%`);
                            finishSession();
                            return;
                        }

                        // Trailing stop
                        if (peakPnlPct >= config.trailActivation) trailingActive = true;
                        if (trailingActive) {
                            const dynamicSL = peakPnlPct - config.trailDistance;
                            if (sdaPnlPct <= dynamicSL) {
                                exitReason = 'TRAIL';
                                if (tokenBalance > 0n) {
                                    solBalance += curve.executeSell(tokenBalance);
                                    tokenBalance = 0n;
                                }
                                await connection.removeOnLogsListener(logsId);
                                if (log) console.log(`  >>> TRAILING STOP: ${formatSign(sdaPnlPct)}% (peak was ${formatSign(peakPnlPct)}%)`);
                                finishSession();
                                return;
                            }
                        }
                    }

                    // Verbose tracking
                    let vRoc = null, vRocPass = true;
                    let vShare = null, vSharePass = true;
                    let vScale = null, vBuyAmountSol = null;
                    let vBought = false, vSkipReason = null;

                    // momentumConfirmed: watch phase + gated entry
                    if (config.strategy === 'momentumConfirmed') {
                        if (!mcWatchStart) mcWatchStart = trade.blockTime || Date.now() / 1000;

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
                                const elapsed = (trade.blockTime || Date.now() / 1000) - mcWatchStart;
                                if (totalBotTrades >= 2 && elapsed > 0) {
                                    const direction = botBuys - botSells;
                                    const speed = totalBotTrades / elapsed;
                                    const score = direction * speed;
                                    shouldEnter = score >= config.scoreThreshold;
                                    if (config.verbose && log) {
                                        console.log(`       [WATCH] score=${score.toFixed(2)} (dir=${direction} spd=${speed.toFixed(2)}) ${shouldEnter ? 'ENTER' : 'wait'}`);
                                    }
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
                                    playerTradeCount++;
                                    if (log) console.log(`  >>> ENTRY CONFIRMED: ${config.approach === 'A' ? `B/S=${(botBuys/botSells).toFixed(2)}` : `score>=${config.scoreThreshold}`} | bought ${(Number(buyAmount) / 1e9).toFixed(3)} SOL | ${botBuys}B/${botSells}S`);
                                }
                            } else if (config.verbose && log && trade.action === 'sell') {
                                const ratioStr = botSells > 0 ? (botBuys / botSells).toFixed(2) : 'inf';
                                console.log(`       [WATCH] B/S=${ratioStr} | ${botBuys}B/${botSells}S | waiting...`);
                            }
                        } else if (config.maxBuys > 1 && playerTradeCount < config.maxBuys
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
                                playerTradeCount++;
                            }
                        }
                    }

                    // Buy when bot sells (with sellStreak + maxPositionPct)
                    if (config.strategy !== 'momentumConfirmed'
                        && trade.action === 'sell' && consecutiveSells >= config.sellStreak
                        && solBalance >= tradeSizeLamports
                        && (config.maxBuys === 0 || playerTradeCount < config.maxBuys)) {

                        // SmartDipAccumulator entry filters
                        let skipBuy = false;
                        if (config.strategy === 'smartDipAccumulator') {
                            // Momentum filter
                            if (priceHistory.length >= config.momentumWindow) {
                                const oldPrice = priceHistory[0];
                                const currentPrice = priceHistory[priceHistory.length - 1];
                                const roc = (currentPrice - oldPrice) / oldPrice;
                                vRoc = roc;
                                if (roc < -config.momentumThreshold) {
                                    skipBuy = true;
                                    vRocPass = false;
                                    vSkipReason = 'MOM';
                                }
                            }
                            // Impact check
                            if (!skipBuy && tokenBalance > 0n && curve.realTokenReserves > 0n) {
                                const share = Number(tokenBalance) / Number(curve.realTokenReserves) * 100;
                                vShare = share;
                                if (share > config.maxImpactPct) {
                                    skipBuy = true;
                                    vSharePass = false;
                                    vSkipReason = 'IMPACT';
                                }
                            }
                        }

                        if (!skipBuy) {
                            let buyAmount = tradeSizeLamports;

                            // Adaptive sizing for smartDipAccumulator
                            if (config.strategy === 'smartDipAccumulator') {
                                const realSolFloat = Number(curve.realSolReserves) / 1e9;
                                const scaleFactor = Math.min(1.0,
                                    Math.max(config.minScaleFactor, realSolFloat / config.curveScaleThreshold));
                                vScale = scaleFactor;
                                buyAmount = BigInt(Math.floor(Number(tradeSizeLamports) * scaleFactor));
                            }

                            // Proportional sizing for proportionalDip
                            if (config.strategy === 'proportionalDip') {
                                const realSolFloat = Number(curve.realSolReserves) / 1e9;
                                const scale = Math.min(config.maxScale, Math.max(config.minScale, realSolFloat / config.scaleThreshold));
                                vScale = scale;
                                buyAmount = BigInt(Math.floor(Number(tradeSizeLamports) * scale));
                            }

                            const maxSol = curve.realSolReserves * BigInt(config.maxPositionPct) / 100n;
                            if (maxSol > 0n && buyAmount > maxSol) buyAmount = maxSol;
                            if (buyAmount > solBalance) buyAmount = solBalance;
                            vBuyAmountSol = Number(buyAmount) / 1e9;
                            const vSolBefore = curve.virtualSolReserves;
                            const vTokenBefore = curve.virtualTokenReserves;
                            const tokensReceived = curve.executeBuy(buyAmount);
                            playerSolDelta += curve.virtualSolReserves - vSolBefore;
                            playerTokenDelta += vTokenBefore - curve.virtualTokenReserves;
                            tokenBalance += tokensReceived;
                            solBalance -= buyAmount;
                            playerTradeCount++;
                            vBought = true;
                        }
                    }

                    // Valorize position
                    const tokenValue = tokenBalance > 0n ? curve.getSolForTokens(tokenBalance) : 0n;
                    const portfolio = solBalance + tokenValue;
                    const pnlPct = Number(portfolio - initialBudget) / Number(initialBudget) * 100;

                    // Live status
                    if (log) {
                        const action = trade.action.toUpperCase().padEnd(4);
                        const pnlStr = formatSign(pnlPct);
                        const solStr = (Number(trade.solAmount) / 1e9).toFixed(4);
                        console.log(`  [${botTradeCount}] Bot ${action} ${solStr} SOL | Player: ${playerTradeCount} buys, P&L: ${pnlStr}% | ${botBuys}B/${botSells}S`);

                        // Verbose: decision details for smartDipAccumulator
                        if (config.verbose && config.strategy === 'smartDipAccumulator') {
                            if (trade.action === 'sell') {
                                const rocStr = vRoc !== null ? `roc=${vRoc.toFixed(2)} ${vRocPass ? 'PASS' : 'SKIP'}` : 'roc=n/a';
                                const shareStr = vShare !== null ? `impact=${vShare.toFixed(1)}% ${vSharePass ? 'PASS' : 'SKIP'}` : 'impact=n/a';
                                const sizeStr = vBought ? `scale=${(vScale ?? 1).toFixed(2)} buy=${vBuyAmountSol.toFixed(3)} SOL` : (vSkipReason ? `SKIPPED(${vSkipReason})` : 'no-buy');
                                console.log(`       ${rocStr} | ${shareStr} | ${sizeStr} | realSOL=${(Number(curve.realSolReserves) / 1e9).toFixed(2)}`);
                            }
                            const dynSL = trailingActive ? peakPnlPct - config.trailDistance : null;
                            console.log(`       trail: peak=${formatSign(peakPnlPct)}% active=${trailingActive ? 'yes' : 'no'}${trailingActive ? ` dynSL=${formatSign(dynSL)}%` : ''} | sells=${consecutiveSells}/${config.reversalExitStreak}`);
                        }

                        // Verbose: decision details for proportionalDip
                        if (config.verbose && config.strategy === 'proportionalDip') {
                            if (trade.action === 'sell') {
                                const sizeStr = vBought ? `scale=${(vScale ?? 1).toFixed(2)} buy=${vBuyAmountSol.toFixed(3)} SOL` : 'no-buy';
                                console.log(`       ${sizeStr} | realSOL=${(Number(curve.realSolReserves) / 1e9).toFixed(2)}`);
                            }
                        }
                    }

                    // Check TP/SL
                    if (pnlPct >= config.takeProfit) {
                        exitReason = 'TP';
                        if (tokenBalance > 0n) {
                            solBalance += curve.executeSell(tokenBalance);
                            tokenBalance = 0n;
                        }
                        await connection.removeOnLogsListener(logsId);
                        if (log) console.log(`  >>> TAKE PROFIT HIT: ${formatSign(pnlPct)}%`);
                        finishSession();
                        return;
                    }
                    if (pnlPct <= -config.stopLoss) {
                        exitReason = 'SL';
                        if (tokenBalance > 0n) {
                            solBalance += curve.executeSell(tokenBalance);
                            tokenBalance = 0n;
                        }
                        await connection.removeOnLogsListener(logsId);
                        if (log) console.log(`  >>> STOP LOSS HIT: ${formatSign(pnlPct)}%`);
                        finishSession();
                        return;
                    }
                } catch (e) {
                    // Ignore individual trade decode errors
                }
            },
            'processed'
        );

        // Start the quiet timer
        resetTimer();
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Historical mode: fetch trades for a specific mint and replay
// ═══════════════════════════════════════════════════════════════════════════

async function fetchTradesForMint(mintAddress, log) {
    const mintPubkey = new PublicKey(mintAddress);
    const allSignatures = [];
    let before = undefined;

    while (true) {
        const batch = await connection.getSignaturesForAddress(mintPubkey, {
            limit: 1000, before,
        }, 'confirmed');
        if (batch.length === 0) break;
        allSignatures.push(...batch.filter(s => !s.err));
        before = batch[batch.length - 1].signature;
        if (batch.length < 1000) break;
    }

    if (log) console.log(`  Found ${allSignatures.length} signatures for ${mintAddress}`);

    const trades = [];

    for (let i = 0; i < allSignatures.length; i++) {
        const sig = allSignatures[i];
        const tx = await rpcQueue(() =>
            connection.getParsedTransaction(sig.signature, {
                maxSupportedTransactionVersion: 0, commitment: 'confirmed',
            }).catch(() => null)
        );

        if (tx) {
            const trade = decodeBotTrade(tx);
            if (trade) trades.push(trade);
        }

        if (log && (i + 1) % 10 === 0) {
            process.stdout.write(`\r  Decoded ${trades.length} bot trades from ${i + 1}/${allSignatures.length} txs...`);
        }
    }

    trades.sort((a, b) => a.slot - b.slot);
    if (log) console.log(`\r  Decoded ${trades.length} bot trades for ${mintAddress}                    `);
    return trades;
}

function replayToken(botTrades, config) {
    const initialBudget = BigInt(Math.floor(config.budget * 1e9));
    const tradeSizeLamports = BigInt(Math.floor(config.tradeSize * 1e9));

    let solBalance = initialBudget;
    let tokenBalance = 0n;
    let tradeCount = 0;
    let consecutiveSells = 0;
    let playerSolDelta = 0n;
    let playerTokenDelta = 0n;
    let exitReason = 'END';
    let exitTradeIndex = botTrades.length - 1;
    let priceHistory = [];
    let peakPnlPct = 0;
    let trailingActive = false;
    let runBotBuys = 0;
    let runBotSells = 0;
    let mcEntered = false;
    let mcWatchStart = null;

    for (let i = 0; i < botTrades.length; i++) {
        const trade = botTrades[i];
        const curve = new BondingCurve();
        curve.virtualSolReserves = BigInt(trade.virtualSolReserves) + playerSolDelta;
        curve.virtualTokenReserves = BigInt(trade.virtualTokenReserves) - playerTokenDelta;
        curve.realSolReserves = BigInt(trade.realSolReserves) + playerSolDelta;
        curve.realTokenReserves = BigInt(trade.realTokenReserves) - playerTokenDelta;

        // Market cap floor: sell & exit if mcap drops below threshold
        if (config.mcapFloor > 0) {
            const mcapSol = Number(1_000_000_000_000_000n * curve.virtualSolReserves / curve.virtualTokenReserves) / 1e9;
            if (mcapSol < config.mcapFloor) {
                exitReason = 'MCAP'; exitTradeIndex = i;
                if (tokenBalance > 0n) {
                    solBalance += curve.executeSell(tokenBalance);
                    tokenBalance = 0n;
                }
                break;
            }
        }

        // momentumConfirmed: kill switch
        if (config.strategy === 'momentumConfirmed' && mcEntered && tokenBalance > 0n && config.killSwitch > 0) {
            const excess = runBotSells - runBotBuys;
            if (excess >= config.killSwitch) {
                exitReason = 'KILL'; exitTradeIndex = i;
                solBalance += curve.executeSell(tokenBalance);
                tokenBalance = 0n;
                break;
            }
        }

        // Price tracking for smartDipAccumulator
        if (config.strategy === 'smartDipAccumulator') {
            const currentPrice = Number(curve.virtualSolReserves) / Number(curve.virtualTokenReserves);
            priceHistory.push(currentPrice);
            if (priceHistory.length > config.momentumWindow) priceHistory.shift();
        }

        // Track consecutive sells and running bot counts
        if (trade.action === 'sell') { consecutiveSells++; runBotSells++; }
        else { consecutiveSells = 0; runBotBuys++; }

        // streakReversal: sell all on first bot buy after we hold tokens
        if (config.strategy === 'streakReversal'
            && trade.action === 'buy' && tokenBalance > 0n) {
            const vSolBefore = curve.virtualSolReserves;
            const vTokenBefore = curve.virtualTokenReserves;
            solBalance += curve.executeSell(tokenBalance);
            playerSolDelta += curve.virtualSolReserves - vSolBefore;
            playerTokenDelta += vTokenBefore - curve.virtualTokenReserves;
            tokenBalance = 0n;
            tradeCount++;
        }

        // smartDipAccumulator exit checks
        if (config.strategy === 'smartDipAccumulator' && tokenBalance > 0n) {
            const tokenValue = curve.getSolForTokens(tokenBalance);
            const portfolio = solBalance + tokenValue;
            const pnlPct = Number(portfolio - initialBudget) / Number(initialBudget) * 100;

            if (pnlPct > peakPnlPct) peakPnlPct = pnlPct;

            // Reversal exit
            if (config.reversalExitStreak > 0 && pnlPct > 0
                && consecutiveSells >= config.reversalExitStreak) {
                exitReason = 'REV'; exitTradeIndex = i;
                const vSolBefore = curve.virtualSolReserves;
                const vTokenBefore = curve.virtualTokenReserves;
                solBalance += curve.executeSell(tokenBalance);
                playerSolDelta += curve.virtualSolReserves - vSolBefore;
                playerTokenDelta += vTokenBefore - curve.virtualTokenReserves;
                tokenBalance = 0n;
                tradeCount++;
                break;
            }

            // Trailing stop
            if (peakPnlPct >= config.trailActivation) trailingActive = true;
            if (trailingActive) {
                const dynamicSL = peakPnlPct - config.trailDistance;
                if (pnlPct <= dynamicSL) {
                    exitReason = 'TRAIL'; exitTradeIndex = i;
                    const vSolBefore = curve.virtualSolReserves;
                    const vTokenBefore = curve.virtualTokenReserves;
                    solBalance += curve.executeSell(tokenBalance);
                    playerSolDelta += curve.virtualSolReserves - vSolBefore;
                    playerTokenDelta += vTokenBefore - curve.virtualTokenReserves;
                    tokenBalance = 0n;
                    tradeCount++;
                    break;
                }
            }
        }

        // Verbose tracking
        let vRoc = null, vRocPass = true;
        let vShare = null, vSharePass = true;
        let vScale = null, vBuyAmountSol = null;
        let vBought = false, vSkipReason = null;

        // momentumConfirmed: watch phase + gated entry
        if (config.strategy === 'momentumConfirmed') {
            if (!mcWatchStart) mcWatchStart = trade.blockTime;

            if (!mcEntered) {
                let shouldEnter = false;

                if (config.approach === 'A') {
                    if (runBotSells > 0) {
                        shouldEnter = (runBotBuys / runBotSells) >= config.entryRatio;
                    } else if (runBotBuys > 0) {
                        shouldEnter = true;
                    }
                } else if (config.approach === 'C') {
                    const totalBotTrades = runBotBuys + runBotSells;
                    const elapsed = trade.blockTime - mcWatchStart;
                    if (totalBotTrades >= 2 && elapsed > 0) {
                        const direction = runBotBuys - runBotSells;
                        const speed = totalBotTrades / elapsed;
                        const score = direction * speed;
                        shouldEnter = score >= config.scoreThreshold;
                        if (config.verbose) {
                            console.log(`       [WATCH] score=${score.toFixed(2)} (dir=${direction} spd=${speed.toFixed(2)}) ${shouldEnter ? 'ENTER' : 'wait'}`);
                        }
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
                        if (config.verbose) console.log(`  >>> ENTRY CONFIRMED: ${config.approach === 'A' ? `B/S=${(runBotBuys/runBotSells).toFixed(2)}` : `score>=${config.scoreThreshold}`} | bought ${(Number(buyAmount) / 1e9).toFixed(3)} SOL | ${runBotBuys}B/${runBotSells}S`);
                    }
                } else if (config.verbose && trade.action === 'sell') {
                    const ratioStr = runBotSells > 0 ? (runBotBuys / runBotSells).toFixed(2) : 'inf';
                    console.log(`       [WATCH] B/S=${ratioStr} | ${runBotBuys}B/${runBotSells}S | waiting...`);
                }
            } else if (config.maxBuys > 1 && tradeCount < config.maxBuys
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
        }

        // Buy when bot sells (with sellStreak + maxPositionPct)
        if (config.strategy !== 'momentumConfirmed'
            && trade.action === 'sell' && consecutiveSells >= config.sellStreak
            && solBalance >= tradeSizeLamports
            && (config.maxBuys === 0 || tradeCount < config.maxBuys)) {

            // SmartDipAccumulator entry filters
            let skipBuy = false;
            if (config.strategy === 'smartDipAccumulator') {
                // Momentum filter
                if (priceHistory.length >= config.momentumWindow) {
                    const oldPrice = priceHistory[0];
                    const currentPrice = priceHistory[priceHistory.length - 1];
                    const roc = (currentPrice - oldPrice) / oldPrice;
                    vRoc = roc;
                    if (roc < -config.momentumThreshold) {
                        skipBuy = true;
                        vRocPass = false;
                        vSkipReason = 'MOM';
                    }
                }
                // Impact check
                if (!skipBuy && tokenBalance > 0n && curve.realTokenReserves > 0n) {
                    const share = Number(tokenBalance) / Number(curve.realTokenReserves) * 100;
                    vShare = share;
                    if (share > config.maxImpactPct) {
                        skipBuy = true;
                        vSharePass = false;
                        vSkipReason = 'IMPACT';
                    }
                }
            }

            if (!skipBuy) {
                let buyAmount = tradeSizeLamports;

                // Adaptive sizing for smartDipAccumulator
                if (config.strategy === 'smartDipAccumulator') {
                    const realSolFloat = Number(curve.realSolReserves) / 1e9;
                    const scaleFactor = Math.min(1.0,
                        Math.max(config.minScaleFactor, realSolFloat / config.curveScaleThreshold));
                    vScale = scaleFactor;
                    buyAmount = BigInt(Math.floor(Number(tradeSizeLamports) * scaleFactor));
                }

                // Proportional sizing for proportionalDip
                if (config.strategy === 'proportionalDip') {
                    const realSolFloat = Number(curve.realSolReserves) / 1e9;
                    const scale = Math.min(config.maxScale, Math.max(config.minScale, realSolFloat / config.scaleThreshold));
                    vScale = scale;
                    buyAmount = BigInt(Math.floor(Number(tradeSizeLamports) * scale));
                }

                const maxSol = curve.realSolReserves * BigInt(config.maxPositionPct) / 100n;
                if (maxSol > 0n && buyAmount > maxSol) buyAmount = maxSol;
                if (buyAmount > solBalance) buyAmount = solBalance;
                vBuyAmountSol = Number(buyAmount) / 1e9;
                const vSolBefore = curve.virtualSolReserves;
                const vTokenBefore = curve.virtualTokenReserves;
                const tokensReceived = curve.executeBuy(buyAmount);
                playerSolDelta += curve.virtualSolReserves - vSolBefore;
                playerTokenDelta += vTokenBefore - curve.virtualTokenReserves;
                tokenBalance += tokensReceived;
                solBalance -= buyAmount;
                tradeCount++;
                vBought = true;
            }
        }

        const tokenValue = tokenBalance > 0n ? curve.getSolForTokens(tokenBalance) : 0n;
        const portfolio = solBalance + tokenValue;
        const pnlPct = Number(portfolio - initialBudget) / Number(initialBudget) * 100;

        // Verbose logging for replay mode
        if (config.verbose) {
            const action = trade.action.toUpperCase().padEnd(4);
            const pnlStr = formatSign(pnlPct);
            const solStr = (Number(trade.solAmount) / 1e9).toFixed(4);
            console.log(`  [${i + 1}] Bot ${action} ${solStr} SOL | Player: ${tradeCount} buys, P&L: ${pnlStr}% | ${runBotBuys}B/${runBotSells}S`);

            if (config.strategy === 'smartDipAccumulator') {
                if (trade.action === 'sell') {
                    const rocStr = vRoc !== null ? `roc=${vRoc.toFixed(2)} ${vRocPass ? 'PASS' : 'SKIP'}` : 'roc=n/a';
                    const shareStr = vShare !== null ? `impact=${vShare.toFixed(1)}% ${vSharePass ? 'PASS' : 'SKIP'}` : 'impact=n/a';
                    const sizeStr = vBought ? `scale=${(vScale ?? 1).toFixed(2)} buy=${vBuyAmountSol.toFixed(3)} SOL` : (vSkipReason ? `SKIPPED(${vSkipReason})` : 'no-buy');
                    console.log(`       ${rocStr} | ${shareStr} | ${sizeStr} | realSOL=${(Number(curve.realSolReserves) / 1e9).toFixed(2)}`);
                }
                const dynSL = trailingActive ? peakPnlPct - config.trailDistance : null;
                console.log(`       trail: peak=${formatSign(peakPnlPct)}% active=${trailingActive ? 'yes' : 'no'}${trailingActive ? ` dynSL=${formatSign(dynSL)}%` : ''} | sells=${consecutiveSells}/${config.reversalExitStreak}`);
            }

            if (config.strategy === 'proportionalDip') {
                if (trade.action === 'sell') {
                    const sizeStr = vBought ? `scale=${(vScale ?? 1).toFixed(2)} buy=${vBuyAmountSol.toFixed(3)} SOL` : 'no-buy';
                    console.log(`       ${sizeStr} | realSOL=${(Number(curve.realSolReserves) / 1e9).toFixed(2)}`);
                }
            }

            if (config.strategy === 'momentumConfirmed') {
                const ratioStr = runBotSells > 0 ? (runBotBuys / runBotSells).toFixed(2) : 'inf';
                const excess = runBotSells - runBotBuys;
                console.log(`       [MC] entered=${mcEntered} B/S=${ratioStr} excess=${excess} | ${runBotBuys}B/${runBotSells}S`);
            }
        }

        if (pnlPct >= config.takeProfit) {
            exitReason = 'TP'; exitTradeIndex = i;
            if (tokenBalance > 0n) {
                solBalance += curve.executeSell(tokenBalance);
                tokenBalance = 0n;
            }
            break;
        }
        if (pnlPct <= -config.stopLoss) {
            exitReason = 'SL'; exitTradeIndex = i;
            if (tokenBalance > 0n) {
                solBalance += curve.executeSell(tokenBalance);
                tokenBalance = 0n;
            }
            break;
        }
    }

    if (tokenBalance > 0n && botTrades.length > 0) {
        const last = botTrades[botTrades.length - 1];
        const curve = new BondingCurve();
        curve.virtualSolReserves = BigInt(last.virtualSolReserves) + playerSolDelta;
        curve.virtualTokenReserves = BigInt(last.virtualTokenReserves) - playerTokenDelta;
        curve.realSolReserves = BigInt(last.realSolReserves) + playerSolDelta;
        curve.realTokenReserves = BigInt(last.realTokenReserves) - playerTokenDelta;
        solBalance += curve.executeSell(tokenBalance);
        tokenBalance = 0n;
    }

    const botBuys = botTrades.filter(t => t.action === 'buy').length;
    const botSells = botTrades.filter(t => t.action === 'sell').length;
    const firstTime = botTrades[0].blockTime;
    const lastTime = botTrades[exitTradeIndex]?.blockTime || botTrades[botTrades.length - 1].blockTime;

    return {
        pnlPct: Number(solBalance - initialBudget) / Number(initialBudget) * 100,
        pnlSol: Number(solBalance - initialBudget) / 1e9,
        tradeCount,
        totalInvested: tradeCount * config.tradeSize,
        botBuys, botSells, exitReason,
        durationSec: lastTime - firstTime,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// Output
// ═══════════════════════════════════════════════════════════════════════════

function printResult(r, config) {
    console.log(`\n${'═'.repeat(90)}`);
    console.log(`RESULT — ${config.strategy}`);
    console.log(`${'═'.repeat(90)}`);
    console.log(`Mint:       ${r.mint}`);
    console.log(`P&L:        ${formatSign(r.pnlPct)}% (${formatSign(r.pnlSol, 4)} SOL)`);
    console.log(`Trades:     ${r.tradeCount} buys | Total invested: ${r.totalInvested.toFixed(2)} SOL`);
    console.log(`Bot:        ${r.botBuys} buys / ${r.botSells} sells`);
    console.log(`Exit:       ${r.exitReason} | Duration: ${formatDuration(r.durationSec)}`);
    console.log(`Config:     strategy=${config.strategy} budget=${config.budget} tradeSize=${config.tradeSize} TP=${config.takeProfit}% SL=${config.stopLoss}%${config.sellStreak > 1 ? ` sellStreak=${config.sellStreak}` : ''}${config.maxPositionPct < 100 ? ` maxPos=${config.maxPositionPct}%` : ''}`);
    if (config.strategy === 'smartDipAccumulator') {
        console.log(`Smart:      momW=${config.momentumWindow} momT=${config.momentumThreshold} impact=${config.maxImpactPct}% crvS=${config.curveScaleThreshold} minS=${config.minScaleFactor} trlA=${config.trailActivation} trlD=${config.trailDistance} revS=${config.reversalExitStreak}`);
    }
    if (config.strategy === 'proportionalDip') {
        console.log(`Proportional: scaleThreshold=${config.scaleThreshold} minScale=${config.minScale} maxScale=${config.maxScale}`);
    }
    if (config.strategy === 'momentumConfirmed') {
        console.log(`Momentum:   approach=${config.approach} entryRatio=${config.entryRatio} scoreThreshold=${config.scoreThreshold} killSwitch=${config.killSwitch}`);
    }
    console.log(`${'═'.repeat(90)}`);
}

function printSummary(results, config) {
    if (results.length === 0) return;

    console.log(`\n${'═'.repeat(110)}`);
    console.log(`CUMULATIVE SUMMARY — ${results.length} tokens — ${config.strategy}`);
    console.log(`${'═'.repeat(110)}`);
    console.log(`Budget: ${config.budget} SOL | Trade size: ${config.tradeSize} SOL | TP: ${config.takeProfit}% | SL: ${config.stopLoss}%${config.sellStreak > 1 ? ` | Streak: ${config.sellStreak}` : ''}${config.maxPositionPct < 100 ? ` | MaxPos: ${config.maxPositionPct}%` : ''}`);
    console.log(`${'─'.repeat(110)}`);

    const header = [
        'CA'.padEnd(44), 'P&L %'.padStart(8), 'P&L SOL'.padStart(9),
        'Trades'.padStart(6), 'Size'.padStart(7), 'Buys/Sells'.padStart(10),
        'Exit'.padStart(4), 'Duration'.padStart(10),
    ].join(' | ');
    console.log(header);
    console.log(`${'─'.repeat(110)}`);

    for (const r of [...results].sort((a, b) => b.pnlPct - a.pnlPct)) {
        console.log([
            r.mint.padEnd(44), formatSign(r.pnlPct).padStart(8),
            formatSign(r.pnlSol, 4).padStart(9), String(r.tradeCount).padStart(6),
            r.totalInvested.toFixed(2).padStart(7), `${r.botBuys}/${r.botSells}`.padStart(10),
            r.exitReason.padStart(4), formatDuration(r.durationSec).padStart(10),
        ].join(' | '));
    }

    const wins = results.filter(r => r.pnlPct > 0).length;
    const pnlValues = results.map(r => r.pnlPct).sort((a, b) => a - b);
    const meanPnl = results.reduce((s, r) => s + r.pnlPct, 0) / results.length;
    const medianPnl = pnlValues[Math.floor(pnlValues.length / 2)];
    const totalPnlSol = results.reduce((s, r) => s + r.pnlSol, 0);

    console.log(`${'═'.repeat(110)}`);
    console.log(`Total: ${results.length} | Win Rate: ${(wins / results.length * 100).toFixed(1)}% (${wins}/${results.length}) | Mean: ${formatSign(meanPnl)}% | Median: ${formatSign(medianPnl)}%`);
    console.log(`Total P&L: ${formatSign(totalPnlSol, 4)} SOL | Best: ${formatSign(pnlValues[pnlValues.length - 1])}% | Worst: ${formatSign(pnlValues[0])}%`);
    console.log(`Exits: TP=${results.filter(r => r.exitReason === 'TP').length} SL=${results.filter(r => r.exitReason === 'SL').length} MCAP=${results.filter(r => r.exitReason === 'MCAP').length} TRAIL=${results.filter(r => r.exitReason === 'TRAIL').length} REV=${results.filter(r => r.exitReason === 'REV').length} KILL=${results.filter(r => r.exitReason === 'KILL').length} END=${results.filter(r => r.exitReason === 'END').length}`);
    const totalInvested = results.length * config.budget;
    console.log(`ROI on capital: ${formatSign(totalPnlSol / totalInvested * 100)}% (${totalInvested.toFixed(1)} SOL deployed across ${results.length} tokens)`);
    console.log(`${'═'.repeat(110)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Save results to JSONL
// ═══════════════════════════════════════════════════════════════════════════

function appendResult(savePath, result, config) {
    const dir = path.dirname(savePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const line = JSON.stringify({
        mint: result.mint,
        pnlPct: +result.pnlPct.toFixed(2),
        pnlSol: +result.pnlSol.toFixed(6),
        tradeCount: result.tradeCount,
        exitReason: result.exitReason,
        botBuys: result.botBuys,
        botSells: result.botSells,
        durationSec: result.durationSec,
        config: {
            strategy: config.strategy, budget: config.budget, tradeSize: config.tradeSize,
            takeProfit: config.takeProfit, stopLoss: config.stopLoss, maxBuys: config.maxBuys,
            sellStreak: config.sellStreak, maxPositionPct: config.maxPositionPct,
            ...(config.strategy === 'smartDipAccumulator' ? {
                momentumWindow: config.momentumWindow, momentumThreshold: config.momentumThreshold,
                maxImpactPct: config.maxImpactPct, curveScaleThreshold: config.curveScaleThreshold,
                minScaleFactor: config.minScaleFactor, trailActivation: config.trailActivation,
                trailDistance: config.trailDistance, reversalExitStreak: config.reversalExitStreak,
            } : {}),
            ...(config.strategy === 'proportionalDip' ? {
                scaleThreshold: config.scaleThreshold, minScale: config.minScale, maxScale: config.maxScale,
            } : {}),
            ...(config.strategy === 'momentumConfirmed' ? {
                approach: config.approach, entryRatio: config.entryRatio,
                scoreThreshold: config.scoreThreshold, killSwitch: config.killSwitch,
            } : {}),
        },
        timestamp: new Date().toISOString(),
    });
    fs.appendFileSync(savePath, line + '\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
    const config = parseArgs();
    const log = !config.json;

    if (log) {
        console.log(`\n${'═'.repeat(70)}`);
        console.log(`MAINNET BACKTEST — ${config.strategy} Strategy`);
        console.log(`${'═'.repeat(70)}`);
        console.log(`Budget: ${config.budget} SOL | Trade size: ${config.tradeSize} SOL`);
        console.log(`Take profit: ${config.takeProfit}% | Stop loss: ${config.stopLoss}%`);
        if (config.maxBuys > 0) console.log(`Max buys: ${config.maxBuys}`);
        if (config.sellStreak > 1) console.log(`Sell streak: ${config.sellStreak}`);
        if (config.maxPositionPct < 100) console.log(`Max position: ${config.maxPositionPct}%`);
        if (config.strategy === 'smartDipAccumulator') {
            console.log(`Smart params: momW=${config.momentumWindow} momT=${config.momentumThreshold} impact=${config.maxImpactPct}% crvS=${config.curveScaleThreshold} minS=${config.minScaleFactor}`);
            console.log(`              trlA=${config.trailActivation} trlD=${config.trailDistance} revS=${config.reversalExitStreak}`);
        }
        if (config.strategy === 'proportionalDip') {
            console.log(`Proportional: scaleThreshold=${config.scaleThreshold} minScale=${config.minScale} maxScale=${config.maxScale}`);
        }
        if (config.strategy === 'momentumConfirmed') {
            console.log(`Momentum:   approach=${config.approach} entryRatio=${config.entryRatio} scoreThreshold=${config.scoreThreshold} killSwitch=${config.killSwitch}`);
        }
        if (config.wallet !== null) console.log(`Wallet: ${config.wallet} SOL (running balance)`);
        if (config.verbose) console.log(`Verbose: ON`);
        if (config.save) console.log(`Save: ${config.save}`);
        console.log(`Mode: ${config.mint ? 'single mint' : 'live (streaming)'}`);
        console.log();
    }

    const allResults = [];

    if (config.mint) {
        // Historical mode: fetch and replay
        if (log) console.log(`Fetching trades for ${config.mint}...`);
        const trades = await fetchTradesForMint(config.mint, log);

        if (trades.length < 2) {
            console.log(`  Not enough bot trades (${trades.length}).`);
            process.exit(0);
        }

        const result = replayToken(trades, config);
        const fullResult = { mint: config.mint, ...result };
        allResults.push(fullResult);
        if (config.save) appendResult(config.save, fullResult, config);

        if (config.json) {
            console.log(JSON.stringify(fullResult, null, 2));
        } else {
            printResult(fullResult, config);
        }
    } else {
        // Live mode: detect new tokens, stream trades, simulate in real-time
        const runningWallet = config.wallet !== null;
        const perTokenBudget = BigInt(Math.floor(config.budget * 1e9));
        let wallet = runningWallet ? BigInt(Math.floor(config.wallet * 1e9)) : null;
        const tradeSizeLamports = BigInt(Math.floor(config.tradeSize * 1e9));

        if (log) {
            if (runningWallet) console.log(`Wallet mode: ${config.wallet} SOL (running balance)\n`);
            console.log(`Press Ctrl+C to stop and show cumulative summary.\n`);
        }

        process.on('SIGINT', () => {
            if (log) {
                printSummary(allResults, config);
                if (runningWallet) console.log(`Final wallet: ${(Number(wallet) / 1e9).toFixed(4)} SOL`);
            }
            process.exit(0);
        });

        while (true) {
            // In wallet mode, check if we can still afford a trade
            if (runningWallet) {
                if (wallet < tradeSizeLamports) {
                    if (log) console.log(`\n  Wallet depleted (${(Number(wallet) / 1e9).toFixed(4)} SOL < ${config.tradeSize} SOL trade size). Stopping.`);
                    break;
                }
                // Per-token budget is capped at config.budget or remaining wallet, whichever is smaller
                const tokenBudget = wallet < perTokenBudget ? wallet : perTokenBudget;

                const mintAddress = await waitForNewMint(log);
                const result = await streamAndSimulate(mintAddress, config, log, tokenBudget);
                // Update wallet: subtract what was allocated, add back what was returned
                wallet = wallet - tokenBudget + result.finalBalance;
                allResults.push(result);
                if (config.save) appendResult(config.save, result, config);
            } else {
                const mintAddress = await waitForNewMint(log);
                const result = await streamAndSimulate(mintAddress, config, log, perTokenBudget);
                allResults.push(result);
                if (config.save) appendResult(config.save, result, config);
            }

            const result = allResults[allResults.length - 1];

            if (config.json) {
                console.log(JSON.stringify(result));
            } else {
                printResult(result, config);
                if (runningWallet) console.log(`  Wallet: ${(Number(wallet) / 1e9).toFixed(4)} SOL`);
                if (allResults.length > 1) {
                    printSummary(allResults, config);
                    if (runningWallet) console.log(`Final wallet: ${(Number(wallet) / 1e9).toFixed(4)} SOL`);
                }
            }
        }

        // Wallet depleted — print final summary
        if (runningWallet && log) {
            printSummary(allResults, config);
            console.log(`Final wallet: ${(Number(wallet) / 1e9).toFixed(4)} SOL`);
        }
    }
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
