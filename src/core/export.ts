// Text exports: schematic as SVG, plot data as CSV.
import { junctions, pinWorld, placedBounds, shownValue, symbolGraphics } from "./netlist";
import { circuitPages, type Graphic, type Schematic } from "./schematic";
import type { SimResult } from "./sim";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function shape(g: Graphic): string {
  const pts = (list: { x: number; y: number }[]) => list.map((p) => `${Number(p.x)},${Number(p.y)}`).join(" ");
  const fill = (filled: boolean) => (filled ? "#1c4e80" : "none");
  switch (g.kind) {
    case "line": return `<polyline points="${pts(g.points)}" fill="none"/>`;
    case "polygon": return `<polygon points="${pts(g.points)}" fill="${fill(g.filled)}"/>`;
    case "rect": return `<rect x="${Number(g.x)}" y="${Number(g.y)}" width="${Number(g.w)}" height="${Number(g.h)}" fill="${fill(g.filled)}"/>`;
    case "ellipse": return `<ellipse cx="${Number(g.cx)}" cy="${Number(g.cy)}" rx="${Math.abs(g.rx)}" ry="${Math.abs(g.ry)}" fill="${fill(g.filled)}"/>`;
    case "text": return `<text x="${Number(g.x)}" y="${Number(g.y)}" font-size="${Number(g.size)}" text-anchor="middle" dominant-baseline="middle" stroke="none" fill="#1c4e80">${escape(g.text)}</text>`;
  }
}

// Text widths can't be measured here, so this errs wide, to keep every letter inside the picture.
const textWidth = (text: string, size = 10) => text.length * size * 0.65;

export function schematicToSvg(doc: Schematic): string {
  if (doc.pages?.length || doc.blocks?.length) {
    const sheets = [...circuitPages(doc), ...(doc.blocks ?? [])];
    let y = 0, width = 0;
    const pictures = sheets.map((sheet) => {
      const svg = schematicToSvg({ ...sheet, pages: undefined, blocks: undefined });
      const [, , w, h] = /viewBox="([^"]+)"/.exec(svg)![1].split(" ").map(Number);
      width = Math.max(width, w);
      const picture = `<g transform="translate(0 ${y})"><text x="10" y="20" font-size="14">${escape(sheet.name)}</text>${svg.replace(/^<svg /, '<svg y="30" ')}</g>`;
      y += h + 60;
      return picture;
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${y}" viewBox="0 0 ${width} ${y}">${pictures.join("")}</svg>`;
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  };
  const body: string[] = [];
  for (const wire of doc.wires) {
    wire.points.forEach((p) => add(p.x, p.y));
    body.push(`<polyline points="${wire.points.map((p) => `${Number(p.x)},${Number(p.y)}`).join(" ")}" fill="none" stroke="#c92a2a"/>`);
  }
  for (const { x, y } of junctions(doc)) body.push(`<circle cx="${Number(x)}" cy="${Number(y)}" r="2.6" fill="#c92a2a"/>`);
  for (const comp of doc.components) {
    const b = placedBounds(comp);
    add(b.x0, b.y0);
    add(b.x1, b.y1);
    const graphics = symbolGraphics(comp);
    for (const g of graphics) {
      if (g.kind !== "text") continue;
      const half = textWidth(g.text, g.size) / 2;
      for (const corner of [{ x: g.x - half, y: g.y - g.size }, { x: g.x + half, y: g.y + g.size }]) {
        const at = pinWorld(comp, corner);
        add(at.x, at.y);
      }
    }
    const mirror = comp.mirrored ? " scale(-1,1)" : "";
    body.push(`<g transform="translate(${Number(comp.x)},${Number(comp.y)}) rotate(${Number(comp.rotation)})${mirror}" stroke="#1c4e80">${graphics.map(shape).join("")}</g>`);
    if (!comp.refDes || comp.kind === "ground") continue;
    // As on the sheet: the name above the part's box and the value below it.
    const center = (b.x0 + b.x1) / 2;
    const label = (text: string, top: number) => {
      const half = textWidth(text) / 2;
      add(center - half, top);
      add(center + half, top + 12);
      body.push(`<text x="${center}" y="${top + 9}" font-size="10" text-anchor="middle">${escape(text)}</text>`);
    };
    label(comp.refDes, b.y0 - 14);
    const value = shownValue(comp);
    if (value) label(value, b.y1 + 2);
  }
  for (const label of doc.labels) {
    if (label.hidden) continue;
    add(label.x, label.y);
    add(label.x + 4 + textWidth(label.net), label.y - 14);
    body.push(`<circle cx="${Number(label.x)}" cy="${Number(label.y)}" r="2" fill="#0b7285"/>`);
    body.push(`<text x="${label.x + 4}" y="${label.y - 4}" font-size="10" fill="#0b7285">${escape(label.net)}</text>`);
  }
  for (const note of doc.texts) {
    const rows = note.text.split("\n");
    add(note.x, note.y - 8);
    add(note.x + Math.max(...rows.map((row) => textWidth(row))), note.y + rows.length * 12);
    rows.forEach((row, i) => {
      body.push(`<text x="${Number(note.x)}" y="${note.y + i * 12 + 3.5}" font-size="10" xml:space="preserve">${escape(row)}</text>`);
    });
  }
  if (!Number.isFinite(x0)) { x0 = y0 = 0; x1 = y1 = 100; }
  const pad = 20;
  const width = x1 - x0 + 2 * pad;
  const height = y1 - y0 + 2 * pad;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x0 - pad} ${y0 - pad} ${width} ${height}" font-family="Helvetica, Arial, sans-serif" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="${x0 - pad}" y="${y0 - pad}" width="${width}" height="${height}" fill="#fff"/>${body.join("")}</svg>\n`;
}

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Several runs of one analysis, one row per sample, labelled by run in the first column. */
export function runsToCsv(runs: { label: string; result: SimResult }[]): string {
  const parts = runs.map((run) => resultToCsv(run.result).trimEnd().split("\n"));
  const rows = [`run,${parts[0][0]}`];
  runs.forEach((run, i) => {
    for (const row of parts[i].slice(1)) rows.push(`${csvCell(run.label)},${row}`);
  });
  return `${rows.join("\n")}\n`;
}

/** Complex values become magnitude and phase columns. */
export function resultToCsv(result: SimResult): string {
  const headers: string[] = [];
  const columns: ArrayLike<number>[] = [];
  if (result.axis) {
    headers.push(result.axis.name);
    columns.push(result.axis.re);
  }
  for (const v of result.vectors) {
    if (v.im) {
      headers.push(`${v.name} mag`, `${v.name} phase deg`);
      columns.push(
        Float64Array.from(v.re, (re, i) => Math.hypot(re, v.im![i])),
        Float64Array.from(v.re, (re, i) => (Math.atan2(v.im![i], re) * 180) / Math.PI),
      );
    } else {
      headers.push(v.name);
      columns.push(v.re);
    }
  }
  const rows = [headers.map(csvCell).join(",")];
  const n = columns[0]?.length ?? 0;
  for (let i = 0; i < n; i++) rows.push(columns.map((c) => c[i]).join(","));
  return `${rows.join("\n")}\n`;
}
