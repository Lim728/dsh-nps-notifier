import fs from 'node:fs';
import path from 'node:path';
import {writeSnapshot} from './recorder.mjs';

const LIMIT = Object.freeze({ms:600000, rows:1000, bytes:1048576});
const STAGES = new Set(['mounted','registry','published','global_subscriber','subscriber','observer','accepted','rejected','enqueue','ack','agent_created','agent_status','idle_after_event']);
const TYPES = new Set(['turn/start','turn/end','agent/created','agent/status']);
const REASONS = new Set(['none','not_live','invalid_fields','identity_or_order','capacity','unpaired_end','interrupted','exception','stopped','queued','not_queued','startup','restored','unknown','completed','error','aborted','blocked','max-tokens']);
const OUTCOMES = new Set(['acknowledged','expired','failed','rejected','unknown']);
const STATUS = new Set(['idle','running','working','finished','error','closed']);
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null;
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const bool = value => typeof value === 'boolean' ? value : null;

/** One explicit capture request, never renewed by a later mount or record limit. */
export function createReceptionCapture(ctx,{base,identityFor,getAgent,getInstance,getControl,now=()=>Date.now(),mono=()=>performance.now(),schedule=setTimeout,unschedule=clearTimeout,io=fs}={}) {
  let dir;
  try {
    const requestFile=path.join(base,'reception-request.json');
    if(!io.existsSync(requestFile)||io.lstatSync(requestFile).isSymbolicLink()||io.statSync(requestFile).size>1024)return null;
    const request=JSON.parse(io.readFileSync(requestFile,'utf8'));
    if(!/^[a-f0-9]{16}$/.test(request.id)||!Number.isSafeInteger(request.expires)||request.expires<=now()||request.expires-now()>LIMIT.ms)return null;
    dir=path.join(base,'reception-'+request.id);
    io.mkdirSync(dir); // Existing evidence means this request has already been used.
  } catch(error) { return null; /* No capture is safer than overwriting prior evidence. */ }
  const began=mono(),off=[];
  const state={started:now(),pid:process.pid,stopped:false,reason:null,rows:0,bytes:0,writeFailures:0,counts:{}};
  let timer;
  function save(){if(!writeSnapshot(dir,'status',state,io))state.writeFailures=Math.min(1000,state.writeFailures+1);}
  function stop(reason='unloaded'){
    if(state.stopped)return;state.stopped=true;state.reason=reason;unschedule(timer);
    for(const dispose of off.splice(0))try{dispose();}catch(error){/* Diagnostic disposal cannot affect forwarding. */}
    save();
  }
  function mark(stage,session,event=null,reason='none',extra={}) {
    if(state.stopped||!STAGES.has(stage))return;
    if(mono()-began>=LIMIT.ms||mono()<began){stop('time_limit');return;}
    try {
      const identity=session?digest(identityFor(session)):null;
      const agent=session?getAgent(session.id):null;
      const registeredIdentity=agent?.session?digest(identityFor(agent.session)):null;
      const instance=getInstance();
      const control=identity?getControl()?.sessions?.find(e=>e.identity===identity):null;
      const type=TYPES.has(event?.type)?event.type:null;
      const record={stage,time:now(),eventTime:integer(event?.time),type,identity,registeredIdentity,
        source:identity&&/^[a-f0-9]{16}$/.test(instance??'')?`dsh:${instance}:${identity.slice(0,32)}`:null,
        turn:integer(event?.data?.turn),seq:integer(event?.seq),reason:REASONS.has(reason)?reason:'unknown',
        registered:!!agent,sameSession:agent?agent.session===session:null,
        agentStatus:STATUS.has(agent?.status)?agent.status:null,hasPending:bool(agent?.inbox?.hasPending),
        idleAcknowledged:bool(control?.runningAcknowledged),idleEpoch:integer(control?.epoch),
        terminalLocked:bool(control?.terminalLocked),pendingApprovals:integer(control?.pending),
        result:extra.outcome===undefined?null:OUTCOMES.has(extra.outcome)?extra.outcome:'unknown',
        resultStatus:STATUS.has(extra.status)?extra.status:null};
      const text=JSON.stringify(record)+'\n',size=Buffer.byteLength(text);
      if(state.rows>=LIMIT.rows||state.bytes+size>LIMIT.bytes){stop('capacity_limit');return;}
      io.appendFileSync(path.join(dir,'records.jsonl'),text);
      state.rows++;state.bytes+=size;state.counts[stage]=(state.counts[stage]??0)+1;save();
      if(state.rows>=LIMIT.rows)stop('capacity_limit');
    } catch(error) { state.writeFailures++;stop('write_or_projection_failed'); }
  }
  function lifecycle(stage,{agent,source,status}) {
    mark(stage,agent?.session,{type:stage==='agent_created'?'agent/created':'agent/status'},source??status??'none');
  }
  try {
    // This tap establishes publication independently of the ordinary subscription filter.
    off.push(ctx.on('internal/dispatch',(_mode,name,args)=>{
      if(name==='session/event'&&['turn/start','turn/end'].includes(args[1]?.type))mark('published',args[0],args[1]);
    },{global:true}));
    off.push(ctx.on('session/event',(session,event)=>{
      if(['turn/start','turn/end'].includes(event.type))mark('global_subscriber',session,event);
    },{global:true}));
    off.push(ctx.on('agent/created',payload=>lifecycle('agent_created',payload),{global:true}));
    off.push(ctx.on('agent/status',payload=>lifecycle('agent_status',payload),{global:true}));
    timer=schedule(()=>stop('time_limit'),LIMIT.ms);timer?.unref?.();
    mark('mounted');
  } catch(error) { stop('subscription_failed'); }
  return {mark,stop,registry(agents){for(const agent of agents){if(state.stopped)break;mark('registry',agent.session);}},snapshot:()=>({...state,counts:{...state.counts}})};
}
