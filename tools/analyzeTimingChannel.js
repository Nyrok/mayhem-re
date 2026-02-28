#!/usr/bin/env node

/**
 * Timing Side-Channel Analyzer — Look for extra Math.random() bits
 * leaked through timing, trade amounts, or cross-token ordering.
 *
 * The Mayhem bot uses Math.random() for buy/sell decisions (1 bit per trade).
 * This script checks if MORE bits leak through:
 *   1. Inter-trade timing gaps (slot deltas, blockTime deltas)
 *   2. Trade amount precision (solAmount vs realSolReserves ratio)
 *   3. Cross-token ordering when multiple trades share a slot
 *
 * Usage:
 *   node tools/analyzeTimingChannel.js
 *   node tools/analyzeTimingChannel.js --verbose
 *
 * Data source: analysis/chronological_trades.json (1000 trades)
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const DATA_PATH = join(import.meta.dirname, '..', 'analysis', 'chronological_trades.json');
const VERBOSE = process.argv.includes('--verbose');

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function mean(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function std(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function median(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function histogram(arr, numBins = 20) {
    if (arr.length === 0) return [];
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    if (min === max) return [{ lo: min, hi: max, count: arr.length }];
    const binWidth = (max - min) / numBins;
    const bins = Array.from({ length: numBins }, (_, i) => ({
        lo: min + i * binWidth,
        hi: min + (i + 1) * binWidth,
        count: 0,
    }));
    for (const v of arr) {
        let idx = Math.floor((v - min) / binWidth);
        if (idx >= numBins) idx = numBins - 1;
        bins[idx].count++;
    }
    return bins;
}

function printHistogram(bins, label, maxBarWidth = 50) {
    const maxCount = Math.max(...bins.map(b => b.count));
    console.log(`\n  ${label}:`);
    for (const b of bins) {
        const barLen = maxCount > 0 ? Math.round((b.count / maxCount) * maxBarWidth) : 0;
        const bar = '#'.repeat(barLen);
        const range = `${b.lo.toFixed(1)}-${b.hi.toFixed(1)}`.padStart(12);
        console.log(`    ${range} | ${bar} ${b.count}`);
    }
}

/** Shannon entropy in bits for a frequency distribution */
function shannonEntropy(counts) {
    const total = counts.reduce((s, c) => s + c, 0);
    if (total === 0) return 0;
    let H = 0;
    for (const c of counts) {
        if (c === 0) continue;
        const p = c / total;
        H -= p * Math.log2(p);
    }
    return H;
}

/** Chi-squared test: observed vs expected uniform distribution */
function chiSquaredUniform(counts) {
    const total = counts.reduce((s, c) => s + c, 0);
    const expected = total / counts.length;
    let chiSq = 0;
    for (const c of counts) {
        chiSq += (c - expected) ** 2 / expected;
    }
    const df = counts.length - 1;
    // Approximate p-value using Wilson-Hilferty normal approx
    const z = Math.cbrt(chiSq / df) - (1 - 2 / (9 * df));
    const denom = Math.sqrt(2 / (9 * df));
    const zScore = z / denom;
    return { chiSq, df, zScore };
}

function sep(title) {
    console.log('\n' + '='.repeat(72));
    console.log(`  ${title}`);
    console.log('='.repeat(72));
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Load data
// ═══════════════════════════════════════════════════════════════════════════

sep('TIMING SIDE-CHANNEL ANALYSIS');
console.log(`  Data: ${DATA_PATH}`);

const raw = JSON.parse(readFileSync(DATA_PATH, 'utf-8'));
const trades = raw.trades.map(t => ({
    slot: t.slot,
    blockTime: t.blockTime,
    signature: t.signature,
    mint: t.mint,
    action: t.action,
    bit: t.bit ?? (t.action === 'buy' ? 0 : 1),
    solAmount: BigInt(t.solAmount),
    realSolReserves: BigInt(t.realSolReserves),
}));

console.log(`  Total trades: ${trades.length}`);
const mints = [...new Set(trades.map(t => t.mint))];
console.log(`  Unique mints: ${mints.length}`);
const slotRange = trades[trades.length - 1].slot - trades[0].slot;
const timeRange = trades[trades.length - 1].blockTime - trades[0].blockTime;
console.log(`  Slot range: ${trades[0].slot} - ${trades[trades.length - 1].slot} (${slotRange} slots)`);
console.log(`  Time range: ${timeRange} seconds (${(timeRange / 60).toFixed(1)} min)`);

// ═══════════════════════════════════════════════════════════════════════════
// 2. Inter-Trade Timing Analysis (Global)
// ═══════════════════════════════════════════════════════════════════════════

sep('SECTION 1: GLOBAL INTER-TRADE TIMING');

const globalSlotDeltas = [];
const globalTimeDeltas = [];
for (let i = 1; i < trades.length; i++) {
    globalSlotDeltas.push(trades[i].slot - trades[i - 1].slot);
    globalTimeDeltas.push(trades[i].blockTime - trades[i - 1].blockTime);
}

console.log('\n  Slot deltas (consecutive trades, any token):');
console.log(`    N:      ${globalSlotDeltas.length}`);
console.log(`    Mean:   ${mean(globalSlotDeltas).toFixed(3)}`);
console.log(`    Median: ${median(globalSlotDeltas)}`);
console.log(`    Std:    ${std(globalSlotDeltas).toFixed(3)}`);
console.log(`    Min:    ${Math.min(...globalSlotDeltas)}`);
console.log(`    Max:    ${Math.max(...globalSlotDeltas)}`);
console.log(`    P5:     ${percentile(globalSlotDeltas, 5)}`);
console.log(`    P95:    ${percentile(globalSlotDeltas, 95)}`);

// Distribution of slot deltas
const slotDeltaCounts = new Map();
for (const d of globalSlotDeltas) {
    slotDeltaCounts.set(d, (slotDeltaCounts.get(d) || 0) + 1);
}
const sortedSlotDeltas = [...slotDeltaCounts.entries()].sort((a, b) => a[0] - b[0]);
console.log('\n  Slot delta frequency (top values):');
const topSlotDeltas = sortedSlotDeltas.slice(0, 15);
for (const [delta, count] of topSlotDeltas) {
    const pct = (count / globalSlotDeltas.length * 100).toFixed(1);
    console.log(`    delta=${String(delta).padStart(3)}: ${String(count).padStart(4)} (${pct}%)`);
}
if (sortedSlotDeltas.length > 15) {
    console.log(`    ... (${sortedSlotDeltas.length - 15} more distinct values)`);
}

// Entropy of slot deltas
const slotDeltaEntropy = shannonEntropy([...slotDeltaCounts.values()]);
const maxEntropy = Math.log2(slotDeltaCounts.size);
console.log(`\n  Slot delta entropy: ${slotDeltaEntropy.toFixed(3)} bits (max possible: ${maxEntropy.toFixed(3)} for ${slotDeltaCounts.size} distinct values)`);
console.log(`  Entropy efficiency: ${(slotDeltaEntropy / maxEntropy * 100).toFixed(1)}%`);

// Same-slot count (delta=0)
const sameSlot = globalSlotDeltas.filter(d => d === 0).length;
console.log(`\n  Same-slot trades (delta=0): ${sameSlot} / ${globalSlotDeltas.length} (${(sameSlot / globalSlotDeltas.length * 100).toFixed(1)}%)`);

console.log('\n  BlockTime deltas (seconds):');
console.log(`    Mean:   ${mean(globalTimeDeltas).toFixed(3)}`);
console.log(`    Median: ${median(globalTimeDeltas)}`);
console.log(`    Std:    ${std(globalTimeDeltas).toFixed(3)}`);
console.log(`    Min:    ${Math.min(...globalTimeDeltas)}`);
console.log(`    Max:    ${Math.max(...globalTimeDeltas)}`);

const timeDeltaCounts = new Map();
for (const d of globalTimeDeltas) {
    timeDeltaCounts.set(d, (timeDeltaCounts.get(d) || 0) + 1);
}
console.log('\n  BlockTime delta frequency:');
for (const [delta, count] of [...timeDeltaCounts.entries()].sort((a, b) => a[0] - b[0])) {
    const pct = (count / globalTimeDeltas.length * 100).toFixed(1);
    console.log(`    delta=${String(delta).padStart(3)}s: ${String(count).padStart(4)} (${pct}%)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Per-Token Timing Analysis
// ═══════════════════════════════════════════════════════════════════════════

sep('SECTION 2: PER-TOKEN INTER-TRADE TIMING');

const tradesByMint = new Map();
for (const t of trades) {
    if (!tradesByMint.has(t.mint)) tradesByMint.set(t.mint, []);
    tradesByMint.get(t.mint).push(t);
}

const perTokenSlotDeltas = [];
const perTokenTimeDeltas = [];
for (const [mint, mintTrades] of tradesByMint) {
    for (let i = 1; i < mintTrades.length; i++) {
        perTokenSlotDeltas.push(mintTrades[i].slot - mintTrades[i - 1].slot);
        perTokenTimeDeltas.push(mintTrades[i].blockTime - mintTrades[i - 1].blockTime);
    }
}

console.log('\n  Slot deltas (consecutive trades, same token):');
console.log(`    N:      ${perTokenSlotDeltas.length}`);
console.log(`    Mean:   ${mean(perTokenSlotDeltas).toFixed(3)}`);
console.log(`    Median: ${median(perTokenSlotDeltas)}`);
console.log(`    Std:    ${std(perTokenSlotDeltas).toFixed(3)}`);
console.log(`    Min:    ${Math.min(...perTokenSlotDeltas)}`);
console.log(`    Max:    ${Math.max(...perTokenSlotDeltas)}`);

const perTokenSlotDeltaCounts = new Map();
for (const d of perTokenSlotDeltas) {
    perTokenSlotDeltaCounts.set(d, (perTokenSlotDeltaCounts.get(d) || 0) + 1);
}
console.log('\n  Per-token slot delta frequency (top values):');
const topPerToken = [...perTokenSlotDeltaCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
for (const [delta, count] of topPerToken.sort((a, b) => a[0] - b[0])) {
    const pct = (count / perTokenSlotDeltas.length * 100).toFixed(1);
    console.log(`    delta=${String(delta).padStart(4)}: ${String(count).padStart(4)} (${pct}%)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Slot Delta vs Buy/Sell Correlation
// ═══════════════════════════════════════════════════════════════════════════

sep('SECTION 3: SLOT DELTA vs BUY/SELL CORRELATION');

// Does the slot gap predict the next trade's action?
const deltaVsBit = new Map(); // delta -> { buys, sells }
for (let i = 1; i < trades.length; i++) {
    const delta = trades[i].slot - trades[i - 1].slot;
    if (!deltaVsBit.has(delta)) deltaVsBit.set(delta, { buys: 0, sells: 0 });
    const entry = deltaVsBit.get(delta);
    if (trades[i].action === 'buy') entry.buys++;
    else entry.sells++;
}

console.log('\n  Slot delta -> buy/sell ratio (does timing predict the decision?):');
const significantDeltas = [...deltaVsBit.entries()]
    .filter(([, v]) => v.buys + v.sells >= 5)
    .sort((a, b) => a[0] - b[0]);

let totalCorrelationDeviation = 0;
let totalCorrelationSamples = 0;
for (const [delta, { buys, sells }] of significantDeltas) {
    const total = buys + sells;
    const buyPct = (buys / total * 100).toFixed(1);
    const sellPct = (sells / total * 100).toFixed(1);
    const deviation = Math.abs(buys / total - 0.5);
    totalCorrelationDeviation += deviation * total;
    totalCorrelationSamples += total;
    const flag = deviation > 0.15 ? ' <-- BIASED' : '';
    console.log(`    delta=${String(delta).padStart(4)}: buy=${buyPct}% sell=${sellPct}% (n=${total})${flag}`);
}

const avgDeviation = totalCorrelationSamples > 0
    ? (totalCorrelationDeviation / totalCorrelationSamples * 100).toFixed(2)
    : '0.00';
console.log(`\n  Weighted average deviation from 50/50: ${avgDeviation}%`);
console.log(`  Interpretation: ${parseFloat(avgDeviation) < 5 ? 'No significant correlation (timing does NOT predict action)' : 'SIGNIFICANT correlation found!'}`);

// ═══════════════════════════════════════════════════════════════════════════
// 5. Trade Amount Analysis (solAmount / realSolReserves ratio)
// ═══════════════════════════════════════════════════════════════════════════

sep('SECTION 4: TRADE AMOUNT ANALYSIS');

// The bot supposedly uses realSolReserves/6 for buys, realSolReserves/4 for sells.
// Check if there's any variation that could encode additional random bits.

const buyRatios = [];
const sellRatios = [];
const buyRemainders = [];
const sellRemainders = [];

for (const t of trades) {
    // Ratio = realSolReserves / solAmount
    // For buys: expected ~6.0, for sells: expected ~4.0
    const ratio = Number(t.realSolReserves) / Number(t.solAmount);

    if (t.action === 'buy') {
        buyRatios.push(ratio);
        // Check remainder: realSolReserves mod (solAmount * 6) or similar
        // More precisely: solAmount = realSolReserves / 6 (integer division)
        // So remainder = realSolReserves - solAmount * 6
        const expectedAmount = t.realSolReserves / 6n;
        const remainder = Number(t.realSolReserves - t.solAmount * 6n);
        buyRemainders.push(remainder);
    } else {
        sellRatios.push(ratio);
        const expectedAmount = t.realSolReserves / 4n;
        const remainder = Number(t.realSolReserves - t.solAmount * 4n);
        sellRemainders.push(remainder);
    }
}

console.log('\n  BUY trades (expected ratio = realSolReserves / solAmount = 6.0):');
console.log(`    N:      ${buyRatios.length}`);
console.log(`    Mean:   ${mean(buyRatios).toFixed(8)}`);
console.log(`    Std:    ${std(buyRatios).toFixed(8)}`);
console.log(`    Min:    ${Math.min(...buyRatios).toFixed(8)}`);
console.log(`    Max:    ${Math.max(...buyRatios).toFixed(8)}`);
const buyExactly6 = buyRatios.filter(r => Math.abs(r - 6.0) < 0.0001).length;
console.log(`    Exactly 6.0 (within 0.0001): ${buyExactly6} / ${buyRatios.length} (${(buyExactly6 / buyRatios.length * 100).toFixed(1)}%)`);

console.log('\n  BUY remainder analysis (realSolReserves - solAmount * 6):');
console.log(`    Mean:   ${mean(buyRemainders).toFixed(3)}`);
console.log(`    Std:    ${std(buyRemainders).toFixed(3)}`);
console.log(`    Min:    ${Math.min(...buyRemainders)}`);
console.log(`    Max:    ${Math.max(...buyRemainders)}`);
const buyRemainderCounts = new Map();
for (const r of buyRemainders) {
    buyRemainderCounts.set(r, (buyRemainderCounts.get(r) || 0) + 1);
}
console.log(`    Distinct remainders: ${buyRemainderCounts.size}`);
if (buyRemainderCounts.size <= 10) {
    for (const [r, c] of [...buyRemainderCounts.entries()].sort((a, b) => a[0] - b[0])) {
        console.log(`      remainder=${r}: ${c} times`);
    }
}

console.log('\n  SELL trades (expected ratio = realSolReserves / solAmount = 4.0):');
console.log(`    N:      ${sellRatios.length}`);
console.log(`    Mean:   ${mean(sellRatios).toFixed(8)}`);
console.log(`    Std:    ${std(sellRatios).toFixed(8)}`);
console.log(`    Min:    ${Math.min(...sellRatios).toFixed(8)}`);
console.log(`    Max:    ${Math.max(...sellRatios).toFixed(8)}`);
const sellExactly4 = sellRatios.filter(r => Math.abs(r - 4.0) < 0.0001).length;
console.log(`    Exactly 4.0 (within 0.0001): ${sellExactly4} / ${sellRatios.length} (${(sellExactly4 / sellRatios.length * 100).toFixed(1)}%)`);

console.log('\n  SELL remainder analysis (realSolReserves - solAmount * 4):');
console.log(`    Mean:   ${mean(sellRemainders).toFixed(3)}`);
console.log(`    Std:    ${std(sellRemainders).toFixed(3)}`);
console.log(`    Min:    ${Math.min(...sellRemainders)}`);
console.log(`    Max:    ${Math.max(...sellRemainders)}`);
const sellRemainderCounts = new Map();
for (const r of sellRemainders) {
    sellRemainderCounts.set(r, (sellRemainderCounts.get(r) || 0) + 1);
}
console.log(`    Distinct remainders: ${sellRemainderCounts.size}`);
if (sellRemainderCounts.size <= 10) {
    for (const [r, c] of [...sellRemainderCounts.entries()].sort((a, b) => a[0] - b[0])) {
        console.log(`      remainder=${r}: ${c} times`);
    }
}

// Check last N digits of solAmount for hidden randomness
console.log('\n  Last-digit analysis of solAmount (looking for hidden random bits):');
for (const mod of [10, 100, 1000]) {
    const buyLastDigits = trades.filter(t => t.action === 'buy').map(t => Number(t.solAmount % BigInt(mod)));
    const sellLastDigits = trades.filter(t => t.action === 'sell').map(t => Number(t.solAmount % BigInt(mod)));

    const buyDigitCounts = new Map();
    for (const d of buyLastDigits) buyDigitCounts.set(d, (buyDigitCounts.get(d) || 0) + 1);
    const sellDigitCounts = new Map();
    for (const d of sellLastDigits) sellDigitCounts.set(d, (sellDigitCounts.get(d) || 0) + 1);

    const buyEntropy = shannonEntropy([...buyDigitCounts.values()]);
    const sellEntropy = shannonEntropy([...sellDigitCounts.values()]);
    const maxEnt = Math.log2(mod);

    console.log(`    mod ${String(mod).padStart(4)}: buy distinct=${buyDigitCounts.size}/${mod} entropy=${buyEntropy.toFixed(2)}/${maxEnt.toFixed(2)} bits | sell distinct=${sellDigitCounts.size}/${mod} entropy=${sellEntropy.toFixed(2)}/${maxEnt.toFixed(2)} bits`);
}

// Deeper: does the fractional part of the ratio encode bits?
console.log('\n  Fractional part of ratio (realSolReserves / solAmount):');
const buyFractional = buyRatios.map(r => r - Math.floor(r));
const sellFractional = sellRatios.map(r => r - Math.floor(r));
console.log(`    Buy fractional parts:  mean=${mean(buyFractional).toFixed(6)} std=${std(buyFractional).toFixed(6)}`);
console.log(`    Sell fractional parts: mean=${mean(sellFractional).toFixed(6)} std=${std(sellFractional).toFixed(6)}`);

// Bin fractional parts into 16 bins to check uniformity
const buyFracBins = Array(16).fill(0);
for (const f of buyFractional) {
    const idx = Math.min(Math.floor(f * 16), 15);
    buyFracBins[idx]++;
}
const sellFracBins = Array(16).fill(0);
for (const f of sellFractional) {
    const idx = Math.min(Math.floor(f * 16), 15);
    sellFracBins[idx]++;
}

const buyFracChi = chiSquaredUniform(buyFracBins);
const sellFracChi = chiSquaredUniform(sellFracBins);
console.log(`    Buy fractional chi-sq: chi2=${buyFracChi.chiSq.toFixed(2)} df=${buyFracChi.df} z=${buyFracChi.zScore.toFixed(2)} ${Math.abs(buyFracChi.zScore) > 2 ? '<-- NON-UNIFORM' : '(uniform)'}`);
console.log(`    Sell fractional chi-sq: chi2=${sellFracChi.chiSq.toFixed(2)} df=${sellFracChi.df} z=${sellFracChi.zScore.toFixed(2)} ${Math.abs(sellFracChi.zScore) > 2 ? '<-- NON-UNIFORM' : '(uniform)'}`);

if (VERBOSE) {
    console.log('\n    Buy fractional histogram (16 bins):');
    for (let i = 0; i < 16; i++) {
        const lo = (i / 16).toFixed(4);
        const hi = ((i + 1) / 16).toFixed(4);
        const bar = '#'.repeat(Math.round(buyFracBins[i] / buyRatios.length * 200));
        console.log(`      ${lo}-${hi}: ${String(buyFracBins[i]).padStart(4)} ${bar}`);
    }
    console.log('    Sell fractional histogram (16 bins):');
    for (let i = 0; i < 16; i++) {
        const lo = (i / 16).toFixed(4);
        const hi = ((i + 1) / 16).toFixed(4);
        const bar = '#'.repeat(Math.round(sellFracBins[i] / sellRatios.length * 200));
        console.log(`      ${lo}-${hi}: ${String(sellFracBins[i]).padStart(4)} ${bar}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Cross-Token Ordering Analysis (Same-Slot Trades)
// ═══════════════════════════════════════════════════════════════════════════

sep('SECTION 5: CROSS-TOKEN ORDERING (SAME-SLOT TRADES)');

// Group trades by slot
const tradesBySlot = new Map();
for (let i = 0; i < trades.length; i++) {
    const slot = trades[i].slot;
    if (!tradesBySlot.has(slot)) tradesBySlot.set(slot, []);
    tradesBySlot.get(slot).push({ ...trades[i], globalIndex: i });
}

const multiTokenSlots = [...tradesBySlot.entries()]
    .filter(([, ts]) => {
        const distinctMints = new Set(ts.map(t => t.mint));
        return distinctMints.size > 1;
    })
    .sort((a, b) => a[0] - b[0]);

console.log(`\n  Slots with trades on multiple tokens: ${multiTokenSlots.length}`);
console.log(`  Total slots: ${tradesBySlot.size}`);
console.log(`  Multi-token slot rate: ${(multiTokenSlots.length / tradesBySlot.size * 100).toFixed(1)}%`);

if (multiTokenSlots.length > 0) {
    // For each multi-token slot, determine the ordering of mints
    // Is it always alphabetical? Random? Correlated with action?
    let alphabeticalCount = 0;
    let reverseAlphabeticalCount = 0;
    let otherOrderCount = 0;

    // Track first-mint action distribution
    let firstMintBuy = 0;
    let firstMintSell = 0;

    // Pairwise ordering consistency
    const pairOrderings = new Map(); // "mintA|mintB" -> { aFirst: n, bFirst: n }

    for (const [slot, slotTrades] of multiTokenSlots) {
        // Order mints by their first appearance in this slot
        const mintOrder = [];
        for (const t of slotTrades) {
            if (!mintOrder.includes(t.mint)) mintOrder.push(t.mint);
        }

        if (mintOrder.length >= 2) {
            const sorted = [...mintOrder].sort();
            if (mintOrder.every((m, i) => m === sorted[i])) alphabeticalCount++;
            else if (mintOrder.every((m, i) => m === sorted[sorted.length - 1 - i])) reverseAlphabeticalCount++;
            else otherOrderCount++;

            // Track first trade action
            if (slotTrades[0].action === 'buy') firstMintBuy++;
            else firstMintSell++;

            // Pairwise analysis
            for (let i = 0; i < mintOrder.length; i++) {
                for (let j = i + 1; j < mintOrder.length; j++) {
                    const [a, b] = [mintOrder[i], mintOrder[j]].sort();
                    const key = `${a}|${b}`;
                    if (!pairOrderings.has(key)) pairOrderings.set(key, { aFirst: 0, bFirst: 0 });
                    const entry = pairOrderings.get(key);
                    if (mintOrder[i] === a) entry.aFirst++;
                    else entry.bFirst++;
                }
            }
        }

        if (VERBOSE && multiTokenSlots.indexOf([slot, slotTrades]) < 10) {
            console.log(`    Slot ${slot}: ${slotTrades.map(t => `${t.mint.slice(0, 8)}(${t.action})`).join(' -> ')}`);
        }
    }

    console.log(`\n  Ordering pattern (${multiTokenSlots.length} multi-token slots):`);
    console.log(`    Alphabetical:         ${alphabeticalCount} (${(alphabeticalCount / multiTokenSlots.length * 100).toFixed(1)}%)`);
    console.log(`    Reverse alphabetical: ${reverseAlphabeticalCount} (${(reverseAlphabeticalCount / multiTokenSlots.length * 100).toFixed(1)}%)`);
    console.log(`    Other ordering:       ${otherOrderCount} (${(otherOrderCount / multiTokenSlots.length * 100).toFixed(1)}%)`);

    console.log(`\n  First trade in multi-token slot:`);
    console.log(`    Buy:  ${firstMintBuy} (${(firstMintBuy / (firstMintBuy + firstMintSell) * 100).toFixed(1)}%)`);
    console.log(`    Sell: ${firstMintSell} (${(firstMintSell / (firstMintBuy + firstMintSell) * 100).toFixed(1)}%)`);

    // Pairwise consistency
    if (pairOrderings.size > 0) {
        console.log(`\n  Pairwise ordering consistency (${pairOrderings.size} unique token pairs):`);
        let deterministic = 0;
        let random = 0;
        for (const [pair, { aFirst, bFirst }] of pairOrderings) {
            const total = aFirst + bFirst;
            if (total < 2) continue;
            const maxPct = Math.max(aFirst, bFirst) / total;
            if (maxPct > 0.9) deterministic++;
            else random++;
            if (VERBOSE || total >= 5) {
                const [a, b] = pair.split('|');
                console.log(`    ${a.slice(0, 8)}|${b.slice(0, 8)}: A-first=${aFirst} B-first=${bFirst} (${(maxPct * 100).toFixed(0)}% consistent) ${maxPct > 0.9 ? 'DETERMINISTIC' : 'VARIABLE'}`);
            }
        }
        console.log(`\n    Deterministic pairs (>90% one order): ${deterministic}`);
        console.log(`    Variable pairs (random-looking):      ${random}`);

        if (random > 0) {
            console.log(`\n    ** POTENTIAL SIDE-CHANNEL: ${random} token pair(s) with variable ordering!`);
            console.log(`       Each multi-token slot could leak ~${Math.log2(Math.max(2, pairOrderings.size)).toFixed(1)} bits of random state.`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Slot Delta Autocorrelation (Are consecutive gaps correlated?)
// ═══════════════════════════════════════════════════════════════════════════

sep('SECTION 6: SLOT DELTA AUTOCORRELATION');

// If slot deltas are iid, autocorrelation should be ~0
// If the timing encodes PRNG state, consecutive deltas might be correlated
function autocorrelation(arr, lag) {
    if (arr.length <= lag) return 0;
    const m = mean(arr);
    const s = std(arr);
    if (s === 0) return 0;
    let sum = 0;
    for (let i = 0; i < arr.length - lag; i++) {
        sum += (arr[i] - m) * (arr[i + lag] - m);
    }
    return sum / ((arr.length - lag) * s * s);
}

console.log('\n  Autocorrelation of global slot deltas:');
for (let lag = 1; lag <= 10; lag++) {
    const ac = autocorrelation(globalSlotDeltas, lag);
    const significant = Math.abs(ac) > 2 / Math.sqrt(globalSlotDeltas.length);
    const bar = '#'.repeat(Math.round(Math.abs(ac) * 50));
    const sign = ac >= 0 ? '+' : '-';
    console.log(`    lag ${String(lag).padStart(2)}: ${sign}${Math.abs(ac).toFixed(4)} ${bar} ${significant ? '<-- SIGNIFICANT' : ''}`);
}

// Autocorrelation of per-token slot deltas
if (perTokenSlotDeltas.length > 20) {
    console.log('\n  Autocorrelation of per-token slot deltas:');
    for (let lag = 1; lag <= 5; lag++) {
        const ac = autocorrelation(perTokenSlotDeltas, lag);
        const significant = Math.abs(ac) > 2 / Math.sqrt(perTokenSlotDeltas.length);
        const bar = '#'.repeat(Math.round(Math.abs(ac) * 50));
        const sign = ac >= 0 ? '+' : '-';
        console.log(`    lag ${String(lag).padStart(2)}: ${sign}${Math.abs(ac).toFixed(4)} ${bar} ${significant ? '<-- SIGNIFICANT' : ''}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Conditional Timing: Does buy/sell affect NEXT timing?
// ═══════════════════════════════════════════════════════════════════════════

sep('SECTION 7: CONDITIONAL TIMING (action -> next slot delta)');

// If the PRNG generates both the action bit AND the timing,
// the action and subsequent timing could be correlated.
const afterBuyDeltas = [];
const afterSellDeltas = [];
for (let i = 0; i < trades.length - 1; i++) {
    const delta = trades[i + 1].slot - trades[i].slot;
    if (trades[i].action === 'buy') afterBuyDeltas.push(delta);
    else afterSellDeltas.push(delta);
}

console.log('\n  Slot delta after BUY:');
console.log(`    N:      ${afterBuyDeltas.length}`);
console.log(`    Mean:   ${mean(afterBuyDeltas).toFixed(3)}`);
console.log(`    Median: ${median(afterBuyDeltas)}`);
console.log(`    Std:    ${std(afterBuyDeltas).toFixed(3)}`);

console.log('\n  Slot delta after SELL:');
console.log(`    N:      ${afterSellDeltas.length}`);
console.log(`    Mean:   ${mean(afterSellDeltas).toFixed(3)}`);
console.log(`    Median: ${median(afterSellDeltas)}`);
console.log(`    Std:    ${std(afterSellDeltas).toFixed(3)}`);

// Two-sample t-test approximation
const meanDiff = Math.abs(mean(afterBuyDeltas) - mean(afterSellDeltas));
const pooledSE = Math.sqrt(
    (std(afterBuyDeltas) ** 2 / afterBuyDeltas.length) +
    (std(afterSellDeltas) ** 2 / afterSellDeltas.length)
);
const tStat = pooledSE > 0 ? meanDiff / pooledSE : 0;
console.log(`\n  Two-sample t-test: t=${tStat.toFixed(3)} ${Math.abs(tStat) > 2 ? '<-- SIGNIFICANT (timing differs after buy vs sell!)' : '(no significant difference)'}`);

// ═══════════════════════════════════════════════════════════════════════════
// 9. Intra-Slot Trade Position Analysis
// ═══════════════════════════════════════════════════════════════════════════

sep('SECTION 8: INTRA-SLOT POSITION ANALYSIS');

// Within a slot, what determines the order of the bot's transactions?
// If the bot submits 2 txs in same slot, which goes first?
const multiTxSlots = [...tradesBySlot.entries()]
    .filter(([, ts]) => ts.length >= 2)
    .sort((a, b) => a[0] - b[0]);

console.log(`\n  Slots with 2+ bot trades: ${multiTxSlots.length}`);

if (multiTxSlots.length > 0) {
    // Check: in slots with exactly 2 trades, what's the action pattern?
    const twoTradeSlots = multiTxSlots.filter(([, ts]) => ts.length === 2);
    const patterns = new Map();
    for (const [, ts] of twoTradeSlots) {
        const pat = ts.map(t => t.action).join(',');
        patterns.set(pat, (patterns.get(pat) || 0) + 1);
    }
    console.log(`\n  Two-trade slots (${twoTradeSlots.length}), action patterns:`);
    for (const [pat, count] of [...patterns.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${pat}: ${count} (${(count / twoTradeSlots.length * 100).toFixed(1)}%)`);
    }

    // Check: different mints or same mint in multi-trade slots?
    let sameTokenMulti = 0;
    let diffTokenMulti = 0;
    for (const [, ts] of multiTxSlots) {
        const uniqueMints = new Set(ts.map(t => t.mint));
        if (uniqueMints.size === 1) sameTokenMulti++;
        else diffTokenMulti++;
    }
    console.log(`\n  Multi-trade slots: same token=${sameTokenMulti}, different tokens=${diffTokenMulti}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. Bit-Level Analysis: Low Bits of Numerical Fields
// ═══════════════════════════════════════════════════════════════════════════

sep('SECTION 9: LOW-BIT ANALYSIS OF NUMERICAL FIELDS');

// Check if low bits of solAmount, realSolReserves, or slot encode information
console.log('\n  Checking low bits of solAmount for hidden random bits:');
for (let bitPos = 0; bitPos < 8; bitPos++) {
    const bitValues = trades.map(t => Number((t.solAmount >> BigInt(bitPos)) & 1n));
    const ones = bitValues.filter(b => b === 1).length;
    const pct = (ones / bitValues.length * 100).toFixed(1);
    // Correlate with action
    let sameAsAction = 0;
    for (let i = 0; i < trades.length; i++) {
        if (bitValues[i] === trades[i].bit) sameAsAction++;
    }
    const corrPct = (sameAsAction / trades.length * 100).toFixed(1);
    console.log(`    bit ${bitPos}: ${pct}% ones, ${corrPct}% correlate with action ${Math.abs(parseFloat(corrPct) - 50) > 5 ? '<-- CORRELATED' : ''}`);
}

console.log('\n  Checking low bits of realSolReserves:');
for (let bitPos = 0; bitPos < 8; bitPos++) {
    const bitValues = trades.map(t => Number((t.realSolReserves >> BigInt(bitPos)) & 1n));
    const ones = bitValues.filter(b => b === 1).length;
    const pct = (ones / bitValues.length * 100).toFixed(1);
    let sameAsAction = 0;
    for (let i = 0; i < trades.length; i++) {
        if (bitValues[i] === trades[i].bit) sameAsAction++;
    }
    const corrPct = (sameAsAction / trades.length * 100).toFixed(1);
    console.log(`    bit ${bitPos}: ${pct}% ones, ${corrPct}% correlate with action ${Math.abs(parseFloat(corrPct) - 50) > 5 ? '<-- CORRELATED' : ''}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 11. Summary & Verdict
// ═══════════════════════════════════════════════════════════════════════════

sep('VERDICT: SIDE-CHANNEL SUMMARY');

const findings = [];

// Timing verdict
if (Math.abs(tStat) > 2) {
    findings.push('TIMING: Slot delta differs after buy vs sell -- possible bit leakage via timing');
} else {
    findings.push('TIMING: No significant correlation between action and subsequent timing');
}

// Amount verdict
const buyRatioStd = std(buyRatios);
const sellRatioStd = std(sellRatios);
if (buyRatioStd < 0.01 && sellRatioStd < 0.01) {
    findings.push(`AMOUNTS: Ratios are near-exact (buy std=${buyRatioStd.toFixed(6)}, sell std=${sellRatioStd.toFixed(6)}) -- no extra bits in amounts`);
} else {
    findings.push(`AMOUNTS: Ratio variation detected (buy std=${buyRatioStd.toFixed(6)}, sell std=${sellRatioStd.toFixed(6)}) -- POSSIBLE extra bits`);
}

// Ordering verdict
if (multiTokenSlots.length > 0) {
    const totalPairs = [...(new Map([...tradesBySlot.entries()]
        .filter(([, ts]) => new Set(ts.map(t => t.mint)).size > 1)
        .map(([slot, ts]) => {
            const mintOrder = [];
            for (const t of ts) if (!mintOrder.includes(t.mint)) mintOrder.push(t.mint);
            return [slot, mintOrder];
        })))].length; // simplified
    findings.push(`ORDERING: ${multiTokenSlots.length} multi-token slots found -- check pairwise analysis above`);
} else {
    findings.push('ORDERING: No multi-token slots found (single token active at a time)');
}

// Autocorrelation verdict
const lag1AC = autocorrelation(globalSlotDeltas, 1);
if (Math.abs(lag1AC) > 2 / Math.sqrt(globalSlotDeltas.length)) {
    findings.push(`AUTOCORRELATION: Significant lag-1 correlation (${lag1AC.toFixed(4)}) in slot deltas -- timing is NOT iid`);
} else {
    findings.push(`AUTOCORRELATION: No significant lag-1 correlation (${lag1AC.toFixed(4)}) -- timing looks independent`);
}

// Low-bit verdict (solAmount)
const solAmtBitCorrelations = [];
for (let bitPos = 0; bitPos < 8; bitPos++) {
    const bitValues = trades.map(t => Number((t.solAmount >> BigInt(bitPos)) & 1n));
    let sameAsAction = 0;
    for (let i = 0; i < trades.length; i++) {
        if (bitValues[i] === trades[i].bit) sameAsAction++;
    }
    const corrPct = sameAsAction / trades.length * 100;
    if (Math.abs(corrPct - 50) > 5) {
        solAmtBitCorrelations.push({ bit: bitPos, corr: corrPct });
    }
}
if (solAmtBitCorrelations.length > 0) {
    findings.push(`LOW BITS (solAmount): bits [${solAmtBitCorrelations.map(b => b.bit).join(',')}] correlate with action -- POSSIBLE extra bits`);
} else {
    findings.push('LOW BITS (solAmount): No significant correlation between solAmount bits and buy/sell action');
}

// Low-bit verdict (realSolReserves)
const reservesBitCorrelations = [];
for (let bitPos = 0; bitPos < 8; bitPos++) {
    const bitValues = trades.map(t => Number((t.realSolReserves >> BigInt(bitPos)) & 1n));
    let sameAsAction = 0;
    for (let i = 0; i < trades.length; i++) {
        if (bitValues[i] === trades[i].bit) sameAsAction++;
    }
    const corrPct = sameAsAction / trades.length * 100;
    if (Math.abs(corrPct - 50) > 5) {
        reservesBitCorrelations.push({ bit: bitPos, corr: corrPct.toFixed(1) });
    }
}
if (reservesBitCorrelations.length > 0) {
    findings.push(`LOW BITS (realSolReserves): bits [${reservesBitCorrelations.map(b => `${b.bit}(${b.corr}%)`).join(', ')}] correlate with action`);
    findings.push('  NOTE: This is expected -- realSolReserves changes BY the solAmount each trade,');
    findings.push('  so its low bits are a CONSEQUENCE of the action, not an independent leak.');
} else {
    findings.push('LOW BITS (realSolReserves): No significant correlation');
}

// Remainder verdict
const buyRemDistinct = buyRemainderCounts.size;
const sellRemDistinct = sellRemainderCounts.size;
if (buyRemDistinct <= 6 && sellRemDistinct <= 6) {
    findings.push(`REMAINDERS: Buy remainders {0..${buyRemDistinct - 1}}, Sell remainders {${Math.min(...sellRemainderCounts.keys())}..${Math.max(...sellRemainderCounts.keys())}} -- just integer division artifacts, no extra bits`);
} else {
    findings.push(`REMAINDERS: Buy ${buyRemDistinct} distinct, Sell ${sellRemDistinct} distinct -- worth investigating`);
}

// Cross-token ordering verdict (refined)
if (multiTokenSlots.length >= 10) {
    // Count variable pairs from earlier analysis
    let variablePairCount = 0;
    // Re-derive since pairOrderings is scoped above
    const pairOrds2 = new Map();
    for (const [, slotTrades] of multiTokenSlots) {
        const mintOrder2 = [];
        for (const t of slotTrades) {
            if (!mintOrder2.includes(t.mint)) mintOrder2.push(t.mint);
        }
        for (let i = 0; i < mintOrder2.length; i++) {
            for (let j = i + 1; j < mintOrder2.length; j++) {
                const [a, b] = [mintOrder2[i], mintOrder2[j]].sort();
                const key = `${a}|${b}`;
                if (!pairOrds2.has(key)) pairOrds2.set(key, { aFirst: 0, bFirst: 0 });
                const entry = pairOrds2.get(key);
                if (mintOrder2[i] === a) entry.aFirst++;
                else entry.bFirst++;
            }
        }
    }
    for (const [, { aFirst, bFirst }] of pairOrds2) {
        const total = aFirst + bFirst;
        if (total < 2) continue;
        const maxPct = Math.max(aFirst, bFirst) / total;
        if (maxPct <= 0.9) variablePairCount++;
    }
    if (variablePairCount > 0) {
        findings.push(`CROSS-TOKEN ORDERING: ${variablePairCount}/${pairOrds2.size} pairs have variable (non-deterministic) ordering`);
        findings.push(`  ** This is the STRONGEST side-channel candidate -- each multi-token slot could leak ~1 bit per pair`);
    } else {
        findings.push('CROSS-TOKEN ORDERING: All pairs have deterministic ordering -- no extra bits');
    }
}

// Slot delta bias verdict
if (parseFloat(avgDeviation) > 5) {
    findings.push(`SLOT-DELTA BIAS: ${avgDeviation}% weighted deviation from 50/50 -- slot timing is weakly correlated with action`);
    findings.push('  NOTE: Could be structural (buy/sell have different processing times) rather than PRNG leakage');
}

console.log('');
for (const f of findings) {
    console.log(`  ${f}`);
}

const hasLeakage = findings.some(f =>
    f.includes('POSSIBLE') ||
    f.includes('SIGNIFICANT') ||
    f.includes('leakage') ||
    f.includes('STRONGEST side-channel')
);
console.log(`\n  OVERALL: ${hasLeakage
    ? 'Potential side-channels detected! Cross-token ordering is the most promising avenue.'
    : 'No strong evidence of additional bit leakage beyond the buy/sell action bit.'}`);
console.log('');
