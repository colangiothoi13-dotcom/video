import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdir,stat,readdir,writeFile,rename,rm} from 'node:fs/promises';
import * as media from './media.mjs';
import * as providers from './ai.mjs';
import {readConfig,AI_PROVIDER,DEFAULT_TRANSLATION_MODEL,DEFAULT_TRANSCRIPTION_MODEL} from './config.mjs';
import {normalizeCues,toSrt} from './subtitles.mjs';
import {runProcess} from './process.mjs';
import {runDubbingTask} from './dubbing-pipeline.mjs';
import {runClipsTask} from './clips-pipeline.mjs';
import {mapSpeakersToCues} from './dubbing.mjs';
import {safeAiMessage,safeValidationDiagnostic,safeProviderUsage} from './ai-diagnostics.mjs';

const failure=(code,message)=>Object.assign(new Error(message),{code});
const safeMessages={
  INVALID_CLIPS:'Các mốc cắt video không hợp lệ. Hãy chọn lại thời gian bắt đầu và kết thúc.',
  CLIP_SOURCE_UNAVAILABLE:'Bản video đã chọn chưa sẵn sàng ở phiên bản hiện tại. Hãy chọn nguồn khác hoặc xuất lại video.',
  CLIP_INVALID_RANGE:'Đoạn cắt nằm ngoài video hoặc quá ngắn. Hãy chọn lại mốc thời gian.',
  CLIP_INVALID_INPUT:'Không tìm thấy video đã chọn để cắt. Hãy kiểm tra tệp nguồn hoặc xuất lại video.',
  CLIP_MEDIA_FAILED:'Không thể cắt video. Hãy kiểm tra mốc thời gian và thử lại.',
  INVALID_DUBBING:'Phân vai không hợp lệ. Hãy lưu lại các vai và giọng đọc.',
  DUBBING_VERSION_CONFLICT:'Phân vai đã thay đổi. Hãy tải lại và tạo lồng tiếng với bản mới.',
  VERSION_CONFLICT:'Phụ đề đã thay đổi trong lúc xử lý. Hãy tạo lồng tiếng với bản đã lưu mới nhất.',
  DUBBING_TOO_LONG:'Có lời thoại dài hơn khung thời gian cho phép. Hãy rút gọn câu hoặc đổi giọng rồi xuất lại.',
  DUBBING_NO_LINES:'Vai đã chọn chưa có câu thoại. Hãy gán ít nhất một câu cho vai để nghe thử.',
  DUBBING_SPEAKERS_MISSING:'AI chưa nhận diện được người nói. Hãy thử lại phân vai tự động; phân vai đã lưu vẫn được giữ.',
  DUBBING_INVALID_AUDIO:'Âm thanh giọng đọc không hợp lệ. Hãy tạo lại câu thoại và thử lại.',
  DUBBING_INVALID_TIMELINE:'Thời gian lồng tiếng không hợp lệ. Hãy kiểm tra lại các câu thoại.',
  DUBBING_MEDIA_FAILED:'Không thể ghép âm thanh lồng tiếng. Hãy kiểm tra video và thử lại.',
  AI_NOT_CONFIGURED:'Hãy nhập API key trong Cài đặt trước khi xử lý video.',
  AI_AUTH:'API key không hợp lệ hoặc đã hết hạn. Hãy cập nhật trong Cài đặt.',
  AI_QUOTA:'Tài khoản Gemini API không còn hạn mức. Hãy kiểm tra hạn mức và thanh toán Google AI Studio.',
  AI_MODEL_ACCESS:'Không có quyền truy cập mô hình đã chọn. Hãy kiểm tra mô hình trong Cài đặt.',
  AI_RATE_LIMIT:'API đang giới hạn tần suất. Vui lòng thử lại sau.',
  AI_UNAVAILABLE:'Dịch vụ AI tạm thời không sẵn sàng. Vui lòng thử lại sau.',
  AI_TIMEOUT:'AI phản hồi quá lâu. Vui lòng thử lại công việc.',
  AI_CONNECTION:'Không thể kết nối dịch vụ AI. Hãy kiểm tra mạng rồi thử lại.',
  AI_REQUEST:'Yêu cầu AI bị từ chối. Hãy kiểm tra cấu hình hoặc thử lại công việc.',
  AI_INVALID_RESPONSE:'AI trả về nội dung không hợp lệ. Vui lòng thử lại công việc.',
  AI_RULES_INVALID:'Không đọc được quy tắc dịch Gemini. Hãy kiểm tra prompts/gemini-subtitles.md: tệp UTF-8, có nội dung và tối đa 16 KiB.',
  AI_INVALID_SEGMENTS:'Nội dung hoặc thời gian lời nói không hợp lệ.',
  NO_SPEECH:'Không tìm thấy lời nói rõ ràng trong video. Hãy chọn video có giọng nói.',
  NO_AUDIO:'Video không có âm thanh để nhận dạng lời nói.',
  INVALID_VIDEO:'Tệp không chứa video hợp lệ. Hãy chọn một tệp video khác.',
  VIDEO_TOO_LONG:'Chỉ nhận video đã kết thúc và có thời lượng xác định. Không hỗ trợ luồng đang phát trực tiếp.',
  VIDEO_TOO_LARGE:'Video vượt giới hạn xử lý 5 GB. Tệp tải lên từ máy vẫn tối đa 500 MB.',
  AUDIO_TOO_LARGE:'Một phần âm thanh vượt giới hạn nhận dạng. Hãy thử lại công việc.',
  IMPORT_FAILED:'Không tải được video công khai. Hãy kiểm tra liên kết và quyền truy cập.',
  FONT_MISSING:'Không tìm thấy phông chữ để hiển thị phụ đề. Hãy chạy npm run setup.',
  INPUT_MISSING:'Không tìm thấy tệp nguồn. Vui lòng tải video lên lại.',
  CHECKPOINT_INVALID:'Dữ liệu xử lý đã lưu không hợp lệ. Vui lòng tạo lại công việc.',
};
function safeError(error) {
  const code=Object.hasOwn(safeMessages,error?.code)?error.code:'PIPELINE_FAILED';
  const result={code,message:safeMessages[code]??'Không thể xử lý video. Vui lòng kiểm tra công cụ và thử lại.'};
  if(code==='AI_INVALID_RESPONSE') {
    const validation=safeValidationDiagnostic(error);
    if(validation) {result.validation=validation;result.message=safeAiMessage(error);}
  }
  return result;
}
async function exists(file) {if(!file)return false;try{return (await stat(file)).isFile();}catch{return false;}}
function checkTranscript(segments,duration) {
  const ids=new Set();
  if(!Array.isArray(segments)||!segments.length) throw failure('NO_SPEECH',safeMessages.NO_SPEECH);
  for(const item of segments) {
    if(typeof item.id!=='string'||!item.id||ids.has(item.id)||typeof item.text!=='string'||!item.text.trim()||!Number.isFinite(item.start)||!Number.isFinite(item.end)||item.start<0||item.end<=item.start||item.end>duration+0.05) throw failure('AI_INVALID_RESPONSE',safeMessages.AI_INVALID_RESPONSE);
    ids.add(item.id);
  }
}

/** Jobs must first be claimed on this store connection. Every write is lease fenced. */
export function createPipeline({store,tools=media,ai=providers,config=()=>readConfig({dataDir}),dataDir=path.resolve(process.env.DATA_DIR||'.data'),workerId,dubbing={}}={}) {
  if(!store) throw new TypeError('Pipeline cần kho dữ liệu.');
  const root=path.resolve(dataDir,'jobs');const active=new Set();
  const tool={runProcess,...media,...tools};
  async function runJob(id,externalSignal) {
    const aborter=new AbortController();
    const signal=externalSignal?AbortSignal.any([externalSignal,aborter.signal]):aborter.signal;
    let job=store.getJobInternal(id);
    if(!job||job.status!=='running') return;
    if(active.has(id)) throw failure('JOB_ALREADY_RUNNING','Công việc đang được xử lý.');
    const owner=workerId??job.workerId;
    if(!owner||job.workerId!==owner) throw failure('WORKER_LEASE_LOST','Worker đã mất quyền xử lý.');
    const fence={workerId:owner};const directory=path.join(root,id);active.add(id);
    let usage=structuredClone(job.usage??{});usage.steps??=[];usage.translation??=[];usage.transcription??=[];
    let checkpoint=structuredClone(job.checkpoint??{});checkpoint.translations??=[];
    let pendingVideo,pendingSrt,publishedVideo,publishedSrt;let committed=false;
    const read=()=>store.getJobInternal(id);
    const write=(patch,conditions={})=>store.updateJob(id,patch,{...conditions,...fence});
    function check() {
      signal?.throwIfAborted();
      const current=read();
      if(current?.cancelRequested) throw failure('JOB_CANCELLED','Đã hủy công việc.');
      // Atomic write fencing is the authority; the read keeps expensive work from starting after loss.
      const lease=store.getWorkerStatus();
      if(!lease.active||lease.workerId!==owner) throw failure('WORKER_LEASE_LOST','Worker đã mất quyền xử lý.');
    }
    async function step(stage,action) {
      check();write({stage,progress:null,usage});const started=Date.now();
      const record={stage,attempt:usage.steps.filter(item=>item.stage===stage).length+1,startedAt:new Date(started).toISOString()};
      try {const value=await action();check();record.status='completed';record.providerAttempts=value?.usage?.attempts??1;return value;}
      catch(error){
        record.status=signal.aborted?'interrupted':'failed';record.code=safeError(error).code;record.providerAttempts=error.attempts??1;
        const validation=safeValidationDiagnostic(error),providerUsage=safeProviderUsage(error.providerUsage);
        if(validation)record.validation=validation;
        if(providerUsage)record.providerUsage=providerUsage;
        if(Array.isArray(error.validationFailures)) {
          const failures=error.validationFailures.slice(0,2).map(entry=>safeValidationDiagnostic({validation:entry})).filter(Boolean);
          if(failures.length)record.validationFailures=failures;
        }
        throw error;
      }
      finally {record.elapsedMs=Date.now()-started;usage.steps.push(record);}
    }
    try {
      const credentials={...(typeof config==='function'?config():config)};
      check();write({error:null,progress:null});await mkdir(directory,{recursive:true});check();
      job=read();
      if(job.clipsRequest) {
        await runClipsTask({store,id,job,directory,usage,step,check,write,read,tool,signal,abort:error=>aborter.abort(error)});return;
      }
      let inputPath=job.artifacts.inputPath;
      if(job.sourceType==='upload') {
        const destination=path.join(directory,'input.bin');
        const uploadRoot=path.resolve(dataDir,'uploads');
        const relative=inputPath?path.relative(uploadRoot,path.resolve(inputPath)):null;
        const staged=relative&&!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative);
        if(staged&&await exists(inputPath)) {
          await step('import',()=>rename(inputPath,destination));
          inputPath=destination;check();write({artifacts:{inputPath},upload:{...job.upload,path:inputPath},usage});
        } else if(!await exists(inputPath)&&await exists(destination)) {
          // A crash can occur after rename but before its SQLite checkpoint.
          inputPath=destination;check();write({artifacts:{inputPath},upload:{...job.upload,path:inputPath},usage});
        }
      }
      if(!await exists(inputPath)) {
        if(job.sourceType!=='url') throw failure('INPUT_MISSING',safeMessages.INPUT_MISSING);
        const imported=await step('import',()=>tool.importVideo(job.sourceUrl,directory,{signal}));
        check();inputPath=imported.inputPath;write({artifacts:{inputPath},title:imported.title??job.title,usage});
      }
      const metadata=await step('probe',async()=>media.validateVideoMetadata(await tool.probeVideo(inputPath,{signal}),(await stat(inputPath)).size));
      check();write({duration:metadata.duration,metadata,usage});job=read();
      if(!await exists(job.artifacts.posterPath)) {
        const posterPath=path.join(directory,`poster-${randomUUID()}.jpg`);
        try {
          await step('probe',()=>tool.runProcess(tool.toolPaths.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-i',path.resolve(inputPath),'-frames:v','1','-vf','scale=w=480:h=480:force_original_aspect_ratio=decrease','-y',posterPath],{signal}));
          if(!(await stat(posterPath)).size)throw failure('INVALID_VIDEO',safeMessages.INVALID_VIDEO);
          check();write({artifacts:{posterPath},usage});
        }catch(error){
          await rm(posterPath,{force:true}).catch(()=>{});
          if(signal.aborted||['WORKER_LEASE_LOST','JOB_CANCELLED'].includes(error.code))throw error;
          check();write({usage});
        }
      }
      if(job.dubbingRequest) {
        await runDubbingTask({store,id,job,credentials,directory,inputPath,duration:metadata.duration,usage,step,check,write,read,tool,signal,abort:error=>aborter.abort(error),services:dubbing});return;
      }
      let transcription=checkpoint.transcription;
      if(!transcription&&!job.subtitleVersion) {
        if(!credentials?.apiKey) throw failure('AI_NOT_CONFIGURED',safeMessages.AI_NOT_CONFIGURED);
        let audioPath=job.artifacts.audioPath;
        if(!await exists(audioPath)) {
          audioPath=path.join(directory,'speech.mp3');
          await step('transcribe',()=>tool.extractAudio(inputPath,audioPath,{signal}));
          check();write({artifacts:{audioPath},usage});
        }
        const result=await step('transcribe',()=>ai.transcribe(audioPath,{apiKey:credentials.apiKey,model:DEFAULT_TRANSCRIPTION_MODEL,duration:metadata.duration,signal,...((credentials.provider??AI_PROVIDER)==='gemini'?{diarization:true}:{})}));
        checkTranscript(result.segments,metadata.duration);
        transcription=result.segments;checkpoint.transcription=transcription;checkpoint.translations=[];
        usage.audioSeconds=result.usage?.audioSeconds??metadata.duration;usage.transcription.push({...result.usage,provider:AI_PROVIDER,model:result.usage?.model||DEFAULT_TRANSCRIPTION_MODEL,completedAt:new Date().toISOString()});
        check();write({checkpoint,usage});
      } else if(transcription) checkTranscript(transcription,metadata.duration);
      if(!read().subtitleVersion) {
        const validIds=new Set(transcription.map(segment=>segment.id));const translated=new Map();
        for(const item of checkpoint.translations) {
          if(!item||!validIds.has(item.id)||translated.has(item.id)||typeof item.text!=='string'||!item.text.trim()) throw failure('CHECKPOINT_INVALID',safeMessages.CHECKPOINT_INVALID);
          translated.set(item.id,item.text);
        }
        const batchSize=Math.max(1,Math.min(100,Number.isInteger(credentials?.translationBatchSize)?credentials.translationBatchSize:30));
        const remaining=transcription.filter(segment=>!translated.has(segment.id));
        for(let offset=0;offset<remaining.length;offset+=batchSize) {
          const batch=remaining.slice(offset,offset+batchSize);
          const result=await step('translate',()=>ai.translateSegments(batch,{apiKey:credentials?.apiKey,model:credentials?.translationModel,language:job.targetLanguage,signal}));
          const expected=new Set(batch.map(item=>item.id));const seen=new Set();
          for(const item of result.segments??[]) {
            if(!expected.has(item.id)||seen.has(item.id)||typeof item.text!=='string'||!item.text.trim()) throw failure('AI_INVALID_RESPONSE',safeMessages.AI_INVALID_RESPONSE);
            seen.add(item.id);translated.set(item.id,item.text);
          }
          if(seen.size!==expected.size) throw failure('AI_INVALID_RESPONSE',safeMessages.AI_INVALID_RESPONSE);
          checkpoint.translations=transcription.filter(item=>translated.has(item.id)).map(item=>({id:item.id,text:translated.get(item.id)}));
          usage.translation.push({ids:batch.map(item=>item.id),...result.usage,provider:AI_PROVIDER,model:result.usage?.model||credentials?.translationModel||DEFAULT_TRANSLATION_MODEL,language:job.targetLanguage,completedAt:new Date().toISOString()});
          check();write({checkpoint,usage});
        }
        const cues=normalizeCues(transcription.map(item=>({...item,sourceId:item.sourceId??item.id,original:item.text,text:translated.get(item.id)})),metadata.duration);
        if(!cues.length) throw failure('NO_SPEECH',safeMessages.NO_SPEECH);
        check();store.saveCues(id,read().subtitleVersion,cues,fence);
      }
      // A transaction prevents another connection committing between the version and cue reads.
      const snapshot=store.getCueSnapshot(id);job=snapshot.job;
      // Reuse speaker labels from the original ASR, including after a checkpoint recovery.
      // A saved cast belongs to the user and must survive ordinary caption rendering.
      if(!job.dubbing&&transcription?.some(item=>typeof item.speaker==='string'&&item.speaker.trim())) {
        check();job=store.saveDubbing(id,mapSpeakersToCues(snapshot.cues,transcription,job.subtitleVersion),fence);
      }
      const version=job.subtitleVersion;const cues=structuredClone(snapshot.cues);
      const token=randomUUID();pendingVideo=path.join(directory,`.pending-${token}.mp4`);pendingSrt=path.join(directory,`.pending-${token}.srt`);
      await writeFile(pendingSrt,toSrt(cues),'utf8');check();
      await step('render',()=>tool.renderVideo({inputPath,outputPath:pendingVideo,cues,style:job.subtitleStyle,duration:metadata.duration,signal,onProgress:fraction=>{
        if(!Number.isFinite(fraction))return;
        try {check();write({progress:Math.floor(Math.min(1,Math.max(0,fraction))*100)});}
        catch(error){aborter.abort(error);}
      }}));
      if(!(await stat(pendingVideo)).size) throw failure('INVALID_VIDEO',safeMessages.INVALID_VIDEO);
      await tool.probeVideo(pendingVideo,{signal,maxBytes:Infinity});check();
      publishedVideo=path.join(directory,`video-v${version}-${token}.mp4`);publishedSrt=path.join(directory,`subtitles-v${version}-${token}.srt`);
      await rename(pendingVideo,publishedVideo);await rename(pendingSrt,publishedSrt);check();
      write({status:'completed',stage:'done',progress:100,error:null,renderedVersion:version,renderRequested:false,artifacts:{videoPath:publishedVideo,srtPath:publishedSrt},checkpoint,usage},{expectedStatuses:['running'],requireUnexpired:true,requireNotCancelled:true});committed=true;
    } catch(error) {
      // Media cancellation wraps AbortSignal.reason; keep the domain reason authoritative.
      if(signal.aborted&&signal.reason?.code)error=signal.reason;
      const current=read();
      // Shutdown/lease loss leaves the last durable checkpoint for the next owner.
      const expired=current?.status==='expired'||error.code==='JOB_EXPIRED';
      const cancelled=!expired&&(current?.cancelRequested||current?.status==='cancelled'||error.code==='JOB_CANCELLED');
      const interrupted=signal?.aborted&&!cancelled&&!expired&&!['VERSION_CONFLICT','DUBBING_VERSION_CONFLICT'].includes(error.code);
      if(interrupted) {
        try {write({usage,checkpoint});}
        catch(fenced){if(fenced.code!=='WORKER_LEASE_LOST')throw fenced;}
      }
      if(!interrupted&&error.code!=='WORKER_LEASE_LOST'&&(error.code!=='JOB_STATE_CONFLICT'||cancelled||expired)) {
        const status=expired?'expired':cancelled?'cancelled':'failed';
        try {write({status,cancelRequested:cancelled,error:cancelled||expired?null:safeError(error),usage,checkpoint},{expectedStatuses:['running',status]});}
        catch(fenced){if(!['WORKER_LEASE_LOST','JOB_STATE_CONFLICT'].includes(fenced.code))throw fenced;}
      }
    } finally {
      // External steps have settled before temporary files are removed.
      for(const file of [pendingVideo,pendingSrt,...(committed?[]:[publishedVideo,publishedSrt])]) if(file) await rm(file,{force:true}).catch(()=>{});
      active.delete(id);
      if(read()?.status==='expired')await cleanupExpiredJob(id,owner);
    }
  }

  async function cleanupExpiredJob(id,owner,now=Date.now()) {
    const job=store.getJobInternal(id);
    if(!job||active.has(id)||['queued','running'].includes(job.status))return false;
    if(job.status!=='expired'&&(!job.expiresAt||Date.parse(job.expiresAt)>now))return false;
    // Re-check terminal state and ownership atomically before removing settled artifacts.
    try {store.updateJob(id,{status:'expired',error:null},{workerId:owner,expectedStatuses:['completed','failed','cancelled','expired']});}
    catch(error){if(['WORKER_LEASE_LOST','JOB_STATE_CONFLICT'].includes(error.code))return false;throw error;}
    if(store.getJobInternal(id)?.status!=='expired'||active.has(id)||!store.heartbeat(owner))return false;
    await rm(path.join(root,id),{recursive:true,force:true});return true;
  }

  async function cleanupExpired(now=Date.now()) {
    const jobs=store.listJobs();const byId=new Map(jobs.map(job=>[job.id,job]));const deleted=[];
    const owner=workerId??store.getWorkerStatus().workerId;
    if(!owner||!store.heartbeat(owner))return deleted;
    for(const job of jobs) {
      if(await cleanupExpiredJob(job.id,owner,now))deleted.push(job.id);
    }
    for(const orphanRoot of [root,path.resolve(dataDir,'uploads')]) {
      let entries=[];try {entries=await readdir(orphanRoot,{withFileTypes:true});}catch(error){if(error.code!=='ENOENT')throw error;}
      for(const entry of entries) {
        if(!entry.isDirectory()||(orphanRoot===root&&(byId.has(entry.name)||active.has(entry.name))))continue;
        const directory=path.join(orphanRoot,entry.name);let lastActivity;
        try {
          lastActivity=(await stat(directory)).mtimeMs;
          // Upload streams touch their file without necessarily touching the directory.
          for(const name of await readdir(directory)) lastActivity=Math.max(lastActivity,(await stat(path.join(directory,name))).mtimeMs);
        }catch(error){if(error.code==='ENOENT')continue;throw error;}
        if(now-lastActivity<3_600_000)continue;
        if(!store.heartbeat(owner))return deleted;
        // Re-read references after inspection so a newly accepted upload stays protected.
        const referenced=store.listJobs().some(job=>{
          if(job.status==='expired')return false;
          const internal=store.getJobInternal(job.id);
          return [internal.artifacts?.inputPath,internal.upload?.path].filter(Boolean).some(file=>{
            const relative=path.relative(directory,path.resolve(file));
            return relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));
          });
        });
        if(!referenced&&!store.getJobInternal(entry.name))await rm(directory,{recursive:true,force:true});
      }
    }
    return deleted;
  }
  return {runJob,cleanupExpired};
}
