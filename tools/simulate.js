import {ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, TransactionInstruction} from "@solana/web3.js";
import {connection} from "../utils/rpc.js";
import {printBalanceDifferences} from "./interpreter.js";
import {MAYHEM_PROGRAM_ID, MAYHEM_TRADING_WALLET} from "../utils/constants.js";

export const inputAccounts = {
    buy: (tokenState, mint, tokenAccount, bondingCurve, vault, creatorVault) => [{
        pubkey: new PublicKey("Gygj9QQby4j2jryqyqBHvLP7ctv2SaANgh4sCb69BUpA"), isSigner: true, isWritable: true
    }, {
        pubkey: new PublicKey("13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ"), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey(tokenState), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey(mint), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey(tokenAccount), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey("BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s"), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false
    }, {
        pubkey: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"), isSigner: false, isWritable: false
    }, {
        pubkey: new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"), isSigner: false, isWritable: false
    }, {
        pubkey: new PublicKey(bondingCurve), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey("GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS"), isSigner: false, isWritable: true
    }, {pubkey: new PublicKey(vault), isSigner: false, isWritable: true}, {
        pubkey: new PublicKey(creatorVault), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"), isSigner: false, isWritable: false
    }, {pubkey: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"), isSigner: false, isWritable: false}, {
        pubkey: new PublicKey("Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y"), isSigner: false, isWritable: true
    }, {pubkey: new PublicKey("FGFrX2q1iAjyAojjeyFDxXqdmvegjPpSWsrPmrJjeQ2f"), isSigner: false, isWritable: true}, {
        pubkey: new PublicKey("8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt"), isSigner: false, isWritable: false
    }, {
        pubkey: new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"), isSigner: false, isWritable: false
    }, {
        pubkey: new PublicKey("8FoNgzmjuSmiy86EPCWxvv1q7oJSu2WGA7wPymwki2LJ"), isSigner: false, isWritable: false
    }, {pubkey: new PublicKey("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e"), isSigner: false, isWritable: false}],

    sell: (tokenState, mint, tokenAccount, bondingCurve, vault, creatorVault) => [{
        pubkey: new PublicKey("Gygj9QQby4j2jryqyqBHvLP7ctv2SaANgh4sCb69BUpA"), isSigner: true, isWritable: true
    }, {
        pubkey: new PublicKey("13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ"), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey(tokenState), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey("BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s"), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey(mint), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey(tokenAccount), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"), isSigner: false, isWritable: false
    }, {
        pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false
    }, {
        pubkey: new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"), isSigner: false, isWritable: false
    }, {
        pubkey: new PublicKey(bondingCurve), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey("GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS"), isSigner: false, isWritable: true
    }, {pubkey: new PublicKey(vault), isSigner: false, isWritable: true}, {
        pubkey: new PublicKey(creatorVault), isSigner: false, isWritable: true
    }, {
        pubkey: new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"), isSigner: false, isWritable: false
    }, {pubkey: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"), isSigner: false, isWritable: false}, {
        pubkey: new PublicKey("8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt"), isSigner: false, isWritable: false
    }, {
        pubkey: new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"), isSigner: false, isWritable: false
    }, {
        pubkey: new PublicKey("8FoNgzmjuSmiy86EPCWxvv1q7oJSu2WGA7wPymwki2LJ"), isSigner: false, isWritable: false
    }, {pubkey: new PublicKey("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e"), isSigner: false, isWritable: false}]
}

export async function simulateTransaction(type, marketCapInput, mint, tokenState, tokenAccount, bondingCurve, vault, creatorVault) {
    const marketCapBuffer = Buffer.alloc(8);
    marketCapBuffer.writeBigInt64LE(marketCapInput);

    const sellDiscriminator = [51, 230, 133, 164, 1, 127, 131, 173]; // Sell
    const buyDiscriminator = [102, 6, 61, 18, 1, 218, 235, 234]; // Buy

    const trailingData = Buffer.alloc(10);
    trailingData.writeUInt16LE(2500, 8);

    const originalData = Buffer.concat([
        Buffer.from(type === 'buy'
            ? buyDiscriminator
            : sellDiscriminator),
        marketCapBuffer,
        trailingData]);

    const instruction = new TransactionInstruction({
        keys: inputAccounts[type](tokenState, mint, tokenAccount, bondingCurve, vault, creatorVault),
        programId: MAYHEM_PROGRAM_ID,
        data: Buffer.from(originalData),
    });
    const transaction = new Transaction();
    transaction.add(ComputeBudgetProgram.setComputeUnitLimit({units: 400000}))
    transaction.add(ComputeBudgetProgram.setComputeUnitPrice({microLamports: 1000000}))
    transaction.add(instruction);
    transaction.add(SystemProgram.transfer({
        fromPubkey: new PublicKey(MAYHEM_TRADING_WALLET),
        toPubkey: new PublicKey("DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL"),
        lamports: 100000
    }))
    transaction.feePayer = new PublicKey("Gygj9QQby4j2jryqyqBHvLP7ctv2SaANgh4sCb69BUpA");
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const simulation = await connection.simulateTransaction(transaction);
    console.log('simulated', type, simulation.context.slot, marketCapInput, mint);
    if (simulation.value.err) {
        console.log("❌ ÉCHEC :", simulation.value.err);
    } else {
        console.log("✅ SUCCÈS : Transaction valide !");
    }
    simulation.value.logs.forEach(l => console.log("  >", l));
    printBalanceDifferences(simulation.value);
}
