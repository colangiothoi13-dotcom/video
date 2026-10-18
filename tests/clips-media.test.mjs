import test from 'node:test';
import assert from 'node:assert/strict';
import {link,mkdtemp,readFile,readdir,rm,stat,symlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {toolPaths} from '../lib/media.mjs';
import {runProcess} from '../lib/process.mjs';

const media=await import('../lib/clips-media.mjs').catch(error=>{
  if(error.code==='ERR_MODULE_NOT_FOUND' && error.message.includes('clips-media.mjs')) return {};
  throw error;
});
const ffmpeg=args=>runProcess(toolPaths.ffmpeg,['-hide_banner','-loglevel','error','-nostdin',...args]);
const probe=async filename=>JSON.parse((await runProcess(toolPaths.ffprobe,['-v','error','-show_format','-show_streams','-of','json',filename])).stdout);
async function fixture(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'video clips có dấu & spaces-'));
  assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return directory;
}
async function coloredVideo(output) {
  await ffmpeg([
    '-f','lavfi','-i','color=c=red:s=160x96:r=20:d=2',
    '-f','lavfi','-i','color=c=green:s=160x96:r=20:d=2',
    '-f','lavfi','-i','color=c=blue:s=160x96:r=20:d=2',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2',
    '-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=2',
    '-f','lavfi','-i','sine=frequency=1320:sample_rate=48000:duration=2',
    '-filter_complex','[0:v][1:v][2:v]concat=n=3:v=1:a=0,drawbox=x=20:y=76:w=120:h=12:color=white:t=fill[v];[3:a][4:a][5:a]concat=n=3:v=0:a=1[a]',
    '-map','[v]','-map','[a]','-c:v','libx264','-g','240','-keyint_min','240','-sc_threshold','0','-pix_fmt','yuv420p','-c:a','aac','-y',output,
  ]);
}
async function firstFrame(input,output) {
  await ffmpeg(['-i',input,'-map','0:v:0','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','-y',output]);
  return readFile(output);
}
function pixel(frame,x,y,width=160) { return [...frame.subarray((y*width+x)*3,(y*width+x)*3+3)]; }
async function audioSamples(input,output) {
  await ffmpeg(['-i',input,'-map','0:a:0','-ar','24000','-ac','1','-c:a','pcm_s16le','-f','s16le','-y',output]);
  return readFile(output);
}
function amplitude(samples,frequency) {
  let real=0,imaginary=0,count=0;
  // Skip AAC boundary samples and compare the actual selected tone.
  for(let i=2400;i<Math.min(samples.length/2,14400);i++) {
    const sample=samples.readInt16LE(i*2)/32768,angle=2*Math.PI*frequency*i/24000;
    real+=sample*Math.cos(angle); imaginary+=sample*Math.sin(angle); count++;
  }
  return 2*Math.hypot(real,imaginary)/count;
}
async function assertUnchanged(directory,input,source,output) {
  assert.deepEqual(await readFile(input),source,'the source must remain byte-for-byte unchanged');
  assert.equal(await readFile(output,'utf8'),'previous successful clip');
  assert.deepEqual((await readdir(directory)).filter(name=>name.startsWith('.clips-')),[],'owned scratch directories must be removed before settling');
}

test('manual clips reencode exact non-keyframe ranges with selected audio, burned pixels and zero-based timestamps',async t=>{
  assert.equal(typeof media.cutVideoClip,'function','manual clip media helper must exist');
  const directory=await fixture(t),input=path.join(directory,'nguồn video.mp4');
  await coloredVideo(input);
  const source=await readFile(input);
  for(const [name,start,end,color,frequency] of [['green',2.25,3.5,1,880],['blue',4.35,5.3,2,1320]]) {
    const output=path.join(directory,`${name} clip.mp4`),progress=[];
    const metadata=await media.cutVideoClip({inputPath:input,outputPath:output,start,end,onProgress:value=>progress.push(value)});
    assert.ok(Math.abs(metadata.duration-(end-start))<=0.06,`${metadata.duration} must measure the selected range`);
    assert.deepEqual([metadata.width,metadata.height,metadata.hasAudio],[160,96,true]);
    const details=await probe(output),video=details.streams.find(stream=>stream.codec_type==='video'),audio=details.streams.find(stream=>stream.codec_type==='audio');
    assert.equal(metadata.duration,Number(details.format.duration),'the helper returns measured output duration');
    assert.equal(video.codec_name,'h264'); assert.equal(audio.codec_name,'aac');
    for(const item of [details.format,video,audio]) assert.ok(Math.abs(Number(item.start_time))<0.05,`output timestamps must begin near zero (${item.start_time})`);
    const frame=await firstFrame(output,path.join(directory,`${name}.rgb`)),background=pixel(frame,5,5),caption=pixel(frame,80,80);
    assert.ok(background[color]>80 && background[color]>background[(color+1)%3]*3 && background[color]>background[(color+2)%3]*3,`first frame must be the selected ${name} scene (${background})`);
    assert.ok(caption.every(value=>value>220),'burned caption pixels must remain visible');
    const samples=await audioSamples(output,path.join(directory,`${name}.pcm`));
    assert.ok(amplitude(samples,frequency)>0.08,'selected audio must remain audible');
    assert.ok(amplitude(samples,440)<0.015,'audio from before the requested cut must be absent');
    assert.ok(progress.length>0 && progress.every(value=>Number.isFinite(value) && value>=0 && value<=1));
    assert.equal(progress.at(-1),1);
    const bytes=await readFile(output);
    assert.ok(bytes.indexOf(Buffer.from('moov'))<bytes.indexOf(Buffer.from('mdat')),'MP4 metadata must precede media for fast start');
  }
  assert.deepEqual(await readFile(input),source);
  assert.deepEqual((await readdir(directory)).filter(name=>name.startsWith('.clips-')),[]);
});

test('clips fit 720p display geometry including anamorphic pixels and display rotation',async t=>{
  assert.equal(typeof media.cutVideoClip,'function');
  const directory=await fixture(t),input=path.join(directory,'anamorphic.mp4'),rotated=path.join(directory,'rotated.mp4');
  await ffmpeg(['-f','lavfi','-i','color=c=blue:s=1440x1080:r=20:d=1','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1','-vf','setsar=4/3','-c:v','libx264','-preset','ultrafast','-c:a','aac','-y',input]);
  await ffmpeg(['-display_rotation:v:0','90','-i',input,'-c','copy','-y',rotated]);
  for(const [source,name,width,height,ratio] of [[input,'wide',1280,720,'16:9'],[rotated,'tall',720,1280,'9:16']]) {
    const output=path.join(directory,`${name}.mp4`);
    await media.cutVideoClip({inputPath:source,outputPath:output,start:0.25,end:0.75});
    const stream=(await probe(output)).streams.find(item=>item.codec_type==='video');
    assert.deepEqual([stream.width,stream.height,stream.sample_aspect_ratio,stream.display_aspect_ratio],[width,height,'1:1',ratio]);
  }
});

test('invalid ranges and remote paths never alter source or a previous output',async t=>{
  assert.equal(typeof media.cutVideoClip,'function');
  const directory=await fixture(t),input=path.join(directory,'source.mp4'),output=path.join(directory,'published.mp4');
  await coloredVideo(input); const source=await readFile(input);
  await writeFile(output,'previous successful clip');
  for(const [start,end] of [[-1,1],[0,0],[1,0.5],[0,0.249],[NaN,1],[0,Infinity],['0',1],[0,'1'],[0,6.06],[6,6.04]]) {
    await assert.rejects(media.cutVideoClip({inputPath:input,outputPath:output,start,end}),error=>error.code==='CLIP_INVALID_RANGE',`invalid ${start}..${end}`);
    await assertUnchanged(directory,input,source,output);
  }
  for(const remote of ['https://example.com/video.mp4','file:///video.mp4','ftp://example.com/video.mp4','http:video.mp4']) {
    await assert.rejects(media.cutVideoClip({inputPath:remote,outputPath:output,start:0,end:1}),error=>error.code==='CLIP_INVALID_INPUT');
    await assert.rejects(media.cutVideoClip({inputPath:input,outputPath:remote,start:0,end:1}),error=>error.code==='INVALID_OUTPUT');
  }
  await assertUnchanged(directory,input,source,output);
  const boundary=path.join(directory,'boundary.mp4');
  const metadata=await media.cutVideoClip({inputPath:input,outputPath:boundary,start:5.75,end:6.04});
  assert.ok(metadata.duration>=0.24 && metadata.duration<=0.31,'up to 50ms of final-frame container rounding is accepted');
  await media.cutVideoClip({inputPath:input,outputPath:path.join(directory,'minimum.mp4'),start:0.5,end:0.75});
});

test('path, realpath and hardlink aliases cannot overwrite the input',async t=>{
  assert.equal(typeof media.cutVideoClip,'function');
  const directory=await fixture(t),input=path.join(directory,'source.mp4'),hardlink=path.join(directory,'hardlink.mp4'),junction=path.join(directory,'alias');
  await coloredVideo(input); const source=await readFile(input);
  await link(input,hardlink);
  await symlink(directory,junction,process.platform==='win32'?'junction':'dir');
  const aliases=[input,path.join(directory,'unused','..','source.mp4'),hardlink,path.join(junction,'source.mp4')];
  if(process.platform==='win32') aliases.push(input.toUpperCase());
  for(const outputPath of aliases) {
    await assert.rejects(media.cutVideoClip({inputPath:input,outputPath,start:0,end:1}),error=>error.code==='INVALID_OUTPUT');
    assert.deepEqual(await readFile(input),source);
  }
  assert.deepEqual(await readFile(hardlink),source);
  assert.deepEqual((await readdir(directory)).filter(name=>name.startsWith('.clips-')),[]);
});

test('failed and cancelled cuts settle before scratch cleanup and preserve source plus previous output',{timeout:20000},async t=>{
  assert.equal(typeof media.cutVideoClip,'function');
  const directory=await fixture(t),input=path.join(directory,'source.mp4'),output=path.join(directory,'published.mp4'),invalid=path.join(directory,'invalid.mp4');
  await ffmpeg(['-f','lavfi','-i','testsrc2=s=1280x720:r=30:d=8','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=8','-c:v','libx264','-preset','ultrafast','-c:a','aac','-y',input]);
  const source=await readFile(input);
  await writeFile(output,'previous successful clip'); await writeFile(invalid,'invalid media');
  await assert.rejects(media.cutVideoClip({inputPath:invalid,outputPath:output,start:0,end:1}),error=>error.code==='CLIP_MEDIA_FAILED');
  await assertUnchanged(directory,input,source,output);
  const cancelled=new AbortController(); cancelled.abort();
  await assert.rejects(media.cutVideoClip({inputPath:input,outputPath:output,start:0,end:1,signal:cancelled.signal}),error=>error.name==='AbortError');
  await assertUnchanged(directory,input,source,output);
  const controller=new AbortController(); let progressSeen=false;
  await assert.rejects(media.cutVideoClip({inputPath:input,outputPath:output,start:0.25,end:7.75,signal:controller.signal,onProgress:()=>{ progressSeen=true; controller.abort(); }}),error=>error.name==='AbortError');
  assert.ok(progressSeen,'cancellation must happen after FFmpeg starts reporting progress');
  await assertUnchanged(directory,input,source,output);
  assert.equal((await stat(output)).size,24);
});

test('cancellation from the final progress update cannot replace an already published clip',async t=>{
  assert.equal(typeof media.cutVideoClip,'function');
  const directory=await fixture(t),input=path.join(directory,'source.mp4'),output=path.join(directory,'published.mp4');
  await coloredVideo(input); const source=await readFile(input);
  await writeFile(output,'previous successful clip');
  const controller=new AbortController(); let completed=false;
  await assert.rejects(media.cutVideoClip({inputPath:input,outputPath:output,start:5.75,end:6.04,signal:controller.signal,onProgress:value=>{
    if(value===1) { completed=true; controller.abort(); }
  }}),error=>error.name==='AbortError');
  assert.ok(completed,'the callback must cancel at the final update');
  await assertUnchanged(directory,input,source,output);
});
