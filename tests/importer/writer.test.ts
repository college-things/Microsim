import { describe, expect, it } from "vitest";
import { buildExample, EXAMPLES } from "../../src/core/examples";
import { decodeContainer, importMs14 } from "../../src/importer";
import { encodeContainer, ms14Xml, serializeMs14 } from "../../src/importer/writer";
import { buildNetlist } from "../../src/core/netlist";
import { simulate } from "../../src/engine";
import { bytesToText, parseXml, path,textValue } from "../../src/importer/xml";
import { decodeEditorExtension, encodeEditorExtension } from "../../src/importer/extension";
describe("ms14 writer", () => {
  it("writes DCL chunks, including multiple chunks and all byte values", () => {
    const data = Uint8Array.from({ length: 950000 }, (_, i) => i % 256);
    expect(decodeContainer(encodeContainer(data))).toEqual(data);
  });
  it("round-trips the complete document including engineering data and Unicode", () => {
    const schematic = buildExample(EXAMPLES[0]); schematic.name = 'Резистор Ω 🙂 " & _uc1';
    schematic.workspace = { firmware: { source: "int main(){}" } };
    const file = { schematic, analyses: [{ type: "op" as const }], issues: [{ severity: "info" as const, message: "User note" }] };
    const bytes = serializeMs14(file);
    expect(bytesToText(decodeContainer(bytes))).toContain('<MSMElectronicsWorkbench Schema="67">');
    const result = importMs14(bytes);
    expect(result.schematic).toEqual(schematic); expect(result.analyses).toEqual(file.analyses); expect(result.issues).toEqual(file.issues);
  });
  it("writes an ordinary circuit graph that works without the private extension", () => {
    const schematic = buildExample(EXAMPLES[0]);
    const xml = ms14Xml({ schematic, analyses: [], issues: [] }).replace(/<!--MicrosimDocument[\s\S]*?-->/g, "");
    const imported = importMs14(new TextEncoder().encode(xml));
    expect(imported.schematic.components.filter((c) => c.pins.length).length).toBe(schematic.components.length);
    const netlist = buildNetlist(imported.schematic);
    expect(netlist.errors).toEqual([]);
    const result = simulate(netlist.text, { type: "op" });
    expect(result.warnings.filter((s) => /unsupported|ignored/i.test(s))).toEqual([]);
    expect(result.stats.unknowns).toBeGreaterThan(0);
  });
  it("puts wire endpoints in the native reference table and marks ground connectors", () => {
    const raw = ms14Xml({schematic:buildExample(EXAMPLES[0]),analyses:[],issues:[]});
    const root=parseXml(raw);
    const composite=path(root,"Project","UniqueSheets","SheetInfos","SheetContainer","Sheet","Variable","DesignSheet","Sheet","XMLSubSheet","CIITHierDoc","Diagram","CIITDiagram","Components","CODComposite")!;
    const refs=path(composite,"ReferencedComponents")!;
    expect(refs.children.length).toBeGreaterThan(0);
    expect(refs.children.every(n=>n.attrs.Class==='CODPinComp'&&n.children[0].attrs.Mobility==='1')).toBe(true);
    expect(raw).toContain('NI_EWB_NET_GLOBAL_GROUND');
    const ids=new Set(refs.children.map(n=>n.attrs.ID));
    for(const n of path(composite,"Objects")!.children.filter(n=>n.attrs.Class==='CIITLinkComp')){
      expect(ids.has(n.children[0].attrs.Connect1)).toBe(true);
      expect(ids.has(n.children[0].attrs.Connect2)).toBe(true);
    }
  });
  it('writes native drawing defaults, active components, numeric ports and source parameter slots',()=>{
    const raw=ms14Xml({schematic:buildExample(EXAMPLES[0]),analyses:[],issues:[]});
    const root=parseXml(raw),elements=path(root,'Project','UniqueSheets','SheetInfos','SheetContainer','Sheet','Variable','DesignSheet','Sheet','XMLSubSheet','CIITHierDoc','Diagram','CIITDiagram','Elements')!;
    const parts=elements.children.filter(n=>n.attrs.Class==='CiComponent').map(n=>n.children[0]);
    const source=parts.find(n=>textValue(n.attrs.LocalName)==='V1')!;
    expect(new Set(parts.map(n=>n.attrs.InstanceID)).size).toBe(parts.length);
    const attrs=path(source,'Attributes')!.children;
    expect(attrs[8].children[0].attrs.FaultType).toBe('3');
    for(const i of [22,23])expect(Number(attrs[i].children[0].attrs.Double)).toBe(1);
    expect(textValue(path(attrs[2].children[0],'parameters')!.children[5].attrs.Value)).toBe('1k');
    expect(textValue(attrs[1].children[0].attrs.String)).toContain('%t1 %t2');
    expect(raw).not.toMatch(/(?:String|Value)="&amp;ASC"/);
    expect(raw).toContain('Transformer-M00="1"');
    expect(raw).toMatch(/<CODEllipseComp[^>]*CenterX="[^\"]+"[^>]*Radius1="[1-9]/);
    expect(raw).not.toMatch(/<CODEllipseComp[^>]*pt0X=/);
  });
  it('retains model definitions and operating point behavior without the editor extension',()=>{
    const schematic=buildExample(EXAMPLES[1]);
    const restored=importMs14(new TextEncoder().encode(ms14Xml({schematic,analyses:[],issues:[]}).replace(/<!--MicrosimDocument[\s\S]*?-->/g,''))).schematic;
    const before=buildNetlist(schematic),after=buildNetlist(restored);
    const a=simulate(before.text,{type:'op'}),b=simulate(after.text,{type:'op'});
    expect(b.warnings.filter(s=>/unsupported|ignored/i.test(s))).toEqual([]);
    const volts=(result:typeof a,net:string)=>net==='0'?0:result.vectors.find(v=>v.name.toLowerCase()===`v(${net})`.toLowerCase())?.re[0];
    for(const c of schematic.components.filter(c=>c.kind!=='ground'&&!c.instrument)){
      const imported=restored.components.find(p=>p.refDes===c.refDes)!;expect(imported).toBeDefined();
      c.pins.forEach((p,i)=>expect(volts(b,after.pinNets.get(imported.id)!.get(imported.pins[i].name)!)).toBeCloseTo(volts(a,before.pinNets.get(c.id)!.get(p.name)!)!,5));
    }
  });
  it("preserves native records and patches a parameter without relying on editor metadata", () => {
    const schematic = buildExample(EXAMPLES[0]);
    const xml = ms14Xml({ schematic, analyses: [], issues: [] }).replace(/<!--MicrosimDocument[\s\S]*?-->/g, "");
    const file = importMs14(new TextEncoder().encode(xml), { retainSource: true });
    const resistor = file.schematic.components.find((c) => c.family === "resistor")!;
    resistor.params[resistor.valueKey!] = "2200"; resistor.displayValue = undefined;
    file.schematic.workspace = { firmware: { source: "user source" } };
    const bytes = serializeMs14(file);
    expect(importMs14(bytes).schematic).toEqual(file.schematic);
    const raw = bytesToText(decodeContainer(bytes)).replace(/<!--MicrosimDocument[\s\S]*?-->/g, "");
    const native = importMs14(new TextEncoder().encode(raw));
    const restored = native.schematic.components.find((c) => c.family === "resistor")!;
    expect(restored.params[restored.valueKey!]).toBe("2200");
    expect(raw).toContain('Class="CViewState"');
    file.schematic.wires.pop();
    expect(() => serializeMs14(file)).toThrow("structural or unsupported edits");
    expect(importMs14(serializeMs14(file,{flattenNative:true})).schematic).toEqual(file.schematic);
  });
  it("preserves Unicode in chunked comments and rejects missing chunks", () => {
    const text = "Ω🙂".repeat(50000);
    const extension = encodeEditorExtension(text);
    expect(decodeEditorExtension(extension)).toBe(text);
    expect(() => decodeEditorExtension(extension.replace(/<!--MicrosimDocument[^]*?-->/, ""))).toThrow("incomplete");
  });
});
