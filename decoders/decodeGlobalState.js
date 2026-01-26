import {
    getStructDecoder, getU64Decoder, getU32Decoder, getI32Decoder, getBytesDecoder, getAddressDecoder, fixCodecSize,
    getU128Decoder
} from '@solana/kit';

export function getGlobalStateDecoder() {
    return getStructDecoder([['slippageBps', getU64Decoder()],
        ['hardCapBuySol', getU64Decoder()],
        ['hardCapSellSol', getU64Decoder()],
        ['solHoldingMin', getU64Decoder()],
        ['sweepThreshold', getU64Decoder()],
        [void 0, fixCodecSize(getBytesDecoder(), 1)],
        ['adminFeeReceiver', getAddressDecoder()],
        ['programAuthority', getAddressDecoder()],
        ['unknownParameter1', getU128Decoder()],
        ['minTotalHolding', getU32Decoder()],
        [void 0, fixCodecSize(getBytesDecoder(), 21)],
        ['sessionTimeout', getU64Decoder()],
        ['unknownParameter2', getU32Decoder()],
        ['maxSession', getI32Decoder()],
    ]);
}

export function decodeGlobalState(uint8Data) {
    const buffer = Buffer.from(uint8Data);
    return getGlobalStateDecoder().decode(buffer.subarray(8));
}
