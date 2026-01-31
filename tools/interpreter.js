export function printBalanceDifferences(meta) {
    let solChange = 0;
    meta.postBalances.forEach((post, index) => {
        const pre = meta.preBalances[index];
        const diff = post - pre;
        if (Math.abs(diff) > 100000) {
            console.log(`Compte SOL #${index} : ${diff} lamports`);
            if (diff < 0) solChange = diff;
        }
    });
    meta.postTokenBalances.forEach((postAccount) => {
        const preAccount = meta.preTokenBalances.find(pre => pre.accountIndex === postAccount.accountIndex);
        const preAmount = preAccount ? BigInt(preAccount.uiTokenAmount.amount) : 0n;
        const postAmount = BigInt(postAccount.uiTokenAmount.amount);
        const decimals = postAccount.uiTokenAmount.decimals;
        const tokenDiff = BigInt(postAmount - preAmount);
        if (tokenDiff !== 0n) {
            const formattedDiff = Number(tokenDiff) / 10 ** decimals;
            console.log(`Compte Token #${postAccount.accountIndex} (${postAccount.owner}) : ${tokenDiff > 0n ? '+' : ''}${formattedDiff.toLocaleString()} tokens`);
        }
    });
    console.log();
}
