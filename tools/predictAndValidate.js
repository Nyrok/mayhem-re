/**
 * predictAndValidate.js
 *
 * Purpose: Test prediction accuracy of the discovered decision logic
 * by validating against historical data or listening in real-time.
 *
 * Usage:
 *   node tools/predictAndValidate.js                    # Validate against dataset
 *   node tools/predictAndValidate.js --live <mint>      # Live prediction
 */

import fs from "fs";
import {connection} from "../utils/rpc.js";
import {PublicKey} from "@solana/web3.js";
import bs58 from "bs58";
import {decodeMayhemTradeEvent} from "../decoders/decodeMayhemTradeEvent.js";
import {MAYHEM_TRADING_WALLET, MAYHEM_PROGRAM_ID} from "../utils/constants.js";

const isLiveMode = process.argv.includes('--live');
const MINT = process.argv[process.argv.indexOf('--live') + 1] || "BPnUPPQf6bKTF6FiGqGtEEJ7h1V2TZZQJqyBP3cFpump";

/**
 * PREDICTION STRATEGIES
 *
 * These are the different hypotheses for predicting the next action.
 * Each strategy takes the current state and returns 'buy' | 'sell' | 'unknown'
 */
const strategies = {
    // Strategy 1: Simple alternation
    alternation: {
        name: 'Simple Alternation',
        predict: (state, prevAction) => {
            if (prevAction === null) return 'unknown';
            return prevAction === 'buy' ? 'sell' : 'buy';
        }
    },

    // Strategy 2: Threshold on realSolReserves
    realSolThreshold: {
        name: 'Real SOL Threshold',
        threshold: 50000000, // 0.05 SOL in lamports
        predict: (state, prevAction) => {
            // Buy to inject liquidity when low, sell to extract when high
            if (state.realSolReserves < strategies.realSolThreshold.threshold) {
                return 'buy';
            }
            return 'sell';
        }
    },

    // Strategy 3: Compression ratio target
    compressionTarget: {
        name: 'Compression Ratio Target',
        targetRV: 1.0, // Target compression ratio
        predict: (state, prevAction) => {
            const compressionRV = state.preVirtualSolReserves / state.virtualSolReserves;
            // If compression is too high (virtual > pre), buy to bring it down
            // If compression is too low, sell to bring it up
            if (compressionRV < strategies.compressionTarget.targetRV) {
                return 'buy';
            }
            return 'sell';
        }
    },

    // Strategy 4: Net position balancing
    netPosition: {
        name: 'Net Position Balance',
        predict: (state, prevAction) => {
            const totalSolBought = BigInt(state.totalSolBought);
            const totalTokensSold = BigInt(state.totalTokensSold);

            // If we've bought more SOL than tokens sold, sell
            // If we've sold more tokens than SOL bought, buy
            if (totalSolBought > 0 && totalTokensSold > 0) {
                // Use ratio to determine - this needs tuning
                const ratio = Number(totalSolBought * 1000000n / totalTokensSold) / 1000000;
                if (ratio > 0.000001) return 'sell';
                return 'buy';
            }
            return 'unknown';
        }
    },

    // Strategy 5: Combined (alternation with exception handling)
    combined: {
        name: 'Combined Strategy',
        predict: (state, prevAction) => {
            // Primary: alternation
            if (prevAction === null) return 'unknown';

            // Check for special conditions that override alternation
            // (Add discovered conditions here)

            // Default to alternation
            return prevAction === 'buy' ? 'sell' : 'buy';
        }
    }
};

async function validateAgainstDataset() {
    console.log(`\n🎯 Validating prediction strategies against dataset\n`);

    const datasetPath = new URL('../analysis/tradeDataset.json', import.meta.url).pathname;

    if (!fs.existsSync(datasetPath)) {
        console.error(`❌ Dataset not found. Run extractTradeDataset.js first.`);
        process.exit(1);
    }

    const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));
    const trades = dataset.trades;

    console.log(`Dataset: ${trades.length} trades\n`);
    console.log(`${'='.repeat(70)}`);

    // Test each strategy
    for (const [key, strategy] of Object.entries(strategies)) {
        let correct = 0;
        let incorrect = 0;
        let unknown = 0;
        const errors = [];

        for (let i = 1; i < trades.length; i++) {
            const prevTrade = trades[i - 1];
            const currTrade = trades[i];

            const prediction = strategy.predict(currTrade, prevTrade.action);

            if (prediction === 'unknown') {
                unknown++;
            } else if (prediction === currTrade.action) {
                correct++;
            } else {
                incorrect++;
                if (errors.length < 5) {
                    errors.push({
                        index: i,
                        predicted: prediction,
                        actual: currTrade.action,
                        slot: currTrade.slot
                    });
                }
            }
        }

        const total = correct + incorrect;
        const accuracy = total > 0 ? (correct / total * 100).toFixed(1) : 0;

        console.log(`\n${strategy.name}:`);
        console.log(`  Correct: ${correct} | Incorrect: ${incorrect} | Unknown: ${unknown}`);
        console.log(`  Accuracy: ${accuracy}%`);

        if (errors.length > 0) {
            console.log(`  Sample errors:`);
            errors.forEach(e => {
                console.log(`    [${e.index}] Predicted: ${e.predicted}, Actual: ${e.actual} (slot ${e.slot})`);
            });
        }

        // Mark best strategies
        if (parseFloat(accuracy) >= 90) {
            console.log(`  ✅ HIGH ACCURACY`);
        } else if (parseFloat(accuracy) >= 70) {
            console.log(`  ⚠️  MODERATE ACCURACY`);
        } else {
            console.log(`  ❌ LOW ACCURACY`);
        }
    }

    console.log(`\n${'='.repeat(70)}`);
    console.log(`\nAnalysis of prediction errors:\n`);

    // Detailed error analysis for alternation strategy
    analyzeAlternationErrors(trades);
}

function analyzeAlternationErrors(trades) {
    console.log(`Alternation failures (consecutive same actions):`);

    let errorCount = 0;
    for (let i = 1; i < trades.length; i++) {
        if (trades[i].action === trades[i - 1].action) {
            errorCount++;
            const prev = trades[i - 1];
            const curr = trades[i];

            if (errorCount <= 10) {
                console.log(`\n  Error ${errorCount}:`);
                console.log(`    Slots: ${prev.slot} → ${curr.slot} (delta: ${curr.slot - prev.slot})`);
                console.log(`    Actions: ${prev.action} → ${curr.action} (NON-ALTERNATING)`);
                console.log(`    Pre-trade state:`);
                console.log(`      virtualSolReserves: ${curr.preVirtualSolReserves}`);
                console.log(`      realSolReserves: ${curr.realSolReserves}`);
                console.log(`      totalSolBought: ${curr.totalSolBought}`);
                console.log(`      totalTokensSold: ${curr.totalTokensSold}`);
                console.log(`    Compression ratios:`);
                console.log(`      RV: ${curr.compressionRV}, RR: ${curr.compressionRR}, VR: ${curr.compressionVR}`);
            }
        }
    }

    console.log(`\n  Total non-alternating transitions: ${errorCount}`);

    if (errorCount === 0) {
        console.log(`\n  ✅ Perfect alternation detected! Bot alternates buy/sell.`);
    } else {
        console.log(`\n  Need to investigate ${errorCount} cases where bot didn't alternate.`);
        console.log(`  These cases likely have special triggering conditions.`);
    }
}

async function livePredict() {
    console.log(`\n🔴 LIVE PREDICTION MODE`);
    console.log(`   Token: ${MINT}`);
    console.log(`   Watching for new trades...\n`);

    let lastSignature = null;
    let lastAction = null;
    let correctPredictions = 0;
    let totalPredictions = 0;

    // Get the most recent trade to establish baseline
    const recentSigs = await connection.getSignaturesForAddress(new PublicKey(MINT), {limit: 10});

    for (const sig of recentSigs) {
        const tx = await connection.getParsedTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        });

        if (!tx) continue;

        const isBotTx = tx.transaction.message.accountKeys.some(
            ({pubkey, signer}) => pubkey.toBase58() === MAYHEM_TRADING_WALLET && signer
        );

        if (isBotTx && tx.meta?.innerInstructions?.[0]) {
            const innerInstructions = tx.meta.innerInstructions[0].instructions;
            const mayhemEventData = innerInstructions[innerInstructions.length - 1]?.data;
            if (mayhemEventData) {
                try {
                    const decoded = decodeMayhemTradeEvent(bs58.decode(mayhemEventData));
                    lastAction = decoded.actionType === 0 ? 'buy' : 'sell';
                    lastSignature = sig.signature;
                    console.log(`Last action: ${lastAction.toUpperCase()} (slot ${tx.slot})`);
                    break;
                } catch (e) {}
            }
        }
    }

    if (!lastAction) {
        console.log(`Could not establish baseline. Starting fresh.`);
    }

    // Poll for new transactions
    console.log(`\nPredictions based on alternation strategy:`);

    setInterval(async () => {
        try {
            const sigs = await connection.getSignaturesForAddress(new PublicKey(MINT), {
                limit: 5,
                until: lastSignature
            });

            for (const sig of sigs.reverse()) {
                if (sig.signature === lastSignature) continue;

                const tx = await connection.getParsedTransaction(sig.signature, {
                    maxSupportedTransactionVersion: 0,
                    commitment: 'confirmed'
                });

                if (!tx) continue;

                const isBotTx = tx.transaction.message.accountKeys.some(
                    ({pubkey, signer}) => pubkey.toBase58() === MAYHEM_TRADING_WALLET && signer
                );

                if (!isBotTx) continue;

                if (!tx.meta?.innerInstructions?.[0]) continue;
                const innerInstructions = tx.meta.innerInstructions[0].instructions;
                const mayhemEventData = innerInstructions[innerInstructions.length - 1]?.data;
                if (!mayhemEventData) continue;

                try {
                    const decoded = decodeMayhemTradeEvent(bs58.decode(mayhemEventData));
                    const actualAction = decoded.actionType === 0 ? 'buy' : 'sell';

                    // Make prediction
                    const predicted = lastAction ? (lastAction === 'buy' ? 'sell' : 'buy') : 'unknown';

                    if (predicted !== 'unknown') {
                        totalPredictions++;
                        if (predicted === actualAction) {
                            correctPredictions++;
                            console.log(`✅ [slot ${tx.slot}] Predicted: ${predicted.toUpperCase()}, Actual: ${actualAction.toUpperCase()}`);
                        } else {
                            console.log(`❌ [slot ${tx.slot}] Predicted: ${predicted.toUpperCase()}, Actual: ${actualAction.toUpperCase()}`);
                        }
                        console.log(`   Running accuracy: ${(correctPredictions / totalPredictions * 100).toFixed(1)}% (${correctPredictions}/${totalPredictions})`);
                    } else {
                        console.log(`➡️  [slot ${tx.slot}] First trade observed: ${actualAction.toUpperCase()}`);
                    }

                    lastAction = actualAction;
                    lastSignature = sig.signature;
                } catch (e) {}
            }
        } catch (e) {
            // Ignore polling errors
        }
    }, 2000);

    console.log(`\nPress Ctrl+C to stop.\n`);
}

// Main execution
if (isLiveMode) {
    await livePredict();
} else {
    await validateAgainstDataset();
}
