import { describe, expect, it } from "vitest";
import { decodeContainer, importMs14 } from "../../src/importer";
import { implodeDecode } from "../../src/importer/implode";
import { evaluate, parseSpiceNumber } from "../../src/importer/values";
import { expandTemplate, rewriteMergeNodes, stripInteractive } from "../../src/importer/template";
import { mapAnalyses, parseSimState } from "../../src/importer/simstate";
import { bytesToText, parseXml, textValue } from "../../src/importer/xml";
import { ascii, buildContainer, buildImplode, findLeaks } from "./helpers";

const decodeOne = (stream: Uint8Array, capacity = 4096) => {
  const out = new Uint8Array(capacity);
  const end = implodeDecode(stream, 0, stream.length, out, 0, capacity);
  return bytesToText(out.subarray(0, end));
};

describe("implode decoder", () => {
  it("decodes uncoded literals", () => {
    expect(decodeOne(buildImplode(ascii("hello"), false))).toBe("hello");
  });

  it("decodes coded literals", () => {
    expect(decodeOne(buildImplode(ascii("Hello, World!"), true))).toBe("Hello, World!");
  });

  it("decodes back references, including overlapping ones and short distances", () => {
    const tokens = [...ascii("abc"), { length: 6, distance: 3 }, { length: 2, distance: 1 }, ...ascii("z")];
    expect(decodeOne(buildImplode(tokens, true))).toBe("abcabcabcccz");
  });

  it.each([4, 5, 6])("honours dictionary size %i", (dictBits) => {
    const text = ascii("0123456789".repeat(30));
    const tokens = [...text, { length: 20, distance: 260 }];
    expect(decodeOne(buildImplode(tokens, false, dictBits))).toBe("0123456789".repeat(30) + "01234567890123456789".slice(0, 20));
  });

  it("rejects a bad header", () => {
    expect(() => decodeOne(new Uint8Array([2, 4, 0, 0]))).toThrow(/bad implode header/);
    expect(() => decodeOne(new Uint8Array([1, 9, 0, 0]))).toThrow(/bad implode header/);
  });

  it("rejects a stream with no end marker rather than hanging", () => {
    expect(() => decodeOne(buildImplode(ascii("abc"), true, 4, false))).toThrow(/truncated/);
  });

  it("rejects a reference before the start of the output", () => {
    expect(() => decodeOne(buildImplode([...ascii("a"), { length: 4, distance: 9 }], true))).toThrow(/too far back/);
  });

  it("rejects output beyond the declared capacity", () => {
    expect(() => decodeOne(buildImplode(ascii("abcdef"), true), 3)).toThrow(/larger than its declared size/);
  });
});

describe("container", () => {
  const body = ascii("<a/>");
  const good = () => buildContainer([{ size: body.length, data: buildImplode(body, true) }]);

  it("reads one chunk", () => {
    expect(bytesToText(decodeContainer(good()))).toBe("<a/>");
  });

  it("joins several chunks, each with its own dictionary", () => {
    const first = ascii("<root>");
    const second = ascii("</root>");
    const file = buildContainer([
      { size: first.length, data: buildImplode(first, true) },
      { size: second.length, data: buildImplode(second, false) },
    ]);
    expect(bytesToText(decodeContainer(file))).toBe("<root></root>");
  });

  it("rejects bad magic", () => {
    expect(() => decodeContainer(new Uint8Array(ascii("PK this is not a circuit file at all, not even close")))).toThrow(/Not a Multisim/);
    expect(() => decodeContainer(new Uint8Array(0))).toThrow(/Not a Multisim/);
  });

  it("rejects truncation at every length without hanging", () => {
    const file = good();
    for (let n = 36; n < file.length; n++) {
      expect(() => decodeContainer(file.subarray(0, n))).toThrow(/Corrupt circuit file/);
    }
  });

  it("rejects a declared size beyond what the file allows", () => {
    const file = good();
    new DataView(file.buffer).setUint32(36, 0xfffffff0, true);
    expect(() => decodeContainer(file)).toThrow(/larger than the file allows/);
    const high = good();
    new DataView(high.buffer).setUint32(40, 1, true);
    expect(() => decodeContainer(high)).toThrow(/larger than the file allows/);
  });

  it("rejects a chunk claiming more than the declared total or the file holds", () => {
    const big = good();
    new DataView(big.buffer).setUint32(44, 99, true);
    expect(() => decodeContainer(big)).toThrow(/declared size/);
    const long = good();
    new DataView(long.buffer).setUint32(48, 0x7fffffff, true);
    expect(() => decodeContainer(long)).toThrow(/truncated chunk/);
  });

  it("rejects a chunk shorter than its header says", () => {
    const stream = buildImplode(body, true);
    const file = buildContainer([{ size: body.length + 1, data: stream }]);
    expect(() => decodeContainer(file)).toThrow(/shorter than/);
  });

  it("rejects a total the chunks never reach", () => {
    const file = buildContainer([{ size: body.length, data: buildImplode(body, true) }], body.length + 5);
    expect(() => decodeContainer(file)).toThrow(/before the declared size/);
  });

  it("gives a clear error for malformed XML inside a valid container", () => {
    const xml = ascii("<MSMElectronicsWorkbench><Project>");
    const file = buildContainer([{ size: xml.length, data: buildImplode(xml, true) }]);
    expect(() => importMs14(file)).toThrow(/XML ends inside/);
  });
});

describe("xml helpers", () => {
  it("drops NUL bytes and keeps newlines in attributes", () => {
    const text = bytesToText(new Uint8Array([60, 97, 0, 32, 98, 61, 34, 49, 10, 50, 34, 47, 62]));
    expect(parseXml(text).attrs.b).toBe("1\n2");
  });

  it("decodes string prefixes", () => {
    expect(textValue("&amp;ASCR1")).toBe("R1");
    expect(textValue("&amp;ASCa &amp; b")).toBe("a & b");
    expect(textValue("&amp;UNI1k_uc103a9")).toBe("1kΩ");
    expect(textValue("plain")).toBe("plain");
    expect(textValue(undefined)).toBe("");
  });

  it("rejects mismatched tags", () => {
    expect(() => parseXml("<a><b></a></b>")).toThrow(/mismatched/);
  });
});

describe("values", () => {
  it("reads SPICE numbers", () => {
    expect(parseSpiceNumber("1k")).toBe(1000);
    expect(parseSpiceNumber("4.7n")).toBeCloseTo(4.7e-9);
    expect(parseSpiceNumber("10Meg")).toBe(1e7);
    expect(parseSpiceNumber("1e+007")).toBe(1e7);
    expect(parseSpiceNumber("Vout")).toBeNull();
  });

  it("evaluates small expressions", () => {
    expect(evaluate("50*0.01/1k")).toBeCloseTo(5e-4);
    expect(evaluate("(1+2)*3")).toBe(9);
    expect(evaluate("a+1")).toBeNull();
    expect(evaluate("1/0")).toBeNull();
  });
});

describe("template expansion", () => {
  const expand = (template: string, parameters: string[] = [], pinNames = ["1", "2"], strings: string[] = [], modelName?: string) =>
    expandTemplate({ template, parameters, strings, pinNames, modelName });

  it("expands a resistor with its conditional model parameters", () => {
    const parameters = ["0", "1k", "0", "0", "1", "50", "0", "0", "1", "2m", "0", "27"];
    const t = "r%p %t1 %t2 #1 vres%p %v4?TEMP=#5%v:%v;\n .model vres%p r(%v6?TC1=#7%v:%v; %v8?TC2=#9%v:%v; %v10?TNOM=#11%v:%v;)\n";
    const r = expand(t, parameters);
    expect(r.spice).toBe("r{ref} {pin:1} {pin:2} {param:p1} vres{ref} TEMP={param:p5}\n .model vres{ref} r( TC2={param:p9} )");
    expect(r.params).toEqual({ p1: "1k", p5: "50", p9: "2m" });
  });

  it("leaves out model options that only state the default", () => {
    const t = "r%p %t1 %t2 #1 vres%p %v4?TEMP=#5%v:%v;\n.model vres%p r(%v6?TC1=#7%v:%v; %v8?TC2=#9%v:%v; %v10?TNOM=#11%v:%v;)\n";
    const defaults = expand(t, ["0", "1k", "0", "0", "1", "27", "1", "0", "1", "0", "1", "27"]);
    expect(defaults.spice).toBe("r{ref} {pin:1} {pin:2} {param:p1}");
    const set = expand(t, ["0", "1k", "0", "0", "1", "85", "1", "1m", "1", "0", "1", "27"]);
    expect(set.spice).toContain("TEMP={param:p5}");
    expect(set.spice).toContain("TC1={param:p7}");
    expect(set.spice).not.toContain("TC2");
    expect(set.spice).not.toContain("TNOM");
  });

  it("computes angle-bracket and brace expressions from parameters", () => {
    const r = expand("v%p %t1 %t2\n+ pulse( 0 #5 0 #7 #9\n+ <#3*0.01/#1>\n+ <1/#1>) {#7+#9}", ["0", "1k", "0", "50", "0", "5", "0", "1n", "0", "1n"]);
    expect(r.spice).toContain("+ 0.0005");
    expect(r.spice).toContain("+ 0.001)");
    expect(r.spice).toContain("2e-9");
    expect(r.spice).toContain("{param:p5}");
  });

  it("wraps non-numeric parameters in braces", () => {
    const r = expand("l%p %t1 %t2 #1", ["0", "Lload"]);
    expect(r.params.p1).toBe("{Lload}");
  });

  it("resolves pin names with symbols, using the longest match and digital branches", () => {
    const pins = ["A", "1A", "1", "~Q", "MAX/MIN", "^U^/D"];
    const r = expand("a%p [%tA?%t:d%t;A +\n %t~Q?%t:d%t;~Q] %t^U^/D?%t:r%t;^U^/D %tMAX/MIN %t1A %t1 %m", [], pins, [], "M1");
    expect(r.spice).toBe("a{ref} [{pin:A} +\n {pin:~Q}] {pin:^U^/D} {pin:MAX/MIN} {pin:1A} {pin:1} M1");
    expect(r.unknownPins).toEqual([]);
  });

  it("reports a pin the part does not have", () => {
    const r = expand("r%p %t1 %t9 1k");
    expect(r.unknownPins).toEqual(["9"]);
    expect(r.spice).toContain("{pin:9}");
  });

  it("expands lists, strings and percent escapes", () => {
    const parameters = ["1", "0", "1", "5", "1", "500m", "1", "1n", "1", "1n", "4", "0", "1", "5", "1e+007"];
    const r = expand("a%p %%vd( %t2 %t1 ) sq%p\n.MODEL sq%p square(\n+ cntl_array = [%f11:10:2]\n+ freq_array = [%f12:10:2]\n+ %v0?out_low = #1%v:%v;)", parameters);
    expect(r.spice).toContain("%vd( {pin:2} {pin:1} )");
    expect(r.spice).toContain("cntl_array = [0 5]");
    expect(r.spice).toContain("freq_array = [1 1e+007]");
    expect(findLeaks(r.spice)).toEqual([]);
    const s = expand("x%p %t1 T%p\n.subckt T%p a\n%S0\n.ends", [], ["1"], ["R1 a 0 1k\r\nC1 a 0 1u\r\n"]);
    expect(s.spice).toBe("x{ref} {pin:1} T{ref}\n.subckt T{ref} a\nR1 a 0 1k\nC1 a 0 1u\n.ends");
  });

  it("drops interactive blocks and keeps what follows", () => {
    const t = "* !!!BEGIN-INTERACT\n* : script #1 %t1\n* !!!END-INTERACT\nr%p %t1 %t2 #1";
    expect(stripInteractive(t).text).toBe("r%p %t1 %t2 #1");
    const r = expand(t, ["0", "2k"]);
    expect(r.spice).toBe("r{ref} {pin:1} {pin:2} {param:p1}");
    expect(expand("* !!!BEGIN-INTERACT\nr1").problems).toHaveLength(1);
  });

  it("notes a stored initial condition that is switched off", () => {
    expect(expand("c%p %t1 %t2 #1 %v4?IC=#5%v:%v;", ["0", "1u", "0", "0", "0", "5"]).ignoredInitialConditions).toEqual(["5"]);
    expect(expand("c%p %t1 %t2 #1 %v4?IC=#5%v:%v;", ["0", "1u", "0", "0", "1", "5"]).spice).toContain("IC={param:p5}");
  });

  it("rewrites .mergenodes", () => {
    expect(rewriteMergeNodes(".subckt a 1 2\n.mergenodes 1 2\n.ends")).toBe(".subckt a 1 2\nRmerge_1 1 2 1u\n.ends");
  });
});

describe("analysis settings", () => {
  const state = "SIMULATION_INFO:list{ANALYSES:list{ANALYSIS_LIST:list{}\nOP:list{NODES:list{}\n}\n" +
    "AC:list{ANALYSIS:list{VARIATION:string{oct}\nNPOINTS_PER_VARIATION:long{20}\nFSTART:double{1}\nFSTOP:double{1e+006}\n}\n}\n" +
    "TRAN:list{ANALYSIS:list{TSTEP:string{calculate}\nTSTOP:double{0.01}\nTSTART:double{0}\nTMAX:double{1e-005}\nIC:string{uic}\n}\n}\n" +
    "DC_SWEEP:list{ANALYSIS:list{Source1:string{vv1}\nStart1:double{0}\nStop1:double{5}\nIncrement1:double{0.5}\nUseSource2:long{0}\n}\n}\n}\n}";

  it("maps settings in file order", () => {
    const issues: never[] = [];
    expect(mapAnalyses(state, "interactive", issues)).toEqual([
      { type: "op" },
      { type: "ac", sweep: "oct", points: 20, fstart: 1, fstop: 1e6 },
      { type: "tran", tstep: 1e-5, tstop: 0.01, tmax: 1e-5, uic: true },
      { type: "dc", source: "vv1", start: 0, stop: 5, step: 0.5 },
    ]);
    expect(issues).toEqual([]);
  });

  it("finds analyses left at the top level by an early close", () => {
    const early = "SIMULATION_INFO:list{ANALYSES:list{OP:list{}\n}\n}\nDC_SWEEP:list{ANALYSIS:list{Source1:string{vv1}\nStart1:double{0}\nStop1:double{1}\nIncrement1:double{0.5}\n}\n}\n}\nRUN:list{}";
    expect(mapAnalyses(early, "dcSweep", [], (name) => `${name}x`)).toEqual([
      { type: "op" },
      { type: "dc", source: "vv1x", start: 0, stop: 1, step: 0.5 },
    ]);
  });

  it("tolerates truncated and hostile text", () => {
    expect(() => parseSimState("A:list{B:list{C:long{1")).not.toThrow();
    expect(() => parseSimState("x".repeat(100000))).not.toThrow();
    expect(() => parseSimState("A:list{".repeat(100000))).not.toThrow();
    const issues: { message: string }[] = [];
    expect(mapAnalyses("garbage", "fourier", issues as never[])).toEqual([]);
    expect(issues.length).toBe(1);
  });
});
