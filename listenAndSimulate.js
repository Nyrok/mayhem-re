import 'dotenv/config';
import bs58 from "bs58";
import {
    PublicKey
} from "@solana/web3.js";
import {decodeBondingCurve} from "./decoders/decodeBondingCurve.js";
import {MAYHEM_PROGRAM_ID, MAYHEM_TRADING_WALLET} from "./utils/constants.js";
import {connection} from "./utils/rpc.js";
import {simulateTransaction} from "./tools/simulate.js";
import {printBalanceDifferences} from "./tools/interpreter.js";
import {decodeMayhemIxDataEvent} from "./decoders/decodeMayhemIxData.js";
import {decodeTokenState} from "./decoders/decodeTokenState.js";

const logsEvent = connection.onLogs(new PublicKey(MAYHEM_TRADING_WALLET), async (logs) => {
    if (logs.err) return;
    const tx = await connection.getParsedTransaction(logs.signature, {maxSupportedTransactionVersion: 0});
    if (!tx) return;
    if (tx.transaction.message.instructions[2].programId.toBase58() !== MAYHEM_PROGRAM_ID) return;
    const dataBuffer = Buffer.from(bs58.decode(tx.transaction.message.instructions[2].data));
    const decodedIxData = decodeMayhemIxDataEvent(dataBuffer);
    if (!['buy', 'sell'].includes(decodedIxData.type)) {
        return;
    }
    await connection.removeOnLogsListener(logsEvent);
    let mint, tokenState, tokenAccount, bondingCurve, vault, creatorVault;
    if (decodedIxData.type === 'buy') {
        mint = tx.meta.innerInstructions[0].instructions[2].parsed.info.mint;
        tokenState = tx.transaction.message.accountKeys[2].pubkey;
        tokenAccount = tx.transaction.message.accountKeys[3].pubkey;
        bondingCurve = tx.transaction.message.accountKeys[5].pubkey;
        vault = tx.transaction.message.accountKeys[7].pubkey;
        creatorVault = tx.transaction.message.accountKeys[8].pubkey;
    } else {
        mint = tx.meta.innerInstructions[0].instructions[2].parsed.info.mint;
        tokenState = tx.transaction.message.accountKeys[2].pubkey;
        tokenAccount = tx.transaction.message.accountKeys[4].pubkey;
        bondingCurve = tx.transaction.message.accountKeys[5].pubkey;
        vault = tx.transaction.message.accountKeys[7].pubkey;
        creatorVault = tx.transaction.message.accountKeys[8].pubkey;
    }
    connection.getAccountInfo(tokenState)
        .then(info => console.log(decodeTokenState(info.data)));
    const bondingCurveData = await connection.getAccountInfo(bondingCurve);
    const bondingCurveObj = decodeBondingCurve(bondingCurveData.data);
    console.log("bonding curve", bondingCurveObj);
    let marketCap = dataBuffer.readBigInt64LE(8);
    console.log("original", decodedIxData.type, tx.slot, mint, marketCap, logs.signature);
    /*
    marketCap *= 10n;
    marketCap /= 10n;
    */
    printBalanceDifferences(tx.meta);
    console.log("expected amount", (bondingCurveObj.realSolReserves * 20n) / 100n - BigInt(decodedIxData.type === 'sell'), "lamports")
    await simulateTransaction(decodedIxData.type, marketCap, mint, tokenState, tokenAccount, bondingCurve, vault, creatorVault)
    console.log("expected amount", (bondingCurveObj.realSolReserves * 20n) / 100n - BigInt(decodedIxData.type !== 'sell'), "lamports")
    await simulateTransaction(decodedIxData.type === 'buy' ? 'sell' : 'buy', marketCap, mint, tokenState, tokenAccount, bondingCurve, vault, creatorVault)
    process.exit(0);
}, 'processed');

