import {connection} from "./rpc.js";

export async function isRentExempt(publicKey) {
    try {
        const accountInfo = await connection.getAccountInfo(publicKey);
        if (accountInfo === null) {
            return false;
        }
        const rentExemptionAmount = await connection.getMinimumBalanceForRentExemption(
            accountInfo.data.length
        );
        return accountInfo.lamports >= rentExemptionAmount;
    } catch (error) {
        return false;
    }
}