import path from 'node:path';
import {mkdir,mkdtemp,realpath,rename,rm,stat,writeFile} from 'node:fs/promises';
import {toolPaths} from './media.mjs';
import {runProcess} from './process.mjs';

const FPS=24;
const fail=(code,message)=>Object.assign(new Error(message),{code});
const invalidTimeline=()=>fail('AI_INVALID_SEGMENTS','Lời nói hoặc mốc thời gian không hợp lệ.');
const validDuration=value=>Number.isFinite(value)&&value>0&&value<=1500;

/** Server-owned timing: source text can never alter scene IDs or coverage. */
export function buildNarratedTimeline(transcript,duration){
  if(!validDuration(duration)||!Array.isArray(transcript)||!transcript.length)throw invalidTimeline();
  const ids=new Set();let previous=-1;
  for(const segment of transcript){
    if(!segment||typeof segment.id!=='string'||!segment.id||ids.has(segment.id)||typeof segment.text!=='string'||!segment.text.trim()||!Number.isFinite(segment.start)||!Number.isFinite(segment.end)||segment.start<0||segment.end<=segment.start||segment.end>duration||segment.start<previous)throw invalidTimeline();
    ids.add(segment.id);previous=segment.start;
  }
  const windows=[];let start=0;
  while(start<duration){
    let end=Math.min(duration,start+8);
    if(duration-start>8){
      const boundaries=transcript.filter(s=>s.end>=start+4&&s.end<=start+8).map(s=>s.end);
      if(boundaries.length)end=boundaries.reduce((best,next)=>Math.abs(next-start-6)<Math.abs(best-start-6)?next:best);
    }
    // A tiny tail must have a frame of its own, or fit in its predecessor.
    if(end<duration&&Math.round(end*FPS)===Math.round(duration*FPS))end=duration-start<=8?duration:start+4;
    const overlapping=transcript.filter(s=>s.start<end&&s.end>start);
    const length=end-start;
    windows.push({id:`scene-${windows.length+1}`,start,end,transcriptIds:overlapping.map(s=>s.id),transcriptText:overlapping.map(s=>s.text.trim()).join(' '),generationDurationSeconds:length<=4?4:length<=6?6:8});
    start=end;
  }
  return windows;
}

async function probe(file,signal){
  try{
    const info=await stat(file);
    // Source/download limits belong to their importers. A long assembled
    // artifact can legitimately exceed either input's byte budget.
    if(!info.isFile()||!info.size)throw new Error();
    const data=JSON.parse((await runProcess(toolPaths.ffprobe,['-v','error','-show_format','-show_streams','-of','json',path.resolve(file)],{signal})).stdout);
    const video=data.streams?.find(s=>s.codec_type==='video'&&!s.disposition?.attached_pic),audio=data.streams?.find(s=>s.codec_type==='audio');
    const duration=Number(data.format?.duration??video?.duration),rotation=Number(video?.side_data_list?.find(s=>s.rotation!==undefined)?.rotation??video?.tags?.rotate??0),rotated=Math.abs(rotation)%180===90;
    const width=Number(rotated?video?.height:video?.width),height=Number(rotated?video?.width:video?.height);
    if(!validDuration(duration)||!Number.isFinite(width)||!Number.isFinite(height)||width<2||height<2)throw new Error();
    return {duration,width,height,hasAudio:Boolean(audio),frameCount:Number(video.nb_frames)||undefined,sourceStart:Number(data.format?.start_time)||0,videoStart:Number(video.start_time)||0,audioStart:Number(audio?.start_time)||0};
  }catch(error){signal?.throwIfAborted();throw fail('INVALID_VIDEO','Không thể đọc clip video hợp lệ.');}
}

/** Generated footage may be silent; source soundtrack is verified separately. */
export async function probeNarratedClip(file,{signal}={}){return probe(file,signal);}

const samePath=(left,right)=>process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;
async function distinctOutput(inputs,outputPath){
  const output=path.resolve(outputPath);
  let outputReal=output,outputInfo;
  try{outputReal=await realpath(output);outputInfo=await stat(outputReal);}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const inputPath of inputs){
    const input=path.resolve(inputPath);if(samePath(input,output))throw new Error();
    const inputReal=await realpath(input),inputInfo=await stat(inputReal);
    if(!inputInfo.isFile()||samePath(inputReal,outputReal)||(outputInfo&&inputInfo.dev===outputInfo.dev&&inputInfo.ino===outputInfo.ino))throw new Error();
  }
}

// Decoded packet timestamps are authoritative: MP4 edit lists can report an
// audio stream start of zero even when its first packet arrives seconds later.
function sourceAudioFilter(sourceStart,duration,sampleRate){
  return `asetpts=PTS-(${sourceStart})/TB,aresample=${sampleRate}:async=1:first_pts=0,apad,atrim=duration=${duration}`;
}

/** Keep ASR word offsets on the same complete source timeline as final assembly. */
export async function extractNarratedAudio(inputPath,outputPath,{signal}={}){
  let directory;
  const operationSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(600000)]):AbortSignal.timeout(600000);
  try{
    if(typeof inputPath!=='string'||typeof outputPath!=='string')throw new Error();
    await distinctOutput([inputPath],outputPath);
    const source=await probe(inputPath,operationSignal);if(!source.hasAudio)throw new Error();
    const output=path.resolve(outputPath);await mkdir(path.dirname(output),{recursive:true});
    directory=await mkdtemp(path.join(path.dirname(output),'.narrated-audio-'));
    const temporary=path.join(directory,'audio.mp3');
    await runProcess(toolPaths.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-copyts','-i',path.resolve(inputPath),'-map','0:a:0','-vn','-af',sourceAudioFilter(source.sourceStart,source.duration,16000),'-ac','1','-ar','16000','-codec:a','libmp3lame','-b:a','64k','-f','mp3','-y',temporary],{signal:operationSignal});
    const info=await stat(temporary);if(!info.size||info.size>=25_000_000)throw new Error();
    await distinctOutput([inputPath],output);operationSignal.throwIfAborted();
    await rename(temporary,output);return {path:output,size:info.size,duration:source.duration};
  }catch(error){signal?.throwIfAborted();throw fail('AI_AUDIO_EXTRACTION','Không chuẩn bị được âm thanh nguồn để nhận dạng lời nói.');}
  finally{if(directory)await rm(directory,{recursive:true,force:true});}
}

/** Normalize one clip at a time; concat demuxing keeps long projects bounded. */
export async function assembleNarratedVideo({scenes,inputPath,outputPath,duration,aspectRatio='9:16',signal}={}){
  let directory;
  const operationSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(3_600_000)]):AbortSignal.timeout(3_600_000);
  try{
    if(!validDuration(duration)||!['9:16','16:9'].includes(aspectRatio)||!Array.isArray(scenes)||!scenes.length||scenes.length>1500||typeof inputPath!=='string'||typeof outputPath!=='string')throw new Error();
    const frameCount=Math.round(duration*FPS);if(!frameCount)throw new Error();
    let end=0;
    for(const scene of scenes){
      if(!scene||typeof scene.path!=='string'||!Number.isFinite(scene.start)||!Number.isFinite(scene.end)||Math.abs(scene.start-end)>1e-7||scene.end<=scene.start||scene.end-scene.start>8+1e-7||Math.round(scene.end*FPS)<=Math.round(scene.start*FPS))throw new Error();
      end=scene.end;
    }
    if(Math.abs(end-duration)>1e-7)throw new Error();
    const inputs=[inputPath,...scenes.map(scene=>scene.path)];
    await distinctOutput(inputs,outputPath);
    const source=await probe(inputPath,operationSignal);if(!source.hasAudio)throw new Error();
    const width=aspectRatio==='9:16'?720:1280,height=aspectRatio==='9:16'?1280:720;
    await mkdir(path.dirname(outputPath),{recursive:true});
    directory=await mkdtemp(path.join(path.dirname(path.resolve(outputPath)),'.narrated-assembly-'));
    const concat=[];
    for(let i=0;i<scenes.length;i++){
      const scene=scenes[i],frames=Math.round(scene.end*FPS)-Math.round(scene.start*FPS),metadata=await probe(scene.path,operationSignal);
      if(metadata.duration+1/FPS+1e-6<Math.max(scene.end-scene.start,frames/FPS))throw new Error();
      const filename=`clip-${i}.mp4`,destination=path.join(directory,filename);
      await runProcess(toolPaths.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-i',path.resolve(scene.path),'-map','0:v:0','-an','-vf',`setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}:start_time=0,trim=end_frame=${frames},setpts=PTS-STARTPTS,format=yuv420p`,'-frames:v',String(frames),'-c:v','libx264','-preset','veryfast','-crf','20','-threads','2','-y',destination],{signal:operationSignal});
      const normalized=await probe(destination,operationSignal);if(normalized.frameCount!==frames)throw new Error();
      concat.push(`file '${filename}'`);
    }
    const list=path.join(directory,'clips.txt'),temporary=path.join(directory,'output.mp4');await writeFile(list,concat.join('\n'));
    const audio=sourceAudioFilter(source.sourceStart,duration,48000);
    await runProcess(toolPaths.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-copyts','-f','concat','-safe','1','-i',list,'-i',path.resolve(inputPath),'-map','0:v:0','-map','1:a:0','-c:v','copy','-af',audio,'-c:a','aac','-b:a','192k','-t',String(duration),'-movflags','+faststart','-y',temporary],{signal:operationSignal});
    const result=await probe(temporary,operationSignal);
    if(!result.hasAudio||result.width!==width||result.height!==height||result.frameCount!==frameCount||Math.abs(result.duration-duration)>.1)throw new Error();
    // Verify the container too: its audio timeline must not extend the result.
    const format=JSON.parse((await runProcess(toolPaths.ffprobe,['-v','error','-show_format','-of','json',temporary],{signal:operationSignal})).stdout).format;
    if(Math.abs(Number(format?.duration)-duration)>.1)throw new Error();
    // Repeat the check at publication in case an output alias changed during encoding.
    await distinctOutput(inputs,outputPath);operationSignal.throwIfAborted();
    await rename(temporary,outputPath);return {...result,path:outputPath};
  }catch(error){signal?.throwIfAborted();throw fail('AI_ASSEMBLY','Không ghép được MP4. Kiểm tra clip và âm thanh nguồn rồi thử ghép lại.');}
  finally{if(directory)await rm(directory,{recursive:true,force:true});}
}
