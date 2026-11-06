import type { Pad, Footprint } from './engineering';
import type { Point, SchComponent } from './schematic';

export interface Package { name: string; pads: Pad[]; outline: Point[][] }
const rect = (x: number, y: number, w: number, h: number): Point[] => [{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h},{x,y}];
const th = (n: number, x: number, y: number, size=1.7, drill=0.8): Pad => ({number:String(n),pin:String(n),net:'',x,y,shape:n===1?'rect':'circle',size:{x:size,y:size},drill});
const smd = (n: number, x: number, y: number, w: number, h: number): Pad => ({number:String(n),pin:String(n),net:'',x,y,shape:'roundrect',size:{x:w,y:h}});
// Original land patterns derived from nominal JEDEC MS-001/MS-012/TO outlines and EIA chip sizes.
// Body outlines are mechanical guides; silkscreen is trimmed away from all pad openings.
export const FOOTPRINTS: Record<string, Package> = {};
const add = (name: string, pads: Pad[], outline: Point[][]) => FOOTPRINTS[name]={name,pads,outline};
for (const inches of [0.3,0.4,0.5]) { const pitch=25.4*inches; add(`AXIAL-${inches.toFixed(1)}`, [th(1,0,0),th(2,pitch,0)], [rect(pitch/2-3,-1.2,6,2.4)]); }
for (const pitch of [2.5,5]) add(`RADIAL-${pitch.toFixed(1)}`,[th(1,0,0),th(2,pitch,0)],[rect(-1.5,-3,pitch+3,6)]);
for (const size of [3,5]) add(`LED-${size}mm`,[th(1,0,0),th(2,2.54,0)],[rect(1.27-size/2,-size/2,size,size)]);
add('TO-92',[th(1,0,0,1,0.6),th(2,1.27,0,1,0.6),th(3,2.54,0,1,0.6)],[rect(-1,-2.5,4.54,3.5)]);
add('TO-220',[th(1,0,0,1.9,1),th(2,2.54,0,1.9,1),th(3,5.08,0,1.9,1)],[rect(-2.54,-4,10.16,4.5)]);
for (const n of [8,14,16,20,28,40]) {
  const rows=n>=28?15.24:7.62, half=n/2;
  add(`DIP-${n}`,Array.from({length:n},(_,i)=>th(i+1,i<half?0:rows,(i<half?i:n-1-i)*2.54)),[rect(1,-1.27,rows-2,half*2.54)]);
}
for (const n of [8,14,16]) {
  const half=n/2;
  add(`SOIC-${n}`,Array.from({length:n},(_,i)=>smd(i+1,i<half?0:5.4,(i<half?i:n-1-i)*1.27,1.55,0.6)),[rect(0.75,-0.65,3.9,half*1.27)]);
}
add('SOT-23',[smd(1,0,0,1,0.6),smd(2,0,1.9,1,0.6),smd(3,2,0.95,1,0.6)],[rect(0.3,-0.55,1.4,3)]);
add('SOT-223',[smd(1,0,0,2,1),smd(2,0,2.3,2,1),smd(3,0,4.6,2,1),smd(4,6.3,2.3,2.5,3.4)],[rect(1,-1,3.5,6.6)]);
for (const [name,pitch,w,h] of [['0603',1.6,0.9,0.95],['0805',2,1.1,1.45],['1206',3.2,1.3,1.8]] as const) add(name,[smd(1,0,0,w,h),smd(2,pitch,0,w,h)],[rect(pitch/2-0.45,-h/2,0.9,h)]);
for (const [name,pitch,w,h] of [['SMA',4.2,1.7,1.8],['SMB',4.6,2,2.4]] as const) add(name,[smd(1,0,0,w,h),smd(2,pitch,0,w,h)],[rect(0.9,-h/2-0.3,pitch-1.8,h+0.6)]);
for (let n=1;n<=40;n++) add(`HEADER-1x${n}`,Array.from({length:n},(_,i)=>th(i+1,i*2.54,0)),[rect(-1.27,-1.27,n*2.54,2.54)]);
add('TERMINAL-2',[th(1,0,0,2.4,1.2),th(2,5.08,0,2.4,1.2)],[rect(-2.5,-4,10.08,8)]);
// Both leads on each side of the common 6x6 switch are internally joined.
add('TACT-6x6',[th(1,0,0),th(1,0,4.5),th(2,6.5,0),th(2,6.5,4.5)],[rect(0.25,-0.75,6,6)]);

export const PIN_MAPS: Record<string, Record<string,string>> = {
  '2n3904':{E:'1',B:'2',C:'3'},'2n3906':{E:'1',B:'2',C:'3'},'2n2222a':{C:'1',B:'2',E:'3'},bc547b:{C:'1',B:'2',E:'3'},
  tip120:{B:'1',C:'2',E:'3'},'2n7000':{S:'1',G:'2',D:'3'},irf540n:{G:'1',D:'2',S:'3'},
  '7805':{IN:'1',GND:'2',OUT:'3'},'7812':{IN:'1',GND:'2',OUT:'3'},lm317:{ADJ:'1',OUT:'2',IN:'3'},
  ne555:{GND:'1',TRIG:'2',OUT:'3',RESET:'4',CTRL:'5',THRESH:'6',DISCH:'7',VCC:'8'},
  lm358:{OUT:'1','-':'2','+':'3','V-':'4','V+':'8'},tl072:{OUT:'1','-':'2','+':'3','V-':'4','V+':'8'},
  lm741:{'-':'2','+':'3','V-':'4',OUT:'6','V+':'7'},lm311:{E:'1','+':'2','-':'3','V-':'4',C:'7','V+':'8'},
  '74hc00':{a:'1',b:'2',y:'3'},'74hc02':{a:'2',b:'3',y:'1'},'74hc04':{a:'1',y:'2'},
  '74hc08':{a:'1',b:'2',y:'3'},'74hc32':{a:'1',b:'2',y:'3'},'74hc86':{a:'1',b:'2',y:'3'},
  '74hc74':{CLR_N:'1',D:'2',CLK:'3',PRE_N:'4',Q:'5',QN:'6'},
  '74hc161':{CLR_N:'1',CLK:'2',A:'3',B:'4',C:'5',D:'6',ENP:'7',LOAD_N:'9',ENT:'10',QD:'11',QC:'12',QB:'13',QA:'14',RCO:'15'},
  '74hc595':{QB:'1',QC:'2',QD:'3',QE:'4',QF:'5',QG:'6',QH:'7',QH_SER:'9',CLR_N:'10',SRCLK:'11',RCLK:'12',OE_N:'13',SER:'14',QA:'15'},
  cd4017:{Q5:'1',Q1:'2',Q0:'3',Q2:'4',Q6:'5',Q7:'6',Q3:'7',Q8:'9',Q4:'10',Q9:'11',CARRY:'12',INHIBIT:'13',CLK:'14',RESET:'15'},
  mcu8051:{RST:'9',XTAL2:'18',XTAL1:'19',GND:'20',PSEN:'29',ALE:'30',EA:'31',VCC:'40'},
  'push-button':{COM:'1',NO:'2'},led:{K:'1',A:'2'},diode:{K:'1',A:'2'},
};
for(let i=0;i<8;i++) Object.assign(PIN_MAPS.mcu8051,{[`P1.${i}`]:String(i+1),[`P3.${i}`]:String(i+10),[`P2.${i}`]:String(i+21),[`P0.${i}`]:String(39-i)});
PIN_MAPS.npn=PIN_MAPS['2n3904']; PIN_MAPS.pnp=PIN_MAPS['2n3906'];
export function defaultFootprint(kind: string, pins: number): string {
  if(kind==='resistor'||kind==='trimmer'||kind==='inductor'||kind==='fuse') return 'AXIAL-0.4';
  if(kind==='capacitor'||kind==='crystal'||kind==='ldr'||kind==='ntc') return 'RADIAL-2.5';
  if(kind==='electrolytic') return 'RADIAL-5.0';
  if(kind.startsWith('led')) return 'LED-5mm';
  if(/^(diode|zener|1n)/.test(kind)) return 'AXIAL-0.3';
  if(/^(2n|bc547|npn|pnp)/.test(kind)) return 'TO-92';
  if(/^(7805|7812|lm317|tip120|irf540n)$/.test(kind)) return 'TO-220';
  if(/^(lm741|lm358|tl072|lm311|ne555)$/.test(kind)) return 'DIP-8';
  if(/^74hc/.test(kind)) return /161|595/.test(kind)?'DIP-16':'DIP-14';
  if(kind==='cd4017') return 'DIP-16';
  if(kind==='mcu8051') return 'DIP-40';
  if(kind==='push-button') return 'TACT-6x6';
  if(/^(vdc|vsin|vpulse|idc|lamp|buzzer|switch)$/.test(kind)) return 'TERMINAL-2';
  return `HEADER-1x${Math.max(1,Math.min(40,pins))}`;
}
export function packagePads(c: SchComponent, name: string, nets: Map<string,string>): Pad[] {
  const pkg=FOOTPRINTS[name]; if(!pkg) throw new Error('Choose a known footprint.');
  const map=PIN_MAPS[c.kind] ?? (/^led/.test(c.kind)?PIN_MAPS.led:/^(1n|zener)/.test(c.kind)?PIN_MAPS.diode:undefined);
  const mapping=map ?? Object.fromEntries(c.pins.map((p,i)=>[p.name,String(i+1)]));
  if(Object.values(mapping).some(n=>!pkg.pads.some(p=>p.number===n))) throw new Error('This footprint does not have all mapped pad numbers.');
  return pkg.pads.map(p=>{
    const pin=c.pins.find(q=>mapping[q.name]===p.number)?.name;
    // Physical supply pins absent from the ideal digital symbol must be assigned explicitly in the dialog.
    const supply=/^(74hc|cd4017)/.test(c.kind)?(p.number===String(pkg.pads.length)?'VCC':p.number===String(pkg.pads.length/2)?'GND':undefined):c.kind==='mcu8051'?Object.keys(map!).find(k=>map![k]===p.number):undefined;
    return {...structuredClone(p),pin:pin??supply??`NC${p.number}`,net:pin?nets.get(pin)??`nc_${c.id}_${pin}`:nets.get(supply??`NC${p.number}`)??`nc_${c.id}_${supply??p.number}`};
  });
}
export function changeFootprint(f: Footprint, c: SchComponent, name: string): void {
  const nets=new Map(f.pads.map(p=>[p.pin,p.net])); f.pads=packagePads(c,name,nets); f.name=name; f.outline=structuredClone(FOOTPRINTS[name].outline);
}
