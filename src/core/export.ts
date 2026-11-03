// Text exports: schematic as SVG, plot data as CSV.
import { PART_BY_KIND } from "./library";
import { pinWorld } from "./netlist";
import type { Graphic, SchComponent, Schematic } from "./schematic";
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

function graphicsOf(comp: SchComponent): Graphic[] {
  return comp.graphics ?? PART_BY_KIND.get(comp.kind)?.graphics ?? [];
}

export function schematicToSvg(doc: Schematic): string {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  };
  const body: string[] = [];
  for (const wire of doc.wires) {
    wire.points.forEach((p) => add(p.x, p.y));
    body.push(`<polyline points="${wire.points.map((p) => `${Number(p.x)},${Number(p.y)}`).join(" ")}" fill="none" stroke="#c92a2a"/>`);
  }
  for (const comp of doc.components) {
    comp.pins.forEach((pin) => {
      const at = pinWorld(comp, pin);
      add(at.x, at.y);
    });
    add(comp.x - 40, comp.y - 40);
    add(comp.x + 40, comp.y + 40);
    const mirror = comp.mirrored ? " scale(-1,1)" : "";
    body.push(`<g transform="translate(${Number(comp.x)},${Number(comp.y)}) rotate(${Number(comp.rotation)})${mirror}" stroke="#1c4e80">${graphicsOf(comp).map(shape).join("")}</g>`);
    if (comp.refDes && comp.kind !== "ground") {
      body.push(`<text x="${Number(comp.x)}" y="${comp.y - 34}" font-size="10" text-anchor="middle">${escape(comp.refDes)}</text>`);
    }
  }
  for (const label of doc.labels) {
    if (label.hidden) continue;
    add(label.x, label.y);
    body.push(`<text x="${label.x + 4}" y="${label.y - 6}" font-size="10" fill="#0b7285">${escape(label.net)}</text>`);
  }
  for (const note of doc.texts) {
    add(note.x, note.y);
    note.text.split("\n").forEach((row, i) => {
      body.push(`<text x="${Number(note.x)}" y="${note.y + i * 12}" font-size="10">${escape(row)}</text>`);
    });
  }
  if (!Number.isFinite(x0)) { x0 = y0 = 0; x1 = y1 = 100; }
  const pad = 20;
  const box = `${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" font-family="Helvetica, Arial, sans-serif" stroke-width="1.3"><rect x="${x0 - pad}" y="${y0 - pad}" width="100%" height="100%" fill="#fff"/>${body.join("")}</svg>\n`;
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
