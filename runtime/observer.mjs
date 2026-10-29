import {createBridge} from './forward-bridge.mjs';
import {createHeartbeatController} from './heartbeat-controller.mjs';
import {createRunningController} from './running-controller.mjs';
import {createStateReader} from './state-reader.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHmac } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {spawn as spawnChild} from 'node:child_process';
import {LIMITS} from './forward-core.mjs';
import {createRecorder,writeSnapshot} from './recorder.mjs';
import {createReceptionCapture} from './reception-capture.mjs';
// The worker belongs to this mount and uses only the plugin-owned diagnostic directory.
const FOUR_STATUS_WORKER=`
const {createWorkerRuntime}=await import(process.argv[1]);
const {createHttpTransport}=await import(process.argv[2]);
createWorkerRuntime({channel:process,base:process.argv[3],httpTransport:createHttpTransport({port:Number(process.argv[4])}),
  exit:()=>{setTimeout(()=>process.exit(0),20).unref();}});
`;
export function createFourStatusBridge(base,spawn=spawnChild,options){
  return createBridge(base,(_module,_args,processOptions)=>spawn(process.execPath,
    ['--input-type=module','--eval',FOUR_STATUS_WORKER,new URL('../runtime/forwarder.mjs',import.meta.url).href,
      new URL('../runtime/forward-http.mjs',import.meta.url).href,base,String(options?.port??17877)],processOptions),options);
}
const REASONS=new Set(['completed','aborted','error','blocked','max-tokens']);
export function createObserver(base, clock=()=>performance.now(), wall=()=>Date.now(), hooks={}) {
  const key=randomBytes(32),sessions=new Map(),recorder=createRecorder(base,'events',{mono:clock,...hooks.recorderOptions});
  let stopped=false;
  const diag={phase:'initialized',initialized:true,subscribed:false,eventEntryReached:false,eventEntryCount:0,writeFailureCount:0};
  const state={mountedUtc:wall(),stopped:false,stopReason:null,rows:0,orphanEnds:0,invalid:0,unpairedStarts:0};
  function identityFor(session){const id=session.id;if(typeof id!=='string'||!id.length||id.length>512)return null;return createHmac('sha256',key).update(id).digest('hex');}
  function save(){
    const recording=recorder.snapshot();
    if(!writeSnapshot(base,'status',{...state,recording}))diag.writeFailureCount=Math.min(1000000,diag.writeFailureCount+1);
    writeSnapshot(base,'diagnostics',{...diag,stopped,lastUtc:wall(),recording});
  }
  function stop(reason='unloaded'){
    if(stopped)return;stopped=true;state.stopped=true;state.stopReason=reason;diag.phase='stopped';
    state.unpairedStarts=[...sessions.values()].filter(s=>s.active).length;sessions.clear();recorder.stop();save();
    try{hooks.stop?.(reason);}catch(error){/* Owner cleanup remains idempotent. */}
  }
  function publish(record,session){
    recorder.append(record);state.rows=Math.min(Number.MAX_SAFE_INTEGER,state.rows+1);save();
    try{hooks.record?.(record,session);}catch(error){/* An observer must not change DSH execution. */}
  }
  function trace(stage,session,event,reason){try{hooks.trace?.(stage,session,event,reason);}catch(error){/* Diagnostics cannot alter admission. */}}
  function handle(session,event){
    if(stopped)return;
    diag.eventEntryCount=Math.min(Number.MAX_SAFE_INTEGER,diag.eventEntryCount+1);
    if(!diag.eventEntryReached){diag.eventEntryReached=true;diag.phase='event_entry';save();}
    try{
      const type=event.type;if(type!=='turn/start'&&type!=='turn/end')return;
      trace('observer',session,event);
      if(hooks.isLive&&hooks.isLive(session)!==true){trace('rejected',session,event,'not_live');return;}
      const turn=event.data.turn,seq=event.seq,timestamp=event.time,identity=identityFor(session);
      if(!identity||!Number.isSafeInteger(turn)||turn<1||!Number.isSafeInteger(seq)||seq<0||!Number.isSafeInteger(timestamp)||timestamp<0){trace('rejected',session,event,'invalid_fields');state.invalid++;save();return;}
      let s=sessions.get(identity);
      if(type==='turn/start'){
        if(s&&(s.session!==session||seq<=s.seq||turn<=s.turn)){trace('rejected',session,event,'identity_or_order');state.invalid++;save();return;}
        if(!s&&sessions.size>=LIMITS.sessions){trace('rejected',session,event,'capacity');state.invalid++;save();return;}
        s={session,turn,seq,active:true};sessions.set(identity,s);
        trace('accepted',session,event);
        publish({type,identity,turn,seq,time:timestamp,reason:null},session);
      }else{
        const reason=event.data.reason?.kind;
        if(!s||s.session!==session||!s.active||s.turn!==turn||seq<=s.seq){trace('rejected',session,event,'unpaired_end');state.orphanEnds++;save();return;}
        s.seq=seq;s.active=false;
        if(reason==='interrupted'){trace('rejected',session,event,'interrupted');state.orphanEnds++;save();return;}
        trace('accepted',session,event,REASONS.has(reason)?reason:'unknown');
        publish({type,identity,turn,seq,time:timestamp,reason:REASONS.has(reason)?reason:'unknown'},session);
      }
    }catch(error){trace('rejected',session,event,'exception');state.invalid++;save();}
  }
  function release(session){const id=identityFor(session);if(sessions.get(id)?.session===session)sessions.delete(id);}
  function subscribed(){diag.subscribed=true;diag.phase='subscribed';save();}
  save();return {handle,stop,subscribed,identityFor,release,snapshot:()=>({...state,recording:recorder.snapshot(),sessions:sessions.size})};
}
export function mountObserver(ctx,{base,bridgeFactory=createBridge,heartbeatEnabled=false,heartbeatFactory=createHeartbeatController,runningEnabled=false,runningFactory=createRunningController,resumeEnabled=false,stateReaderFactory=createStateReader,clock=()=>performance.now(),wall=()=>Date.now(),schedule=setTimeout,unschedule=clearTimeout,recorderOptions={},port=17877}={}){
  // Diagnostic availability never controls activation.
  try{fs.mkdirSync(base,{recursive:true});}catch(error){/* Recorder reports bounded write failure. */}
  let bridge,heartbeat,running,reader,capture;let mounted=true;const off=[];
  // Cordis restricts registry access to contexts declaring the agents dependency.
  let heartbeatAgent=typeof ctx.inject==='function'?()=>undefined:id=>ctx.agents?.get(id);
  const observer=createObserver(base,clock,wall,{recorderOptions,
    record:(r,session)=>{if(r.type==='turn/start')heartbeat?.start(r,session);try{running?.observeRecord?.(r,session);}catch{}const queued=bridge?.enqueue(r);capture?.mark('enqueue',session,{type:r.type,time:r.time,seq:r.seq,data:{turn:r.turn}},queued?'queued':'not_queued');},
    trace:(...args)=>capture?.mark(...args),
    isLive:session=>heartbeatAgent(session.id)?.session===session,
    stop:()=>{running?.stop();reader?.stop();heartbeat?.stop();bridge?.stop();}
  });
  if(!observer)return null;
  function stop(){if(!mounted)return;mounted=false;capture?.stop();running?.stop();reader?.stop();for(const unsubscribe of off.splice(0))unsubscribe();heartbeat?.stop();observer.stop('unloaded');bridge?.stop();}
  try{
    capture=createReceptionCapture(ctx,{base,identityFor:observer.identityFor,getAgent:id=>heartbeatAgent(id),getInstance:()=>bridge?.snapshot().instance,getControl:()=>running?.snapshot(),now:wall,mono:clock,schedule,unschedule});
    if(resumeEnabled===true)reader=stateReaderFactory({schedule,unschedule,port});
    bridge=bridgeFactory(base,undefined,{
      now:wall,mono:clock,schedule,unschedule,port,
      allowHeartbeat:r=>heartbeat?.eligible(r)===true,
      allowRunning:r=>running?.eligible(r)===true,
      authorizeRunning:r=>running?.authorize(r)??Promise.resolve(false),
      onReady:()=>running?.considerAll(),
      onResult:(r,result)=>{heartbeat?.acknowledge(r,result);running?.acknowledge?.(r,result);},
      onStop:()=>stop()
    });
    if(!mounted){bridge.stop();return null;}
    if(heartbeatEnabled===true)heartbeat=heartbeatFactory({getAgent:id=>heartbeatAgent(id),bridge,now:wall,mono:clock,schedule,unschedule});
    off.push(ctx.on('session/event',(session,event)=>{
      const traced=event.type==='turn/start'||event.type==='turn/end';
      if(traced)capture?.mark('subscriber',session,event);
      // Revoke before parsing end reasons or attempting diagnostic writes.
      try{heartbeat?.end(session,event);}catch{}
      try{running?.sessionEvent(session,event);}catch{}
      if(traced)capture?.mark('idle_after_event',session,event);
      observer.handle(session,event);
    }));
    off.push(ctx.on('session/disposed',session=>{const live=heartbeatAgent(session.id);if(live&&live.session!==session)return;const identity=observer.identityFor(session);observer.release(session);bridge?.release?.(identity);}));
    off.push(ctx.on('agent/disposed',({agent})=>{const live=heartbeatAgent(agent.session.id);if(live&&live!==agent)return;const identity=observer.identityFor(agent.session);observer.release(agent.session);bridge?.release?.(identity);}));
    if(heartbeat){
      off.push(ctx.on('agent/pre-step',(payload,next)=>heartbeat.preStep(payload,next)));
      off.push(ctx.on('agent/disposed',payload=>heartbeat.disposed(payload.agent)));
      off.push(ctx.on('agent/status',payload=>heartbeat.status(payload.agent,payload.status)));
    }
    if((runningEnabled===true||heartbeatEnabled===true)&&typeof ctx.inject==='function'){
      // Declare the live registry dependency locally; do not alter the web profile.
      const fiber=ctx.inject(['agents'],child=>{
        if(!mounted)return;
        const registeredAgent=id=>child.agents.get(id);heartbeatAgent=registeredAgent;
        try{capture?.registry(child.agents.list());}catch(error){/* Diagnostic enumeration cannot affect registry use. */}
        child.effect(()=>()=>{if(heartbeatAgent===registeredAgent){heartbeatAgent=()=>undefined;stop();}});
        if(heartbeat){
          const getAgent=id=>child.agents.get(id),controller=heartbeat;
          child.effect(()=>()=>controller.stop());
        }
        if(runningEnabled!==true)return;
        const controller=runningFactory({getAgent:id=>child.agents.get(id),identityFor:observer.identityFor,bridge,base,getApprovalState:agent=>{const owner=child.get?.('approval');const state=owner?.pendingState?.(agent);return state?{...state,owner:state.authority}:undefined;},readState:reader?.read,now:wall,mono:clock,schedule,unschedule});
        running=controller;controller.attach(child);
        // Optional approval ownership: removal cancels restored qualifications
        // immediately; absence never substitutes an empty observer-side set.
        const approvals=child.inject(['approval'],scope=>{
          scope.effect(()=>()=>controller.approvalUnavailable?.());
        });
        off.push(()=>{const disposal=approvals?.dispose?.();disposal?.catch?.(()=>{});});
        child.effect(()=>()=>{controller.stop('unloaded');if(running===controller)running=undefined;});
      });
      off.push(()=>{const disposal=fiber?.dispose?.();disposal?.catch?.(()=>{});});
    }
    ctx.effect(()=>stop);observer.subscribed();
    return {stop,heartbeat,observer,bridge,get running(){return running;}};
  }catch{stop();return null;}
}
// Register synchronously: boot commits appReady only after plugin registration.
// Defer the mount (and its unchanged 3s worker handshake) out of the boot stack.
export function mountAfterAppReady(ctx,{defer=setImmediate,cancelDefer=clearImmediate,mountFactory=mountObserver,...options}={}){
  const {base,clock=()=>performance.now(),schedule=setTimeout,unschedule=clearTimeout}=options;
  const appReady=ctx.get?.('appReady');
  if(typeof appReady?.onReady!=='function')return null;
  let closed=false,requested=false,mounted,offReady,pending,deadline;
  function stop(){
    if(closed)return;closed=true;
    offReady?.();offReady=undefined;
    if(pending!==undefined){cancelDefer(pending);pending=undefined;}
    unschedule(deadline);mounted?.stop();
  }
  function ready(){
    if(closed||requested)return;requested=true;
    pending=defer(()=>{
      pending=undefined;if(closed)return;
      offReady?.();offReady=undefined;
      try{mounted=mountFactory(ctx,options);if(!mounted)stop();}
      catch{stop();}
    });
  }
  try{
    ctx.effect(()=>stop);
    const unsubscribe=appReady.onReady(ready);
    if(closed)unsubscribe?.();else offReady=unsubscribe;
  }catch{stop();return null;}
  return {stop,get mounted(){return mounted;},get observer(){return mounted?.observer;},
    get bridge(){return mounted?.bridge;},get running(){return mounted?.running;},get heartbeat(){return mounted?.heartbeat;}};
}

/** Register the shipped plugin with all previously accepted status controls. */
export function startBuiltin(ctx,{base,port}){
  const owner=mountAfterAppReady(ctx,{base,port,bridgeFactory:createFourStatusBridge,heartbeatEnabled:true,runningEnabled:true,resumeEnabled:true});
  if(!owner)throw new Error('nps_notifier_registration_failed');
  return owner;
}
