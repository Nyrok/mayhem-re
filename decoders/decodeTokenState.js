import {
    fixCodecSize,
    getAddressDecoder,
    getBooleanDecoder,
    getBytesDecoder,
    getI64Decoder,
    getStructDecoder,
    getU64Decoder
} from "@solana/kit";

export function getTokenStateDecoder() {
    return getStructDecoder([
        ["startTime", getU64Decoder()],
        ["endTime", getU64Decoder()],
        ["targetMint", getAddressDecoder()],
        ["totalSolsBought", getI64Decoder()],
        [void 0, fixCodecSize(getBytesDecoder(), 8)],
        ["totalTokensSold", getI64Decoder()],
        [void 0, fixCodecSize(getBytesDecoder(), 9)],
        ["lastUpdate", getU64Decoder()],
        ["isRunning", getBooleanDecoder()],
    ]);
}

export function decodeTokenState(uint8Data) {
    const buffer = Buffer.from(uint8Data);
    return getTokenStateDecoder().decode(buffer.subarray(8));
}
