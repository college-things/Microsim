import type { Board, Zone } from './engineering';
import type { Point } from './schematic';
import { boardPads, boardSegments, inside, lineShape, shapeDistance, type Layer } from './pcb-geometry';

/** Point membership of the actual dark outline minus foreign copper clearances. */
export function zoneContains(b:Board,z:Zone,p:Point):boolean {
 if(!inside(p,z.outline))return false;
 const probe=lineShape(p,p);
 if(boardPads(b).some(q=>q.net!==z.net&&q.layers.includes(z.layer)&&shapeDistance(probe,q.shape)<b.clearance))return false;
 if(boardSegments(b).some(q=>q.net!==z.net&&q.layer===z.layer&&shapeDistance(probe,q.shape)<b.clearance))return false;
 return !(b.keepouts??[]).some(k=>(k.layer===z.layer||k.layer==='both')&&(inside(p,k.outline)||k.outline.some((a,i)=>shapeDistance(probe,lineShape(a,k.outline[(i+1)%k.outline.length]))<b.clearance)));
}
/** Conservative raster topology check; no island removal or polygon clipping. */
export function zoneAnalysis(b:Board){
 const warnings:string[]=[],pads=boardPads(b),segments=boardSegments(b);
 const maps=(b.zones??[]).map(z=>{
  const pitch=Math.max(0.1,Math.min(0.25,b.clearance/2),Math.sqrt(b.width*b.height/500000)),nx=Math.ceil(b.width/pitch)+1,ny=Math.ceil(b.height/pitch)+1;
  const cells=new Int32Array(nx*ny);cells.fill(-1);
  const obstacles=[...pads.filter(p=>p.net!==z.net&&p.layers.includes(z.layer)).map(p=>p.shape),...segments.filter(s=>s.net!==z.net&&s.layer===z.layer).map(s=>s.shape)];
  // Rasterize obstacle bounding boxes instead of scanning every copper feature at every cell.
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)if(inside({x:x*pitch,y:y*pitch},z.outline))cells[y*nx+x]=0;
  const block=(shape:typeof obstacles[number])=>{
   const r=shape.radius+b.clearance+pitch*0.71,minX=Math.max(0,Math.floor((Math.min(...shape.core.map(p=>p.x))-r)/pitch)),maxX=Math.min(nx-1,Math.ceil((Math.max(...shape.core.map(p=>p.x))+r)/pitch)),minY=Math.max(0,Math.floor((Math.min(...shape.core.map(p=>p.y))-r)/pitch)),maxY=Math.min(ny-1,Math.ceil((Math.max(...shape.core.map(p=>p.y))+r)/pitch));
   for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++)if(shapeDistance(lineShape({x:x*pitch,y:y*pitch},{x:x*pitch,y:y*pitch}),shape)<b.clearance+pitch*0.71)cells[y*nx+x]=-1;
  };
  obstacles.forEach(block);
  for(const k of b.keepouts??[])if(k.layer===z.layer||k.layer==='both'){
   for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)if(inside({x:x*pitch,y:y*pitch},k.outline))cells[y*nx+x]=-1;
   k.outline.forEach((p,i)=>block(lineShape(p,k.outline[(i+1)%k.outline.length])));
  }
  let count=0;const queue=new Int32Array(cells.length);
  for(let i=0;i<cells.length;i++)if(cells[i]===0){let head=0,tail=1;queue[0]=i;cells[i]=++count;
   while(head<tail){const n=queue[head++],x=n%nx;for(const j of [x>0?n-1:-1,x<nx-1?n+1:-1,n-nx,n+nx])if(j>=0&&j<cells.length&&cells[j]===0){cells[j]=count;queue[tail++]=j;}}
  }
  const component=(p:Point)=>{const x=Math.round(p.x/pitch),y=Math.round(p.y/pitch);return x>=0&&x<nx&&y>=0&&y<ny?cells[y*nx+x]:-1;};
  const anchored=new Set(pads.filter(p=>p.net===z.net&&p.layers.includes(z.layer)).map(p=>component(p.at)));
  for(let i=1;i<=count;i++)if(!anchored.has(i))warnings.push(`Warning: ${z.net} pour on ${z.layer}: island ${i} is not connected to a pad of its net (sampled check).`);
  return {z,component};
 });
 return {warnings,connected:(a:Point,c:Point,net:string,al:Layer[],cl:Layer[])=>maps.some(({z,component})=>z.net===net&&al.includes(z.layer)&&cl.includes(z.layer)&&component(a)>0&&component(a)===component(c))};
}
