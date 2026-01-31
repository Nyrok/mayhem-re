import 'dotenv/config';
import {
    ComputeBudgetProgram,
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction
} from "@solana/web3.js";
import {connection} from "../utils/rpc.js";
import {
    MAYHEM_EVENT_AUTHORITY, MAYHEM_FEE_RECIPIENT,
    MAYHEM_GLOBAL_STATE,
    MAYHEM_PROGRAM_ID,
    MAYHEM_TOKEN_ACCOUNT,
    MAYHEM_TRADING_WALLET, MAYHEM_USER_VOLUME_ACCUMULATOR
} from "../utils/constants.js";
import bs58 from "bs58";
import {
    GLOBAL_PDA, GLOBAL_VOLUME_ACCUMULATOR_PDA,
    PUMP_EVENT_AUTHORITY_PDA, PUMP_FEE_CONFIG_PDA,
    PUMP_FEE_PROGRAM_ID,
    PUMP_PROGRAM_ID
} from "@pump-fun/pump-sdk";
import {TOKEN_2022_PROGRAM_ID} from "@solana/spl-token";

export const inputAccounts = {
    buy: (tokenState, mint, tokenAccount, bondingCurve, vault, creatorVault) => [{
        pubkey: new PublicKey(MAYHEM_TRADING_WALLET), isSigner: true, isWritable: true
    }, {
        pubkey: new PublicKey(MAYHEM_GLOBAL_STATE), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey(tokenState), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey(mint), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey(tokenAccount), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey(MAYHEM_TOKEN_ACCOUNT), isSigner: false, isWritable: true
    }, {
        pubkey: SystemProgram.programId, isSigner: false, isWritable: false
    }, {
        pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false
    }, {
        pubkey: GLOBAL_PDA, isSigner: false, isWritable: false
    }, {
        pubkey: new PublicKey(bondingCurve), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey(MAYHEM_FEE_RECIPIENT), isSigner: false, isWritable: true
    }, {pubkey: new PublicKey(vault), isSigner: false, isWritable: true}, {
        pubkey: new PublicKey(creatorVault), isSigner: false, isWritable: true
    }, {
        pubkey: PUMP_EVENT_AUTHORITY_PDA, isSigner: false, isWritable: false
    }, {pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false}, {
        pubkey: GLOBAL_VOLUME_ACCUMULATOR_PDA, isSigner: false, isWritable: true
    }, {pubkey: new PublicKey(MAYHEM_USER_VOLUME_ACCUMULATOR), isSigner: false, isWritable: true}, {
        pubkey: PUMP_FEE_CONFIG_PDA, isSigner: false, isWritable: false
    }, {
        pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false
    }, {
        pubkey: new PublicKey(MAYHEM_EVENT_AUTHORITY), isSigner: false, isWritable: false
    }, {pubkey: new PublicKey(MAYHEM_PROGRAM_ID), isSigner: false, isWritable: false}],

    sell: (tokenState, mint, tokenAccount, bondingCurve, vault, creatorVault) => [{
        pubkey: new PublicKey(MAYHEM_TRADING_WALLET), isSigner: true, isWritable: true
    }, {
        pubkey: new PublicKey(MAYHEM_GLOBAL_STATE), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey(tokenState), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey(MAYHEM_TOKEN_ACCOUNT), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey(mint), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey(tokenAccount), isSigner: false, isWritable: true
    }, {
        pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false
    }, {
        pubkey: SystemProgram.programId, isSigner: false, isWritable: false
    }, {
        pubkey: GLOBAL_PDA, isSigner: false, isWritable: false
    }, {
        pubkey: new PublicKey(bondingCurve), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey(MAYHEM_FEE_RECIPIENT), isSigner: false, isWritable: true
    }, {pubkey: new PublicKey(vault), isSigner: false, isWritable: true}, {
        pubkey: new PublicKey(creatorVault), isSigner: false, isWritable: true
    }, {
        pubkey: PUMP_EVENT_AUTHORITY_PDA, isSigner: false, isWritable: false
    }, {pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false}, {
        pubkey: PUMP_FEE_CONFIG_PDA, isSigner: false, isWritable: false
    }, {
        pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false
    }, {
        pubkey: new PublicKey(MAYHEM_EVENT_AUTHORITY), isSigner: false, isWritable: false
    }, {pubkey: new PublicKey(MAYHEM_PROGRAM_ID), isSigner: false, isWritable: false}]
}

export async function simulateTransaction(type, marketCapInput, mint, tokenState, tokenAccount, bondingCurve, vault, creatorVault) {
    const marketCapBuffer = Buffer.alloc(8);
    marketCapBuffer.writeBigInt64LE(marketCapInput);

    const sellDiscriminator = [51, 230, 133, 164, 1, 127, 131, 173]; // Sell
    const buyDiscriminator = [102, 6, 61, 18, 1, 218, 235, 234]; // Buy

    const trailingData = Buffer.alloc(10);
    trailingData.writeUInt16LE(3000, 8);

    const originalData = Buffer.concat([
        Buffer.from(type === 'buy'
            ? buyDiscriminator
            : sellDiscriminator),
        marketCapBuffer,
        trailingData]);

    const instruction = new TransactionInstruction({
        keys: inputAccounts[type](tokenState, mint, tokenAccount, bondingCurve, vault, creatorVault),
        programId: MAYHEM_PROGRAM_ID,
        data: Buffer.from(originalData),
    });
    const transaction = new Transaction();
    transaction.add(ComputeBudgetProgram.setComputeUnitLimit({units: 400000}))
    transaction.add(ComputeBudgetProgram.setComputeUnitPrice({microLamports: 1000000}))
    transaction.add(instruction);
    transaction.add(SystemProgram.transfer({
        fromPubkey: new PublicKey(MAYHEM_TRADING_WALLET),
        toPubkey: new PublicKey("DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL"),
        lamports: 100000
    }))
    transaction.feePayer = new PublicKey(MAYHEM_TRADING_WALLET);
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const simulation = await connection.simulateTransaction(transaction);
    console.log('simulated', type, simulation.context.slot, marketCapInput, mint);
    if (simulation.value.err) {
        console.log("❌ ÉCHEC :", simulation.value.err);
    } else {
        console.log("✅ SUCCÈS : Transaction valide !");
    }
    //simulation.value.logs.forEach(l => console.log("  >", l));
    //printBalanceDifferences(simulation.value);
}
