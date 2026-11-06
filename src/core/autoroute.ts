import { validateWorkspace, type Board, type Track, type Via } from './engineering';
import { boardPads, boardSegments, inside, lineShape, shapeDistance, type CopperShape } from './pcb-geometry';
import type { Point } from './schematic';

export interface RouteOptions { width?:number; maxMs?:number; retries?:number }
export interface RouteProgress { completed:number; total:number; attempt:number }
export interface RouteResult { board:Board; unrouted:string[]; elapsedMs:number; connections:number }
class Heap {
 private nodes:number[]=[];private scores:number[]=[];
 get length(){return this.nodes.length;}
 push(n:number,s:number){let i=this.nodes.length;this.nodes.push(n);this.scores.push(s);while(i){const p=(i-1)>>>1;if(this.scores[p]<=s)break;this.nodes[i]=this.nodes[p];this.scores[i]=this.scores[p];i=p;}this.nodes[i]=n;this.scores[i]=s;}
 pop(){const n=this.nodes[0],last=this.nodes.pop()!,score=this.scores.pop()!;if(this.nodes.length){let i=0;while(i*2+1<this.nodes.length){let c=i*2+1;if(c+1<this.nodes.length&&this.scores[c+1]<this.scores[c])c++;if(this.scores[c]>=score)break;this.nodes[i]=this.nodes[c];this.scores[i]=this.scores[c];i=c;}this.nodes[i]=last;this.scores[i]=score;}return n;}
}
/** Two-layer orthogonal A*, 0.125 mm grid for nominal 0.25 mm tracks. Run in the PCB worker. */
export function autoroute(input:Board,options:RouteOptions={},progress?:(p:RouteProgress)=>void):RouteResult {
 validateWorkspace({board:input});
 const start=performance.now(),width=options.width??0.25,step=Math.min(0.125,input.clearance/2),maxMs=options.maxMs??5000;
 if(!Number.isFinite(width)||width<0.15||!Number.isFinite(maxMs)||maxMs<=0)throw new Error('Use a track width of at least 0.15 mm and a positive time limit.');
 const nx=Math.floor(input.width/step)+1,ny=Math.floor(input.height/step)+1,area=nx*ny;
 if(area>1500000)throw new Error('Board is too large for this router grid. Route a smaller board or route manually.');
 const initial=structuredClone(input),pads=boardPads(initial),tasks:{net:string;a:typeof pads[number];b:typeof pads[number];length:number}[]=[];
 for(const net of new Set(pads.map(p=>p.net))){
  const group=pads.filter(p=>p.net===net),seen=new Set([0]);
  while(seen.size<group.length){let best:{i:number;j:number;length:number}|undefined;
   for(const i of seen)for(let j=0;j<group.length;j++)if(!seen.has(j)){const length=Math.hypot(group[i].at.x-group[j].at.x,group[i].at.y-group[j].at.y);if(!best||length<best.length)best={i,j,length};}
   if(!best)break;seen.add(best.j);tasks.push({net,a:group[best.i],b:group[best.j],length:best.length});
  }
 }
 const totals=new Map<string,number>();tasks.forEach(t=>totals.set(t.net,(totals.get(t.net)??0)+t.length));
 tasks.sort((a,b)=>totals.get(a.net)!-totals.get(b.net)!||a.length-b.length);
 let best:RouteResult|undefined,priority=new Set<string>();
 const retries=Math.max(0,Math.min(3,options.retries??2));
 for(let attempt=0;attempt<=retries;attempt++){
  const board=structuredClone(initial),unrouted:string[]=[],failed=new Set<string>();let complete=0;
  const ordered=[...tasks].sort((a,b)=>Number(priority.has(b.net))-Number(priority.has(a.net)));
  for(const task of ordered){
   progress?.({completed:complete++,total:tasks.length,attempt:attempt+1});
   const fail=()=>{failed.add(task.net);unrouted.push(`${task.net}: ${task.a.name} to ${task.b.name}`);};
   if(performance.now()-start>maxMs){fail();continue;}
   const blocked=new Uint8Array(area*2),viaBlocked=new Uint8Array(area*2),segments=boardSegments(board);
   const obstacles:{shape:CopperShape;layers:number[]}[]=[...pads.filter(p=>p.net!==task.net).map(p=>({shape:p.shape,layers:p.layers.map(l=>l==='F.Cu'?0:1)})),...segments.filter(s=>s.net!==task.net).map(s=>({shape:s.shape,layers:[s.layer==='F.Cu'?0:1]})),...(board.vias??[]).filter(v=>v.net!==task.net).map(v=>({shape:lineShape(v,v,v.diameter),layers:[0,1]}))];
   const paint=(shape:CopperShape,layers:number[],extra:number,target:Uint8Array)=>{
    const r=shape.radius+extra,minX=Math.max(0,Math.floor((Math.min(...shape.core.map(p=>p.x))-r)/step)),maxX=Math.min(nx-1,Math.ceil((Math.max(...shape.core.map(p=>p.x))+r)/step)),minY=Math.max(0,Math.floor((Math.min(...shape.core.map(p=>p.y))-r)/step)),maxY=Math.min(ny-1,Math.ceil((Math.max(...shape.core.map(p=>p.y))+r)/step));
    for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){const p={x:x*step,y:y*step};if(shapeDistance(lineShape(p,p),shape)<extra)for(const layer of layers)target[layer*area+y*nx+x]=1;}
   };
   const margin=step*0.72+0.001;
   for(const o of obstacles){paint(o.shape,o.layers,board.clearance+width/2+margin,blocked);paint(o.shape,o.layers,board.clearance+0.4+margin,viaBlocked);}
   for(const k of board.keepouts??[]){const layers=k.layer==='both'?[0,1]:[k.layer==='F.Cu'?0:1];
    const minX=Math.max(0,Math.floor(Math.min(...k.outline.map(p=>p.x))/step)),maxX=Math.min(nx-1,Math.ceil(Math.max(...k.outline.map(p=>p.x))/step)),minY=Math.max(0,Math.floor(Math.min(...k.outline.map(p=>p.y))/step)),maxY=Math.min(ny-1,Math.ceil(Math.max(...k.outline.map(p=>p.y))/step));
    for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++)if(inside({x:x*step,y:y*step},k.outline))for(const l of layers){blocked[l*area+y*nx+x]=1;viaBlocked[l*area+y*nx+x]=1;}
    k.outline.forEach((p,i)=>{const shape=lineShape(p,k.outline[(i+1)%k.outline.length]);paint(shape,layers,board.clearance+width/2+margin,blocked);paint(shape,layers,board.clearance+0.4+margin,viaBlocked);});
   }
   const edge=board.clearance+width/2+margin,viaEdge=board.clearance+0.4+margin;
   const at=(p:Point)=>Math.round(p.y/step)*nx+Math.round(p.x/step),goal=at(task.b.at),source=at(task.a.at);
   const point=(n:number):Point=>({x:n%area%nx*step,y:Math.floor(n%area/nx)*step});
   const valid=(n:number)=>{const p=point(n);return !blocked[n]&&p.x>=edge&&p.y>=edge&&p.x<=board.width-edge&&p.y<=board.height-edge;};
   const heuristic=(n:number)=>{const a=point(n),b=point(goal);return (Math.abs(a.x-b.x)+Math.abs(a.y-b.y))/step;};
   const dist=new Float32Array(area*2);dist.fill(Infinity);const parent=new Int32Array(area*2);parent.fill(-1);const closed=new Uint8Array(area*2),heap=new Heap();
   for(const l of task.a.layers){const n=source+(l==='F.Cu'?0:area);if(valid(n)){dist[n]=0;heap.push(n,heuristic(n));}}
   let end=-1,visited=0;
   while(heap.length){const n=heap.pop();if(closed[n])continue;closed[n]=1;if(n%area===goal&&task.b.layers.includes(n<area?'F.Cu':'B.Cu')){end=n;break;}
    if(++visited%2048===0&&(performance.now()-start>maxMs||visited>500000))break;
    const x=n%area%nx,y=Math.floor(n%area/nx),other=n<area?n+area:n-area,p=point(n);
    const next=[x>0?n-1:-1,x<nx-1?n+1:-1,y>0?n-nx:-1,y<ny-1?n+nx:-1];
    if(!viaBlocked[n]&&!viaBlocked[other]&&p.x>=viaEdge&&p.y>=viaEdge&&p.x<=board.width-viaEdge&&p.y<=board.height-viaEdge)next.push(other);
    for(const j of next)if(j>=0&&!closed[j]&&valid(j)){const cost=dist[n]+(j===other?2/step:1);if(cost<dist[j]){dist[j]=cost;parent[j]=n;heap.push(j,cost+heuristic(j));}}
   }
   if(end<0){fail();continue;}
   const nodes:number[]=[];for(let n=end;n>=0;n=parent[n])nodes.push(n);nodes.reverse();
   const tracks:Track[]=[],vias:Via[]=[];let layer=nodes[0]<area?'F.Cu' as const:'B.Cu' as const,points:Point[]=[task.a.at,point(nodes[0])];
   const flush=()=>{const reduced:Point[]=[];for(const p of points){if(reduced.length&&Math.hypot(p.x-reduced[reduced.length-1].x,p.y-reduced[reduced.length-1].y)<1e-8)continue;while(reduced.length>1){const a=reduced[reduced.length-2],b=reduced[reduced.length-1];if(Math.abs((b.x-a.x)*(p.y-b.y)-(b.y-a.y)*(p.x-b.x))>1e-8)break;reduced.pop();}reduced.push(p);}if(reduced.length>1)tracks.push({net:task.net,layer,width,points:reduced});};
   for(let i=1;i<nodes.length;i++){const p=point(nodes[i]),l=nodes[i]<area?'F.Cu':'B.Cu';if(l!==layer){flush();vias.push({...p,net:task.net,diameter:0.8,drill:0.4});layer=l;points=[p];}else points.push(p);}
   points.push(task.b.at);flush();board.tracks.push(...tracks);board.vias??=[];board.vias.push(...vias);
  }
  const result={board,unrouted,elapsedMs:performance.now()-start,connections:tasks.length};
  if(!best||unrouted.length<best.unrouted.length)best=result;
  if(!unrouted.length||performance.now()-start>maxMs)break;
  priority=failed; // Bounded rip-up: discard generated copper only, retain all user routes.
 }
 progress?.({completed:tasks.length,total:tasks.length,attempt:1});
 return {...best!,elapsedMs:performance.now()-start};
}
