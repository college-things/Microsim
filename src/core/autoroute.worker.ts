import { autoroute, type RouteOptions } from './autoroute';
import type { Board } from './engineering';
self.onmessage=(event:MessageEvent<{board:Board;options:RouteOptions}>)=>{
 try {const result=autoroute(event.data.board,event.data.options,progress=>self.postMessage({progress}));self.postMessage({result});}
 catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)});}
};
