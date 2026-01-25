import {connection} from "./utils/rpc.js";
import {PublicKey} from "@solana/web3.js";
import bs58 from "bs58";
import {calculateMayhemRatios, decodeMayhemTradeEvent} from "./decoders/decodeMayhemTradeEvent.js";
import {MAYHEM_TRADING_WALLET} from "./utils/constants.js";

const MINT = "BPnUPPQf6bKTF6FiGqGtEEJ7h1V2TZZQJqyBP3cFpump";

let globalCount = 0;
let lastSignature = null;
const decodedTrades = [];

const signatures = await connection.getSignaturesForAddress(new PublicKey(MINT), {
    limit: 1000,
    before: lastSignature
}, 'confirmed');

if (signatures.length === 0) process.exit(1);

console.log(`Found ${signatures.length} signatures`);

lastSignature = signatures[signatures.length - 1].signature;

for (const signatureInfo of signatures) {
    if (globalCount === 50) break;
    const tx = await connection.getParsedTransaction(signatureInfo.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
    });
    if (!tx.transaction.message.accountKeys.some(({
                                                      pubkey,
                                                      signer
                                                  }) => pubkey.toBase58() === MAYHEM_TRADING_WALLET && signer)) continue;
    if (!tx || !tx.meta?.innerInstructions || !tx.meta.innerInstructions[0]) continue;
    const innerInstructions = tx.meta.innerInstructions[0].instructions;
    const mayhemEventData = innerInstructions[innerInstructions.length - 1]?.data;
    if (!mayhemEventData) continue;
    try {
        const decodedEventData = decodeMayhemTradeEvent(bs58.decode(mayhemEventData));
        decodedTrades.push(decodedEventData);
        globalCount++;
        console.log(`Decoded: ${globalCount}`);
    } catch (e) {
    }
}

decodedTrades.reverse();
console.table(decodedTrades.map(event => calculateMayhemRatios(event)));