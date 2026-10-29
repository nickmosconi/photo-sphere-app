// A small baseline JPEG encoder that takes the picture a band of rows at a time, so a sphere
// bigger than Safari's canvas limit can be saved without ever holding the whole image.
// Standard JFIF: YCbCr with 4:2:0 color subsampling and the example tables from the JPEG
// standard (ITU T.81, Annex K), scaled for quality like libjpeg.
//
// Use: const enc = new JpegEncoder(width, height, 92);
//      enc.addRows(rgba, rowStride, x0, rows);  // repeatedly, top to bottom, rows a multiple of 16
//      const blob = enc.finish();
// width and height must be multiples of 16.

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
  28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
  47, 55, 62, 63,
];

const LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51,
  87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];

const CHROMA_Q = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99,
  99, 99, 99, ...new Array(32).fill(99),
];

const DC_LUMA = { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const DC_CHROMA = { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const AC_LUMA = {
  bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  vals: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14,
    0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09,
    0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a,
    0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65,
    0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88,
    0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9,
    0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca,
    0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
    0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};
const AC_CHROMA = {
  bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  vals: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32,
    0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16,
    0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39,
    0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64,
    0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86,
    0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8,
    0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9,
    0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};

// Cosine table for the 8×8 DCT: COS[x * 8 + u] = C(u)/2 · cos((2x + 1)uπ / 16).
const COS = new Float32Array(64);
for (let x = 0; x < 8; x++) {
  for (let u = 0; u < 8; u++) {
    COS[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * 0.5 * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
}

export class JpegEncoder {
  constructor(width, height, quality = 92) {
    if (width % 16 || height % 16) throw new Error("JPEG size must be a multiple of 16.");
    this.width = width;
    this.height = height;
    this.rowsDone = 0;
    this.lumaQ = scaleTable(LUMA_Q, quality);
    this.chromaQ = scaleTable(CHROMA_Q, quality);
    this.dcLuma = huffmanCodes(DC_LUMA);
    this.acLuma = huffmanCodes(AC_LUMA);
    this.dcChroma = huffmanCodes(DC_CHROMA);
    this.acChroma = huffmanCodes(AC_CHROMA);
    this.prevDc = [0, 0, 0];
    this.out = new ByteWriter();
    this.bits = 0; // bit buffer
    this.bitCount = 0;
    this.block = new Float32Array(64);
    this.temp = new Float32Array(64);
    this.coefs = new Int32Array(64);
    this.cb = new Float32Array(64);
    this.cr = new Float32Array(64);
    this.#writeHeaders();
  }

  // Adds `rows` rows (a multiple of 16) of RGBA pixels. Pixel (x, y) of this band is read from
  // rgba[y * stride + (x0 + x) * 4]; stride is in bytes.
  addRows(rgba, stride, x0, rows) {
    if (rows % 16) throw new Error("Add rows in multiples of 16.");
    for (let my = 0; my < rows; my += 16) {
      for (let mx = 0; mx < this.width; mx += 16) this.#encodeMcu(rgba, stride, x0 + mx, my);
    }
    this.rowsDone += rows;
  }

  // Returns the finished JPEG as a Blob.
  finish() {
    if (this.rowsDone !== this.height) throw new Error(`Only ${this.rowsDone} of ${this.height} rows were added.`);
    // Pad the last byte with 1s, as the standard asks.
    if (this.bitCount > 0) this.#writeBits((1 << (8 - this.bitCount)) - 1, 8 - this.bitCount);
    this.out.bytes([0xff, 0xd9]); // end of image
    return this.out.toBlob("image/jpeg");
  }

  // One 16×16 block of pixels: four 8×8 luminance blocks plus one each of Cb and Cr
  // (averaged over 2×2 pixels).
  #encodeMcu(rgba, stride, px, py) {
    const { block, cb, cr } = this;
    cb.fill(0);
    cr.fill(0);
    for (let by = 0; by < 16; by += 8) {
      for (let bx = 0; bx < 16; bx += 8) {
        for (let y = 0; y < 8; y++) {
          let i = (py + by + y) * stride + (px + bx) * 4;
          for (let x = 0; x < 8; x++, i += 4) {
            const r = rgba[i];
            const g = rgba[i + 1];
            const b = rgba[i + 2];
            block[y * 8 + x] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
            const c = ((by + y) >> 1) * 8 + ((bx + x) >> 1);
            cb[c] += -0.168736 * r - 0.331264 * g + 0.5 * b;
            cr[c] += 0.5 * r - 0.418688 * g - 0.081312 * b;
          }
        }
        this.#encodeBlock(block, this.lumaQ, 0, this.dcLuma, this.acLuma);
      }
    }
    for (let i = 0; i < 64; i++) {
      cb[i] *= 0.25;
      cr[i] *= 0.25;
    }
    this.#encodeBlock(cb, this.chromaQ, 1, this.dcChroma, this.acChroma);
    this.#encodeBlock(cr, this.chromaQ, 2, this.dcChroma, this.acChroma);
  }

  // DCT, quantize and Huffman-code one 8×8 block (values already shifted to −128…127).
  #encodeBlock(block, q, component, dcCodes, acCodes) {
    const { temp, coefs } = this;
    // Rows, then columns.
    for (let y = 0; y < 8; y++) {
      for (let u = 0; u < 8; u++) {
        let s = 0;
        for (let x = 0; x < 8; x++) s += block[y * 8 + x] * COS[x * 8 + u];
        temp[y * 8 + u] = s;
      }
    }
    for (let u = 0; u < 8; u++) {
      for (let v = 0; v < 8; v++) {
        let s = 0;
        for (let y = 0; y < 8; y++) s += temp[y * 8 + u] * COS[y * 8 + v];
        coefs[v * 8 + u] = Math.round(s / q[v * 8 + u]);
      }
    }

    const dc = coefs[0];
    const diff = dc - this.prevDc[component];
    this.prevDc[component] = dc;
    this.#writeValue(diff, dcCodes, 0);

    let zeros = 0;
    for (let k = 1; k < 64; k++) {
      const v = coefs[ZIGZAG[k]];
      if (v === 0) {
        zeros++;
        continue;
      }
      while (zeros > 15) {
        this.#writeCode(acCodes[0xf0]); // 16 zeros
        zeros -= 16;
      }
      this.#writeValue(v, acCodes, zeros << 4);
      zeros = 0;
    }
    if (zeros > 0) this.#writeCode(acCodes[0x00]); // end of block
  }

  // Writes a value as (Huffman code for run/size) followed by its bits.
  #writeValue(v, codes, run) {
    const a = Math.abs(v);
    let size = 0;
    while (a >> size) size++;
    this.#writeCode(codes[run | size]);
    if (size) this.#writeBits(v < 0 ? (v - 1) & ((1 << size) - 1) : v, size);
  }

  #writeCode([code, length]) {
    this.#writeBits(code, length);
  }

  #writeBits(value, count) {
    this.bits = (this.bits << count) | value;
    this.bitCount += count;
    while (this.bitCount >= 8) {
      const byte = (this.bits >> (this.bitCount - 8)) & 0xff;
      this.out.byte(byte);
      if (byte === 0xff) this.out.byte(0); // 0xFF in the data is followed by 0 so it isn't read as a marker
      this.bitCount -= 8;
    }
    this.bits &= (1 << this.bitCount) - 1;
  }

  #writeHeaders() {
    const o = this.out;
    o.bytes([0xff, 0xd8]); // start of image
    o.bytes([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]); // JFIF
    // Quantization tables, in zigzag order.
    o.bytes([0xff, 0xdb, 0, 132]);
    o.byte(0);
    for (let k = 0; k < 64; k++) o.byte(this.lumaQ[ZIGZAG[k]]);
    o.byte(1);
    for (let k = 0; k < 64; k++) o.byte(this.chromaQ[ZIGZAG[k]]);
    // Frame: 8-bit, size, 3 components (Y sampled 2×2, Cb and Cr 1×1).
    o.bytes([0xff, 0xc0, 0, 17, 8, this.height >> 8, this.height & 0xff, this.width >> 8, this.width & 0xff, 3]);
    o.bytes([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    // Huffman tables.
    const dht = (cls, id, t) => {
      o.bytes([0xff, 0xc4, 0, 3 + 16 + t.vals.length, (cls << 4) | id, ...t.bits, ...t.vals]);
    };
    dht(0, 0, DC_LUMA);
    dht(1, 0, AC_LUMA);
    dht(0, 1, DC_CHROMA);
    dht(1, 1, AC_CHROMA);
    // Start of scan.
    o.bytes([0xff, 0xda, 0, 12, 3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);
  }
}

// Quality 1–100 scaling of a quantization table, as libjpeg does it.
function scaleTable(base, quality) {
  const q = Math.max(1, Math.min(100, quality));
  const scale = q < 50 ? 5000 / q : 200 - 2 * q;
  return Int32Array.from(base, (b) => Math.max(1, Math.min(255, Math.floor((b * scale + 50) / 100))));
}

// [code, length] for each symbol, from the table's code-length counts.
function huffmanCodes({ bits, vals }) {
  const codes = [];
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < bits[length - 1]; i++) codes[vals[k++]] = [code++, length];
    code <<= 1;
  }
  return codes;
}

// Growable byte buffer, kept as a list of chunks.
class ByteWriter {
  constructor() {
    this.chunks = [];
    this.buf = new Uint8Array(1 << 20);
    this.pos = 0;
  }

  byte(b) {
    if (this.pos === this.buf.length) {
      this.chunks.push(this.buf);
      this.buf = new Uint8Array(1 << 20);
      this.pos = 0;
    }
    this.buf[this.pos++] = b;
  }

  bytes(list) {
    for (const b of list) this.byte(b);
  }

  toBlob(type) {
    return new Blob([...this.chunks, this.buf.subarray(0, this.pos)], { type });
  }
}
