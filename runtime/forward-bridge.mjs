import fs from 'node:fs';import path from 'node:path';import {fork} from 'node:child_process';import {fileURLToPath} from 'node:url';import {randomBytes} from 'node:crypto';
import {whitelist,LIMITS} from './forward-core.mjs';
import {createHandshakeDiagnostics} from './handshake-diagnostics.mjs';
export function createBridge(base,spawn=fork,{allowHeartbeat=()=>false,allowRunning=()=>false,authorizeRunning=async()=>false,onReady=()=>{},onResult=()=>{},onStop=()=>{},now=()=>Date.now(),mono=()=>performance.now(),schedule=setTimeout,unschedule=clearTimeout}={}){
  const instance=randomBytes(8).toString('hex'),queue=[],began=mono();
  const handshake=createHandshakeDiagnostics(base,'parent',{now,mono});
  let child,ready=false,inflight=null,closed=false,serial=0,watchdog,deadline;
  const state={phase:'starting',instance,queued:0,dropped:0,sentToWorker:0,queueDepth:0,heartbeatsQueued:0,heartbeatsAcknowledged:0};
  function save(){try{fs.writeFileSync(path.join(base,'bridge-status.tmp'),JSON.stringify(state));fs.renameSync(path.join(base,'bridge-status.tmp'),path.join(base,'bridge-status.json'));}catch{}}
  function stop(reason='stopped'){
    if(closed)return;closed=true;unschedule(watchdog);unschedule(deadline);queue.length=0;inflight=null;state.phase=reason;state.queueDepth=0;save();handshake.finish();
    try{onStop(reason);}catch{}
    try{if(child?.connected)child.disconnect();}catch{}
    try{child?.kill();}catch{}
  }
  const open=()=>!closed;
  const isRunning=r=>['session/ready','session/restored-ready','session/resume','session/heartbeat'].includes(r?.type);
  const isHeartbeat=r=>['heartbeat','session/heartbeat'].includes(r?.type);
  const fresh=r=>now()-r.time>=(isRunning(r)||isHeartbeat(r)?0:-1000)&&now()-r.time<=(['session/ready','session/restored-ready','session/resume'].includes(r.type)?LIMITS.runningAgeMs:isHeartbeat(r)?LIMITS.heartbeatAgeMs:LIMITS.ageMs);
  function permitted(r){try{return open()&&ready&&child?.connected&&fresh(r)&&allowHeartbeat(r)===true;}catch{return false;}}
  function runningPermitted(r){try{return open()&&ready&&child?.connected&&fresh(r)&&allowRunning(r)===true;}catch{return false;}}
  function send(message){try{if(!child?.connected){stop('ipc_failed');return false;}child.send(message,err=>{if(err)stop('ipc_failed');});return !closed;}catch{stop('ipc_failed');return false;}}
  function drain(){
    if(!open())return;
    if(!ready||inflight!==null)return;
    while(queue.length){const item=queue.shift();if(!fresh(item.record)||(item.record.type==='heartbeat'&&!permitted(item.record))||(isRunning(item.record)&&!runningPermitted(item.record))){state.dropped++;continue;}
      inflight=item;state.sentToWorker++;state.queueDepth=queue.length;save();
      unschedule(watchdog);watchdog=schedule(()=>stop('worker_timeout'),3000);
      send({kind:'event',...item});return;
    }state.queueDepth=0;save();
  }
  function revoke(identity,turn,seq){
    if(closed||! /^[0-9a-f]{64}$/.test(identity??'')||!Number.isSafeInteger(turn)||turn<1||!Number.isSafeInteger(seq)||seq<0)return;
    for(let i=queue.length-1;i>=0;i--){const r=queue[i].record;if(r.type==='heartbeat'&&r.identity===identity&&r.turn<=turn){queue.splice(i,1);state.dropped++;}}
    // Control bypasses the work queue, including while HTTP or a retry is in progress.
    send({kind:'revoke',identity,turn,seq});state.queueDepth=queue.length;save();
  }
  function revokeRunning(identity){
    if(closed||! /^[0-9a-f]{64}$/.test(identity??''))return;
    for(let i=queue.length-1;i>=0;i--)if(isRunning(queue[i].record)&&queue[i].record.identity===identity){queue.splice(i,1);state.dropped++;}
    send({kind:'revokeRunning',identity});state.queueDepth=queue.length;save();
  }
  function pauseRunning(identity,epoch){
    if(closed||! /^[0-9a-f]{64}$/.test(identity??'')||!Number.isSafeInteger(epoch)||epoch<1)return;
    for(let i=queue.length-1;i>=0;i--){const r=queue[i].record;if(['session/heartbeat','session/restored-ready'].includes(r.type)&&r.identity===identity&&r.epoch<=epoch){queue.splice(i,1);state.dropped++;}}
    send({kind:'pauseRunning',identity,epoch});state.queueDepth=queue.length;save();
  }
  try{
    child=spawn(fileURLToPath(new URL('./forwarder.mjs',import.meta.url)),[],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,execArgv:[]});
    child.on('error',()=>stop('worker_failed'));child.on('exit',()=>stop('worker_exited'));child.on('disconnect',()=>stop('ipc_disconnected'));
    child.on('message',m=>{handshake.mark('message_entered');if(closed)return;
      if(m?.kind==='ready')handshake.mark('ready_received');
      if(m?.kind==='ready'&&!ready){
        handshake.mark('ready_processing');
        try{ready=true;state.phase='ready';unschedule(watchdog);save();drain();try{onReady();}catch{handshake.mark('ready_callback_failed');}handshake.mark('ready_handled');}
        catch(error){handshake.mark('ready_processing_failed');throw error;}
      }
      else if(m?.kind==='authorizeRunning'){
        const r=whitelist(m.record),item=inflight;
        const matches=()=>isRunning(r)&&inflight===item&&item?.record.type===r.type&&['identity','turn','seq','epoch','pulse','time'].every(k=>item.record[k]===r[k]);
        if(!Number.isSafeInteger(m.requestId)||m.requestId<1)return;
        if(!matches()||!runningPermitted(r)){send({kind:'runningPermit',requestId:m.requestId,allowed:false});return;}
        Promise.resolve().then(()=>authorizeRunning(r)).then(ok=>{
          if(!closed)send({kind:'runningPermit',requestId:m.requestId,allowed:ok===true&&matches()&&runningPermitted(r)});
        },()=>{if(!closed)send({kind:'runningPermit',requestId:m.requestId,allowed:false});});
      }
      else if(m?.kind==='authorizeHeartbeat'){
        const r=whitelist(m.record),a=inflight?.record;
        const matches=r?.type==='heartbeat'&&a?.type==='heartbeat'&&['identity','turn','seq','pulse','time'].every(k=>a[k]===r[k]);
        if(Number.isSafeInteger(m.requestId)&&m.requestId>0)send({kind:'heartbeatPermit',requestId:m.requestId,allowed:!!matches&&permitted(r)});
      }
      else if(m?.kind==='ack'&&m.id===inflight?.id){
        const item=inflight;inflight=null;unschedule(watchdog);
        if(isHeartbeat(item.record)&&m.result?.outcome==='acknowledged')state.heartbeatsAcknowledged++;
        try{onResult(item.record,m.result);}catch{}
        save();drain();
      }
    });
    handshake.mark('listener_attached');
    watchdog=schedule(()=>{handshake.mark('start_timeout');handshake.mark(ready?'timeout_after_ready':'timeout_before_ready');stop('worker_start_timeout');},3000);send({kind:'init',instance});save();
  }catch{stop('worker_failed');}
  function release(identity){
    if(closed||! /^[0-9a-f]{64}$/.test(identity??''))return;
    for(let i=queue.length-1;i>=0;i--)if(queue[i].record.identity===identity){queue.splice(i,1);state.dropped++;}
    send({kind:'release',identity});state.queueDepth=queue.length;save();
  }
  function add(input,heartbeat){
    if(!open())return false;
    const record=whitelist(input);
    if(!record||isHeartbeat(record)!==heartbeat||!fresh(record)||(record.type==='heartbeat'&&!permitted(record))||(isRunning(record)&&!runningPermitted(record))){state.dropped++;save();return false;}
    if(!heartbeat&&record.type==='turn/start'){revokeRunning(record.identity);send({kind:'observeStart',record});}
    if(!heartbeat&&record.type==='turn/end')revoke(record.identity,record.turn,record.seq);
    if(heartbeat){
      const i=queue.findIndex(x=>isHeartbeat(x.record)&&x.record.identity===record.identity);
      if(i>=0){queue.splice(i,1);state.dropped++;}
    }
    if(closed)return false;
    if(queue.length+(inflight!==null?1:0)>=LIMITS.queue){state.dropped++;save();return false;}
    queue.push({id:++serial,record});state.queued++;if(heartbeat)state.heartbeatsQueued++;state.queueDepth=queue.length;save();drain();return true;
  }
  return {enqueue:r=>add(r,false),enqueueHeartbeat:r=>add(r,true),revoke,revokeRunning,pauseRunning,release,stop,isReady:()=>open()&&ready&&!!child?.connected,
    snapshot:()=>({...state,inflight:inflight!==null,pendingHeartbeats:queue.filter(x=>isHeartbeat(x.record)).length})};
}
