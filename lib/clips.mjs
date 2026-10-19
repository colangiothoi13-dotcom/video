import {MAX_CLIP_TOTAL_SECONDS} from './validation.mjs';
const fail=code=>Object.assign(new Error(code),{code});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export const clipFilename=index=>`clip-${String(index+1).padStart(2,'0')}.mp4`;

/** Validate a manual export against the selected saved video; never silently change its source. */
export function validateClipRequest(body,job) {
 if(!exact(body,['source','subtitleVersion','dubbingVersion','ranges'])||!['source','video','dubbed'].includes(body.source)||!Number.isInteger(body.subtitleVersion)||body.subtitleVersion<0||!Number.isInteger(body.dubbingVersion)||body.dubbingVersion<0)throw fail('INVALID_CLIPS');
 if(body.subtitleVersion!==job.subtitleVersion)throw fail('VERSION_CONFLICT');
 if(body.source==='dubbed'&&body.dubbingVersion!==(job.dubbing?.version??0))throw fail('DUBBING_VERSION_CONFLICT');
 if(body.source==='video'&&(!job.renderedVersion||job.renderedVersion!==job.subtitleVersion))throw fail('CLIP_SOURCE_UNAVAILABLE');
 if(body.source==='dubbed'&&(!job.dubbingOutput||job.dubbingOutput.subtitleVersion!==job.subtitleVersion||job.dubbingOutput.version!==job.dubbing?.version))throw fail('CLIP_SOURCE_UNAVAILABLE');
 if(!Number.isFinite(job.duration)||job.duration<=0||!Array.isArray(body.ranges)||!body.ranges.length||body.ranges.length>20)throw fail('INVALID_CLIPS');
 let total=0;
 const ranges=body.ranges.map(r=>{
  if(!exact(r,['start','end'])||!Number.isFinite(r.start)||!Number.isFinite(r.end)||r.start<0||r.end-r.start<0.25-1e-9||r.end>job.duration)throw fail('INVALID_CLIPS');
  total+=r.end-r.start;return {start:r.start,end:r.end};
 });
 if(total>MAX_CLIP_TOTAL_SECONDS+1e-9)throw fail('INVALID_CLIPS');
 return {source:body.source,subtitleVersion:body.subtitleVersion,dubbingVersion:body.dubbingVersion,ranges};
}

export function clipSourceArtifact(job,request) {
 const file=job.artifacts?.[{source:'inputPath',video:'videoPath',dubbed:'dubbedPath'}[request.source]];
 if(typeof file!=='string'||!file)throw fail('CLIP_SOURCE_UNAVAILABLE');return file;
}
