// Bounded /state projection. Never return or persist labels, messages or paths.
import http from 'node:http';
import {LIMITS} from './forward-core.mjs';
export function projectState(value,source){
  if(value?.ok!==true||!Number.isSafeInteger(value.finishedWidgetRetentionSec)||value.finishedWidgetRetentionSec<0||value.finishedWidgetRetentionSec>3600||!Array.isArray(value.sessions)||value.sessions.length>4096)return null;
  const rows=value.sessions.filter(row=>row?.source===source);if(rows.length!==1)return null;
  const row=rows[0];
  if(!['running','working','finished','error','closed','idle','waiting_approval'].includes(row.status)||typeof row.taskId!=='string'||!/^turn-[1-9]\d{0,15}$/.test(row.taskId)||typeof row.autoClosed!=='boolean'||typeof row.eventTime!=='string'||(row.terminalSinceUtc!==null&&typeof row.terminalSinceUtc!=='string'))return null;
  const eventTime=Date.parse(row.eventTime),terminalSince=row.terminalSinceUtc===null?null:Date.parse(row.terminalSinceUtc);
  if(!Number.isFinite(eventTime)||(terminalSince!==null&&!Number.isFinite(terminalSince)))return null;
  return {status:row.status,taskId:row.taskId,eventTime,terminalSince,autoClosed:row.autoClosed,retentionMs:value.finishedWidgetRetentionSec*1000};
}
export function createStateReader({request=http.request,port=17877,schedule=setTimeout,unschedule=clearTimeout}={}){
  let stopped=false,reads=0;const active=new Set();
  function attempt(source,signal){return new Promise(resolve=>{
    let settled=false,req,timer,text='',bytes=0;
    const finish=(result,retry=false)=>{if(settled)return;settled=true;unschedule(timer);signal.removeEventListener('abort',cancel);text='';resolve({result,retry});};
    const cancel=()=>{finish(null);req?.destroy();};
    if(signal.aborted){finish(null);return;}signal.addEventListener('abort',cancel,{once:true});
    try{
      req=request({hostname:'127.0.0.1',port,path:'/state',method:'GET',agent:false},res=>{
        res.setEncoding('utf8');res.on('data',chunk=>{if(settled)return;bytes+=Buffer.byteLength(chunk);if(bytes>1048576){finish(null);res.destroy();}else text+=chunk;});
        res.on('end',()=>{if(settled)return;const code=res.statusCode??0;
          if(code>=200&&code<300){try{finish(projectState(JSON.parse(text),source));}catch{finish(null);}}
          else finish(null,code>=500&&code<=599);
        });res.on('error',()=>finish(null,true));
      });
      timer=schedule(()=>{finish(null,true);req?.destroy();},LIMITS.timeoutMs);
      req.on('error',()=>finish(null,true));req.end();
    }catch{finish(null);req?.destroy();}
  });}
  function pause(signal){return new Promise(resolve=>{
    if(signal.aborted){resolve(false);return;}let timer;
    const cancel=()=>{unschedule(timer);signal.removeEventListener('abort',cancel);resolve(false);};
    signal.addEventListener('abort',cancel,{once:true});timer=schedule(()=>{signal.removeEventListener('abort',cancel);resolve(true);},100);
  });}
  async function read(source,{signal}={}){
    if(stopped||signal?.aborted||active.size>=LIMITS.sessions||!/^dsh:[0-9a-f]{16}:[0-9a-f]{32}$/.test(source??''))return null;
    reads++;const ctrl=new AbortController(),cancel=()=>ctrl.abort();active.add(ctrl);signal?.addEventListener('abort',cancel,{once:true});
    try{for(let i=0;i<=LIMITS.retries;i++){
      const result=await attempt(source,ctrl.signal);if(stopped||ctrl.signal.aborted)return null;
      if(result.result||!result.retry||i===LIMITS.retries)return result.result;
      if(!await pause(ctrl.signal))return null;
    }}finally{signal?.removeEventListener('abort',cancel);active.delete(ctrl);}
    return null;
  }
  function stop(){stopped=true;for(const ctrl of active)ctrl.abort();}
  return {read,stop};
}
