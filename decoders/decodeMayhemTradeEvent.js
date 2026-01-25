import {
    getAddressDecoder,
    getI64Decoder,
    getStructDecoder,
    getU8Decoder,
    getU32Decoder,
    getU64Decoder,
    getU128Decoder, fixCodecSize, getBytesDecoder, getI16Decoder, getI32Decoder, getI128Decoder,
} from '@solana/kit';

export function getMayhemTradeEventDecoder() {
    return getStructDecoder([
        ['actionType', getU8Decoder()],
        ['maker', getAddressDecoder()],
        ['mint', getAddressDecoder()],
        ['solAmount', getU64Decoder()],
        ['tokenAmount', getU64Decoder()],
        ['XpreTradeVirtualSolReserves', getU64Decoder()],
        ['XpreTradeVirtualTokenReserves', getU64Decoder()],
        ['totalSolBought', getI128Decoder()],
        ['totalTokensSold', getI128Decoder()],
        ['virtualSolReserves', getU64Decoder()],
        ['virtualTokenReserves', getU64Decoder()],
        ['XpreTradeRealTokenReserves', getU64Decoder()],
        [void 0, fixCodecSize(getBytesDecoder(), 8)],
        ['tradeTime', getI64Decoder()],
        ['endTime', getI64Decoder()],
        ['realSolReserves', getU64Decoder()],
        ['realTokenReserves', getU64Decoder()],
        ['constant', getU32Decoder()],
    ]);
}

export function decodeMayhemTradeEvent(uint8Data) {
    const buffer = Buffer.from(uint8Data);
    return getMayhemTradeEventDecoder().decode(buffer.subarray(16));
}

export function calculateMayhemRatios(event) {
    const tokenInvariant = BigInt(event.virtualTokenReserves) + BigInt(event.XpreTradeVirtualTokenReserves);

    const refSol = Number(event.XpreTradeVirtualSolReserves);
    const virtSol = Number(event.virtualSolReserves);
    const realSol = Number(event.realSolReserves);

    const compressionRVRatio = refSol / virtSol;
    const compressionRRRatio = refSol / realSol;
    const compressionVRRatio = virtSol / realSol;

    const solDeltaReal = event.solAmount;

    return {
        action: event.actionType ? 'sell' : 'buy',
        compressionRatioRV: parseFloat(compressionRVRatio.toFixed(4)),
        compressionRatioRR: parseFloat(compressionRRRatio.toFixed(4)),
        compressionRatioVR: parseFloat(compressionVRRatio.toFixed(4)),
        refSol, realSol,
        totalSolBought: event.totalSolBought,
        totalTokensSold: event.totalTokensSold,
        tradeTime: event.tradeTime,
    };
}
