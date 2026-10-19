import path from 'node:path';
import {mkdir,mkdtemp,realpath,rename,rm,stat} from 'node:fs/promises';
import {fitDimensions,probeVideo,toolPaths} from './media.mjs';
import {runProcess} from './process.mjs';

const MIN_CLIP_SECONDS=0.25;
// Container duration and the final encoded frame may differ by a small fraction
// of a second. Allow only this end-of-source margin; FFmpeg stops at real EOF.
const SOURCE_END_TOLERANCE=0.05;
function mediaError(code,message) { return Object.assign(new Error(message),{code}); }
const invalidRange=()=>mediaError('CLIP_INVALID_RANGE','Khoảng cắt phải dài ít nhất 0,25 giây và nằm trong thời lượng video.');
const invalidOutput=()=>mediaError('INVALID_OUTPUT','Tệp xuất phải khác video nguồn và có đường dẫn hợp lệ.');
const samePath=(left,right)=>process.platform==='win32' ? left.toLowerCase()===right.toLowerCase() : left===right;

function localPath(value,output=false) {
  // Accept absolute Windows drive paths, but never URL/protocol inputs. Passing
  // only resolved filesystem paths also prevents FFmpeg interpreting protocols.
  if(typeof value!=='string' || !value.trim() || value.includes('\0') ||
    (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value))) {
    throw output ? invalidOutput() : mediaError('CLIP_INVALID_INPUT','Hãy chọn một tệp video có sẵn để cắt.');
  }
  return path.resolve(value);
}

async function distinctOutput(input,output) {
  if(samePath(input,output)) throw invalidOutput();
  const inputReal=await realpath(input),inputInfo=await stat(inputReal);
  if(!inputInfo.isFile()) throw mediaError('CLIP_INVALID_INPUT','Hãy chọn một tệp video có sẵn để cắt.');
  let outputReal=output,outputInfo;
  try { outputReal=await realpath(output); outputInfo=await stat(outputReal); }
  catch(error) { if(error.code!=='ENOENT') throw error; }
  if(samePath(inputReal,outputReal) ||
    (outputInfo && inputInfo.dev===outputInfo.dev && inputInfo.ino===outputInfo.ino)) throw invalidOutput();
}

function safeFailure(error) {
  if(error.name==='AbortError' || error.code==='INVALID_OUTPUT' || error.code==='PROCESS_TERMINATION_FAILED' || error.code?.startsWith('CLIP_')) return error;
  return mediaError('CLIP_MEDIA_FAILED','Không thể cắt video. Hãy kiểm tra video và khoảng thời gian rồi thử lại.');
}

/** Accurately cut the selected source pixels and audio into a standalone MP4. */
export async function cutVideoClip({inputPath,outputPath,start,end,signal,onProgress}) {
  let directory;
  try {
    signal?.throwIfAborted();
    const input=localPath(inputPath),output=localPath(outputPath,true);
    if(!Number.isFinite(start) || !Number.isFinite(end) || start<0 || end<=start || end-start<MIN_CLIP_SECONDS-1e-9) throw invalidRange();
    await distinctOutput(input,output);
    const source=await probeVideo(input,{signal,maxBytes:Infinity});
    if(start>=source.duration || end>source.duration+SOURCE_END_TOLERANCE) throw invalidRange();
    const dimensions=fitDimensions(source.width,source.height,source.displayAspectRatio),duration=end-start;
    const parent=path.dirname(output);
    await mkdir(parent,{recursive:true});
    signal?.throwIfAborted();
    const scratch=await mkdtemp(path.join(parent,'.clips-'));
    // Only this newly created direct child is owned and may be removed below.
    if(path.dirname(path.resolve(scratch))!==parent || !path.basename(scratch).startsWith('.clips-')) throw invalidOutput();
    directory=scratch;
    const clipped=path.join(directory,'clip.mp4');
    await runProcess(toolPaths.ffmpeg,[
      '-hide_banner','-loglevel','error','-nostdin','-i',input,
      // Output seeking decodes from the source timeline and discards frames up
      // to the exact requested point, independent of source keyframe placement.
      '-ss',String(start),'-t',String(duration),'-map','0:v:0','-map','0:a:0',
      '-vf',`scale=${dimensions.width}:${dimensions.height},setsar=1`,
      '-c:v','libx264','-preset','fast','-crf','22','-pix_fmt','yuv420p',
      '-c:a','aac','-b:a','128k','-movflags','+faststart','-progress','pipe:1','-nostats','-y',clipped,
    ],{signal,onProgress:line=>{
      const match=line.match(/^out_time_us=(-?\d+)$/);
      if(match) onProgress?.(Math.max(0,Math.min(1,Number(match[1])/1_000_000/duration)));
    }});
    const info=await stat(clipped);
    if(!info.isFile() || info.size===0) throw mediaError('CLIP_MEDIA_FAILED','Không thể tạo tệp video đã cắt.');
    const metadata=await probeVideo(clipped,{signal,maxBytes:Infinity});
    signal?.throwIfAborted();
    // Recheck aliases immediately before publication. Failed encoding/probing
    // never opens or removes a previous output; rename publishes only success.
    await distinctOutput(input,output);
    onProgress?.(1);
    signal?.throwIfAborted();
    await rename(clipped,output);
    return metadata;
  } catch(error) { throw safeFailure(error); }
  finally {
    // runProcess waits for FFmpeg and its termination helper before rejecting,
    // so no process can keep writing into this owned directory during cleanup.
    if(directory) await rm(directory,{recursive:true,force:true});
  }
}
