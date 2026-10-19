import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,rename,rm,stat} from 'node:fs/promises';
import {transcribe} from './ai.mjs';
import {synthesizeSpeech,TTS_MODEL} from './gemini-tts.mjs';
import {prepareSpeechClip,buildVoiceTrack,mixDubbedVideo} from './dubbing-media.mjs';
import {mapSpeakersToCues,speechTurns,validateDubbingProfile} from './dubbing.mjs';
import {DEFAULT_TRANSCRIPTION_MODEL} from './config.mjs';
const failure=(code,message)=>Object.assign(new Error(message),{code});
async function exists(file){try{return Boolean(file&&(await stat(file)).isFile());}catch{return false;}}

/** Uses the existing worker lease, cancellation checks and durable job state. */
export async function runDubbingTask({store,id,job,credentials,directory,inputPath,duration,usage,step,check,write,read,tool,signal,abort,services={}}) {
  const service={transcribe,synthesizeSpeech,prepareSpeechClip,buildVoiceTrack,mixDubbedVideo,...services};
  const request=job.dubbingRequest;
  let expectedVersion=request.version,published,committed=false;
  function guard(){
    check();const current=read();
    if(current.status==='expired'||(current.expiresAt&&Date.parse(current.expiresAt)<=Date.now()))throw failure('JOB_EXPIRED','Công việc đã hết hạn.');
    if(current.subtitleVersion!==request.subtitleVersion)throw failure('VERSION_CONFLICT','Phụ đề đã thay đổi.');
    if((current.dubbing?.version??0)!==expectedVersion)throw failure('DUBBING_VERSION_CONFLICT','Phân vai đã thay đổi.');
  }
  guard();
  const key=credentials.providerConfigs?.gemini?.apiKey||credentials.videoApiKey||((credentials.provider??'gemini')==='gemini'?credentials.apiKey:'');
  if(!key)throw failure('AI_NOT_CONFIGURED','Hãy thêm khóa Google để tạo giọng.');
  const cues=store.getCues(id);if(!cues.length)throw failure('INVALID_DUBBING','Cần có phụ đề trước khi lồng tiếng.');
  const scratch=await mkdtemp(path.join(directory,'.dubbing-'));usage.dubbing??=[];
  const complete=patch=>{guard();write({status:'completed',stage:'done',progress:100,error:null,dubbingRequest:null,usage,...patch},{expectedStatuses:['running'],requireUnexpired:true,requireNotCancelled:true,expectedSubtitleVersion:request.subtitleVersion,expectedDubbingVersion:expectedVersion});committed=true;};
  try {
    if(request.action==='analyze') {
      let audioPath=job.artifacts.audioPath;
      if(!await exists(audioPath)){
        audioPath=path.join(directory,'speech.mp3');await step('transcribe',()=>tool.extractAudio(inputPath,audioPath,{signal}));guard();write({artifacts:{audioPath},usage});
      }
      const result=await step('transcribe',()=>service.transcribe(audioPath,{apiKey:key,model:credentials.providerConfigs?.gemini?.transcriptionModel??DEFAULT_TRANSCRIPTION_MODEL,duration,diarization:true,signal}));
      guard();
      if(!Array.isArray(result.segments)||!result.segments.length||result.segments.some(s=>!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<=s.start||s.end>duration))throw failure('AI_INVALID_RESPONSE','Mốc phân vai không hợp lệ.');
      if(!result.segments.some(s=>typeof s.speaker==='string'&&s.speaker.trim()))throw failure('DUBBING_SPEAKERS_MISSING','AI chưa trả về người nói để phân vai.');
      const mapped=mapSpeakersToCues(cues,result.segments,request.subtitleVersion);
      const profile=validateDubbingProfile({...mapped,version:expectedVersion},cues,request.subtitleVersion);
      usage.dubbing.push({...result.usage,kind:'analyze',completedAt:new Date().toISOString()});complete({dubbing:{...profile,version:expectedVersion+1}});return;
    }
    if(!['preview','render'].includes(request.action))throw failure('INVALID_DUBBING','Yêu cầu không hợp lệ.');
    const profile=validateDubbingProfile(job.dubbing,cues,request.subtitleVersion);
    const cache=path.join(directory,'dubbing-cache');await mkdir(cache,{recursive:true});
    async function audioFor(turn){
      guard();const hash=createHash('sha256').update(JSON.stringify([TTS_MODEL,turn.voice,turn.text])).digest('hex'),cached=path.join(cache,`${hash}.wav`);
      if(await exists(cached))return cached;
      const result=await step('render',()=>service.synthesizeSpeech(turn.text,{apiKey:key,voice:turn.voice,signal}));guard();
      if(!Buffer.isBuffer(result.audio)||!result.audio.length)throw failure('AI_INVALID_RESPONSE','Không có âm thanh hợp lệ.');
      const temporary=path.join(scratch,`${hash}.wav`);await writeFile(temporary,result.audio,{mode:0o600});guard();await rename(temporary,cached);guard();
      usage.dubbing.push({...result.usage,kind:'speech',speakerId:turn.speakerId,cueIds:turn.cueIds,completedAt:new Date().toISOString()});write({usage});return cached;
    }
    if(request.action==='preview') {
      const assignment=profile.assignments.find(a=>a.speakerId===request.speakerId),cue=cues.find(c=>c.id===assignment?.cueId),speaker=profile.speakers.find(s=>s.id===request.speakerId);
      if(!cue||!speaker)throw failure('DUBBING_NO_LINES','Vai đã chọn chưa có câu thoại.');
      const audio=await audioFor({speakerId:speaker.id,voice:speaker.voice,text:cue.text.replace(/\s+/gu,' ').trim(),cueIds:[cue.id]});
      complete({artifacts:{dubbingPreviewPath:audio},dubbingPreview:{version:expectedVersion,subtitleVersion:request.subtitleVersion,speakerId:speaker.id,token:randomUUID()}});return;
    }
    const turns=speechTurns(cues,profile),clips=[];
    for(const [index,turn]of turns.entries()) {
      const audio=await audioFor(turn),prepared=path.join(scratch,`clip-${index}.wav`);
      await step('render',()=>service.prepareSpeechClip({inputPath:audio,outputPath:prepared,slotSeconds:turn.end-turn.start,signal}));guard();
      clips.push({path:prepared,start:turn.start,end:turn.end});write({progress:Math.floor((index+1)/turns.length*65),usage});
    }
    const track=path.join(scratch,'voices.wav');await step('render',()=>service.buildVoiceTrack({clips,duration,outputPath:track,signal}));guard();
    let base=job.artifacts.videoPath;
    if(job.renderedVersion!==request.subtitleVersion||!await exists(base)) {
      base=path.join(scratch,'captioned.mp4');await step('render',()=>tool.renderVideo({inputPath,outputPath:base,cues,style:job.subtitleStyle,duration,signal}));guard();
    }
    const output=path.join(scratch,'dubbed.mp4');
    await step('render',()=>service.mixDubbedVideo({inputPath:base,voiceTrackPath:track,outputPath:output,duration,signal,onProgress:fraction=>{if(Number.isFinite(fraction)){try{guard();write({progress:65+Math.floor(Math.min(1,Math.max(0,fraction))*34)});}catch(error){abort(error);}}}}));guard();
    if(!(await stat(output)).size)throw failure('INVALID_VIDEO','Video lồng tiếng trống.');
    const token=randomUUID();published=path.join(directory,`dubbed-s${request.subtitleVersion}-d${expectedVersion}-${token}.mp4`);await rename(output,published);guard();
    complete({artifacts:{dubbedPath:published},dubbingOutput:{version:expectedVersion,subtitleVersion:request.subtitleVersion,token}});
  } finally {
    await rm(scratch,{recursive:true,force:true});
    if(published&&!committed)await rm(published,{force:true});
  }
}
