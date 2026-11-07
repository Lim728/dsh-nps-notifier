import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {createSelectionController,normalizeTitle} from '../runtime/selection-controller.mjs';
import {Clock,flush,disposeFixtures} from './runtime-fixture.mjs';
import {prepareSelectionPatches} from '../scripts/patch-dsh-selection.mjs';

let passed=0;
const equal=(a,b)=>{assert.deepEqual(a,b);passed++;};
const ok=x=>{assert.ok(x);passed++;};
function fixture({send}={}){
  const clock=new Clock(),handlers=new Map(),sent=[],agents=new Map(),titles=new Map();
  const a={session:{id:'a'}},b={session:{id:'b'}};agents.set('a',a);agents.set('b',b);
  titles.set(a.session,'会话 A');titles.set(b.session,'会话 B');
  const ctx={on(name,fn){if(!handlers.has(name))handlers.set(name,new Set());handlers.get(name).add(fn);return ()=>handlers.get(name).delete(fn);}};
  const emit=(name,...args)=>{for(const fn of [...(handlers.get(name)??[])])fn(...args);};
  let ready=true,stopped=false;
  const bridge={isReady:()=>ready,snapshot:()=>({instance:'a'.repeat(16)})};
  const controller=createSelectionController({getAgent:id=>agents.get(id),getTitle:s=>titles.get(s),identityFor:s=>(s.id==='a'?'1':'2').repeat(64),bridge,
    transport:{send:async(p,o)=>{sent.push(p);return send?send(p,o):{ok:true};},stop(){stopped=true;}},schedule:clock.schedule,unschedule:clock.unschedule});
  controller.attach(ctx);
  const select=(agent,event='api-session/presentation',focused=true)=>{const life=new AbortController();emit(event,{agent,signal:life.signal,focused});return life;};
  return {clock,controller,emit,sent,a,b,agents,titles,select,setReady:v=>ready=v,stopped:()=>stopped};
}
try{
  equal(normalizeTitle('  中文\n名称\u202e  '),'中文 名称');
  ok(Buffer.byteLength(normalizeTitle('🙂'.repeat(100)))<=256);
  equal(normalizeTitle(null),'');
  const f=fixture(),lifeA=f.select(f.a);await flush();
  equal(f.sent.at(-1),{instance:'a'.repeat(16),revision:1,source:`dsh:${'a'.repeat(16)}:${'1'.repeat(32)}`,sessionTitle:'会话 A'});
  equal(Object.keys(f.sent[0]).sort(),['instance','revision','sessionTitle','source']);
  f.titles.set(f.a.session,'改名后的会话 A');f.emit('session/event',f.a.session,{type:'session/title'});await flush();
  equal(f.sent.at(-1).sessionTitle,'改名后的会话 A');equal(f.sent.at(-1).revision,2);
  const lifeB=f.select(f.b);lifeA.abort();await flush();
  equal(f.sent.at(-1).sessionTitle,'会话 B');
  const before=f.sent.length;f.emit('session/event',f.a.session,{type:'session/title'});await flush();equal(f.sent.length,before);
  f.clock.advance(15000);await flush();equal(f.sent.at(-1).revision,3);
  lifeB.abort();await flush();equal(f.sent.at(-1).source,null);equal(f.sent.at(-1).sessionTitle,'');
  f.controller.stop();ok(f.stopped());equal(f.clock.jobs.size,0);

  let release;const waiting=new Promise(resolve=>release=resolve);
  const q=fixture({send:async()=>{await waiting;return {ok:true};}});q.select(q.a);q.select(q.b);
  q.titles.set(q.b.session,'B 的最新名字');q.emit('session/event',q.b.session,{type:'session/title'});
  equal(q.sent.length,1);release();await flush();equal(q.sent.length,2);equal(q.sent[1].sessionTitle,'B 的最新名字');equal(q.sent[1].revision,3);q.controller.stop();

  let calls=0;const r=fixture({send:async()=>({ok:++calls>1})});const rlife=r.select(r.a);await flush();
  r.clock.advance(1000);await flush();equal(calls,2);equal(r.sent[0],r.sent[1]);rlife.abort();await flush();r.controller.stop();equal(r.clock.jobs.size,0);
  const late=fixture();late.setReady(false);late.select(late.a);await flush();equal(late.sent.length,0);
  late.setReady(true);late.controller.consider();await flush();equal(late.sent.length,1);
  late.agents.set('a',{session:{id:'a'}});late.emit('agent/created',{});await flush();equal(late.sent.at(-1).source,null);late.controller.stop();
  const multi=fixture();multi.select(multi.a);await flush();multi.select(multi.b,'api-session/presentation',false);await flush();
  equal(multi.sent.at(-1).sessionTitle,'会话 A');multi.select(multi.b);await flush();equal(multi.sent.at(-1).sessionTitle,'会话 B');multi.controller.stop();

  // Optional compatibility verification against a supplied, unmodified local
  // host. It prepares patches in memory and executes only the navigation class.
  if(process.env.DSH_SELECTION_PACKAGES){
    const files=prepareSelectionPatches(process.env.DSH_SELECTION_PACKAGES);
    const client=files.find(f=>f.relative==='dsh-client-ui-workspace/lib/client.js');
    const source=ts.createSourceFile('client.js',client.content,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    let klass;
    function visit(node){if(ts.isClassExpression(node)&&node.members.some(m=>m.name?.getText(source)==='presentMain'))klass=node;ts.forEachChild(node,visit);}
    visit(source);ok(klass);
    const Constructor=vm.runInNewContext('('+klass.getText(source)+')',{_deepseek_ai_cordis:{Service:class{}},AbortController,AbortSignal,document:{hasFocus:()=>true}});
    const navigation=Object.create(Constructor.prototype),calls=[];
    const refs=new Map(['A','B'].map(id=>[id,{sessionId:id,ready:Promise.resolve(),release(){}}]));
    navigation.lifetime=new AbortController();navigation.selection={set(){}};navigation.ctx={layout:{selectPanel(){}}};
    navigation.sessions={retain:id=>refs.get(id),subagentAddress:()=>undefined,interact:async(id,signal,presentationOnly)=>{calls.push({id,signal,presentationOnly});}};
    navigation.replaceMain('A',navigation.lifetime.signal,'preserve');await flush();
    equal(calls.at(-1).id,'A');equal(calls.at(-1).presentationOnly,true);
    navigation.replaceMain('B',navigation.lifetime.signal,'preserve');await flush();
    ok(calls[0].signal.aborted);equal(calls.at(-1).id,'B');
    navigation.presentMain();await flush();ok(calls[1].signal.aborted);equal(calls.at(-1).id,'B');
    navigation.clearMain();ok(calls.at(-1).signal.aborted);
    const require=createRequire(import.meta.url),z=createRequire(require.resolve('@deepseek-ai/dsh-agent/package.json'))('zod').z;
    for(const file of files.filter(f=>f.relative.endsWith('typert.host.js')||f.relative.endsWith('typert.remote-client.js')||f.relative==='dsh-api-remotes/lib/client.js')){
      const declarations=file.content.match(/const \w*session_interaction_parameter_0(?:_strict)?\$schema\s*=.*?(?:z|zod\.z)\.(?:strictObject|object)\(\{[\s\S]*?\}\)\)?;?/g);
      equal(declarations.length,2);
      for(const declaration of declarations){
        const name=declaration.match(/const (\S+)\s*=/)[1],cache=name+'$value';
        const schema=new Function('z','zod',`let ${cache};${declaration};return ${name}();`)(z,{z});
        equal(schema.parse({sessionId:'a',presentationOnly:true}),{sessionId:'a',presentationOnly:true});
        equal(schema.parse({sessionId:'a'}),{sessionId:'a'});
      }
    }
  }
  console.log(JSON.stringify({suite:'selected conversation titles and companion navigation',passed,failed:0,hostVerified:!!process.env.DSH_SELECTION_PACKAGES}));
}finally{disposeFixtures();}
