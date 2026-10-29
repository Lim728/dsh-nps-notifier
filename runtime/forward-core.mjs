// Pure forwarding policy. No network at import; transport is injected.
export const LIMITS=Object.freeze({sessions:8,queue:16,ageMs:5000,timeoutMs:500,retries:1,heartbeatMs:15000,heartbeatAgeMs:2000,runningAgeMs:2000});
const TERMINAL_STATUS=Object.freeze({completed:'finished',error:'error',aborted:'closed'});
const keys=['type','identity','turn','seq','time','reason'];
export function whitelist(r){
  const ready=['session/ready','session/restored-ready'].includes(r?.type),resume=r?.type==='session/resume',idle=r?.type==='session/heartbeat',session=ready||idle||resume;
  const allowed=idle?[...keys,'epoch','pulse']:ready||resume?[...keys,'epoch']:r?.type==='heartbeat'?[...keys,'pulse']:keys;
  if(!r||typeof r!=='object'||Object.keys(r).some(k=>!allowed.includes(k)))return null;
  if(!['turn/start','turn/end','heartbeat','session/ready','session/restored-ready','session/heartbeat','session/resume'].includes(r.type)||typeof r.identity!=='string'||! /^[0-9a-f]{64}$/.test(r.identity))return null;
  if(!Number.isSafeInteger(r.turn)||r.turn<(session?0:1)||!Number.isSafeInteger(r.seq)||r.seq<0||!Number.isSafeInteger(r.time)||r.time<0)return null;
  if(session&&(!Number.isSafeInteger(r.epoch)||r.epoch<1))return null;
  if(ready&&(r.turn!==0||r.seq!==0))return null;
  if(resume&&(r.turn<1||r.seq<1))return null;
  if(idle&&((r.turn===0)!==(r.seq===0)))return null;
  if(r.type!=='turn/end'&&r.reason!==null)return null;
  if((r.type==='heartbeat'||idle)&&(!Number.isSafeInteger(r.pulse)||r.pulse<1))return null;
  if(r.type==='turn/end'&&!['completed','aborted','error','blocked','max-tokens','unknown','interrupted'].includes(r.reason))return null;
  return Object.fromEntries(allowed.map(k=>[k,r[k]]));
}
export function createForwarder({instance,transport,authorizeHeartbeat=async()=>false,authorizeRunning=async()=>false,now=()=>Date.now(),mono=()=>performance.now(),wait=ms=>new Promise(r=>setTimeout(r,ms))}){
  if(!/^[0-9a-f]{16}$/.test(instance))throw new Error('invalid instance');
  const seen=new Map(),sessions=new Map(),revoked=new Map(),latestStarts=new Map(),readyUsed=new Set(),readyBlocked=new Set(),readyAck=new Map(),idleRevoked=new Map(),began=mono();let stopped=false,current=null;
  const open=()=>!stopped;
  const fresh=r=>now()-r.time>=(['heartbeat','session/ready','session/restored-ready','session/resume','session/heartbeat'].includes(r.type)?0:-1000)&&now()-r.time<=(['session/ready','session/restored-ready','session/resume'].includes(r.type)?LIMITS.runningAgeMs:['heartbeat','session/heartbeat'].includes(r.type)?LIMITS.heartbeatAgeMs:LIMITS.ageMs);
  // A transient loss of idle cancels this generation, without granting a new
  // initial readiness or clearing the permanent task/terminal fence.
  function pauseRunning(identity,epoch){
    if(!/^[0-9a-f]{64}$/.test(identity??'')||!Number.isSafeInteger(epoch)||epoch<1)return;
    if(!idleRevoked.has(identity)&&idleRevoked.size>=LIMITS.sessions){return;}
    idleRevoked.set(identity,Math.max(idleRevoked.get(identity)??0,epoch));
    if(['session/heartbeat','session/restored-ready'].includes(current?.record.type)&&current.record.identity===identity&&current.record.epoch<=epoch)current.abort.abort();
  }
  function revokeRunning(identity){
    if(!/^[0-9a-f]{64}$/.test(identity??''))return;
    if(!readyBlocked.has(identity)&&readyBlocked.size>=LIMITS.sessions){return;}
    readyBlocked.add(identity);readyAck.delete(identity);
    if(['session/ready','session/restored-ready','session/resume','session/heartbeat'].includes(current?.record.type)&&current.record.identity===identity)current.abort.abort();
  }
  // New starts can arrive while an older HTTP request or retry is pending.
  // Observe only identity/turn/sequence; do not mark a start acknowledged here.
  function observeStart(input){
    const r=whitelist(input);if(!r||r.type!=='turn/start'||!open()||!fresh(r))return false;
    const processed=sessions.get(r.identity);
    if(processed&&(r.turn<=processed.turn||r.seq<=processed.seq))return false;
    const prior=latestStarts.get(r.identity);
    if(prior&&(r.turn<=prior.turn||r.seq<=prior.seq))return false;
    if(!prior&&latestStarts.size>=LIMITS.sessions)return false;
    latestStarts.set(r.identity,{turn:r.turn,seq:r.seq});
    revokeRunning(r.identity);
    if(current?.record.identity===r.identity&&current.record.turn<r.turn)current.abort.abort();
    return true;
  }
  const superseded=r=>r.turn<(latestStarts.get(r.identity)?.turn??0);
  function revoke(identity,turn,seq){
    if(!/^[0-9a-f]{64}$/.test(identity??'')||!Number.isSafeInteger(turn)||turn<1||!Number.isSafeInteger(seq)||seq<0)return;
    if(!revoked.has(identity)&&revoked.size>=LIMITS.sessions){return;}
    revoked.set(identity,Math.max(revoked.get(identity)??0,turn));
    if(current?.record.type==='heartbeat'&&current.record.identity===identity&&current.record.turn<=turn)current.abort.abort();
  }
  function release(identity){
    if(current?.record.identity===identity)current.abort.abort();
    for(const collection of [seen,sessions,revoked,latestStarts,readyUsed,readyBlocked,readyAck,idleRevoked])collection.delete(identity);
  }
  function stop(){stopped=true;current?.abort.abort();seen.clear();sessions.clear();revoked.clear();latestStarts.clear();readyUsed.clear();readyBlocked.clear();readyAck.clear();idleRevoked.clear();}
  async function accept(input){
    const r=whitelist(input);if(!r)return {outcome:'invalid',attempts:0};
    const hb=r.type==='heartbeat',restored=r.type==='session/restored-ready',ready=r.type==='session/ready'||restored,idle=r.type==='session/heartbeat',resume=r.type==='session/resume';
    const source=`dsh:${instance}:${r.identity.slice(0,32)}`,base={source,turn:r.turn,seq:r.seq,eventTime:r.time,...(hb||idle?{heartbeat:true,pulse:r.pulse}:{}),...(idle?{epoch:r.epoch}:{})};
    const done=(outcome,attempts=0,status=null)=>({...base,outcome,attempts,status});
    if(!open())return done('stopped');
    if(current)return done('busy');
    if(!fresh(r))return done('expired');
    if(r.type==='turn/start'){
      observeStart(r);
      if(!latestStarts.has(r.identity))return done('session_limit');
    }
    if(superseded(r))return done('superseded');
    let water=seen.get(r.identity);
    if(!water){if(seen.size>=LIMITS.sessions)return done('session_limit');water={};seen.set(r.identity,water);}
    const lane=restored?'restored':resume?'resume':idle?'idle':ready?'ready':hb?'workingHeartbeat':'task';
    const cursor=resume||ready?r.epoch:idle||hb?r.pulse:r.seq;
    if(cursor<=(water[lane]??-1))return done('duplicate');
    water[lane]=cursor;
    let s=sessions.get(r.identity),status,completion;
    const sameCompletion=c=>!!c&&!s?.active&&s?.completed===c&&c.turn===r.turn&&c.seq===r.seq&&s.turn===r.turn&&s.seq===r.seq&&latestStarts.get(r.identity)?.turn===r.turn;
    const idleValid=()=>{const ack=readyAck.get(r.identity);return !!ack&&ack.turn===r.turn&&ack.seq===r.seq&&r.epoch>=ack.epoch&&mono()-ack.at>=0&&mono()-ack.at<2*LIMITS.heartbeatMs&&r.epoch>(idleRevoked.get(r.identity)??0)&&!readyBlocked.has(r.identity)&&(r.turn===0?(!s&&!latestStarts.has(r.identity)):sameCompletion(s?.completed));};
    if(ready){
      if(readyBlocked.has(r.identity)||(!restored&&readyUsed.has(r.identity))||r.epoch<=(idleRevoked.get(r.identity)??0)||sessions.has(r.identity)||latestStarts.has(r.identity))return done('ineligible');
      if(readyUsed.size>=LIMITS.sessions)return done('session_limit');
      if(!restored)readyUsed.add(r.identity);status='running';
    }else if(resume){
      completion=s?.completed;
      if(!sameCompletion(completion)||completion.used)return done('ineligible');
      completion.used=true;status='running';
    }else if(idle){
      if(!idleValid())return done('ineligible');status='running';
    }else if(hb){
      if(!s?.active||s.active.turn!==r.turn||s.active.seq!==r.seq||!s.active.workingAcknowledged)return done('ineligible');
      if((revoked.get(r.identity)??0)>=r.turn)return done('revoked');
      status='working';
    }else{
      if(!s){if(sessions.size>=LIMITS.sessions)return done('session_limit');s={seq:-1,turn:0,active:null};sessions.set(r.identity,s);}
      if(r.seq<=s.seq)return done('out_of_order');s.seq=r.seq;
      if(r.type==='turn/start'){
        if(r.turn<=s.turn)return done('old_turn');
        s.completed=null;s.turn=r.turn;s.active={turn:r.turn,seq:r.seq,workingAcknowledged:false};status='working';
      }else{
        const a=s.active;
        if(!a||a.turn!==r.turn||r.seq<=a.seq)return done('orphan_end');
        s.active=null;
        const terminal=TERMINAL_STATUS[r.reason];
        if(!terminal)return done('non_completed');
        if(!a.workingAcknowledged)return done('start_unacknowledged');
        status=terminal;
      }
    }
    const payload={source,displayName:'DSH',...(ready||idle?{}:{taskId:`turn-${r.turn}`}),status,timestamp:new Date(r.time).toISOString(),...(hb||idle?{heartbeat:true}:{})};
    const job={record:r,abort:new AbortController()};current=job;
    let attempts=0;
    const valid=()=>!job.abort.signal.aborted&&(!resume||sameCompletion(completion))&&(!idle||idleValid())&&(!ready||(!readyBlocked.has(r.identity)&&r.epoch>(idleRevoked.get(r.identity)??0)&&!sessions.has(r.identity)&&!latestStarts.has(r.identity)))&&(!hb||(s.active?.turn===r.turn&&s.active?.seq===r.seq&&s.active.workingAcknowledged&&(revoked.get(r.identity)??0)<r.turn));
    try{
      for(let attempt=0;attempt<=LIMITS.retries;attempt++){
        if(!open()||!fresh(r))return done('expired',attempts,status);
        if(superseded(r))return done('superseded',attempts,status);
        if(!valid())return done('revoked',attempts,status);
        if(hb||ready||idle||resume){
          let allowed=false;try{allowed=await (ready||idle||resume?authorizeRunning(r):authorizeHeartbeat(r));}catch{}
          if(!allowed||!valid())return done('revoked',attempts,status);
          if(!open()||!fresh(r))return done('expired',attempts,status);
        }
        attempts++;
        let result;try{result=await transport(payload,{signal:job.abort.signal});}catch{result={ok:false,retry:true};}
        if(stopped)return done('stopped',attempts,status);
        if(superseded(r))return done('superseded',attempts,status);
        if(!valid())return done('revoked',attempts,status);
        if(result?.ok===true){
          if(ready||resume){readyAck.set(r.identity,{epoch:r.epoch,at:mono(),turn:r.turn,seq:r.seq});if(resume)readyBlocked.delete(r.identity);}
          if(r.type==='turn/end'&&status==='finished')s.completed={turn:r.turn,seq:r.seq,used:false};
          if(idle)readyAck.get(r.identity).at=mono();
          if(!hb&&status==='working'&&s.active?.turn===r.turn)s.active.workingAcknowledged=true;
          return done('acknowledged',attempts,status);
        }
        if(!result?.retry||attempt===LIMITS.retries)return done('delivery_failed',attempts,status);
        await wait(100);
      }
    }finally{if(current===job)current=null;}
  }
  return {accept,observeStart,revoke,revokeRunning,pauseRunning,release,stop,snapshot(){return {seen:seen.size,sessions:sessions.size,stopped};}};
}
