import http from 'node:http';
import {LIMITS} from './forward-core.mjs';
export function createHttpTransport({request=http.request,port=17877,timeoutMs=LIMITS.timeoutMs,schedule=setTimeout,unschedule=clearTimeout}={}){
  let closed=false,cancelActive;
  function send(payload,{signal}={}){return new Promise(resolve=>{
    if(closed||signal?.aborted||cancelActive){resolve({ok:false,retry:false});return;}
    let settled=false,timer,req;
    const finish=r=>{if(settled)return;settled=true;unschedule(timer);signal?.removeEventListener('abort',cancel);if(cancelActive===cancel)cancelActive=null;resolve(r);};
    const cancel=()=>{finish({ok:false,retry:false});req?.destroy();};
    cancelActive=cancel;signal?.addEventListener('abort',cancel,{once:true});
    try{
      const body=JSON.stringify(payload);
      req=request({hostname:'127.0.0.1',port,path:'/notify',method:'POST',agent:false,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
        let text='',bytes=0;res.setEncoding('utf8');
        res.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>4096){finish({ok:false,retry:false});res.destroy();}else text+=chunk;});
        res.on('end',()=>{const code=res.statusCode??0;
          if(code>=200&&code<300){try{const v=JSON.parse(text);finish({ok:v.ok===true&&v.source===payload.source&&v.status===payload.status&&(payload.heartbeat!==true||v.heartbeat===true),retry:false});}catch{finish({ok:false,retry:false});}}
          else finish({ok:false,retry:code>=500&&code<=599});
        });res.on('error',()=>finish({ok:false,retry:true}));
      });
      timer=schedule(()=>{finish({ok:false,retry:true});req?.destroy();},timeoutMs);
      req.on('error',()=>finish({ok:false,retry:true}));req.end(body);
    }catch{finish({ok:false,retry:false});req?.destroy();}
  });}
  function stop(){closed=true;cancelActive?.();}
  return {send,stop};
}
