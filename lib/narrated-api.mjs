import express from 'express';
import path from 'node:path';
import {rm} from 'node:fs/promises';
import {createNarratedStore,narratedBusy} from './narrated-store.mjs';
import {createNarratedPipeline,narratedSettings,currentClip,currentAssembly,safeError,failure,within} from './narrated-pipeline.mjs';
import {readConfig as defaultReadConfig} from './config.mjs';
import {validateSourceUrl} from './validation.mjs';

const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function keys(v,allowed,required=allowed){if(!object(v)||Object.keys(v).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(v,k)))throw failure('NARRATED_INVALID');}
function publicProject(p){
 const base=`/api/narrated/projects/${encodeURIComponent(p.id)}/files/`;
 return {id:p.id,title:p.title,sourceUrl:p.sourceUrl,aspectRatio:p.aspectRatio,duration:p.duration,status:p.status,error:p.error?safeError(p.error):null,busy:narratedBusy(p),scenes:p.scenes.map(s=>({id:s.id,start:s.start,end:s.end,transcriptText:s.transcriptText,title:s.title,visual:s.visual,prompt:s.prompt,version:s.version,status:s.status,error:s.error?safeError(s.error):null,stale:Boolean(s.artifact&&!currentClip(s)),...(s.artifact?{videoUrl:`${base}${s.id}?v=${encodeURIComponent(s.artifact.token)}`} : {}),history:s.history.map(h=>({id:h.id,version:h.version,prompt:h.prompt,effectivePrompt:h.effectivePrompt,model:h.model??h.videoModel,videoModel:h.videoModel??h.model,status:h.status,createdAt:h.createdAt,...(h.completedAt?{completedAt:h.completedAt}:{}),...(h.error?{error:safeError(h.error)}:{}),...(h.artifact?{videoUrl:`${base}${s.id}?generation=${encodeURIComponent(h.id)}`} : {})}))})),assembly:{status:p.assembly.status,error:p.assembly.error?safeError(p.assembly.error):null,stale:Boolean(p.assembly.artifact&&!currentAssembly(p)),...(p.assembly.artifact?{videoUrl:`${base}video?v=${encodeURIComponent(p.assembly.artifact.token)}`} : {})},createdAt:p.createdAt,updatedAt:p.updatedAt};
}

/** Mounted after existing loopback/origin and bounded JSON guards. */
export function createNarratedApi({dataDir=path.resolve(process.env.DATA_DIR||'.data'),readConfig=()=>defaultReadConfig({dataDir}),tools={}}={}){
 dataDir=path.resolve(dataDir);const root=path.join(dataDir,'narrated'),store=createNarratedStore(path.join(dataDir,'narrated.sqlite'));store.recover();
 const pipeline=createNarratedPipeline({store,root,readConfig,tools}),router=express.Router();let closing=false,closePromise;
 const settings=()=>narratedSettings(readConfig);
 function configured(){const c=settings();if(!c.apiKey)throw failure('AI_NOT_CONFIGURED');if(!c.videoApiKey)throw failure('AI_VIDEO_NOT_CONFIGURED');return c;}
 function project(id){const p=store.get(id);if(!p)throw failure('NARRATED_NOT_FOUND',404);return p;}
 function scene(p,id){const s=p.scenes.find(s=>s.id===id);if(!s)throw failure('NARRATED_NOT_FOUND',404);return s;}
 function idle(p){if(narratedBusy(p))throw failure('NARRATED_BUSY',409);}
 function planned(p){if(!p.windows?.length||p.scenes.length!==p.windows.length)throw failure('NARRATED_INCOMPLETE_PLAN',409);}
 function version(s,v){if(!Number.isInteger(v)||s.version!==v)throw failure('NARRATED_VERSION_CONFLICT',409);}
 router.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');next(closing?failure('NARRATED_CLOSED',503):undefined);});
 router.get('/',(req,res)=>{const c=settings();res.json({configured:Boolean(c.apiKey),videoConfigured:Boolean(c.videoApiKey),provider:c.provider,videoModel:c.videoModel,projects:store.list().map(publicProject)});});
 router.post('/projects',(req,res)=>{
  keys(req.body,['url','aspectRatio'],['url']);const sourceUrl=validateSourceUrl(req.body.url),aspectRatio=req.body.aspectRatio??'9:16';if(!['9:16','16:9'].includes(aspectRatio))throw failure('NARRATED_INVALID');configured();const p=store.create({sourceUrl,aspectRatio});res.status(202).json({project:publicProject(p)});pipeline.kick();
 });
 router.get('/projects/:id',(req,res)=>res.json({project:publicProject(project(req.params.id))}));
 router.put('/projects/:id/scenes/:sceneId',(req,res)=>{
  keys(req.body,['version','prompt']);if(typeof req.body.prompt!=='string'||!req.body.prompt.trim()||req.body.prompt.length>6000||req.body.prompt.includes('\0'))throw failure('NARRATED_INVALID');
  const p=store.mutate(req.params.id,p=>{idle(p);planned(p);const s=scene(p,req.params.sceneId);version(s,req.body.version);const prompt=req.body.prompt.trim();if(prompt===s.prompt)return;s.prompt=prompt;s.version++;s.status='draft';s.error=null;s.operation=null;p.status='ready';p.error=null;p.request=null;});res.json({project:publicProject(p)});
 });
 router.post('/projects/:id/scenes/:sceneId/generate',(req,res)=>{
  keys(req.body,['version']);const c=settings();if(!c.videoApiKey)throw failure('AI_VIDEO_NOT_CONFIGURED');const p=store.mutate(req.params.id,p=>{idle(p);planned(p);const s=scene(p,req.params.sceneId);version(s,req.body.version);s.status='draft';s.error=null;s.operation=null;p.status='queued';p.error=null;p.request={type:'scene',sceneId:s.id};});res.status(202).json({project:publicProject(p)});pipeline.kick();
 });
 router.post('/projects/:id/render',(req,res)=>{
  keys(req.body,[],[]);const p=store.mutate(req.params.id,p=>{idle(p);planned(p);if(!p.scenes.length||!p.scenes.every(currentClip))throw failure('NARRATED_MISSING_CLIPS',409);p.status='queued';p.error=null;p.request={type:'render'};});res.status(202).json({project:publicProject(p)});pipeline.kick();
 });
 router.post('/projects/:id/resume',(req,res)=>{
  keys(req.body,[],[]);const p=store.mutate(req.params.id,p=>{idle(p);if(p.status!=='failed')throw failure('NARRATED_INVALID',409);const c=settings(),request=p.request??{type:'auto'};if(request.type!=='render'&&(!c.videoApiKey||request.type==='auto'&&!c.apiKey))configured();p.status='queued';p.error=null;p.request=request;});res.status(202).json({project:publicProject(p)});pipeline.kick();
 });
 router.delete('/projects/:id',async(req,res)=>{
  const p=project(req.params.id);idle(p);store.delete(p.id);const directory=path.resolve(root,p.id);if(!within(root,directory))throw failure('NARRATED_INVALID');await rm(directory,{recursive:true,force:true});res.json({ok:true});
 });
 router.get('/projects/:id/files/:kind',async(req,res)=>{
  const p=project(req.params.id),kind=req.params.kind;let file;const generation=req.query.generation,v=req.query.v;
  if(generation!==undefined&&(typeof generation!=='string'||! /^[0-9a-f-]{36}$/i.test(generation)))throw failure('NARRATED_FILE_NOT_FOUND',404);
  if(v!==undefined&&typeof v!=='string')throw failure('NARRATED_FILE_NOT_FOUND',404);
  if(kind==='source'&&generation===undefined&&v===undefined)file=p.source?.inputPath;
  else if(kind==='video'&&generation===undefined&&(!v||v===p.assembly.artifact?.token))file=p.assembly.artifact?.path;
  else if(/^scene-[1-9]\d*$/.test(kind)){const s=scene(p,kind);if(generation!==undefined)file=s.history.find(h=>h.id===generation&&h.status==='completed')?.artifact?.path;else if(v!==undefined)file=[s.artifact,...s.history.map(h=>h.artifact)].find(a=>a?.token===v)?.path;else file=s.artifact?.path;}
  if(!file)throw failure('NARRATED_FILE_NOT_FOUND',404);let resolved;try{resolved=await pipeline.owned(p.id,file);}catch{throw failure('NARRATED_FILE_NOT_FOUND',404);}
  if(kind==='source')res.type(path.extname(resolved)||'application/octet-stream');else res.type('video/mp4');const directory=path.dirname(resolved);res.sendFile(path.basename(resolved),{root:directory,dotfiles:'deny',acceptRanges:true},error=>{if(error){if(res.headersSent)res.destroy();else if(error.status===416)res.status(416).end();else res.status(404).json({error:safeError(failure('NARRATED_FILE_NOT_FOUND'))});}});
 });
 router.use((req,res,next)=>next(failure('NARRATED_NOT_FOUND',404)));
 router.use((error,req,res,next)=>{if(res.headersSent)return next(error);const safe=safeError(error);res.status(safe.code==='NARRATED_INTERNAL'?500:error.status??400).json({error:safe});});
 router.close=()=>{if(!closePromise){closing=true;closePromise=(async()=>{await pipeline.close();store.close();})();}return closePromise;};
 return router;
}
