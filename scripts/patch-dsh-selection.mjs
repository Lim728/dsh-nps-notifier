// Companion adapter for the pinned, already compatible DSH 0.2.1-rc.2 build.
// Prepare every edit before writing; preserve originals outside the installation.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const marker='/* dsh-nps-selection-v2 */';
function once(text,from,to){
  if(text.split(from).length!==2)throw new Error('unsupported_dsh_companion_shape: '+from.slice(0,90));
  return text.replace(from,to);
}
function schemas(text){
  let count=0;
  text=text.replace(/(const \w*session_interaction_parameter_0(?:_strict)?\$schema\s*=.*?(?:z|zod\.z)\.(?:strictObject|object)\(\{)([\s\S]*?)(\}\)\)?;?)/g,(whole,head,body,tail)=>{
    count++;const z=head.includes('zod.z.')?'zod.z':'z';
    return head+body.replace(/(["']sessionId["']\s*:\s*[^,}]+)(,?)/,`$1, 'presentationOnly': ${z}.boolean().optional(), 'presentationFocused': ${z}.boolean().optional(),`)+tail;
  });
  if(count!==2)throw new Error('unsupported_dsh_interaction_codecs: '+count);
  // Keep generated introspection JSON schemas consistent with runtime codecs.
  let offset=0,patched=0;
  while(true){
    const at=text.indexOf('SessionInteractionRequest',offset);if(at<0)break;
    const schema=text.indexOf('jsonSchema:',at);if(schema<0)break;
    const start=text.indexOf('{',schema);let end=start,depth=0,quoted=false,escaped=false;
    for(;end<text.length;end++){
      const c=text[end];
      if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
      if(c==='"'){quoted=true;continue;}if(c==='{')depth++;if(c==='}'&&--depth===0)break;
    }
    const value=JSON.parse(text.slice(start,end+1));
    value.properties.presentationOnly={type:'boolean'};
    value.properties.presentationFocused={type:'boolean'};
    const json=JSON.stringify(value);text=text.slice(0,start)+json+text.slice(end+1);offset=start+json.length;patched++;
  }
  if(patched!==2)throw new Error('unsupported_dsh_interaction_json_schemas: '+patched);
  return text;
}
export function prepareSelectionPatches(packagesRoot){
  const files=[];
  function edit(relative,transform){
    const file=path.join(packagesRoot,relative),original=fs.readFileSync(file,'utf8');
    if(original.includes(marker)){files.push({relative,file,original,content:original,unchanged:true});return;}
    const content=transform(original);files.push({relative,file,original,content:marker+'\n'+content,unchanged:false});
  }
  edit('dsh-api-session-controller/lib/index.js',text=>{
    text=once(text,'async *open(sessionId, signal) {','async *open(sessionId, signal, presentationOnly = false, focused = false) {');
    text=once(text,'this.ctx.emit("api-session/interaction", {','this.ctx.emit(presentationOnly ? "api-session/presentation" : "api-session/interaction", {');
    text=once(text,'agent: accepted,\n\t\t\t\tsignal: life','agent: accepted,\n\t\t\t\tfocused: !presentationOnly || focused,\n\t\t\t\tsignal: life');
    return once(text,'this.interactions.open(request.sessionId, AbortSignal.any([signal, peer.signal]))','this.interactions.open(request.sessionId, AbortSignal.any([signal, peer.signal]), request.presentationOnly === true, request.presentationFocused === true)');
  });
  edit('dsh-api-session-controller/lib/client.js',text=>{
    text=once(text,'async interact(sessionId, signal) {','async interact(sessionId, signal, presentationOnly = false, presentationFocused = false) {');
    return once(text,'this.remote.session.interaction({ sessionId }, life)','this.remote.session.interaction({ sessionId, ...(presentationOnly ? { presentationOnly: true, presentationFocused } : {}) }, life)');
  });
  for(const relative of ['dsh-api-session-controller/lib/typert.host.js','dsh-api-session-controller/lib/typert.remote-client.js','dsh-api-remotes/lib/client.js'])edit(relative,schemas);
  edit('dsh-client-ui-workspace/lib/client.js',text=>{
    text=once(text,'\t\t\tinteraction;','\t\t\tinteraction;\n\t\t\tpresentation;');
    text=once(text,'\t\t\t\t\tconst stop = this.watchNavigation();',`\t\t\t\t\tconst stop = this.watchNavigation();
                    const refreshPresentation = () => this.presentMain();
                    const visible = () => { if (document.visibilityState === 'visible') refreshPresentation(); };
                    window.addEventListener('focus', refreshPresentation);
                    document.addEventListener('visibilitychange', visible);
                    const connection = this.sessions.rootCtx.connection;
                    const unsubscribeConnection = connection?.generation?.subscribe(() => { if (connection.generation.getSnapshot() !== void 0) refreshPresentation(); });`);
    text=once(text,'\t\t\t\t\t\tstop();',`\t\t\t\t\t\tstop();
                        window.removeEventListener('focus', refreshPresentation);
                        document.removeEventListener('visibilitychange', visible);
                        unsubscribeConnection?.();
                        this.presentation?.abort();`);
    text=once(text,'\t\t\tclearMain() {','\t\t\tclearMain() {\n                this.presentation?.abort();\n                this.presentation = void 0;');
    text=once(text,'\t\t\t\tthis.mainReference = reference;','\t\t\t\tthis.mainReference = reference;\n                this.presentMain();');
    return once(text,'\t\t\treplaceMain(target, signal, panel, beforeOpen) {',`            // Restore and browser focus update presentation only, never idle readiness.
            presentMain() {
                this.presentation?.abort();
                this.presentation = void 0;
                const reference = this.mainReference;
                if (!reference || this.lifetime.signal.aborted || this.sessions.subagentAddress(reference.sessionId)) return;
                const controller = new AbortController();
                this.presentation = controller;
                const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
                reference.ready.then(async () => {
                    if (!signal.aborted && this.mainReference === reference) await this.sessions.interact(reference.sessionId, signal, true, document.hasFocus());
                }).catch(() => controller.abort());
            }
\t\t\treplaceMain(target, signal, panel, beforeOpen) {`);
  });
  return files;
}
export function applySelectionPatches(packagesRoot,backupRoot){
  const files=prepareSelectionPatches(packagesRoot);
  for(const item of files){
    if(item.unchanged)continue;
    const backup=path.join(backupRoot,item.relative);fs.mkdirSync(path.dirname(backup),{recursive:true});
    if(fs.existsSync(backup))throw new Error('backup_already_exists: '+backup);
  }
  for(const item of files){
    if(item.unchanged)continue;
    fs.copyFileSync(item.file,path.join(backupRoot,item.relative));
    fs.writeFileSync(item.file,item.content,'utf8');
  }
  return files.map(({relative,unchanged})=>({file:relative,changed:!unchanged}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [packagesRoot,backupRoot]=process.argv.slice(2);
  if(!packagesRoot)throw new Error('usage: node scripts/patch-dsh-selection.mjs <@deepseek-ai directory> [backup-directory]');
  console.log(JSON.stringify(backupRoot?applySelectionPatches(packagesRoot,backupRoot):prepareSelectionPatches(packagesRoot).map(f=>({file:f.relative,changed:!f.unchanged})),null,2));
}
