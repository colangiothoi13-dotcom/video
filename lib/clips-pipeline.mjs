import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rename,rm,stat} from 'node:fs/promises';
import {validateClipRequest,clipFilename} from './clips.mjs';
import {cutVideoClip} from './clips-media.mjs';
const failure=code=>Object.assign(new Error(code),{code});
const within=(root,file)=>{const rel=path.relative(root,file);return rel!==''&&rel!=='..'&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel);};

/** Cut a captured saved artifact with the existing queue's cancellation and publication fences. */
export async function runClipsTask({store,id,job,directory,usage,step,check,write,read,tool,signal,abort}) {
 const request=job.clipsRequest;
 const body={source:request.source,subtitleVersion:request.subtitleVersion,dubbingVersion:request.dubbingVersion,ranges:request.ranges};
 function guard(){
  check();const current=read();
  if(current.status==='expired'||(current.expiresAt&&Date.parse(current.expiresAt)<=Date.now()))throw failure('JOB_EXPIRED');
  validateClipRequest(body,current);
 }
 guard();let source,root;
 try {root=await realpath(directory);source=await realpath(request.sourcePath);if(!within(root,source)||!(await stat(source)).isFile())throw failure('CLIP_INVALID_INPUT');}
 catch{throw failure('CLIP_INVALID_INPUT');}
 const cut=tool.cutVideoClip??cutVideoClip;
 const scratch=await mkdtemp(path.join(directory,'.clips-'));let published,committed=false;
 try {
  const clips=[],total=request.ranges.reduce((sum,r)=>sum+r.end-r.start,0);let processed=0;
  for(const [index,range]of request.ranges.entries()) {
   guard();const outputPath=path.join(scratch,clipFilename(index));
   const metadata=await step('render',()=>cut({inputPath:source,outputPath,...range,signal,onProgress:fraction=>{
    if(!Number.isFinite(fraction))return;
    try{guard();write({progress:Math.floor(99*(processed+Math.min(1,Math.max(0,fraction))*(range.end-range.start))/total)});}catch(error){abort(error);}
   }}));guard();
   if(!(await stat(outputPath)).size||!Number.isFinite(metadata?.duration)||metadata.duration<=0)throw failure('CLIP_MEDIA_FAILED');
   clips.push({index,start:range.start,end:range.end,duration:metadata.duration});processed+=range.end-range.start;
  }
  const token=randomUUID();published=path.join(directory,`clips-${token}`);await rename(scratch,published);guard();
  write({status:'completed',stage:'done',progress:100,error:null,clipsRequest:null,usage,artifacts:{clipsDirectory:published},clipsOutput:{token,source:request.source,subtitleVersion:request.subtitleVersion,dubbingVersion:request.dubbingVersion,clips}},{expectedStatuses:['running'],requireUnexpired:true,requireNotCancelled:true,expectedSubtitleVersion:request.subtitleVersion,...(request.source==='dubbed'?{expectedDubbingVersion:request.dubbingVersion}:{})});committed=true;
  // Old batch URLs are superseded. Remove only the previous, confined batch directory.
  const previous=job.artifacts.clipsDirectory;
  if(previous&&previous!==published){try{const old=await realpath(previous);if(within(root,old)&&/^clips-[0-9a-f-]{36}$/.test(path.basename(old)))await rm(old,{recursive:true,force:true});}catch{}}
 }finally{
  await rm(scratch,{recursive:true,force:true}).catch(()=>{});
  if(published&&!committed)await rm(published,{recursive:true,force:true}).catch(()=>{});
 }
}
