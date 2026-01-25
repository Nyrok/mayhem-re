import {
    getAddressDecoder, getI16Decoder,
    getI64Decoder,
    getStructDecoder,
    getU64Decoder,
} from '@solana/kit';

export function getMayhemVirtualParamsEventDecoder() {
    return getStructDecoder([
        ['timestamp', getI64Decoder()],
        ['mint', getAddressDecoder()],
        ['virtualTokenReserves', getU64Decoder()],
        ['virtualSolReserves', getU64Decoder()],
        ['newVirtualTokenReserves', getU64Decoder()],
        ['newVirtualSolReserves', getU64Decoder()],
        ['realTokenReserves', getU64Decoder()],
        ['realSolReserves', getU64Decoder()],
    ]);
}

export function decodeMayhemVirtualParamsEvent(uint8Data) {
    const buffer = Buffer.from(uint8Data);
    return getMayhemVirtualParamsEventDecoder().decode(buffer.subarray(16));
}
