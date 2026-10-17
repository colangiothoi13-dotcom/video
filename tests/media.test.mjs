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

test('process wrapper uses argument arrays literally and aborts active subprocesses',{timeout:10000},async()=>{
  assert.equal(typeof processTools.runProcess,'function','process wrapper must exist');
  const arg='D:\\có dấu & khoảng trắng\\$(echo x);video.mp4';
  const result=await processTools.runProcess(process.execPath,['-e','process.stdout.write(process.argv[1])',arg]);
  assert.equal(result.stdout,arg);
  const controller=new AbortController();
  let pid,forcedCleanup=false;
  const timer=setTimeout(()=>{
    forcedCleanup=true;
    controller.abort();
    if(pid) { try { process.kill(pid,'SIGKILL'); } catch {} }
  },5000);
  try {
    const running=processTools.runProcess(process.execPath,['-e',"console.log(process.pid);setInterval(()=>{},1000)"],{signal:controller.signal,onProgress:line=>{pid=Number(line);controller.abort();}});
    await assert.rejects(running,error=>error.name==='AbortError');
    assert.equal(forcedCleanup,false,'abort must finish before test safety cleanup');
  } finally {
    clearTimeout(timer);
    controller.abort();
    if(pid) { try { process.kill(pid,'SIGKILL'); } catch(error) { if(error.code!=='ESRCH') throw error; } }
  }
});

test('abort waits for the owned child and its descendant to exit before rejecting', {timeout:10000}, async()=>{
  const controller=new AbortController();
  const owned=[];
  let forcedCleanup=false;
  const isAlive=pid=>{ try { process.kill(pid,0); return true; } catch(error) { if(error.code==='ESRCH') return false; throw error; } };
  const childCode=`const {spawn}=require('node:child_process'); const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); descendant.once('spawn',()=>console.log('owned:'+JSON.stringify([process.pid,descendant.pid]))); setInterval(()=>{},1000);`;
  const fallback=setTimeout(()=>{
    forcedCleanup=true;
    controller.abort();
    // Test safety net if tree termination is denied by a restricted host sandbox.
    for(const pid of owned) { try { process.kill(pid,'SIGKILL'); } catch {} }
  },5000);
  try {
    await assert.rejects(processTools.runProcess(process.execPath,['-e',childCode],{signal:controller.signal,onProgress:line=>{
      if(line.startsWith('owned:')) { owned.push(...JSON.parse(line.slice(6))); controller.abort(); }
    }}),error=>error.name==='AbortError');
    assert.equal(owned.length,2,'the test must start both owned processes');
    assert.equal(forcedCleanup,false,'cancellation must complete without the test safety cleanup');
    assert.deepEqual(owned.filter(isAlive),[],'no owned process may remain alive when cancellation rejects');
  } finally {
    clearTimeout(fallback);
    controller.abort();
    for(const pid of owned) { try { process.kill(pid,'SIGKILL'); } catch(error) { if(error.code!=='ESRCH') throw error; } }
  }
});

test('non-square pixels and rotation retain display ratio with square output pixels and no upscaling',async()=>{
  const ffmpeg=(await import('ffmpeg-static')).default;
  const ffprobe=(await import('ffprobe-static')).default.path;
  const dir=await mkdtemp(path.join(os.tmpdir(),'tỉ lệ hiển thị-'));
  try {
    const input=path.join(dir,'anamorphic.mp4');
    await processTools.runProcess(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=s=320x240:r=10:d=1','-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=1','-vf','setsar=4/3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-y',input]);
    const rotated=path.join(dir,'rotated.mp4');
    await processTools.runProcess(ffmpeg,['-hide_banner','-loglevel','error','-display_rotation:v:0','90','-i',input,'-c','copy','-y',rotated]);
    const rotatedSource=await media.probeVideo(rotated);
    assert.equal(rotatedSource.width,240,'rotation fixture must really carry quarter-turn display metadata');
    assert.equal(rotatedSource.height,320);
    for(const [source,name,wantWidth,wantHeight,wantDar] of [[input,'landscape',320,180,'16:9'],[rotated,'portrait',180,320,'9:16']]) {
      const output=path.join(dir,`${name}.mp4`);
      await media.renderVideo({inputPath:source,outputPath:output,cues:[],style:'classic',duration:1});
      const details=JSON.parse((await processTools.runProcess(ffprobe,['-v','error','-show_streams','-of','json',output])).stdout);
      const stream=details.streams.find(s=>s.codec_type==='video');
      assert.equal(stream.sample_aspect_ratio,'1:1');
      assert.equal(stream.display_aspect_ratio,wantDar);
      assert.equal(stream.width,wantWidth);
      assert.equal(stream.height,wantHeight);
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
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
