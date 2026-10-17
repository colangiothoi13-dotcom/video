import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat,utimes} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import http from 'node:http';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createStore,RETENTION_MS} from '../lib/store.mjs';
import * as realAi from '../lib/ai.mjs';
import {createPipeline} from '../lib/pipeline.mjs';
import {createWorker} from '../worker.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,timeout=3000) {const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw new Error('condition timed out');await sleep(10);}}
async function setup(t,{failBatch=false,noSpeech=false,tools:overrides={}}={}) {
  const dir=await mkdtemp(path.join(tmpdir(),'vietsub-pipeline-'));let now=Date.now();const store=createStore(path.join(dir,'jobs.sqlite'),{now:()=>now});
  const calls={transcribe:0,translation:[],render:0,aiProgress:[]};const extraStores=[];
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;res.setHeader('content-type','application/json');
    calls.aiProgress.push(store.listJobs('running').map(job=>({stage:job.stage,progress:job.progress})));
    if(req.url.endsWith('/transcriptions')){calls.transcribe++;res.end(JSON.stringify({duration:3,text:noSpeech?'':'one two three',segments:noSpeech?[]:[0,1,2].map(i=>({id:i,start:i,end:i+1,text:['one','two','three'][i]}))}));return;}
    const input=JSON.parse(JSON.parse(body).input[1].content);calls.translation.push(input.segments.map(s=>s.id));
    if(failBatch&&input.segments[0].id==='1'){res.statusCode=401;res.end(JSON.stringify({error:{code:'invalid_api_key'}}));return;}
    res.end(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({segments:input.segments.map(s=>({id:s.id,text:`Dịch ${s.text}`}))})}]}],usage:{input_tokens:4,output_tokens:3,total_tokens:7}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const tools={runProcess:async(_,args,{signal})=>{signal?.throwIfAborted();await writeFile(args.at(-1),'JPEG fixture');},probeVideo:async()=>({duration:3,width:640,height:360,hasAudio:true}),extractAudio:async(_,output)=>{await writeFile(output,'mp3');return {path:output};},renderVideo:async({outputPath,signal})=>{signal?.throwIfAborted();calls.render++;await writeFile(outputPath,`mp4-${calls.render}`);return {duration:3,width:640,height:360,hasAudio:true};},...overrides};
  const config={apiKey:'fixture-secret',translationModel:'gpt-5.6-terra',translationBatchSize:1};
  const aiOptions={apiBase:`http://127.0.0.1:${server.address().port}/v1`,retryDelayMs:1};
  const ai={transcribe:(file,options)=>realAi.transcribe(file,{...options,...aiOptions}),translateSegments:(segments,options)=>realAi.translateSegments(segments,{...options,...aiOptions})};
  const pipeline=createPipeline({store,tools,ai,config,dataDir:dir,workerId:'worker-a'});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));for(const extra of extraStores)extra.close();store.close();await rm(dir,{recursive:true,force:true});});
  async function job(){const created=store.createJob({title:'Video tiếng Việt'});const jobDir=path.join(dir,'jobs',created.id);await mkdir(jobDir,{recursive:true});const inputPath=path.join(jobDir,'nguồn $(echo).mp4');await writeFile(inputPath,'source');store.updateJob(created.id,{artifacts:{inputPath}});return created;}
  return {dir,store,calls,pipeline,tools,ai,config,job,extraStores,setNow:value=>now=value,setFailBatch:value=>failBatch=value};
}
test('real SQLite checkpoints resume only untranslated batches after restart, without repeating ASR',async t=>{
  const f=await setup(t,{failBatch:true});const job=await f.job();f.store.claimNextJob('worker-a');await f.pipeline.runJob(job.id);
  assert.equal(f.store.getJob(job.id).status,'failed');assert.equal(f.store.getJobInternal(job.id).checkpoint.translations.length,1);
  f.store.updateJob(job.id,{status:'queued',error:null});f.setFailBatch(false);
  f.store.claimNextJob('worker-a');const restarted=createPipeline({store:f.store,tools:f.tools,ai:f.ai,config:f.config,dataDir:f.dir,workerId:'worker-a'});await restarted.runJob(job.id);
  const result=f.store.getJob(job.id);assert.equal(result.status,'completed');assert.equal(result.subtitleVersion,1);assert.equal(result.renderedVersion,1);assert.equal(f.calls.transcribe,1);
  assert.deepEqual(f.calls.translation,[['0'],['1'],['1'],['2']]);assert.equal(result.usage.translation.length,3);assert.equal(result.usage.audioSeconds,3);
  assert.equal(result.usage.translation[0].model,'gpt-5.6-terra');assert.equal(result.usage.translation[0].language,'vi');assert.equal(result.usage.transcription[0].model,'whisper-1');
  assert.equal(await readFile(f.store.getJobInternal(job.id).artifacts.videoPath,'utf8'),'mp4-1');assert.match(await readFile(f.store.getJobInternal(job.id).artifacts.srtPath,'utf8'),/Dịch three/);
});
test('two real store connections cannot duplicate provider work or reset a live job',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);let entered=false;
  const f=await setup(t,{tools:{extractAudio:async(_,output)=>{entered=true;await gate;await writeFile(output,'mp3');}}});const other=createStore(path.join(f.dir,'jobs.sqlite'));f.extraStores.push(other);const job=await f.job();
  const workerA=createWorker({store:f.store,pipeline:f.pipeline,workerId:'worker-a',pollMs:10,heartbeatMs:30,cancelPollMs:10});
  const pipelineB=createPipeline({store:other,tools:f.tools,ai:f.ai,config:f.config,dataDir:f.dir,workerId:'worker-b'});const workerB=createWorker({store:other,pipeline:pipelineB,workerId:'worker-b',pollMs:10,heartbeatMs:30,cancelPollMs:10});
  workerA.start();await until(()=>entered);workerB.start();await sleep(80);assert.equal(other.getJob(job.id).status,'running');assert.equal(other.recoverInterruptedJobs('worker-b'),0);
  release();await until(()=>f.store.getJob(job.id).status==='completed');await workerB.stop();await workerA.stop();assert.equal(f.calls.transcribe,1);assert.equal(f.calls.render,1);
});
test('cancellation aborts and waits for external step completion before terminal state',async t=>{
  let entered=false,closed=false;const f=await setup(t,{tools:{extractAudio:async(_,output,{signal})=>{entered=true;await new Promise(resolve=>signal.addEventListener('abort',()=>setTimeout(()=>{closed=true;resolve();},40),{once:true}));signal.throwIfAborted();}}});const job=await f.job();
  const worker=createWorker({store:f.store,pipeline:f.pipeline,workerId:'worker-a',pollMs:10,cancelPollMs:10});worker.start();await until(()=>entered);f.store.updateJob(job.id,{cancelRequested:true});await sleep(20);assert.equal(f.store.getJob(job.id).status,'running');
  await until(()=>f.store.getJob(job.id).status==='cancelled');assert.equal(closed,true);assert.equal(f.calls.transcribe,0);await worker.stop();
});
test('failed re-render preserves prior MP4 and captured subtitle version despite concurrent edits',async t=>{
  const f=await setup(t);const job=await f.job();f.store.claimNextJob('worker-a');await f.pipeline.runJob(job.id);const before=f.store.getJobInternal(job.id);const firstPath=before.artifacts.videoPath;
  const cues=f.store.getCues(job.id);f.store.saveCues(job.id,1,cues.map(c=>({...c,text:'Sửa'})));f.store.updateJob(job.id,{status:'queued',renderRequested:true});f.store.claimNextJob('worker-a');
  const failing=createPipeline({store:f.store,tools:{...f.tools,renderVideo:async({outputPath})=>{await writeFile(outputPath,'broken');throw new Error('C:\\private path fixture-secret');}},ai:f.ai,config:f.config,dataDir:f.dir,workerId:'worker-a'});await failing.runJob(job.id);
  const failed=f.store.getJobInternal(job.id);assert.equal(failed.artifacts.videoPath,firstPath);assert.equal(await readFile(firstPath,'utf8'),'mp4-1');assert.equal(failed.renderedVersion,1);assert.doesNotMatch(failed.error.message,/private|fixture-secret/);
  f.store.updateJob(job.id,{status:'queued',renderRequested:true});f.store.claimNextJob('worker-a');
  const concurrent=createPipeline({store:f.store,tools:{...f.tools,renderVideo:async({outputPath,cues})=>{assert.equal(cues[0].text,'Sửa');f.store.saveCues(job.id,2,f.store.getCues(job.id).map(c=>({...c,text:'Mới hơn'})));await writeFile(outputPath,'mp4-2');}},ai:f.ai,config:f.config,dataDir:f.dir,workerId:'worker-a'});await concurrent.runJob(job.id);
  assert.equal(f.store.getJob(job.id).renderedVersion,2);assert.equal(f.store.getJob(job.id).subtitleVersion,3);assert.equal(f.store.getJob(job.id).expiresAt,before.expiresAt);
});
test('cleanup protects running/queued input, expires terminal jobs, and removes only stale upload orphans',async t=>{
  const f=await setup(t);const job=await f.job();f.store.claimNextJob('worker-a');await f.pipeline.runJob(job.id);
  const active=await f.job();const orphan=path.join(f.dir,'jobs','orphan-upload');await mkdir(orphan,{recursive:true});await writeFile(path.join(orphan,'upload.part'),'partial');const old=new Date(Date.now()-3700000);await utimes(orphan,old,old);
  const fresh=path.join(f.dir,'jobs','fresh-upload');await mkdir(fresh);await writeFile(path.join(fresh,'upload.part'),'partial');
  const now=Date.now()+RETENTION_MS+1000;f.setNow(now);f.store.releaseWorker('worker-a');f.store.recoverInterruptedJobs('worker-a');await f.pipeline.cleanupExpired(now);
  assert.equal(f.store.getJob(job.id).status,'expired');await assert.rejects(stat(path.join(f.dir,'jobs',job.id)),{code:'ENOENT'});assert.equal((await stat(f.store.getJobInternal(active.id).artifacts.inputPath)).isFile(),true);
  await assert.rejects(stat(orphan),{code:'ENOENT'});
  // A newly active upload is evaluated against the supplied cleanup time.
  // Shift back to demonstrate that a fresh directory is retained.
  await mkdir(fresh,{recursive:true});await f.pipeline.cleanupExpired(Date.now());assert.equal((await stat(fresh)).isDirectory(),true);
});
test('expired lease fences initial cues and job writes after a completed provider call',async t=>{
  const f=await setup(t);const job=await f.job();f.store.claimNextJob('worker-a');const other=createStore(path.join(f.dir,'jobs.sqlite'),{now:()=>Date.now()+40000});f.extraStores.push(other);
  const displaced=createPipeline({store:f.store,tools:f.tools,ai:{...f.ai,translateSegments:async(...args)=>{const result=await f.ai.translateSegments(...args);f.setNow(Date.now()+40000);other.recoverInterruptedJobs('worker-b');return result;}},config:f.config,dataDir:f.dir,workerId:'worker-a'});await displaced.runJob(job.id);
  assert.equal(f.store.getCues(job.id).length,0);assert.equal(f.store.getJob(job.id).status,'queued');assert.equal(f.calls.render,0);
});
test('saved cues can re-render without an AI checkpoint or configured credentials',async t=>{
  const f=await setup(t);const job=await f.job();f.store.claimNextJob('worker-a');await f.pipeline.runJob(job.id);
  f.store.updateJob(job.id,{checkpoint:null,status:'queued',renderRequested:true});f.store.claimNextJob('worker-a');
  const renderer=createPipeline({store:f.store,tools:f.tools,config:{apiKey:''},dataDir:f.dir,workerId:'worker-a'});await renderer.runJob(job.id);
  assert.equal(f.store.getJob(job.id).status,'completed');assert.equal(f.calls.transcribe,1);assert.equal(f.calls.render,2);
});
test('progress after cancellation aborts media and never throws into an asynchronous process callback',async t=>{
  const f=await setup(t);const job=await f.job();f.store.claimNextJob('worker-a');let escaped,aborted=false;
  const pipeline=createPipeline({store:f.store,tools:{...f.tools,renderVideo:async({signal,onProgress})=>{
    f.store.updateJob(job.id,{cancelRequested:true});
    await new Promise(resolve=>setTimeout(()=>{try{onProgress(0.5);}catch(error){escaped=error;}resolve();},5));
    aborted=signal.aborted;signal.throwIfAborted();
  }},ai:f.ai,config:f.config,dataDir:f.dir,workerId:'worker-a'});
  await pipeline.runJob(job.id);assert.equal(escaped,undefined);assert.equal(aborted,true);assert.equal(f.store.getJob(job.id).status,'cancelled');
});
test('shutdown awaits the media step before releasing the singleton, preserving checkpoint for next worker',async t=>{
  let entered=false,settled=false;const f=await setup(t,{tools:{extractAudio:async(_,output,{signal})=>{entered=true;await new Promise(resolve=>signal.addEventListener('abort',()=>setTimeout(()=>{settled=true;resolve();},40),{once:true}));signal.throwIfAborted();}}});const job=await f.job();
  const worker=createWorker({store:f.store,pipeline:f.pipeline,workerId:'worker-a',pollMs:10});worker.start();await until(()=>entered);
  const stopping=worker.stop();await sleep(10);assert.equal(f.store.getWorkerStatus().active,true);assert.equal(settled,false);await stopping;
  assert.equal(settled,true);assert.equal(f.store.getWorkerStatus().active,false);assert.equal(f.store.getJob(job.id).status,'running');
  assert.equal(f.store.getJob(job.id).usage.steps.at(-1).status,'interrupted');
  assert.equal(f.store.claimNextJob('worker-next').id,job.id);assert.equal(f.calls.transcribe,0);
});
test('missing audio is rejected before AI and silent speech is a distinct failure',async t=>{
  const f=await setup(t,{tools:{probeVideo:async()=>({duration:3,width:640,height:360,hasAudio:false})}});const job=await f.job();f.store.claimNextJob('worker-a');await f.pipeline.runJob(job.id);
  assert.equal(f.store.getJob(job.id).error.code,'NO_AUDIO');assert.equal(f.calls.transcribe,0);
  const silent=await setup(t,{noSpeech:true});const silentJob=await silent.job();silent.store.claimNextJob('worker-a');await silent.pipeline.runJob(silentJob.id);
  assert.equal(silent.store.getJob(silentJob.id).error.code,'NO_SPEECH');assert.equal(silent.calls.translation.length,0);assert.equal(silent.calls.render,0);
});
test('completed upload moves into job directory and recovery finds a move interrupted before its checkpoint',async t=>{
  const f=await setup(t);const uploadDir=path.join(f.dir,'uploads','pending-upload');await mkdir(uploadDir,{recursive:true});const uploaded=path.join(uploadDir,'input.mov');await writeFile(uploaded,'original bytes');
  const job=f.store.createJob({artifacts:{inputPath:uploaded},upload:{path:uploaded,originalName:'Tên gốc.mov'}});f.store.claimNextJob('worker-a');await f.pipeline.runJob(job.id);
  const actual=f.store.getJobInternal(job.id).artifacts.inputPath;assert.equal(path.dirname(actual),path.join(f.dir,'jobs',job.id));assert.equal(await readFile(actual,'utf8'),'original bytes');await assert.rejects(stat(uploaded),{code:'ENOENT'});
  const pendingDir=path.join(f.dir,'uploads','interrupted-upload');await mkdir(pendingDir);const pending=path.join(pendingDir,'input');const interrupted=f.store.createJob({artifacts:{inputPath:pending},upload:{path:pending}});
  const finalDir=path.join(f.dir,'jobs',interrupted.id);await mkdir(finalDir,{recursive:true});await writeFile(path.join(finalDir,'input.bin'),'moved before crash');f.store.claimNextJob('worker-a');await f.pipeline.runJob(interrupted.id);
  assert.equal(f.store.getJob(interrupted.id).status,'completed');assert.equal(await readFile(f.store.getJobInternal(interrupted.id).artifacts.inputPath,'utf8'),'moved before crash');
});
test('upload cleanup removes inactive unreferenced directories and preserves queued inputs',async t=>{
  const f=await setup(t);const root=path.join(f.dir,'uploads');await mkdir(root,{recursive:true});
  for(const name of ['orphan','queued','fresh']){await mkdir(path.join(root,name));await writeFile(path.join(root,name,'input'),'bytes');}
  const old=new Date(Date.now()-3700000);for(const name of ['orphan','queued']){await utimes(path.join(root,name,'input'),old,old);await utimes(path.join(root,name),old,old);}
  const job=f.store.createJob({artifacts:{inputPath:path.join(root,'queued','input')}});f.store.recoverInterruptedJobs('worker-a');await f.pipeline.cleanupExpired();
  await assert.rejects(stat(path.join(root,'orphan')),{code:'ENOENT'});assert.equal((await stat(f.store.getJobInternal(job.id).artifacts.inputPath)).isFile(),true);assert.equal((await stat(path.join(root,'fresh'))).isDirectory(),true);
});
test('periodic cleanup continues while a long media step runs and protects that step',async t=>{
  let entered=false,release;const gate=new Promise(resolve=>release=resolve);
  const f=await setup(t,{tools:{extractAudio:async(_,output)=>{entered=true;await gate;await writeFile(output,'mp3');}}});const job=await f.job();
  const worker=createWorker({store:f.store,pipeline:f.pipeline,workerId:'worker-a',pollMs:10,cleanupMs:30});worker.start();await until(()=>entered);
  const expired=await f.job();f.store.updateJob(expired.id,{status:'failed'});f.store.updateJob(expired.id,{expiresAt:new Date(Date.now()-1000).toISOString()});
  await sleep(90);const state=f.store.getJob(expired.id).status;release();await until(()=>f.store.getJob(job.id).status==='completed');await worker.stop();
  assert.equal(state,'expired');assert.equal(await readFile(f.store.getJobInternal(job.id).artifacts.inputPath,'utf8'),'source');
});
test('import and AI stages are indeterminate; rendering reports measured current-step percentage',async t=>{
  const f=await setup(t);const job=f.store.createJob({sourceUrl:'https://www.youtube.com/watch?v=dQw4w9WgXcQ'});let imported=false,probed=false,rendered=false;
  const pipeline=createPipeline({store:f.store,tools:{...f.tools,
    importVideo:async(_,directory)=>{imported=true;assert.equal(f.store.getJob(job.id).progress,null);const inputPath=path.join(directory,'source.mp4');await writeFile(inputPath,'source');return {inputPath};},
    probeVideo:async()=>{probed=true;const current=f.store.getJob(job.id);if(current.stage==='probe')assert.equal(current.progress,null);return {duration:3,width:640,height:360,hasAudio:true};},
    renderVideo:async({outputPath,onProgress})=>{rendered=true;assert.equal(f.store.getJob(job.id).progress,null);onProgress(0.36);assert.equal(f.store.getJob(job.id).progress,36);onProgress(1);assert.equal(f.store.getJob(job.id).progress,100);await writeFile(outputPath,'mp4');},
  },ai:f.ai,config:f.config,dataDir:f.dir,workerId:'worker-a'});
  f.store.claimNextJob('worker-a');await pipeline.runJob(job.id);
  assert.equal(imported&&probed&&rendered,true);assert.equal(f.store.getJob(job.id).status,'completed');
  assert.ok(f.calls.aiProgress.length>=2);for(const observations of f.calls.aiProgress)for(const observed of observations)assert.equal(observed.progress,null);
});
for(const mode of ['shutdown','disconnect'])test(`worker CLI ${mode} releases its SQLite lease and closes its IPC channel`,async t=>{
  const f=await setup(t);const child=fork(fileURLToPath(new URL('../worker.mjs',import.meta.url)),[],{env:{...process.env,DATA_DIR:f.dir},stdio:['ignore','pipe','pipe','ipc']});
  const exit=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  t.after(async()=>{if(child.exitCode===null){child.kill();await exit;}});
  await until(()=>f.store.getWorkerStatus().active);
  if(mode==='shutdown')child.send({type:'shutdown'});else child.disconnect();
  const outcome=await Promise.race([exit.then(code=>({code})),sleep(500).then(()=>({timeout:true}))]);
  if(outcome.timeout){child.kill();await exit;}
  assert.equal(outcome.timeout,undefined);assert.equal(outcome.code,0);assert.equal(f.store.getWorkerStatus().active,false);
});
test('render captures cues and version through one atomic SQLite snapshot',async t=>{
  const f=await setup(t);const job=await f.job();f.store.claimNextJob('worker-a');await f.pipeline.runJob(job.id);
  f.store.updateJob(job.id,{status:'queued',renderRequested:true});f.store.claimNextJob('worker-a');let captured;
  const editor=createStore(path.join(f.dir,'jobs.sqlite'));f.extraStores.push(editor);
  // Reproduce a second connection committing an edit between separate job/cue reads.
  const racingStore=new Proxy(f.store,{get(target,key){if(key==='getCues')return id=>{
    const current=editor.getJob(id);editor.saveCues(id,current.subtitleVersion,editor.getCues(id).map(cue=>({...cue,text:'Chỉnh sửa đồng thời'})));return target.getCues(id);
  };return target[key];}});
  const pipeline=createPipeline({store:racingStore,tools:{...f.tools,renderVideo:async({outputPath,cues})=>{captured=cues[0].text;await writeFile(outputPath,'mp4');}},ai:f.ai,config:f.config,dataDir:f.dir,workerId:'worker-a'});await pipeline.runJob(job.id);
  assert.equal(captured,'Dịch one');assert.equal(f.store.getJob(job.id).renderedVersion,1);assert.equal(f.store.getJob(job.id).status,'completed');
});
test('valid source gets a poster; optional thumbnail errors do not block translation',async t=>{
  const f=await setup(t);const job=await f.job();f.store.claimNextJob('worker-a');await f.pipeline.runJob(job.id);
  const poster=f.store.getJobInternal(job.id).artifacts.posterPath;assert.ok(poster);assert.equal(await readFile(poster,'utf8'),'JPEG fixture');
  const broken=await setup(t,{tools:{runProcess:async()=>{throw new Error('private-fixture-key C:\\path');}}});const other=await broken.job();broken.store.claimNextJob('worker-a');await broken.pipeline.runJob(other.id);
  assert.equal(broken.store.getJob(other.id).status,'completed');assert.equal(broken.store.getJob(other.id).error,null);assert.equal(broken.store.getJobInternal(other.id).artifacts.posterPath,undefined);
});
