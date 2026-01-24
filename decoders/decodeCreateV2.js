import {
    getStructDecoder, getAddressDecoder, getBooleanDecoder, addDecoderSizePrefix, getUtf8Decoder, getU32Decoder,
} from "@solana/kit";

export function getCreateV2Decoder() {
    const borshStringDecoder = addDecoderSizePrefix(getUtf8Decoder(), getU32Decoder());
    return getStructDecoder([
        ['name', borshStringDecoder],
        ['symbol', borshStringDecoder],
        ['uri', borshStringDecoder],
        ['creator', getAddressDecoder()],
        ['isMayhemMode', getBooleanDecoder()]
    ]);
}

export function decodeCreateV2(uint8Data) {
    const buffer = Buffer.from(uint8Data);
    return getCreateV2Decoder().decode(buffer.subarray(8));
}
