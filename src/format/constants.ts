export const BZIP_HEADER = new Uint8Array([0x42, 0x5a, 0x68]);

export const BLOCK_MARKER_HIGH = 0x314159;
export const BLOCK_MARKER_LOW = 0x265359;
export const STREAM_END_MARKER_HIGH = 0x177245;
export const STREAM_END_MARKER_LOW = 0x385090;

export const MAX_HUFFMAN_CODE_BITS = 20;
export const MAX_SYMBOLS = 258;
export const RUN_A = 0;
export const RUN_B = 1;
export const MIN_HUFFMAN_GROUPS = 2;
export const MAX_HUFFMAN_GROUPS = 6;
export const HUFFMAN_GROUP_SIZE = 50;

export const DEFAULT_OUTPUT_CHUNK_SIZE = 64 * 1024;
