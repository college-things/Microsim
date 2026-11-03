// PKWARE Data Compression Library "implode" decoder, from the public format description.

const LITLEN = [
  11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8,
  9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5,
  7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11, 8, 11, 9, 12,
  8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27,
  44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45,
  44, 173,
];
const LENLEN = [2, 35, 36, 53, 38, 23];
const DISTLEN = [2, 20, 53, 230, 247, 151, 248];
const BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264];
const EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];
const MAX_BITS = 13;
const END_OF_STREAM = 519;

interface Huffman {
  count: Uint16Array;
  symbol: Uint16Array;
}

/** Expands run-length code lengths into canonical count and symbol tables. */
function buildTable(runs: number[]): Huffman {
  const lengths: number[] = [];
  for (const run of runs) {
    for (let i = (run >> 4) + 1; i > 0; i--) lengths.push(run & 15);
  }
  const count = new Uint16Array(MAX_BITS + 1);
  for (const length of lengths) count[length]++;
  const offsets = new Uint16Array(MAX_BITS + 2);
  for (let i = 1; i <= MAX_BITS; i++) offsets[i + 1] = offsets[i] + count[i];
  const symbol = new Uint16Array(lengths.length);
  lengths.forEach((length, sym) => {
    if (length) symbol[offsets[length]++] = sym;
  });
  return { count, symbol };
}

const LIT_TABLE = buildTable(LITLEN);
const LEN_TABLE = buildTable(LENLEN);
const DIST_TABLE = buildTable(DISTLEN);

/** Exposed so tests can build streams with the same codes. */
export const IMPLODE_TABLES = { literal: LIT_TABLE, length: LEN_TABLE, distance: DIST_TABLE, BASE, EXTRA };

class BitReader {
  private buf = 0;
  private cnt = 0;

  constructor(
    private readonly data: Uint8Array,
    public pos: number,
    private readonly end: number,
  ) {}

  take(need: number): number {
    while (this.cnt < need) {
      if (this.pos >= this.end) throw new Error("Corrupt circuit file: implode stream is truncated.");
      this.buf |= this.data[this.pos++] << this.cnt;
      this.cnt += 8;
    }
    const value = this.buf & ((1 << need) - 1);
    this.buf >>>= need;
    this.cnt -= need;
    return value;
  }

  decode(table: Huffman): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let length = 1; length <= MAX_BITS; length++) {
      code |= this.take(1) ^ 1;
      const n = table.count[length];
      if (code < first + n) return table.symbol[index + (code - first)];
      index += n;
      first = (first + n) << 1;
      code <<= 1;
    }
    throw new Error("Corrupt circuit file: invalid implode code.");
  }
}

/**
 * Decodes one stream from data[start, end) into out starting at outStart, writing at most
 * up to outEnd. Back references may not reach before outStart. Returns the end of the output.
 */
export function implodeDecode(
  data: Uint8Array,
  start: number,
  end: number,
  out: Uint8Array,
  outStart: number,
  outEnd: number,
): number {
  if (end - start < 2) throw new Error("Corrupt circuit file: implode stream is truncated.");
  const coded = data[start];
  const dictBits = data[start + 1];
  if (coded > 1 || dictBits < 4 || dictBits > 6) {
    throw new Error(`Corrupt circuit file: bad implode header (${coded}, ${dictBits}).`);
  }
  const bits = new BitReader(data, start + 2, end);
  let at = outStart;
  for (;;) {
    if (bits.take(1)) {
      const sym = bits.decode(LEN_TABLE);
      const length = BASE[sym] + bits.take(EXTRA[sym]);
      if (length === END_OF_STREAM) return at;
      const shift = length === 2 ? 2 : dictBits;
      const dist = (bits.decode(DIST_TABLE) << shift) + bits.take(shift) + 1;
      if (dist > at - outStart) throw new Error("Corrupt circuit file: implode distance is too far back.");
      if (at + length > outEnd) throw new Error("Corrupt circuit file: chunk is larger than its declared size.");
      // The ranges may overlap on purpose, so this copies byte by byte.
      for (let i = 0; i < length; i++, at++) out[at] = out[at - dist];
    } else {
      if (at >= outEnd) throw new Error("Corrupt circuit file: chunk is larger than its declared size.");
      out[at++] = coded ? bits.decode(LIT_TABLE) : bits.take(8);
    }
  }
}
