import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdir,realpath,stat,rename,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import * as defaultMedia from './narrated-media.mjs';
import * as defaultProvider from './narrated-provider.mjs';
import * as defaultAi from './ai-provider.mjs';
import {importVideo,validateVideoMetadata} from './media.mjs';
import {getVideoModel} from './scene-provider.mjs';
import {interruptedError} from './narrated-store.mjs';
import {DEFAULT_TRANSLATION_MODEL,OPENAI_TRANSLATION_MODEL,OPENAI_TRANSCRIPTION_MODEL} from './config.mjs';

export const messages={
 AI_AUDIO_UNSUPPORTED:'Mô hình Gemini đã chọn từ chối yêu cầu nhận dạng lời nói. Hãy chọn mô hình hỗ trợ âm thanh và mốc thời gian trong Cài đặt.',
 AI_AUDIO_EXTRACTION:'Không chuẩn bị được âm thanh nguồn để nhận dạng lời nói.',
 NARRATED_INCOMPLETE_PLAN:'Kế hoạch cảnh chưa hoàn tất. Bấm Tiếp tục để xử lý các nhóm cảnh còn lại trước khi sửa hoặc tạo từng cảnh.',
 NARRATED_INVALID:'Thông tin dự án hoặc cảnh không hợp lệ.',NARRATED_NOT_FOUND:'Không tìm thấy dự án hoặc cảnh.',NARRATED_BUSY:'Dự án đang xử lý. Vui lòng chờ hoàn tất.',NARRATED_VERSION_CONFLICT:'Cảnh đã thay đổi. Hãy tải lại phiên bản đã lưu.',NARRATED_MISSING_CLIPS:'Cần hoàn thành mọi cảnh ở phiên bản hiện tại trước khi ghép.',NARRATED_FILE_NOT_FOUND:'Video chưa sẵn sàng hoặc không còn tồn tại.',NARRATED_INTERNAL:'Không thể hoàn tất xử lý. Vui lòng thử lại.',NARRATED_CLOSED:'Ứng dụng đang tắt.',NARRATED_INTERRUPTED:interruptedError.message,
 INVALID_SOURCE_URL:'Hãy dùng liên kết HTTPS YouTube hoặc Facebook công khai.',AI_NOT_CONFIGURED:'Nhập khóa API của dịch vụ AI trong Cài đặt.',AI_VIDEO_NOT_CONFIGURED:'Thêm khóa Google cho Veo trong Cài đặt.',AI_INVALID_RESPONSE:'Dịch vụ AI trả về dữ liệu không hợp lệ.',AI_AUTH:'Khóa API không hợp lệ hoặc đã hết hạn.',AI_MODEL_ACCESS:'Tài khoản không có quyền truy cập mô hình này.',AI_QUOTA:'Tài khoản API đã hết hạn mức.',AI_RATE_LIMIT:'Dịch vụ AI đang giới hạn tần suất. Vui lòng thử lại sau.',AI_TIMEOUT:'Dịch vụ AI phản hồi quá lâu.',AI_CONNECTION:'Không thể kết nối dịch vụ AI.',AI_UNAVAILABLE:'Dịch vụ AI tạm thời chưa sẵn sàng.',AI_NETWORK_BLOCKED:'Ứng dụng bị chặn truy cập mạng.',AI_REQUEST:'Dịch vụ AI từ chối yêu cầu.',AI_VIDEO_OPTIONS:'Mô hình hoặc tùy chọn tạo video không được hỗ trợ.',AI_CONTENT_BLOCKED:'Dịch vụ AI chặn cảnh này. Sửa prompt trước khi thử lại.',AI_OPERATION_EXPIRED:'Tác vụ tạo clip đã hết hạn. Chủ động tiếp tục để tạo lại.',AI_DOWNLOAD:'Chưa tải được clip đã tạo.',AI_ASSEMBLY:'Không thể ghép video. Kiểm tra clip và công cụ xử lý.',IMPORT_FAILED:'Không tải được video công khai từ liên kết này.',VIDEO_TOO_LONG:'Chỉ nhận video đã kết thúc và có thời lượng xác định.',VIDEO_TOO_LARGE:'Video nguồn vượt giới hạn 5 GB.',INVALID_VIDEO:'Video nguồn không hợp lệ.',NO_AUDIO:'Video nguồn không có âm thanh.',AUDIO_TOO_LARGE:'Âm thanh vượt giới hạn nhận dạng lời nói.',NARRATED_NO_SPEECH:'Không nhận dạng được lời nói hợp lệ.',TOOLS_UNAVAILABLE:'Công cụ xử lý video chưa sẵn sàng.',URL_TOOL_UNAVAILABLE:'Công cụ tải liên kết chưa sẵn sàng.',
};
export const failure=(code,status=400)=>Object.assign(new Error(messages[code]??messages.NARRATED_INTERNAL),{code,status});
export function safeError(error){const code=Object.hasOwn(messages,error?.code)?error.code:'NARRATED_INTERNAL';return {code,message:messages[code]};}
export const within=(root,file)=>{const relative=path.relative(root,file);return relative!==''&&relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};
export const currentClip=scene=>Boolean(scene.artifact&&scene.artifact.version===scene.version&&scene.status==='completed');
export const currentAssembly=p=>Boolean(p.assembly.artifact&&p.scenes.length&&p.scenes.every((s,i)=>currentClip(s)&&p.assembly.artifact.clips[i]===s.artifact.token));
export const effectivePrompt=(p,s)=>`Realistic live action, natural light and materials, appropriate natural subject and camera motion. Preserve continuity: ${p.continuity}\nAspect ratio: ${p.aspectRatio}. Illustrate the original narration without inventing spoken dialogue.\n${s.prompt}`;
export function narratedSettings(readConfig){
 const c=readConfig(),provider=c.provider??'gemini',translationModel=c.translationModel??(provider==='openai'?OPENAI_TRANSLATION_MODEL:DEFAULT_TRANSLATION_MODEL);
 return {...c,provider,translationModel,transcriptionModel:provider==='gemini'?translationModel:(c.transcriptionModel??OPENAI_TRANSCRIPTION_MODEL),videoApiKey:c.videoApiKey??(provider==='openai'?'':c.apiKey),videoModel:getVideoModel(c.videoModel)};
}

/** Serial, independent dispatcher. Network uncertainty never causes automatic paid retries. */
export function createNarratedPipeline({store,root,readConfig,tools={}}){
 const provider={...defaultProvider,...tools.narratedProvider},media={...defaultMedia,...tools.narratedMedia},ai={...defaultAi,...tools.narratedAi};
 const importer=tools.importVideo??importVideo,extractor=tools.extractAudio??media.extractNarratedAudio;
 const pollMs=Number.isFinite(tools.narratedPollIntervalMs)&&tools.narratedPollIntervalMs>=0?tools.narratedPollIntervalMs:10000;
 const tickMs=Number.isFinite(tools.narratedTickMs)&&tools.narratedTickMs>=1?tools.narratedTickMs:1000;
 const controller=new AbortController(),signal=controller.signal;let running=null,closing=false,closePromise;
 const settings=()=>narratedSettings(readConfig);
 async function owned(id,file){const expected=path.resolve(root,id),canonicalRoot=await realpath(expected),canonicalParent=await realpath(root),resolved=await realpath(file);if(path.relative(path.join(canonicalParent,id),canonicalRoot)!==''||!within(canonicalRoot,resolved)||(await stat(resolved)).isFile()!==true)throw failure('NARRATED_FILE_NOT_FOUND',404);return resolved;}
 function update(id,action){return store.mutate(id,action);}
 function stage(id,status){return update(id,p=>{p.status=status;p.error=null;});}
 function credentials(video=false){const c=settings();if(video&&!c.videoApiKey)throw failure('AI_VIDEO_NOT_CONFIGURED');if(!video&&!c.apiKey)throw failure('AI_NOT_CONFIGURED');return c;}
 async function plan(id){
  let p=store.get(id);if(!p.windows){const windows=media.buildNarratedTimeline(p.transcript,p.duration);if(!Array.isArray(windows)||!windows.length)throw failure('AI_INVALID_RESPONSE');update(id,p=>{p.windows=windows;});}
  while(true){p=store.get(id);const plannedIds=new Set(p.scenes.map(s=>s.id));const windows=p.windows.filter(w=>!plannedIds.has(w.id)).slice(0,20);if(!windows.length)return;
   const c=credentials();stage(id,'planning');
   const result=await provider.generateNarratedPlan({windows,continuity:p.continuity,sourceTitle:p.title},{provider:c.provider,apiKey:c.apiKey,model:c.translationModel,signal});signal.throwIfAborted();
   const bounded=(v,max)=>typeof v==='string'&&v.trim()&&v.length<=max&&!v.includes('\0');
   if(!result||!bounded(result.title,300)||typeof result.continuity!=='string'||result.continuity.length>6000||!Array.isArray(result.scenes)||result.scenes.length!==windows.length||result.scenes.some((s,i)=>s.id!==windows[i].id||!bounded(s.title,300)||!bounded(s.visual,3000)||!bounded(s.prompt,6000)))throw failure('AI_INVALID_RESPONSE');
   update(id,p=>{p.title=result.title;p.continuity=result.continuity;for(const [i,scene] of result.scenes.entries())p.scenes.push({...windows[i],title:scene.title,visual:scene.visual,prompt:scene.prompt,version:1,status:'draft',error:null,artifact:null,operation:null,history:[]});p.status='queued';});
  }
 }
 async function generate(id,sceneId){
  let p=store.get(id),s=p.scenes.find(s=>s.id===sceneId);if(currentClip(s))return;
  const c=credentials(true);let token=s.operation?.token;
  if(!s.operation?.name){
   token=randomUUID();update(id,p=>{p.status='generating';const s=p.scenes.find(s=>s.id===sceneId);s.status='starting';s.error=null;s.operation={token,name:null,version:s.version};s.history.unshift({id:token,version:s.version,prompt:s.prompt,effectivePrompt:effectivePrompt(p,s),model:c.videoModel,videoModel:c.videoModel,durationSeconds:s.generationDurationSeconds,status:'starting',createdAt:new Date().toISOString()});});
   p=store.get(id);s=p.scenes.find(s=>s.id===sceneId);const h=s.history.find(h=>h.id===token);
   let result;try{result=await provider.startSceneVideo({prompt:h.effectivePrompt,durationSeconds:h.durationSeconds,aspectRatio:p.aspectRatio,references:[]},{apiKey:c.videoApiKey,videoModel:c.videoModel,signal});}catch(error){if(signal.aborted||['AI_TIMEOUT','AI_CONNECTION','AI_UNAVAILABLE','AI_NETWORK_BLOCKED'].includes(error.code)||!Object.hasOwn(messages,error.code))throw failure('NARRATED_INTERRUPTED');throw error;}
   if(typeof result?.operationName!=='string'||!result.operationName||result.operationName.length>1000)throw failure('NARRATED_INTERRUPTED');
   update(id,p=>{const s=p.scenes.find(s=>s.id===sceneId);s.operation.name=result.operationName;s.status='generating';s.history.find(h=>h.id===token).status='generating';});
  }else stage(id,'generating');
  while(true){signal.throwIfAborted();p=store.get(id);s=p.scenes.find(s=>s.id===sceneId);const result=await provider.pollSceneVideo(s.operation.name,{apiKey:c.videoApiKey,signal});if(!result?.done){await delay(pollMs,undefined,{signal});continue;}
   if(typeof result.videoUri!=='string')throw failure('AI_INVALID_RESPONSE');
   const directory=path.join(root,id),pending=path.join(directory,`.clip-${token}.mp4`),published=path.join(directory,`${sceneId}-${token}.mp4`);
   try{await provider.downloadSceneVideo(result.videoUri,pending,{apiKey:c.videoApiKey,signal});signal.throwIfAborted();await owned(id,pending);const metadata=await media.probeNarratedClip(pending,{signal});if(!Number.isFinite(metadata.duration)||metadata.duration+1/24<s.end-s.start)throw failure('AI_INVALID_RESPONSE');await rename(pending,published);update(id,p=>{const s=p.scenes.find(s=>s.id===sceneId);s.artifact={path:published,version:s.version,token};s.operation=null;s.status='completed';s.error=null;const h=s.history.find(h=>h.id===token);h.status='completed';h.artifact={...s.artifact};h.completedAt=new Date().toISOString();});return;}finally{await rm(pending,{force:true}).catch(()=>{});}
  }
 }
 async function assemble(id){
  const p=store.get(id);if(!p.scenes.length||!p.scenes.every(currentClip))throw failure('NARRATED_MISSING_CLIPS',409);
  const token=randomUUID(),directory=path.join(root,id),pending=path.join(directory,`.assembly-${token}.mp4`),published=path.join(directory,`video-${token}.mp4`);
  update(id,p=>{p.status='assembling';p.assembly.status='rendering';p.assembly.error=null;});
  try{const inputPath=await owned(id,p.source.inputPath),scenes=[];for(const s of p.scenes)scenes.push({start:s.start,end:s.end,path:await owned(id,s.artifact.path)});
   await media.assembleNarratedVideo({scenes,inputPath,outputPath:pending,duration:p.duration,aspectRatio:p.aspectRatio,signal});signal.throwIfAborted();await owned(id,pending);if(!(await stat(pending)).size)throw failure('AI_ASSEMBLY');await rename(pending,published);update(id,p=>{p.assembly={status:'completed',error:null,artifact:{path:published,token,clips:p.scenes.map(s=>s.artifact.token)}};p.status='completed';p.error=null;p.request=null;});
  }finally{await rm(pending,{force:true}).catch(()=>{});}
 }
 async function processProject(id){
  try{let p=store.get(id);const request=p.request??{type:'auto'};await mkdir(path.join(root,id),{recursive:true});
   if(request.type==='render'){await assemble(id);return;}
   if(request.type==='auto'){
    if(!p.source){stage(id,'importing');const imported=await importer(p.sourceUrl,path.join(root,id),{signal});signal.throwIfAborted();await owned(id,imported.inputPath);const metadata=validateVideoMetadata(imported.metadata,(await stat(imported.inputPath)).size);update(id,p=>{p.source={inputPath:imported.inputPath,metadata};p.duration=metadata.duration;p.title=String(imported.title||p.title).slice(0,300);p.status='queued';});}
    p=store.get(id);await owned(id,p.source.inputPath);
    if(!p.transcript){const c=credentials(),audioPath=path.join(root,id,'asr.mp3');if(!p.source.audioPath){await extractor(p.source.inputPath,audioPath,{signal});signal.throwIfAborted();await owned(id,audioPath);update(id,p=>{p.source.audioPath=audioPath;});}stage(id,'transcribing');p=store.get(id);await owned(id,p.source.audioPath);const result=await ai.transcribe(p.source.audioPath,{provider:c.provider,apiKey:c.apiKey,model:c.transcriptionModel,duration:p.duration,signal});signal.throwIfAborted();const segments=Array.isArray(result)?result:result?.segments;if(!Array.isArray(segments)||!segments.length||!segments.some(s=>typeof s.text==='string'&&s.text.trim())||segments.some(s=>!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<=s.start||s.end>p.duration+0.1||typeof s.text!=='string'||s.text.length>20000))throw failure('NARRATED_NO_SPEECH');update(id,p=>{p.transcript=segments;p.transcriptionUsage=result.usage??null;p.status='queued';});}
    await plan(id);for(const s of store.get(id).scenes){signal.throwIfAborted();await generate(id,s.id);}await assemble(id);
   }else if(request.type==='scene'){await generate(id,request.sceneId);update(id,p=>{p.status=currentAssembly(p)?'completed':'ready';p.error=null;p.request=null;});}
  }catch(error){const p=store.get(id);if(!p)return;
   // Known operation names remain durable through shutdown; restart only polls them.
   if(signal.aborted&&p.status==='generating'&&p.scenes.some(s=>s.operation?.name))return;
   const safe=safeError(signal.aborted?failure('NARRATED_INTERRUPTED'):error);
   update(id,p=>{p.status='failed';p.error=safe;if(p.assembly.status==='rendering'){p.assembly.status='failed';p.assembly.error=safe;}for(const s of p.scenes)if(['starting','generating'].includes(s.status)){s.status='failed';s.error=safe;const h=s.history.find(h=>h.id===s.operation?.token);if(h){h.status='failed';h.error=safe;h.completedAt=new Date().toISOString();}if(!s.operation?.name||['AI_OPERATION_EXPIRED','AI_CONTENT_BLOCKED','AI_INVALID_RESPONSE','AI_REQUEST','AI_VIDEO_OPTIONS','INVALID_VIDEO'].includes(safe.code))s.operation=null;}});
  }
 }
 function kick(){if(closing||running)return;const project=store.list().slice().reverse().find(p=>p.status==='queued');if(!project)return;running=processProject(project.id);running.catch(()=>{}).finally(()=>{running=null;if(!closing)queueMicrotask(kick);});}
 const timer=setInterval(kick,tickMs);timer.unref();queueMicrotask(kick);
 return {kick,owned,close(){if(!closePromise){closing=true;clearInterval(timer);controller.abort(failure('NARRATED_CLOSED',503));closePromise=(async()=>{await running;})();}return closePromise;}};
}
