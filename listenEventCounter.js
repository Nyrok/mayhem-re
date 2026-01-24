import {PublicKey} from "@solana/web3.js";
import bs58 from 'bs58';
import * as fs from "fs";
import {connection} from "./utils/rpc.js";
import {MAYHEM_PROGRAM_ID, MAYHEM_TRADING_WALLET} from "./utils/constants.js";
import {decodeMayhemIxDataEvent} from "./decoders/decodeMayhemIxData.js";

connection.onLogs(new PublicKey(MAYHEM_TRADING_WALLET), async (logs) => {
    if (logs.err) return;
    const tx = await connection
        .getParsedTransaction(logs.signature, {maxSupportedTransactionVersion: 0});
    if (!tx) return;
    if (tx.transaction.message.instructions[2].programId.toBase58() !== MAYHEM_PROGRAM_ID) return;
    const dataBuffer = Buffer.from(bs58.decode(tx.transaction.message.instructions[2].data));
    const decodedIxData = decodeMayhemIxDataEvent(dataBuffer);
    const innerInstructions = tx.meta.innerInstructions[0].instructions;
    const buffer = Buffer.from(bs58.decode(innerInstructions[innerInstructions.length - 1].data));
    console.log(decodedIxData.type, buffer.readUInt8(177), tx.blockTime, tx.blockTime % 256)
    fs.appendFileSync('counter.csv', decodedIxData.type + ',' + buffer.readUInt8(177) + '\n')
}, 'processed');

