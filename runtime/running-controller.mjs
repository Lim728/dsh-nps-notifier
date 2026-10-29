// Initial readiness and separately acknowledged idle-only heartbeats.
// No task-heartbeat eligibility, message/history reads or approval mapping.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {LIMITS,whitelist} from './forward-core.mjs';
const REASONS=new Set(['mounted','created','fresh_startup','history_unknown','checking','eligible','queued','queue_rejected','not_idle','queued_input','pending_approval','turn_observed','terminal_locked','released','identity_changed','stale_check','check_failed','expired','capacity','write_failed','stopped','unloaded','ready_acknowledged','heartbeat_queued','heartbeat_acknowledged','delivery_failed','disconnected','completion_wait','resume_queued','resume_confirmed','resume_rejected','restored_ready','interaction_released','approval_unknown']);
export function createRunningController({getAgent,identityFor,bridge,base,readState=null,getApprovalState=()=>undefined,now=()=>Date.now(),mono=()=>performance.now(),schedule=setTimeout,unschedule=clearTimeout,io=fs}){
  const began=mono(),entries=new Map(),off=[];let stopped=false,deadline,timer,waiting=0,epoch=0,pulse=0;
  const counters={phase:'running_guard',checks:0,queued:0,authorized:0,revoked:0,rejected:0,writeFailures:0,idleHeartbeatsQueued:0,idleHeartbeatsAcknowledged:0,resumeChecks:0,resumed:0,lastReason:'mounted'};
  function snapshot(){return {...counters,waiting,entries:entries.size,sessions:[...entries.values()].map(e=>({identity:e.identity,epoch:e.epoch,fresh:e.fresh,restoredReady:e.leases.size>0,turnSeen:e.turnSeen,terminalLocked:e.terminal,offered:e.offered,runningAcknowledged:e.acked,released:e.released,pending:e.pending.size,lastReason:e.reason})),time:now()};}
  function save(reason,e){
    if(stopped)return;if(!REASONS.has(reason))reason='check_failed';counters.lastReason=reason;if(e)e.reason=reason;
    try{const text=JSON.stringify(snapshot())+'\n';if(Buffer.byteLength(text)>16384)throw new Error();io.writeFileSync(path.join(base,'running-status.tmp'),text);io.renameSync(path.join(base,'running-status.tmp'),path.join(base,'running-status.json'));}
    catch(error){counters.writeFailures=Math.min(1000000,counters.writeFailures+1);}
  }
  function open(){return !stopped;}
  function same(e){try{return !e.released&&getAgent(e.session.id)===e.agent&&e.agent.session===e.session;}catch{return false;}}
  // A backend interaction lease is separate from startup freshness. It never
  // changes source=resume, and never reads transcript/history to infer intent.
  function approval(e){
    try{const s=getApprovalState(e.agent);return s&&s.owner&&Number.isSafeInteger(s.pending)&&s.pending>=0&&Number.isSafeInteger(s.revision)&&s.revision>=0?s:null;}catch{return null;}
  }
  function restored(e){
    const s=approval(e);return e.leases.size>0&&!e.turnSeen&&!e.terminal&&!e.uncertain&&!!s&&s.pending===0&&s.owner===e.approvalOwner&&s.revision===e.approvalRevision;
  }
  function clearLeases(e){for(const dispose of e.leases.values())dispose();e.leases.clear();e.approvalOwner=null;}
  function interaction({agent,signal}){
    if(!open()||!signal||signal.aborted)return;
    let e=lookup(agent.session);
    // If mounted after publication, retain the absence of creation provenance;
    // only this backend lease can qualify it, never a fabricated startup/resume.
    if(!e){created(agent,'interactive_attachment');e=lookup(agent.session);}
    if(!e||e.agent!==agent||!same(e)||e.fresh||!['resume','interactive_attachment'].includes(e.origin)||e.turnSeen||e.terminal||e.completed||e.idleAnchor||e.uncertain)return;
    try{if(agent.status!=='idle'||agent.inbox.hasPending!==false)return;}catch{return;}
    const s=approval(e);
    if(!s||s.pending!==0){save(s?'pending_approval':'approval_unknown',e);return;}
    if(e.leases.has(signal)||e.leases.size>=16)return;
    const release=()=>{
      e.leases.get(signal)?.();e.leases.delete(signal);
      if(!e.leases.size){invalidateInteraction(e,'interaction_released');}
    };
    signal.addEventListener('abort',release,{once:true});
    e.leases.set(signal,()=>signal.removeEventListener('abort',release));
    e.approvalOwner=s.owner;e.approvalRevision=s.revision;
    if(signal.aborted){release();return;}
    save('restored_ready',e);
    if(e.busy)e.reconsider=true;else consider(e);
  }
  function invalidateInteraction(e,reason){
    const prior=e.epoch;e.epoch++;e.confirmed=0;e.cancelCheck?.();e.due=null;
    bridge.pauseRunning(e.identity,prior);clearLeases(e);e.record=null;e.acked=false;e.offered=false;
    save(reason,e);arm();
  }
  function cancelResume(e,forget){
    const c=e.completed;if(c){unschedule(c.timer);c.timer=null;c.abort?.abort();if(forget)e.completed=null;}
    if(forget)e.idleAnchor=null;
  }
  function revoke(e,reason){
    if(e.leases.size&&!['turn_observed','terminal_locked','released','identity_changed','stopped','unloaded','disconnected'].includes(reason)){invalidateInteraction(e,reason);return;}
    clearLeases(e);
    const prior=e.epoch,temporary=e.acked&&['not_idle','queued_input','pending_approval'].includes(reason);
    e.epoch++;e.confirmed=0;e.reason=reason;e.due=null;e.cancelCheck?.();
    cancelResume(e,!['not_idle','queued_input','pending_approval'].includes(reason));
    if(temporary)bridge.pauseRunning(e.identity,prior);
    else if(e.record||e.acked)bridge.revokeRunning(e.identity);
    if(e.record||e.acked)counters.revoked=Math.min(Number.MAX_SAFE_INTEGER,counters.revoked+1);
    e.record=null;if(!temporary)e.acked=false;
    save(reason,e);arm();
  }
  function stop(reason='stopped',write=true){
    if(stopped)return;stopped=true;unschedule(deadline);unschedule(timer);for(const fn of off.splice(0))try{fn();}catch{}
    for(const e of entries.values()){clearLeases(e);e.epoch++;e.confirmed=0;e.cancelCheck?.();cancelResume(e,true);if(e.record||e.acked)try{bridge.revokeRunning(e.identity);}catch{}e.record=null;e.acked=false;e.due=null;e.pending.clear();e.agent=null;e.session=null;e.released=true;}
    counters.phase='stopped';counters.lastReason=REASONS.has(reason)?reason:'stopped';
    if(write)try{io.writeFileSync(path.join(base,'running-status.json'),JSON.stringify(snapshot())+'\n');}catch{counters.writeFailures++;}
  }
  function baseEligible(e){
    if(!open()||!same(e)||e.terminal||e.pending.size||(!e.idleAnchor&&!restored(e)&&(!e.fresh||e.turnSeen)))return false;
    try{return e.agent.status==='idle'&&e.agent.inbox.hasPending===false;}catch{return false;}
  }
  function eligible(input){
    const r=whitelist(input),e=r&&entries.get(r.identity);
    return !!(['session/ready','session/restored-ready','session/resume','session/heartbeat'].includes(r?.type)&&e&&e.record&&['type','turn','seq','epoch','pulse','time'].every(k=>e.record[k]===r[k])&&e.confirmed===e.epoch&&(r.type==='session/resume'?resumeLive(e,e.completed)&&e.completed.used&&mono()-e.completed.proofMono>=0&&mono()-e.completed.proofMono<=LIMITS.runningAgeMs:baseEligible(e))&&bridge.isReady()&&(r.type!=='session/heartbeat'||(e.acked&&mono()-e.lastAck>=0&&mono()-e.lastAck<2*LIMITS.heartbeatMs))&&now()-r.time>=0&&now()-r.time<=(r.type==='session/heartbeat'?LIMITS.heartbeatAgeMs:LIMITS.runningAgeMs));
  }
  async function checkIdle(e,r,predicate=baseEligible){
    if(!predicate(e)||e.busy)return false;
    if(waiting>=LIMITS.sessions)return false;
    const version=e.epoch;e.busy=true;waiting++;counters.checks++;save('checking',e);
    let cancel;const cancelled=new Promise(resolve=>{cancel=()=>resolve(false);});e.cancelCheck=cancel;
    try{
      const idle=await Promise.race([Promise.resolve(e.agent.whenIdle()).then(()=>true),cancelled]);
      if(!idle)return false;
      if(!open())return false;
      if(version!==e.epoch||!predicate(e)||(r&&!eligible(r))){counters.rejected++;save('stale_check',e);return false;}
      e.confirmed=version;save('eligible',e);return true;
    }catch{if(open()){counters.rejected++;save('check_failed',e);}return false;}
    finally{waiting--;e.busy=false;if(e.cancelCheck===cancel)e.cancelCheck=null;if(e.reconsider){e.reconsider=false;queueMicrotask(()=>{if(open())consider(e);});}}
  }
  function consider(e){
    if(e?.completed&&!e.idleAnchor){considerResume(e);return;}
    if(!e||!baseEligible(e)||!bridge.isReady())return;
    if(e.acked){if(e.due===null){e.due=mono()+LIMITS.heartbeatMs;arm();}return;}
    if(e.offered)return;
    void checkIdle(e).then(ok=>{
      if(!ok||e.confirmed!==e.epoch||!baseEligible(e)||e.offered||!bridge.isReady())return;
      e.offered=true;e.record={type:e.fresh?'session/ready':'session/restored-ready',identity:e.identity,turn:0,seq:0,time:now(),reason:null,epoch:e.epoch};
      // turn/seq=0 are protocol sentinels for pre-task readiness, never a fabricated task.
      if(bridge.enqueue(e.record)){counters.queued++;save('queued',e);}else{e.record=null;save('queue_rejected',e);}
    }).catch(()=>{if(open())save('check_failed',e);});
  }
  async function authorize(r){
    if(!eligible(r))return false;const e=entries.get(r.identity);
    const ok=await checkIdle(e,r,r.type==='session/resume'?x=>resumeLive(x,x.completed):baseEligible);if(ok&&eligible(r)){counters.authorized++;save('eligible',e);return true;}return false;
  }
  function arm(){
    unschedule(timer);if(stopped)return;
    const due=[...entries.values()].filter(e=>e.acked&&e.due!==null).map(e=>e.due);
    if(!due.length)return;
    timer=schedule(tick,Math.max(0,Math.min(...due)-mono()));timer?.unref?.();
  }
  function tick(){
    if(!open())return;
    if(!bridge.isReady()){stop('disconnected');return;}
    const at=mono();
    for(const e of entries.values()){
      if(!e.acked||e.due===null||at<e.due)continue;
      // One opportunity, never replay missed periods. Only live idle facts qualify.
      e.due=at+LIMITS.heartbeatMs;
      // Lose the idle lease before NPS's 45s timeout. A stalled scheduler must
      // not recreate an already expired source with a later pure heartbeat.
      if(at-e.lastAck<0||at-e.lastAck>=2*LIMITS.heartbeatMs){revoke(e,'expired');continue;}
      if(!baseEligible(e)){
        let reason='check_failed';
        try{reason=!same(e)?'identity_changed':e.pending.size?'pending_approval':e.agent.inbox.hasPending?'queued_input':'not_idle';}catch{}
        revoke(e,reason);continue;
      }
      if(e.busy)continue;
      void checkIdle(e).then(ok=>{
        if(!ok||e.confirmed!==e.epoch||!e.acked||!baseEligible(e)||!bridge.isReady())return;
        e.record={type:'session/heartbeat',identity:e.identity,turn:e.idleAnchor?.turn??0,seq:e.idleAnchor?.seq??0,time:now(),reason:null,epoch:e.epoch,pulse:++pulse};
        if(bridge.enqueueHeartbeat(e.record)){counters.idleHeartbeatsQueued++;save('heartbeat_queued',e);}
        else{e.record=null;save('queue_rejected',e);}
      }).catch(()=>{if(open())revoke(e,'check_failed');});
    }
    arm();
  }
  function acknowledge(input,result){
    const r=whitelist(input);if(!r)return;
    if(r.type==='turn/start'||r.type==='turn/end'){acknowledgeTask(r,result);return;}
    if(!eligible(r))return;
    const e=entries.get(r.identity);
    if(result?.outcome!=='acknowledged'||result.status!=='running'){
      // No successful readiness proof, or an unavailable/changed NPS state:
      // never re-post running to resurrect a closed or terminal session.
      revoke(e,'delivery_failed');return;
    }
    if(r.type==='session/resume'){confirmResume(e,r);return;}
    if(r.type==='session/ready'||r.type==='session/restored-ready'){
      if(e.acked)return;e.acked=true;e.lastAck=mono();e.due=mono()+LIMITS.heartbeatMs;save('ready_acknowledged',e);arm();
    }else{e.lastAck=mono();counters.idleHeartbeatsAcknowledged++;e.record=null;save('heartbeat_acknowledged',e);}
  }
  function resumeLive(e,c){
    if(!readState||!c||e.completed!==c||!c.start.acked||!c.acked||e.uncertain||!open()||!same(e)||!bridge.isReady()||e.pending.size)return false;
    try{return e.agent.status==='idle'&&e.agent.inbox.hasPending===false;}catch{return false;}
  }
  function matchesState(s,c,status,time){
    return !!s&&s.status===status&&s.taskId===`turn-${c.end.turn}`&&s.eventTime===time&&s.autoClosed===false&&
      (status==='running'?s.terminalSince===null:Number.isFinite(s.terminalSince)&&s.terminalSince<=now()&&Number.isSafeInteger(s.retentionMs)&&s.retentionMs>=0&&s.retentionMs<=3600000);
  }
  function rejectResume(e,c){if(e.completed===c){c.used=true;revoke(e,'resume_rejected');}}
  function considerResume(e){
    const c=e.completed;if(!c||c.used||!resumeLive(e,c))return;
    if(c.busy){c.rerun=true;return;}if(c.timer!==null)return;
    c.busy=true;c.rerun=false;counters.resumeChecks++;const version=e.epoch,abort=new AbortController();c.abort=abort;
    const valid=()=>!abort.signal.aborted&&version===e.epoch&&resumeLive(e,c);
    void (async()=>{
      if(!await checkIdle(e,undefined,x=>resumeLive(x,c))||!valid())return;
      const s=await readState(c.source,{signal:abort.signal});if(!valid())return;
      if(!matchesState(s,c,'finished',c.end.time)||(c.terminalSince!==null&&c.terminalSince!==s.terminalSince)){rejectResume(e,c);return;}
      c.terminalSince=s.terminalSince;
      const remaining=Math.max(s.terminalSince+s.retentionMs-now(),c.ackMono+s.retentionMs-mono());
      if(remaining>=0){
        save('completion_wait',e);
        c.timer=schedule(()=>{c.timer=null;if(valid())considerResume(e);},remaining+1);c.timer?.unref?.();return;
      }
      c.proofMono=mono();
      if(!await checkIdle(e,undefined,x=>resumeLive(x,c))||!valid()||e.confirmed!==e.epoch||mono()-c.proofMono>LIMITS.runningAgeMs)return;
      c.used=true;e.record={type:'session/resume',identity:e.identity,turn:c.end.turn,seq:c.end.seq,time:now(),reason:null,epoch:e.epoch};
      if(bridge.enqueue(e.record)){counters.queued++;save('resume_queued',e);}else rejectResume(e,c);
    })().catch(()=>{if(open())rejectResume(e,c);}).finally(()=>{
      c.busy=false;if(c.abort===abort)c.abort=null;
      if(c.rerun&&e.completed===c&&!c.used){c.rerun=false;considerResume(e);}
    });
  }
  function confirmResume(e,r){
    const c=e.completed;if(!c||c.confirming)return;c.confirming=true;
    const version=e.epoch,abort=new AbortController();c.abort=abort;
    void (async()=>{
      const s=await readState(c.source,{signal:abort.signal});
      if(abort.signal.aborted||e.epoch!==version||!eligible(r))return;
      if(!matchesState(s,c,'running',r.time)){rejectResume(e,c);return;}
      if(!await checkIdle(e,r,x=>resumeLive(x,c))||!eligible(r))return;
      e.idleAnchor={turn:c.end.turn,seq:c.end.seq};e.terminal=false;e.acked=true;e.lastAck=mono();e.due=mono()+LIMITS.heartbeatMs;e.record=null;
      counters.resumed++;save('resume_confirmed',e);arm();
    })().catch(()=>{if(open())rejectResume(e,c);}).finally(()=>{if(c.abort===abort)c.abort=null;});
  }
  function observeRecord(input,session){
    if(!readState||!open())return;const r=whitelist(input);if(!r||!['turn/start','turn/end'].includes(r.type))return;
    let e=lookup(session);
    if(!e&&r.type==='turn/start'){try{const a=getAgent(session.id);if(a?.session===session)created(a,'observed_task');}catch{}e=lookup(session);}
    if(!e||e.session!==session||!same(e)||e.identity!==r.identity)return;
    if(r.type==='turn/start'){
      if(e.startProof&&(r.turn<=e.startProof.record.turn||r.seq<=e.startProof.record.seq))return;
      cancelResume(e,true);e.turnSeen=true;e.terminal=false;e.startProof={record:r,acked:false};return;
    }
    const start=e.startProof;
    if(start&&(r.turn<start.record.turn||(e.completed&&r.turn===e.completed.end.turn&&r.seq<=e.completed.end.seq)))return;
    if(!start||start.record.turn!==r.turn||r.seq<=start.record.seq||r.reason!=='completed'){cancelResume(e,true);return;}
    e.completed={start,end:r,acked:false,source:null,ackMono:null,terminalSince:null,proofMono:null,used:false,timer:null,abort:null,busy:false,rerun:false,confirming:false};
  }
  function acknowledgeTask(r,result){
    if(!readState||!open())return;const e=entries.get(r.identity);if(!e||!same(e))return;
    const success=result?.outcome==='acknowledged';
    if(r.type==='turn/start'){
      const start=e.startProof;if(start&&['turn','seq','time'].every(k=>start.record[k]===r[k]))start.acked=success&&result.status==='working';return;
    }
    const c=e.completed;if(!c||!['turn','seq','time'].every(k=>c.end[k]===r[k])||!c.start.acked||!success||result.status!=='finished')return;
    if(typeof result.source!=='string'||!/^dsh:[0-9a-f]{16}:[0-9a-f]{32}$/.test(result.source)||!result.source.endsWith(':'+r.identity.slice(0,32)))return;
    if(c.acked)return;c.acked=true;c.source=result.source;c.ackMono=mono();considerResume(e);
  }
  function created(agent,source){
    if(!open())return;
    try{
      const session=agent.session,identity=identityFor(session);if(!/^[0-9a-f]{64}$/.test(identity??'')||getAgent(session.id)!==agent)return;
      const previous=entries.get(identity);
      if(previous){if(previous.agent!==agent||previous.session!==session)revoke(previous,'identity_changed');return;} // Duplicate creation never re-grants freshness.
      if(entries.size>=LIMITS.sessions){save('capacity');return;}
      const e={identity,agent,session,origin:source,leases:new Map(),approvalOwner:null,approvalRevision:0,epoch:++epoch,confirmed:0,fresh:false,turnSeen:false,terminal:false,pending:new Set(),offered:false,record:null,busy:false,cancelCheck:null,acked:false,lastAck:0,due:null,released:false,reason:'created',startProof:null,completed:null,idleAnchor:null,uncertain:false};
      entries.set(identity,e);save('created',e);
      if(source!=='startup'){revoke(e,'history_unknown');return;}
      e.fresh=true;save('fresh_startup',e);
      // DSH awaits agent/created listeners. Never await whenIdle in that dispatch.
      // The detached check revalidates this instance, turn and lifetime before use.
      void Promise.resolve().then(()=>{if(open())consider(e);}).catch(()=>{if(open())save('check_failed',e);});
    }catch{save('check_failed');}
  }
  function lookup(session){try{return entries.get(identityFor(session));}catch{return undefined;}}
  function sessionEvent(session,event){
    if(!open())return;
    try{
      const type=event.type;if(!['turn/start','turn/end','approval/asked','approval/decided'].includes(type))return;
      const e=lookup(session);if(!e||e.session!==session)return;
      if(type==='turn/start'||type==='turn/end'){
        const turn=event.data.turn,seq=event.seq,prior=e.startProof?.record,done=e.completed?.end;
        if(Number.isSafeInteger(turn)&&Number.isSafeInteger(seq)&&prior&&
          (turn<prior.turn||(type==='turn/start'&&turn===prior.turn&&seq<=prior.seq)||(type==='turn/end'&&done&&turn===done.turn&&seq<=done.seq)))return;
        if(type==='turn/start')e.startProof=null;
        e.turnSeen=true;
        if(type==='turn/end'&&['completed','error','aborted'].includes(event.data.reason?.kind))e.terminal=true;
        revoke(e,e.terminal?'terminal_locked':'turn_observed');return;
      }
      // Only pair opaque IDs to exclude pending approvals. Never map their outcomes.
      const id=event.data.id;if(typeof id!=='string'||!id.length||id.length>512){e.uncertain=true;e.fresh=false;revoke(e,'history_unknown');return;}
      const hash=createHash('sha256').update(id).digest('hex');
      if(type==='approval/asked'){
        if(e.pending.size>=16){e.uncertain=true;e.fresh=false;revoke(e,'history_unknown');return;}e.pending.add(hash);revoke(e,'pending_approval');
      }else{if(!e.pending.delete(hash)){e.uncertain=true;e.fresh=false;revoke(e,'history_unknown');}else consider(e);}
    }catch{save('check_failed');}
  }
  function release(session){const e=lookup(session);if(!e||e.session!==session)return;revoke(e,'released');clearLeases(e);e.pending.clear();e.released=true;e.agent=null;e.session=null;entries.delete(e.identity);save('released',e);}
  function attach(ctx){
    const listen=(name,fn)=>off.push(ctx.on(name,(...args)=>{if(!open())return;try{fn(...args);}catch{save('check_failed');}}));
    listen('api-session/interaction',interaction);
    listen('approval/pending-changed',({agent})=>{const e=lookup(agent.session);if(e?.agent===agent&&e.leases.size)invalidateInteraction(e,'pending_approval');});
    listen('agent/created',({agent,source})=>created(agent,source));
    listen('agent/status',({agent,status})=>{const e=lookup(agent.session);if(!e||e.agent!==agent)return;if(status!=='idle')revoke(e,'not_idle');else consider(e);});
    listen('agent/inbox/inserted',({agent})=>{const e=lookup(agent.session);if(e?.agent===agent)revoke(e,'queued_input');});
    listen('agent/inbox/discarded',({agent})=>{const e=lookup(agent.session);if(e?.agent===agent)consider(e);});
    listen('agent/disposed',({agent})=>release(agent.session));listen('session/disposed',release);
    // session/event is fed by the parent before its existing turn forwarder.
    ctx.effect(()=>()=>stop('unloaded'));return ()=>stop('unloaded');
  }
  save('mounted');
  return {attach,sessionEvent,observeRecord,considerAll:()=>{for(const e of entries.values())consider(e);},approvalUnavailable:()=>{if(open())for(const e of entries.values())if(e.leases.size)invalidateInteraction(e,'approval_unknown');},eligible,authorize,acknowledge,stop,snapshot};
}
