import {existsSync, readdirSync} from 'node:fs';
import {dirname, join, isAbsolute, delimiter} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const names={sdcc:'sdcc',ghdl:'ghdl',yosys:'yosys',nextpnr:'nextpnr-ice40',icepack:'icepack'};
const variables={sdcc:'MICROSIM_SDCC',ghdl:'MICROSIM_GHDL',yosys:'MICROSIM_YOSYS',nextpnr:'MICROSIM_NEXTPNR',icepack:'MICROSIM_ICEPACK'};
export function resolveTool(tool, env=process.env) {
 if(!(tool in names))throw new Error('Unsupported tool.');
 if(env[variables[tool]])return env[variables[tool]];
 const file=names[tool]+(process.platform==='win32'?'.exe':'');
 const dirs=(env.PATH??env.Path??'').split(delimiter);
 if(process.platform==='win32'){
  if(env.LOCALAPPDATA)dirs.push(join(env.LOCALAPPDATA,'Microsoft','WinGet','Links'));
  if(tool==='sdcc')dirs.push(join(env.ProgramFiles??'C:/Program Files','SDCC','bin'));
  if(tool==='ghdl'&&env.LOCALAPPDATA){
   const root=join(env.LOCALAPPDATA,'Microsoft','WinGet','Packages');
   try{for(const n of readdirSync(root))if(n.startsWith('ghdl.'))dirs.push(join(root,n,'bin'));}catch{}
  }
 }
 for(const dir of dirs)if(dir&&existsSync(join(dir,file)))return join(dir,file);
 if(['yosys','nextpnr','icepack'].includes(tool)&&process.platform==='win32'&&env.LOCALAPPDATA){
  const fallback=join(env.LOCALAPPDATA,'MicrosimTools','fpga','Scripts',`yowasp-${names[tool]}.exe`);
  if(existsSync(fallback))return fallback;
 }
 return names[tool];
}
export async function runTool(tool,args,cwd) {
 const executable=resolveTool(tool);
 // SDCC's preprocessor launches cc1 by name; custom installations need their bin on PATH.
 const env={...process.env};
 if(isAbsolute(executable))env.PATH=dirname(executable)+delimiter+(env.PATH??env.Path??'');
 try{return await exec(executable,args,{cwd,env,timeout:120000,maxBuffer:4*1024*1024,windowsHide:true});}
 catch(e){const error=new Error(`${tool}: ${e.code==='ENOENT'?'not installed or not on PATH':[e.stdout,e.stderr,e.message].filter(Boolean).join('\n')}`);Object.assign(error,{code:e.code,stdout:e.stdout,stderr:e.stderr});throw error;}
}
export async function toolStatus(){
 return Object.fromEntries(await Promise.all(Object.keys(names).map(async tool=>{
  const path=resolveTool(tool);
  try{const r=await runTool(tool,tool==='yosys'?['-V']:tool==='icepack'?['-h']:['--version']);return [tool,{path,available:true,version:(r.stdout+r.stderr).trim().slice(0,1000)}];}
  catch(e){if(tool==='icepack'&&e.code===1&&/Usage:.*(?:yowasp-)?icepack/i.test(e.stderr??''))return [tool,{path,available:true,version:'icepack (help command verified; no version option)'}];return [tool,{path,available:false,error:e.message.slice(0,1000)}];}
 })));
}
