import { describe, expect, it } from "vitest";
import { buildExample, EXAMPLES } from "../../src/core/examples";
import { parseCircuit, serializeCircuit } from "../../src/core/file";
import { schematicToSvg } from "../../src/core/export";
import { jpegToPdf, PAPER_SIZES, renderPrintPage, type PaperSize } from "../../src/core/print";
import { Doc } from "../../src/core/doc";
import { importMs14 } from "../../src/importer";
import { ms14Xml, serializeMs14 } from "../../src/importer/writer";

const fixture = () => ({ schematic: buildExample(EXAMPLES[0]), analyses: [], issues: [] });
const titleBlock = { title: 'Filter <A> & "B"', author: "Engineer Ω", company: "Circuit Co", documentNumber: "DOC-42", revision: "C", date: "2026-11-06" };

describe("print pages", () => {
  it("uses physical paper sizes in either orientation", () => {
    const sizes = { A4: [210, 297], A3: [297, 420], "US Letter": [215.9, 279.4], "US Tabloid": [279.4, 431.8] };
    expect(PAPER_SIZES).toEqual(sizes);
    for (const [paper, [w, h]] of Object.entries(sizes)) {
      for (const orientation of ["portrait", "landscape"] as const) {
        const page = renderPrintPage(fixture().schematic, { paper: paper as PaperSize, orientation });
        expect([page.width, page.height]).toEqual(orientation === "portrait" ? [w, h] : [h, w]);
        expect(page.svg).toContain(`width="${page.width}mm" height="${page.height}mm"`);
      }
    }
  });

  it("fits every original example within the drawing area, accounting for margins and title block", () => {
    for (const example of EXAMPLES) {
      const doc = buildExample(example);
      const page = renderPrintPage(doc, { margins: { top: 12, right: 15, bottom: 18, left: 21 } });
      const [, , w, h] = /viewBox="([^"]+)"/.exec(schematicToSvg(doc))![1].split(" ").map(Number);
      expect(page.drawing).toEqual({ x: 21, y: 12, width: 174, height: 223 });
      expect(page.scale).toBeCloseTo(Math.min(174 / w, 223 / h), 10);
      expect(page.clipped).toBe(false);
      expect(w * page.scale).toBeLessThanOrEqual(174 + 1e-8);
      expect(h * page.scale).toBeLessThanOrEqual(223 + 1e-8);
    }
  });

  it("defines fixed scale in physical units and clips oversized drawings", () => {
    const doc = fixture().schematic;
    expect(renderPrintPage(doc, { scale: 1 }).scale).toBeCloseTo(25.4 / 96);
    const page = renderPrintPage(doc, { scale: 100 });
    expect(page.clipped).toBe(true);
    expect(page.svg).toContain('clip-path="url(#drawing)"');
    for (const scale of [0, -1, NaN, Infinity]) expect(() => renderPrintPage(doc, { scale })).toThrow("Scale");
    for (const margins of [-1, Infinity, 100]) expect(() => renderPrintPage(doc, { margins })).toThrow();
  });

  it("prints escaped fields, sheet count and black ink on white", () => {
    const doc = fixture().schematic;
    doc.titleBlock = titleBlock;
    const { svg } = renderPrintPage(doc);
    expect(svg).toContain("Title: Filter &lt;A&gt; &amp; &quot;B&quot;");
    for (const value of [titleBlock.author, titleBlock.company, titleBlock.documentNumber, titleBlock.revision, titleBlock.date, "Sheet 1 of 1", "Microsim"]) expect(svg).toContain(value);
    expect(svg).not.toMatch(/#(?:1c4e80|c92a2a|0b7285)/);
    expect(svg).toContain('fill="white"');
    delete doc.titleBlock;
    expect(renderPrintPage(doc).svg).toContain(`Title: ${doc.name}`);
    doc.titleBlock = { title: "x".repeat(500) };
    expect(renderPrintPage(doc).svg).toContain('lengthAdjust="spacingAndGlyphs"');
  });

  it("preserves colour codes written as schematic text while converting ink", () => {
    const doc = fixture().schematic;
    doc.texts.push({ id: "colour-note", x: 0, y: 0, text: "Use #c92a2a & #1c4e80" });
    const { svg } = renderPrintPage(doc);
    expect(svg).toContain("Use #c92a2a &amp; #1c4e80");
    expect(svg).not.toMatch(/(?:fill|stroke)="#(?:1c4e80|c92a2a|0b7285)"/);
  });
});

describe("title-block persistence", () => {
  it("round-trips .microsim and .ms14 editor extensions including Unicode", () => {
    const file = fixture();
    file.schematic.titleBlock = titleBlock;
    expect(parseCircuit(serializeCircuit(file)).schematic).toEqual(file.schematic);
    expect(importMs14(serializeMs14(file)).schematic).toEqual(file.schematic);
  });

  it("preserves title edits when saving an imported native circuit", () => {
    const raw = ms14Xml(fixture()).replace(/<!--MicrosimDocument[\s\S]*?-->/g, "");
    const file = importMs14(new TextEncoder().encode(raw), { retainSource: true });
    file.schematic.titleBlock = titleBlock;
    expect(importMs14(serializeMs14(file)).schematic.titleBlock).toEqual(titleBlock);
  });

  it("leaves old documents without title metadata and validates optional fields", () => {
    const file = fixture();
    expect(parseCircuit(serializeCircuit(file)).schematic).toEqual(file.schematic);
    expect(parseCircuit(serializeCircuit(file)).schematic).not.toHaveProperty("titleBlock");
    for (const invalid of [null, [], "title", ...Object.keys(titleBlock).map((key) => ({ [key]: 42 }))]) {
      expect(() => parseCircuit(JSON.stringify({ ...file.schematic, titleBlock: invalid }))).toThrow("title block");
    }
  });

  it("includes title edits in undo and redo", () => {
    const doc = new Doc();
    doc.checkpoint();
    doc.schematic.titleBlock = titleBlock;
    doc.undo();
    expect(doc.schematic.titleBlock).toBeUndefined();
    doc.redo();
    expect(doc.schematic.titleBlock).toEqual(titleBlock);
  });
});

describe("PDF container", () => {
  it("writes physical page bounds, binary stream lengths, xref byte offsets and trailer", () => {
    // Binary bytes and PDF-like text ensure offsets do not depend on text decoding.
    const jpeg = new Uint8Array([255, 216, 0, 128, 10, 255, 217]);
    const pdf = jpegToPdf({ width: 210, height: 297 }, jpeg, { width: 2480, height: 3508 });
    const text = Buffer.from(pdf).toString("latin1");
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.endsWith("%%EOF\n")).toBe(true);
    expect(text).toContain("/MediaBox [0 0 595.2755905511812 841.8897637795276]");
    expect(text).toContain("/Width 2480 /Height 3508 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length 7");
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xref, xref + 9)).toBe("xref\n0 6\n");
    const entries = text.slice(xref).split("\n").slice(3, 8);
    entries.forEach((entry, i) => {
      expect(entry).toMatch(/^\d{10} 00000 n $/);
      const offset = Number(entry.slice(0, 10));
      expect(text.slice(offset, offset + 7)).toBe(`${i + 1} 0 obj`);
    });
    const imageStart = text.indexOf("stream\n", text.indexOf("4 0 obj")) + 7;
    expect(pdf.slice(imageStart, imageStart + jpeg.length)).toEqual(jpeg);
    expect(text.slice(imageStart + jpeg.length)).toMatch(/^\nendstream\nendobj/);
    expect(text).toContain("trailer\n<< /Size 6 /Root 1 0 R >>");
  });
});
