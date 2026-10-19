import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createStore} from '../lib/store.mjs';
import {createPipeline} from '../lib/pipeline.mjs';
import {defaultDubbingProfile} from '../lib/dubbing.mjs';
async function setup(t){
 const dir=await mkdtemp(path.join(tmpdir(),'vietsub-dub-pipe-')),store=createStore(path.join(dir,'jobs.sqlite'));t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 const created=store.createJob({title:'Dub'}),directory=path.join(dir,'jobs',created.id);await mkdir(directory,{recursive:true});const input=path.join(directory,'input.mp4'),video=path.join(directory,'video.mp4'),audio=path.join(directory,'speech.mp3');await writeFile(input,'source');await writeFile(video,'old-video');await writeFile(audio,'audio');
 store.updateJob(created.id,{duration:8,status:'completed',renderedVersion:1,artifacts:{inputPath:input,videoPath:video,audioPath:audio,posterPath:input}});
 const cues=[{id:'a',sourceId:'a',start:0,end:2,text:'Xin chào.',original:'Hello.'},{id:'b',sourceId:'b',start:4,end:7,text:'Bạn khỏe không?',original:'How are you?'}];store.saveCues(created.id,0,cues);
 const config={provider:'openai',apiKey:'sk-no-use',providerConfigs:{gemini:{apiKey:'google-private',transcriptionModel:'gemini-3.5-transcribe'}}};let calls=0,fail=false,analyzed=false;
 const dub={synthesizeSpeech:async(text,options)=>{assert.equal(options.apiKey,'google-private');calls++;if(fail&&text.includes('khỏe'))throw Object.assign(new Error('private-provider'),{code:'AI_RATE_LIMIT'});return {audio:Buffer.from('RIFF-fixture'),usage:{provider:'gemini',model:'gemini-3.8-flash-lite-tts',total_tokens:10}};},transcribe:async(_,options)=>{analyzed=options.diarization;return {segments:[{start:0,end:2,text:'Hello.',speaker:'a'},{start:4,end:7,text:'How are you?',speaker:'b'}],usage:{provider:'gemini'}};},prepareSpeechClip:async({outputPath})=>{await writeFile(outputPath,'clip');return {duration:2,speed:1};},buildVoiceTrack:async({outputPath})=>{await writeFile(outputPath,'track');return outputPath;},mixDubbedVideo:async({outputPath,onProgress})=>{onProgress?.(1);await writeFile(outputPath,'dubbed-video');return {};} };
 const pipeline=createPipeline({store,dataDir:dir,workerId:'dub-worker',config,dubbing:dub,tools:{probeVideo:async()=>({duration:8,width:640,height:360,hasAudio:true}),renderVideo:async()=>{throw new Error('must use current captioned video');}}});
 const profile=store.saveDubbing(created.id,defaultDubbingProfile(cues,1)).dubbing;
 const run=async(action='render',extra={})=>{store.queueDubbing(created.id,{action,version:store.getJob(created.id).dubbing.version,subtitleVersion:1,...extra});store.claimNextJob('dub-worker');await pipeline.runJob(created.id);return store.getJobInternal(created.id);};
 return {store,id:created.id,profile,run,dub,calls:()=>calls,setFail:v=>fail=v,analyzed:()=>analyzed};
}
test('queued multivoice export preserves original video, snapshots versions and reuses synthesis cache',async t=>{
 const f=await setup(t),job=await f.run();assert.equal(job.status,'completed');assert.equal(job.dubbingOutput.version,1);assert.equal(job.dubbingOutput.subtitleVersion,1);assert.equal(await readFile(job.artifacts.videoPath,'utf8'),'old-video');assert.equal(await readFile(job.artifacts.dubbedPath,'utf8'),'dubbed-video');assert.equal(f.calls(),2);assert.equal(job.usage.dubbing.length,2);
 await f.run();assert.equal(f.calls(),2);
});
test('failed TTS resumes cache on retry and never publishes partial dubbing',async t=>{
 const f=await setup(t);f.setFail(true);const failed=await f.run();assert.equal(failed.status,'failed');assert.equal(failed.error.code,'AI_RATE_LIMIT');assert.ok(!failed.artifacts.dubbedPath);assert.equal(f.calls(),2);
 f.setFail(false);const done=await f.run();assert.equal(done.status,'completed');assert.equal(f.calls(),3);
});
test('speaker analysis and preview keep source subtitles and use the Google key',async t=>{
 const f=await setup(t),before=f.store.getCues(f.id);const analyzed=await f.run('analyze');assert.equal(analyzed.status,'completed');assert.equal(f.analyzed(),true);assert.equal(analyzed.dubbing.speakers.length,2);assert.equal(analyzed.dubbing.version,2);assert.deepEqual(f.store.getCues(f.id),before);
 const preview=await f.run('preview',{speakerId:'spk_2'});assert.equal(preview.status,'completed');assert.equal(preview.dubbingPreview.speakerId,'spk_2');assert.ok(preview.artifacts.dubbingPreviewPath);assert.ok(!preview.artifacts.dubbedPath);
});

test('speaker analysis without speaker labels fails without replacing the saved cast or subtitles',async t=>{
 const f=await setup(t),before=f.store.getCues(f.id);
 f.dub.transcribe=async()=>({segments:[{start:0,end:2,text:'Hello.'},{start:4,end:7,text:'How are you?',speaker:' '}],usage:{provider:'gemini'}});
 const job=await f.run('analyze');assert.equal(job.status,'failed');assert.equal(job.error.code,'DUBBING_SPEAKERS_MISSING');assert.deepEqual(job.dubbing,f.profile);assert.deepEqual(f.store.getCues(f.id),before);assert.equal(f.calls(),0);
});
test('cancellation during progress aborts the subprocess without throwing from its event callback',async t=>{
 const f=await setup(t);let progressReturned=false;
 f.dub.mixDubbedVideo=async({signal,onProgress})=>{f.store.requestCancellation(f.id);onProgress(0.5);progressReturned=true;assert.equal(signal.aborted,true);signal.throwIfAborted();};
 const job=await f.run();assert.equal(progressReturned,true);assert.equal(job.status,'cancelled');assert.ok(!job.artifacts.dubbedPath);assert.equal(await readFile(job.artifacts.videoPath,'utf8'),'old-video');
});
test('expiry between turns stops further paid synthesis and prevents publication',async t=>{
 const f=await setup(t),prepare=f.dub.prepareSpeechClip;
 f.dub.prepareSpeechClip=async options=>{const result=await prepare(options);f.store.updateJob(f.id,{firstCompletedAt:new Date(Date.now()-25*60*60*1000).toISOString()});return result;};
 const job=await f.run();assert.equal(job.status,'expired');assert.equal(f.calls(),1);assert.ok(!job.artifacts.dubbedPath);
});
test('expiry raised by media progress settles the job instead of leaving the queue running',async t=>{
 const f=await setup(t);
 f.dub.mixDubbedVideo=async({signal,onProgress})=>{f.store.updateJob(f.id,{firstCompletedAt:new Date(Date.now()-25*60*60*1000).toISOString()});onProgress(0.5);assert.equal(signal.aborted,true);const error=new DOMException('Aborted','AbortError');error.cause=signal.reason;throw error;};
 const job=await f.run();assert.equal(job.status,'expired');assert.equal(f.store.listJobs('running').length,0);
});
