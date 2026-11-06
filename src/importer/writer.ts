import { flattenCircuit, hasHierarchy } from "../core/hierarchy";
// Original schema-67 writer. The extension retains editor-only data; the ordinary
// sheet contains flattened geometry, ports, nodes and expanded SPICE templates.
import type { CircuitFile } from "../core/file";
import { serializeCircuit } from "../core/file";
import { buildNetlist, componentTemplate, onSegment, pinWorld, symbolGraphics } from "../core/netlist";
import type { Graphic } from "../core/schematic";
import type {SchComponent} from '../core/schematic';
import { IMPLODE_TABLES } from "./implode";
import { child, kids, parseXml, path, textValue, type XmlNode } from "./xml";
import { parseCircuit } from "../core/file";
import { parseSpiceNumber } from "./values";
import { encodeEditorExtension } from "./extension";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\r/g, "&#13;").replace(/\n/g, "&#10;");
const str = (s: string) => s?xml((/[^\x20-\x7e]|_uc1/.test(s)?"&UNI":"&ASC") + s.replace(/[^\x20-\x7e]|_uc1/g, (c) => [...c].map((u) => `_uc1${u.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""))):'';
const drawingDefaults:Record<string,string>={instID:'0',Stretchable:'1',Moveable:'1',LabelSelectable:'1',Selectable:'1',LockedPenColor:'0',LockedBrushColor:'0',Layer:'511',Hidden:'0',PenColor:'0',FgColor:'0',BgColor:'16777215','Pen-Style':'0','Pen-Width':'1','Pen-Color':'0','Brush-Style':'1','Transformer-M00':'1','Transformer-M01':'0','Transformer-M10':'0','Transformer-M11':'1','Transformer-M20':'0','Transformer-M21':'0','Font-Height':'-11','Font-Weight':'400','Font-FaceName':'&amp;ASCArial'};
const item = (id: string, cls: string, attrs: string, body = "") => `<Item ID="${id}" Class="${cls}"><${cls} Class="${cls}" ${Object.entries(drawingDefaults).filter(([key])=>!attrs.includes(`${key}=`)).map(([key,value])=>`${key}="${value}"`).join(' ')} ${attrs}>${body}</${cls}></Item>`;
const layerDefinition=(schematic:boolean)=>`<LayerDefinition Class="CLayerDefinition"><LayerInfo Class="CLayerInfo" RGB="0" DrawMode="13" Name="${str(schematic?'Schematic':'Layer1')}" Number="0" State="3" Properties="32" Type="1" GroupNumber="${schematic?1376256:65536}" ForceLayerNum="512"><LayerInfoExtension><LayerInfoExtension Class="CLayerInfoExtension" Routability="1" TraceBias="3" LayerType="0"/></LayerInfoExtension><DllStack>${['UT_GenSettings',...(schematic?['UT_GenCadObj','UT_SCHCap']:[])].map(name=>`<DllString Name="${str(name)}"/>`).join('')}</DllStack></LayerInfo></LayerDefinition>`;
const sheetVariant=`<Extensions><Extension Class="CMultisimSheetComponentExtension"><Variant Class="CSheetVariantData" CurrentVariant="${str('Default1')}"><SheetVariantMap><VariantNames VariantName="${str('Default1')}"><VariantData Class="CVariantData" Comments=""/></VariantNames></SheetVariantMap><Reports Class="CReportVariantData" IncludeVariantByDefault="1"><SheetVariantMap/></Reports></Variant></Extension></Extensions>`;
const electrical = (net?: string) => `<ElectricalObject HiddenName="0"><ModifierInfo>${net === "0" ? `<Element NetModifier="${str("NI_EWB_NET_GLOBAL_GROUND")}"><Item Value="${str("0")}" Guid="{${crypto.randomUUID().toUpperCase()}}"/></Element>` : ""}</ModifierInfo></ElectricalObject>`;
function nativeIdentity(c:SchComponent,template:string):string{
 const ground=c.kind==='ground',source=['vsin','vdc','vcc','vpulse','clock','function-generator'].includes(c.kind);
 const family=ground||source?'POWER_SOURCES':c.kind.toUpperCase();
 const name=ground?'GROUND':c.kind==='vsin'?'AC_POWER':source?'DC_POWER':c.kind.toUpperCase();
 const identity=Array<string>(36).fill('');Object.assign(identity,{0:family,1:name,2:family,3:ground?'EMPTY':name,4:'1',8:'Generic',14:source||ground?'Sources':'Basic',15:family,16:'Generic',20:name,29:'1',35:'1'});
 const database=Array<string>(21).fill('');Object.assign(database,{0:ground?'12':source?'2':'29',1:'Product',2:family,4:ground?'0':`${c.refDes[0]??'X'}%d`,5:template,9:'Generic',13:'DMN',18:'18'});
 const collection=(values:string[])=>`<Item><CiaCollString Class="CiaCollString"><strings>${values.map(value=>`<Item Value="${str(value)}"/>`).join('')}</strings></CiaCollString></Item>`;
 const attributes=Array<string>(53).fill('<Item/>');
 const number=(value:number)=>`<Item><CiaDOUBLE Class="CiaDOUBLE" Double="${value}"/></Item>`;
 attributes[4]=collection(identity);attributes[5]=collection(database);
 attributes[8]='<Item><CiaFault Class="CiaFault" FaultType="3" LeakResistanceValue="100" LeakResistanceScale="&amp;ASCOhm"><FaultPorts/></CiaFault></Item>';
 attributes[17]=number(ground?102:source?108:200);attributes[20]=number(-1);
 for(const index of [22,23,36,37])attributes[index]=number(1);
 attributes[44]=`<Item><CiaCString Class="CiaCString" String="${str(ground||source?'0':'1')}"/></Item>`;
 attributes[46]=number(0);attributes[47]=collection(['A']);
 return attributes.slice(3).join('');
}
function referenceManager(components:SchComponent[]):string{
 return `<RefDesMgrs><RefDesMgr Class="CIITHierRefDesManager"><ComponentPins/><RefDesInfoContainers><RefDesInfoContainer Class="CIITHierRefDesInfoContainer" CIR="${str('#1/Main:')}" UsePreOffset="0" Prefix="" Offset="0" UsePreOffsetParent="0" PrefixParent="" OffsetParent="0"><CIRToInfoMap>${components.map(c=>{
  const ref=c.kind==='ground'?'0':c.refDes,match=/^(.*?)(\d+)$/.exec(ref),prefix=match?.[1]??ref,number=match?.[2]??'1';
  const data=`!0!0!0${ref}!0!01!0Main!0`,length=data.replace(/!0/g,'\0').length+2;
  return `<CIRToInfoMapItem CIRKey="${str(ref)}"><RefDesInfo Class="CIITHierRefDesInfo" IRPrefix="${str(prefix)}" IRNumber="${number}" Locked="0" IRSection="" IRSectionID="0" SpiceTemplate=""><RefDesInfoData Class="CIITHierRefDes" RefDesBufSize="${Math.max(260,length)}" RefDesStrSize="${length}" RefDesCount="2" RefDes="${str(data)}" SectionBufSize="0" SectionStrSize="0" Section="${str('(null)')}" Prefix="${str(prefix)}" Number="${number}"><RefDesData/></RefDesInfoData><PinOrderCIR/><PinOrderIR/><PinNumbersCIR/><PinNumbersIR/><SharedPins/></RefDesInfo></CIRToInfoMapItem>`;
 }).join('')}</CIRToInfoMap></RefDesInfoContainer></RefDesInfoContainers><RefDesPrefixUsageMap/></RefDesMgr></RefDesMgrs>`;
}
function nativeParameters(c:SchComponent):{values:string[];indices:Map<string,number>}{
 const indices=new Map<string,number>();
 const sine:Record<string,number>={amp:1,offset:3,freq:5,phase:11,acmag:13};
 for(const [i,key]of Object.keys(c.params).entries())indices.set(key,c.kind==='vsin'&&sine[key]!==undefined?sine[key]:2*i+1);
 const size=Math.max(0,...indices.values())+1,values=Array<string>(size).fill('0');
 for(const [key,index]of indices){values[index-1]='-1';values[index]=c.params[key];}
 return {values,indices};
}
function modelBlocks(text:string):{name:string;text:string}[]{
 const lines=text.split('\n'),starts:{name:string;line:number}[]=[];let depth=0;
 for(const [i,line]of lines.entries()){
  const match=/^\s*\.(subckt|model)\s+(\S+)/i.exec(line);
  if(match&&depth===0)starts.push({name:match[2],line:i});
  if(/^\s*\.subckt\b/i.test(line))depth++;
  if(/^\s*\.ends\b/i.test(line))depth=Math.max(0,depth-1);
 }
 return starts.length?starts.map((s,i)=>({name:s.name,text:lines.slice(i?s.line:0,starts[i+1]?.line).join('\n')})):[{name:'MicrosimDefinitions',text}];
}

/** Literal-only DCL streams trade compression for a small, auditable encoder. */
export function encodeContainer(data: Uint8Array): Uint8Array {
  const magic = "MSMCompressedElectronicsWorkbenchXML";
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < data.length; start += 64000) {
    const block = data.subarray(start, start + 64000);
    const bytes: number[] = [0, 4];
    let buffer = 0, count = 0;
    const bits = (value: number, n: number) => {
      for (let i = 0; i < n; i++) {
        buffer |= ((value >>> i) & 1) << count++;
        if (count === 8) { bytes.push(buffer); buffer = count = 0; }
      }
    };
    for (const b of block) { bits(0, 1); bits(b, 8); }
    // End marker: length symbol 15 + extra value 255 = 519.
    bits(1, 1);
    const table = IMPLODE_TABLES.length;
    let first = 0, index = 0;
    outer: for (let len = 1; len < table.count.length; len++) {
      for (let i = 0; i < table.count[len]; i++) if (table.symbol[index + i] === 15) {
        for (let bit = len - 1; bit >= 0; bit--) bits(((first + i) >>> bit & 1) ^ 1, 1);
        break outer;
      }
      index += table.count[len]; first = (first + table.count[len]) << 1;
    }
    bits(255, 8);
    if (count) bytes.push(buffer);
    const chunk = new Uint8Array(8 + bytes.length);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, block.length, true); view.setUint32(4, bytes.length, true);
    chunk.set(bytes, 8); chunks.push(chunk);
  }
  const out = new Uint8Array(magic.length + 8 + chunks.reduce((n, c) => n + c.length, 0));
  out.set(new TextEncoder().encode(magic));
  new DataView(out.buffer).setUint32(magic.length, data.length, true);
  let at = magic.length + 8;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

export function ms14Xml(file: CircuitFile): string {
  const s = structuredClone(flattenCircuit(file.schematic, true));
  // Port and instance terminals are already resolved into the leaf pins' named nets.
  // Their editable drawings remain in the complete editor extension below.
  s.components = s.components.filter((c) => !c.kind.startsWith("hierarchy-"));
  // Native schematic views open at the positive origin. Preserve editor coordinates
  // in the extension while moving the exported sheet into its visible work area.
  const positions=[...s.components.flatMap(c=>c.pins.map(p=>pinWorld(c,p))),...s.wires.flatMap(w=>w.points),...s.labels,...s.texts];
  const dx=Math.max(0,50-positions.reduce((n,p)=>Math.min(n,p.x),50)),dy=Math.max(0,50-positions.reduce((n,p)=>Math.min(n,p.y),50));
  for(const c of s.components){c.x+=dx;c.y+=dy;}for(const p of [...s.wires.flatMap(w=>w.points),...s.labels,...s.texts]){p.x+=dx;p.y+=dy;}
  const wireMarkers = s.wires.filter((w) => w.points.length).map((w) => ({ id: `ms14-wire-${w.id}`, refDes: "", kind: "imported", x: w.points[0].x, y: w.points[0].y, rotation: 0 as const, mirrored: false, params: {}, pins: [{ name: "net", x: 0, y: 0 }], spice: "" }));
  const netlist = buildNetlist({ ...s, components: [...s.components, ...wireMarkers] });
  if (netlist.errors.length) throw new Error(netlist.errors.join(" "));
  let sequence = 1;
  const id = () => String(sequence++);
  const nodes = new Map<string, string>();
  const nodePorts = new Map<string, string[]>();
  const componentIds: string[] = [];
  const modelIds:string[]=[];
  const elements: string[] = [], objects: string[] = [], referenced: string[] = [];
  const connectors: { id: string; x: number; y: number; linked: string[] }[] = [];
  const node = (net: string) => {
    if (!nodes.has(net)) {
      const key = id(); nodes.set(net, key);
    }
    return nodes.get(net)!;
  };
  const draw = (g: Graphic) => {
    if (g.kind === "line" || g.kind === "polygon") return item(id(), g.kind === "line" ? "CODMultiLineComp" : "CODPolygonComp", `Brush-Style="${g.kind === "polygon" && g.filled ? 0 : 1}"`, `<Points>${g.points.map((p) => `<Item X="${p.x}" Y="${p.y}"/>`).join("")}</Points>`);
    if (g.kind === "text") return item(id(), "CODTextComp", `Output="${str(g.text)}" Transformer-M20="${g.x}" Transformer-M21="${g.y - g.size * 0.8}" Font-Height="${-g.size}"`);
    if (g.kind === "rect") return item(id(), "CODRectComp", `pt0X="${g.x}" pt0Y="${g.y}" pt1X="${g.x + g.w}" pt1Y="${g.y + g.h}" Brush-Style="${g.filled ? 0 : 1}"`);
    return item(id(), "CODEllipseComp", `CenterX="${g.cx}" CenterY="${g.cy}" Radius1="${g.rx}" Radius2="${g.ry}" Brush-Style="${g.filled ? 0 : 1}"`);
  };
  for (const c of s.components) {
    const cid = id(), sid = id();
    componentIds.push(cid);
    const ports: string[] = [], symbols: string[] = [];
    for (const p of c.pins) {
      const nativeName=String(c.pins.indexOf(p)+1);
      const pid = id(), net = netlist.pinNets.get(c.id)?.get(p.name) ?? `nc_${cid}_${pid}`;
      nodePorts.set(net, [...(nodePorts.get(net) ?? []), pid]);
      ports.push(`<Item CiID="${pid}"/>`);
      elements.push(`<Item CiID="${pid}" Class="CiPort"><CiPort Class="CiPort" LocalName="${str(nativeName)}" Component="${cid}"><Attributes>${'<Item/>'.repeat(7)}<Item><CiaNodeType Class="CiaNodeType" DWORD="256"/></Item></Attributes><Nodes><Item CiID="${node(net)}"/></Nodes></CiPort></Item>`);
      const at = pinWorld(c, p);
      const connector = { id: id(), x: at.x, y: at.y, linked: [] as string[] }; connectors.push(connector);
      symbols.push(item(id(), "CIITPinSymbolComp", `PinName="${str(nativeName)}" PinNumber="${str(nativeName)}" PortID="${pid}" ShowName="1" ShowNumber="0"`, `<Objects>${item(connector.id, "CIITPinConnectorComp", `ptCenterX="${at.x - c.x}" ptCenterY="${at.y - c.y}"`, `${electrical(net)}<ConnectList>__CONNECT_${connector.id}__</ConnectList>`)}</Objects>`));
    }
    const parameters=nativeParameters(c),params=parameters.values;
    const nativeTemplate = componentTemplate(c).replace(/^\{ref\}/, `${(c.refDes[0] ?? "X").toLowerCase()}{ref}`);
    const template = nativeTemplate.replace(/%/g, "%%").replace(/\{ref\}/g, "%p").replace(/\{pin:([^}]+)\}/g, (_, p: string) => `%t${c.pins.findIndex(pin=>pin.name===p)+1}`).replace(/\{param:([^}]+)\}/g, (_, p: string) => `#${parameters.indices.get(p)??0}`);
    elements.push(`<Item CiID="${cid}" Class="CiComponent"><CiComponent Class="CiComponent" InstanceID="{${crypto.randomUUID().toUpperCase()}}" Circuit="1000000" LocalName="${str(c.kind==="ground"?"0":c.refDes || `P${cid}`)}" SymCompID="${sid}"><Attributes><Item/><Item><CiaSpiceTmpltExprt Class="CiaSpiceTmpltExprt" String="${str(template)}"/></Item><Item><CiaParamList Class="CiaParamList"><doubles>${params.map(v => `<Item Value="${parseSpiceNumber(v) ?? 0}"/>`).join("")}</doubles><strings>${Object.keys(c.params).map(()=>`<Item Value="${str('Param')}"/>`).join('')}</strings><parameters>${params.map(v => `<Item Value="${str(v)}"/>`).join("")}</parameters><paramindicators>${params.map(() => '<Item Value="1"/>').join("")}</paramindicators></CiaParamList></Item>${nativeIdentity(c,template)}</Attributes><Ports>${ports.join("")}</Ports></CiComponent></Item>`);
    // Transform graphics into world orientation, then store relative to the symbol.
    const oriented = symbolGraphics(c).map((g): Graphic => {
      const point = (p: { x: number; y: number }) => { const a = pinWorld(c, p); return { x: a.x - c.x, y: a.y - c.y }; };
      if (g.kind === "line" || g.kind === "polygon") return { ...g, points: g.points.map(point) };
      if (g.kind === "text") return { ...g, ...point(g) };
      if (g.kind === "ellipse") return { ...g, cx: point({ x: g.cx, y: g.cy }).x, cy: point({ x: g.cx, y: g.cy }).y, rx: c.rotation % 180 ? g.ry : g.rx, ry: c.rotation % 180 ? g.rx : g.ry };
      const a = point(g), b = point({ x: g.x + g.w, y: g.y + g.h });
      return { ...g, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
    });
    objects.push(item(sid, "CIITSymbolComp", `CiComponent="${cid}" Transformer-M00="1" Transformer-M01="0" Transformer-M10="0" Transformer-M11="1" Transformer-M20="${c.x}" Transformer-M21="${c.y}"`, `<Objects>${symbols.join("")}${oriented.map(draw).join("")}${item(id(), "CIITSymTextCompName", `Output="${str(c.refDes)}"`)}</Objects>`));
  }
  // Native models carry their definitions independently of an installed component database.
  const definitions = [...new Set([s.definitions, ...s.components.map((c) => netlistDefinitions(c.kind))])].filter(Boolean).join("\n");
  if (definitions) {
    for(const block of modelBlocks(definitions)){
      const mid=id();modelIds.push(mid);
      elements.push(`<Item CiID="${mid}" Class="CiModel"><CiModel Class="CiModel" LocalName="${str(block.name)}" Scope="1000000" ChangedByUser="1"><Attributes><Item/><Item><CiaCString Class="CiaCString" String="${str(block.text)}"/></Item><Item><CiaParamList Class="CiaParamList"><doubles/><strings/><parameters/><paramindicators/></CiaParamList></Item><Item><CiaModelDataRefCount Class="CiaModelDataRefCount" RefCnt="1"/></Item></Attributes></CiModel></Item>`);
    }
  }
  const landingPoints = [...connectors, ...s.wires.flatMap((w) => w.points.length ? [w.points[0], w.points[w.points.length - 1]] : [])];
  const ends: { id: string; x: number; y: number }[] = [];
  for (const w of s.wires) {
    const net = netlist.pinNets.get(`ms14-wire-${w.id}`)?.get("net");
    // Split at all electrical landings so native wire endpoint connections describe tees too.
    for (let i = 1; i < w.points.length; i++) {
      const a = w.points[i - 1], b = w.points[i];
      const points = [a, ...landingPoints.filter((p) => onSegment(p, a, b)), b].sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y)).filter((p, j, all) => !j || p.x !== all[j - 1].x || p.y !== all[j - 1].y);
      for (let j = 1; j < points.length; j++) {
        const start = { id: id(), x: points[j - 1].x, y: points[j - 1].y }, end = { id: id(), x: points[j].x, y: points[j].y };
        ends.push(start, end);
        objects.push(item(id(), "CIITLinkComp", `${net ? `Node="${node(net)}"` : ""} Connect1="${start.id}" Connect2="${end.id}"`, `<Points><Item X="${start.x}" Y="${start.y}"/><Item X="${end.x}" Y="${end.y}"/></Points><ElectricalObject HiddenName="0"><ModifierInfo/></ElectricalObject>`));
      }
    }
  }
  const atKey = (p: { x: number; y: number }) => `${p.x},${p.y}`;
  const groups = new Map<string, typeof ends>();
  for (const end of ends) groups.set(atKey(end), [...(groups.get(atKey(end)) ?? []), end]);
  for (const [key, group] of groups) {
    const pins = connectors.filter((p) => atKey(p) === key);
    const hub = group.length > 1 || group.length + pins.length > 2 ? id() : undefined;
    if (hub) {
      const at = group[0];
      objects.push(item(hub, "CODPinComp", `CenterX="${at.x}" CenterY="${at.y}" Mobility="0" Pen-Style="0"`, `<ElectricalObject HiddenName="0"><ModifierInfo/></ElectricalObject><ConnectList>${group.map((p) => `<Item ID="${p.id}" Class="CODPinComp"/>`).join("")}${pins.map((p) => `<Item ID="${p.id}" Class="CIITPinConnectorComp"/>`).join("")}</ConnectList>`));
    }
    for (const p of pins) p.linked.push(...(hub ? [hub] : group.map((end) => end.id)));
    for (const end of group) {
      const links = hub ? `<Item ID="${hub}" Class="CODPinComp"/>` : `${pins.map((p) => `<Item ID="${p.id}" Class="CIITPinConnectorComp"/>`).join("")}${group.filter((p) => p !== end).map((p) => `<Item ID="${p.id}" Class="CODPinComp"/>`).join("")}`;
      referenced.push(item(end.id, "CODPinComp", `CenterX="${end.x}" CenterY="${end.y}" Mobility="1" Pen-Style="5" Hidden="0"`, `<ElectricalObject HiddenName="0"><ModifierInfo/></ElectricalObject><ConnectList>${links}</ConnectList>`));
    }
  }
  for (let i = 0; i < objects.length; i++) objects[i] = objects[i].replace(/__CONNECT_(\d+)__/g, (_, key: string) => connectors.find((p) => p.id === key)!.linked.map((link) => `<Item ID="${link}" Class="CODPinComp"/>`).join(""));
  for (const t of s.texts) objects.push(draw({ kind: "text", x: t.x, y: t.y, text: t.text, size: 10 }));
  const refs = (ids: Iterable<string>) => [...ids].map((key) => `<Item CiID="${key}"/>`).join("");
  for (const [net, key] of nodes) elements.push(`<Item CiID="${key}" Class="CiNode"><CiNode Class="CiNode" Circuit="1000000" LocalName="${str(net)}"><Attributes/><Ports>${refs(nodePorts.get(net) ?? [])}</Ports></CiNode></Item>`);
  elements.unshift(`<Item CiID="1000000" Class="CiCircuit"><CiCircuit Class="CiCircuit" LocalName=""><Attributes/><Models>${refs(modelIds)}</Models><Nodes>${refs(nodes.values())}</Nodes><Probes/><ProbeExts/><CompAddRefs/><Components>${refs(componentIds)}</Components></CiCircuit></Item>`);
  const guid = () => `{${crypto.randomUUID().toUpperCase()}}`;
  const projectExtensions=`<Extensions><Extension Class="CPrjTreeCtrlExtension"><SWsTreeItem Class="SWsTreeItem" Name="${str(s.name)}"><Children><SWsTreeItem Class="SWsTreeItem" Name="${str('Main')}"><Children/></SWsTreeItem></Children></SWsTreeItem></Extension><Extension Class="CODProjectExtension"><CDesignNetContainer Class="CDesignNetContainer" BusLineMode="1"><NetLabels/><CNetPropertyHandler Class="CNetPropertyHandler"><CDataElementMap Class="CDataElementMap"><MapData/></CDataElementMap></CNetPropertyHandler><CNetPropertyHandler Class="CNetPropertyHandler"><CDataElementMap Class="CDataElementMap"><MapData/></CDataElementMap></CNetPropertyHandler></CDesignNetContainer></Extension><Extension Class="CMultisimExtension">${referenceManager(s.components)}<CoSimulationSummary><Connections/></CoSimulationSummary></Extension></Extensions>`;
  const shapeObject = `<Object><Point Class="CDrawPoint" X="0" Y="0"/><Point Class="CDrawPoint" X="30000000" Y="0"/><Point Class="CDrawPoint" X="30000000" Y="30000000"/><Point Class="CDrawPoint" X="0" Y="30000000"/></Object>`;
  const sheetAttrs = `Layer="511" LineColor="2" FillColor="2" ObjectInfo="16842788" Rotation="0" MultiObjects="0" Mirrored="0" WorkAreaLeft="-148500000" WorkAreaBottom="-105000000" WorkAreaRight="148500000" WorkAreaTop="105000000" PageName="${str("1")}" SheetID="${guid()}"`;
  const projectSheet = `<DesignSheet Class="CDrwSubSheet" ObjectID="900001" ${sheetAttrs} Title="${str(s.name)}" DocType="${str("PROJECT")}">${shapeObject}<Group><Store Class="CDrawingStore"><DataTreeContainer Class="CTreeDataContainer"/></Store><RefPoint Class="CRefPoint" X="0" Y="0"/></Group><Sheet><Variable/>${layerDefinition(false)}<ColorDefinition Class="CColorDefinition"><ColorInfo Class="CColorInfo" ID="1" Type="1" RGB="16777215"/><ColorInfo Class="CColorInfo" ID="2" Type="-2147483647" RGB="0"/></ColorDefinition><UnitInfo Class="CUnitInfo" Name="${str("mil")}" Factor="0.00003937007874015748" DBFactor="1"/><PreSubSheet/><Store Class="CDrawingStore"><DataTreeContainer Class="CTreeDataContainer"><Group Class="CSheetComponent" ObjectID="900003" ${sheetAttrs.replace('ObjectInfo="16842788"', 'ObjectInfo="16842790"')} SheetName="${str("Main")}" GUID="${guid()}" Path="" PathAbs="">${shapeObject}<Group><Store Class="CDrawingStore"><DataTreeContainer Class="CTreeDataContainer"/></Store><RefPoint Class="CRefPoint" X="0" Y="0"/></Group>${sheetVariant}</Group></DataTreeContainer></Store><SubSheet/></Sheet></DesignSheet>`;
  return `<?xml version="1.0" encoding="ASCII"?><MSMElectronicsWorkbench Schema="67"><Project Class="CProject" ProgramVersion="14.0.0.0" Name="${str(s.name)}" ProjectID="${guid()}" AppName="${str("Multisim")}" AppVersion="${str("14.0")}"><UniqueSheets><SheetInfos><SheetContainer Class="CSheetContainer" ObjectID="900002"><Sheet><Variable><DesignSheet Class="CSCH_CAPSubSheet" ObjectID="900004" ${sheetAttrs} Title="${str("Main")}" DocType="${str("SCH_CAPDESIGN")}">${shapeObject}<Group><Store Class="CDrawingStore"><DataTreeContainer Class="CTreeDataContainer"/></Store><RefPoint Class="CRefPoint" X="0" Y="0"/></Group><Sheet><Variable/>${layerDefinition(true)}<ColorDefinition Class="CColorDefinition"><ColorInfo Class="CColorInfo" ID="1" Type="1" RGB="16777215"/><ColorInfo Class="CColorInfo" ID="2" Type="-2147483647" RGB="0"/></ColorDefinition><UnitInfo Class="CUnitInfo" Name="${str("mm")}" Factor="1e-6" DBFactor="1"/><PreSubSheet/><Store Class="CDrawingStore"><DataTreeContainer Class="CTreeDataContainer"/></Store><XMLSubSheet><CIITHierDoc Class="CIITHierDoc"><Diagram><CIITDiagram Class="CIITDiagram" MultisimInternalVersion="1000"><Components><CODComposite Class="CODComposite" Layer="511" Hidden="0"><Objects>${objects.join("")}</Objects><ReferencedComponents>${referenced.join("")}</ReferencedComponents></CODComposite></Components><CiCircuitXMLizeHelper Class="CiCircuitXMLizeHelper" Circuit="1000000"/><CircPrefs><CIITCircuitPrefs Class="CIITCircuitPrefs"><Settings/></CIITCircuitPrefs></CircPrefs><Restrictions><CCircuitRestriction Class="CCircuitRestriction"><CCircuitGeneral Class="CCircuitGeneral" Password="" ShowCompValue="1" ShowCorpDB="1" ShowCompFault="1" UseSubcircuits="1" ShowBinInstrument="1" ShowBinMultisimDB="1" ShowBinUserDB="1" ShowBinInUse="1" CircuitLocked="1"/><AnalysisEnable/></CCircuitRestriction></Restrictions><Elements>${elements.join("")}</Elements></CIITDiagram></Diagram><InstrumentsData/></CIITHierDoc></XMLSubSheet></Sheet></DesignSheet></Variable></Sheet></SheetContainer></SheetInfos></UniqueSheets>${projectSheet}<UniqueSheetGroups><SheetGroupInfo FirstSheetComponentObjectID="900003"><Extensions/></SheetGroupInfo></UniqueSheetGroups><ViewState Class="CViewState" WindowPlacement="${str("44,0,3,-1,-1,-1,-1,0,0,1000,700")}" TabIndex="0"><Path><PathElement PageName="${str("1")}" ID="900003"/></Path><IITViewState OffsetX="0" OffsetY="0" ZoomIndex="15"/></ViewState>${projectExtensions}${encodeEditorExtension(serializeCircuit(file))}</Project></MSMElectronicsWorkbench>`;
}
import { PART_BY_KIND } from "../core/library";
const netlistDefinitions = (kind: string) => PART_BY_KIND.get(kind)?.definitions ?? "";

/** Preserve native records for imported files; only explicitly supported edits are patched. */
export function serializeNativeMs14(file: CircuitFile): Uint8Array {
  const source = file.schematic.nativeMs14;
  if (!source) throw new Error("This circuit has no original native .ms14 records.");
  const baseline = parseCircuit(source.baseline).schematic;
  const current = file.schematic;
  const unsupported = () => { throw new Error("Native .ms14 saving currently supports imported circuits with parameter changes and engineering data. This circuit has structural or unsupported edits; use File > Export flattened .ms14 or save as .microsim."); };
  for (const key of ["wires", "labels", "texts", "definitions"] as const) if (JSON.stringify(current[key]) !== JSON.stringify(baseline[key])) unsupported();
  if (current.components.length !== baseline.components.length) unsupported();
  const root = parseXml(source.xml), project = child(root, "Project");
  if (!project) throw new Error("Invalid original native project.");
  const seen = new Set<string>();
  for (const c of current.components) {
    const original = baseline.components.find((p) => p.id === c.id);
    if (!original) return unsupported();
    const { params: _, displayValue: _display, ...rest } = c, { params: __, displayValue: _oldDisplay, ...before } = original;
    if (JSON.stringify(rest) !== JSON.stringify(before)) unsupported();
    // A converted NI microcontroller's program lives in the editor extension; NI loads its own from the workspace.
    const nativeParams = (p: Record<string, string>) => Object.fromEntries(Object.entries(p).filter(([key]) => !(c.params.mcu === "8051" && (key === "code" || key === "asm"))));
    if (JSON.stringify(nativeParams(c.params)) === JSON.stringify(nativeParams(original.params))) continue;
    const binding = original.nativeMs14;
    if (!binding) return unsupported();
    const identity = `${binding.sheet}/${binding.component}`;
    // Repeated hierarchical instances share one original record; patching one would change all.
    if (seen.has(identity) || baseline.components.filter((p) => p.nativeMs14?.sheet === binding.sheet && p.nativeMs14?.component === binding.component).length !== 1) unsupported();
    seen.add(identity);
    const container = kids(path(project, "UniqueSheets", "SheetInfos")).find((n) => textValue(path(n, "Sheet", "Variable", "DesignSheet")?.attrs.Title) === binding.sheet);
    const diagram = path(container, "Sheet", "Variable", "DesignSheet", "Sheet", "XMLSubSheet", "CIITHierDoc", "Diagram", "CIITDiagram");
    const part = kids(child(diagram, "Elements")).find((n) => n.attrs.CiID === binding.component)?.children[0];
    const parameters = path(kids(child(part, "Attributes"))[2]?.children[0], "parameters");
    const doubles = path(kids(child(part, "Attributes"))[2]?.children[0], "doubles");
    for (const key of new Set([...Object.keys(c.params), ...Object.keys(original.params)])) {
      if (c.params[key] === original.params[key] || (c.params.mcu === "8051" && (key === "code" || key === "asm"))) continue;
      if (!/^p\d+$/.test(key) || c.params[key] === undefined) return unsupported();
      const entry = parameters?.children[Number(key.slice(1))];
      if (!entry) return unsupported();
      entry.attrs.Value = str(c.params[key]);
      const numeric = parseSpiceNumber(c.params[key]);
      const double = doubles?.children[Number(key.slice(1))];
      if (double && numeric !== null) double.attrs.Value = String(numeric);
    }
    if (c.valueKey && c.params[c.valueKey] !== original.params[c.valueKey]) {
      const drawing = path(diagram, "Components", "CODComposite", "Objects");
      const symbol = kids(drawing).find((n) => n.attrs.ID === binding.symbol)?.children[0];
      for (const object of kids(child(symbol, "Objects"))) if (object.attrs.Class === "CIITSymTextCompValue" && object.children[0]) object.children[0].attrs.Output = str(c.params[c.valueKey]);
    }
  }
  // Title-block edits are editor metadata; the complete document below preserves them.
  // XmlNode keeps raw attribute entities. Do not escape the entire attribute twice.
  const render = (node: XmlNode): string => `<${node.tag}${Object.entries(node.attrs).map(([k, v]) => ` ${k}="${v}"`).join("")}>${node.children.map(render).join("")}</${node.tag}>`;
  const text = `<?xml version="1.0" encoding="ASCII"?>\n${render(root).replace("</Project>", `${encodeEditorExtension(serializeCircuit(file))}</Project>`)}`;
  return encodeContainer(Uint8Array.from(text, (c) => c.charCodeAt(0)));
}
export function serializeMs14(file: CircuitFile, options: { flattenNative?: boolean } = {}): Uint8Array {
  if (file.schematic.nativeMs14 && !options.flattenNative && !hasHierarchy(file.schematic)) return serializeNativeMs14(file);
  // Escape all non-ASCII in the extension as XML numeric entities.
  return encodeContainer(new TextEncoder().encode(ms14Xml(file).replace(/[^\x00-\x7f]/g, (c) => `&#${c.charCodeAt(0)};`)));
}
