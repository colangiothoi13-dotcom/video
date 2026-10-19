import path from 'node:path';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import ffmpegPath from 'ffmpeg-static';
import {runProcess} from './process.mjs';
import {invalidAiResponse,safeProviderUsage,safeValidationDiagnostic} from './ai-diagnostics.mjs';

const PART_SECONDS=1200;
const SINGLE_PART_SECONDS=1800;
const MAX_PART_BYTES=25_000_000;
const error=(code,message,extra={})=>Object.assign(new Error(message),{code,...extra});
const noSpeech=()=>error('NO_SPEECH','Không tìm thấy lời nói rõ ràng trong video. Hãy chọn video có giọng nói.');
const validCount=value=>Number.isFinite(value)&&value>=0;

function validateDuration(duration) {
  if(!Number.isFinite(duration)||duration<=0)throw error('AI_INVALID_SEGMENTS','Thời lượng âm thanh phải là một số hữu hạn lớn hơn 0.');
}

/** Exact source offsets, including the final fractional part. */
export function planAudioParts(duration,partSeconds=PART_SECONDS) {
  validateDuration(duration);
  if(!Number.isFinite(partSeconds)||partSeconds<=0||partSeconds>PART_SECONDS)throw new TypeError('Invalid audio part duration.');
  const parts=[];
  for(let index=0;index*partSeconds<duration;index++) {
    const start=index*partSeconds;
    parts.push({index,start,duration:Math.min(partSeconds,duration-start)});
  }
  return parts;
}

function addUsage(total,value) {
  for(const [key,amount] of Object.entries(safeProviderUsage(value)??{})) {
    if(typeof amount==='number')total[key]=(total[key]??0)+amount;
    else {total[key]??={};for(const [detail,count] of Object.entries(amount))total[key][detail]=(total[key][detail]??0)+count;}
  }
}

function validatePartSegments(segments,duration) {
  if(!Array.isArray(segments)||!segments.length)throw invalidAiResponse('INVALID_SEGMENT');
  const seen=new Set();let end=0;
  for(const [index,segment] of segments.entries()) {
    if(!segment||typeof segment!=='object'||Array.isArray(segment)||typeof segment.id!=='string'||!segment.id||seen.has(segment.id)||typeof segment.text!=='string'||!segment.text.trim()||(segment.speaker!==undefined&&(typeof segment.speaker!=='string'||!segment.speaker)))throw invalidAiResponse('INVALID_SEGMENT',{index});
    if(!Number.isFinite(segment.start)||!Number.isFinite(segment.end)||segment.start<end||segment.end<=segment.start||segment.end>duration)throw invalidAiResponse('INVALID_TIMING',{index});
    seen.add(segment.id);end=segment.end;
  }
}

/**
 * Keep short requests unchanged. Long files are decoded one bounded part at a
 * time; only that MP3 is ever read by a provider. Dependencies are local process
 * fixtures, separate from provider options and their restricted API endpoints.
 */
export async function transcribeAudioChunks(audioPath,options,transcribePart,{run=runProcess,partSeconds=PART_SECONDS,splitAfterSeconds=SINGLE_PART_SECONDS}={}) {
  const {duration,signal}=options;
  signal?.throwIfAborted();validateDuration(duration);
  if(!Number.isFinite(splitAfterSeconds)||splitAfterSeconds<=0||splitAfterSeconds>SINGLE_PART_SECONDS)throw new TypeError('Invalid single audio duration.');
  if(duration<=splitAfterSeconds)return transcribePart(audioPath,options);
  const parts=planAudioParts(duration,partSeconds);
  const source=path.resolve(audioPath),directory=path.dirname(source),info=await stat(source);
  if(!info.isFile()||!info.size)throw error('AUDIO_TOO_LARGE','Âm thanh phải có dung lượng lớn hơn 0.');
  const started=Date.now(),segments=[],usage={},validationFailures=[];
  let attempts=0,validationAttempts=0,audioSeconds=0,temp;
  const account=(value={})=>{
    addUsage(usage,value);
    for(const key of ['provider','model'])if(typeof value[key]==='string'&&usage[key]===undefined)usage[key]=value[key];
    if(validCount(value.attempts))attempts+=value.attempts;
    if(validCount(value.validationAttempts))validationAttempts+=value.validationAttempts;
    if(Array.isArray(value.validationFailures))for(const failure of value.validationFailures) {
      const diagnostic=safeValidationDiagnostic({validation:failure});if(diagnostic)validationFailures.push(diagnostic);
    }
  };
  const metadata=()=>({attempts,audioSeconds,elapsedMs:Date.now()-started,providerUsage:safeProviderUsage(usage),...(validationAttempts?{validationAttempts}:{}),...(validationFailures.length?{validationFailures:[...validationFailures]}:{})});
  try {
    signal?.throwIfAborted();
    temp=await mkdtemp(path.join(directory,'.asr-parts-'));
    for(const part of parts) {
      signal?.throwIfAborted();
      const file=path.join(temp,`part-${part.index+1}.mp3`);
      await run(ffmpegPath,['-hide_banner','-loglevel','error','-nostdin','-ss',String(part.start),'-i',source,'-t',String(part.duration),'-map','0:a:0','-vn','-ac','1','-ar','16000','-codec:a','libmp3lame','-b:a','64k','-f','mp3','-y',file],{signal});
      signal?.throwIfAborted();
      const partInfo=await stat(file);
      if(!partInfo.isFile()||!partInfo.size||partInfo.size>=MAX_PART_BYTES)throw error('AUDIO_TOO_LARGE','Mỗi phần âm thanh phải có dung lượng lớn hơn 0 và dưới 25 MB.');
      let result;
      audioSeconds+=part.duration;
      try {result=await transcribePart(file,{...options,duration:part.duration});}
      catch(failure) {
        account({...failure, ...failure.providerUsage});
        signal?.throwIfAborted();
        if(failure.code!=='NO_SPEECH')throw failure;
        await rm(file,{force:true});continue;
      }
      account(result?.usage);
      signal?.throwIfAborted();
      validatePartSegments(result?.segments,part.duration);
      for(const segment of result.segments) {
        const id=`s${segments.length+1}`;
        segments.push({...segment,id,sourceId:id,start:part.start+segment.start,end:part.start+segment.end,...(segment.speaker?{speaker:`chunk${part.index+1}:${segment.speaker}`}:{})});
      }
      await rm(file,{force:true});
    }
    if(!segments.length)throw noSpeech();
    const {providerUsage,...counts}=metadata();
    return {segments,usage:{...usage,...counts}};
  } catch(failure) {
    // Cancellation reasons can be frozen or primitive; retain an Error boundary.
    if(!(failure instanceof Error)||!Object.isExtensible(failure))failure=error(signal?.aborted?'JOB_CANCELLED':'AI_INVALID_RESPONSE','Không thể hoàn tất phiên âm.',{name:signal?.aborted?'AbortError':'Error'});
    throw Object.assign(failure,metadata());
  } finally {
    // Only this call's mkdtemp directory is recursively removed.
    if(temp&&path.dirname(temp)===directory&&path.basename(temp).startsWith('.asr-parts-'))await rm(temp,{recursive:true,force:true});
  }
}
