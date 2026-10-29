// Live objects stay in this process. Only sanitized records cross the bridge.
import {LIMITS, whitelist} from './forward-core.mjs';
export function createHeartbeatController({getAgent, bridge, now=()=>Date.now(), mono=()=>performance.now(),
  schedule=setTimeout, unschedule=clearTimeout}) {
  const entries=new Map(), began=mono();
  let timer, stopped=false, pulse=0;
  const counts={generated:0,revoked:0,skipped:0};
  const windowOpen=()=>!stopped;
  function remove(e) { e.signal?.removeEventListener('abort',e.abort);entries.delete(e.identity); }
  function revoke(e) { if(!e)return;remove(e);counts.revoked=Math.min(1000,counts.revoked+1);bridge.revoke(e.identity,e.turn,e.seq); }
  function stop() { if(stopped)return;stopped=true;unschedule(timer);for(const e of [...entries.values()])revoke(e); }
  function live(e) {
    try{return windowOpen()&&bridge.isReady()&&getAgent(e.session.id)===e.agent&&e.agent.session===e.session&&e.agent.status==='running';}
    catch{return false;}
  }
  function eligible(r) {
    const e=entries.get(r.identity);
    return !!e&&e.turn===r.turn&&e.seq===r.seq&&e.ack&&!!e.signal&&!e.signal.aborted&&live(e);
  }
  function arm() {
    unschedule(timer);if(stopped||!entries.size)return;
    const due=Math.min(...[...entries.values()].map(e=>e.due));
    timer=schedule(tick,Math.max(0,due-mono()));timer?.unref?.();
  }
  function tick() {
    if(!windowOpen()){stop();return;}
    const at=mono();
    for(const e of [...entries.values()]) {
      if(at<e.due)continue;
      // No catch-up: the next opportunity is 15 seconds after this check.
      e.due=at+LIMITS.heartbeatMs;
      if(!live(e)){revoke(e);continue;}
      if(!eligible(e)){counts.skipped=Math.min(1000,counts.skipped+1);continue;}
      const r={type:'heartbeat',identity:e.identity,turn:e.turn,seq:e.seq,time:now(),reason:null,pulse:++pulse};
      if(bridge.enqueueHeartbeat(r))counts.generated++;
    }
    arm();
  }
  function start(input,session) {
    const r=whitelist(input);if(!r||r.type!=='turn/start'||!windowOpen())return;
    const old=entries.get(r.identity);if(old)revoke(old);
    if(entries.size>=LIMITS.sessions)return;
    let agent;try{agent=getAgent(session.id);}catch{return;}
    if(!agent||agent.session!==session)return;
    entries.set(r.identity,{identity:r.identity,turn:r.turn,seq:r.seq,session,agent,ack:false,signal:null,abort:null,due:mono()+LIMITS.heartbeatMs});arm();
  }
  function acknowledge(r,result) {
    const e=entries.get(r.identity);
    if(e&&r.type==='turn/start'&&e.turn===r.turn&&e.seq===r.seq)
      e.ack=result?.outcome==='acknowledged'&&result.status==='working';
  }
  function preStep(payload,next) {
    // Never inspect messages, alter a decision, or await I/O in the execution chain.
    try {
      if(windowOpen())for(const e of entries.values()) {
        if(e.agent!==payload.agent||e.turn!==payload.turn)continue;
        const signal=payload.signal;
        if(!signal||typeof signal.addEventListener!=='function')continue;
        if(e.signal&&e.signal!==signal){revoke(e);break;}
        if(!e.signal){e.signal=signal;e.abort=()=>{revoke(e);arm();};signal.addEventListener('abort',e.abort,{once:true});}
        if(signal.aborted){revoke(e);arm();}
        break;
      }
    }catch{}
    return next();
  }
  function end(session,event) {
    if(event.type!=='turn/end')return;
    const turn=event.data.turn;
    for(const e of [...entries.values()])if(e.session===session&&e.turn===turn)revoke(e);
    arm();
  }
  function disposed(agent) {for(const e of [...entries.values()])if(e.agent===agent)revoke(e);arm();}
  function status(agent,value) {if(value==='idle')disposed(agent);}
  return {start,acknowledge,preStep,end,disposed,status,eligible,stop,
    snapshot:()=>({...counts,active:entries.size,stopped})};
}
