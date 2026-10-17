import express from 'express';
import Busboy from 'busboy';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {mkdir, rm, realpath, stat} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import * as settings from './config.mjs';
import * as media from './media.mjs';
import {testAiConnection} from './ai.mjs';
import {MAX_UPLOAD_BYTES,validateJobOptions,validateSourceUrl} from './validation.mjs';
import {normalizeCues,toSrt} from './subtitles.mjs';

const messages={
  FORBIDDEN:'Yêu cầu phải đến từ ứng dụng trên máy này.',INVALID_REQUEST:'Dữ liệu yêu cầu không hợp lệ.',
  INVALID_SETTINGS:'Cấu hình không hợp lệ.',INVALID_GEMINI_MODEL:'Mô hình dịch phải là tên Gemini, ví dụ gemini-3.5-flash-lite.',INVALID_OPTIONS:'Ngôn ngữ hoặc kiểu phụ đề không hợp lệ.',
  INVALID_SOURCE_URL:'Liên kết video không được hỗ trợ. Hãy dùng liên kết YouTube hoặc Facebook công khai.',
  INVALID_JOB:'Trạng thái công việc không hợp lệ.',JOB_NOT_FOUND:'Không tìm thấy công việc.',
  JOB_EXPIRED:'Kết quả đã hết hạn lưu trữ 24 giờ.',JOB_BUSY:'Công việc đang xếp hàng hoặc đang xử lý.',
  JOB_STATE_CONFLICT:'Trạng thái công việc đã thay đổi. Vui lòng tải lại trước khi thử lại.',
  INVALID_CUES:'Phụ đề phải có nội dung và vừa tối đa hai dòng, mỗi dòng 42 ký tự.',
  VERSION_CONFLICT:'Phụ đề đã thay đổi. Vui lòng tải lại trước khi lưu.',
  VIDEO_TOO_LARGE:'Video vượt giới hạn tải lên 500.000.000 byte.',BODY_TOO_LARGE:'Dữ liệu yêu cầu quá lớn.',
  AI_NOT_CONFIGURED:'Hãy nhập API key trong Cài đặt trước khi xử lý video.',
  TOOLS_UNAVAILABLE:'Công cụ xử lý video chưa sẵn sàng. Hãy chạy npm run setup.',
  URL_TOOL_UNAVAILABLE:'Công cụ tải liên kết chưa sẵn sàng. Hãy chạy npm run setup hoặc tải video từ máy.',
  FILE_NOT_FOUND:'Tệp chưa sẵn sàng hoặc không còn tồn tại.',AI_AUTH:'API key không hợp lệ hoặc đã hết hạn.',
  AI_MODEL_ACCESS:'Không có quyền truy cập mô hình đã chọn. Hãy kiểm tra Cài đặt.',
  AI_RATE_LIMIT:'API đang giới hạn tần suất. Vui lòng thử lại sau.',AI_QUOTA:'Tài khoản API không còn hạn mức.',
  AI_CONNECTION:'Không thể kết nối dịch vụ AI. Hãy kiểm tra mạng rồi thử lại.',
  AI_TIMEOUT:'Dịch vụ AI phản hồi quá lâu. Vui lòng thử lại.',AI_UNAVAILABLE:'Dịch vụ AI tạm thời không sẵn sàng.',
  INTERNAL_ERROR:'Không thể hoàn tất yêu cầu. Vui lòng thử lại.',
};
const failure=(code,status=400)=>Object.assign(new Error(messages[code]),{code,status});
const within=(root,file)=>{const relative=path.relative(root,file);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};

/** Parse a bounded multipart stream directly to disk; never enqueue a partial upload. */
async function receiveUpload(req,dataDir,maxBytes) {
  if(!req.is('multipart/form-data'))throw failure('INVALID_REQUEST');
  const directory=path.join(dataDir,'uploads',randomUUID());
  await mkdir(directory,{recursive:true});
  const destination=path.join(directory,'input');const fields=Object.create(null);const writes=[];
  let fileInfo=null,parser,settled=false;
  try {
    await new Promise((resolve,reject)=>{
      const fail=error=>{
        if(settled)return;settled=true;req.unpipe(parser);parser.destroy();req.pause();
        for(const write of writes)write.stream.destroy();reject(error);
      };
      try {parser=Busboy({headers:req.headers,limits:{fileSize:maxBytes+1,files:1,fields:3,fieldSize:4096,fieldNameSize:32,parts:4}});}catch {reject(failure('INVALID_REQUEST'));return;}
      parser.on('file',(name,file,info)=>{
        if(name!=='video'||fileInfo){file.resume();fail(failure('INVALID_REQUEST'));return;}
        let size=0;const output=createWriteStream(destination,{flags:'wx',mode:0o600});
        fileInfo={path:destination,originalName:path.win32.basename(path.posix.basename(info.filename||'video')).slice(0,255),size:0};
        file.on('data',chunk=>{size+=chunk.length;fileInfo.size=size;if(size>maxBytes)fail(failure('VIDEO_TOO_LARGE',413));});
        file.on('limit',()=>fail(failure('VIDEO_TOO_LARGE',413)));
        const promise=pipeline(file,output);promise.catch(()=>{});writes.push({stream:output,promise});
      });
      parser.on('field',(name,value,info)=>{
        if(!['url','language','style'].includes(name)||name in fields||info.valueTruncated||info.nameTruncated)fail(failure('INVALID_REQUEST'));
        else fields[name]=value;
      });
      for(const event of ['filesLimit','fieldsLimit','partsLimit'])parser.on(event,()=>fail(failure('INVALID_REQUEST')));
      parser.on('error',()=>fail(failure('INVALID_REQUEST')));
      req.once('aborted',()=>fail(failure('INVALID_REQUEST')));
      parser.on('close',()=>{if(!settled){settled=true;resolve();}});req.pipe(parser);
    });
    await Promise.all(writes.map(item=>item.promise));
    if((fileInfo?1:0)+(fields.url?.trim()?1:0)!==1||fileInfo?.size===0)throw failure('INVALID_REQUEST');
    return {fields,file:fileInfo,directory};
  } catch(error) {
    await Promise.allSettled(writes.map(item=>item.promise));await rm(directory,{recursive:true,force:true});throw error;
  }
}

/** Local, single-user HTTP boundary. No raw configuration or disk paths leave this router. */
export function createApi({store,config={},dataDir=path.resolve(process.env.DATA_DIR||'.data'),tools={}}={}) {
  if(!store)throw new TypeError('API cần kho dữ liệu.');
  dataDir=path.resolve(dataDir);const router=express.Router();
  const options={dataDir,...(config.env?{env:config.env}:{})};
  const read=()=>config.readConfig?config.readConfig(options):settings.readConfig(options);
  const status=()=>{const value=read();return {provider:settings.AI_PROVIDER,configured:Boolean(value.apiKey),translationModel:value.translationModel,transcriptionModel:settings.DEFAULT_TRANSCRIPTION_MODEL};};
  const write=patch=>{(config.writeConfig??settings.writeConfig)(patch,options);return status();};
  const tool={...media,...tools};let cachedTools=null,cacheUntil=0;
  async function toolHealth(){if(!cachedTools||Date.now()>=cacheUntil){cachedTools=Promise.resolve().then(()=>tool.getToolStatus()).then(value=>{
    const result={};for(const key of ['ffmpeg','ffprobe','ytdlp','font'])if(value[key]){const entry={available:value[key].available===true};if(typeof value[key].version==='string')entry.version=value[key].version.slice(0,300);for(const flag of ['subtitles','ejs'])if(typeof value[key][flag]==='boolean')entry[flag]=value[key][flag];result[key]=entry;}return result;
  }).catch(()=>({ffmpeg:{available:false},ffprobe:{available:false},ytdlp:{available:false}}));cacheUntil=Date.now()+60000;}return cachedTools;}
  function liveJob(job){if(!job)throw failure('JOB_NOT_FOUND',404);if(job.status==='expired'||(job.expiresAt&&Date.parse(job.expiresAt)<=Date.now()))throw failure('JOB_EXPIRED',410);return job;}
  function requireJob(id){return liveJob(store.getJob(id));}
  function cueSnapshot(id){const snapshot=store.getCueSnapshot(id);liveJob(snapshot.job);return snapshot;}
  const jsonObject=body=>body&&typeof body==='object'&&!Array.isArray(body);
  router.use((req,res,next)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    if(['GET','HEAD','OPTIONS'].includes(req.method))return next();
    try {
      const host=req.headers.host;if(!host||! /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host))throw failure('FORBIDDEN',403);
      const origin=req.headers.origin;if(origin&&origin!==`http://${host}`)throw failure('FORBIDDEN',403);
      if(req.headers['sec-fetch-site']==='cross-site')throw failure('FORBIDDEN',403);
      next();
    }catch(error){next(error);}
  });
  router.use(express.json({limit:'1mb',strict:true}));
  router.get('/health',async(req,res)=>res.json({ok:true,...status(),worker:store.getWorkerStatus(),tools:await toolHealth()}));
  router.get('/settings',(req,res)=>res.json(status()));
  router.put('/settings',(req,res)=>{if(!jsonObject(req.body)||Object.keys(req.body).some(key=>!['apiKey','translationModel'].includes(key)))throw failure('INVALID_SETTINGS');res.json(write(req.body));});
  router.post('/settings/test',async(req,res)=>{
    const credentials=read();if(!credentials.apiKey)throw failure('AI_NOT_CONFIGURED');
    const result=await (tools.testAiConnection??testAiConnection)({apiKey:credentials.apiKey,model:credentials.translationModel,transcriptionModel:settings.DEFAULT_TRANSCRIPTION_MODEL,signal:AbortSignal.timeout(30000)});
    res.json({ok:result.ok===true,provider:settings.AI_PROVIDER,translationModel:result.translationModel??credentials.translationModel,transcriptionModel:result.transcriptionModel??settings.DEFAULT_TRANSCRIPTION_MODEL});
  });
  router.get('/jobs',(req,res)=>res.json({jobs:store.listJobs(req.query.status)}));
  router.post('/jobs',async(req,res)=>{
    if(!read().apiKey)throw failure('AI_NOT_CONFIGURED');
    const health=await toolHealth();if(!health.ffmpeg?.available||!health.ffprobe?.available||health.ffmpeg.subtitles===false||health.font?.available===false)throw failure('TOOLS_UNAVAILABLE',503);
    let upload;
    try {
      upload=await receiveUpload(req,dataDir,Math.min(MAX_UPLOAD_BYTES,config.maxUploadBytes??MAX_UPLOAD_BYTES));
      const jobOptions=validateJobOptions(upload.fields);const sourceUrl=upload.fields.url?validateSourceUrl(upload.fields.url):null;
      if(sourceUrl&&(!health.ytdlp?.available||health.ytdlp.ejs===false))throw failure('URL_TOOL_UNAVAILABLE',503);
      const file=upload.file;
      const job=store.createJob({...jobOptions,sourceType:file?'upload':'url',sourceUrl,title:file?.originalName||'Video từ liên kết',...(file?{artifacts:{inputPath:file.path},upload:file}:{})});
      if(!file)await rm(upload.directory,{recursive:true,force:true});res.status(202).json({job});
    }catch(error){if(upload)await rm(upload.directory,{recursive:true,force:true});throw error;}
  });
  router.get('/jobs/:id',(req,res)=>res.json(cueSnapshot(req.params.id)));
  router.put('/jobs/:id/subtitles',(req,res)=>{
    const job=requireJob(req.params.id),body=req.body;
    if(!jsonObject(body)||Object.keys(body).some(key=>!['version','cues'].includes(key))||!Array.isArray(body.cues)||!body.cues.length)throw failure('INVALID_CUES');
    if(body.version!==job.subtitleVersion)throw failure('VERSION_CONFLICT',409);
    const existing=store.getCues(job.id);if(body.cues.length!==existing.length)throw failure('INVALID_CUES');
    const mapped=body.cues.map((cue,index)=>{
      const old=existing[index];if(!jsonObject(cue)||Object.keys(cue).some(key=>!['id','text'].includes(key))||cue.id!==old.id||typeof cue.text!=='string')throw failure('INVALID_CUES');
      const normalized=normalizeCues([{...old,text:cue.text}],job.duration);
      if(normalized.length!==1||normalized[0].id!==old.id||normalized[0].start!==old.start||normalized[0].end!==old.end)throw failure('INVALID_CUES');
      return {id:old.id,text:normalized[0].text};
    });res.json(store.saveCues(job.id,body.version,mapped));
  });
  router.post('/jobs/:id/cancel',(req,res)=>{
    res.json({job:store.requestCancellation(req.params.id)});
  });
  for(const action of ['retry','render'])router.post(`/jobs/:id/${action}`,(req,res)=>{
    const job=requireJob(req.params.id);if(['running','queued'].includes(job.status))throw failure('JOB_BUSY',409);
    if(action==='retry'&&!['failed','cancelled'].includes(job.status))throw failure('INVALID_JOB',409);
    if(action==='render'&&(!job.subtitleVersion||!store.getCues(job.id).length))throw failure('INVALID_CUES');
    res.status(202).json({job:store.updateJob(job.id,{status:'queued',error:null,cancelRequested:false,...(action==='render'?{renderRequested:true,stage:'render'}:{})},{expectedStatuses:action==='retry'?['failed','cancelled']:['completed','failed','cancelled'],requireUnexpired:true})});
  });
  router.get('/jobs/:id/files/:kind',async(req,res)=>{
    const job=requireJob(req.params.id),kind=req.params.kind;
    if(!['video','source','srt','poster'].includes(kind))throw failure('FILE_NOT_FOUND',404);
    if(kind==='srt'){const {cues}=cueSnapshot(job.id);if(!cues.length)throw failure('FILE_NOT_FOUND',404);res.type('application/x-subrip; charset=utf-8').attachment(`phu-de-${job.id}.srt`).send(toSrt(cues));return;}
    const internal=store.getJobInternal(job.id);const file=internal.artifacts?.[{video:'videoPath',source:'inputPath',poster:'posterPath'}[kind]];
    if(!file||(kind==='video'&&!job.renderedVersion))throw failure('FILE_NOT_FOUND',404);
    let resolved,jobRoot;
    try {resolved=await realpath(file);jobRoot=await realpath(path.join(dataDir,'jobs',job.id));if(!within(jobRoot,resolved)||(await stat(resolved)).isFile()!==true)throw new Error();}catch {throw failure('FILE_NOT_FOUND',404);}
    if(kind==='video')res.type('video/mp4');if(kind==='poster')res.type('image/jpeg');
    if(kind==='source'){
      const extension=path.extname(internal.upload?.originalName||resolved).toLowerCase();
      res.type(({'.mp4':'video/mp4','.m4v':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mkv':'video/x-matroska','.avi':'video/x-msvideo'})[extension]||'application/octet-stream');
    }
    // Dotfile protection applies inside the validated job root, not to .data ancestors.
    res.sendFile(path.relative(jobRoot,resolved),{root:jobRoot,acceptRanges:kind!=='poster',dotfiles:'deny'},error=>{if(error){if(res.headersSent)res.destroy();else if(error.status===416){res.status(416).end();}else res.status(404).json({error:{code:'FILE_NOT_FOUND',message:messages.FILE_NOT_FOUND}});}});
  });
  router.use((req,res)=>res.status(404).json({error:{code:'JOB_NOT_FOUND',message:messages.JOB_NOT_FOUND}}));
  router.use((error,req,res,next)=>{
    if(res.headersSent)return next(error);
    let code=error.code,statusCode=error.status??400;
    if(error.type==='entity.too.large'){code='BODY_TOO_LARGE';statusCode=413;}
    if(error.type==='entity.parse.failed'){code='INVALID_REQUEST';statusCode=400;}
    if(!messages[code]){code='INTERNAL_ERROR';statusCode=500;}
    if(code==='VERSION_CONFLICT')statusCode=409;
    if(code==='JOB_NOT_FOUND')statusCode=404;
    if(code==='JOB_STATE_CONFLICT')statusCode=409;
    if(code==='JOB_EXPIRED')statusCode=410;
    if(!req.complete){res.setHeader('Connection','close');res.once('finish',()=>req.destroy());}
    res.status(statusCode).json({error:{code,message:messages[code]}});
  });
  return router;
}
