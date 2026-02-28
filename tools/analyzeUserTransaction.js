/**
 * analyzeUserTransaction.js
 *
 * Purpose: Verify if Pump Fun calls Mayhem via CPI during user buy/sell on mayhem tokens.
 *
 * This script finds USER transactions (not bot) on a mayhem token and checks
 * if MAYHEM_PROGRAM_ID appears in innerInstructions.
 *
 * Result:
 * - If CPI present: Mayhem is triggered internally by Pump Fun
 * - If no CPI: Bot operates off-chain, simulation impossible without recreating the service
 */

import {connection} from "../utils/rpc.js";
import {PublicKey} from "@solana/web3.js";
import bs58 from "bs58";
import {MAYHEM_PROGRAM_ID, MAYHEM_TRADING_WALLET, PUMP_FUN_PROGRAM} from "../utils/constants.js";

// Token to analyze - a mayhem mode token
const MINT = process.argv[2] || "BPnUPPQf6bKTF6FiGqGtEEJ7h1V2TZZQJqyBP3cFpump";

async function analyzeUserTransactions() {
    console.log(`\n🔍 Analyzing user transactions for token: ${MINT}`);
    console.log(`   Looking for CPI calls to MAYHEM_PROGRAM_ID in user transactions\n`);

    const signatures = await connection.getSignaturesForAddress(new PublicKey(MINT), {
        limit: 200
    }, 'confirmed');

    console.log(`Found ${signatures.length} total signatures\n`);

    let userTxCount = 0;
    let botTxCount = 0;
    let cpiFoundCount = 0;
    const userTxsWithCpi = [];
    const userTxsWithoutCpi = [];

    for (const signatureInfo of signatures) {
        const tx = await connection.getParsedTransaction(signatureInfo.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        });

        if (!tx) continue;

        // Check if MAYHEM_TRADING_WALLET is the signer (bot transaction)
        const isBotTx = tx.transaction.message.accountKeys.some(
            ({pubkey, signer}) => pubkey.toBase58() === MAYHEM_TRADING_WALLET && signer
        );

        if (isBotTx) {
            botTxCount++;
            continue; // Skip bot transactions, we're looking for user transactions
        }

        userTxCount++;

        // Check if this is a Pump Fun transaction
        const isPumpFunTx = tx.transaction.message.accountKeys.some(
            ({pubkey}) => pubkey.toBase58() === PUMP_FUN_PROGRAM
        );

        if (!isPumpFunTx) continue;

        // Now check innerInstructions for MAYHEM_PROGRAM_ID
        const innerInstructions = tx.meta?.innerInstructions || [];
        let mayhemCpiFound = false;
        let mayhemInnerIx = null;

        for (const innerSet of innerInstructions) {
            for (const ix of innerSet.instructions) {
                // Check if programId is MAYHEM_PROGRAM_ID
                const programId = ix.programId?.toBase58?.() || ix.programId;
                if (programId === MAYHEM_PROGRAM_ID) {
                    mayhemCpiFound = true;
                    mayhemInnerIx = ix;
                    break;
                }
            }
            if (mayhemCpiFound) break;
        }

        if (mayhemCpiFound) {
            cpiFoundCount++;
            userTxsWithCpi.push({
                signature: signatureInfo.signature,
                slot: tx.slot,
                innerIx: mayhemInnerIx
            });
        } else {
            userTxsWithoutCpi.push({
                signature: signatureInfo.signature,
                slot: tx.slot,
                innerInstructionsCount: innerInstructions.length
            });
        }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`RESULTS`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Total transactions analyzed: ${signatures.length}`);
    console.log(`Bot transactions (MAYHEM_TRADING_WALLET signer): ${botTxCount}`);
    console.log(`User transactions: ${userTxCount}`);
    console.log(`\nUser transactions WITH Mayhem CPI: ${cpiFoundCount}`);
    console.log(`User transactions WITHOUT Mayhem CPI: ${userTxsWithoutCpi.length}`);

    if (cpiFoundCount > 0) {
        console.log(`\n✅ CPI DETECTED - Mayhem IS called via CPI from Pump Fun!`);
        console.log(`\nSample user transactions with Mayhem CPI:`);
        for (const tx of userTxsWithCpi.slice(0, 5)) {
            console.log(`  - ${tx.signature} (slot: ${tx.slot})`);
            if (tx.innerIx?.data) {
                console.log(`    Data: ${tx.innerIx.data.substring(0, 50)}...`);
            }
        }
    } else {
        console.log(`\n❌ NO CPI DETECTED - Bot operates off-chain`);
        console.log(`   The Mayhem program is NOT called via CPI during user trades.`);
        console.log(`   Local simulation would require recreating the off-chain bot service.`);
    }

    // Show some user transactions for manual verification
    if (userTxsWithoutCpi.length > 0) {
        console.log(`\nSample user transactions WITHOUT Mayhem CPI (for manual verification):`);
        for (const tx of userTxsWithoutCpi.slice(0, 5)) {
            console.log(`  - ${tx.signature}`);
            console.log(`    Slot: ${tx.slot}, InnerIx sets: ${tx.innerInstructionsCount}`);
        }
    }
}

// Also provide detailed analysis of a single transaction
async function analyzeSpecificTransaction(signature) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`DETAILED ANALYSIS: ${signature}`);
    console.log(`${'='.repeat(60)}`);

    const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
    });

    if (!tx) {
        console.log("Transaction not found");
        return;
    }

    console.log(`\nSlot: ${tx.slot}`);
    console.log(`Block Time: ${new Date(tx.blockTime * 1000).toISOString()}`);

    console.log(`\nAccount Keys:`);
    tx.transaction.message.accountKeys.forEach((key, i) => {
        const pubkey = key.pubkey.toBase58();
        const marker =
            pubkey === MAYHEM_PROGRAM_ID ? ' [MAYHEM_PROGRAM]' :
            pubkey === MAYHEM_TRADING_WALLET ? ' [MAYHEM_WALLET]' :
            pubkey === PUMP_FUN_PROGRAM ? ' [PUMP_FUN]' : '';
        console.log(`  ${i}: ${pubkey}${key.signer ? ' (signer)' : ''}${marker}`);
    });

    console.log(`\nTop-level Instructions:`);
    tx.transaction.message.instructions.forEach((ix, i) => {
        const programId = ix.programId?.toBase58?.() || ix.programId;
        console.log(`  [${i}] Program: ${programId}`);
        if (ix.data) {
            const dataStr = typeof ix.data === 'string' ? ix.data : bs58.encode(ix.data);
            console.log(`      Data: ${dataStr.substring(0, 50)}...`);
        }
    });

    console.log(`\nInner Instructions:`);
    const innerInstructions = tx.meta?.innerInstructions || [];
    if (innerInstructions.length === 0) {
        console.log("  (none)");
    }
    for (const innerSet of innerInstructions) {
        console.log(`  Set for instruction ${innerSet.index}:`);
        for (const ix of innerSet.instructions) {
            const programId = ix.programId?.toBase58?.() || ix.programId;
            const isMayhem = programId === MAYHEM_PROGRAM_ID ? ' 🎯 [MAYHEM]' : '';
            console.log(`    - Program: ${programId}${isMayhem}`);
            if (ix.data && isMayhem) {
                console.log(`      Data: ${ix.data}`);
            }
        }
    }
}

// Run analysis
await analyzeUserTransactions();

// If a specific signature is provided as second argument, analyze it in detail
if (process.argv[3]) {
    await analyzeSpecificTransaction(process.argv[3]);
}
