import { describe, expect, it } from "vitest";
import { Doc } from "../../src/core/doc";
import { parseDeck } from "../../src/core/deck";
import { schematicToSvg } from "../../src/core/export";
import { parseCircuit, serializeCircuit } from "../../src/core/file";
import { buildNetlist, deckUsesGround, placedBounds, readValue } from "../../src/core/netlist";
import type { Schematic } from "../../src/core/schematic";

const deckSheet = (spice: string): Schematic => ({
  name: "deck", wires: [], labels: [], texts: [], definitions: "",
  components: [{ id: "c", refDes: "NETLIST", kind: "imported", x: 0, y: 0, rotation: 0, mirrored: false, params: {}, pins: [], spice }],
});

describe("ground in a plain SPICE deck", () => {
  it("doesn't warn when the deck uses node 0", () => {
    const { warnings } = buildNetlist(deckSheet("V1 a 0 DC 10\nR1 a b 1k\nR2 b 0 1k"));
    expect(warnings).not.toContain("The circuit has no ground connection.");
  });

  it("still warns when it doesn't", () => {
    const { warnings } = buildNetlist(deckSheet("V1 a b DC 10\nR1 a b 1k"));
    expect(warnings).toContain("The circuit has no ground connection.");
  });

  it("reads nodes, not values, models or comments", () => {
    expect(deckUsesGround("V1 a b 0")).toBe(false);
    expect(deckUsesGround("R1 a b 0")).toBe(false);
    expect(deckUsesGround("* R1 a 0 1k")).toBe(false);
    expect(deckUsesGround(".ic v(a)=0")).toBe(false);
    expect(deckUsesGround("Q1 c b 0 npn")).toBe(true);
    expect(deckUsesGround("X1 a 0 opamp")).toBe(true);
    expect(deckUsesGround("X1 a b sub r=0")).toBe(false);
    expect(deckUsesGround("X1 a b 0")).toBe(false);
    expect(deckUsesGround("A1 [a b] 0 gate")).toBe(true);
    expect(deckUsesGround("r1 a GND 1k")).toBe(true);
  });
});

describe("reading a SPICE file", () => {
  it("refuses empty and binary files", () => {
    expect(() => parseDeck("")).toThrow("This file is empty.");
    expect(() => parseDeck("\n  \n")).toThrow("This file is empty.");
    expect(() => parseDeck("PNG\0\x01\x02 bytes\nR1 a 0 1k")).toThrow("isn't a SPICE netlist");
  });

  it("refuses a file with nothing after its title", () => {
    expect(() => parseDeck("only a title")).toThrow("no circuit lines");
    expect(() => parseDeck("title\n* a comment\n.tran 1u 1m\n.end")).toThrow("no circuit lines");
  });

  it("keeps a Latin-1 comment and a DOS end-of-file mark", () => {
    expect(parseDeck("t\n* 4,7 k�\nR1 a 0 1k\n.end\n\x1a").body).toContain("R1 a 0 1k");
  });

  it("stops at .end and keeps each line where it was", () => {
    const deck = parseDeck("title\r\nV1 a 0 DC 1\r\nR1 a 0 1k\r\n.END\r\nthis is a note after end\r\n");
    expect(deck.title).toBe("title");
    expect(deck.body).toBe("V1 a 0 DC 1\nR1 a 0 1k");
  });

  it("doesn't take .ends for the end of the file", () => {
    expect(parseDeck("t\n.subckt s a\nR1 a 0 1\n.ends\nX1 b s\n.end").body).toContain("X1 b s");
  });

  it("reads the analyses a deck asks for", () => {
    const deck = parseDeck("t\nV1 a 0 PULSE(0 5 0 1u 1u 1m 2m) AC 1\nR1 a b 1k\nC1 b 0 1u\n.tran 10u 5m\n.AC dec 10 1 1meg\n.dc V1 0 5 0.5\n.op\n.tran nonsense\n.end");
    expect(deck.analyses).toEqual([
      { type: "tran", tstep: readValue("10u"), tstop: 5e-3 },
      { type: "ac", sweep: "dec", points: 10, fstart: 1, fstop: 1e6 },
      { type: "dc", source: "V1", start: 0, stop: 5, step: 0.5 },
      { type: "op" },
    ]);
  });
});

describe("opening a saved circuit", () => {
  const sheet = { name: "a", components: [], wires: [], labels: [], texts: [], definitions: "" };

  it("only blames a newer version when the file is really from one", () => {
    expect(() => parseCircuit(JSON.stringify({ format: "ohmlet", version: 2, schematic: sheet }))).toThrow("newer version");
    expect(() => parseCircuit(JSON.stringify({ format: "kicad", version: 1, schematic: sheet }))).toThrow("not a valid circuit file");
    expect(parseCircuit(JSON.stringify({ format: "microsim", version: 1, schematic: sheet })).schematic.name).toBe("a");
    // Files saved before the rename still open.
    expect(parseCircuit(JSON.stringify({ format: "ohmlet", version: 1, schematic: sheet })).schematic.name).toBe("a");
    expect(() => parseCircuit(JSON.stringify({ format: "other", version: 1, schematic: sheet }))).toThrow("not a Microsim circuit");
    expect(JSON.parse(serializeCircuit({ schematic: sheet, analyses: [], issues: [] })).format).toBe("microsim");
  });
});

describe("the exported SVG", () => {
  const texts = (svg: string) => [...svg.matchAll(/<text x="([-\d.]+)" y="([-\d.]+)"[^>]*>([^<]*)<\/text>/g)]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]), text: m[3] }));

  it("labels each part as the sheet does, by its own box", () => {
    const doc = new Doc();
    const r1 = doc.addPart("resistor", 0, 0);
    const r2 = doc.addPart("resistor", 300, 200);
    r2.rotation = 90;
    r2.params.value = "4.7k";
    const svg = schematicToSvg(doc.schematic);
    const shown = texts(svg);
    for (const comp of [r1, r2]) {
      const b = placedBounds(comp);
      const name = shown.find((t) => t.text === comp.refDes)!;
      expect(name.x).toBe((b.x0 + b.x1) / 2);
      expect(name.y).toBeLessThan(b.y0);
      const value = shown.find((t) => t.text === comp.params.value)!;
      expect(value.x).toBe((b.x0 + b.x1) / 2);
      expect(value.y).toBeGreaterThan(b.y1);
    }
  });

  it("makes room for all of a note", () => {
    const doc = new Doc();
    doc.schematic.texts.push({ id: "t", x: 0, y: 0, text: `first\n${"x".repeat(200)}\nthird\nfourth` });
    const box = /viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/.exec(schematicToSvg(doc.schematic))!.slice(1).map(Number);
    expect(box[0] + box[2]).toBeGreaterThan(200 * 6);
    expect(box[1] + box[3]).toBeGreaterThan(4 * 12);
  });

  it("marks where wires join", () => {
    const doc = new Doc();
    doc.schematic.wires.push(
      { id: "a", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
      { id: "b", points: [{ x: 50, y: 0 }, { x: 50, y: 50 }] },
    );
    expect(schematicToSvg(doc.schematic)).toContain('<circle cx="50" cy="0"');
  });
});
