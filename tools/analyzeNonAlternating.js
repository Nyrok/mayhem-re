/**
 * analyzeNonAlternating.js
 *
 * Purpose: Deep dive into non-alternating sequences to understand
 * what triggers consecutive buys or sells.
 */

import fs from "fs";

const datasetPath = process.argv[2] ||
    new URL('../analysis/tradeDataset.json', import.meta.url).pathname;

async function analyzeNonAlternating() {
    const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));
    const trades = dataset.trades;

    console.log(`\n📊 Analyzing Non-Alternating Sequences\n`);
    console.log(`${'='.repeat(80)}`);

    // Find all streaks
    const streaks = [];
    let currentStreak = [trades[0]];

    for (let i = 1; i < trades.length; i++) {
        if (trades[i].action === trades[i - 1].action) {
            currentStreak.push(trades[i]);
        } else {
            if (currentStreak.length > 1) {
                streaks.push([...currentStreak]);
            }
            currentStreak = [trades[i]];
        }
    }
    if (currentStreak.length > 1) {
        streaks.push(currentStreak);
    }

    console.log(`\nFound ${streaks.length} non-alternating streaks (2+ consecutive same actions)\n`);

    // Analyze each streak
    streaks.forEach((streak, idx) => {
        console.log(`\n${'─'.repeat(80)}`);
        console.log(`STREAK ${idx + 1}: ${streak.length} consecutive ${streak[0].action.toUpperCase()}s`);
        console.log(`${'─'.repeat(80)}`);

        console.log(`\nSlots: ${streak[0].slot} → ${streak[streak.length - 1].slot}`);
        console.log(`Duration: ${streak[streak.length - 1].slot - streak[0].slot} slots`);

        // Analyze progression within streak
        console.log(`\nProgression within streak:`);
        console.log(`${'─'.repeat(60)}`);
        console.log(`| # | Slot     | solAmount      | realSolRes     | comprRV   |`);
        console.log(`${'─'.repeat(60)}`);

        streak.forEach((trade, i) => {
            const solAmtStr = (trade.solAmount / 1e9).toFixed(4).padStart(12);
            const realSolStr = (trade.realSolReserves / 1e9).toFixed(4).padStart(12);
            const compRVStr = trade.compressionRV.toFixed(2).padStart(8);
            console.log(`| ${i + 1} | ${trade.slot} | ${solAmtStr} | ${realSolStr} | ${compRVStr} |`);
        });

        // Check for patterns
        console.log(`\nPattern analysis:`);

        // 1. Are sol amounts increasing/decreasing?
        const solAmounts = streak.map(t => t.solAmount);
        const solTrend = solAmounts[solAmounts.length - 1] > solAmounts[0] ? 'increasing' : 'decreasing';
        console.log(`  SOL amounts: ${solTrend} (${(solAmounts[0] / 1e9).toFixed(4)} → ${(solAmounts[solAmounts.length - 1] / 1e9).toFixed(4)})`);

        // 2. realSolReserves trend
        const realSolTrend = streak.map(t => t.realSolReserves);
        const realTrendDir = realSolTrend[realSolTrend.length - 1] > realSolTrend[0] ? 'increasing' : 'decreasing';
        console.log(`  realSolReserves: ${realTrendDir} (${(realSolTrend[0] / 1e9).toFixed(4)} → ${(realSolTrend[realSolTrend.length - 1] / 1e9).toFixed(4)})`);

        // 3. Compression ratio trend
        const compressionTrend = streak.map(t => t.compressionRV);
        const compTrendDir = compressionTrend[compressionTrend.length - 1] > compressionTrend[0] ? 'increasing' : 'decreasing';
        console.log(`  compressionRV: ${compTrendDir} (${compressionTrend[0].toFixed(2)} → ${compressionTrend[compressionTrend.length - 1].toFixed(2)})`);

        // 4. totalSolBought and totalTokensSold trends
        const totalSolTrend = streak.map(t => BigInt(t.totalSolBought));
        const totalTokenTrend = streak.map(t => BigInt(t.totalTokensSold));

        const solBoughtDir = totalSolTrend[totalSolTrend.length - 1] > totalSolTrend[0] ? 'increasing' : 'decreasing';
        const tokenSoldDir = totalTokenTrend[totalTokenTrend.length - 1] > totalTokenTrend[0] ? 'increasing' : 'decreasing';

        console.log(`  totalSolBought: ${solBoughtDir}`);
        console.log(`  totalTokensSold: ${tokenSoldDir}`);

        // What happened before this streak?
        const firstTradeIndex = trades.findIndex(t => t.signature === streak[0].signature);
        if (firstTradeIndex > 0) {
            const prevTrade = trades[firstTradeIndex - 1];
            console.log(`\nPreceding trade:`);
            console.log(`  Action: ${prevTrade.action}`);
            console.log(`  realSolReserves: ${(prevTrade.realSolReserves / 1e9).toFixed(4)}`);
            console.log(`  compressionRV: ${prevTrade.compressionRV.toFixed(2)}`);
        }

        // What happened after this streak?
        const lastTradeIndex = trades.findIndex(t => t.signature === streak[streak.length - 1].signature);
        if (lastTradeIndex < trades.length - 1) {
            const nextTrade = trades[lastTradeIndex + 1];
            console.log(`\nFollowing trade:`);
            console.log(`  Action: ${nextTrade.action} (${nextTrade.action !== streak[0].action ? 'ALTERNATED' : 'CONTINUED'})`);
            console.log(`  realSolReserves: ${(nextTrade.realSolReserves / 1e9).toFixed(4)}`);
            console.log(`  compressionRV: ${nextTrade.compressionRV.toFixed(2)}`);
        }
    });

    // Summary statistics
    console.log(`\n${'='.repeat(80)}`);
    console.log(`SUMMARY STATISTICS`);
    console.log(`${'='.repeat(80)}`);

    const buyStreaks = streaks.filter(s => s[0].action === 'buy');
    const sellStreaks = streaks.filter(s => s[0].action === 'sell');

    console.log(`\nBuy streaks: ${buyStreaks.length}`);
    if (buyStreaks.length > 0) {
        const avgBuyStreakLen = buyStreaks.reduce((a, s) => a + s.length, 0) / buyStreaks.length;
        const maxBuyStreak = Math.max(...buyStreaks.map(s => s.length));
        console.log(`  Average length: ${avgBuyStreakLen.toFixed(1)}`);
        console.log(`  Max length: ${maxBuyStreak}`);
    }

    console.log(`\nSell streaks: ${sellStreaks.length}`);
    if (sellStreaks.length > 0) {
        const avgSellStreakLen = sellStreaks.reduce((a, s) => a + s.length, 0) / sellStreaks.length;
        const maxSellStreak = Math.max(...sellStreaks.map(s => s.length));
        console.log(`  Average length: ${avgSellStreakLen.toFixed(1)}`);
        console.log(`  Max length: ${maxSellStreak}`);
    }

    // Hypothesis: Does streak end when realSolReserves hits a threshold?
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`THRESHOLD ANALYSIS`);
    console.log(`${'─'.repeat(80)}`);

    console.log(`\nrealSolReserves at end of streaks:`);
    streaks.forEach((streak, idx) => {
        const lastTrade = streak[streak.length - 1];
        console.log(`  Streak ${idx + 1} (${streak[0].action}): ${(lastTrade.realSolReserves / 1e9).toFixed(4)} SOL`);
    });

    // Check if there's a pattern in when streaks end
    const buyEndRealSol = buyStreaks.map(s => s[s.length - 1].realSolReserves);
    const sellEndRealSol = sellStreaks.map(s => s[s.length - 1].realSolReserves);

    if (buyEndRealSol.length > 0) {
        console.log(`\nBuy streaks end at realSolReserves:`);
        console.log(`  Min: ${(Math.min(...buyEndRealSol) / 1e9).toFixed(4)} SOL`);
        console.log(`  Max: ${(Math.max(...buyEndRealSol) / 1e9).toFixed(4)} SOL`);
    }

    if (sellEndRealSol.length > 0) {
        console.log(`\nSell streaks end at realSolReserves:`);
        console.log(`  Min: ${(Math.min(...sellEndRealSol) / 1e9).toFixed(4)} SOL`);
        console.log(`  Max: ${(Math.max(...sellEndRealSol) / 1e9).toFixed(4)} SOL`);
    }
}

await analyzeNonAlternating();
