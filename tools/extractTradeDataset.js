/**
 * extractTradeDataset.js
 *
 * Purpose: Extract complete trade data for each bot transaction to build a dataset
 * for analyzing the buy/sell decision logic.
 *
 * For each trade, extracts:
 * - Pre-trade state (from XpreTradeVirtual* fields in trade event)
 * - Post-trade state (from trade event)
 * - Cumulative counters (totalSolBought, totalTokensSold - i128 signed!)
 * - Compression ratios
 * - Trade specifics (solAmount, tokenAmount, marketCap)
 */

import {connection} from "../utils/rpc.js";
import {PublicKey} from "@solana/web3.js";
import bs58 from "bs58";
import fs from "fs";
import {decodeMayhemTradeEvent} from "../decoders/decodeMayhemTradeEvent.js";
import {decodeMayhemIxDataEvent} from "../decoders/decodeMayhemIxData.js";
import {MAYHEM_TRADING_WALLET, MAYHEM_PROGRAM_ID} from "../utils/constants.js";

// Token to analyze
const MINT = process.argv[2] || "BPnUPPQf6bKTF6FiGqGtEEJ7h1V2TZZQJqyBP3cFpump";
const MAX_TRADES = parseInt(process.argv[3]) || 100;

async function extractTradeDataset() {
    console.log(`\n📊 Extracting trade dataset for token: ${MINT}`);
    console.log(`   Max trades to extract: ${MAX_TRADES}\n`);

    const trades = [];
    let lastSignature = null;
    let totalFetched = 0;

    while (trades.length < MAX_TRADES) {
        const signatures = await connection.getSignaturesForAddress(new PublicKey(MINT), {
            limit: 200,
            before: lastSignature
        }, 'confirmed');

        if (signatures.length === 0) break;
        totalFetched += signatures.length;
        console.log(`Fetched ${totalFetched} signatures, processing...`);

        lastSignature = signatures[signatures.length - 1].signature;

        for (const signatureInfo of signatures) {
            if (trades.length >= MAX_TRADES) break;

            try {
                const tx = await connection.getParsedTransaction(signatureInfo.signature, {
                    maxSupportedTransactionVersion: 0,
                    commitment: 'confirmed'
                });

                if (!tx) continue;

                // Only process bot transactions
                const isBotTx = tx.transaction.message.accountKeys.some(
                    ({pubkey, signer}) => pubkey.toBase58() === MAYHEM_TRADING_WALLET && signer
                );
                if (!isBotTx) continue;

                // Find the Mayhem instruction data
                let ixData = null;
                for (const ix of tx.transaction.message.instructions) {
                    const programId = ix.programId?.toBase58?.() || ix.programId;
                    if (programId === MAYHEM_PROGRAM_ID) {
                        ixData = ix.data;
                        break;
                    }
                }

                // Get the trade event from inner instructions
                if (!tx.meta?.innerInstructions || !tx.meta.innerInstructions[0]) continue;
                const innerInstructions = tx.meta.innerInstructions[0].instructions;
                const mayhemEventData = innerInstructions[innerInstructions.length - 1]?.data;
                if (!mayhemEventData) continue;

                // Decode both the instruction data and the trade event
                const decodedEvent = decodeMayhemTradeEvent(bs58.decode(mayhemEventData));
                let decodedIx = null;
                if (ixData) {
                    try {
                        decodedIx = decodeMayhemIxDataEvent(bs58.decode(ixData));
                    } catch (e) {
                        // May fail if format is different
                    }
                }

                // Calculate ratios
                const preVirtualSol = Number(decodedEvent.XpreTradeVirtualSolReserves);
                const preVirtualToken = Number(decodedEvent.XpreTradeVirtualTokenReserves);
                const preRealToken = Number(decodedEvent.XpreTradeRealTokenReserves);
                const postVirtualSol = Number(decodedEvent.virtualSolReserves);
                const postVirtualToken = Number(decodedEvent.virtualTokenReserves);
                const postRealSol = Number(decodedEvent.realSolReserves);
                const postRealToken = Number(decodedEvent.realTokenReserves);

                // Compression ratios
                const compressionRV = preVirtualSol / postVirtualSol;
                const compressionRR = preVirtualSol / postRealSol;
                const compressionVR = postVirtualSol / postRealSol;

                const trade = {
                    // Metadata
                    signature: signatureInfo.signature,
                    slot: tx.slot,
                    blockTime: tx.blockTime,
                    action: decodedEvent.actionType === 0 ? 'buy' : 'sell',

                    // Pre-trade state
                    preVirtualSolReserves: preVirtualSol,
                    preVirtualTokenReserves: preVirtualToken,
                    preRealTokenReserves: preRealToken,

                    // Post-trade state
                    virtualSolReserves: postVirtualSol,
                    virtualTokenReserves: postVirtualToken,
                    realSolReserves: postRealSol,
                    realTokenReserves: postRealToken,

                    // Cumulative counters (i128 signed - stored as string to preserve precision)
                    totalSolBought: decodedEvent.totalSolBought.toString(),
                    totalTokensSold: decodedEvent.totalTokensSold.toString(),

                    // Trade specifics
                    solAmount: Number(decodedEvent.solAmount),
                    tokenAmount: Number(decodedEvent.tokenAmount),
                    marketCap: decodedIx?.marketCap?.toString() || null,

                    // Calculated ratios
                    compressionRV: parseFloat(compressionRV.toFixed(6)),
                    compressionRR: parseFloat(compressionRR.toFixed(6)),
                    compressionVR: parseFloat(compressionVR.toFixed(6)),

                    // Time info
                    tradeTime: decodedEvent.tradeTime?.toString(),
                    endTime: decodedEvent.endTime?.toString(),
                    version: decodedEvent.version
                };

                trades.push(trade);
                console.log(`  [${trades.length}] ${trade.action.toUpperCase()} - slot ${trade.slot}`);

            } catch (e) {
                // Skip invalid transactions
                continue;
            }
        }
    }

    // Sort by slot (chronological order)
    trades.sort((a, b) => a.slot - b.slot);

    // Add sequence information
    trades.forEach((trade, index) => {
        trade.sequenceIndex = index;
        if (index > 0) {
            trade.prevAction = trades[index - 1].action;
            trade.isAlternation = trade.action !== trade.prevAction;
        } else {
            trade.prevAction = null;
            trade.isAlternation = null;
        }
    });

    // Calculate additional metrics
    const metrics = calculateDatasetMetrics(trades);

    // Output
    const output = {
        mint: MINT,
        extractedAt: new Date().toISOString(),
        totalTrades: trades.length,
        metrics,
        trades
    };

    const outputPath = new URL('../analysis/tradeDataset.json', import.meta.url).pathname;

    // Ensure directory exists
    const dir = new URL('../analysis', import.meta.url).pathname;
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {recursive: true});
    }

    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.log(`\n✅ Dataset saved to: ${outputPath}`);

    // Print summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(`DATASET SUMMARY`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Total trades: ${trades.length}`);
    console.log(`Buy trades: ${metrics.buyCount} (${(metrics.buyCount / trades.length * 100).toFixed(1)}%)`);
    console.log(`Sell trades: ${metrics.sellCount} (${(metrics.sellCount / trades.length * 100).toFixed(1)}%)`);
    console.log(`Alternation rate: ${(metrics.alternationRate * 100).toFixed(1)}%`);
    console.log(`\nSlot range: ${metrics.minSlot} - ${metrics.maxSlot}`);
    console.log(`Time range: ${metrics.minTime} - ${metrics.maxTime}`);

    return output;
}

function calculateDatasetMetrics(trades) {
    if (trades.length === 0) return {};

    const buyTrades = trades.filter(t => t.action === 'buy');
    const sellTrades = trades.filter(t => t.action === 'sell');

    // Count alternations
    let alternations = 0;
    for (let i = 1; i < trades.length; i++) {
        if (trades[i].action !== trades[i - 1].action) {
            alternations++;
        }
    }

    // Find ranges
    const totalSolBoughts = trades.map(t => BigInt(t.totalSolBought));
    const totalTokensSolds = trades.map(t => BigInt(t.totalTokensSold));

    return {
        buyCount: buyTrades.length,
        sellCount: sellTrades.length,
        alternationCount: alternations,
        alternationRate: trades.length > 1 ? alternations / (trades.length - 1) : 0,

        minSlot: Math.min(...trades.map(t => t.slot)),
        maxSlot: Math.max(...trades.map(t => t.slot)),
        minTime: trades[0].blockTime ? new Date(trades[0].blockTime * 1000).toISOString() : null,
        maxTime: trades[trades.length - 1].blockTime ?
            new Date(trades[trades.length - 1].blockTime * 1000).toISOString() : null,

        // Compression ratio stats
        avgCompressionRV: average(trades.map(t => t.compressionRV)),
        avgCompressionRR: average(trades.map(t => t.compressionRR)),
        avgCompressionVR: average(trades.map(t => t.compressionVR)),

        // Sol amount stats
        avgSolAmount: average(trades.map(t => t.solAmount)),
        minSolAmount: Math.min(...trades.map(t => t.solAmount)),
        maxSolAmount: Math.max(...trades.map(t => t.solAmount)),

        // Cumulative counter ranges
        totalSolBoughtMin: totalSolBoughts.reduce((a, b) => a < b ? a : b).toString(),
        totalSolBoughtMax: totalSolBoughts.reduce((a, b) => a > b ? a : b).toString(),
        totalTokensSoldMin: totalTokensSolds.reduce((a, b) => a < b ? a : b).toString(),
        totalTokensSoldMax: totalTokensSolds.reduce((a, b) => a > b ? a : b).toString(),
    };
}

function average(arr) {
    if (arr.length === 0) return 0;
    return parseFloat((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(6));
}

await extractTradeDataset();
