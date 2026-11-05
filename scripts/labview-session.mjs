import {spawn} from 'node:child_process';
import {stat} from 'node:fs/promises';
import {join,isAbsolute,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
export class LabviewSession {
 constructor(launch=spawn){this.launch=launch;this.child=undefined;this.pending=undefined;this.path=undefined;this.bits=undefined;this.idle=undefined;}
 async exchange(request){
  if(typeof request.path!=='string'||!isAbsolute(request.path)||extname(request.path).toLowerCase()!=='.vi')throw new Error('Use an absolute .vi file path.');
  if(![32,64].includes(request.bits))throw new Error('LabVIEW bitness must be 32 or 64.');
  const frame=request.frame;
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  const name=n=>typeof n==='string'&&n.length>0&&n.length<512&&!/[\r\n\0]/.test(n);
  if(!frame||!finite(frame.time)||!frame.signals||typeof frame.signals!=='object'||Array.isArray(frame.signals)||Object.keys(frame.signals).length>1024||!Object.entries(frame.signals).every(([k,v])=>name(k)&&finite(v))||!Array.isArray(request.outputs)||request.outputs.length>1024||!request.outputs.every(name)||request.timeControl!==undefined&&request.timeControl!==''&&!name(request.timeControl))throw new Error('Expected finite numeric VI controls, output names and time.');
  if(this.pending)throw new Error('A VI exchange is already running.');
  if(!this.child||this.path!==request.path||this.bits!==request.bits){
   if(process.platform!=='win32')throw new Error('Native LabVIEW VI execution requires Windows.');
   if(!(await stat(request.path)).isFile())throw new Error('VI path must be a file.');
   this.close();this.path=request.path;this.bits=request.bits;
   const ps=join(process.env.SystemRoot??'C:/Windows',request.bits===32?'SysWOW64':'System32','WindowsPowerShell','v1.0','powershell.exe');
   const child=this.launch(ps,['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./labview-session.ps1',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe']});
   this.child=child;let stderr='';child.stderr.on('data',data=>{stderr=(stderr+data).slice(-4096)});
   const fail=error=>{if(this.child!==child)return;this.pending?.reject(error);this.pending=undefined;this.child=undefined;child.stdin.end();};
   child.on('error',fail);child.on('exit',code=>fail(new Error(`LabVIEW adapter exited (${code}): ${stderr}`)));
   createInterface({input:child.stdout}).on('line',line=>{
    if(this.child!==child||!this.pending)return;
    try{const reply=JSON.parse(line);const pending=this.pending;this.pending=undefined;
     if(reply.error)pending.reject(new Error(reply.error));
     else if(!reply.signals||typeof reply.signals!=='object'||Array.isArray(reply.signals)||!Object.values(reply.signals).every(finite))pending.reject(new Error('Invalid VI numeric output.'));
     else pending.resolve(reply);
    }catch(error){this.pending?.reject(error);this.pending=undefined;}
   });
  }
  clearTimeout(this.idle);
  try{return await new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>{this.close();reject(new Error('LabVIEW adapter timed out.'));},15000);
   this.pending={resolve:v=>{clearTimeout(timeout);resolve(v)},reject:e=>{clearTimeout(timeout);reject(e)}};
   this.child.stdin.write(JSON.stringify({...request,action:'exchange'})+'\n',error=>{if(error){this.pending?.reject(error);this.pending=undefined;}});
  });}finally{this.idle=setTimeout(()=>this.close(),30000);this.idle.unref();}
 }
 close(){
  clearTimeout(this.idle);this.pending?.reject(new Error('LabVIEW session closed.'));this.pending=undefined;
  const child=this.child;this.child=undefined;this.path=undefined;
  if(child){child.stdin.end(JSON.stringify({action:'close'})+'\n');const timer=setTimeout(()=>child.kill(),5000);timer.unref();child.once('exit',()=>clearTimeout(timer));}
 }
}
