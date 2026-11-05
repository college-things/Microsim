import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LabviewSession} from './labview-session.mjs';
test('VI protocol keeps its process between frames, validates output and releases it', {skip:process.platform!=='win32'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'microsim-vi-test-')),path=join(dir,'fixture.vi');await writeFile(path,'adapter fixture, not a VI');
 let launches=0,steps=0,ended=false;
 const session=new LabviewSession((executable,args,options)=>{
  launches++;assert.match(executable,/SysWOW64/);assert.equal(options.windowsHide,true);assert.ok(args.includes('-File'));
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>child.emit('exit',0);
  child.stdin.on('data',data=>{const request=JSON.parse(data.toString());if(request.action==='close'){ended=true;child.emit('exit',0);}else{steps++;setImmediate(()=>child.stdout.write(JSON.stringify({signals:{drive:request.frame.signals.input+steps}})+'\n'));}});
  return child;
 });
 try{
  const request={path,bits:32,outputs:['drive'],frame:{time:0,signals:{input:2}}};
  assert.deepEqual(await session.exchange(request),{signals:{drive:3}});
  assert.deepEqual(await session.exchange(request),{signals:{drive:4}});assert.equal(launches,1);
  await assert.rejects(session.exchange({...request,frame:{time:NaN,signals:{}}}),/finite/);
  const pending=session.exchange(request);await assert.rejects(session.exchange(request),/already running/);await pending;
  session.close();assert.equal(ended,true);
 }finally{session.close();await rm(dir,{recursive:true,force:true});}
});
test('VI requests reject paths and names before launching a process',async()=>{
 const session=new LabviewSession(()=>{throw new Error('should not launch')});
 await assert.rejects(session.exchange({path:'relative.vi'}),/absolute/);
 await assert.rejects(session.exchange({path:join(tmpdir(),'x.vi'),bits:7}),/bitness/);
});
