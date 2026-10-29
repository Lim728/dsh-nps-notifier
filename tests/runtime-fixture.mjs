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
export const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-finished-resume-'));let serial=0;
const dir=()=>{const d=path.join(root,String(++serial));fs.mkdirSync(d);return d;};
export function fixture({retentionMs=10000,send,read,source='startup',resumeEnabled=true,heartbeatEnabled=false,recorderOptions={}}={}){
 const base=dir(),clock=new Clock(),handlers=new Map(),effects=[],children=[],registry=new Map(),sent=[],reads=[],messages=[],nps=new Map();let child,worker;
 const on=(name,fn)=>{if(!handlers.has(name))handlers.set(name,new Set());handlers.get(name).add(fn);return ()=>handlers.get(name).delete(fn);};
 const emit=(name,...args)=>{for(const fn of [...(handlers.get(name)??[])])fn(...args);};
 const authority=Symbol('test approval');const approval={pendingState:()=>({pending:0,revision:0,authority})};
 const ctx={get:name=>name==='approval'?approval:undefined,agents:{get:id=>registry.get(id)},on,effect:fn=>effects.push(fn()),inject(_deps,fn){fn({...ctx,effect:f=>children.push(f())});return {dispose(){for(const f of children.splice(0).reverse())f?.();}};}};
 const a={session:{id:'synthetic'},status:'idle',inbox:{hasPending:false},wait:()=>Promise.resolve(),whenIdle(){return this.wait();}};registry.set(a.session.id,a);
 const stateFor=src=>{const s=nps.get(src);return s?{...s,retentionMs}:null;};
 const apply=p=>{if(p.heartbeat){return;}nps.set(p.source,{status:p.status,taskId:p.taskId??nps.get(p.source)?.taskId??null,eventTime:Date.parse(p.timestamp),terminalSince:['finished','error','closed'].includes(p.status)?clock.now():null,autoClosed:false});};
 const bridgeFactory=(b,_spawn,opts)=>createBridge(b,()=>{
  child=new Channel();const channel=new Channel();child.send=(m,cb)=>{messages.push(m);queueMicrotask(()=>{if(channel.connected)channel.emit('message',m);});cb?.();};channel.send=(m,cb)=>{queueMicrotask(()=>{if(child.connected)child.emit('message',m);});cb?.();};child.disconnect=()=>{child.connected=false;channel.connected=false;channel.emit('disconnect');};
  worker=createWorkerRuntime({channel,base:b,recorderOptions,now:clock.now,mono:clock.mono,schedule:clock.schedule,unschedule:clock.unschedule,httpTransport:{send:async(p,o)=>{sent.push(p);if(send)return send(p,o,{apply,clock,nps});apply(p);return {ok:true};},stop(){}}});return child;
 },opts);
 let readerStopped=false;const mounted=mountObserver(ctx,{base,bridgeFactory,runningEnabled:true,resumeEnabled,heartbeatEnabled,recorderOptions,clock:clock.mono,wall:clock.now,schedule:clock.schedule,unschedule:clock.unschedule,stateReaderFactory:()=>({read:async(src,opts)=>{reads.push({source:src,time:clock.now(),signal:opts.signal});return read?read(src,opts,{stateFor,clock,nps}):stateFor(src);},stop(){readerStopped=true;}})});cleanup.push(()=>mounted.stop());
 const event=(type,turn=1,seq=1,kind='completed')=>emit('session/event',a.session,{type,seq,time:clock.now(),data:{turn,reason:{kind}}});
 const start=async(turn=1,seq=1)=>{a.status='running';emit('agent/status',{agent:a,status:'running'});event('turn/start',turn,seq);await flush();};
 const finish=async(kind='completed',turn=1,seq=2)=>{event('turn/end',turn,seq,kind);a.status='idle';emit('agent/status',{agent:a,status:'idle'});await flush();};
 const init=async()=>{await flush();emit('agent/created',{agent:a,source});await flush();};
 const complete=async()=>{await init();await start();clock.advance(100);await finish();};
 return {base,clock,emit,registry,approval,a,sent,reads,messages,nps,mounted,child:()=>child,worker:()=>worker,init,start,finish,complete,event,
  setRetention:ms=>retentionMs=ms,readerStopped:()=>readerStopped,unload:()=>{for(const f of [...children.splice(0),...effects.splice(0)].reverse())f?.();}};
}

export {Clock,flush};
export function disposeFixtures(){for(const f of cleanup.splice(0).reverse())f();const resolved=fs.realpathSync(root),parent=fs.realpathSync(os.tmpdir());if(path.dirname(resolved).toLowerCase()!==parent.toLowerCase()||!path.basename(resolved).startsWith('dsh-finished-resume-'))throw new Error('cleanup_boundary');fs.rmSync(resolved,{recursive:true,force:true});}
