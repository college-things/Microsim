import { describe, expect, it, vi } from "vitest";
import { Doc } from "../../src/core/doc";
import { boardFromSchematic, boardToKicad, checkBoard, padPosition } from "../../src/core/engineering";
import { parseCircuit, serializeCircuit } from "../../src/core/file";
import { buildNetlist, changesOverTime } from "../../src/core/netlist";
import { databaseKind, readComponentDatabase, registerDatabase, writeComponentDatabase } from "../../src/core/component-database";
import { exchangeLabview,exchangeLabviewVI } from "../../src/core/labview";
import { simulate } from "../../src/engine";
import { at } from "../engine/helpers";

function twoPads() {
  const doc = new Doc();
  const r1 = doc.addPart("resistor", 0, 0), r2 = doc.addPart("resistor", 100, 0);
  r1.pins[0].net = r2.pins[0].net = "a";
  r1.pins[1].net = r2.pins[1].net = "0";
  return doc;
}
describe("PCB layout", () => {
  it("keeps schematic nets and placements and reports routes still missing", () => {
    const doc = twoPads(); const b = boardFromSchematic(doc.schematic);
    expect(b.footprints[0].pads.map((p) => p.net)).toEqual(["a", "0"]);
    expect(checkBoard(b).filter((s) => /unconnected/.test(s))).toHaveLength(2);
    b.footprints[0].x = 50; b.footprints[0].rotation = 90;
    expect(padPosition(b.footprints[0], b.footprints[0].pads[1])).toEqual({ x: 50, y: 20.16 });
    expect(boardFromSchematic(doc.schematic, b).footprints[0].x).toBe(50);
    expect(boardToKicad(b)).toContain('(net 1 "a")');
    expect(boardToKicad(b)).toContain('"Edge.Cuts"');
  });
  it("detects a crossing short on one layer but permits crossing layers", () => {
    const b = { width: 50, height: 50, clearance: 0.25, footprints: [], tracks: [
      { net: "a", layer: "F.Cu" as const, width: 0.4, points: [{ x: 10, y: 10 }, { x: 30, y: 30 }] },
      { net: "b", layer: "F.Cu" as "F.Cu" | "B.Cu", width: 0.4, points: [{ x: 10, y: 30 }, { x: 30, y: 10 }] },
    ] };
    expect(checkBoard(b).join()).toContain("short");
    b.tracks[1].layer = "B.Cu"; expect(checkBoard(b)).toEqual([]);
  });
  it("detects disconnected copper islands on the same net", () => {
    const b = boardFromSchematic(twoPads().schematic);
    for (const f of b.footprints) for (const p of f.pads) {
      const a = padPosition(f, p); b.tracks.push({ net: p.net, layer: "F.Cu", width: 0.4, points: [a, { x: a.x, y: a.y + 2 }] });
    }
    expect(checkBoard(b).filter((s) => /unconnected/.test(s))).toHaveLength(2);
  });
});
describe("engineering persistence and catalogue", () => {
  it("round-trips board, sources and mappings, and rejects malformed geometry", () => {
    const doc = twoPads();
    doc.schematic.workspace = { board: boardFromSchematic(doc.schematic), firmware: { source: "void main(void){}" }, vhdl: { source: "entity top is end;", top: "top", constraints: "" }, labview: { url: "http://localhost/vi", inputs: { test: 1 }, outputs: { result: "V1" } } };
    expect(parseCircuit(serializeCircuit({ schematic: doc.schematic, analyses: [], issues: [] })).schematic).toEqual(doc.schematic);
    doc.schematic.workspace.board!.width = NaN;
    expect(() => parseCircuit(serializeCircuit({ schematic: doc.schematic, analyses: [], issues: [] }))).toThrow("workspace");
  });
  it("can place catalogue parts and preserve their model without the catalogue", () => {
    const p = twoPads().schematic.components[0];
    const parts = readComponentDatabase(writeComponentDatabase([{ name: "My resistor", component: p, definitions: "* user model" }]));
    registerDatabase(parts);
    try {
      const doc = new Doc(); const placed = doc.addPart(databaseKind(parts[0]), 0, 0);
      expect(placed.pins.every((p) => p.net === undefined)).toBe(true);
      expect(doc.schematic.definitions).toContain("user model");
      const text = serializeCircuit({ schematic: doc.schematic, analyses: [], issues: [] });
      registerDatabase([]);
      expect(buildNetlist(parseCircuit(text).schematic).text).toContain("1k");
    } finally { registerDatabase([]); }
  });
});
describe("LabVIEW JSON protocol", () => {
  it('passes native VI control names through the authenticated local bridge and validates output',async()=>{
    const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({signals:{drive:2}})));
    try{
      expect(await exchangeLabviewVI('http://localhost:47832','key',{path:'C:\\project\\step.vi',bits:32,outputs:['drive']},{time:1,signals:{'v(out)':3}})).toEqual({drive:2});
      expect(fetcher.mock.calls[0][0]).toBe('http://localhost:47832/labview/exchange');
      expect(fetcher.mock.calls[0][1]!.headers).toEqual({'Content-Type':'application/json',Authorization:'Bearer key'});
      expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).frame.time).toBe(1);
      await expect(exchangeLabviewVI('https://example.com','key',{path:'x.vi',bits:32,outputs:[]},{time:0,signals:{}})).rejects.toThrow('localhost');
      fetcher.mockResolvedValue(new Response('{"error":"not installed"}',{status:400}));
      await expect(exchangeLabviewVI('http://localhost:47832','key',{path:'x.vi',bits:32,outputs:[]},{time:0,signals:{}})).rejects.toThrow('not installed');
    }finally{fetcher.mockRestore();}
  });
  it("sends simulation time and readings and validates returned signals", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ signals: { control: 2.5 } })));
    try {
      expect(await exchangeLabview("http://localhost/vi", { time: 1, signals: { measured: 3 } })).toEqual({ control: 2.5 });
      expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ time: 1, signals: { measured: 3 } });
      fetcher.mockResolvedValue(new Response('{"signals":{"control":"bad"}}'));
      await expect(exchangeLabview("http://localhost/vi", { time: 0, signals: {} })).rejects.toThrow("finite_number");
    } finally { fetcher.mockRestore(); }
  });
});
describe("machine models", () => {
  it("fills a tank at the commanded rate and never empties below zero", () => {
    const doc = new Doc(); doc.addPart("holding-tank", 0, 0);
    const model = buildNetlist(doc.schematic).text.split(".subckt")[1].split(".end")[0];
    const deck = `* tank\nVfill fill 0 2\nVdrain drain 0 PWL(0 0 1 0 1.01 4)\nX1 fill drain level full 0 MS_TANK capacity=10 rate=1\n.subckt${model}.ends MS_TANK\n.end`;
    expect(changesOverTime(deck)).toBe(true);
    const result = simulate(deck, { type: "tran", tstep: 0.01, tstop: 3, tmax: 0.01 });
    expect(at(result, "v(level)", 0.5)).toBeCloseTo(1, 1);
    expect(at(result, "v(level)", 3)).toBeCloseTo(0, 1);
    expect(result.warnings.filter((s) => /unsupported|ignored/i.test(s))).toEqual([]);
  });
  it("moves and wraps a conveyor, and stops on disable", () => {
    const doc = new Doc(); doc.addPart("conveyor", 0, 0);
    const model = buildNetlist(doc.schematic).text.split(".subckt")[1].split(".end")[0];
    const deck = `* belt\nVspeed speed 0 2\nVenable enable 0 PWL(0 5 1.5 5 1.501 0)\nX1 speed enable position sensor 0 MS_BELT length=2 gain=1 sensor=1\n.subckt${model}.ends MS_BELT\n.end`;
    const result = simulate(deck, { type: "tran", tstep: 0.005, tstop: 2, tmax: 0.005 });
    expect(at(result, "v(position)", 0.25)).toBeCloseTo(0.5, 1);
    expect(at(result, "v(position)", 1.25)).toBeCloseTo(0.5, 1);
    expect(at(result, "v(position)", 2)).toBeCloseTo(1, 1);
    expect(at(result, "v(sensor)", 0.5)).toBeCloseTo(5);
  });
});
