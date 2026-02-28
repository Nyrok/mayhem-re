#!/usr/bin/env node

/**
 * collectTokenData.js — Live data collector for Mayhem tokens.
 *
 * Listens for new tokens, records all bot trades, saves to analysis/tokens/.
 * Each token gets its own JSON file compatible with offlineSweep.js.
 *
 * Usage:
 *   node tools/collectTokenData.js              # collect continuously
 *   node tools/collectTokenData.js --count=10   # stop after 10 tokens
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

const rpcQueue = (() => {
    let pending = Promise.resolve();
    const MIN_GAP_MS = 250;
    return (fn) => {
        pending = pending.then(() => fn()).then(result =>
            new Promise(resolve => setTimeout(() => resolve(result), MIN_GAP_MS))
        );
        return pending;
    };
})();

async function fetchTxWithRetry(signature, maxRetries = 5) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const tx = await rpcQueue(() =>
            connection.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 0, commitment: 'confirmed',
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

function waitForNewMint() {
    return new Promise((resolve) => {
        console.log(`\nListening for new Mayhem token...`);
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
                    console.log(`  New token: ${mintAddress}`);
                    resolve(mintAddress);
                } catch (e) {
                    if (e.message) console.log(`  (detection error: ${e.message})`);
                }
            },
            'processed'
        );
    });
}

function collectTrades(mintAddress) {
    return new Promise((resolve) => {
        const MAX_TIMEOUT_MS = 180_000; // 3 min hard cap
        const POLL_INTERVAL_MS = 5_000;
        const INACTIVITY_MS = 15_000;
        const trades = [];
        let done = false;
        let logsId = null;
        let lastTradeTime = Date.now();
        const processed = new Set();

        const [statePDA] = PublicKey.findProgramAddressSync(
            [Buffer.from("mayhem-state"), new PublicKey(mintAddress).toBuffer()],
            new PublicKey(MAYHEM_PROGRAM_ID)
        );

        function finish() {
            if (done) return;
            done = true;
            clearInterval(pollId);
            clearTimeout(hardTimeout);
            if (logsId != null) {
                connection.removeOnLogsListener(logsId).catch(() => {});
            }
            trades.sort((a, b) => a.slot - b.slot);
            resolve(trades);
        }

        async function checkIsRunning() {
            if (done) return;
            // Inactivity check first
            if (trades.length > 0 && Date.now() - lastTradeTime > INACTIVITY_MS) {
                try {
                    const accountData = await connection.getAccountInfo(statePDA);
                    if (!accountData || !decodeTokenState(accountData.data).isRunning) {
                        finish();
                        return;
                    }
                } catch {
                    finish();
                    return;
                }
            }
        }

        console.log(`  Recording trades for ${mintAddress}...`);

        // Hard timeout
        const hardTimeout = setTimeout(() => {
            if (!done) {
                console.log(`\n  (hard timeout after ${MAX_TIMEOUT_MS/1000}s)`);
                finish();
            }
        }, MAX_TIMEOUT_MS);

        // Poll isRunning every 5s
        const pollId = setInterval(checkIsRunning, POLL_INTERVAL_MS);

        logsId = connection.onLogs(
            new PublicKey(MAYHEM_TRADING_WALLET),
            async (logs) => {
                if (logs.err || done) return;
                if (processed.has(logs.signature)) return;
                processed.add(logs.signature);

                try {
                    const tx = await fetchTxWithRetry(logs.signature);
                    if (!tx || done) return;
                    const trade = decodeBotTrade(tx);
                    if (!trade || trade.mint !== mintAddress || done) return;
                    lastTradeTime = Date.now(); // Only reset for OUR mint
                    trades.push(trade);
                    const buys = trades.filter(t => t.action === 'buy').length;
                    const sells = trades.length - buys;
                    process.stdout.write(`\r  Trades: ${trades.length} (${buys}B/${sells}S)`);
                } catch {}
            },
            'processed'
        );
    });
}

// Main
const args = process.argv.slice(2);
let maxTokens = 0;
for (const arg of args) {
    if (arg.startsWith('--count=')) maxTokens = parseInt(arg.split('=')[1]);
}

const outDir = new URL('../analysis/tokens', import.meta.url).pathname;
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

console.log(`Collecting Mayhem token trade data...`);
console.log(`Output: ${outDir}/`);
if (maxTokens > 0) console.log(`Will stop after ${maxTokens} tokens.`);

let collected = 0;

process.on('SIGINT', () => {
    console.log(`\n\nCollected ${collected} tokens. Exiting.`);
    process.exit(0);
});

while (true) {
    if (maxTokens > 0 && collected >= maxTokens) break;

    const mintAddress = await waitForNewMint();
    const trades = await collectTrades(mintAddress);

    if (trades.length < 2) {
        console.log(`\n  Skipped (only ${trades.length} trades).`);
        continue;
    }

    const buys = trades.filter(t => t.action === 'buy').length;
    const sells = trades.length - buys;
    const dataset = {
        mint: mintAddress,
        extractedAt: new Date().toISOString(),
        totalTrades: trades.length,
        metrics: { buyCount: buys, sellCount: sells },
        trades,
    };

    const filename = `${mintAddress.slice(0, 12)}_${trades.length}t.json`;
    fs.writeFileSync(path.join(outDir, filename), JSON.stringify(dataset, null, 2));
    collected++;
    console.log(`\n  Saved ${filename} (${buys}B/${sells}S) [${collected}${maxTokens ? '/' + maxTokens : ''}]`);
}

console.log(`\nDone. Collected ${collected} tokens.`);
process.exit(0);
