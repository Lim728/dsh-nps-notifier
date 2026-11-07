// Display metadata has its own lane: it never creates or revives a task.
export const SELECTION_LIMITS=Object.freeze({heartbeatMs:15000,titleBytes:256,leases:64});
export function normalizeTitle(value){
  if(typeof value!=='string')return '';
  const text=value.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/gu,' ').trim();
  let title='';
  for(const character of text){if(Buffer.byteLength(title+character,'utf8')>SELECTION_LIMITS.titleBytes)break;title+=character;}
  return title.trim();
}
export function createSelectionController({getAgent,getTitle,identityFor,bridge,transport,schedule=setTimeout,unschedule=clearTimeout}){
  const leases=new Map(),off=[];
  let stopped=false,serial=0,revision=0,current=null,desired=null,pending=null,busy=false,timer,retryTimer,abort;
  const live=e=>{try{return e.agent.session===e.session&&getAgent(e.session.id)===e.agent;}catch{return false;}};
  const titleFor=e=>{try{return normalizeTitle(getTitle(e.session));}catch{return '';}};
  function arm(){unschedule(timer);if(!stopped&&current){timer=schedule(()=>{update();send();},SELECTION_LIMITS.heartbeatMs);timer?.unref?.();}}
  async function drain(){
    if(stopped||busy||!pending||!bridge.isReady())return;
    const payload=pending;pending=null;busy=true;abort=new AbortController();
    let ok=false;
    try{ok=(await transport.send(payload,{signal:abort.signal}))?.ok===true;}catch{/* NPS availability cannot affect DSH. */}
    finally{
      busy=false;abort=null;
      if(!stopped){
        if(pending)void drain();
        else if(!ok&&payload.revision===revision){
          unschedule(retryTimer);retryTimer=schedule(()=>{send();},1000);retryTimer?.unref?.();
        }
      }
    }
  }
  function send(){
    if(stopped||!desired)return;
    unschedule(retryTimer);
    const instance=bridge.snapshot().instance;
    if(!/^[0-9a-f]{16}$/.test(instance??''))return;
    pending={instance,revision,source:desired.identity?`dsh:${instance}:${desired.identity.slice(0,32)}`:null,sessionTitle:desired.title};
    void drain();
  }
  function update(){
    if(stopped)return;
    const next=[...leases.values()].filter(e=>!e.signal.aborted&&live(e)).sort((a,b)=>Number(b.focused)-Number(a.focused)||b.serial-a.serial)[0]??null;
    let identity=null,title='';
    if(next){try{identity=identityFor(next.session);}catch{}if(!/^[0-9a-f]{64}$/.test(identity??''))return;title=titleFor(next);}
    current=next;
    if(!desired||desired.identity!==identity||desired.title!==title){desired={identity,title};revision++;send();}
    arm();
  }
  function attach(ctx){
    const listen=(name,fn)=>off.push(ctx.on(name,(...args)=>{if(!stopped)try{fn(...args);}catch{}}));
    const selected=({agent,signal,focused=true})=>{
      if(!agent||!signal||signal.aborted||typeof signal.addEventListener!=='function'||leases.has(signal)||leases.size>=SELECTION_LIMITS.leases)return;
      const entry={agent,session:agent.session,signal,focused:focused===true,serial:++serial};if(!live(entry))return;
      const release=()=>{signal.removeEventListener('abort',release);leases.delete(signal);update();};
      entry.release=release;leases.set(signal,entry);signal.addEventListener('abort',release,{once:true});update();
    };
    // Legacy explicit opens remain useful; presentation is a separate signal so
    // restore/focus never grants the running controller any idle eligibility.
    listen('api-session/presentation',selected);listen('api-session/interaction',selected);
    listen('session/event',(session,event)=>{if(event?.type==='session/title'&&current?.session===session)update();});
    const disposed=session=>{for(const e of [...leases.values()])if(e.session===session)e.release();};
    listen('session/disposed',disposed);listen('agent/disposed',({agent})=>disposed(agent.session));
    listen('agent/created',()=>{for(const e of [...leases.values()])if(!live(e))e.release();});
  }
  function stop(){
    if(stopped)return;stopped=true;unschedule(timer);unschedule(retryTimer);abort?.abort();transport.stop();pending=null;current=null;desired=null;
    for(const e of leases.values())e.signal.removeEventListener('abort',e.release);leases.clear();for(const dispose of off.splice(0))dispose();
  }
  return {attach,stop,consider:()=>{if(!stopped&&desired)send();},snapshot:()=>({stopped,leases:leases.size,revision,busy,pending:!!pending})};
}
