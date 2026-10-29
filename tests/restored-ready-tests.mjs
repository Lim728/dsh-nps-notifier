// Synthetic events, IPC and HTTP only; preloaded guard forbids real network.
import assert from 'node:assert/strict';
import {fixture,flush,disposeFixtures} from './runtime-fixture.mjs';
import {createForwarder} from '../runtime/forward-core.mjs';
import fs from 'node:fs';import path from 'node:path';
let passed=0;const eq=(a,b)=>{assert.deepEqual(a,b);passed++;};
const open=x=>{const c=new AbortController();x.emit('api-session/interaction',{agent:x.a,signal:c.signal});return c;};
try{
 {
  const x=fixture({source:'resume'});await flush();eq(x.sent.length,0);
  open(x);await flush();eq(x.sent.map(p=>p.status),['running']);
  eq(JSON.parse(fs.readFileSync(path.join(x.base,'running-status.json'))).sessions[0].fresh,false);x.unload();
 }
 for(const source of ['resume','clear','compact','unknown']){
  const x=fixture({source});await x.init();eq(x.sent.length,0);open(x);await flush();
  eq(x.sent.length,source==='resume'?1:0);x.unload();
 }
 {
  const x=fixture({source:'resume'});await x.init();const page=open(x);await flush();
  eq(x.sent.map(p=>p.status),['running']);eq(x.sent[0].taskId,undefined);
  const source=x.sent[0].source;
  eq(JSON.parse(fs.readFileSync(path.join(x.base,'running-status.json'))).sessions[0].fresh,false);
  x.clock.advance(15000);await flush();eq(x.sent.filter(p=>p.heartbeat).length,1);
  page.abort();await flush();const count=x.sent.length;x.clock.advance(30000);await flush();eq(x.sent.length,count);
  // Explicit reopen can grant a new epoch; no implicit reconnect or closed.
  open(x);await flush();eq(x.sent.at(-1).status,'running');eq(x.sent.length,count+1);
  await x.start();const afterStart=x.sent.length;x.clock.advance(15000);await flush();
  eq(x.sent.length,afterStart);eq(x.sent.at(-1).status,'working');
  eq(x.sent.at(-1).source,source);
  await x.finish('error');open(x);await flush();eq(x.sent.at(-1).status,'error');x.unload();
 }
 for(const cause of ['abort','task','queue','approval','replace','unload','disconnect']){
  const x=fixture({source:'resume'});await x.init();let idle;x.a.wait=()=>new Promise(r=>{idle=r;});
  const page=open(x);await flush();eq(x.sent.length,0);
  if(cause==='abort')page.abort();
  if(cause==='task')await x.start();
  if(cause==='queue'){x.a.inbox.hasPending=true;x.emit('agent/inbox/inserted',{agent:x.a});}
  if(cause==='approval'){x.approval.pendingState=()=>({pending:0,revision:2});x.emit('approval/pending-changed',{agent:x.a,pending:0,revision:2});}
  if(cause==='replace')x.registry.set(x.a.session.id,{...x.a});
  if(cause==='unload')x.unload();
  if(cause==='disconnect')x.child().emit('disconnect');
  idle?.();await flush();eq(x.sent.filter(p=>p.status==='running').length,0);x.unload();
 }
 {
  const x=fixture({source:'resume'});await x.init();let calls=0;
  x.a.wait=()=>++calls===1?new Promise(()=>{}):Promise.resolve();
  const first=open(x);await flush();first.abort();open(x);await flush();
  eq(x.sent.map(p=>p.status),['running']);x.unload();
 }
 for(const state of [undefined,{pending:1,revision:1},{pending:-1,revision:0}]){
  const x=fixture({source:'resume'});await x.init();x.approval.pendingState=()=>state;open(x);await flush();eq(x.sent.length,0);x.unload();
 }
 {
  const x=fixture({source:'resume',send:()=>({ok:false,retry:false})});await x.init();open(x);await flush();
  x.clock.advance(15000);await flush();eq(x.sent.filter(p=>p.heartbeat).length,0);x.unload();
 }
 for(const mode of ['busy','queued','approval-owner-changed','approval-service-lost']){
  const x=fixture({source:'resume'});await x.init();
  if(mode==='busy')x.a.status='running';
  if(mode==='queued')x.a.inbox.hasPending=true;
  if(mode==='busy'||mode==='queued'){
    open(x);await flush();x.a.status='idle';x.a.inbox.hasPending=false;x.emit('agent/status',{agent:x.a,status:'idle'});await flush();eq(x.sent.length,0);
  }else{
    open(x);await flush();const count=x.sent.length;
    x.approval.pendingState=()=>mode==='approval-service-lost'?undefined:{pending:0,revision:0,authority:Symbol('replacement')};
    x.clock.advance(15000);await flush();eq(x.sent.length,count);
  }
  x.unload();
 }
 {
  let ack;const x=fixture({source:'resume',send:()=>new Promise(r=>{ack=r;})});await x.init();open(x);await flush();
  x.clock.advance(15000);await flush();eq(x.sent.filter(p=>p.heartbeat).length,0);
  ack({ok:true});await flush();x.clock.advance(15000);await flush();eq(x.sent.filter(p=>p.heartbeat).length,0);x.unload();
 }
 for(const invalidation of ['close','task','expiry']){
  let time=100000,calls=0;const identity='e'.repeat(64);
  const record={type:'session/restored-ready',identity,turn:0,seq:0,time,reason:null,epoch:1};
  const core=createForwarder({instance:'a'.repeat(16),now:()=>time,mono:()=>time,authorizeRunning:async()=>true,
    transport:async()=>{calls++;return {ok:false,retry:true};},wait:async()=>{
      if(invalidation==='close')core.pauseRunning(identity,1);
      if(invalidation==='task')core.observeStart({type:'turn/start',identity,turn:1,seq:1,time,reason:null});
      if(invalidation==='expiry')time+=2001;
    }});
  const result=await core.accept(record);eq(calls,1);eq(result.outcome,{close:'revoked',task:'superseded',expiry:'expired'}[invalidation]);core.stop();
 }
 for(const reason of ['completed','aborted','error']){
  const x=fixture({source:'resume'});await x.init();open(x);await flush();await x.start();await x.finish(reason);
  const count=x.sent.length;open(x);await flush();eq(x.sent.length,count);eq(x.sent.at(-1).status,{completed:'finished',aborted:'closed',error:'error'}[reason]);x.unload();
 }
 {
  const x=fixture({source:'resume'});await x.init();const first=open(x),second=open(x);await flush();first.abort();
  x.clock.advance(15000);await flush();eq(x.sent.filter(p=>p.heartbeat).length,1);
  second.abort();const count=x.sent.length;x.clock.advance(15000);await flush();eq(x.sent.length,count);x.unload();
 }
 console.log(JSON.stringify({suite:'restored-ready',passed,failed:0,skipped:0,realNotifyRequests:0}));
}finally{disposeFixtures();}
