import bs58 from "bs58";
import {PublicKey} from "@solana/web3.js";
import {connection} from "./utils/rpc.js";
import {MAYHEM_GLOBAL_STATE, MAYHEM_PROGRAM_ID, MAYHEM_TRADING_WALLET} from "./utils/constants.js";
import {decodeMayhemIxDataEvent} from "./decoders/decodeMayhemIxData.js";
import {decodeGlobalState} from "./decoders/decodeGlobalState.js";
import * as fs from "fs";

connection.onLogs(new PublicKey(MAYHEM_TRADING_WALLET), async (logs, ctx) => {
    if (logs.err) return;
    const tx = await connection.getParsedTransaction(logs.signature, {maxSupportedTransactionVersion: 0});
    if (!tx) return;
    if (tx.transaction.message.instructions[2].programId.toBase58() !== MAYHEM_PROGRAM_ID) return;
    const dataBuffer = Buffer.from(bs58.decode(tx.transaction.message.instructions[2].data));
    const decoded = decodeMayhemIxDataEvent(dataBuffer);
    console.log(ctx.slot, decoded.type, decoded.marketCap);
}, 'processed');

connection.onAccountChange(new PublicKey(MAYHEM_GLOBAL_STATE), (accountInfo, context) => {
    const decoded = decodeGlobalState(accountInfo.data);
    console.log(context.slot, decoded.unknownParameter1);
    fs.appendFileSync('globalState.csv', `${context.slot},${decoded.unknownParameter1}\n`);
}, 'processed');