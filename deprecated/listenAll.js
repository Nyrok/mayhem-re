const { PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const {connection} = require("../utils/rpc.js");
const {MAYHEM_TRADING_WALLET, MAYHEM_PROGRAM_ID, PUMP_FUN_PROGRAM} = require("../utils/constants.js");
const {decodeTokenState} = require("../decoders/decodeTokenState.js");

// --- MONITORING DU WALLET SNIPER (PARALLÈLE) ---
async function monitorSniper(mintAddress) {
    console.log(`🔫 Surveillance du sniper ${MAYHEM_TRADING_WALLET} sur ${mintAddress}...`);
    return connection.onLogs(new PublicKey(MAYHEM_TRADING_WALLET), async (logs) => {
        if (logs.err) return;
        try {
            const tx = await connection.getParsedTransaction(logs.signature, {maxSupportedTransactionVersion: 0});
            if (!tx) return;
            if (tx.transaction.message.instructions[2].programId.toBase58() !== MAYHEM_PROGRAM_ID) return;
            if (tx.meta.innerInstructions[0].instructions[2].parsed.info.mint !== mintAddress) return;
            const dataBuffer = Buffer.from(bs58.decode(tx.transaction.message.instructions[2].data));
            const discriminator = dataBuffer.slice(0, 8).toString('hex');
            let type = null;
            if (discriminator.startsWith('66063d1201')) {
                type = 'buy';
            } else if (discriminator.startsWith('33e685a401')) {
                type = 'sell';
            }
            let marketCap = dataBuffer.readBigInt64LE(8);
            console.log(tx.slot, tx.blockTime, marketCap, type, mintAddress);
        } catch (e) { console.error("Erreur Sniper:", e.message); }
    }, 'confirmed');
}

// --- MAIN LOOP ---
async function startMonitoring() {
    console.log(`👀 ${MAYHEM_PROGRAM_ID}`);

    const logsSubId = connection.onLogs(
        new PublicKey(MAYHEM_PROGRAM_ID),
        async (logs) => {
            if (logs.err) return;
            const signature = logs.signature;

            try {
                const tx = await connection.getParsedTransaction(signature, {
                    maxSupportedTransactionVersion: 0,
                    commitment: 'confirmed'
                });

                if (!tx) return;

                // --- TES CHECKS STRICTS (Copier-Coller de ton code) ---
                const instructions = tx.transaction.message.instructions;

                // 1. On cible l'instruction à l'index 2 (comme dans ton code)
                const ix = instructions[2];

                // 2. Validation complète
                const isValid = ix
                    && ix.programId.toString() === PUMP_FUN_PROGRAM
                    && ix.accounts[9]?.toBase58() === MAYHEM_PROGRAM_ID
                    && decodePumpCreateV2(ix.data)?.isMayhemMode; // Check du flag boolean

                if (!isValid) return;

                console.log(`\n🚨 VALIDATION RÉUSSIE ! Tx: ${signature}`);

                // 3. Récupération State Account (Ton index 6)
                const stateAccountKey = tx.transaction.message.accountKeys[6];
                const statePubkey = stateAccountKey.pubkey.toString();

                console.log(`🎯 State Account: ${statePubkey}`);

                // --- PASSAGE EN MODE SURVEILLANCE ---

                // A. On arrête de chercher de nouveaux tokens
                connection.removeOnLogsListener(logsSubId);

                // B. On récupère le Mint initial
                const initialInfo = await connection.getAccountInfo(stateAccountKey.pubkey);
                let mintAddress = null;
                if (initialInfo) {
                    const decoded = decodeTokenState(initialInfo.data);
                    if (decoded) {
                        mintAddress = decoded.targetMint;
                        console.log(`🍬 Mint trouvé: ${mintAddress}`);
                        // Log initial
                        fs.appendFileSync(CSV_STATE, initialInfo.data.toString('hex') + '\n');
                    }
                }

                if (!mintAddress) {
                    console.log("❌ Impossible de lire le Mint dans le State. Arrêt.");
                    process.exit(1);
                }

                // C. Lancement Monitor Sniper (CSV 2)
                const sniperSubId = await monitorSniper(mintAddress);

                // D. Lancement Monitor State WSS (CSV 1)
                console.log(`📡 Écoute temps réel du State (${statePubkey})...`);
                let lastSolPlusValue = 0n;
                const stateSubId = connection.onAccountChange(
                    stateAccountKey.pubkey,
                    (accountInfo, context) => {
                        const d = decode(accountInfo.data);
                        if (d) {
                            if (lastSolPlusValue === 0n)
                            {
                                if (d.totalSolPlusValue > 0) {
                                    console.log(context.slot, "🟢 LE BOT VA BUY")
                                }
                                else {
                                    console.log(context.slot, "🔴 LE BOT VA SELL")
                                }
                            }
                            else if (lastSolPlusValue - d.totalSolPlusValue < 0) {
                                console.log(context.slot, "🟢 LE BOT VA BUY")
                            }
                            else {
                                console.log(context.slot, "🔴 LE BOT VA SELL")
                            }
                            lastSolPlusValue = d.totalSolPlusValue;
                        }
                    },
                    'processed'
                );

                // E. Timer de sortie
                console.log("⏳ Session de 60s démarrée. CTRL+C pour arrêter avant.");
                setTimeout(async () => {
                    console.log("\n🛑 Fin de session.");
                    await connection.removeAccountChangeListener(stateSubId);
                    await connection.removeOnLogsListener(sniperSubId);
                    process.exit(0);
                }, 300 * 1000);

            } catch (err) {
                console.error(`Erreur tx ${signature}:`, err.message);
            }
        },
        'confirmed'
    );
}




startMonitoring();