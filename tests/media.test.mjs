import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const media = await import('../lib/media.mjs');
const processTools = await import('../lib/process.mjs');

test('output dimensions respect landscape, portrait, ratio, even dimensions and no upscaling',()=>{
  assert.equal(typeof media.fitDimensions,'function','dimension calculator must exist');
  for(const [w,h,expected] of [[1920,1080,[1280,720]],[1080,1920,[720,1280]],[640,360,[640,360]],[403,301,[402,300]],[2000,1000,[1280,640]]]) {
    const result=media.fitDimensions(w,h);
    assert.deepEqual([result.width,result.height],expected);
  }
});

test('invalid media is rejected before AI: no audio, too long, too large, no video',()=>{
  assert.equal(typeof media.validateVideoMetadata,'function','media validation must exist');
  const good={duration:3,width:320,height:240,hasAudio:true};
  assert.throws(()=>media.validateVideoMetadata({...good,hasAudio:false}),/âm thanh/i);
  assert.throws(()=>media.validateVideoMetadata({...good,duration:600.001}),/600/);
  assert.throws(()=>media.validateVideoMetadata(good,500000001),/500/);
  assert.throws(()=>media.validateVideoMetadata({...good,width:0}),/video/i);
  assert.doesNotThrow(()=>media.validateVideoMetadata({...good,duration:600},500000000));
});

test('process wrapper uses argument arrays literally and aborts active subprocesses',async()=>{
  assert.equal(typeof processTools.runProcess,'function','process wrapper must exist');
  const arg='D:\\có dấu & khoảng trắng\\$(echo x);video.mp4';
  const result=await processTools.runProcess(process.execPath,['-e','process.stdout.write(process.argv[1])',arg]);
  assert.equal(result.stdout,arg);
  const controller=new AbortController();
  const running=processTools.runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:controller.signal});
  setTimeout(()=>controller.abort(),80);
  await assert.rejects(running,error=>error.name==='AbortError');
});

test('real ffmpeg renders Unicode captions at accented paths and extracts small mono audio',async()=>{
  assert.equal(typeof media.renderVideo,'function','real media renderer must exist');
  const ffmpeg=(await import('ffmpeg-static')).default;
  const dir=await mkdtemp(path.join(os.tmpdir(),'phụ đề có dấu & khoảng trắng-'));
  try {
    const input=path.join(dir,'đầu vào.mp4');
    const output=path.join(dir,'kết quả.mp4');
    const audio=path.join(dir,'âm thanh.mp3');
    await processTools.runProcess(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=320x180:r=15:d=2','-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-y',input]);
    const progress=[];
    const result=await media.renderVideo({inputPath:input,outputPath:output,duration:2,style:'box',cues:[{id:'x',sourceId:'x',start:0,end:1.8,original:'hello',text:'Xin chào Việt Nam 🌿',readingWarning:false}],onProgress:p=>progress.push(p)});
    assert.equal(result.width,320);
    assert.equal(result.height,180);
    const probe=await media.probeVideo(output);
    assert.ok(probe.hasAudio && probe.duration >= 1.9 && probe.duration < 2.3);
    assert.ok(progress.some(p=>p>0 && p<=1));
    const burnedFrame=await processTools.runProcess(ffmpeg,['-hide_banner','-loglevel','error','-ss','0.5','-i',output,'-vf','crop=iw:ih/2:0:ih/2,signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-','-frames:v','1','-an','-f','null','-']);
    assert.ok(Number(burnedFrame.stdout.match(/YMAX=(\d+)/)?.[1])>200,'white subtitle pixels must actually be burned into the blue image');
    await media.extractAudio(input,audio,{});
    const audioStat=await stat(audio);
    assert.ok(audioStat.size>100 && audioStat.size<25000000);
    const ffprobe=(await import('ffprobe-static')).default.path;
    const details=JSON.parse((await processTools.runProcess(ffprobe,['-v','error','-show_streams','-of','json',audio])).stdout);
    assert.equal(details.streams[0].channels,1);
    assert.equal(details.streams[0].sample_rate,'16000');
    assert.equal(details.streams[0].codec_name,'mp3');
    const silent=path.join(dir,'không tiếng.mp4');
    await processTools.runProcess(ffmpeg,['-hide_banner','-loglevel','error','-i',input,'-an','-c:v','copy','-y',silent]);
    await assert.rejects(media.probeVideo(silent),/âm thanh/i);
    const long=path.join(dir,'quá dài.mp4');
    await processTools.runProcess(ffmpeg,['-hide_banner','-loglevel','error','-stream_loop','-1','-i',input,'-t','601','-c','copy','-y',long]);
    await assert.rejects(media.probeVideo(long),/600/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
