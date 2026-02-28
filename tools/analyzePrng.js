#!/usr/bin/env node

/**
 * PRNG Analyzer — Analyze Mayhem bot's buy/sell decision sequence
 *
 * Extracts binary sequences (buy=0, sell=1) from saved datasets,
 * runs statistical tests to determine if the PRNG is cryptographic or not,
 * and checks cross-token continuity.
 *
 * Usage:
 *   node tools/analyzePrng.js                    # analyze all datasets
 *   node tools/analyzePrng.js --verbose           # show per-token details
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const TOKENS_DIR = join(import.meta.dirname, '..', 'analysis', 'tokens');

// ═══════════════════════════════════════════════════════════════════════════
// 1. Data Extraction
// ═══════════════════════════════════════════════════════════════════════════

function loadAllTokens() {
    const files = readdirSync(TOKENS_DIR).filter(f => f.endsWith('.json'));
    const tokens = [];

    for (const file of files) {
        const data = JSON.parse(readFileSync(join(TOKENS_DIR, file), 'utf-8'));
        const trades = data.trades.map(t => ({
            action: t.action,     // "buy" or "sell"
            bit: t.action === 'buy' ? 0 : 1,
            slot: t.slot,
            blockTime: t.blockTime,
            mint: t.mint,
        }));
        tokens.push({
            mint: data.mint,
            file,
            firstSlot: trades[0]?.slot ?? 0,
            firstBlockTime: trades[0]?.blockTime ?? 0,
            trades,
        });
    }

    // Sort tokens chronologically by first trade slot
    tokens.sort((a, b) => a.firstSlot - b.firstSlot);
    return tokens;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Statistical Tests
// ═══════════════════════════════════════════════════════════════════════════

/** Proportion of 1s (sells) in the sequence */
function proportionTest(bits) {
    const ones = bits.filter(b => b === 1).length;
    const p = ones / bits.length;
    // Z-test for proportion = 0.5
    const z = (p - 0.5) / Math.sqrt(0.25 / bits.length);
    return { proportion: p, z, pValue: 2 * (1 - normalCDF(Math.abs(z))) };
}

/** Runs test — counts consecutive sequences of same value */
function runsTest(bits) {
    const n = bits.length;
    const n1 = bits.filter(b => b === 1).length;
    const n0 = n - n1;

    // Count runs
    let runs = 1;
    for (let i = 1; i < n; i++) {
        if (bits[i] !== bits[i - 1]) runs++;
    }

    // Expected runs and variance under H0 (random)
    const expectedRuns = 1 + (2 * n0 * n1) / n;
    const variance = (2 * n0 * n1 * (2 * n0 * n1 - n)) / (n * n * (n - 1));
    const z = (runs - expectedRuns) / Math.sqrt(variance);

    return {
        runs,
        expectedRuns: expectedRuns.toFixed(1),
        z: z.toFixed(3),
        pValue: 2 * (1 - normalCDF(Math.abs(z))),
        interpretation: Math.abs(z) > 2.58
            ? (z > 0 ? 'TOO MANY RUNS (anti-clustering / alternating bias)' : 'TOO FEW RUNS (clustering bias)')
            : 'CONSISTENT WITH RANDOM',
    };
}

/** Autocorrelation at various lags */
function autocorrelation(bits, maxLag = 20) {
    const n = bits.length;
    const mean = bits.reduce((s, b) => s + b, 0) / n;
    const variance = bits.reduce((s, b) => s + (b - mean) ** 2, 0) / n;

    const results = [];
    for (let lag = 1; lag <= Math.min(maxLag, n - 1); lag++) {
        let sum = 0;
        for (let i = 0; i < n - lag; i++) {
            sum += (bits[i] - mean) * (bits[i + lag] - mean);
        }
        const r = sum / ((n - lag) * variance);
        // 95% CI for white noise: ±1.96/√n
        const ci = 1.96 / Math.sqrt(n);
        results.push({
            lag,
            r: r.toFixed(4),
            significant: Math.abs(r) > ci,
        });
    }
    return results;
}

/** Frequency of n-grams (overlapping windows of size k) */
function ngramFrequency(bits, k) {
    const counts = {};
    const total = bits.length - k + 1;
    for (let i = 0; i <= bits.length - k; i++) {
        const key = bits.slice(i, i + k).join('');
        counts[key] = (counts[key] || 0) + 1;
    }

    // Chi-squared test: all 2^k patterns should be equally likely
    const expected = total / (2 ** k);
    let chiSq = 0;
    const allPatterns = 2 ** k;
    for (let p = 0; p < allPatterns; p++) {
        const key = p.toString(2).padStart(k, '0');
        const observed = counts[key] || 0;
        chiSq += (observed - expected) ** 2 / expected;
    }

    const df = allPatterns - 1;
    // Approximate p-value using chi-squared distribution
    const pValue = 1 - chiSquaredCDF(chiSq, df);

    return { k, counts, chiSq: chiSq.toFixed(2), df, pValue, expected: expected.toFixed(1) };
}

/** Serial correlation (lag-1 transition matrix) */
function transitionMatrix(bits) {
    const transitions = { '0→0': 0, '0→1': 0, '1→0': 0, '1→1': 0 };
    for (let i = 0; i < bits.length - 1; i++) {
        transitions[`${bits[i]}→${bits[i + 1]}`]++;
    }

    const total01 = transitions['0→0'] + transitions['0→1'];
    const total10 = transitions['1→0'] + transitions['1→1'];

    return {
        transitions,
        probAfterBuy: {
            buy: total01 > 0 ? (transitions['0→0'] / total01 * 100).toFixed(1) + '%' : 'N/A',
            sell: total01 > 0 ? (transitions['0→1'] / total01 * 100).toFixed(1) + '%' : 'N/A',
        },
        probAfterSell: {
            buy: total10 > 0 ? (transitions['1→0'] / total10 * 100).toFixed(1) + '%' : 'N/A',
            sell: total10 > 0 ? (transitions['1→1'] / total10 * 100).toFixed(1) + '%' : 'N/A',
        },
    };
}

/** Longest run of same value */
function longestRun(bits) {
    let maxRun = 1, currentRun = 1, maxVal = bits[0];
    for (let i = 1; i < bits.length; i++) {
        if (bits[i] === bits[i - 1]) {
            currentRun++;
            if (currentRun > maxRun) {
                maxRun = currentRun;
                maxVal = bits[i];
            }
        } else {
            currentRun = 1;
        }
    }
    return { maxRun, value: maxVal === 0 ? 'buy' : 'sell' };
}

/** Run-length distribution */
function runLengthDistribution(bits) {
    const runs = [];
    let currentLen = 1;
    for (let i = 1; i < bits.length; i++) {
        if (bits[i] === bits[i - 1]) {
            currentLen++;
        } else {
            runs.push(currentLen);
            currentLen = 1;
        }
    }
    runs.push(currentLen);

    // Distribution
    const dist = {};
    for (const r of runs) {
        dist[r] = (dist[r] || 0) + 1;
    }

    // For truly random binary: P(run length = k) = (1/2)^k
    // Expected proportion of runs of length k = (1/2)^k
    const totalRuns = runs.length;

    return { dist, totalRuns, avgRunLength: (bits.length / totalRuns).toFixed(2) };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Cross-Token Continuity Check
// ═══════════════════════════════════════════════════════════════════════════

/**
 * If the PRNG is continuous across tokens, the combined sequence should
 * pass the same statistical tests as individual tokens. If it's reseeded
 * per token, we might see discontinuities at token boundaries.
 */
function crossTokenAnalysis(tokens) {
    const results = [];

    for (let i = 0; i < tokens.length - 1; i++) {
        const t1 = tokens[i];
        const t2 = tokens[i + 1];

        // Time gap between last trade of t1 and first trade of t2
        const lastSlot1 = t1.trades[t1.trades.length - 1].slot;
        const firstSlot2 = t2.trades[0].slot;
        const slotGap = firstSlot2 - lastSlot1;
        const timeGap = t2.firstBlockTime - t1.trades[t1.trades.length - 1].blockTime;

        // Boundary bits: last 5 of t1 + first 5 of t2
        const tail = t1.trades.slice(-5).map(t => t.bit);
        const head = t2.trades.slice(0, 5).map(t => t.bit);
        const boundary = [...tail, ...head];

        results.push({
            from: t1.file.slice(0, 12),
            to: t2.file.slice(0, 12),
            slotGap,
            timeGapSec: timeGap,
            boundaryBits: boundary.map(b => b === 0 ? 'B' : 'S').join(''),
            // Check if there's a "reset" pattern (e.g., always starts with buy)
            t2StartsWithBuy: t2.trades[0].bit === 0,
        });
    }

    // Check if tokens always start with the same action (reseeding signal)
    const firstActions = tokens.map(t => t.trades[0]?.action);
    const firstActionCounts = { buy: 0, sell: 0 };
    for (const a of firstActions) firstActionCounts[a]++;

    return {
        boundaries: results,
        firstActionDistribution: firstActionCounts,
        alwaysStartsSame: firstActionCounts.buy === tokens.length || firstActionCounts.sell === tokens.length,
        firstBuyProportion: (firstActionCounts.buy / tokens.length * 100).toFixed(1) + '%',
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. xorshift128+ Specific Test
// ═══════════════════════════════════════════════════════════════════════════

/**
 * xorshift128+ has a known weakness: consecutive outputs have correlations
 * in their lower bits. For the MSB (which determines our buy/sell), the
 * correlation is weaker but still detectable with enough data.
 *
 * Key signature: lag-1 autocorrelation should be very slightly negative
 * for xorshift128+ (due to the XOR structure).
 */
function xorshiftSignatureTest(bits) {
    // For xorshift128+, test specific lag patterns
    const n = bits.length;

    // Count same-bit pairs vs different-bit pairs at various lags
    const lagStats = [];
    for (const lag of [1, 2, 3, 4, 5, 64, 128]) {
        if (lag >= n) continue;
        let same = 0;
        for (let i = 0; i < n - lag; i++) {
            if (bits[i] === bits[i + lag]) same++;
        }
        const total = n - lag;
        const sameProp = same / total;
        // For true random, expected proportion of same = 0.5
        const z = (sameProp - 0.5) / Math.sqrt(0.25 / total);
        lagStats.push({
            lag,
            sameProportion: (sameProp * 100).toFixed(2) + '%',
            z: z.toFixed(3),
            significant: Math.abs(z) > 1.96,
        });
    }

    return lagStats;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper: Normal CDF approximation
// ═══════════════════════════════════════════════════════════════════════════

function normalCDF(x) {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.SQRT2;
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1.0 + sign * y);
}

function chiSquaredCDF(x, k) {
    // Approximation using Wilson-Hilferty transformation
    if (k === 0) return x >= 0 ? 1 : 0;
    const z = Math.pow(x / k, 1 / 3) - (1 - 2 / (9 * k));
    const denom = Math.sqrt(2 / (9 * k));
    return normalCDF(z / denom);
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

const verbose = process.argv.includes('--verbose');

console.log('═══════════════════════════════════════════════════════════════');
console.log(' PRNG ANALYSIS — Mayhem Bot Buy/Sell Decision Sequence');
console.log('═══════════════════════════════════════════════════════════════\n');

const tokens = loadAllTokens();
const allBits = tokens.flatMap(t => t.trades.map(tr => tr.bit));

console.log(`Tokens loaded:     ${tokens.length}`);
console.log(`Total trades:      ${allBits.length}`);
console.log(`Total buys:        ${allBits.filter(b => b === 0).length}`);
console.log(`Total sells:       ${allBits.filter(b => b === 1).length}`);
console.log(`Date range:        ${new Date(tokens[0].trades[0].blockTime * 1000).toISOString().slice(0, 10)} → ${new Date(tokens[tokens.length - 1].trades.at(-1).blockTime * 1000).toISOString().slice(0, 10)}`);
console.log();

// ─── Per-Token Summary ───
if (verbose) {
    console.log('─── Per-Token Summary (chronological order) ───\n');
    for (const t of tokens) {
        const bits = t.trades.map(tr => tr.bit);
        const buys = bits.filter(b => b === 0).length;
        const seq = bits.map(b => b === 0 ? 'B' : 'S').join('');
        console.log(`  ${t.file.padEnd(28)} ${String(bits.length).padStart(3)} trades | ${buys}B/${bits.length - buys}S | ${seq}`);
    }
    console.log();
}

// ─── 1. Proportion Test ───
console.log('─── 1. PROPORTION TEST (buy/sell ratio) ───\n');
const prop = proportionTest(allBits);
console.log(`  Sell proportion:  ${(prop.proportion * 100).toFixed(2)}% (expected: 50%)`);
console.log(`  Z-statistic:     ${prop.z.toFixed(3)}`);
console.log(`  P-value:         ${prop.pValue.toFixed(4)}`);
console.log(`  Verdict:         ${prop.pValue > 0.05 ? 'PASS — consistent with 50/50' : 'FAIL — significantly different from 50/50'}`);
console.log();

// ─── 2. Runs Test ───
console.log('─── 2. RUNS TEST (clustering / alternating) ───\n');
const runs = runsTest(allBits);
console.log(`  Observed runs:   ${runs.runs}`);
console.log(`  Expected runs:   ${runs.expectedRuns}`);
console.log(`  Z-statistic:     ${runs.z}`);
console.log(`  P-value:         ${runs.pValue.toFixed(4)}`);
console.log(`  Verdict:         ${runs.interpretation}`);
console.log();

// ─── 3. Transition Matrix ───
console.log('─── 3. TRANSITION MATRIX (what follows buy/sell) ───\n');
const tm = transitionMatrix(allBits);
console.log(`  After BUY:  → BUY ${tm.probAfterBuy.buy}  → SELL ${tm.probAfterBuy.sell}`);
console.log(`  After SELL: → BUY ${tm.probAfterSell.buy}  → SELL ${tm.probAfterSell.sell}`);
console.log(`  (Random expectation: 50% / 50% in each row)`);
console.log();

// ─── 4. Autocorrelation ───
console.log('─── 4. AUTOCORRELATION (lag 1-20) ───\n');
const ac = autocorrelation(allBits);
const significantLags = ac.filter(a => a.significant);
for (const a of ac.slice(0, 10)) {
    const marker = a.significant ? ' ***' : '';
    console.log(`  Lag ${String(a.lag).padStart(2)}: r = ${a.r}${marker}`);
}
if (significantLags.length === 0) {
    console.log(`\n  No significant autocorrelations → consistent with IID random`);
} else {
    console.log(`\n  ${significantLags.length} significant lag(s) found → possible structure`);
}
console.log();

// ─── 5. N-gram (bigram, trigram, 4-gram) ───
console.log('─── 5. N-GRAM CHI-SQUARED TESTS ───\n');
for (const k of [2, 3, 4, 5]) {
    const ng = ngramFrequency(allBits, k);
    const verdict = ng.pValue > 0.05 ? 'PASS' : 'FAIL';
    console.log(`  ${k}-gram: χ² = ${ng.chiSq}, df = ${ng.df}, p = ${ng.pValue.toFixed(4)} → ${verdict}`);

    if (verbose && k <= 3) {
        const sorted = Object.entries(ng.counts).sort((a, b) => a[0].localeCompare(b[0]));
        for (const [pattern, count] of sorted) {
            const label = pattern.split('').map(b => b === '0' ? 'B' : 'S').join('');
            console.log(`    ${label}: ${count} (expected ~${ng.expected})`);
        }
    }
}
console.log();

// ─── 6. Run Length Distribution ───
console.log('─── 6. RUN LENGTH DISTRIBUTION ───\n');
const rld = runLengthDistribution(allBits);
console.log(`  Total runs:      ${rld.totalRuns}`);
console.log(`  Avg run length:  ${rld.avgRunLength} (random expectation: 2.0)`);
console.log(`  Distribution:`);
const sortedDist = Object.entries(rld.dist).sort((a, b) => Number(a[0]) - Number(b[0]));
for (const [len, count] of sortedDist) {
    const expectedProp = (0.5 ** Number(len) * 100).toFixed(1);
    const actualProp = (count / rld.totalRuns * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(count / rld.totalRuns * 50));
    console.log(`    Length ${len}: ${String(count).padStart(4)} (${actualProp}%, expected ~${expectedProp}%) ${bar}`);
}
console.log();

// ─── 7. Longest Run ───
const lr = longestRun(allBits);
console.log(`─── 7. LONGEST RUN ───\n`);
console.log(`  Longest run:     ${lr.maxRun} consecutive ${lr.value}s`);
// For n bits, expected longest run ~ log2(n)
const expectedLongest = Math.log2(allBits.length).toFixed(1);
console.log(`  Expected (random): ~${expectedLongest} for n=${allBits.length}`);
console.log();

// ─── 8. xorshift128+ Signature Test ───
console.log('─── 8. XORSHIFT128+ SIGNATURE TEST ───\n');
const xorStats = xorshiftSignatureTest(allBits);
for (const s of xorStats) {
    const marker = s.significant ? ' ***' : '';
    console.log(`  Lag ${String(s.lag).padStart(3)}: same=${s.sameProportion}, z=${s.z}${marker}`);
}
console.log();

// ─── 9. Cross-Token Continuity ───
console.log('─── 9. CROSS-TOKEN CONTINUITY ───\n');
const ct = crossTokenAnalysis(tokens);
console.log(`  First action distribution: ${ct.firstActionDistribution.buy} buy, ${ct.firstActionDistribution.sell} sell`);
console.log(`  First action = buy:        ${ct.firstBuyProportion}`);
console.log(`  Always starts same:        ${ct.alwaysStartsSame ? 'YES → STRONG reseeding signal' : 'NO → compatible with continuous PRNG'}`);
console.log();

if (verbose) {
    console.log('  Token boundaries (last 5 + first 5 trades):');
    for (const b of ct.boundaries) {
        console.log(`    ${b.from} → ${b.to} | gap=${b.timeGapSec}s | ${b.boundaryBits}`);
    }
    console.log();
}

// ─── 10. Verdict ───
console.log('═══════════════════════════════════════════════════════════════');
console.log(' VERDICT');
console.log('═══════════════════════════════════════════════════════════════\n');

const issues = [];
if (prop.pValue < 0.05) issues.push('Proportion significantly differs from 50%');
if (runs.pValue < 0.05) issues.push(`Runs test failed: ${runs.interpretation}`);
if (significantLags.length > 0) issues.push(`${significantLags.length} significant autocorrelation lag(s)`);
if (ct.alwaysStartsSame) issues.push('All tokens start with same action (reseeding)');

if (issues.length === 0) {
    console.log('  All tests PASS — sequence is consistent with a good PRNG (random).');
    console.log('  With only 1-bit observations, distinguishing xorshift128+ from CSPRNG');
    console.log('  requires seed recovery attempt (Phase A3).');
    console.log();
    console.log('  RECOMMENDATION: Proceed with z3 seed recovery on consecutive subsequences.');
} else {
    console.log('  ISSUES DETECTED:');
    for (const issue of issues) console.log(`    - ${issue}`);
    console.log();
    if (issues.some(i => i.includes('alternating'))) {
        console.log('  Alternating bias detected — this is NOT purely random.');
        console.log('  The bot may use a modified PRNG or deterministic alternation rule.');
    }
}
console.log();
