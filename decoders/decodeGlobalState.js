import {
    getStructDecoder,
    getU64Decoder,
    getU32Decoder,
    getI32Decoder,
    getBytesDecoder,
    getAddressDecoder,
    fixCodecSize
} from '@solana/kit';

export function getGlobalStateDecoder() {
    return getStructDecoder([
        ['slippageBps', getU64Decoder()],                // 8-16
        ['hardCapBuySol', getU64Decoder()],              // 16-24
        ['hardCapSellSol', getU64Decoder()],             // 24-32
        ['solHoldingMin', getU64Decoder()],              // 32-40
        ['sweepThreshold', getU64Decoder()],             // 40-48
        [void 0, fixCodecSize(getBytesDecoder(), 1)],             // 40-48
        ['adminFeeReceiver', getAddressDecoder()],       // 49-81
        ['programAuthority', getAddressDecoder()],       // 81-113
        ['unknownParameter1', getI32Decoder()],          // 113-117
        ['unknownParameter2', getU64Decoder()],          // 117-125
        [void 0, fixCodecSize(getBytesDecoder(), 4)],             // 40-48
        ['minTotalHolding', getU64Decoder()],            // 129-137
        ['unknownParameter3', getU32Decoder()],          // 137-145
        [void 0, fixCodecSize(getBytesDecoder(), 13)],             // 40-48
        ['sessionTimeout', getU64Decoder()],             // 154-162
        ['unknownParameter4', getU32Decoder()],          // 162-166
        ['maxSession', getI32Decoder()],                 // 166-170
    ]);
}

export function decodeGlobalState(uint8Data) {
    const buffer = Buffer.from(uint8Data);
    return getGlobalStateDecoder().decode(buffer.subarray(8));
}
