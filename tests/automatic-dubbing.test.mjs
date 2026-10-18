import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createStore} from '../lib/store.mjs';
import {createPipeline} from '../lib/pipeline.mjs';
import {defaultDubbingProfile} from '../lib/dubbing.mjs';

const labeled=[{id:'s1',sourceId:'s1',start:0,end:2,text:'Hello.',speaker:'first'},{id:'s2',sourceId:'s2',start:3,end:5,text:'World.',speaker:'second'}];
async function fixture(t,{existing=false,labels=true,manual=false,provider='gemini'}={}) {
 const dir=await mkdtemp(path.join(tmpdir(),'vietsub-auto-cast-')),store=createStore(path.join(dir,'jobs.sqlite'));t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 const segments=structuredClone(labeled).map(s=>{if(!labels)delete s.speaker;return s;});
 const job=store.createJob({title:'Auto cast',...(existing?{checkpoint:{transcription:segments,translations:[]}}:{})}),root=path.join(dir,'jobs',job.id);await mkdir(root,{recursive:true});
 const inputPath=path.join(root,'input.mp4'),audioPath=path.join(root,'speech.mp3');await writeFile(inputPath,'video');await writeFile(audioPath,'audio');store.updateJob(job.id,{duration:6,artifacts:{inputPath,audioPath,posterPath:inputPath}});
 if(existing)store.saveCues(job.id,0,segments.map(s=>({...s,original:s.text,text:`Dịch ${s.text}`})));
 let originalProfile;
 if(manual){store.updateJob(job.id,{status:'completed'});const profile=defaultDubbingProfile(store.getCues(job.id),1);profile.speakers[0].name='Vai do tôi đặt';originalProfile=store.saveDubbing(job.id,profile).dubbing;store.updateJob(job.id,{status:'queued'});}
 const calls={asr:0,translation:0};let asrOptions;
 const pipeline=createPipeline({store,dataDir:dir,workerId:'automatic-cast-worker',config:{provider,apiKey:'fixture-key'},tools:{probeVideo:async()=>({duration:6,width:640,height:360,hasAudio:true}),renderVideo:async({outputPath})=>writeFile(outputPath,'rendered')},ai:{transcribe:async(_,options)=>{calls.asr++;asrOptions=options;return {segments,usage:{provider,model:'fixture'}};},translateSegments:async(batch)=>{calls.translation++;return {segments:batch.map(s=>({...s,text:s.id==='s1'?'Một câu dịch dài để kiểm tra việc chia phụ đề vẫn giữ đúng vai cho từng phần được chia.':'Xin chào.'})),usage:{provider}};}}});
 store.claimNextJob('automatic-cast-worker');await pipeline.runJob(job.id);
 return {job:store.getJob(job.id),cues:store.getCues(job.id),calls,asrOptions,originalProfile};
}
test('new Gemini jobs detect speakers during their single ASR call and map split translated cues automatically',async t=>{
 const f=await fixture(t);assert.equal(f.job.status,'completed');assert.equal(f.asrOptions.diarization,true);assert.equal(f.calls.asr,1);assert.equal(f.calls.translation,1);
 assert.equal(f.job.dubbing.version,1);assert.equal(f.job.dubbing.subtitleVersion,f.job.subtitleVersion);assert.equal(f.job.dubbing.speakers.length,2);assert.equal(f.job.dubbing.assignments.length,f.cues.length);
 assert.ok(f.cues.filter(c=>c.sourceId==='s1').length>1,'fixture must exercise normalized cue splits');
 const byId=new Map(f.job.dubbing.assignments.map(a=>[a.cueId,a.speakerId]));for(const c of f.cues)assert.equal(byId.get(c.id),c.sourceId==='s1'?'spk_1':'spk_2');assert.ok(!f.job.usage.dubbing?.length);
});
test('a restart after cue publication recovers automatic roles from the saved transcript without paid ASR or translation',async t=>{
 const f=await fixture(t,{existing:true});assert.equal(f.job.status,'completed');assert.equal(f.calls.asr,0);assert.equal(f.calls.translation,0);assert.equal(f.job.dubbing.version,1);assert.equal(f.job.dubbing.speakers.length,2);
});
test('ordinary rendering never overwrites an existing edited cast',async t=>{
 const f=await fixture(t,{existing:true,manual:true});assert.equal(f.job.status,'completed');assert.deepEqual(f.job.dubbing,f.originalProfile);assert.equal(f.calls.asr,0);assert.equal(f.calls.translation,0);
});
test('legacy checkpoints without speakers do not trigger extra recognition or invent a detected cast',async t=>{
 const f=await fixture(t,{existing:true,labels:false});assert.equal(f.job.status,'completed');assert.equal(f.job.dubbing,undefined);assert.equal(f.calls.asr,0);assert.equal(f.calls.translation,0);
});
test('OpenAI transcription remains unchanged when speaker labels are unavailable',async t=>{
 const f=await fixture(t,{labels:false,provider:'openai'});assert.equal(f.job.status,'completed');assert.notEqual(f.asrOptions.diarization,true);assert.equal(f.job.dubbing,undefined);assert.equal(f.calls.asr,1);
});
