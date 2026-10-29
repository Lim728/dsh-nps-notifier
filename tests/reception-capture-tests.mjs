import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {createReceptionCapture} from '../runtime/reception-capture.mjs';
import {createObserver} from '../runtime/observer.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-reception-tests-'));
let passed=0,serial=0;
const check=(value)=>{assert.ok(value);passed++;};
const eq=(a,b)=>{assert.deepEqual(a,b);passed++;};
const secret='must-not-be-read-or-persisted';
const identity='a'.repeat(64),instance='b'.repeat(16);
function setup(io=fs){
  const base=path.join(root,String(++serial));fs.mkdirSync(base);
  const id=serial.toString(16).padStart(16,'0');
  fs.writeFileSync(path.join(base,'reception-request.json'),JSON.stringify({id,expires:600001}));
  const ctx=new Context(),session={id:'synthetic'},agent={session,status:'idle',inbox:{hasPending:false}};
  let time=1,idle=true;
  const timers=new Map();let timerId=0;
  const opts={base,io,identityFor:()=>identity,getAgent:()=>agent,getInstance:()=>instance,getControl:()=>({sessions:[{identity,runningAcknowledged:idle,epoch:1,terminalLocked:false,pending:0}]}),now:()=>time,mono:()=>time,schedule:fn=>{timers.set(++timerId,fn);return timerId;},unschedule:id=>timers.delete(id)};
  const capture=createReceptionCapture(ctx,opts),dir=path.join(base,'reception-'+id);
  return {ctx,base,dir,opts,session,agent,capture,timers,setTime:t=>time=t,setIdle:v=>idle=v,
    rows:()=>fs.readFileSync(path.join(dir,'records.jsonl'),'utf8').trim().split('\n').map(JSON.parse)};
}
const event=(seq=1)=>({type:'turn/start',time:1,seq,data:{turn:1,get content(){throw new Error(secret);}},get body(){throw new Error(secret);}});
try{
  const f=setup();
  f.ctx.on('session/event',(s,e)=>f.capture.mark('subscriber',s,e));
  f.ctx.emit('session/event',f.session,event());
  eq(f.rows().map(r=>r.stage),['mounted','published','global_subscriber','subscriber']);
  const row=f.rows().at(-1);eq(row.source,`dsh:${instance}:${identity.slice(0,32)}`);eq(row.sameSession,true);eq(row.idleAcknowledged,true);
  check(!fs.readFileSync(path.join(f.dir,'records.jsonl'),'utf8').includes(secret));
  // Cordis filtering excludes the ordinary callback; the independent taps still see publication.
  f.ctx.emit({[Context.filter]:()=>false},'session/event',f.session,event(2));
  eq(f.rows().slice(-2).map(r=>r.stage),['published','global_subscriber']);
  eq(createReceptionCapture(f.ctx,f.opts),null); // A remount never overwrites evidence.
  f.capture.stop();const n=f.rows().length;f.ctx.emit('session/event',f.session,event(3));eq(f.rows().length,n);eq(f.timers.size,0);

  const timed=setup();timed.setTime(600001);timed.capture.mark('subscriber',timed.session,event());eq(timed.capture.snapshot().reason,'time_limit');eq(timed.timers.size,0);
  const capped=setup();for(let i=0;i<1100;i++)capped.capture.mark('subscriber',capped.session,event(i));eq(capped.capture.snapshot().rows,1000);eq(capped.capture.snapshot().reason,'capacity_limit');check(capped.capture.snapshot().bytes<=1048576);eq(capped.timers.size,0);
  const failing=setup({...fs,appendFileSync(){throw new Error(secret);}});eq(failing.capture.snapshot().reason,'write_or_projection_failed');check(failing.capture.snapshot().writeFailures>0);eq(failing.timers.size,0);

  const g=setup();let live=false;const forwarded=[];
  const observer=createObserver(g.base,()=>1,()=>1,{isLive:()=>live,trace:g.capture.mark,record:r=>forwarded.push(r)});
  observer.handle(g.session,event());eq(forwarded.length,0);eq(g.rows().at(-1).reason,'not_live');
  live=true;observer.handle(g.session,event());eq(forwarded.length,1);eq(g.rows().at(-1).stage,'accepted');
  observer.handle(g.session,event());eq(forwarded.length,1);eq(g.rows().at(-1).reason,'identity_or_order');
  observer.handle(g.session,{type:'turn/end',seq:2,time:1,data:{turn:2,reason:{kind:'completed'}}});eq(g.rows().at(-1).reason,'unpaired_end');
  observer.handle(g.session,{type:'turn/start',seq:-1,time:1,data:{turn:2}});eq(g.rows().at(-1).reason,'invalid_fields');
  // Capture failure does not veto valid forwarding or alter deduplication.
  const h=setup();let accepted=0;
  const safe=createObserver(h.base,()=>1,()=>1,{isLive:()=>true,trace(){throw new Error(secret);},record(){accepted++;}});
  safe.handle(h.session,event());eq(accepted,1);safe.handle(h.session,event());eq(accepted,1);
  observer.stop();safe.stop();g.capture.stop();h.capture.stop();
  console.log(JSON.stringify({passed,failed:0,skipped:0}));
}finally{
  // Only this test's unique temporary directory is removed.
  fs.rmSync(root,{recursive:true,force:true});
}
