import { describe, expect, it } from 'vitest';
import { FOOTPRINTS, PIN_MAPS, changeFootprint, defaultFootprint } from '../../src/core/footprints';
import { boardFromSchematic, boardToKicad, checkBoard, validateWorkspace, type Board, type Pad } from '../../src/core/engineering';
import { boardFabricationFiles } from '../../src/core/fabrication';
import { boardSilkscreen, strokeText } from '../../src/core/pcb-silk';
import { boardPads, lineShape, shapeDistance } from '../../src/core/pcb-geometry';
import { zoneContains } from '../../src/core/pcb-zones';
import { autoroute } from '../../src/core/autoroute';
import { Doc } from '../../src/core/doc';
import { EXAMPLES, buildExample } from '../../src/core/examples';
import { parseCircuit, serializeCircuit } from '../../src/core/file';
import { PARTS } from '../../src/core/library';

const empty=():Board=>({width:50,height:40,clearance:0.25,footprints:[],tracks:[],vias:[]});
function add(b:Board,ref:string,x:number,y:number,pads:Pad[],rotation=0){b.footprints.push({component:ref,ref,x,y,rotation,pads});}
const pad=(net:string,x=0,y=0):Pad=>({net,pin:'1',number:'1',x,y,shape:'roundrect',size:{x:1,y:1}});

describe('original footprint library',()=>{
 it('has expected package counts, pitch and row spacing',()=>{
  for(const n of [8,14,16,20,28,40]){const p=FOOTPRINTS[`DIP-${n}`].pads;expect(p).toHaveLength(n);expect(p[1].y-p[0].y).toBeCloseTo(2.54);expect(p[n-1].x-p[0].x).toBeCloseTo(n>=28?15.24:7.62);expect(p[n/2].y).toBeCloseTo((n/2-1)*2.54);}
  for(const n of [8,14,16]){const p=FOOTPRINTS[`SOIC-${n}`].pads;expect(p).toHaveLength(n);expect(p[1].y-p[0].y).toBeCloseTo(1.27);expect(p[n-1].x).toBeCloseTo(5.4);expect(p.every(q=>q.drill===undefined)).toBe(true);}
  expect(FOOTPRINTS['TO-92'].pads.map(p=>p.x)).toEqual([0,1.27,2.54]);
  for(const name of ['AXIAL-0.3','AXIAL-0.4','AXIAL-0.5','RADIAL-2.5','RADIAL-5.0','LED-3mm','LED-5mm','TO-220','SOT-23','SOT-223','0603','0805','1206','SMA','SMB','TERMINAL-2','TACT-6x6','HEADER-1x40'])expect(FOOTPRINTS[name]).toBeDefined();
  for(const part of PARTS)expect(FOOTPRINTS[defaultFootprint(part.kind,part.pins.length)]).toBeDefined();
  for(const part of PARTS.filter(p=>p.pins.length&&!p.instrument&&p.kind!=='ground')){const doc=new Doc();doc.addPart(part.kind,0,0);const b=boardFromSchematic(doc.schematic);for(const pin of part.pins)expect(b.footprints[0].pads.some(p=>p.pin===pin.name),`${part.kind}.${pin.name}`).toBe(true);}
 });
 it('maps real package numbers, one-section parts and MCU ports',()=>{
  expect(PIN_MAPS['2n3904']).toEqual({E:'1',B:'2',C:'3'});
  expect(PIN_MAPS['7805']).toEqual({IN:'1',GND:'2',OUT:'3'});
  expect(PIN_MAPS.ne555).toEqual({GND:'1',TRIG:'2',OUT:'3',RESET:'4',CTRL:'5',THRESH:'6',DISCH:'7',VCC:'8'});
  expect(PIN_MAPS.lm358).toEqual({OUT:'1','-':'2','+':'3','V-':'4','V+':'8'});
  expect(PIN_MAPS['74hc00']).toEqual({a:'1',b:'2',y:'3'});
  expect(PIN_MAPS['74hc02']).toEqual({a:'2',b:'3',y:'1'});
  expect(PIN_MAPS['74hc595']).toMatchObject({SER:'14',SRCLK:'11',RCLK:'12',OE_N:'13',CLR_N:'10',QA:'15',QH:'7',QH_SER:'9'});
  for(let i=0;i<8;i++)expect(PIN_MAPS.mcu8051).toMatchObject({[`P1.${i}`]:String(i+1),[`P0.${i}`]:String(39-i),[`P2.${i}`]:String(21+i),[`P3.${i}`]:String(10+i)});
  const doc=new Doc();doc.addPart('ne555',0,0);const b=boardFromSchematic(doc.schematic);expect(b.footprints[0].pads.find(p=>p.pin==='OUT')?.number).toBe('3');
  changeFootprint(b.footprints[0],doc.schematic.components[0],'SOIC-8');expect(b.footprints[0].pads.every(p=>p.drill===undefined)).toBe(true);
  expect(()=>changeFootprint(b.footprints[0],doc.schematic.components[0],'0603')).toThrow(/mapped/);
 });
 it('reloads old generic geometry without migrating it or mutating its source',()=>{
  const doc=new Doc();const c=doc.addPart('resistor',0,0),b=empty();add(b,c.refDes,12,14,[{pin:'1',net:'a',x:0,y:0},{pin:'2',net:'b',x:2.54,y:0,diameter:2,drill:1}],37);b.footprints[0].component=c.id;
  doc.schematic.workspace={board:b};const loaded=parseCircuit(serializeCircuit({schematic:doc.schematic,analyses:[],issues:[]})).schematic;
  expect(loaded.workspace!.board).toEqual(b);validateWorkspace(loaded.workspace);
  const refreshed=boardFromSchematic(loaded,b);expect(refreshed.footprints[0].pads.map(({net,...p})=>p)).toEqual(b.footprints[0].pads.map(({net,...p})=>p));
  refreshed.footprints[0].pads[0].x=99;expect(b.footprints[0].pads[0].x).toBe(0);
 });
});

describe('manufacturing layers and DRC',()=>{
 it('declares every aperture before use and exports rotated shapes, paste and plated holes',()=>{
  const b=empty();add(b,'R1',10,10,[pad('a')],37);add(b,'J1',20,10,[{pin:'1',net:'b',x:0,y:0,shape:'oval',size:{x:3,y:1.6},drill:0.8}]);add(b,'J2',30,10,[{pin:'1',net:'c',x:0,y:0,shape:'rect',size:{x:2,y:1},drill:0.6}],90);
  const files=boardFabricationFiles(b);
  for(const [name,text] of Object.entries(files).filter(([n])=>/\.g/.test(n))){const defined=new Set<number>();for(const line of text.split('\n')){const a=line.match(/^%ADD(\d+)/);if(a)defined.add(Number(a[1]));const d=line.match(/^D(\d+)\*/);if(d)expect(defined.has(Number(d[1])),name).toBe(true);}}
  expect(files['front-paste.gtp'].match(/D03\*/g)).toHaveLength(1);
  expect(files['back-copper.gbl']).not.toContain('X10000000Y30000000D03*');
  expect(files['plated-drills.drl']).not.toContain('X10.000000Y30.000000');
  expect(files['plated-drills.drl']).toContain('X20.000000Y30.000000');
  expect(files['front-copper.gtl']).toContain('%AM');expect(files['front-copper.gtl']).toContain('O,3.000000X1.600000');expect(files['front-copper.gtl']).toContain('R,1.000000X2.000000');
  const pcb=boardToKicad(b);expect(pcb).toContain('smd roundrect');expect(pcb).toContain('"F.Paste"');expect(pcb).toContain('(roundrect_rratio 0.25)');
 });
 it('draws a deterministic original 1 mm stroke alphabet and keeps silk off rotated and neighboring pads',()=>{
  const paths=strokeText('R1 ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',{x:0,y:0});expect(paths.length).toBeGreaterThan(40);expect(Math.min(...paths.flat().map(p=>p.y))).toBe(0);expect(Math.max(...paths.flat().map(p=>p.y))).toBe(1);expect(paths).toEqual(strokeText('R1 ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',{x:0,y:0}));
  const doc=new Doc();doc.addPart('ne555',0,0);doc.addPart('resistor',100,0);const b=boardFromSchematic(doc.schematic);b.footprints[0].rotation=37;
  const silk=boardSilkscreen(b);expect(silk.length).toBeGreaterThan(10);for(const s of silk)for(const p of boardPads(b))expect(shapeDistance(lineShape(s.a,s.b,s.width),p.shape)).toBeGreaterThanOrEqual(0.149999);
  expect(boardToKicad(b)).toContain('Microsim:DIP-8');expect(boardFabricationFiles({...b,footprints:[b.footprints[1]]})['front-silkscreen.gto']).toContain('D01*');
 });
 it('checks pad shapes, SMD layer connectivity, silk, drill, ring and width',()=>{
  const b=empty();add(b,'A',10,10,[pad('a')]);add(b,'B',11.1,10,[pad('b')]);expect(checkBoard(b).join()).toContain('pad clearance');
  b.footprints[1].x=20;b.footprints[1].pads[0].net='a';b.tracks=[{net:'a',layer:'B.Cu',width:0.1,points:[{x:10,y:10},{x:20,y:10}]}];
  expect(checkBoard(b).join()).toMatch(/unconnected/);expect(checkBoard(b).join()).toMatch(/width below/);
  b.tracks[0].layer='F.Cu';b.tracks[0].width=0.25;expect(checkBoard(b)).toEqual([]);
  b.footprints[0].pads[0].drill=0.2;expect(checkBoard(b).join()).toMatch(/drill below/);
  b.footprints[0].pads[0].drill=0.8;expect(checkBoard(b).join()).toMatch(/annular ring/);
  b.silkscreen=[{a:{x:9,y:10},b:{x:11,y:10},width:0.15,ref:'BAD'}];expect(checkBoard(b).join()).toMatch(/silkscreen over pad/);
 });
 it('clears a pour around other nets using polarity and writes a refillable KiCad zone',()=>{
  const b=empty();add(b,'G',5,5,[pad('gnd')]);add(b,'X',20,10,[pad('other')]);add(b,'H',40,30,[pad('gnd')]);
  const z={net:'gnd',layer:'F.Cu' as const,outline:[{x:1,y:1},{x:49,y:1},{x:49,y:39},{x:1,y:39}]};b.zones=[z];
  expect(zoneContains(b,z,{x:20.6,y:10})).toBe(false);expect(zoneContains(b,z,{x:20.8,y:10})).toBe(true);expect(zoneContains(b,z,{x:5,y:5})).toBe(true);
  expect(checkBoard(b)).toEqual([]);
  const g=boardFabricationFiles(b)['front-copper.gtl'];expect(g).toMatch(/%LPD\*%[\s\S]*G36\*[\s\S]*%LPC\*%[\s\S]*D03\*[\s\S]*%LPD\*%/);
  expect(boardToKicad(b)).toContain('(zone (net 1) (net_name "gnd") (layer "F.Cu")');expect(boardToKicad(b)).toContain('(connect_pads yes (clearance 0.25))');
  b.tracks.push({net:'wall',layer:'F.Cu',width:0.25,points:[{x:25,y:0.5},{x:25,y:39.5}]});b.footprints.pop();expect(checkBoard(b).join()).toMatch(/Warning:.*island/);
 });
});

describe('two-layer maze autorouter',()=>{
 it('routes two crossing nets, changing layer instead of shorting them',()=>{
  const b=empty();add(b,'N1',25,5,[pad('north-south')]);add(b,'N2',25,35,[pad('north-south')]);add(b,'E1',5,20,[pad('east-west')]);add(b,'E2',45,20,[pad('east-west')]);
  const result=autoroute(b);expect(result.unrouted).toEqual([]);expect(new Set(result.board.tracks.map(t=>t.net))).toEqual(new Set(['north-south','east-west']));expect(result.board.vias!.length).toBeGreaterThanOrEqual(2);expect(checkBoard(result.board)).toEqual([]);
 });
 it('routes crossing SMD nets with vias while respecting a fixed copper barrier',()=>{
  const b=empty();add(b,'A',10,20,[pad('signal')]);add(b,'B',40,20,[pad('signal')]);
  b.tracks=[{net:'wall',layer:'F.Cu',width:0.25,points:[{x:25,y:0.375},{x:25,y:39.625}]}];
  const result=autoroute(b);expect(result.unrouted).toEqual([]);expect(result.board.vias!.length).toBeGreaterThanOrEqual(2);expect(checkBoard(result.board)).toEqual([]);expect(b.tracks).toHaveLength(1);
 });
 it('routes every connection in the 555 blinker with clean DRC',()=>{
  const s=buildExample(EXAMPLES.find(e=>e.name==='555 LED blinker')!),b=boardFromSchematic(s);
  const progress:number[]=[];const result=autoroute(b,{},p=>progress.push(p.completed));
  expect(result.unrouted).toEqual([]);expect(checkBoard(result.board)).toEqual([]);expect(result.elapsedMs).toBeLessThan(5000);expect(progress.at(-1)).toBe(result.connections);
  expect(boardFabricationFiles(result.board)['front-silkscreen.gto']).toContain('D01*');
 });
 it('reports impossible connections and bounds retry/time work',()=>{
  const b=empty();add(b,'A',10,20,[pad('a')]);add(b,'B',40,20,[pad('a')]);b.keepouts=[{layer:'both',outline:[{x:24,y:0},{x:26,y:0},{x:26,y:40},{x:24,y:40}]}];
  const result=autoroute(b,{maxMs:500,retries:1});expect(result.unrouted).toEqual(['a: A.1 to B.1']);expect(result.elapsedMs).toBeLessThan(1500);
 });
 it('routes a 30-part board within a few seconds',()=>{
  const doc=new Doc();
  for(let i=0;i<30;i++){const c=doc.addPart('resistor',i*100,0);c.pins[0].net=`row${Math.floor(i/6)}`;c.pins[1].net=`pair${Math.floor(i/2)}`;}
  const b=boardFromSchematic(doc.schematic);b.width=120;b.height=90;
  b.footprints.forEach((f,i)=>{f.x=8+i%6*18;f.y=8+Math.floor(i/6)*16;});
  const result=autoroute(b);expect(result.unrouted).toEqual([]);expect(checkBoard(result.board)).toEqual([]);expect(result.elapsedMs).toBeLessThan(5000);
 });
});
