// Comments carry the complete circuit document, including optional title-block fields,
// without adding unknown native classes or huge attributes.
export function encodeEditorExtension(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const count = Math.max(1, Math.ceil(bytes.length / 32000));
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    let binary = "";
    for (const byte of bytes.subarray(i * 32000, (i + 1) * 32000)) binary += String.fromCharCode(byte);
    parts.push(`<!--MicrosimDocument:v1:${i + 1}/${count}:${btoa(binary)}-->`);
  }
  return parts.join("\n");
}
export function decodeEditorExtension(xml: string): string | undefined {
  const matches = [...xml.matchAll(/<!--MicrosimDocument:v(\d+):(\d+)\/(\d+):([A-Za-z0-9+/=]*)-->/g)];
  if (!matches.length) return undefined;
  const count = Number(matches[0][3]);
  if (count > 10000 || count !== matches.length || matches.some((m, i) => m[1] !== "1" || Number(m[2]) !== i + 1 || Number(m[3]) !== count)) throw new Error("Corrupt circuit file: incomplete editor extension.");
  const parts = matches.map((m) => Uint8Array.from(atob(m[4]), (s) => s.charCodeAt(0)));
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.length; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
