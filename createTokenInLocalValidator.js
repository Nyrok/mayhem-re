import 'dotenv/config';
import BN from "bn.js";
import {
    ComputeBudgetProgram,
    Keypair,
    PublicKey,
    SystemProgram,
    TransactionMessage,
    VersionedTransaction
} from "@solana/web3.js";
import {getBuyTokenAmountFromSolAmount, GLOBAL_PDA, MAYHEM_PROGRAM_ID, PumpSdk} from "@pump-fun/pump-sdk";
import {connection} from "./utils/rpc.js";
import bs58 from "bs58";
import {
    MAYHEM_TOKEN_ACCOUNT, MAYHEM_TRADING_WALLET
} from "./utils/constants.js";
import {simulateTransaction} from "./tools/simulate.js";
import {decodeBondingCurve} from "./decoders/decodeBondingCurve.js";
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddressSync,
    TOKEN_2022_PROGRAM_ID
} from "@solana/spl-token";

const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const account = Keypair.fromSecretKey(bs58.decode(process.env.SECRET_KEY));
const pumpSdk = new PumpSdk(connection);
const global = pumpSdk.decodeGlobal(await connection.getAccountInfo(GLOBAL_PDA));
const solAmount = new BN(10e9);

if (await connection.getBalance(account.publicKey, 'confirmed') < 150 * 1e9) {
    await connection.confirmTransaction(await connection.requestAirdrop(account.publicKey, 200 * 1e9), 'confirmed');
}

const mintKeypair = Keypair.generate();

const pumpInstructions = await pumpSdk.createV2AndBuyInstructions({
    global,
    mint: mintKeypair.publicKey,
    name: "DEMON",
    symbol: "DEM",
    uri: "https://ipfs.io/ipfs/QmaMTvt8GNiC41kFGd2t5kznvbKhRmQp5r8fVrTmvun93M",
    creator: account.publicKey,
    user: account.publicKey,
    solAmount,
    amount: getBuyTokenAmountFromSolAmount({
        global, amount: solAmount, bondingCurve: null, feeConfig: null, mintSupply: null
    }),
    mayhemMode: true
});

const {blockhash} = await connection.getLatestBlockhash();

const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_400_000,
});

const instructions = [modifyComputeUnits, ...pumpInstructions];

const messageV0 = new TransactionMessage({
    payerKey: account.publicKey, recentBlockhash: blockhash, instructions,
}).compileToV0Message();

const transaction = new VersionedTransaction(messageV0);

transaction.sign([account, mintKeypair]);

console.log("Envoi de la transaction...");
try {
    const tx = await connection.sendTransaction(transaction, {
        skipPreflight: false, preflightCommitment: "confirmed",
    });

    await connection.confirmTransaction({
        signature: tx, ...(await connection.getLatestBlockhash()),
    });
    console.log(`Transaction confirmée!`);

    const [bondingCurvePK] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mintKeypair.publicKey.toBuffer()], PUMP_PROGRAM_ID);
    const [mayhemStatePK] = PublicKey.findProgramAddressSync([Buffer.from("mayhem-state"), mintKeypair.publicKey.toBuffer()], MAYHEM_PROGRAM_ID);

    const [associatedBondingCurvePK] = PublicKey.findProgramAddressSync([bondingCurvePK.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), mintKeypair.publicKey.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);

    const mayhemTokenAccountPK = getAssociatedTokenAddressSync(mintKeypair.publicKey,
        new PublicKey(MAYHEM_TOKEN_ACCOUNT),
        true,
        TOKEN_2022_PROGRAM_ID
    );

    const [creatorVaultPK] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), account.publicKey.toBuffer()], PUMP_PROGRAM_ID);
    const bondingCurveInfo = await connection.getAccountInfo(bondingCurvePK);
    const bondingCurveData = decodeBondingCurve(bondingCurveInfo.data);
    const marketCap = 1000000000000000n * bondingCurveData.virtualSolReserves / bondingCurveData.virtualTokenReserves;
    await simulateTransaction('buy', marketCap, mintKeypair.publicKey.toBase58(), mayhemStatePK, mayhemTokenAccountPK, bondingCurvePK, associatedBondingCurvePK, creatorVaultPK);
} catch (e) {
    if (e.logs) {
        console.log(e.logs.join('\n'));
    } else {
        console.log(e);
    }
}

await connection.onLogs(new PublicKey(MAYHEM_TRADING_WALLET), async (logs) => {
    console.log(logs);
}, 'processed')