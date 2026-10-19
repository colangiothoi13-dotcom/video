import path from 'node:path';
import {mkdir,mkdtemp,open,realpath,rename,rm,stat} from 'node:fs/promises';
import {runProcess} from './process.mjs';
import {probeVideo,toolPaths} from './media.mjs';
import {MAX_UPLOAD_BYTES} from './validation.mjs';

const RATE=24000;
const BLOCK=2;
const COPY_BYTES=64*1024;
const RIFF_MAX_BYTES=0xffffffff;
function mediaError(code,message) { return Object.assign(new Error(message),{code}); }
const invalidAudio=()=>mediaError('DUBBING_INVALID_AUDIO','Âm thanh lồng tiếng không hợp lệ. Hãy tạo lại câu thoại và thử lại.');
const invalidTimeline=()=>mediaError('DUBBING_INVALID_TIMELINE','Thời gian lồng tiếng không hợp lệ hoặc các lượt thoại bị chồng nhau. Hãy kiểm tra lại các câu thoại.');
const tooLong=()=>mediaError('DUBBING_TOO_LONG','Lời thoại quá dài cho khoảng thời gian của câu. Hãy rút gọn bản dịch rồi tạo lại lồng tiếng.');
function safeFailure(error) {
  if(error.name==='AbortError' || error.code==='INVALID_OUTPUT' || error.code==='PROCESS_TERMINATION_FAILED' || error.code?.startsWith('DUBBING_')) return error;
  return mediaError('DUBBING_MEDIA_FAILED','Không thể xử lý âm thanh lồng tiếng. Hãy kiểm tra video và thử lại.');
}
function localPath(value,output=false) {
  if(typeof value!=='string' || !value.trim() || value.includes('\0') || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    throw output ? mediaError('INVALID_OUTPUT','Đường dẫn tệp xuất không hợp lệ.') : invalidAudio();
  }
  return path.resolve(value);
}
function validDuration(value) { return Number.isFinite(value) && value>0; }
const samePath=(left,right)=>process.platform==='win32' ? left.toLowerCase()===right.toLowerCase() : left===right;

async function distinctOutput(inputs,output) {
  let outputInfo,outputReal=output;
  try { outputInfo=await stat(output); outputReal=await realpath(output); }
  catch(error) { if(error.code!=='ENOENT') throw error; }
  for(const input of inputs) {
    if(samePath(input,output)) throw mediaError('INVALID_OUTPUT','Tệp xuất phải khác các tệp nguồn.');
    const inputReal=await realpath(input),inputInfo=await stat(inputReal);
    if(samePath(inputReal,outputReal) || (outputInfo && inputInfo.dev===outputInfo.dev && inputInfo.ino===outputInfo.ino)) {
      throw mediaError('INVALID_OUTPUT','Tệp xuất phải khác các tệp nguồn.');
    }
  }
}

async function temporaryOutput(output,signal,action) {
  signal?.throwIfAborted();
  const parent=path.dirname(output);
  await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(path.join(parent,'.dubbing-'));
  // Only this newly created, direct child may ever be recursively removed.
  if(path.dirname(directory)!==parent || !path.basename(directory).startsWith('.dubbing-')) throw mediaError('INVALID_OUTPUT','Không thể tạo thư mục xuất an toàn.');
  try { return await action(directory); }
  finally { await rm(directory,{recursive:true,force:true}); }
}

async function readExact(file,buffer,position) {
  let offset=0;
  while(offset<buffer.length) {
    const {bytesRead}=await file.read(buffer,offset,buffer.length-offset,position+offset);
    if(!bytesRead) throw invalidAudio();
    offset+=bytesRead;
  }
}

function safeWaveCount(value) {
  if(value>BigInt(Number.MAX_SAFE_INTEGER)) throw invalidAudio();
  return Number(value);
}

/** Inspect RIFF/RF64 chunks without loading audio or assuming a fixed-size header. */
async function inspectWave(filename,{canonical=false,signal}={}) {
  signal?.throwIfAborted();
  let file;
  try {
    file=await open(filename,'r');
    const info=await file.stat();
    if(!info.isFile() || !Number.isSafeInteger(info.size) || info.size<44 || (!canonical && info.size>MAX_UPLOAD_BYTES)) throw invalidAudio();
    const header=Buffer.alloc(12);
    await readExact(file,header,0);
    const signature=header.toString('ascii',0,4),rf64=signature==='RF64';
    if((signature!=='RIFF' && !rf64) || header.toString('ascii',8,12)!=='WAVE' || (rf64 ? header.readUInt32LE(4)!==RIFF_MAX_BYTES : header.readUInt32LE(4)+8!==info.size)) throw invalidAudio();
    let format,data,ds64,chunks=0,offset=12;
    while(offset<info.size) {
      signal?.throwIfAborted();
      if(offset+8>info.size || ++chunks>10000) throw invalidAudio();
      const chunk=Buffer.alloc(8);
      await readExact(file,chunk,offset);
      const name=chunk.toString('ascii',0,4),declaredSize=chunk.readUInt32LE(4);
      let size=declaredSize;
      if(name==='data' && declaredSize===RIFF_MAX_BYTES) {
        if(!rf64 || !ds64) throw invalidAudio();
        size=ds64.dataBytes;
      } else if(rf64 && (declaredSize===RIFF_MAX_BYTES || name==='data')) throw invalidAudio();
      const next=offset+8+size+(size%2);
      if(!Number.isSafeInteger(next) || next>info.size) throw invalidAudio();
      if(name==='ds64') {
        // Generated RF64 tracks have one data chunk and need no size-table entries.
        if(!rf64 || ds64 || offset!==12 || size!==28) throw invalidAudio();
        const value=Buffer.alloc(28); await readExact(file,value,offset+8);
        ds64={riffBytes:safeWaveCount(value.readBigUInt64LE(0)),dataBytes:safeWaveCount(value.readBigUInt64LE(8)),frames:safeWaveCount(value.readBigUInt64LE(16))};
        if(ds64.riffBytes!==info.size-8 || !ds64.dataBytes || !ds64.frames || value.readUInt32LE(24)!==0) throw invalidAudio();
      } else if(name==='fmt ') {
        if(format || size<16) throw invalidAudio();
        const value=Buffer.alloc(Math.min(size,64));
        await readExact(file,value,offset+8);
        let encoding=value.readUInt16LE(0);
        if(encoding===0xfffe) {
          if(size<40 || value.readUInt16LE(16)<22 || !value.subarray(28,40).equals(Buffer.from('00001000800000aa00389b71','hex'))) throw invalidAudio();
          encoding=value.readUInt32LE(24);
        }
        const channels=value.readUInt16LE(2),rate=value.readUInt32LE(4),byteRate=value.readUInt32LE(8),block=value.readUInt16LE(12),bits=value.readUInt16LE(14);
        if(![1,3].includes(encoding) || !Number.isInteger(channels) || channels<1 || channels>8 || rate<8000 || rate>192000 ||
          !(encoding===1 ? [8,16,24,32] : [32,64]).includes(bits) || block!==channels*bits/8 || byteRate!==rate*block) throw invalidAudio();
        format={encoding,channels,rate,bits,block};
      } else if(name==='data') {
        if(data || size===0) throw invalidAudio();
        data={offset:offset+8,size};
      }
      offset=next;
    }
    if(!format || !data || data.size%format.block) throw invalidAudio();
    const frames=data.size/format.block,duration=frames/format.rate;
    if((rf64 && (!ds64 || ds64.dataBytes!==data.size || ds64.frames!==frames)) || !validDuration(duration) || (canonical && (format.encoding!==1 || format.channels!==1 || format.rate!==RATE || format.bits!==16))) throw invalidAudio();
    return {...format,...data,frames,duration};
  } catch(error) {
    if(error.name==='AbortError') throw error;
    throw invalidAudio();
  } finally { await file?.close(); }
}

export async function prepareSpeechClip({inputPath,outputPath,slotSeconds,signal}) {
  try {
    signal?.throwIfAborted();
    const input=localPath(inputPath),output=localPath(outputPath,true);
    if(!validDuration(slotSeconds) || Math.floor(slotSeconds*RATE)<1) throw invalidTimeline();
    await distinctOutput([input],output);
    const source=await inspectWave(input,{signal});
    if(source.duration>slotSeconds*2+1e-9) throw tooLong();
    return await temporaryOutput(output,signal,async directory=>{
      const prepared=path.join(directory,'speech.wav');
      let speed=Math.min(2,Math.max(1,source.duration/slotSeconds)),precise=false;
      for(let attempt=0;attempt<5;attempt++) {
        const filters=speed===1 ? [] : ['-af',`${precise ? 'rubberband=tempo' : 'atempo'}=${speed.toFixed(12)}`];
        await runProcess(toolPaths.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-i',input,'-map','0:a:0','-vn',...filters,'-ac','1','-ar',String(RATE),'-c:a','pcm_s16le','-f','wav','-y',prepared],{signal});
        const audio=await inspectWave(prepared,{canonical:true,signal});
        if(audio.frames<=Math.floor(slotSeconds*RATE+1e-7)) {
          signal?.throwIfAborted();
          await rename(prepared,output);
          return {duration:audio.duration,speed};
        }
        // atempo works in windows: re-render the full source with a small timing
        // margin if sample rounding overshoots. Never trim the spoken payload.
        // The bundled FFmpeg includes Rubber Band. At the exact 2x boundary it
        // preserves the complete phrase while avoiding atempo's window overrun.
        if(speed===2 && !precise) { precise=true; continue; }
        if(speed===1 || speed===2) throw tooLong();
        speed=Math.min(2,speed*(audio.duration+0.003)/slotSeconds);
      }
      throw tooLong();
    });
  } catch(error) { throw safeFailure(error); }
}

function waveHeader(frames) {
  const bytes=frames*BLOCK,rf64=bytes+36>RIFF_MAX_BYTES,header=Buffer.alloc(rf64?80:44),formatOffset=rf64?48:12,dataOffset=rf64?72:36;
  header.write(rf64?'RF64':'RIFF'); header.writeUInt32LE(rf64?RIFF_MAX_BYTES:bytes+36,4); header.write('WAVE',8);
  if(rf64) {
    header.write('ds64',12); header.writeUInt32LE(28,16);
    header.writeBigUInt64LE(BigInt(bytes+72),20); header.writeBigUInt64LE(BigInt(bytes),28); header.writeBigUInt64LE(BigInt(frames),36);
    header.writeUInt32LE(0,44);
  }
  header.write('fmt ',formatOffset); header.writeUInt32LE(16,formatOffset+4); header.writeUInt16LE(1,formatOffset+8); header.writeUInt16LE(1,formatOffset+10);
  header.writeUInt32LE(RATE,formatOffset+12); header.writeUInt32LE(RATE*BLOCK,formatOffset+16); header.writeUInt16LE(BLOCK,formatOffset+20); header.writeUInt16LE(16,formatOffset+22);
  header.write('data',dataOffset); header.writeUInt32LE(rf64?RIFF_MAX_BYTES:bytes,dataOffset+4);
  return header;
}
async function writeAll(file,buffer,position) {
  let offset=0;
  while(offset<buffer.length) {
    const {bytesWritten}=await file.write(buffer,offset,buffer.length-offset,position+offset);
    if(!bytesWritten) throw invalidAudio();
    offset+=bytesWritten;
  }
}

export async function buildVoiceTrack({clips,duration,outputPath,signal}) {
  try {
    signal?.throwIfAborted();
    const output=localPath(outputPath,true);
    if(!validDuration(duration) || !Array.isArray(clips)) throw invalidTimeline();
    const frames=Math.round(duration*RATE);
    if(!Number.isSafeInteger(frames) || frames<1 || !Number.isSafeInteger(frames*BLOCK+80)) throw invalidTimeline();
    const ordered=clips.map(clip=>{
      if(!clip || !Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.start<0 || clip.end<=clip.start || clip.end>duration) throw invalidTimeline();
      return {...clip,path:localPath(clip.path),startFrame:Math.round(clip.start*RATE),endFrame:Math.round(clip.end*RATE)};
    }).sort((left,right)=>left.start-right.start);
    for(let index=0;index<ordered.length;index++) {
      if(ordered[index].endFrame<=ordered[index].startFrame || (index && ordered[index].start<ordered[index-1].end)) throw invalidTimeline();
    }
    await distinctOutput(ordered.map(clip=>clip.path),output);
    // Validate every clip before creating any timeline output.
    for(const clip of ordered) {
      clip.audio=await inspectWave(clip.path,{canonical:true,signal});
      if(clip.audio.frames>clip.endFrame-clip.startFrame) throw tooLong();
    }
    return await temporaryOutput(output,signal,async directory=>{
      const timeline=path.join(directory,'voices.wav');
      const destination=await open(timeline,'wx');
      try {
        const header=waveHeader(frames);
        await writeAll(destination,header,0);
        // Extending a regular file guarantees zero-filled gaps, without a large
        // allocation or one FFmpeg command-line argument for every utterance.
        await destination.truncate(header.length+frames*BLOCK);
        const buffer=Buffer.alloc(COPY_BYTES);
        for(const clip of ordered) {
          const source=await open(clip.path,'r');
          try {
            for(let copied=0;copied<clip.audio.size;) {
              signal?.throwIfAborted();
              const chunk=buffer.subarray(0,Math.min(COPY_BYTES,clip.audio.size-copied));
              await readExact(source,chunk,clip.audio.offset+copied);
              await writeAll(destination,chunk,header.length+clip.startFrame*BLOCK+copied);
              copied+=chunk.length;
            }
          } finally { await source.close(); }
        }
      } finally { await destination.close(); }
      signal?.throwIfAborted();
      await rename(timeline,output);
      return output;
    });
  } catch(error) { throw safeFailure(error); }
}

export async function mixDubbedVideo({inputPath,voiceTrackPath,outputPath,duration,signal,onProgress}) {
  try {
    signal?.throwIfAborted();
    const input=localPath(inputPath),voices=localPath(voiceTrackPath),output=localPath(outputPath,true);
    if(!validDuration(duration)) throw invalidTimeline();
    await distinctOutput([input,voices],output);
    await probeVideo(input,{signal,maxBytes:Infinity});
    const track=await inspectWave(voices,{canonical:true,signal});
    if(Math.abs(track.duration-duration)>1/RATE) throw invalidTimeline();
    return await temporaryOutput(output,signal,async directory=>{
      const mixed=path.join(directory,'dubbed.mp4');
      // Leave bounded tail room for filter/encoder flushing when the copied
      // video stream reaches EOF. The output's -t removes only this padding.
      const filters=[
        '[1:a:0]aresample=48000,aformat=sample_fmts=fltp,apad=pad_dur=1,asplit=2[voice][sidechain]',
        '[0:a:0]aresample=48000,aformat=sample_fmts=fltp,apad=pad_dur=1[original]',
        '[original][sidechain]sidechaincompress=threshold=0.008:ratio=16:attack=4:release=180:makeup=1[ducked]',
        '[ducked][voice]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=0:latency=1[mixed]',
      ].join(';');
      await runProcess(toolPaths.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-i',input,'-i',voices,'-filter_complex',filters,'-map','0:v:0','-map','[mixed]','-c:v','copy','-c:a','aac','-b:a','160k','-t',String(duration),'-movflags','+faststart','-progress','pipe:1','-nostats','-y',mixed],{signal,onProgress:line=>{
        const match=line.match(/^out_time_us=(\d+)$/);
        if(match) onProgress?.(Math.min(1,Number(match[1])/1_000_000/duration));
        if(line==='progress=end') onProgress?.(1);
      }});
      const metadata=await probeVideo(mixed,{signal,maxBytes:Infinity});
      signal?.throwIfAborted();
      await rename(mixed,output);
      return metadata;
    });
  } catch(error) { throw safeFailure(error); }
}
