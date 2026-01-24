import bs58 from "bs58";
import {PublicKey} from "@solana/web3.js";
import {connection} from "./utils/rpc.js";
import {MAYHEM_PROGRAM_ID, MAYHEM_TRADING_WALLET, PUMP_FUN_PROGRAM} from "./utils/constants.js";
import {decodeTokenState} from "./decoders/decodeTokenState.js";
import {decodeCreateV2} from "./decoders/decodeCreateV2.js";

async function monitorTradingBot(mintAddress) {
    return connection.onLogs(new PublicKey(MAYHEM_TRADING_WALLET), async (logs) => {
        if (logs.err) return;
        const tx = await connection.getParsedTransaction(logs.signature, {maxSupportedTransactionVersion: 0});
        if (!tx) return;
        if (tx.transaction.message.instructions[2].programId.toBase58() !== MAYHEM_PROGRAM_ID) return;
        if (tx.meta.innerInstructions[0].instructions[2].parsed.info.mint !== mintAddress) return;
        const dataBuffer = Buffer.from(bs58.decode(tx.transaction.message.instructions[2].data));
        console.log(decodeTokenState(dataBuffer))
    }, 'processed');
}

// --- MAIN LOOP ---
async function startMonitoring() {
    return connection.onLogs(
        new PublicKey(MAYHEM_PROGRAM_ID),
        async (logs) => {
            if (logs.err) return;
            const signature = logs.signature;
            const tx = await connection.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed'
            });
            if (!tx) return;
            const instructions = tx.transaction.message.instructions;
            const ix = instructions[2];
            const ixBuffer = Buffer.from(bs58.decode(ix.data));
            const isValid = ix
                && ix.programId.toString() === PUMP_FUN_PROGRAM
                && ix.accounts[9]?.toBase58() === MAYHEM_PROGRAM_ID
                && decodeCreateV2(ixBuffer).isMayhemMode;
            if (!isValid) return;
            const stateAccountKey = tx.transaction.message.accountKeys[6];
            const stateAccountData = await connection.getAccountInfo(stateAccountKey.pubkey);
            const mintAddress = decodeTokenState(stateAccountData.data).targetMint;
            console.log(mintAddress);
            await monitorTradingBot(mintAddress);
        },
        'processed'
    );
}


startMonitoring();