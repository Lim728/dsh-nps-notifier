// Synthetic clocks, IPC and HTTP only. The network guard must be preloaded.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {EventEmitter} from 'node:events';
import {mountObserver} from '../runtime/observer.mjs';import {createBridge} from '../runtime/forward-bridge.mjs';import {createWorkerRuntime} from '../runtime/forwarder.mjs';
import {createForwarder,whitelist,LIMITS} from '../runtime/forward-core.mjs';import {createStateReader,projectState} from '../runtime/state-reader.mjs';
let count=0;const cases=[],cleanup=[];
const eq=(a,b,m)=>{assert.deepEqual(a,b,m);count++;},ok=(v,m)=>{assert.ok(v,m);count++;};
const run=async(name,fn)=>{await fn();cases.push(name);},flush=async()=>{for(let i=0;i<220;i++)await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
class Clock{
 t=100000;serial=0;jobs=new Map();now=()=>this.t;mono=()=>this.t-100000;
 schedule=(fn,ms)=>{const id=++this.serial;this.jobs.set(id,{fn,due:this.t+ms});return id;};unschedule=id=>this.jobs.delete(id);
 advance(ms){const end=this.t+ms;let steps=0;while(true){const next=[...this.jobs].filter(([,x])=>x.due<=end).sort((a,b)=>a[1].due-b[1].due||a[0]-b[0])[0];if(!next)break;if(++steps>3000)throw new Error('timer_loop');this.t=next[1].due;this.jobs.delete(next[0]);next[1].fn();}this.t=end;}
}
class Channel extends EventEmitter{connected=true;messages=[];send(m,cb){this.messages.push(m);cb?.();}disconnect(){this.connected=false;}kill(){this.killed=true;}}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-finished-resume-'));let serial=0;
const dir=()=>{const d=path.join(root,String(++serial));fs.mkdirSync(d);return d;};
function fixture({retentionMs=10000,send,read,source='startup',resumeEnabled=true}={}){
 const base=dir(),clock=new Clock(),handlers=new Map(),effects=[],children=[],registry=new Map(),sent=[],reads=[],messages=[],nps=new Map();let child,worker;
 const on=(name,fn)=>{if(!handlers.has(name))handlers.set(name,new Set());handlers.get(name).add(fn);return ()=>handlers.get(name).delete(fn);};
 const emit=(name,...args)=>{for(const fn of [...(handlers.get(name)??[])])fn(...args);};
 const ctx={agents:{get:id=>registry.get(id)},on,effect:fn=>effects.push(fn()),inject(_deps,fn){fn({...ctx,effect:f=>children.push(f())});return {dispose(){for(const f of children.splice(0).reverse())f?.();}};}};
 const a={session:{id:'synthetic'},status:'idle',inbox:{hasPending:false},wait:()=>Promise.resolve(),whenIdle(){return this.wait();}};registry.set(a.session.id,a);
 const stateFor=src=>{const s=nps.get(src);return s?{...s,retentionMs}:null;};
 const apply=p=>{if(p.heartbeat){return;}nps.set(p.source,{status:p.status,taskId:p.taskId??nps.get(p.source)?.taskId??null,eventTime:Date.parse(p.timestamp),terminalSince:['finished','error','closed'].includes(p.status)?clock.now():null,autoClosed:false});};
 const bridgeFactory=(b,_spawn,opts)=>createBridge(b,()=>{
  child=new Channel();const channel=new Channel();child.send=(m,cb)=>{messages.push(m);queueMicrotask(()=>{if(channel.connected)channel.emit('message',m);});cb?.();};channel.send=(m,cb)=>{queueMicrotask(()=>{if(child.connected)child.emit('message',m);});cb?.();};child.disconnect=()=>{child.connected=false;channel.connected=false;channel.emit('disconnect');};
  worker=createWorkerRuntime({channel,base:b,now:clock.now,mono:clock.mono,schedule:clock.schedule,unschedule:clock.unschedule,httpTransport:{send:async(p,o)=>{sent.push(p);if(send)return send(p,o,{apply,clock,nps});apply(p);return {ok:true};},stop(){}}});return child;
 },opts);
 let readerStopped=false;const mounted=mountObserver(ctx,{base,bridgeFactory,runningEnabled:true,resumeEnabled,heartbeatEnabled:false,clock:clock.mono,wall:clock.now,schedule:clock.schedule,unschedule:clock.unschedule,stateReaderFactory:()=>({read:async(src,opts)=>{reads.push({source:src,time:clock.now(),signal:opts.signal});return read?read(src,opts,{stateFor,clock,nps}):stateFor(src);},stop(){readerStopped=true;}})});cleanup.push(()=>mounted.stop());
 const event=(type,turn=1,seq=1,kind='completed')=>emit('session/event',a.session,{type,seq,time:clock.now(),data:{turn,reason:{kind}}});
 const start=async(turn=1,seq=1)=>{a.status='running';emit('agent/status',{agent:a,status:'running'});event('turn/start',turn,seq);await flush();};
 const finish=async(kind='completed',turn=1,seq=2)=>{event('turn/end',turn,seq,kind);a.status='idle';emit('agent/status',{agent:a,status:'idle'});await flush();};
 const init=async()=>{await flush();emit('agent/created',{agent:a,source});await flush();};
 const complete=async()=>{await init();await start();clock.advance(100);await finish();};
 return {base,clock,emit,registry,a,sent,reads,messages,nps,mounted,child:()=>child,worker:()=>worker,init,start,finish,complete,event,
  setRetention:ms=>retentionMs=ms,readerStopped:()=>readerStopped,unload:()=>{for(const f of [...children.splice(0),...effects.splice(0)].reverse())f?.();}};
}
const id='a'.repeat(64),instance='b'.repeat(16),source=`dsh:${instance}:${id.slice(0,32)}`;
const record=(type,seq=1,time=100000,reason=null,turn=1)=>({type,identity:id,turn,seq,time,reason});
const resume=(time=100000,epoch=3)=>({...record('session/resume',2,time),epoch});
const hb=(time=100000,epoch=3)=>({...record('session/heartbeat',2,time),epoch,pulse:1});
function policy(extra={}){const clock=new Clock(),sent=[];const core=createForwarder({instance,now:clock.now,mono:clock.mono,transport:async(p,o)=>{sent.push(p);return {ok:true};},authorizeRunning:async()=>true,wait:async()=>{},...extra});cleanup.push(()=>core.stop());return {clock,core,sent};}
const paired=async x=>{await x.core.accept(record('turn/start'));await x.core.accept(record('turn/end',2,100000,'completed'));};
try{
 await run('configured retention before, on and after boundary; running requires a post-write state confirmation',async()=>{
  for(const retention of [0,1234,10000,27000]){
   const x=fixture({retentionMs:retention});await x.complete();eq(x.sent.map(p=>p.status),['running','working','finished']);eq(x.reads.length,1);
   if(retention>0){x.clock.advance(retention-1);await flush();eq(x.sent.length,3);x.clock.advance(1);await flush();eq(x.sent.length,3);}
   x.clock.advance(1);await flush();eq(x.sent.map(p=>p.status),['running','working','finished','running']);eq(x.sent.at(-1).heartbeat,undefined);eq(x.sent.at(-1).source,x.sent[0].source);
   eq(x.mounted.running.snapshot().resumed,1);eq(x.reads.length,3);eq(x.mounted.running.snapshot().sessions[0].runningAcknowledged,true);
   x.clock.advance(15000);await flush();eq(x.sent.at(-1).heartbeat,true);eq(x.sent.at(-1).status,'running');eq(x.mounted.running.snapshot().idleHeartbeatsAcknowledged,1);
  }
 });
 await run('NPS retention changes are reread; terminal replacement or missing state fails closed',async()=>{
  const x=fixture({retentionMs:1000});await x.complete();x.setRetention(5000);x.clock.advance(1001);await flush();eq(x.sent.length,3);x.clock.advance(4000);await flush();eq(x.sent.length,4);
  for(const mode of ['missing','error','closed','wrong_task','wrong_event','changed_terminal','auto_closed','unavailable']){
   const y=fixture({read:(src,_opts,{stateFor})=>{const s=stateFor(src);if(y.reads.length===1)return s;if(mode==='missing'||mode==='unavailable')return null;if(mode==='error'||mode==='closed')return {...s,status:mode};if(mode==='wrong_task')return {...s,taskId:'turn-2'};if(mode==='wrong_event')return {...s,eventTime:s.eventTime-1};if(mode==='changed_terminal')return {...s,terminalSince:s.terminalSince+1};return {...s,autoClosed:true};}});
   await y.complete();y.clock.advance(10001);await flush();eq(y.sent.length,3,mode);eq(y.mounted.running.snapshot().resumed,0);y.clock.advance(60000);await flush();eq(y.sent.length,3,mode);
  }
 });
 await run('both successful acknowledgments and an observed paired completion are mandatory',async()=>{
  for(const mode of ['working_failed','finished_failed','orphan','error','aborted','blocked','max-tokens','wrong_turn']){
   const x=fixture({send:(p,_o,{apply})=>{if((mode==='working_failed'&&p.status==='working')||(mode==='finished_failed'&&p.status==='finished'))return {ok:false,retry:false};apply(p);return {ok:true};}});await x.init();
   if(mode!=='orphan')await x.start();x.clock.advance(100);
   await x.finish(['error','aborted','blocked','max-tokens'].includes(mode)?mode:'completed',mode==='wrong_turn'?2:1,2);x.clock.advance(60000);await flush();eq(x.sent.filter(p=>p.status==='running').length,1,mode);eq(x.reads.length,0,mode);eq(x.mounted.running.snapshot().resumed,0);
  }
 });
 await run('resumed startup cannot initially report running; a newly observed successful task is independent proof',async()=>{
  const x=fixture({source:'resume',retentionMs:0});await x.complete();eq(x.sent.map(p=>p.status),['working','finished']);x.clock.advance(1);await flush();eq(x.sent.at(-1).status,'running');eq(x.mounted.running.snapshot().resumed,1);
 });
 await run('new task at the retention boundary wins and old timers never overwrite it',async()=>{
  const x=fixture({retentionMs:1000});await x.complete();x.clock.advance(1000);await x.start(2,3);x.clock.advance(60000);await flush();eq(x.sent.map(p=>p.status),['running','working','finished','working']);eq(x.mounted.running.snapshot().resumed,0);
  await x.finish('completed',2,4);x.clock.advance(1001);await flush();eq(x.sent.at(-1).status,'running');eq(x.mounted.running.snapshot().resumed,1);
 });
 await run('cancel pending reads, maintenance checks, release, replacement, unload and disconnect',async()=>{
  for(const mode of ['start','release','replace','unload','disconnect','queue','approval']){
   const d=deferred();let captured;
   const x=fixture({retentionMs:1000,read:(src,opts,{stateFor})=>{if(x.reads.length===2){captured=opts.signal;return d.promise;}return stateFor(src);}});await x.complete();x.clock.advance(1001);await flush();ok(!!captured);
   if(mode==='start')await x.start(2,3);if(mode==='release')x.emit('agent/disposed',{agent:x.a});if(mode==='replace')x.registry.set(x.a.session.id,{...x.a});if(mode==='unload')x.unload();if(mode==='disconnect')x.child().emit('disconnect');
   if(mode==='queue'){x.a.inbox.hasPending=true;x.emit('agent/inbox/inserted',{agent:x.a});}if(mode==='approval')x.emit('session/event',x.a.session,{type:'approval/asked',data:{id:'synthetic-approval'}});
   if(mode!=='replace')eq(captured.aborted,true,mode);d.resolve(x.nps.get(x.sent[0].source));await flush();eq(x.sent.filter(p=>p.status==='running').length,1,mode);eq(x.mounted.running?.snapshot().resumed??0,0);
   if(mode==='unload'||mode==='disconnect')eq(x.readerStopped(),true);
  }
  const x=fixture({retentionMs:1000});await x.complete();const d=deferred();x.a.wait=()=>d.promise;x.clock.advance(1001);await flush();await x.start(2,3);d.resolve();await flush();eq(x.sent.at(-1).status,'working');eq(x.mounted.running.snapshot().resumed,0);
 });
 await run('no pending approval or inbox input; short interruption can only recheck the same completion',async()=>{
  for(const mode of ['approval','queue']){
   const x=fixture({retentionMs:1000});await x.complete();x.clock.advance(500);
   if(mode==='queue'){x.a.inbox.hasPending=true;x.emit('agent/inbox/inserted',{agent:x.a});}else x.emit('session/event',x.a.session,{type:'approval/asked',data:{id:'synthetic'}});
   x.clock.advance(5000);await flush();eq(x.sent.length,3);
   if(mode==='queue'){x.a.inbox.hasPending=false;x.emit('agent/inbox/discarded',{agent:x.a});}else x.emit('session/event',x.a.session,{type:'approval/decided',data:{id:'synthetic'}});
   await flush();eq(x.sent.length,4);eq(x.mounted.running.snapshot().resumed,1);
  }
 });
 await run('post-write readback is required; stale or failed ack cannot start heartbeats',async()=>{
  for(const mode of ['missing','finished','closed','wrong_time','late','new_turn']){
   const d=deferred();const x=fixture({retentionMs:0,read:(src,_o,{stateFor})=>{const s=stateFor(src);if(x.reads.length!==3)return s;if(mode==='late'||mode==='new_turn')return d.promise;if(mode==='missing')return null;if(mode==='wrong_time')return {...s,eventTime:s.eventTime-1};return {...s,status:mode};}});
   await x.complete();x.clock.advance(1);await flush();eq(x.sent.length,4);
   if(mode==='late')x.clock.advance(2001);if(mode==='new_turn')await x.start(2,3);
   if(mode==='late'||mode==='new_turn'){d.resolve(x.nps.get(x.sent[0].source));await flush();}
   x.clock.advance(60000);await flush();eq(x.sent.filter(p=>p.heartbeat).length,0,mode);eq(x.mounted.running.snapshot().resumed,0);
  }
 });
 await run('completion eligibility does not erase older task fences or permit errors and closed to resume',async()=>{
  for(const mode of ['no_start','no_end','unacked','error','aborted','new_start','wrong_seq','wrong_turn']){
   const x=policy({transport:async p=>({ok:!(mode==='unacked'&&p.status==='finished'),retry:false})});
   if(mode!=='no_start')await x.core.accept(record('turn/start'));
   if(mode!=='no_end')await x.core.accept(record('turn/end',2,100000,['error','aborted'].includes(mode)?mode:'completed'));
   if(mode==='new_start')x.core.observeStart(record('turn/start',3,100000,null,2));let r=resume();if(mode==='wrong_seq')r.seq=3;if(mode==='wrong_turn')r.turn=2;
   ok((await x.core.accept(r)).outcome!=='acknowledged',mode);
  }
  const x=policy();await paired(x);eq((await x.core.accept(resume())).outcome,'acknowledged');eq((await x.core.accept(hb())).outcome,'acknowledged');eq(x.sent.at(-1).heartbeat,true);
  eq((await x.core.accept({...resume(),epoch:4})).outcome,'ineligible');x.core.observeStart(record('turn/start',3,100000,null,2));eq((await x.core.accept({...hb(),pulse:2})).outcome,'superseded');
 });
 await run('resume retries are finite and reauthorize; new start, revocation or expiration abort them',async()=>{
  for(const mode of ['success','exhaust','start','revoke','expire','deny']){
   let calls=0,auth=0,core;const clock=new Clock();
   core=createForwarder({instance,now:clock.now,mono:clock.mono,authorizeRunning:async()=>{auth++;return mode!=='deny'||auth===1;},transport:async p=>{if(p.status!=='running')return {ok:true};calls++;return {ok:mode==='success'&&calls===2,retry:true};},wait:async()=>{if(mode==='start')core.observeStart(record('turn/start',3,clock.now(),null,2));if(mode==='revoke')core.revokeRunning(id);if(mode==='expire')clock.advance(2001);}});cleanup.push(()=>core.stop());
   await core.accept(record('turn/start'));await core.accept(record('turn/end',2,100000,'completed'));const out=await core.accept(resume());eq(calls,['success','exhaust'].includes(mode)?2:1);ok(auth<=2);eq(out.outcome,mode==='success'?'acknowledged':mode==='exhaust'?'delivery_failed':mode==='start'?'superseded':mode==='expire'?'expired':'revoked');
  }
 });
 await run('inflight resume aborts before next working; late terminal and old resume ack never rearm',async()=>{
  const d=deferred();let signal;const x=fixture({retentionMs:0,send:(p,o,{apply})=>{if(p.status==='running'&&p.taskId){signal=o.signal;return d.promise;}apply(p);return {ok:true};}});await x.complete();x.clock.advance(1);await flush();ok(signal&&!signal.aborted);await x.start(2,3);eq(signal.aborted,true);d.resolve({ok:true});await flush();eq(x.sent.at(-1).status,'working');eq(x.mounted.running.snapshot().resumed,0);eq(x.sent.filter(p=>p.heartbeat).length,0);
  const y=fixture({retentionMs:0});await y.complete();y.clock.advance(1);await flush();eq(y.mounted.running.snapshot().resumed,1);y.event('turn/end',1,2);await flush();y.clock.advance(15000);await flush();eq(y.sent.at(-1).heartbeat,true);eq(y.mounted.running.snapshot().resumed,1);
 });
 await run('two successful cycles, late previous completion and failure followed by a new successful task stay isolated',async()=>{
  const x=fixture({retentionMs:0});await x.complete();x.clock.advance(1);await flush();eq(x.mounted.running.snapshot().resumed,1);
  await x.start(2,3);x.event('turn/end',1,2);await flush();eq(x.sent.at(-1).status,'working');
  x.clock.advance(100);await x.finish('completed',2,4);x.clock.advance(1);await flush();eq(x.mounted.running.snapshot().resumed,2);
  x.event('turn/end',1,2);x.clock.advance(15000);await flush();eq(x.sent.at(-1).status,'running');eq(x.sent.at(-1).heartbeat,true);eq(x.sent.at(-1).source,x.sent[0].source);
  const y=fixture({retentionMs:0});await y.init();await y.start();await y.finish('error');y.clock.advance(20000);await flush();eq(y.sent.at(-1).status,'error');eq(y.mounted.running.snapshot().resumed,0);
  await y.start(2,3);await y.finish('completed',2,4);y.clock.advance(1);await flush();eq(y.sent.at(-1).status,'running');eq(y.mounted.running.snapshot().resumed,1);
 });
 await run('strict whitelist and state projection ignore private fields and reject ambiguous identity',async()=>{
  ok(whitelist(resume()));for(const mutation of [{turn:0},{seq:0},{epoch:0},{reason:'completed'},{pulse:1},{body:'synthetic'},{path:'synthetic'}])eq(whitelist({...resume(),...mutation}),null);
  const s={source,taskId:'turn-1',status:'finished',eventTime:new Date(100000).toISOString(),terminalSinceUtc:new Date(100010).toISOString(),autoClosed:false};const doc={ok:true,finishedWidgetRetentionSec:7,sessions:[s]};
  for(const key of ['message','title','project','path','body'])Object.defineProperty(s,key,{get(){throw new Error('private_field_access');}});
  eq(projectState(doc,source),{status:'finished',taskId:'turn-1',eventTime:100000,terminalSince:100010,autoClosed:false,retentionMs:7000});
  for(const d of [{...doc,sessions:[s,s]},{...doc,sessions:[]},{...doc,finishedWidgetRetentionSec:-1},{...doc,finishedWidgetRetentionSec:'7'},{...doc,finishedWidgetRetentionSec:3601}])eq(projectState(d,source),null);
 });
 await run('state GET uses 500ms, at most one retry, response cap and cancellation without text persistence',async()=>{
  const clock=new Clock(),requests=[];
  const reader=createStateReader({schedule:clock.schedule,unschedule:clock.unschedule,request:(opts,cb)=>{eq(opts.method,'GET');eq(opts.path,'/state');const req=new EventEmitter();req.end=()=>{};req.destroy=()=>{req.destroyed=true;};requests.push({req,cb});return req;}});cleanup.push(()=>reader.stop());
  const reply=(index,code,text)=>{const res=new EventEmitter();res.statusCode=code;res.setEncoding=()=>{};res.destroy=()=>{};requests[index].cb(res);res.emit('data',text);res.emit('end');};
  let p=reader.read(source);clock.advance(499);eq(requests.length,1);clock.advance(1);await flush();clock.advance(100);await flush();eq(requests.length,2);clock.advance(500);eq(await p,null);eq(requests.every(x=>x.req.destroyed),true);
  p=reader.read(source);reply(2,200,'x'.repeat(1048577));eq(await p,null);eq(requests.length,3);
  const ctrl=new AbortController();p=reader.read(source,{signal:ctrl.signal});ctrl.abort();eq(await p,null);eq(requests[3].req.destroyed,true);
  p=reader.read(source);reply(4,200,JSON.stringify({ok:true,finishedWidgetRetentionSec:2,sessions:[{source,status:'finished',taskId:'turn-1',eventTime:new Date(100000).toISOString(),terminalSinceUtc:new Date(100000).toISOString(),autoClosed:false,message:'synthetic-private'}]}));const out=await p;eq(out.retentionMs,2000);ok(!JSON.stringify(out).includes('synthetic-private'));
  const pending=[];for(let i=0;i<8;i++)pending.push(reader.read(source));eq(await reader.read(source),null);reader.stop();eq(await Promise.all(pending),Array(8).fill(null));eq(clock.jobs.size,0);eq(await reader.read(source),null);
 });
 await run('retention may cross diagnostic windows; unload cancels timers and snapshots are read-only',async()=>{
  const x=fixture({retentionMs:600000});await x.complete();eq(x.reads.length,1);const before=fs.readFileSync(path.join(x.base,'running-status.json'),'utf8');for(let i=0;i<10;i++)x.mounted.running.snapshot();eq(x.reads.length,1);eq(fs.readFileSync(path.join(x.base,'running-status.json'),'utf8'),before);
  x.clock.advance(600001);await flush();eq(x.mounted.bridge.isReady(),true);eq(x.sent.filter(p=>p.status==='running'&&!p.heartbeat).length,2);x.unload();await flush();const after=x.sent.length;eq(x.clock.jobs.size,0);x.clock.advance(600000);await flush();eq(x.sent.length,after);
  const y=fixture();await y.complete();y.unload();await flush();eq(y.clock.jobs.size,0);y.clock.advance(60000);await flush();eq(y.sent.length,3);
 });
 console.log(JSON.stringify({suite:'finished-resume',passed:count,failed:0,skipped:0,cases,realNotifyRequests:0,realStateRequests:0,realChildProcesses:0},null,2));
}finally{
 for(const fn of cleanup.reverse())try{fn();}catch{}
 const resolved=fs.realpathSync(root),parent=fs.realpathSync(os.tmpdir());if(path.dirname(resolved).toLowerCase()!==parent.toLowerCase()||!path.basename(resolved).startsWith('dsh-finished-resume-'))throw new Error('cleanup_boundary');fs.rmSync(resolved,{recursive:true,force:true});
}
