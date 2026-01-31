import 'dotenv/config';
import {start} from "solana-bankrun";
import {
    PublicKey, Keypair, TransactionMessage, VersionedTransaction, ComputeBudgetProgram
} from "@solana/web3.js";
import {
    PumpSdk, GLOBAL_PDA, getBuyTokenAmountFromSolAmount, PUMP_FEE_PROGRAM_ID, PUMP_PROGRAM_ID, MAYHEM_PROGRAM_ID
} from "@pump-fun/pump-sdk";
import {TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync} from "@solana/spl-token";
import BN from "bn.js";
import {connection} from "./utils/rpc.js";
import {
    MAYHEM_FEE_RECIPIENT,
    MAYHEM_GLOBAL_STATE,
    MAYHEM_TOKEN_ACCOUNT,
    MAYHEM_TRADING_WALLET,
    MAYHEM_USER_VOLUME_ACCUMULATOR
} from "./utils/constants.js";

async function main() {
    console.log("🔄 Cloning Mainnet state...");

    const accountsToClone = [
        PUMP_PROGRAM_ID.toBase58(),
        PUMP_FEE_PROGRAM_ID.toBase58(),
        MAYHEM_PROGRAM_ID.toBase58(),
        'T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt',
        '4R3gSG8BpU4t19KYj8CfnbtRpnT8gtk4dvTHxVRwc2r7',
        "B5MvUwXdiW1NMM6QFFD3ssPKBujD4zMohncbM73Z2BQu",
        "75Uu23mqWBb8LM8vDppqC1mQAnCcBuLXhVaDezVMQLRw",
        "4TXghKDfUy26yBMjicyfSfAp995GbLtNvW1d1uPSknub",
        "7ny6X1Rq883geHEhDSLpCvQDZzbygPZEYXFhTKkyoCRF",
        "2Ph7k7bbrQXf1nm9g5CV73D26HFFemRHJnGYzVmSmVoS",
        "13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ",
        "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s",
        "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf",
        "GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS",
        "62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV",
        "7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ",
        "7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX",
        "9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz",
        "AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY",
        "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
        "FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz",
        "G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP",
        "4budycTjhs9fD6xw62VBducVTNgMgJJ5BgtKq7mAZwn6",
        "8SBKzEQU4nLSzcwF4a74F2iaUDQyTfjGndn6qUWBnrpR",
        "4UQeTP1T39KZ9Sfxzo3WR5skgsaP6NZa87BAkuazLEKH",
        "8sNeir4QsLsJdYpc9RZacohhK1Y5FLU3nC5LXgYB4aa6",
        "Fh9HmeLNUMVCvejxCtCL2DbYaRyBFVJ5xrWkLnMH6fdk",
        "463MEnMeGyJekNZFQSTUABBEbLnvMTALbT6ZmsxAbAdq",
        "6AUH3WEHucYZyC61hqpqYUWVto5qA5hjHuNQ32GNnNxA",
        "Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y",
        "8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt",
        "7gZufwwAo17y5kg8FMyJy2phgpvv9RSdzWtdXiWHjFr8",
        "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",
        "FGFrX2q1iAjyAojjeyFDxXqdmvegjPpSWsrPmrJjeQ2f",
        MAYHEM_TRADING_WALLET,
        "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
        "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
        "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
        "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
        "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
        "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
        "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
        "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
        "FFWtrEQ4B4PKQoVuHYzZq8FabGkVatYzDpEVHsK5rrhF",
        "UqN2p5bAzBqYdHXcgB6WLtuVrdvmy9JSAtgqZb3CMKw",
        "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM",
        "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg"
    ];
    const accountsInfos = await connection.getMultipleAccountsInfo(accountsToClone.map(address => new PublicKey(address)), 'confirmed');
    const accounts = accountsToClone.map((address, i) => ({address: new PublicKey(address), info: accountsInfos[i]}));
    // Démarrage Bankrun
    const context = await start([], accounts, 1_400_000n);
    const client = context.banksClient;
    const payer = context.payer;
    console.log(`🚀 Bankrun ready. Wallet: ${payer.publicKey.toBase58()}`);

    // Setup SDK
    const pumpSdk = new PumpSdk(connection);
    const globalAccount = await client.getAccount(GLOBAL_PDA);
    const global = pumpSdk.decodeGlobal({
        data: Buffer.from(globalAccount.data),
        executable: globalAccount.executable,
        lamports: Number(globalAccount.lamports),
        owner: globalAccount.owner
    });

    // --- TX 1: CREATE + BUY ---
    let solAmount = new BN(0.06 * 1e9);
    const mintKeypair = Keypair.generate();
    console.log(`Minting: ${mintKeypair.publicKey.toBase58()}`);

    const createInstructions = await pumpSdk.createV2AndBuyInstructions({
        global,
        mint: mintKeypair.publicKey,
        name: "DEMON",
        symbol: "DEM",
        uri: "https://ipfs.io/ipfs/QmaMTvt8GNiC41kFGd2t5kznvbKhRmQp5r8fVrTmvun93M",
        creator: payer.publicKey,
        user: payer.publicKey,
        solAmount,
        amount: getBuyTokenAmountFromSolAmount({
            global, amount: solAmount, bondingCurve: null, feeConfig: null, mintSupply: null
        }),
        mayhemMode: true
    });

    const msgV0 = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: context.lastBlockhash,
        instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({units: 1_400_000}),
            ComputeBudgetProgram.setComputeUnitPrice({microLamports: 1000000}),
            ...createInstructions
        ],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msgV0);
    tx.sign([payer, mintKeypair]);

    await client.processTransaction(tx);
    console.log("✅ Create + Buy Confirmed");

    // --- TX 2: BUY AGAIN ---
    const [bondingCurvePK] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mintKeypair.publicKey.toBuffer()], PUMP_PROGRAM_ID);

    const bcAccount = await client.getAccount(bondingCurvePK, 'confirmed');
    const bondingCurveData = pumpSdk.decodeBondingCurve({
        data: Buffer.from(bcAccount.data),
        executable: bcAccount.executable,
        lamports: Number(bcAccount.lamports),
        owner: bcAccount.owner
    });

    solAmount = solAmount.mul(new BN(5)); // x5
    const amount = getBuyTokenAmountFromSolAmount({
        global,
        amount: solAmount,
        bondingCurve: bondingCurveData,
        feeConfig: null,
        mintSupply: bondingCurveData.tokenTotalSupply
    });

    const buyInstructions = await pumpSdk.buyInstructions({
        global,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        bondingCurveAccountInfo: {
            data: Buffer.from(bcAccount.data), owner: bcAccount.owner
        },
        bondingCurve: bondingCurveData,
        mint: mintKeypair.publicKey,
        associatedUserAccountInfo: await client.getAccount(payer.publicKey),
        user: payer.publicKey,
        solAmount,
        amount,
        slippage: 3000
    });

    const buyMsg = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: context.lastBlockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({units: 400_000}), ...buyInstructions],
    }).compileToV0Message();

    const buyTx = new VersionedTransaction(buyMsg);
    buyTx.sign([payer]);

    await client.processTransaction(buyTx);
    console.log("✅ Second Buy Confirmed");

    // Check Balance
    const ata = getAssociatedTokenAddressSync(mintKeypair.publicKey, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ataAcc = await client.getAccount(ata);
    const bal = new BN(ataAcc.data.subarray(0, 8), 'le');
    console.log(`💰 Final Balance: ${bal.toString()}`);
}

main().catch(console.error);