#!/usr/bin/env node

/**
 * extractChronologicalTrades.js — Extract ALL bot trades in strict chronological order.
 *
 * Unlike batchExtract.js which groups by mint, this saves trades in slot order
 * across all tokens. This is essential for PRNG analysis: we need to see the
 * exact interleaving pattern to find consecutive PRNG outputs.
 *
 * Usage:
 *   node tools/extractChronologicalTrades.js                    # default 5000 trades
 *   node tools/extractChronologicalTrades.js --target=10000     # 10k trades
 *   node tools/extractChronologicalTrades.js --resume           # continue from last saved position
 *   node tools/extractChronologicalTrades.js --analyze          # just analyze existing data
 *
 * Output:
 *   analysis/chronological_trades.json — all trades in slot order
 */

import { connection } from "../utils/rpc.js";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "fs";
import path from "path";
import { decodeMayhemTradeEvent } from "../decoders/decodeMayhemTradeEvent.js";
import { MAYHEM_TRADING_WALLET } from "../utils/constants.js";

const args = process.argv.slice(2);
const targetTrades = parseInt(args.find(a => a.startsWith('--target='))?.split('=')[1] || '5000');
const resumeMode = args.includes('--resume');
const analyzeOnly = args.includes('--analyze');

const OUT_FILE = path.join(import.meta.dirname, '..', 'analysis', 'chronological_trades.json');
const RATE_LIMIT_MS = 200;  // 5 RPS — safe for Helius

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
                    signature: tx.transaction.signatures[0],
                    mint: decoded.mint,
                    action: decoded.actionType === 0 ? 'buy' : 'sell',
                    bit: decoded.actionType === 0 ? 0 : 1,
                    solAmount: decoded.solAmount.toString(),
                    realSolReserves: decoded.realSolReserves.toString(),
                };
            }
        } catch {}
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Extraction
// ═══════════════════════════════════════════════════════════════════════════

async function extractTrades() {
    let existingTrades = [];
    let lastSignature = undefined;

    if (resumeMode && fs.existsSync(OUT_FILE)) {
        const data = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
        existingTrades = data.trades || [];
        // Resume from the oldest signature we have (since getSignaturesForAddress goes backward)
        if (existingTrades.length > 0) {
            lastSignature = existingTrades[existingTrades.length - 1].signature;
            console.log(`Resuming from ${existingTrades.length} existing trades (oldest slot: ${existingTrades[existingTrades.length - 1].slot})`);
        }
    }

    const allTrades = [...existingTrades];
    const seenSigs = new Set(allTrades.map(t => t.signature));

    console.log(`Target: ${targetTrades} total trades`);
    console.log(`Fetching signatures from ${MAYHEM_TRADING_WALLET}...\n`);

    // Phase 1: Fetch all signatures (paginated, going backward in time)
    const allSignatures = [];
    let before = lastSignature;
    const SIG_BATCH = 1000;

    // We need roughly targetTrades signatures (not all sigs are successful trades)
    const targetSigs = Math.ceil(targetTrades * 1.2); // 20% buffer for failed txs

    while (allSignatures.length < targetSigs) {
        const opts = { limit: SIG_BATCH };
        if (before) opts.before = before;

        try {
            const sigs = await connection.getSignaturesForAddress(
                new PublicKey(MAYHEM_TRADING_WALLET), opts, 'confirmed'
            );
            if (sigs.length === 0) {
                console.log('No more signatures available.');
                break;
            }
            allSignatures.push(...sigs);
            before = sigs[sigs.length - 1].signature;
            console.log(`  ${allSignatures.length} signatures fetched...`);
            await sleep(RATE_LIMIT_MS);
        } catch (err) {
            console.error(`  Error fetching sigs: ${err.message}. Retrying in 2s...`);
            await sleep(2000);
        }
    }

    console.log(`\nTotal new signatures to process: ${allSignatures.length}`);

    // Phase 2: Decode each transaction
    let processed = 0;
    let decoded = 0;
    let errors = 0;
    const startTime = Date.now();

    for (const sigInfo of allSignatures) {
        if (sigInfo.err) { processed++; continue; }
        if (seenSigs.has(sigInfo.signature)) { processed++; continue; }

        try {
            const tx = await connection.getParsedTransaction(sigInfo.signature, {
                maxSupportedTransactionVersion: 0, commitment: 'confirmed',
            });
            if (!tx) { processed++; continue; }

            const trade = decodeBotTrade(tx);
            if (trade) {
                allTrades.push(trade);
                decoded++;
            }
        } catch (err) {
            errors++;
            if (errors % 10 === 0) console.log(`  ${errors} errors so far`);
        }

        processed++;
        if (processed % 25 === 0) {
            const elapsed = (Date.now() - startTime) / 1000;
            const rate = processed / elapsed;
            const eta = ((allSignatures.length - processed) / rate).toFixed(0);
            process.stdout.write(
                `\r  ${processed}/${allSignatures.length} txs | ${decoded} trades decoded | ${rate.toFixed(1)} tx/s | ETA ${eta}s    `
            );
        }

        // Save progress every 500 trades
        if (decoded > 0 && decoded % 500 === 0) {
            saveData(allTrades);
        }

        await sleep(RATE_LIMIT_MS);

        if (allTrades.length >= targetTrades + existingTrades.length) {
            console.log(`\nReached target of ${targetTrades} new trades.`);
            break;
        }
    }

    // Sort by slot (chronological)
    allTrades.sort((a, b) => a.slot - b.slot);

    saveData(allTrades);
    console.log(`\n\nExtraction complete.`);
    console.log(`Total trades: ${allTrades.length}`);
    console.log(`Date range: ${new Date(allTrades[0].blockTime * 1000).toISOString()} → ${new Date(allTrades[allTrades.length - 1].blockTime * 1000).toISOString()}`);

    return allTrades;
}

function saveData(trades) {
    const sorted = [...trades].sort((a, b) => a.slot - b.slot);
    const data = {
        extractedAt: new Date().toISOString(),
        totalTrades: sorted.length,
        trades: sorted,
    };
    fs.writeFileSync(OUT_FILE, JSON.stringify(data, null, 2));
    console.log(`\n  [Saved ${sorted.length} trades to ${OUT_FILE}]`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Analysis — Find non-overlapping windows
// ═══════════════════════════════════════════════════════════════════════════

function analyzeTrades(trades) {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(' INTERLEAVING ANALYSIS');
    console.log('═══════════════════════════════════════════════════════════════\n');

    console.log(`Total trades: ${trades.length}`);
    const mints = new Set(trades.map(t => t.mint));
    console.log(`Unique tokens: ${mints.size}`);

    // Identify active tokens at each trade
    // A token is "active" from its first trade to its last trade
    const tokenSessions = new Map();
    for (const trade of trades) {
        if (!tokenSessions.has(trade.mint)) {
            tokenSessions.set(trade.mint, { first: trade.slot, last: trade.slot, trades: 0 });
        }
        const session = tokenSessions.get(trade.mint);
        session.last = Math.max(session.last, trade.slot);
        session.trades++;
    }

    // For each trade, count how many tokens are active simultaneously
    const sessions = [...tokenSessions.values()].sort((a, b) => a.first - b.first);

    // Find non-overlapping windows (where only 1 token is active)
    const nonOverlapping = [];
    let currentWindow = null;
    let currentMint = null;

    for (let i = 0; i < trades.length; i++) {
        const trade = trades[i];

        // Count how many token sessions are active at this slot
        let activeCount = 0;
        for (const [mint, session] of tokenSessions) {
            if (trade.slot >= session.first && trade.slot <= session.last) {
                activeCount++;
            }
        }

        if (activeCount === 1) {
            if (!currentWindow || trade.mint !== currentMint) {
                if (currentWindow && currentWindow.trades.length >= 5) {
                    nonOverlapping.push(currentWindow);
                }
                currentWindow = { mint: trade.mint, trades: [], startSlot: trade.slot };
                currentMint = trade.mint;
            }
            currentWindow.trades.push(trade);
            currentWindow.endSlot = trade.slot;
        } else {
            if (currentWindow && currentWindow.trades.length >= 5) {
                nonOverlapping.push(currentWindow);
            }
            currentWindow = null;
            currentMint = null;
        }
    }
    if (currentWindow && currentWindow.trades.length >= 5) {
        nonOverlapping.push(currentWindow);
    }

    console.log(`\n─── Non-Overlapping Windows (1 token active, >= 5 trades) ───\n`);
    if (nonOverlapping.length === 0) {
        console.log('  NO non-overlapping windows found!');
        console.log('  The bot always has multiple tokens active simultaneously.');
        console.log('  This makes consecutive PRNG output extraction impossible from this data.');
    } else {
        let totalConsecutive = 0;
        for (const w of nonOverlapping) {
            const bits = w.trades.map(t => t.bit === 0 ? 'B' : 'S').join('');
            console.log(`  ${w.mint.slice(0, 12)} | ${w.trades.length} trades | slots ${w.startSlot}-${w.endSlot} | ${bits}`);
            totalConsecutive += w.trades.length;
        }
        console.log(`\n  Total non-overlapping windows: ${nonOverlapping.length}`);
        console.log(`  Total consecutive trades: ${totalConsecutive}`);
        console.log(`  Longest window: ${Math.max(...nonOverlapping.map(w => w.trades.length))} trades`);
    }

    // Also analyze: concurrent token count distribution
    console.log('\n─── Concurrency Distribution ───\n');
    const concurrencyAtEachTrade = [];
    for (const trade of trades) {
        let active = 0;
        for (const [, session] of tokenSessions) {
            if (trade.slot >= session.first && trade.slot <= session.last) active++;
        }
        concurrencyAtEachTrade.push(active);
    }

    const concDist = {};
    for (const c of concurrencyAtEachTrade) {
        concDist[c] = (concDist[c] || 0) + 1;
    }
    for (const [conc, count] of Object.entries(concDist).sort((a, b) => Number(a[0]) - Number(b[0]))) {
        const pct = (count / trades.length * 100).toFixed(1);
        const bar = '█'.repeat(Math.round(count / trades.length * 40));
        console.log(`  ${conc} tokens active: ${String(count).padStart(5)} trades (${pct}%) ${bar}`);
    }

    // Full sequence analysis
    console.log('\n─── Full Chronological Sequence Stats ───\n');
    const fullBits = trades.map(t => t.bit);
    const buys = fullBits.filter(b => b === 0).length;
    console.log(`  Buys:  ${buys} (${(buys / fullBits.length * 100).toFixed(1)}%)`);
    console.log(`  Sells: ${fullBits.length - buys} (${((fullBits.length - buys) / fullBits.length * 100).toFixed(1)}%)`);

    // Transitions
    let transitions = { '0→0': 0, '0→1': 0, '1→0': 0, '1→1': 0 };
    for (let i = 0; i < fullBits.length - 1; i++) {
        transitions[`${fullBits[i]}→${fullBits[i + 1]}`]++;
    }
    const t01 = transitions['0→0'] + transitions['0→1'];
    const t10 = transitions['1→0'] + transitions['1→1'];
    console.log(`  After BUY:  → BUY ${(transitions['0→0']/t01*100).toFixed(1)}%  → SELL ${(transitions['0→1']/t01*100).toFixed(1)}%`);
    console.log(`  After SELL: → BUY ${(transitions['1→0']/t10*100).toFixed(1)}%  → SELL ${(transitions['1→1']/t10*100).toFixed(1)}%`);

    // Per-token sequential analysis (within each token, transitions)
    console.log('\n─── Per-Token Sequential Analysis ───\n');
    const perTokenStats = [];
    for (const [mint, session] of tokenSessions) {
        const tokenTrades = trades.filter(t => t.mint === mint);
        tokenTrades.sort((a, b) => a.slot - b.slot);
        const bits = tokenTrades.map(t => t.bit);

        let alt = 0, same = 0;
        for (let i = 0; i < bits.length - 1; i++) {
            if (bits[i] !== bits[i + 1]) alt++;
            else same++;
        }
        const altPct = bits.length > 1 ? alt / (alt + same) * 100 : 0;
        perTokenStats.push({ mint: mint.slice(0, 12), trades: bits.length, altPct });
    }

    const avgAlt = perTokenStats.reduce((s, t) => s + t.altPct, 0) / perTokenStats.length;
    console.log(`  Average alternation rate (per token): ${avgAlt.toFixed(1)}% (random expectation: 50%)`);
    console.log(`  Min: ${Math.min(...perTokenStats.map(t => t.altPct)).toFixed(1)}%`);
    console.log(`  Max: ${Math.max(...perTokenStats.map(t => t.altPct)).toFixed(1)}%`);

    return nonOverlapping;
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

if (analyzeOnly) {
    if (!fs.existsSync(OUT_FILE)) {
        console.error('No data file found. Run without --analyze first.');
        process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    analyzeTrades(data.trades);
} else {
    const trades = await extractTrades();
    analyzeTrades(trades);
}
