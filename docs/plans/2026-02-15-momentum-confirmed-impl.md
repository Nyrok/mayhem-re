# momentumConfirmed Strategy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `momentumConfirmed` strategy (variants A and C) to backtestMainnet.js and offlineSweep.js so we can run live A/B testing.

**Architecture:** New strategy with a watch phase (track bot B/S before buying) and a kill switch (sell if momentum reverses after entry). Two variants share the same code path, differing only in the entry gate logic. Reuses existing BondingCurve, delta overlay, TP/SL, and save/display infrastructure.

**Tech Stack:** Node.js, BigInt arithmetic, BondingCurve class from monteCarloSimulation.js

---

### Task 1: Add CLI parameters to backtestMainnet.js

**Files:**
- Modify: `tools/backtestMainnet.js:38-95` (parseArgs defaults and parsing)

**Step 1: Add defaults**

In the `config` object at line 38, add after `mcapFloor: 0,`:

```js
        approach: 'A',          // momentumConfirmed variant: 'A' (Pure Gate) or 'C' (Momentum Score)
        entryRatio: 1.2,        // min botBuys/botSells to enter (approach A)
        scoreThreshold: 2.0,    // min momentum score to enter (approach C)
        killSwitch: 2,          // sell if botSells - botBuys >= this after entry (0=disabled)
```

**Step 2: Add CLI parsing**

After the `--mcapFloor=` line (line 94), add:

```js
        else if (arg.startsWith('--approach=')) config.approach = arg.split('=')[1];
        else if (arg.startsWith('--entryRatio=')) config.entryRatio = parseFloat(arg.split('=')[1]);
        else if (arg.startsWith('--scoreThreshold=')) config.scoreThreshold = parseFloat(arg.split('=')[1]);
        else if (arg.startsWith('--killSwitch=')) config.killSwitch = parseInt(arg.split('=')[1]);
```

**Step 3: Verify syntax**

Run: `node -c tools/backtestMainnet.js`
Expected: No output (success)

**Step 4: Commit**

```bash
git add tools/backtestMainnet.js
git commit -m "feat: add momentumConfirmed CLI params to backtestMainnet"
```

---

### Task 2: Add momentumConfirmed to streamAndSimulate (live mode)

**Files:**
- Modify: `tools/backtestMainnet.js:340-610` (streamAndSimulate function)

The strategy logic goes in the per-trade handler inside `onLogs`. The key difference from existing strategies: there's a "watch phase" before the first buy where we only observe bot trades.

**Step 1: Add state variables**

After the existing state variables around line 340-360 (where `botBuys`, `botSells`, `playerSolDelta` etc are declared), add:

```js
                let mcEntered = false;      // momentumConfirmed: has entry gate been passed?
                let mcWatchStart = null;     // momentumConfirmed: timestamp when watching started
```

**Step 2: Add kill switch check**

After the mcapFloor check block (line ~413) and before the smartDipAccumulator price tracking (line ~416), add:

```js
                    // momentumConfirmed: kill switch — sell if momentum reverses after entry
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
```

**Step 3: Replace the buy logic block for momentumConfirmed**

The existing buy logic starts at line ~484 with `if (trade.action === 'sell' && consecutiveSells >= config.sellStreak ...`. We need to add a completely separate path for `momentumConfirmed` BEFORE the existing sell-triggered buy block.

Insert before line 484 (the `// Buy when bot sells` comment):

```js
                    // momentumConfirmed: watch phase + gated entry
                    if (config.strategy === 'momentumConfirmed') {
                        if (!mcWatchStart) mcWatchStart = trade.blockTime || Date.now() / 1000;

                        if (!mcEntered) {
                            // Watch phase — check entry gate
                            let shouldEnter = false;

                            if (config.approach === 'A') {
                                // Pure Gate: B/S ratio check
                                if (botSells > 0) {
                                    shouldEnter = (botBuys / botSells) >= config.entryRatio;
                                } else if (botBuys > 0) {
                                    shouldEnter = true; // all buys, infinite ratio
                                }
                            } else if (config.approach === 'C') {
                                // Momentum Score: direction * speed
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
                                // Execute first buy
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
                            // Post-entry: additional buys on bot sells (like dipAccumulator)
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
```

Then wrap the existing buy block (line ~484) with a guard so it doesn't fire for momentumConfirmed:

Change `if (trade.action === 'sell' && consecutiveSells >= config.sellStreak` to:
```js
                    if (config.strategy !== 'momentumConfirmed'
                        && trade.action === 'sell' && consecutiveSells >= config.sellStreak
```

**Step 4: Verify syntax**

Run: `node -c tools/backtestMainnet.js`
Expected: No output (success)

**Step 5: Commit**

```bash
git add tools/backtestMainnet.js
git commit -m "feat: add momentumConfirmed strategy logic to live mode"
```

---

### Task 3: Add momentumConfirmed to replayToken (historical mode)

**Files:**
- Modify: `tools/backtestMainnet.js:650-880` (replayToken function)

Same logic as Task 2 but in the historical replay function. Follow the same pattern:

**Step 1: Add state variables** after line ~682:

```js
    let mcEntered = false;
    let mcWatchStart = null;
```

**Step 2: Add kill switch** after the mcapFloor block (~line 703) and before smartDipAccumulator price tracking (~line 706):

```js
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
```

**Step 3: Add watch phase + gated entry** before the existing buy block (~line 774):

Same logic as Task 2 Step 3 but using `runBotBuys`/`runBotSells` instead of `botBuys`/`botSells`, and using `trade.blockTime` for timestamps. Guard the existing buy block with `config.strategy !== 'momentumConfirmed'`.

**Step 4: Add verbose logging** for watch phase. After the existing verbose logging blocks (~line 864):

```js
            if (config.strategy === 'momentumConfirmed') {
                const ratioStr = runBotSells > 0 ? (runBotBuys / runBotSells).toFixed(2) : 'inf';
                const excess = runBotSells - runBotBuys;
                console.log(`       [MC] entered=${mcEntered} B/S=${ratioStr} excess=${excess} | ${runBotBuys}B/${runBotSells}S`);
            }
```

**Step 5: Verify syntax + test with a saved dataset**

Run: `node -c tools/backtestMainnet.js`
Run: `node tools/backtestMainnet.js --strategy=momentumConfirmed --approach=A --tradeSize=0.2 --takeProfit=15 --maxBuys=1 --killSwitch=2 --entryRatio=1.2 --verbose --mint=<any saved mint address>`
Expected: Should show [WATCH] logs, then ENTRY CONFIRMED or END without entry

**Step 6: Commit**

```bash
git add tools/backtestMainnet.js
git commit -m "feat: add momentumConfirmed to replayToken (historical mode)"
```

---

### Task 4: Update display and save functions

**Files:**
- Modify: `tools/backtestMainnet.js:920-1045` (printResult, printSummary, appendResult, main)

**Step 1: Update printResult** (~line 929):

After the proportionalDip config display, add:

```js
    if (config.strategy === 'momentumConfirmed') {
        console.log(`Momentum:   approach=${config.approach} entryRatio=${config.entryRatio} scoreThreshold=${config.scoreThreshold} killSwitch=${config.killSwitch}`);
    }
```

**Step 2: Update printSummary** (~line 974):

Add KILL to the exit reasons line:

```js
    console.log(`Exits: TP=${...} SL=${...} MCAP=${...} TRAIL=${...} REV=${...} KILL=${results.filter(r => r.exitReason === 'KILL').length} END=${...}`);
```

**Step 3: Update appendResult** (~line 1007):

After the proportionalDip config spread, add:

```js
            ...(config.strategy === 'momentumConfirmed' ? {
                approach: config.approach, entryRatio: config.entryRatio,
                scoreThreshold: config.scoreThreshold, killSwitch: config.killSwitch,
            } : {}),
```

**Step 4: Update main()** (~line 1037):

After the proportionalDip display, add:

```js
        if (config.strategy === 'momentumConfirmed') {
            console.log(`Momentum:   approach=${config.approach} entryRatio=${config.entryRatio} scoreThreshold=${config.scoreThreshold} killSwitch=${config.killSwitch}`);
        }
```

**Step 5: Verify syntax**

Run: `node -c tools/backtestMainnet.js`

**Step 6: Commit**

```bash
git add tools/backtestMainnet.js
git commit -m "feat: update display/save for momentumConfirmed strategy"
```

---

### Task 5: Add momentumConfirmed to offlineSweep.js

**Files:**
- Modify: `tools/offlineSweep.js:22-300` (replayDataset) and `tools/offlineSweep.js:306-433` (generateConfigs)

**Step 1: Add state variables** in replayDataset after line ~36:

```js
    let mcEntered = false;
    let mcWatchStart = null;
```

**Step 2: Add kill switch** after mcapFloor block (~line 65) and before smartDipAccumulator price tracking:

Same pattern as Task 3 Step 2 using `botBuys`/`botSells`.

**Step 3: Add watch phase + gated entry** before the existing buy block (~line 188):

Same entry gate logic. Guard existing buy block with `config.strategy !== 'momentumConfirmed'`. For timestamps, use the trade index as a proxy (each trade ~0.4s apart based on Solana slot time): `const elapsed = i * 0.4;`

**Step 4: Add sweep grid** in generateConfigs after the proportionalDip block (~line 430):

```js
    // MomentumConfirmed configs
    if (!strategyFilter || strategyFilter === 'momentumConfirmed') {
        for (const approach of ['A', 'C']) {
            for (const tradeSize of [0.1, 0.2, 0.3]) {
                for (const entryRatio of (approach === 'A' ? [0.8, 1.0, 1.2, 1.5] : [0])) {
                    for (const scoreThreshold of (approach === 'C' ? [0.5, 1.0, 2.0, 3.0] : [0])) {
                        for (const takeProfit of [5, 10, 15]) {
                            for (const maxBuys of [1, 2, 3]) {
                                for (const killSwitch of [0, 2, 3]) {
                                    configs.push({
                                        strategy: 'momentumConfirmed',
                                        tradeSize, budget: 1.0,
                                        takeProfit, stopLoss: 20,
                                        maxBuys, maxPositionPct: 100,
                                        sellStreak: 1, buyStreak: 1,
                                        approach, entryRatio, scoreThreshold, killSwitch,
                                        mcapFloor: 0,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }
```

**Step 5: Add display columns** for momentumConfirmed in the results printing section (~line 534):

Add an `isMC` flag and corresponding display format with columns: Appr, Size, Ratio/Score, TP, MaxB, Kill.

**Step 6: Verify + test**

Run: `node tools/offlineSweep.js --strategy=momentumConfirmed --top=10`
Expected: Shows top 10 configs with approach A and C results

**Step 7: Commit**

```bash
git add tools/offlineSweep.js
git commit -m "feat: add momentumConfirmed to offlineSweep"
```

---

### Task 6: Live A/B validation

**Step 1: Run variant A live**

```bash
node tools/backtestMainnet.js --strategy=momentumConfirmed --approach=A --tradeSize=0.2 --budget=1 --takeProfit=15 --stopLoss=20 --maxBuys=1 --killSwitch=2 --entryRatio=1.2 --verbose --save=analysis/live_runs/momentum_A_run1.jsonl
```

Wait for 20+ tokens.

**Step 2: Run variant C live**

```bash
node tools/backtestMainnet.js --strategy=momentumConfirmed --approach=C --tradeSize=0.2 --budget=1 --takeProfit=15 --stopLoss=20 --maxBuys=3 --killSwitch=2 --scoreThreshold=2.0 --verbose --save=analysis/live_runs/momentum_C_run1.jsonl
```

Wait for 20+ tokens.

**Step 3: Compare results**

Check wallet balance, WR, exit reasons, avg win/loss for both variants. Compare to dipAccumulator baseline.

**Step 4: Update MEMORY.md with findings**
