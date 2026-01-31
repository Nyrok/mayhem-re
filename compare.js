import {localConnection, mainnetConnection} from "./utils/rpc.js";
import {PublicKey} from "@solana/web3.js";
import {
    MAYHEM_EVENT_AUTHORITY,
    MAYHEM_GLOBAL_STATE,
    MAYHEM_TOKEN_ACCOUNT,
    MAYHEM_TRADING_WALLET
} from "./utils/constants.js";
import {decodeGlobalState} from "./decoders/decodeGlobalState.js";

const globalStatePk = new PublicKey(MAYHEM_GLOBAL_STATE);
console.log(decodeGlobalState((await mainnetConnection.getAccountInfo(globalStatePk)).data));
console.log(decodeGlobalState((await localConnection.getAccountInfo(globalStatePk)).data));

const tokenAccountPK = new PublicKey(MAYHEM_TOKEN_ACCOUNT);
console.log(await mainnetConnection.getAccountInfo(tokenAccountPK));
console.log(await localConnection.getAccountInfo(tokenAccountPK));

const tradingWalletPK = new PublicKey(MAYHEM_TRADING_WALLET);
console.log(await mainnetConnection.getBalance(tradingWalletPK));
console.log(await localConnection.getBalance(tradingWalletPK));

const eventAccountPK = new PublicKey(MAYHEM_EVENT_AUTHORITY);
console.log(await mainnetConnection.getAccountInfo(eventAccountPK));
console.log(await localConnection.getAccountInfo(eventAccountPK));