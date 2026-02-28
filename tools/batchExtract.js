#!/usr/bin/env node

/**
 * batchExtract.js — Extract trade data from completed Mayhem tokens.
 *
 * Fetches recent bot transactions, groups by mint, saves each as a dataset.
 * Much faster than live collection since tokens are already completed.
 *
 * Usage:
 *   node tools/batchExtract.js              # extract recent tokens
 *   node tools/batchExtract.js --count=20   # stop after 20 tokens
 */

import { connection } from "../utils/rpc.js";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "fs";
import path from "path";
import { decodeMayhemTradeEvent } from "../decoders/decodeMayhemTradeEvent.js";
import { MAYHEM_TRADING_WALLET } from "../utils/constants.js";

const args = process.argv.slice(2);
let maxTokens = 10;
for (const arg of args) {
    if (arg.startsWith('--count=')) maxTokens = parseInt(arg.split('=')[1]);
}

const outDir = new URL('../analysis/tokens', import.meta.url).pathname;
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// Skip mints that already have data files
const existingFiles = fs.readdirSync(outDir).filter(f => f.endsWith('.json'));
const existingMints = new Set();
for (const f of existingFiles) {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
        if (data.mint) existingMints.add(data.mint);
    } catch {}
}
if (existingMints.size > 0) {
    console.log(`Skipping ${existingMints.size} already-extracted mints.`);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
                    solAmount: decoded.solAmount.toString(),
                    tokenAmount: decoded.tokenAmount.toString(),
                    virtualSolReserves: decoded.virtualSolReserves.toString(),
                    virtualTokenReserves: decoded.virtualTokenReserves.toString(),
                    realSolReserves: decoded.realSolReserves.toString(),
                    realTokenReserves: decoded.realTokenReserves.toString(),
                };
            }
        } catch {}
    }
    return null;
}

console.log(`Extracting trade data for up to ${maxTokens} completed tokens...`);
console.log(`Output: ${outDir}/\n`);

// Phase 1: Fetch all recent signatures from the trading wallet
const allSignatures = [];
let before = undefined;
const SIG_BATCH = 1000;
const TARGET_SIGS = 5000; // enough for ~50 tokens (50 trades each * 2 sigs/trade)

console.log(`Fetching signatures from trading wallet...`);
while (allSignatures.length < TARGET_SIGS) {
    const opts = { limit: SIG_BATCH };
    if (before) opts.before = before;

    const sigs = await connection.getSignaturesForAddress(
        new PublicKey(MAYHEM_TRADING_WALLET), opts, 'confirmed'
    );
    if (sigs.length === 0) break;
    allSignatures.push(...sigs);
    before = sigs[sigs.length - 1].signature;
    console.log(`  ${allSignatures.length} signatures fetched...`);
    await sleep(300);
}

console.log(`Total signatures: ${allSignatures.length}`);

// Phase 2: Decode each transaction and group by mint
const tradesByMint = new Map();
let processed = 0;
let decoded = 0;

for (const sigInfo of allSignatures) {
    if (sigInfo.err) continue;

    try {
        const tx = await connection.getParsedTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0, commitment: 'confirmed',
        });
        if (!tx) continue;

        const trade = decodeBotTrade(tx);
        if (trade) {
            if (existingMints.has(trade.mint)) continue;
            if (!tradesByMint.has(trade.mint)) tradesByMint.set(trade.mint, []);
            tradesByMint.get(trade.mint).push(trade);
            decoded++;
        }
    } catch {}

    processed++;
    if (processed % 50 === 0) {
        process.stdout.write(`\r  Processed ${processed}/${allSignatures.length} txs, ${decoded} trades across ${tradesByMint.size} mints`);
    }

    // Rate limit
    await sleep(250);

    // Early stop if we have enough mints
    if (tradesByMint.size >= maxTokens + 5) {
        // Keep going a bit to get full trade sets
        const completeLooking = [...tradesByMint.values()].filter(t => t.length >= 40).length;
        if (completeLooking >= maxTokens) break;
    }
}

console.log(`\n\nDecoded ${decoded} trades across ${tradesByMint.size} mints.`);

// Phase 3: Save complete datasets (>= 10 trades)
let saved = 0;
const results = [];

for (const [mint, trades] of tradesByMint) {
    if (trades.length < 10) continue;
    if (saved >= maxTokens) break;

    trades.sort((a, b) => a.slot - b.slot);
    const buys = trades.filter(t => t.action === 'buy').length;
    const sells = trades.length - buys;

    const dataset = {
        mint,
        extractedAt: new Date().toISOString(),
        totalTrades: trades.length,
        metrics: { buyCount: buys, sellCount: sells },
        trades,
    };

    const filename = `${mint.slice(0, 12)}_${trades.length}t.json`;
    fs.writeFileSync(path.join(outDir, filename), JSON.stringify(dataset, null, 2));
    saved++;
    results.push({ mint: mint.slice(0, 12), trades: trades.length, buys, sells, buyPct: (buys/trades.length*100).toFixed(0) });
    console.log(`  Saved ${filename} (${buys}B/${sells}S) [${saved}/${maxTokens}]`);
}

console.log(`\nDone. Saved ${saved} token datasets.`);
console.log(`\nSummary:`);
console.log(`${'Mint'.padEnd(14)} ${'Trades'.padStart(6)} ${'Buys'.padStart(5)} ${'Sells'.padStart(5)} ${'Buy%'.padStart(5)}`);
for (const r of results) {
    console.log(`${r.mint.padEnd(14)} ${String(r.trades).padStart(6)} ${String(r.buys).padStart(5)} ${String(r.sells).padStart(5)} ${(r.buyPct + '%').padStart(5)}`);
}
