import fs from 'node:fs';
import path from 'node:path';

/** Diagnostics have no ownership of forwarding, session state, or timers. */
export const RECORD_LIMITS = Object.freeze({windowMs:600000, rows:1000, bytes:1048576, segments:3, snapshotBytes:16384});

/** Replace one fixed-size diagnostic snapshot; report failure without throwing. */
export function writeSnapshot(base, name, value, io=fs) {
  if(!/^[a-z][a-z-]{0,40}$/.test(name))return false;
  try {
    const text=JSON.stringify(value)+'\n';
    if(Buffer.byteLength(text)>RECORD_LIMITS.snapshotBytes)return false;
    io.mkdirSync(base,{recursive:true});
    const file=path.join(base,name+'.json'),temporary=path.join(base,name+'.tmp');
    if([file,temporary].some(p=>io.existsSync(p)&&io.lstatSync(p).isSymbolicLink()))return false;
    io.writeFileSync(temporary,text);io.renameSync(temporary,file);return true;
  } catch (error) { return false; /* Diagnostic failure cannot revoke live state. */ }
}

/** Bounded ring of sanitized records. Existing files never prevent activation. */
export function createRecorder(base, stream, {io=fs,mono=()=>performance.now(),limits=RECORD_LIMITS,onFailure=()=>{}}={}) {
  if(!['events','delivery'].includes(stream))throw new Error('invalid_record_stream');
  const cap={...RECORD_LIMITS,...limits};
  for(const key of ['windowMs','rows','bytes','segments'])if(!Number.isSafeInteger(cap[key])||cap[key]<1)throw new Error('invalid_record_limit');
  let slot=-1,rows=0,bytes=0,began=mono(),rotations=0,failures=0,disabled=false,closed=false;
  function fail(){failures=Math.min(1000000,failures+1);disabled=true;try{onFailure('diagnostic_write_failed');}catch(error){/* Failure reporting does not own forwarding. */}}
  try {
    const meta=path.join(base,stream+'-ring.json');
    if(io.existsSync(meta)&&!io.lstatSync(meta).isSymbolicLink()&&io.statSync(meta).size<=4096){
      const previous=JSON.parse(io.readFileSync(meta,'utf8'));
      if(Number.isInteger(previous.slot)&&previous.slot>=0&&previous.slot<cap.segments)slot=previous.slot;
    }
  } catch(error){ /* An unreadable diagnostic cursor does not restore service state. */ }
  function rotate(){
    slot=(slot+1)%cap.segments;rows=0;bytes=0;began=mono();rotations++;
    const file=path.join(base,`${stream}-${slot}.jsonl`);
    io.mkdirSync(base,{recursive:true});
    if(io.existsSync(file)&&io.lstatSync(file).isSymbolicLink())throw new Error('diagnostic_symlink');
    io.writeFileSync(file,'');
    if(!writeSnapshot(base,stream+'-ring',{slot,rows,bytes,rotations},io))throw new Error('diagnostic_cursor_failed');
  }
  function append(record){
    if(closed||disabled)return false;
    try {
      const text=JSON.stringify(record)+'\n',size=Buffer.byteLength(text);
      if(size>cap.bytes){fail();return false;}
      if(slot<0||rows===0&&rotations===0||rows>=cap.rows||bytes+size>cap.bytes||mono()-began>=cap.windowMs||mono()<began)rotate();
      io.appendFileSync(path.join(base,`${stream}-${slot}.jsonl`),text);
      rows++;bytes+=size;
      if(!writeSnapshot(base,stream+'-ring',{slot,rows,bytes,rotations},io))throw new Error('diagnostic_cursor_failed');
      return true;
    }catch(error){fail();return false;}
  }
  return {append,stop(){closed=true;},snapshot:()=>({slot,rows,bytes,rotations,writeFailures:failures,disabled,closed})};
}
