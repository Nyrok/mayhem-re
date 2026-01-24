import 'dotenv/config';
import {Connection} from "@solana/web3.js";

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const WSS_URL = `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

export const connection = new Connection(RPC_URL, {
    wsEndpoint: WSS_URL,
    commitment: 'confirmed'
});
