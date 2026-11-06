import type { Board } from './engineering';
import type { Point } from './schematic';
import { boardPads, lineShape, shapeDistance, transform } from './pcb-geometry';
// Original single-stroke alphabet on a 0.6 x 1 mm cell. Each path is a sequence of grid points.
const glyphs:Record<string,string>={
 A:'06 20 46;04 44',B:'00 06 36 45 44 33 03;00 30 41 42 33',C:'40 10 01 05 16 46',D:'00 06 26 45 41 20 00',E:'40 00 06 46;03 33',F:'06 00 40;03 33',G:'40 10 01 05 16 46 43 23',H:'00 06;40 46;03 43',I:'00 40;20 26;06 46',J:'00 40 45 36 16 05',K:'00 06;40 03 46',L:'00 06 46',M:'06 00 23 40 46',N:'06 00 46 40',O:'10 30 41 45 36 16 05 01 10',P:'06 00 30 41 42 33 03',Q:'10 30 41 45 36 16 05 01 10;24 46',R:'06 00 30 41 42 33 03;23 46',S:'40 10 01 02 43 45 36 06',T:'00 40;20 26',U:'00 05 16 36 45 40',V:'00 26 40',W:'00 06 23 46 40',X:'00 46;40 06',Y:'00 23 40;23 26',Z:'00 40 06 46',
 '0':'10 30 41 45 36 16 05 01 10;05 41','1':'02 20 26;06 46','2':'01 10 30 41 42 06 46','3':'00 40 23 44 45 36 06','4':'40 03 43;40 46','5':'40 00 03 33 44 45 36 06','6':'40 10 01 05 16 36 45 44 33 03','7':'00 40 16','8':'10 30 41 42 33 13 02 01 10;13 04 05 16 36 45 44 33','9':'43 13 02 01 10 30 41 45 36 06',
 '-':'03 43','_':'06 46','.':'26 26','?':'01 10 30 41 42 23 24;26 26',
};
export interface SilkLine { a:Point; b:Point; width:number; ref:string }
export function strokeText(text:string,at:Point,height=1):Point[][]{
 return [...text.toUpperCase()].flatMap((c,i)=>c===' '?[]:(glyphs[c]??glyphs['?']).split(';').map(path=>path.split(' ').map(token=>({x:at.x+(i*0.85+Number(token[0])*0.15)*height,y:at.y+Number(token[1])/6*height}))));
}
/** Trim in small pieces against expanded mask openings, including pads of nearby footprints. */
export function boardSilkscreen(b:Board):SilkLine[]{
 const pads=boardPads(b).filter(p=>p.layers.includes('F.Cu')),result:SilkLine[]=[];
 for(const f of b.footprints){
  if(!f.outline)continue; // Legacy boards keep their original export geometry.
  const minY=Math.min(...f.pads.map(p=>p.y-(p.size?.y??p.diameter??1.6)/2),...f.outline.flat().map(p=>p.y));
  const paths=[...f.outline,...strokeText(f.ref,{x:0,y:minY-1.6})];
  for(const path of paths)for(let i=1;i<path.length;i++){
   const a=transform(f,path[i-1]),z=transform(f,path[i]),n=Math.max(1,Math.ceil(Math.hypot(z.x-a.x,z.y-a.y)/0.1));
   let start:Point|undefined;
   for(let j=0;j<n;j++){
    const p={x:a.x+(z.x-a.x)*j/n,y:a.y+(z.y-a.y)*j/n},q={x:a.x+(z.x-a.x)*(j+1)/n,y:a.y+(z.y-a.y)*(j+1)/n};
    const clear=[p,q].every(v=>v.x>=0.1&&v.y>=0.1&&v.x<=b.width-0.1&&v.y<=b.height-0.1)&&pads.every(pad=>shapeDistance(lineShape(p,q,0.15),pad.shape)>=0.15);
    if(clear){start??=p;if(j===n-1)result.push({a:start,b:q,width:0.15,ref:f.ref});}
    else if(start){result.push({a:start,b:p,width:0.15,ref:f.ref});start=undefined;}
   }
  }
 }
 return [...result,...(b.silkscreen??[])];
}
