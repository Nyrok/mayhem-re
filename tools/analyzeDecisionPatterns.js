/**
 * analyzeDecisionPatterns.js
 *
 * Purpose: Analyze the extracted trade dataset to identify patterns
 * that determine buy/sell decisions.
 *
 * Hypotheses to test:
 * 1. Simple alternation (buy/sell/buy/sell...)
 * 2. Threshold on totalSolBought/totalTokensSold (i128 signed)
 * 3. Net position ratio
 * 4. Compression ratio thresholds
 * 5. Correlation with unknownParameter1 (from globalState)
 */

import fs from "fs";
import path from "path";

const datasetPath = process.argv[2] ||
    new URL('../analysis/tradeDataset.json', import.meta.url).pathname;

async function analyzePatterns() {
    console.log(`\n📈 Analyzing decision patterns...`);
    console.log(`   Dataset: ${datasetPath}\n`);

    if (!fs.existsSync(datasetPath)) {
        console.error(`❌ Dataset not found. Run extractTradeDataset.js first.`);
        process.exit(1);
    }

    const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));
    const trades = dataset.trades;

    if (trades.length < 2) {
        console.error(`❌ Not enough trades for analysis (found ${trades.length})`);
        process.exit(1);
    }

    console.log(`${'='.repeat(70)}`);
    console.log(`HYPOTHESIS TESTING`);
    console.log(`${'='.repeat(70)}`);

    // Hypothesis 1: Simple Alternation
    testAlternationHypothesis(trades);

    // Hypothesis 2: Threshold on cumulative counters
    testCumulativeThresholdHypothesis(trades);

    // Hypothesis 3: Net position ratio
    testNetPositionHypothesis(trades);

    // Hypothesis 4: Compression ratio thresholds
    testCompressionRatioHypothesis(trades);

    // Hypothesis 5: State delta analysis
    testStateDeltaHypothesis(trades);

    // Hypothesis 6: Sequence patterns (n-gram analysis)
    testSequencePatterns(trades);

    // Summary
    printSummary(trades);
}

function testAlternationHypothesis(trades) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`HYPOTHESIS 1: Simple Alternation`);
    console.log(`${'─'.repeat(70)}`);

    let alternations = 0;
    let nonAlternations = 0;
    const streaks = [];
    let currentStreak = 1;
    let currentAction = trades[0].action;

    for (let i = 1; i < trades.length; i++) {
        if (trades[i].action !== trades[i - 1].action) {
            alternations++;
            streaks.push({action: currentAction, length: currentStreak});
            currentStreak = 1;
            currentAction = trades[i].action;
        } else {
            nonAlternations++;
            currentStreak++;
        }
    }
    streaks.push({action: currentAction, length: currentStreak});

    const alternationRate = alternations / (trades.length - 1);

    console.log(`\nResults:`);
    console.log(`  Alternations: ${alternations} (${(alternationRate * 100).toFixed(1)}%)`);
    console.log(`  Non-alternations: ${nonAlternations} (${((1 - alternationRate) * 100).toFixed(1)}%)`);
    console.log(`  Streak count: ${streaks.length}`);
    console.log(`  Max streak: ${Math.max(...streaks.map(s => s.length))}`);
    console.log(`  Avg streak: ${(streaks.reduce((a, b) => a + b.length, 0) / streaks.length).toFixed(2)}`);

    if (alternationRate > 0.9) {
        console.log(`\n  ✅ SUPPORTED: Bot appears to alternate buy/sell consistently`);
    } else if (alternationRate > 0.7) {
        console.log(`\n  ⚠️  PARTIAL: Bot mostly alternates but not always`);
    } else {
        console.log(`\n  ❌ REJECTED: Bot does NOT follow simple alternation`);
    }

    // Print streak distribution
    const streakDist = {};
    streaks.forEach(s => {
        const key = `${s.action}-${s.length}`;
        streakDist[key] = (streakDist[key] || 0) + 1;
    });
    console.log(`\n  Streak distribution:`);
    Object.entries(streakDist).sort().forEach(([k, v]) => {
        console.log(`    ${k}: ${v}`);
    });
}

function testCumulativeThresholdHypothesis(trades) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`HYPOTHESIS 2: Cumulative Counter Thresholds`);
    console.log(`${'─'.repeat(70)}`);

    const buyTrades = trades.filter(t => t.action === 'buy');
    const sellTrades = trades.filter(t => t.action === 'sell');

    // Analyze totalSolBought at time of action
    const buyTotalSol = buyTrades.map(t => BigInt(t.totalSolBought));
    const sellTotalSol = sellTrades.map(t => BigInt(t.totalSolBought));

    console.log(`\n  totalSolBought at time of BUY:`);
    console.log(`    Min: ${buyTotalSol.length > 0 ? buyTotalSol.reduce((a, b) => a < b ? a : b).toString() : 'N/A'}`);
    console.log(`    Max: ${buyTotalSol.length > 0 ? buyTotalSol.reduce((a, b) => a > b ? a : b).toString() : 'N/A'}`);

    console.log(`\n  totalSolBought at time of SELL:`);
    console.log(`    Min: ${sellTotalSol.length > 0 ? sellTotalSol.reduce((a, b) => a < b ? a : b).toString() : 'N/A'}`);
    console.log(`    Max: ${sellTotalSol.length > 0 ? sellTotalSol.reduce((a, b) => a > b ? a : b).toString() : 'N/A'}`);

    // Check for non-overlapping ranges
    if (buyTotalSol.length > 0 && sellTotalSol.length > 0) {
        const buyMax = buyTotalSol.reduce((a, b) => a > b ? a : b);
        const sellMin = sellTotalSol.reduce((a, b) => a < b ? a : b);
        const buyMin = buyTotalSol.reduce((a, b) => a < b ? a : b);
        const sellMax = sellTotalSol.reduce((a, b) => a > b ? a : b);

        if (buyMax < sellMin) {
            console.log(`\n  ✅ THRESHOLD FOUND: Buy when totalSolBought < ${sellMin}`);
        } else if (sellMax < buyMin) {
            console.log(`\n  ✅ THRESHOLD FOUND: Sell when totalSolBought < ${buyMin}`);
        } else {
            console.log(`\n  ❌ Ranges overlap - no clear threshold`);
        }
    }

    // Same for totalTokensSold
    const buyTotalToken = buyTrades.map(t => BigInt(t.totalTokensSold));
    const sellTotalToken = sellTrades.map(t => BigInt(t.totalTokensSold));

    console.log(`\n  totalTokensSold at time of BUY:`);
    console.log(`    Min: ${buyTotalToken.length > 0 ? buyTotalToken.reduce((a, b) => a < b ? a : b).toString() : 'N/A'}`);
    console.log(`    Max: ${buyTotalToken.length > 0 ? buyTotalToken.reduce((a, b) => a > b ? a : b).toString() : 'N/A'}`);

    console.log(`\n  totalTokensSold at time of SELL:`);
    console.log(`    Min: ${sellTotalToken.length > 0 ? sellTotalToken.reduce((a, b) => a < b ? a : b).toString() : 'N/A'}`);
    console.log(`    Max: ${sellTotalToken.length > 0 ? sellTotalToken.reduce((a, b) => a > b ? a : b).toString() : 'N/A'}`);
}

function testNetPositionHypothesis(trades) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`HYPOTHESIS 3: Net Position Ratio`);
    console.log(`${'─'.repeat(70)}`);

    // Calculate net position ratio for each trade
    const tradesWithRatio = trades.map(t => {
        const solBought = BigInt(t.totalSolBought);
        const tokensSold = BigInt(t.totalTokensSold);
        // Avoid division by zero
        const ratio = tokensSold !== 0n ?
            Number(solBought * 1000000n / tokensSold) / 1000000 : 0;
        return {...t, netRatio: ratio};
    });

    const buyRatios = tradesWithRatio.filter(t => t.action === 'buy').map(t => t.netRatio);
    const sellRatios = tradesWithRatio.filter(t => t.action === 'sell').map(t => t.netRatio);

    if (buyRatios.length > 0 && sellRatios.length > 0) {
        console.log(`\n  Net ratio (totalSolBought/totalTokensSold) at time of BUY:`);
        console.log(`    Mean: ${average(buyRatios).toFixed(6)}`);
        console.log(`    Min: ${Math.min(...buyRatios).toFixed(6)}`);
        console.log(`    Max: ${Math.max(...buyRatios).toFixed(6)}`);

        console.log(`\n  Net ratio at time of SELL:`);
        console.log(`    Mean: ${average(sellRatios).toFixed(6)}`);
        console.log(`    Min: ${Math.min(...sellRatios).toFixed(6)}`);
        console.log(`    Max: ${Math.max(...sellRatios).toFixed(6)}`);

        // Check for separation
        const buyMean = average(buyRatios);
        const sellMean = average(sellRatios);
        const separation = Math.abs(buyMean - sellMean);

        if (separation > 0.1) {
            console.log(`\n  ⚠️  Ratios show some separation (diff: ${separation.toFixed(4)})`);
        } else {
            console.log(`\n  ❌ No clear separation in net position ratios`);
        }
    }
}

function testCompressionRatioHypothesis(trades) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`HYPOTHESIS 4: Compression Ratio Thresholds`);
    console.log(`${'─'.repeat(70)}`);

    const buyTrades = trades.filter(t => t.action === 'buy');
    const sellTrades = trades.filter(t => t.action === 'sell');

    for (const ratioName of ['compressionRV', 'compressionRR', 'compressionVR']) {
        const buyVals = buyTrades.map(t => t[ratioName]).filter(v => v !== null && !isNaN(v));
        const sellVals = sellTrades.map(t => t[ratioName]).filter(v => v !== null && !isNaN(v));

        if (buyVals.length === 0 || sellVals.length === 0) continue;

        console.log(`\n  ${ratioName}:`);
        console.log(`    BUY  - Mean: ${average(buyVals).toFixed(4)}, Range: [${Math.min(...buyVals).toFixed(4)}, ${Math.max(...buyVals).toFixed(4)}]`);
        console.log(`    SELL - Mean: ${average(sellVals).toFixed(4)}, Range: [${Math.min(...sellVals).toFixed(4)}, ${Math.max(...sellVals).toFixed(4)}]`);

        // Check for non-overlapping ranges
        const buyMax = Math.max(...buyVals);
        const buyMin = Math.min(...buyVals);
        const sellMax = Math.max(...sellVals);
        const sellMin = Math.min(...sellVals);

        if (buyMax < sellMin) {
            console.log(`    ✅ THRESHOLD: ${ratioName} < ${sellMin} → BUY`);
        } else if (sellMax < buyMin) {
            console.log(`    ✅ THRESHOLD: ${ratioName} < ${buyMin} → SELL`);
        } else {
            const overlap = Math.min(buyMax, sellMax) - Math.max(buyMin, sellMin);
            const totalRange = Math.max(buyMax, sellMax) - Math.min(buyMin, sellMin);
            const overlapPct = overlap / totalRange * 100;
            console.log(`    ❌ Ranges overlap by ${overlapPct.toFixed(1)}%`);
        }
    }
}

function testStateDeltaHypothesis(trades) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`HYPOTHESIS 5: State Delta Analysis`);
    console.log(`${'─'.repeat(70)}`);

    // Look at changes between consecutive trades
    const deltas = [];
    for (let i = 1; i < trades.length; i++) {
        const prev = trades[i - 1];
        const curr = trades[i];

        deltas.push({
            action: curr.action,
            prevAction: prev.action,
            slotDelta: curr.slot - prev.slot,
            virtualSolDelta: curr.preVirtualSolReserves - prev.virtualSolReserves,
            realSolDelta: (curr.realSolReserves || 0) - (prev.realSolReserves || 0),
            solBoughtDelta: BigInt(curr.totalSolBought) - BigInt(prev.totalSolBought),
            tokensSoldDelta: BigInt(curr.totalTokensSold) - BigInt(prev.totalTokensSold),
        });
    }

    console.log(`\n  State changes before BUY vs SELL:`);

    const beforeBuy = deltas.filter(d => d.action === 'buy');
    const beforeSell = deltas.filter(d => d.action === 'sell');

    console.log(`\n  Slot delta (time between trades):`);
    console.log(`    Before BUY  - Mean: ${average(beforeBuy.map(d => d.slotDelta)).toFixed(1)}`);
    console.log(`    Before SELL - Mean: ${average(beforeSell.map(d => d.slotDelta)).toFixed(1)}`);

    console.log(`\n  Virtual SOL delta:`);
    console.log(`    Before BUY  - Mean: ${average(beforeBuy.map(d => d.virtualSolDelta)).toFixed(0)}`);
    console.log(`    Before SELL - Mean: ${average(beforeSell.map(d => d.virtualSolDelta)).toFixed(0)}`);
}

function testSequencePatterns(trades) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`HYPOTHESIS 6: Sequence Pattern Analysis (N-grams)`);
    console.log(`${'─'.repeat(70)}`);

    // Convert to sequence string
    const sequence = trades.map(t => t.action === 'buy' ? 'B' : 'S').join('');

    // 2-grams
    const bigrams = {};
    for (let i = 0; i < sequence.length - 1; i++) {
        const gram = sequence.substring(i, i + 2);
        bigrams[gram] = (bigrams[gram] || 0) + 1;
    }

    console.log(`\n  2-gram frequencies:`);
    Object.entries(bigrams).sort((a, b) => b[1] - a[1]).forEach(([gram, count]) => {
        const pct = (count / (sequence.length - 1) * 100).toFixed(1);
        console.log(`    ${gram}: ${count} (${pct}%)`);
    });

    // 3-grams
    if (sequence.length >= 3) {
        const trigrams = {};
        for (let i = 0; i < sequence.length - 2; i++) {
            const gram = sequence.substring(i, i + 3);
            trigrams[gram] = (trigrams[gram] || 0) + 1;
        }

        console.log(`\n  3-gram frequencies:`);
        Object.entries(trigrams).sort((a, b) => b[1] - a[1]).forEach(([gram, count]) => {
            const pct = (count / (sequence.length - 2) * 100).toFixed(1);
            console.log(`    ${gram}: ${count} (${pct}%)`);
        });
    }

    // Transition probabilities
    console.log(`\n  Transition probabilities:`);
    const bAfterB = (bigrams['BB'] || 0) / ((bigrams['BB'] || 0) + (bigrams['BS'] || 0)) || 0;
    const sAfterB = (bigrams['BS'] || 0) / ((bigrams['BB'] || 0) + (bigrams['BS'] || 0)) || 0;
    const bAfterS = (bigrams['SB'] || 0) / ((bigrams['SB'] || 0) + (bigrams['SS'] || 0)) || 0;
    const sAfterS = (bigrams['SS'] || 0) / ((bigrams['SB'] || 0) + (bigrams['SS'] || 0)) || 0;

    console.log(`    P(BUY  | after BUY):  ${(bAfterB * 100).toFixed(1)}%`);
    console.log(`    P(SELL | after BUY):  ${(sAfterB * 100).toFixed(1)}%`);
    console.log(`    P(BUY  | after SELL): ${(bAfterS * 100).toFixed(1)}%`);
    console.log(`    P(SELL | after SELL): ${(sAfterS * 100).toFixed(1)}%`);
}

function printSummary(trades) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`SUMMARY`);
    console.log(`${'='.repeat(70)}`);

    console.log(`\nDataset: ${trades.length} trades`);
    console.log(`Buys: ${trades.filter(t => t.action === 'buy').length}`);
    console.log(`Sells: ${trades.filter(t => t.action === 'sell').length}`);

    // Calculate alternation rate
    let alternations = 0;
    for (let i = 1; i < trades.length; i++) {
        if (trades[i].action !== trades[i - 1].action) alternations++;
    }
    const altRate = alternations / (trades.length - 1);

    console.log(`\nKey findings:`);
    if (altRate > 0.9) {
        console.log(`  - Bot uses simple alternation (${(altRate * 100).toFixed(0)}% alternate)`);
    } else if (altRate > 0.5) {
        console.log(`  - Bot mostly alternates but has exceptions (${(altRate * 100).toFixed(0)}%)`);
        console.log(`  - Need to investigate non-alternating cases`);
    } else {
        console.log(`  - Bot does NOT use simple alternation`);
        console.log(`  - Decision logic is based on internal state`);
    }

    console.log(`\nRecommended next steps:`);
    console.log(`  1. Run predictAndValidate.js to test prediction accuracy`);
    console.log(`  2. Analyze non-alternating sequences in detail`);
    console.log(`  3. Cross-reference with globalState changes`);
}

function average(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

await analyzePatterns();
