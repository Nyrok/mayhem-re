import {
    fixCodecSize, getBytesDecoder, getStructDecoder, getU16Decoder, getU64Decoder,
} from '@solana/kit';

const BUY_DISCRIMINATOR = '66063d1201daebea';
const SELL_DISCRIMINATOR = '33e685a4017f83ad';

export function getMayhemIxDataDecoder() {
    return getStructDecoder([['marketCap', getU64Decoder()], [void 0, fixCodecSize(getBytesDecoder(), 8)], ["maxPriceImpact", getU16Decoder()],]);
}

export function decodeMayhemIxDataEvent(uint8Data) {
    const buffer = Buffer.from(uint8Data);
    return {
        type: buffer.subarray(0, 8).toString('hex') === BUY_DISCRIMINATOR ? 'buy' : 'sell',
        ...getMayhemIxDataDecoder().decode(buffer.subarray(8))
    };
}
