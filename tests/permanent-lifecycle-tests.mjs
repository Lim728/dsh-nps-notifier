import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,Clock,flush,root,disposeFixtures} from './runtime-fixture.mjs';
import {createRecorder} from '../runtime/recorder.mjs';
import {createForwarder} from '../runtime/forward-core.mjs';
let passed=0;const cases=[];
const eq=(a,b)=>{assert.deepEqual(a,b);passed++;};
const ok=x=>{assert.ok(x);passed++;};
const run=async(name,f)=>{await f();cases.push(name);};
try {
  await run('idle heartbeats survive four recording windows without source or dedup reset',async()=>{
    const x=fixture();await x.init();
    for(let i=0;i<160;i++){x.clock.advance(15000);await flush();}
    eq(x.mounted.bridge.isReady(),true);eq(x.sent.length,161);
    eq(new Set(x.sent.map(p=>p.source)).size,1);eq(x.sent.filter(p=>!p.heartbeat).length,1);
    eq(new Set(x.messages.filter(m=>m.kind==='event').map(m=>m.id)).size,161);
    const ring=JSON.parse(fs.readFileSync(path.join(x.base,'delivery-ring.json')));
    ok(ring.rotations>=4);ok(ring.rows<=1000);
    eq(fs.readdirSync(x.base).filter(n=>/^delivery-\d.jsonl$/.test(n)).length,3);
    for(const file of fs.readdirSync(x.base).filter(n=>/^delivery-\d.jsonl$/.test(n)))ok(fs.statSync(path.join(x.base,file)).size<=1048576);
    x.unload();await flush();const size=x.sent.length;x.clock.advance(3600000);await flush();eq(x.sent.length,size);eq(x.clock.jobs.size,0);
  });
  await run('working heartbeat retains the same active turn across recording windows and cancels before finish',async()=>{
    const x=fixture({heartbeatEnabled:true});await x.init();await x.start();
    const signal=new AbortController();x.emit('agent/pre-step',{agent:x.a,turn:1,signal:signal.signal},()=>{});
    for(let i=0;i<125;i++){x.clock.advance(15000);await flush();}
    eq(x.sent.filter(p=>p.status==='working'&&p.heartbeat).length,125);eq(x.mounted.bridge.isReady(),true);
    const source=x.sent[0].source;eq(x.sent.every(p=>p.source===source),true);
    await x.finish();const workingCount=x.sent.filter(p=>p.status==='working').length;
    x.clock.advance(10001);await flush();eq(x.mounted.running.snapshot().resumed,1);
    x.clock.advance(15000);await flush();eq(x.sent.at(-1).status,'running');eq(x.sent.at(-1).heartbeat,true);
    eq(x.sent.filter(p=>p.status==='working').length,workingCount);
    await x.start(2,3);const before=x.sent.filter(p=>p.status==='running').length;
    x.clock.advance(30000);await flush();eq(x.sent.filter(p=>p.status==='running').length,before);
    x.unload();await flush();eq(x.clock.jobs.size,0);
  });
  await run('record row and byte limits rotate while completion proof survives',async()=>{
    const x=fixture({retentionMs:700000,recorderOptions:{limits:{rows:2,bytes:1024,windowMs:50,segments:3}}});await x.complete();
    const identity=x.mounted.running.snapshot().sessions[0].identity;
    x.clock.advance(700001);await flush();eq(x.mounted.running.snapshot().resumed,1);
    for(let i=0;i<10;i++){x.clock.advance(15000);await flush();}
    eq(x.mounted.running.snapshot().sessions[0].identity,identity);
    eq(x.sent.filter(p=>p.status==='finished').length,1);
    eq(x.sent.filter(p=>p.status==='running'&&!p.heartbeat).length,2);
    const ring=JSON.parse(fs.readFileSync(path.join(x.base,'delivery-ring.json')));ok(ring.rotations>4);
    for(const f of fs.readdirSync(x.base).filter(n=>/^delivery-\d.jsonl$/.test(n)))ok(fs.statSync(path.join(x.base,f)).size<=1024);
    x.unload();
  });
  await run('full or unwritable diagnostics do not affect task mapping or heartbeat qualification',async()=>{
    for(const mode of ['write_failure','oversize']){
      const options=mode==='write_failure'?{io:{...fs,mkdirSync(){throw new Error('synthetic_disk_failure');}}}:{limits:{bytes:1}};
      const x=fixture({recorderOptions:options});await x.complete();x.clock.advance(10001);await flush();
      eq(x.sent.filter(p=>!p.heartbeat).map(p=>p.status),['running','working','finished','running']);
      eq(x.mounted.bridge.isReady(),true);eq(x.mounted.running.snapshot().resumed,1);
      x.clock.advance(15000);await flush();eq(x.sent.at(-1).heartbeat,true);x.unload();
    }
  });
  await run('error and closed locks survive multiple windows; NPS unavailability does not stop the service',async()=>{
    for(const reason of ['error','aborted']){
      const x=fixture();await x.init();await x.start();await x.finish(reason);
      x.clock.advance(2400000);await flush();x.emit('agent/status',{agent:x.a,status:'idle'});await flush();
      eq(x.mounted.running.snapshot().sessions[0].terminalLocked,true);eq(x.mounted.bridge.isReady(),true);
      eq(x.sent.filter(p=>p.status==='running').length,1);x.unload();
    }
    let unavailable=true;const x=fixture({send:async(p,o,{apply})=>{if(unavailable)return {ok:false,retry:false};apply(p);return {ok:true};}});
    await x.init();await x.start();await x.finish();eq(x.mounted.bridge.isReady(),true);
    unavailable=false;await x.start(2,3);await x.finish('completed',2,4);x.clock.advance(10001);await flush();
    eq(x.mounted.running.snapshot().resumed,1);x.unload();
  });
  await run('per-session high-water marks reject duplicates after thousands of heartbeats without unbounded history',async()=>{
    const identity='a'.repeat(64),clock=new Clock(),sent=[];
    const c=createForwarder({instance:'b'.repeat(16),now:clock.now,mono:clock.mono,transport:async p=>{sent.push(p);return {ok:true};},authorizeRunning:async()=>true});
    const ready={type:'session/ready',identity,turn:0,seq:0,time:clock.now(),reason:null,epoch:1};
    eq((await c.accept(ready)).outcome,'acknowledged');let last;
    for(let pulse=1;pulse<=3000;pulse++){clock.advance(15000);last={type:'session/heartbeat',identity,turn:0,seq:0,time:clock.now(),reason:null,epoch:1,pulse};eq((await c.accept(last)).outcome,'acknowledged');}
    eq((await c.accept(last)).outcome,'duplicate');eq(c.snapshot().seen,1);eq(c.snapshot().stopped,false);
    c.release(identity);eq(c.snapshot().seen,0);c.stop();eq((await c.accept(last)).outcome,'stopped');
  });
  await run('record rotation reuses fixed slots and never reads private fields or creates service timers',async()=>{
    const base=path.join(root,'ring-only'),clock=new Clock();const r=createRecorder(base,'events',{mono:clock.mono,limits:{rows:1,bytes:80,segments:2,windowMs:10}});
    for(let i=0;i<20;i++){ok(r.append({type:'turn/start',seq:i}));clock.advance(11);}
    eq(fs.readdirSync(base).filter(n=>n.endsWith('.jsonl')).length,2);eq(clock.jobs.size,0);r.stop();eq(r.append({type:'turn/end'}),false);
  });
  console.log(JSON.stringify({suite:'permanent-lifecycle',passed,failed:0,skipped:0,cases,realNotifyRequests:0}));
}finally{disposeFixtures();}
