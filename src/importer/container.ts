// Outer file layout: magic, total size, then size-prefixed implode chunks.
import { implodeDecode } from "./implode";

const MAGIC = "MSMCompressedElectronicsWorkbenchXML";
const HEADER_SIZE = MAGIC.length + 8;
const CHUNK_HEADER_SIZE = 8;
const MAX_CHUNK = 1 << 24;
const MAX_TOTAL = 1 << 30;
/** Implode cannot expand beyond this ratio, so a larger declared size is a lie. */
const MAX_RATIO = 512;

function startsWith(bytes: Uint8Array, text: string): boolean {
  if (bytes.length < text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Returns the XML bytes held by a circuit file. Throws a clear Error on corrupt input. */
export function decodeContainer(bytes: Uint8Array): Uint8Array {
  if (!startsWith(bytes, MAGIC)) {
    // Not seen in the samples, but cheap to accept: the same XML stored uncompressed.
    if (startsWith(bytes, "<?xml") || startsWith(bytes, "<MSMElectronicsWorkbench")) return bytes;
    throw new Error("Not a Multisim circuit file.");
  }
  if (bytes.length < HEADER_SIZE) throw new Error("Corrupt circuit file: truncated header.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = view.getUint32(MAGIC.length, true);
  const high = view.getUint32(MAGIC.length + 4, true);
  if (high !== 0 || total > MAX_TOTAL || total > Math.max(bytes.length * MAX_RATIO, 1 << 20)) {
    throw new Error("Corrupt circuit file: declared size is larger than the file allows.");
  }
  const out = new Uint8Array(total);
  let pos = HEADER_SIZE;
  let produced = 0;
  while (pos < bytes.length) {
    if (pos + CHUNK_HEADER_SIZE > bytes.length) throw new Error("Corrupt circuit file: truncated chunk header.");
    const size = view.getUint32(pos, true);
    const compressed = view.getUint32(pos + 4, true);
    pos += CHUNK_HEADER_SIZE;
    if (compressed < 2 || pos + compressed > bytes.length) throw new Error("Corrupt circuit file: truncated chunk.");
    if (size > MAX_CHUNK || produced + size > total) {
      throw new Error("Corrupt circuit file: chunk is larger than the declared size allows.");
    }
    const end = implodeDecode(bytes, pos, pos + compressed, out, produced, produced + size);
    if (end - produced !== size) throw new Error("Corrupt circuit file: chunk is shorter than its declared size.");
    produced = end;
    pos += compressed;
  }
  if (produced !== total) throw new Error("Corrupt circuit file: data ends before the declared size.");
  return out;
}
