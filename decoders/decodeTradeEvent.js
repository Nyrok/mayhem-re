import {
    addDecoderSizePrefix,
    getAddressDecoder,
    getBooleanDecoder,
    getI64Decoder,
    getStructDecoder,
    getU32Decoder,
    getU64Decoder,
    getUtf8Decoder,
} from '@solana/kit';
import bs58 from "bs58";

export function getTradeEventDecoder() {
    return getStructDecoder([
        ['mint', getAddressDecoder()],
        ['solAmount', getU64Decoder()],
        ['tokenAmount', getU64Decoder()],
        ['isBuy', getBooleanDecoder()],
        ['user', getAddressDecoder()],
        ['timestamp', getI64Decoder()],
        ['virtualSolReserves', getU64Decoder()],
        ['virtualTokenReserves', getU64Decoder()],
        ['realSolReserves', getU64Decoder()],
        ['realTokenReserves', getU64Decoder()],
        ['feeRecipient', getAddressDecoder()],
        ['feeBasisPoints', getU64Decoder()],
        ['fee', getU64Decoder()],
        ['creator', getAddressDecoder()],
        ['creatorFeeBasisPoints', getU64Decoder()],
        ['creatorFee', getU64Decoder()],
        ['trackVolume', getBooleanDecoder()],
        ['totalUnclaimedTokens', getU64Decoder()],
        ['totalClaimedTokens', getU64Decoder()],
        ['currentSolVolume', getU64Decoder()],
        ['lastUpdateTimestamp', getI64Decoder()],
        ['ixName', addDecoderSizePrefix(getUtf8Decoder(), getU32Decoder())],
        ['mayhemMode', getBooleanDecoder()],
    ]);
}

export function decodeTradeEvent(uint8Data) {
    const buffer = Buffer.from(uint8Data);
    return getTradeEventDecoder().decode(buffer.subarray(16));
}
