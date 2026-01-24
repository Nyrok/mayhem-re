import {
    getAddressDecoder,
    getBooleanDecoder,
    getStructDecoder,
    getU64Decoder,
} from '@solana/kit';

export function getBondingCurveDecoder() {
    return getStructDecoder([
        // IDL: "virtual_token_reserves": "u64"
        ['virtualTokenReserves', getU64Decoder()],

        // IDL: "virtual_sol_reserves": "u64"
        ['virtualSolReserves', getU64Decoder()],

        // IDL: "real_token_reserves": "u64"
        ['realTokenReserves', getU64Decoder()],

        // IDL: "real_sol_reserves": "u64"
        ['realSolReserves', getU64Decoder()],

        // IDL: "token_total_supply": "u64"
        ['tokenTotalSupply', getU64Decoder()],

        // IDL: "complete": "bool"
        ['complete', getBooleanDecoder()],

        // IDL: "creator": "pubkey"
        ['creator', getAddressDecoder()],

        // IDL: "is_mayhem_mode": "bool"
        ['isMayhemMode', getBooleanDecoder()],
    ]);
}

export function decodeBondingCurve(uint8Data) {
    const buffer = Buffer.from(uint8Data);
    return getBondingCurveDecoder().decode(buffer.subarray(8));
}
