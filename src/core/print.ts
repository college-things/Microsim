// Sheet print layout and multi-page PDF export. Page coordinates and margins are millimetres.
import { schematicToSvg } from "./export";
import { circuitPages, type Schematic } from "./schematic";

export const PAPER_SIZES = {
  A4: [210, 297], A3: [297, 420], "US Letter": [215.9, 279.4], "US Tabloid": [279.4, 431.8],
} as const;
export type PaperSize = keyof typeof PAPER_SIZES;
export interface PrintOptions {
  paper?: PaperSize;
  orientation?: "portrait" | "landscape";
  margins?: number | { top: number; right: number; bottom: number; left: number };
  /** Fixed scale: 1 means one schematic unit is one CSS pixel (96 units/inch). */
  scale?: "fit" | number;
}
export interface PrintPage {
  svg: string;
  width: number;
  height: number;
  scale: number;
  clipped: boolean;
  drawing: { x: number; y: number; width: number; height: number };
}

const xml = (s: string) => s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderPrintPages(doc: Schematic, options: PrintOptions = {}): PrintPage[] {
  const sheets = [...circuitPages(doc), ...(doc.blocks ?? [])];
  return sheets.map((sheet, i) => renderPrintPage({ ...sheet, pages: undefined, blocks: undefined, titleBlock: { ...doc.titleBlock, title: `${doc.titleBlock?.title ?? doc.name}${sheets.length > 1 ? ` — ${sheet.name}` : ""}` } }, options, i + 1, sheets.length));
}

export function renderPrintPage(doc: Schematic, options: PrintOptions = {}, sheetNumber = 1, sheetCount = 1): PrintPage {
  let [width, height]: number[] = [...PAPER_SIZES[options.paper ?? "A4"]];
  if (options.orientation === "landscape") [width, height] = [height, width];
  const margin = options.margins ?? 10;
  const m = typeof margin === "number" ? { top: margin, right: margin, bottom: margin, left: margin } : margin;
  if (!Object.values(m).every((v) => Number.isFinite(v) && v >= 0)) throw new Error("Margins must be zero or greater.");
  const innerWidth = width - m.left - m.right, innerHeight = height - m.top - m.bottom;
  if (innerWidth < 60 || innerHeight < 70) throw new Error("Margins leave too little room for the schematic and title block.");
  const drawing = { x: m.left, y: m.top, width: innerWidth, height: innerHeight - 44 };
  // Keep the existing drawing and its conservative text bounds, replacing only ink colours.
  const source = schematicToSvg(doc).replace(/(fill|stroke)="#(?:1c4e80|c92a2a|0b7285)"/g, '$1="#000"');
  const [sx, sy, sw, sh] = /viewBox="([^"]+)"/.exec(source)![1].split(" ").map(Number);
  const requested = options.scale ?? "fit";
  if (requested !== "fit" && (!Number.isFinite(requested) || requested <= 0)) throw new Error("Scale must be greater than zero.");
  const scale = requested === "fit" ? Math.min(drawing.width / sw, drawing.height / sh) : requested * 25.4 / 96;
  const dw = sw * scale, dh = sh * scale;
  const x = drawing.x + (drawing.width - dw) / 2, y = drawing.y + (drawing.height - dh) / 2;
  const picture = source.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const blockWidth = Math.min(180, innerWidth), bx = width - m.right - blockWidth, by = height - m.bottom - 40;
  const data = doc.titleBlock ?? {};
  const rows = [
    ["Title", data.title ?? doc.name], ["Drawn by", data.author ?? ""], ["Company", data.company ?? ""],
    ["Document number", data.documentNumber ?? ""], ["Revision", data.revision ?? ""], ["Date", data.date ?? ""],
    ["Microsim", `Sheet ${sheetNumber} of ${sheetCount}`],
  ];
  const rowHeight = 40 / rows.length;
  const title = rows.map(([label, value], i) => {
    const top = by + i * rowHeight;
    // Keep long fields inside their cell, without dropping their stored content.
    const text = `${label}: ${value}`.replace(/\s+/g, " ");
    const fit = text.length * 1.65 > blockWidth - 4 ? ` textLength="${blockWidth - 4}" lengthAdjust="spacingAndGlyphs"` : "";
    return `${i ? `<path d="M${bx} ${top}h${blockWidth}"/>` : ""}<text fill="black" stroke="none" x="${bx + 2}" y="${top + 4}"${fit}>${xml(text)}</text>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif"><rect width="${width}" height="${height}" fill="white"/><defs><clipPath id="drawing"><rect x="${drawing.x}" y="${drawing.y}" width="${drawing.width}" height="${drawing.height}"/></clipPath></defs><g clip-path="url(#drawing)"><svg x="${x}" y="${y}" width="${dw}" height="${dh}" viewBox="${sx} ${sy} ${sw} ${sh}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${picture}</svg></g><g fill="none" stroke="black" stroke-width="0.25"><rect x="${m.left}" y="${m.top}" width="${innerWidth}" height="${innerHeight}"/><rect x="${bx}" y="${by}" width="${blockWidth}" height="40"/></g><g stroke="black" stroke-width="0.25" font-size="3">${title}</g></svg>\n`;
  return { svg, width, height, scale, drawing, clipped: dw > drawing.width + 1e-8 || dh > drawing.height + 1e-8 };
}

/** PDF 1.4 with a single RGB JPEG image. Offsets and lengths count bytes, including binary data. */
export function jpegToPdf(page: Pick<PrintPage, "width" | "height">, jpeg: Uint8Array, pixels: { width: number; height: number }): Uint8Array {
  return jpegPagesToPdf([{ page, jpeg, pixels }]);
}

export function jpegPagesToPdf(pages: { page: Pick<PrintPage, "width" | "height">; jpeg: Uint8Array; pixels: { width: number; height: number } }[]): Uint8Array {
  if (!pages.length) throw new Error("There are no sheets to export.");
  const encode = (s: string) => new TextEncoder().encode(s);
  const chunks: Uint8Array[] = [];
  let length = 0;
  const append = (data: string | Uint8Array) => { const bytes = typeof data === "string" ? encode(data) : data; chunks.push(bytes); length += bytes.length; };
  const offsets = [0];
  const object = (id: number, body: string, stream?: Uint8Array) => {
    offsets[id] = length;
    append(`${id} 0 obj\n${body}\n`);
    if (stream) { append("stream\n"); append(stream); append("\nendstream\n"); }
    append("endobj\n");
  };
  append("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  pages.forEach(({ page, jpeg, pixels }, i) => {
    const w = page.width * 72 / 25.4, h = page.height * 72 / 25.4, id = 3 + i * 3;
    object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>`);
    object(id + 1, `<< /Type /XObject /Subtype /Image /Width ${pixels.width} /Height ${pixels.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);
    const content = encode(`q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`);
    object(id + 2, `<< /Length ${content.length} >>`, content);
  });
  const xref = length;
  const size = 3 + pages.length * 3;
  append(`xref\n0 ${size}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const result = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { result.set(chunk, at); at += chunk.length; }
  return result;
}

/** Browser/webview rasterization preserves Unicode and all existing SVG symbols. */
export async function printPageToPdf(page: PrintPage): Promise<Uint8Array> {
  return printPagesToPdf([page]);
}

export async function printPagesToPdf(pages: PrintPage[]): Promise<Uint8Array> {
  const images = [];
  for (const page of pages) {
    // data: images are allowed by the desktop shell's content policy.
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(page.svg)}`;
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("Could not render the print page.")); image.src = url; });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(page.width / 25.4 * 300);
    canvas.height = Math.round(page.height / 25.4 * 300);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create the PDF image.");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error("Could not encode the PDF image.")), "image/jpeg", 0.98));
    images.push({ page, jpeg: new Uint8Array(await blob.arrayBuffer()), pixels: { width: canvas.width, height: canvas.height } });
  }
  return jpegPagesToPdf(images);
}
