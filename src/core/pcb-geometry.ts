import type { Board, Footprint, Pad } from './engineering';
import type { Point } from './schematic';
export type Layer = 'F.Cu'|'B.Cu';
export const padSize=(p:Pad)=>p.size??{x:p.diameter??1.6,y:p.diameter??1.6};
export const padDrill=(p:Pad)=>p.shape||p.size ? p.drill : p.drill??0.8;
export const padLayers=(p:Pad):Layer[]=>padDrill(p)===undefined?['F.Cu']:['F.Cu','B.Cu'];
export const transform=(f:Pick<Footprint,'x'|'y'|'rotation'>,p:Point):Point=>{const a=f.rotation*Math.PI/180;return{x:f.x+p.x*Math.cos(a)-p.y*Math.sin(a),y:f.y+p.x*Math.sin(a)+p.y*Math.cos(a)}};
export function pointSegment(p:Point,a:Point,b:Point):number{const dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);}
export function inside(p:Point,poly:Point[]):boolean{let yes=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)yes=!yes;}return yes;}
export function segmentDistance(a:Point,b:Point,c:Point,d:Point):number{
 const cross=(u:Point,v:Point,w:Point)=>(v.x-u.x)*(w.y-u.y)-(v.y-u.y)*(w.x-u.x);
 if(cross(a,b,c)*cross(a,b,d)<=0&&cross(c,d,a)*cross(c,d,b)<=0&&Math.max(a.x,b.x)>=Math.min(c.x,d.x)&&Math.max(c.x,d.x)>=Math.min(a.x,b.x)&&Math.max(a.y,b.y)>=Math.min(c.y,d.y)&&Math.max(c.y,d.y)>=Math.min(a.y,b.y))return 0;
 return Math.min(pointSegment(a,c,d),pointSegment(b,c,d),pointSegment(c,a,b),pointSegment(d,a,b));
}
// All supported pad shapes are a rotated rectangle swept by a circle. Degenerate cores are intentional.
export interface CopperShape { core:Point[]; radius:number }
export function pointShapeDistance(p:Point,shape:CopperShape):number{
 if(inside(p,shape.core))return -shape.radius;
 let d=Infinity;
 for(let i=0;i<shape.core.length;i++)d=Math.min(d,pointSegment(p,shape.core[i],shape.core[(i+1)%shape.core.length]));
 return d-shape.radius;
}
export function padShape(f:Footprint,p:Pad,expand=0):CopperShape{
 const s=padSize(p),kind=p.shape??'circle',r=kind==='circle'?Math.min(s.x,s.y)/2:kind==='oval'?Math.min(s.x,s.y)/2:kind==='roundrect'?Math.min(s.x,s.y)*0.25:0;
 const x=s.x/2-r,y=s.y/2-r;
 return {core:[{x:-x,y:-y},{x,y:-y},{x,y},{x:-x,y}].map(q=>transform({...f,...transform(f,p)},q)),radius:r+expand};
}
export function shapeDistance(a:CopperShape,b:CopperShape):number{
 if(inside(a.core[0],b.core)||inside(b.core[0],a.core))return -a.radius-b.radius;
 let d=Infinity;for(let i=0;i<a.core.length;i++)for(let j=0;j<b.core.length;j++)d=Math.min(d,segmentDistance(a.core[i],a.core[(i+1)%a.core.length],b.core[j],b.core[(j+1)%b.core.length]));return d-a.radius-b.radius;
}
export const lineShape=(a:Point,b:Point,width=0):CopperShape=>({core:[a,b],radius:width/2});
export function boardPads(b:Board){return [...b.footprints.flatMap(f=>f.pads.map(p=>({p,f,at:transform(f,p),net:p.net,name:`${f.ref}.${p.pin}`,layers:padLayers(p),shape:padShape(f,p)}))),...(b.vias??[]).map((v,i)=>{const p:Pad={...v,pin:'',shape:'circle',size:{x:v.diameter,y:v.diameter}};const f:Footprint={component:'',ref:'',x:0,y:0,rotation:0,pads:[]};return{p,f,at:v,net:v.net,name:`Via ${i+1}`,layers:padLayers(p),shape:padShape(f,p)}})];}
export const boardSegments=(b:Board)=>b.tracks.flatMap(t=>t.points.slice(1).map((p,i)=>({...t,a:t.points[i],b:p,shape:lineShape(t.points[i],p,t.width)})));
