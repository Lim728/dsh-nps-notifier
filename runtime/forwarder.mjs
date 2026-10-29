// Dedicated bounded IPC worker; no autonomous heartbeat scheduling.
import fs from 'node:fs';import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createForwarder,LIMITS} from './forward-core.mjs';
import {createHttpTransport} from './forward-http.mjs';
import {createHandshakeDiagnostics} from './handshake-diagnostics.mjs';
import {createRecorder} from './recorder.mjs';
export function createWorkerRuntime({channel,base,httpTransport,now=()=>Date.now(),mono=()=>performance.now(),schedule=setTimeout,unschedule=clearTimeout,exit=()=>{},recorderOptions={}}){
  let core,busy=false,closed=false,deadline,logged=0,logBytes=0,permit=null,permitSerial=0;
  const recorder=createRecorder(base,'delivery',{mono,...recorderOptions});
  const handshake=createHandshakeDiagnostics(base,'child',{now,mono});
  const counts={phase:'waiting_init',received:0,acknowledged:0,dropped:0,writeFailures:0,heartbeatsReceived:0,heartbeatsAcknowledged:0};
  function summary(){try{const text=JSON.stringify(counts);if(text.length>4096)return;fs.writeFileSync(path.join(base,'forward-status.tmp'),text);fs.renameSync(path.join(base,'forward-status.tmp'),path.join(base,'forward-status.json'));}catch{counts.writeFailures=Math.min(1000,counts.writeFailures+1);}}
  function log(result){
    if(!recorder.append({...result,time:now()}))counts.writeFailures=Math.min(1000000,counts.writeFailures+1);
  }
  function resolvePermit(allowed){if(!permit)return;const p=permit;permit=null;unschedule(p.timer);p.resolve(allowed);}
  function send(m){
    const isReady=m.kind==='ready';if(isReady)handshake.mark('ready_send_called');
    try{
      if(!channel.connected){if(isReady)handshake.mark('ready_disconnected');close('disconnected');return;}
      const sent=channel.send(m,error=>{if(isReady){handshake.mark('ready_callback');handshake.mark(error?'ready_callback_failed':'ready_callback_ok');}if(error)close('ipc_failed');});
      if(isReady)handshake.mark(sent===false?'ready_send_buffered':'ready_send_returned');
    }catch{if(isReady)handshake.mark('ready_send_threw');close('ipc_failed');}
  }
  function close(reason='stopped'){
    if(closed)return;closed=true;unschedule(deadline);resolvePermit(false);core?.stop();httpTransport.stop();recorder.stop();counts.phase=reason;summary();handshake.finish();
    channel.off('message',handle);channel.off('disconnect',disconnect);
    if(channel.connected)try{channel.disconnect();}catch{}exit();
  }
  function authorizeHeartbeat(record){
    return authorize(record,'authorizeHeartbeat');
  }
  function authorizeRunning(record){
    return authorize(record,'authorizeRunning');
  }
  function authorize(record,kind){
    if(closed||!channel.connected)return Promise.resolve(false);
    return new Promise(resolve=>{
      resolvePermit(false);const requestId=++permitSerial;
      permit={requestId,resolve,kind,identity:record.identity,epoch:record.epoch,type:record.type,timer:schedule(()=>resolvePermit(false),LIMITS.timeoutMs)};
      send({kind,requestId,record});
    });
  }
  async function handle(msg){
    if(closed)return;
    if(!core){
      if(msg?.kind!=='init'||! /^[0-9a-f]{16}$/.test(msg.instance??''))return;
      handshake.mark('init_received');
      core=createForwarder({instance:msg.instance,transport:httpTransport.send,authorizeHeartbeat,authorizeRunning,now,mono});counts.phase='ready';summary();handshake.mark('ready_built');unschedule(deadline);send({kind:'ready'});return;
    }
    if(msg?.kind==='release'){core.release(msg.identity);if(permit?.identity===msg.identity)resolvePermit(false);return;}
    if(msg?.kind==='observeStart'){core.observeStart(msg.record);return;}
    if(msg?.kind==='revokeRunning'){core.revokeRunning(msg.identity);if(permit?.kind==='authorizeRunning'&&permit.identity===msg.identity)resolvePermit(false);return;}
    if(msg?.kind==='pauseRunning'){core.pauseRunning(msg.identity,msg.epoch);if(permit?.type==='session/heartbeat'&&permit.identity===msg.identity&&permit.epoch<=msg.epoch)resolvePermit(false);return;}
    if(msg?.kind==='revoke'){core.revoke(msg.identity,msg.turn,msg.seq);resolvePermit(false);return;}
    if(msg?.kind==='heartbeatPermit'||msg?.kind==='runningPermit'){
      if(msg.requestId===permit?.requestId&&permit.kind===(msg.kind==='runningPermit'?'authorizeRunning':'authorizeHeartbeat'))resolvePermit(msg.allowed===true);return;
    }
    if(msg?.kind!=='event'||busy||!Number.isSafeInteger(msg.id))return;
    busy=true;counts.received++;if(['heartbeat','session/heartbeat'].includes(msg.record?.type))counts.heartbeatsReceived++;
    let result={outcome:'internal_failure',attempts:0,status:null};
    try{result=await core.accept(msg.record);if(closed)return;
      log(result);
      if(result.outcome==='acknowledged'){counts.acknowledged++;if(result.heartbeat)counts.heartbeatsAcknowledged++;}else counts.dropped++;
      summary();
    }catch{counts.dropped++;summary();}
    finally{busy=false;if(!closed)send({kind:'ack',id:msg.id,result});}
  }
  function disconnect(){close('disconnected');}
  channel.on('disconnect',disconnect);channel.on('message',handle);handshake.mark('listener_attached');deadline=schedule(()=>{handshake.mark('init_timeout');close('init_timeout');},3000);
  return {close,snapshot:()=>({...counts,closed}),handle};
}
