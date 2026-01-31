import 'dotenv/config';
import {Connection} from "@solana/web3.js";

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const WSS_URL = `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const LOCAL_RPC_URL = 'http://127.0.0.1:8899';
const LOCAL_WSS_URL = 'ws://127.0.0.1:8900';
const isLocalRpc = process.env.ENV === 'local-rpc';

export const connection = new Connection(isLocalRpc ? LOCAL_RPC_URL : RPC_URL, {
    wsEndpoint: isLocalRpc ? LOCAL_WSS_URL : WSS_URL, commitment: 'confirmed'
});

export const mainnetConnection = new Connection(RPC_URL, {
    wsEndpoint: WSS_URL, commitment: 'confirmed'
});

export const localConnection = new Connection(LOCAL_RPC_URL, {
    wsEndpoint: LOCAL_WSS_URL, commitment: 'confirmed'
});
