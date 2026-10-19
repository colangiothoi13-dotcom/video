import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,rm,readFile,writeFile,link,symlink,readdir,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {watch} from 'node:fs';
import {toolPaths} from '../lib/media.mjs';
import {runProcess} from '../lib/process.mjs';
import {buildNarratedTimeline,probeNarratedClip,assembleNarratedVideo} from '../lib/narrated-media.mjs';
import * as narratedMedia from '../lib/narrated-media.mjs';

test('timeline covers silence and splits long speech into <=8 second windows with a short final clip',()=>{
  const windows=buildNarratedTimeline([{id:'s1',start:1,end:17,text:'A long continuous sentence.'}],18.3);
  assert.deepEqual(windows.map(({id,start,end,generationDurationSeconds})=>({id,start,end,generationDurationSeconds})),[
    {id:'scene-1',start:0,end:8,generationDurationSeconds:8},
    {id:'scene-2',start:8,end:16,generationDurationSeconds:8},
    {id:'scene-3',start:16,end:18.3,generationDurationSeconds:4},
  ]);
  assert.deepEqual(windows[1].transcriptIds,['s1']);assert.equal(windows[1].transcriptText,'A long continuous sentence.');
  const short=buildNarratedTimeline([{id:'s',start:.1,end:.5,text:'Hello.'}],2.3);
  assert.equal(short[0].end,2.3);assert.equal(short[0].generationDurationSeconds,4);
});

test('timeline prefers sentence boundaries, retains silent windows and rejects malformed ASR',()=>{
  const windows=buildNarratedTimeline([{id:'s1',start:0,end:5,text:'First.'},{id:'s2',start:5,end:12,text:'Second.'}],25);
  assert.deepEqual(windows.map(w=>[w.start,w.end,w.generationDurationSeconds]),[[0,5,6],[5,12,8],[12,20,8],[20,25,6]]);
  assert.equal(windows.at(-1).transcriptText,'');
  for(const transcript of [null,[],[{id:'s',start:0,end:2,text:''}],[{id:'s',start:0,end:NaN,text:'x'}],[{id:'s',start:2,end:1,text:'x'}],[{id:'s',start:0,end:30,text:'x'}],[{id:'s',start:0,end:1,text:'x'},{id:'s',start:2,end:3,text:'y'}]])assert.throws(()=>buildNarratedTimeline(transcript,25));
  for(const duration of [0,-1,NaN,Infinity,Number.MAX_VALUE,Number.MAX_SAFE_INTEGER,.001])assert.throws(()=>buildNarratedTimeline([{id:'s',start:0,end:.0001,text:'x'}],duration));
});

test('timeline preserves ASR-order boundary ties and overlapping speech when segment ends are unordered',()=>{
  const windows=buildNarratedTimeline([
    {id:'a',start:0,end:7,text:' A '},{id:'b',start:1,end:5,text:'B'},
    {id:'c',start:4,end:14,text:'C'},{id:'d',start:5,end:7,text:'D'},
    {id:'e',start:6,end:13,text:'E'},{id:'f',start:18,end:21,text:'F'},
  ],26.001);
  assert.deepEqual(windows.map(w=>[w.start,w.end,w.generationDurationSeconds,w.transcriptIds,w.transcriptText]),[
    [0,7,8,['a','b','c','d','e'],'A B C D E'],
    [7,13,6,['c','e'],'C E'],
    [13,21,8,['c','f'],'C F'],
    [21,26.001,6,[],''],
  ]);
});

test('full long timelines exceed 1500 windows without rescanning the complete transcript for every window',()=>{
  let endReads=0;
  const transcript=Array.from({length:4000},(_,i)=>({id:`s${i}`,start:i*5.993,get end(){endReads++;return (i+1)*5.993;},text:`Sentence ${i}.`}));
  const windows=buildNarratedTimeline(transcript,23972.001);
  assert.equal(windows.length,4000);assert.equal(windows[0].start,0);assert.equal(windows.at(-1).end,23972.001);
  assert.deepEqual(windows.at(-1).transcriptIds,['s3999']);
  let frames=0;
  for(let i=0;i<windows.length;i++){
    const window=windows[i];if(i)assert.equal(window.start,windows[i-1].end);
    assert.ok(window.end>window.start&&window.end-window.start<=8);
    const count=Math.round(window.end*24)-Math.round(window.start*24);assert.ok(count>0);frames+=count;
    assert.ok([4,6,8].includes(window.generationDurationSeconds));
  }
  assert.equal(frames,575328);assert.ok(endReads<400_000,`unexpected whole-transcript scanning: ${endReads} reads`);
});

test('long fractional timelines have no gaps or zero-frame tails',()=>{
  const transcript=Array.from({length:250},(_,i)=>({id:`s${i}`,start:i*5.993,end:(i+1)*5.993,text:'A sentence.'}));
  const windows=buildNarratedTimeline(transcript,1499.001);
  assert.equal(windows[0].start,0);assert.equal(windows.at(-1).end,1499.001);
  let frames=0;
  for(let i=0;i<windows.length;i++){const w=windows[i];if(i)assert.equal(w.start,windows[i-1].end);assert.ok(w.end-w.start<=8);const n=Math.round(w.end*24)-Math.round(w.start*24);assert.ok(n>0);frames+=n;}
  assert.equal(frames,35976);
  const tail=buildNarratedTimeline([{id:'s',start:0,end:8,text:'Sentence.'}],8.001);
  assert.ok(tail.every(w=>Math.round(w.end*24)>Math.round(w.start*24)&&w.end-w.start<=8));
});

async function directory(t){const dir=await mkdtemp(path.join(tmpdir(),'narrated-media-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function ffmpeg(args){return runProcess(toolPaths.ffmpeg,['-hide_banner','-loglevel','error','-nostdin',...args]);}
async function makeClip(file,{duration=1,frequency=0,rate=30}={}){await ffmpeg(['-f','lavfi','-i',`color=c=green:s=96x64:r=${rate}:d=${duration}`,...(frequency?['-f','lavfi','-i',`sine=frequency=${frequency}:sample_rate=48000:duration=${duration}`]:[]),'-c:v','libx264','-pix_fmt','yuv420p',...(frequency?['-c:a','aac']:['-an']),'-y',file]);}
async function samples(file,output){await ffmpeg(['-i',file,'-map','0:a:0','-ac','1','-ar','8000','-f','f32le','-y',output]);const bytes=await readFile(output);return new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));}
function rms(data,start,end){let sum=0;const a=Math.round(start*8000),b=Math.min(data.length,Math.round(end*8000));for(let i=a;i<b;i++)sum+=data[i]**2;return Math.sqrt(sum/(b-a));}
function energy(data,frequency,start,end){let real=0,imag=0;for(let i=Math.round(start*8000);i<Math.round(end*8000);i++){real+=data[i]*Math.cos(2*Math.PI*frequency*i/8000);imag+=data[i]*Math.sin(2*Math.PI*frequency*i/8000);}return Math.hypot(real,imag);}

test('silent generated clips are valid video and broken files are rejected',async t=>{
  const dir=await directory(t),file=path.join(dir,'silent.mp4');await makeClip(file);
  const info=await probeNarratedClip(file);assert.equal(info.hasAudio,false);assert.equal(info.width,96);assert.ok(info.duration>=1);
  const bad=path.join(dir,'bad.mp4');await writeFile(bad,'not media');await assert.rejects(probeNarratedClip(bad),{code:'INVALID_VIDEO'});
});

test('artifact probing accepts valid MP4s beyond the importer-only 500MB source limit',async t=>{
  const dir=await directory(t),file=path.join(dir,'large-artifact.mp4');await makeClip(file);
  const handle=await open(file,'r+');try{await handle.truncate(500_000_001);}finally{await handle.close();}
  const metadata=await probeNarratedClip(file);assert.equal(metadata.width,96);assert.ok(metadata.duration>=1);
});

test('real assembly uses source frequency, preserves its delayed start and end silence, and cumulative frames',{timeout:120000},async t=>{
  const dir=await directory(t),source=path.join(dir,'source.mp4'),silent=path.join(dir,'silent.mp4'),noisy=path.join(dir,'generated.mp4'),output=path.join(dir,'output.mp4');
  await ffmpeg(['-f','lavfi','-i','color=c=blue:s=96x64:r=24:d=2.38','-itsoffset','0.4','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1.2','-c:v','libx264','-c:a','aac','-y',source]);
  await makeClip(silent);await makeClip(noisy,{frequency:880,rate:25});
  const boundaries=[0,.26,.52,.78,1.04,1.3,1.56,1.82,2.08,2.38];
  const scenes=boundaries.slice(0,-1).map((start,i)=>({start,end:boundaries[i+1],path:i%2?silent:noisy}));
  const result=await assembleNarratedVideo({scenes,inputPath:source,outputPath:output,duration:2.38,aspectRatio:'16:9'});
  assert.equal(result.width,1280);assert.equal(result.height,720);assert.ok(Math.abs(result.duration-2.38)<=.1);assert.equal(result.frameCount,57);
  const info=JSON.parse((await runProcess(toolPaths.ffprobe,['-v','error','-show_streams','-of','json',output])).stdout),v=info.streams.find(s=>s.codec_type==='video');
  assert.equal(v.nb_frames,'57');assert.equal(v.avg_frame_rate,'24/1');assert.equal(v.codec_name,'h264');
  const data=await samples(output,path.join(dir,'audio.raw'));assert.ok(rms(data,.05,.25)<.002);assert.ok(rms(data,.6,1.3)>.05);assert.ok(rms(data,1.9,2.2)<.002);
  assert.ok(energy(data,440,.6,1.3)>energy(data,880,.6,1.3)*20);
  const before=await readFile(output);
  await assert.rejects(assembleNarratedVideo({scenes:[{start:0,end:2.38,path:silent}],inputPath:source,outputPath:output,duration:2.38,aspectRatio:'16:9'}),{code:'AI_ASSEMBLY'});
  assert.deepEqual(await readFile(output),before);
});

test('source audio before a nonzero video start survives from the container origin',{timeout:60000},async t=>{
  const dir=await directory(t),source=path.join(dir,'offset-source.mp4'),silent=path.join(dir,'silent.mp4'),output=path.join(dir,'output.mp4');
  await ffmpeg(['-itsoffset','0.4','-f','lavfi','-i','color=c=blue:s=96x64:r=25:d=2','-f','lavfi','-i','aevalsrc=if(lt(t\\,0.4)\\,0.1*sin(2*PI*880*t)\\,0.1*sin(2*PI*440*t)):s=48000:d=1.4','-fps_mode','passthrough','-c:v','libx264','-c:a','aac','-y',source]);
  const sourceMetadata=await probeNarratedClip(source);assert.ok(sourceMetadata.videoStart>=.39);assert.equal(sourceMetadata.audioStart,0);
  await makeClip(silent,{duration:2.4});
  await assembleNarratedVideo({scenes:[{start:0,end:2.4,path:silent}],inputPath:source,outputPath:output,duration:2.4,aspectRatio:'9:16'});
  const metadata=await probeNarratedClip(output);assert.equal(metadata.width,720);assert.equal(metadata.height,1280);
  const data=await samples(output,path.join(dir,'audio.raw'));
  assert.ok(energy(data,880,.1,.3)>energy(data,440,.1,.3)*20,'pre-video original voice must survive');assert.ok(energy(data,440,.6,.9)>energy(data,880,.6,.9)*20);assert.ok(rms(data,1.7,2.1)<.002);
});

test('assembly rejects output aliases of the original source and every scene before changing files',{timeout:60000},async t=>{
  const dir=await directory(t),source=path.join(dir,'source.mp4'),clip=path.join(dir,'clip.mp4'),junction=path.join(dir,'alias');
  await makeClip(source,{duration:1,frequency:440});await makeClip(clip,{duration:1});
  const originals=new Map([[source,await readFile(source)],[clip,await readFile(clip)]]);
  await symlink(dir,junction,process.platform==='win32'?'junction':'dir');
  const aliases=[];
  for(const input of [source,clip]){
    const hardlink=path.join(dir,`hardlink-${path.basename(input)}`);await link(input,hardlink);
    aliases.push(input,path.join(dir,'unused','..',path.basename(input)),hardlink,path.join(junction,path.basename(input)));
    if(process.platform==='win32')aliases.push(input.toUpperCase());
  }
  const args={scenes:[{start:0,end:1,path:clip}],inputPath:source,duration:1,aspectRatio:'16:9'};
  for(const outputPath of aliases){
    await assert.rejects(assembleNarratedVideo({...args,outputPath}),{code:'AI_ASSEMBLY'});
    for(const [input,bytes] of originals)assert.deepEqual(await readFile(input),bytes);
    assert.deepEqual((await readdir(dir)).filter(name=>name.startsWith('.narrated-assembly-')),[]);
  }
  const outputPath=path.join(dir,'previous.mp4');await writeFile(outputPath,'previous successful result');
  const result=await assembleNarratedVideo({...args,outputPath});assert.equal(result.width,1280);assert.equal((await probeNarratedClip(outputPath)).height,720);
  for(const [input,bytes] of originals)assert.deepEqual(await readFile(input),bytes);
});

test('long delayed source packets retain their five-second origin in assembled audio',{timeout:60000},async t=>{
  const dir=await directory(t),source=path.join(dir,'delayed.mp4'),clip=path.join(dir,'clip.mp4'),output=path.join(dir,'output.mp4');
  await ffmpeg(['-f','lavfi','-i','color=c=blue:s=96x64:r=24:d=7','-itsoffset','5','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1','-c:v','libx264','-c:a','aac','-y',source]);
  const packets=JSON.parse((await runProcess(toolPaths.ffprobe,['-v','error','-select_streams','a:0','-show_packets','-show_entries','packet=pts_time','-of','json',source])).stdout).packets;
  assert.ok(Number(packets[0].pts_time)>4.9);
  await makeClip(clip,{duration:7});
  await assembleNarratedVideo({scenes:[{start:0,end:7,path:clip}],inputPath:source,outputPath:output,duration:7,aspectRatio:'16:9'});
  const data=await samples(output,path.join(dir,'audio.raw'));assert.ok(rms(data,.2,4.7)<.002,'retain long leading silence');assert.ok(rms(data,5.2,5.8)>.05,'voice remains at source time');assert.ok(rms(data,6.3,6.8)<.002);
});

test('narrated ASR MP3 retains source-origin timing, full duration, mono16k and64k encoding',{timeout:60000},async t=>{
  assert.equal(typeof narratedMedia.extractNarratedAudio,'function');
  const dir=await directory(t);
  for(const [label,videoOffset,audioOffset,duration,toneEnd] of [['normal',0,0,2,1],['long-delay',0,5,7,6],['negative-lead',.4,0,2,1.4]]){
    const source=path.join(dir,`${label}.mp4`),audio=path.join(dir,`${label}.mp3`);
    await ffmpeg(['-itsoffset',String(videoOffset),'-f','lavfi','-i',`color=c=blue:s=96x64:r=25:d=${duration}`,'-itsoffset',String(audioOffset),'-f','lavfi','-i',videoOffset?'aevalsrc=if(lt(t\\,0.4)\\,0.1*sin(2*PI*880*t)\\,0.1*sin(2*PI*440*t)):s=48000:d=1.4':'sine=frequency=440:sample_rate=48000:duration=1','-fps_mode','passthrough','-c:v','libx264','-c:a','aac','-y',source]);
    const targetDuration=duration+videoOffset;
    const result=await narratedMedia.extractNarratedAudio(source,audio);assert.equal(result.path,path.resolve(audio));assert.ok(result.size>0&&result.size<25_000_000);assert.equal(result.duration,targetDuration);
    const metadata=JSON.parse((await runProcess(toolPaths.ffprobe,['-v','error','-show_format','-show_streams','-of','json',audio])).stdout),stream=metadata.streams[0];
    assert.equal(stream.sample_rate,'16000');assert.equal(stream.channels,1);assert.equal(stream.bit_rate,'64000');assert.ok(Math.abs(Number(metadata.format.duration)-targetDuration)<.15);
    const data=await samples(audio,path.join(dir,`${label}.raw`));assert.ok(Math.abs(data.length/8000-targetDuration)<.02);
    if(audioOffset)assert.ok(rms(data,.2,4.7)<.002,'ASR must hear the leading source silence');
    const start=audioOffset+(videoOffset ? .6 : .2);assert.ok(energy(data,440,start,start+.5)>energy(data,880,start,start+.5)*20);assert.ok(rms(data,toneEnd+.3,targetDuration-.1)<.002);
    if(videoOffset)assert.ok(energy(data,880,.1,.3)>energy(data,440,.1,.3)*20,'ASR must hear original audio before the first video frame');
  }
});

test('long source probing and ASR extraction preserve audio past 52 minutes even when the complete MP3 exceeds 25MB',{timeout:120000},async t=>{
  const dir=await directory(t),source=path.join(dir,'long.mp4'),audio=path.join(dir,'long.mp3');
  await ffmpeg(['-f','lavfi','-i','color=c=blue:s=96x64:r=1/8:d=3128','-itsoffset','3128.4','-f','lavfi','-i','aevalsrc=if(lt(t\\,2)\\,0.125*sin(2*PI*440*t)\\,0):s=16000:d=7.7250625','-c:v','libx264','-c:a','aac','-movie_timescale','16000','-y',source]);
  const sourceMetadata=await probeNarratedClip(source);assert.equal(sourceMetadata.duration,3136.125063);assert.equal(sourceMetadata.frameCount,391);
  const result=await narratedMedia.extractNarratedAudio(source,audio);assert.equal(result.duration,3136.125063);assert.ok(result.size>25_000_000);
  const metadata=JSON.parse((await runProcess(toolPaths.ffprobe,['-v','error','-show_format','-show_streams','-of','json',audio])).stdout);
  assert.ok(Math.abs(Number(metadata.format.duration)-3136.125063)<.15);assert.equal(metadata.streams[0].sample_rate,'16000');assert.equal(metadata.streams[0].channels,1);
  const excerpt=path.join(dir,'tail.wav');await ffmpeg(['-ss','3127','-i',audio,'-t','9','-c:a','pcm_s16le','-y',excerpt]);
  const data=await samples(excerpt,path.join(dir,'tail.raw'));
  assert.ok(rms(data,.1,1.1)<.002,'keep source-origin silence before late speech');
  assert.ok(rms(data,1.7,2.8)>.05,'retain the last original speech after 52 minutes');
  assert.ok(energy(data,440,1.7,2.8)>energy(data,880,1.7,2.8)*20);assert.ok(rms(data,4,8)<.002,'pad through the full source ending');
  assert.deepEqual((await readdir(dir)).filter(name=>name.startsWith('.narrated-audio-')),[]);
});

test('assembly accepts more than 1500 valid scenes and cancellation keeps the previous artifact atomic',{timeout:60000},async t=>{
  const dir=await directory(t),source=path.join(dir,'source.mp4'),clip=path.join(dir,'clip.mp4'),output=path.join(dir,'output.mp4');
  await makeClip(source,{frequency:440});await makeClip(clip,{duration:4});await writeFile(output,'previous successful result');
  const controller=new AbortController(),reason=new Error('cancel after long-scene validation');
  const watcher=watch(dir,(_event,filename)=>{if(String(filename).startsWith('.narrated-assembly-'))controller.abort(reason);});
  const timeout=setTimeout(()=>controller.abort(new Error('long-scene assembly never reached normalization')),10000);
  try{
    const scenes=Array.from({length:1501},(_,i)=>({start:i*4,end:(i+1)*4,path:clip}));
    await assert.rejects(assembleNarratedVideo({scenes,inputPath:source,outputPath:output,duration:6004,signal:controller.signal}),error=>error===reason);
  }finally{clearTimeout(timeout);watcher.close();}
  assert.equal(await readFile(output,'utf8'),'previous successful result');
  assert.deepEqual((await readdir(dir)).filter(name=>name.startsWith('.narrated-assembly-')),[]);
});
