import fs from 'node:fs';import path from 'node:path';
const EVENTS=Object.freeze({
  parent:['listener_attached','message_entered','ready_received','ready_processing','ready_handled','ready_processing_failed','ready_callback_failed','start_timeout','timeout_before_ready','timeout_after_ready'],
  child:['listener_attached','init_received','ready_built','ready_send_called','ready_send_returned','ready_send_buffered','ready_callback','ready_callback_ok','ready_callback_failed','ready_send_threw','ready_disconnected','init_timeout']
});
// Fixed-size snapshots only. Diagnostics never own a timer or alter forwarding.
export function createHandshakeDiagnostics(base,role,{now=()=>Date.now(),mono=()=>performance.now(),io=fs}={}){
  const names=EVENTS[role];if(!names)throw new Error('invalid_diagnostic_role');
  const began=mono(),file=path.join(base,`handshake-${role}.json`),temporary=path.join(base,`handshake-${role}.tmp`);
  let stopped=false;
  const data={phase:'recording',stopReason:null,updates:0,writeFailures:0,startedUtc:now(),lastUtc:null,
    counters:Object.fromEntries(names.map(k=>[k,0])),times:Object.fromEntries(names.map(k=>[k,null])),elapsedMs:Object.fromEntries(names.map(k=>[k,null]))};
  function save(){try{const text=JSON.stringify(data);if(Buffer.byteLength(text)>4096)return;io.writeFileSync(temporary,text);io.renameSync(temporary,file);}catch{data.writeFailures=Math.min(1000,data.writeFailures+1);}}
  function finish(reason='owner_stopped'){
    if(stopped)return;stopped=true;data.phase='stopped';data.stopReason=['owner_stopped','capacity','time_limit'].includes(reason)?reason:'owner_stopped';data.lastUtc=now();save();
  }
  function mark(name){
    if(stopped||!names.includes(name))return;
    const elapsed=mono()-began;if(elapsed<0||elapsed>=600000){finish('time_limit');return;}
    data.updates++;data.counters[name]++;data.times[name]=now();data.elapsedMs[name]=elapsed;data.lastUtc=data.times[name];
    if(data.updates>=1000){finish('capacity');return;}save();
  }
  save();return {mark,finish,snapshot:()=>({...data,counters:{...data.counters},times:{...data.times},elapsedMs:{...data.elapsedMs}})};
}
