import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {toolPaths} from '../lib/media.mjs';
import {runProcess} from '../lib/process.mjs';

const media=await import('../lib/dubbing-media.mjs').catch(error=>{
  if(error.code==='ERR_MODULE_NOT_FOUND' && error.message.includes('dubbing-media.mjs')) return {};
  throw error;
});
const ffmpeg=args=>runProcess(toolPaths.ffmpeg,['-hide_banner','-loglevel','error','-nostdin',...args]);
async function fixture(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'dubbing âm thanh-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return directory;
}
async function tone(output,duration,{frequency=880,rate=24000,channels=1}={}) {
  await ffmpeg(['-f','lavfi','-i',`sine=frequency=${frequency}:sample_rate=${rate}:duration=${duration}`,'-ac',String(channels),'-c:a','pcm_s16le','-y',output]);
}
function wave(buffer) {
  assert.equal(buffer.toString('ascii',0,4),'RIFF');
  let format,data;
  for(let offset=12;offset+8<=buffer.length;) {
    const name=buffer.toString('ascii',offset,offset+4),size=buffer.readUInt32LE(offset+4);
    if(name==='fmt ') format={encoding:buffer.readUInt16LE(offset+8),channels:buffer.readUInt16LE(offset+10),rate:buffer.readUInt32LE(offset+12),bits:buffer.readUInt16LE(offset+22)};
    if(name==='data') data=buffer.subarray(offset+8,offset+8+size);
    offset+=8+size+(size%2);
  }
  assert.ok(format && data);
  return {...format,data,duration:data.length/(format.rate*format.channels*format.bits/8)};
}
function rms(audio,start,end) {
  let sum=0,count=0;
  for(let i=Math.round(start*audio.rate);i<Math.round(end*audio.rate);i++) { sum+=(audio.data.readInt16LE(i*2)/32768)**2; count++; }
  return Math.sqrt(sum/count);
}
function amplitude(audio,start,end,frequency) {
  let real=0,imaginary=0,count=0;
  for(let i=Math.round(start*audio.rate);i<Math.round(end*audio.rate);i++) {
    const sample=audio.data.readInt16LE(i*2)/32768,angle=2*Math.PI*frequency*i/audio.rate;
    real+=sample*Math.cos(angle); imaginary+=sample*Math.sin(angle); count++;
  }
  return 2*Math.hypot(real,imaginary)/count;
}
async function video(output,duration=3) {
  await ffmpeg(['-f','lavfi','-i',`color=c=blue:s=96x64:r=10:d=${duration}`,'-f','lavfi','-i',`sine=frequency=440:sample_rate=48000:duration=${duration}`,'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-y',output]);
}

test('speech preparation preserves fitting phrases and converts stereo WAV to 24 kHz mono PCM',async t=>{
  assert.equal(typeof media.prepareSpeechClip,'function','speech clip preparation must exist');
  const dir=await fixture(t),input=path.join(dir,'source.wav'),output=path.join(dir,'prepared.wav');
  await tone(input,0.6,{rate:44100,channels:2});
  const result=await media.prepareSpeechClip({inputPath:input,outputPath:output,slotSeconds:1});
  const audio=wave(await readFile(output));
  assert.deepEqual([audio.encoding,audio.rate,audio.channels,audio.bits],[1,24000,1,16]);
  assert.equal(result.speed,1,'a phrase that fits must retain its natural speaking speed');
  assert.ok(Math.abs(result.duration-0.6)<1/24000);
  assert.ok(rms(audio,0.05,0.55)>0.05);
});

test('speech preparation fits complete audio within its slot with at most twofold tempo',async t=>{
  assert.equal(typeof media.prepareSpeechClip,'function');
  const dir=await fixture(t),input=path.join(dir,'source.wav');
  await tone(input,1);
  for(const slotSeconds of [0.7,0.5,0.5-Number.EPSILON]) {
    const output=path.join(dir,`prepared-${slotSeconds}.wav`);
    const result=await media.prepareSpeechClip({inputPath:input,outputPath:output,slotSeconds});
    const audio=wave(await readFile(output));
    assert.ok(result.speed>1 && result.speed<=2);
    assert.ok(audio.duration<=slotSeconds+1e-9,`${audio.duration} must fit ${slotSeconds}`);
    assert.equal(result.duration,audio.duration);
    assert.ok(audio.duration>slotSeconds-0.06,'tempo adjustment must retain the complete phrase');
    assert.ok(rms(audio,0.02,audio.duration-0.02)>0.05);
  }
});

test('oversized or invalid speech leaves source and any published output untouched',async t=>{
  assert.equal(typeof media.prepareSpeechClip,'function');
  const dir=await fixture(t),input=path.join(dir,'source.wav'),output=path.join(dir,'published.wav');
  await tone(input,1);
  const source=await readFile(input);
  await writeFile(output,'previous successful audio');
  await assert.rejects(media.prepareSpeechClip({inputPath:input,outputPath:output,slotSeconds:0.4}),error=>error.code==='DUBBING_TOO_LONG' && /rút gọn/i.test(error.message) && !error.message.includes(dir));
  assert.equal(await readFile(output,'utf8'),'previous successful audio');
  assert.deepEqual(await readFile(input),source);
  await assert.rejects(media.prepareSpeechClip({inputPath:input,outputPath:input,slotSeconds:1}),error=>error.code==='INVALID_OUTPUT');
  await writeFile(path.join(dir,'invalid.wav'),Buffer.from('RIFF-not-real-audio'));
  await assert.rejects(media.prepareSpeechClip({inputPath:path.join(dir,'invalid.wav'),outputPath:output,slotSeconds:1}),error=>error.code==='DUBBING_INVALID_AUDIO');
  assert.deepEqual((await readdir(dir)).filter(name=>name.startsWith('.dubbing-')),[]);
});

test('voice timeline places metadata-bearing clips at source times with exact silence and deterministic padding',async t=>{
  assert.equal(typeof media.buildVoiceTrack,'function','voice timeline must exist');
  const dir=await fixture(t),first=path.join(dir,'first.wav'),second=path.join(dir,'second.wav');
  await tone(first,0.2,{frequency:880}); await tone(second,0.2,{frequency:1320});
  // An odd-length metadata chunk prevents assumptions about a fixed 44-byte WAV header.
  const original=await readFile(second),junk=Buffer.alloc(12);
  junk.write('JUNK'); junk.writeUInt32LE(3,4); junk.write('abc',8);
  const tagged=Buffer.concat([original.subarray(0,12),junk,original.subarray(12)]);
  tagged.writeUInt32LE(tagged.length-8,4); await writeFile(second,tagged);
  const clips=[{path:first,start:0.5,end:0.8},{path:second,start:1.5,end:1.8}];
  const output=path.join(dir,'track.wav'),again=path.join(dir,'again.wav');
  assert.equal(await media.buildVoiceTrack({clips,duration:2.5,outputPath:output}),output);
  await media.buildVoiceTrack({clips:[...clips].reverse(),duration:2.5,outputPath:again});
  const bytes=await readFile(output),audio=wave(bytes);
  assert.equal(audio.duration,2.5);
  assert.equal(audio.data.length,120000);
  for(const [start,end] of [[0,0.5],[0.7,1.5],[1.7,2.5]]) assert.equal(rms(audio,start,end),0);
  assert.ok(amplitude(audio,0.52,0.68,880)>0.1);
  assert.ok(amplitude(audio,1.52,1.68,1320)>0.1);
  assert.deepEqual(await readFile(again),bytes);
});

test('timeline rejects overlap, nonfinite timing and phrase overflow without replacing output',async t=>{
  assert.equal(typeof media.buildVoiceTrack,'function');
  const dir=await fixture(t),input=path.join(dir,'source.wav'),output=path.join(dir,'track.wav');
  await tone(input,0.2); await writeFile(output,'previous track');
  for(const clips of [
    [{path:input,start:0,end:0.3},{path:input,start:0.2,end:0.5}],
    [{path:input,start:NaN,end:0.4}],
    [{path:input,start:0,end:Infinity}],
    [{path:input,start:0,end:0.1}],
  ]) await assert.rejects(media.buildVoiceTrack({clips,duration:1,outputPath:output}),error=>/^DUBBING_/.test(error.code));
  await assert.rejects(media.buildVoiceTrack({clips:[{path:input,start:0,end:0.3}],duration:1,outputPath:input}),error=>error.code==='INVALID_OUTPUT');
  assert.equal(await readFile(output,'utf8'),'previous track');
});

test('real mix copies captioned video and ducks background only while dubbed speech is active',async t=>{
  assert.equal(typeof media.mixDubbedVideo,'function','dubbed mix must exist');
  const dir=await fixture(t),input=path.join(dir,'captioned.mp4'),speech=path.join(dir,'speech.wav'),track=path.join(dir,'track.wav'),output=path.join(dir,'dubbed.mp4');
  await video(input); await tone(speech,0.8);
  await media.buildVoiceTrack({clips:[{path:speech,start:1,end:1.8}],duration:3,outputPath:track});
  const progress=[],metadata=await media.mixDubbedVideo({inputPath:input,voiceTrackPath:track,outputPath:output,duration:3,onProgress:value=>progress.push(value)});
  assert.ok(metadata.hasAudio && Math.abs(metadata.duration-3)<0.1);
  assert.ok(progress.some(value=>value>0 && value<=1));
  const hash=async file=>(await ffmpeg(['-i',file,'-map','0:v:0','-c','copy','-f','hash','-hash','sha256','-'])).stdout;
  assert.equal(await hash(output),await hash(input),'captioned H.264 packets must be copied exactly');
  const decoded=path.join(dir,'decoded.wav');
  await ffmpeg(['-i',output,'-map','0:a:0','-ar','24000','-ac','1','-c:a','pcm_s16le','-y',decoded]);
  const audio=wave(await readFile(decoded)),quiet=amplitude(audio,0.3,0.7,440),during=amplitude(audio,1.2,1.6,440);
  assert.ok(quiet>0.09,`original audio must remain audible in speech gaps (${quiet})`);
  assert.ok(during<quiet*0.6,`background must duck during speech (${during}/${quiet})`);
  assert.ok(amplitude(audio,1.2,1.6,880)>0.09,'the Vietnamese voice track must be mixed in');
  assert.ok(amplitude(audio,2.4,2.8,440)>quiet*0.9,'background must recover after speech');
  const probe=JSON.parse((await runProcess(toolPaths.ffprobe,['-v','error','-show_streams','-of','json',output])).stdout);
  assert.equal(probe.streams.find(stream=>stream.codec_type==='audio').codec_name,'aac');
});

test('cancelled mix settles before cleaning temporary files and preserves published output', {timeout:20000},async t=>{
  assert.equal(typeof media.mixDubbedVideo,'function');
  const dir=await fixture(t),input=path.join(dir,'captioned.mp4'),track=path.join(dir,'track.wav'),output=path.join(dir,'published.mp4');
  await video(input); await media.buildVoiceTrack({clips:[],duration:3,outputPath:track});
  await writeFile(output,'previous successful video');
  const cancelled=new AbortController(); cancelled.abort();
  await assert.rejects(media.buildVoiceTrack({clips:[],duration:1500,outputPath:path.join(dir,'cancelled.wav'),signal:cancelled.signal}),error=>error.name==='AbortError');
  await assert.rejects(stat(path.join(dir,'cancelled.wav')),error=>error.code==='ENOENT');
  const controller=new AbortController();
  let cancellation;
  try { await media.mixDubbedVideo({inputPath:input,voiceTrackPath:track,outputPath:output,duration:3,signal:controller.signal,onProgress:()=>controller.abort()}); }
  catch(error) { cancellation=error; }
  assert.equal(await readFile(output,'utf8'),'previous successful video');
  assert.deepEqual((await readdir(dir)).filter(name=>name.startsWith('.dubbing-')),[]);
  assert.equal(cancellation?.name,'AbortError',`cancel must settle as AbortError (${cancellation?.code})`);
});
