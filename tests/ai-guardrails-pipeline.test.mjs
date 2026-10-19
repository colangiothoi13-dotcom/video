import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createStore} from '../lib/store.mjs';
import {createPipeline} from '../lib/pipeline.mjs';

async function fixture(t,ai,{checkpoint,usage}={}) {
  const directory=await mkdtemp(path.join(tmpdir(),'vietsub-ai-guardrails-'));
  const store=createStore(path.join(directory,'jobs.sqlite'));
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const job=store.createJob({title:'Diagnostic fixture'});
  const jobDirectory=path.join(directory,'jobs',job.id);await mkdir(jobDirectory,{recursive:true});
  const inputPath=path.join(jobDirectory,'input.mp4'),audioPath=path.join(jobDirectory,'speech.mp3'),posterPath=path.join(jobDirectory,'poster.jpg');
  await Promise.all([writeFile(inputPath,'video'),writeFile(audioPath,'audio'),writeFile(posterPath,'poster')]);
  store.updateJob(job.id,{artifacts:{inputPath,audioPath,posterPath},...(checkpoint?{checkpoint}:{}),...(usage?{usage}:{})});
  const pipeline=createPipeline({store,dataDir:directory,workerId:'guardrail-worker',config:{provider:'gemini',apiKey:'fixture-secret',translationBatchSize:1},ai,tools:{probeVideo:async()=>({duration:3,width:640,height:360,hasAudio:true}),renderVideo:async()=>{throw new Error('render must not begin');}}});
  store.claimNextJob('guardrail-worker');
  await pipeline.runJob(job.id);
  return {store,job:store.getJob(job.id),internal:store.getJobInternal(job.id)};
}
function providerFailure(reason,facts={}) {
  return Object.assign(new Error('private provider payload C:\\private fixture-secret'),{code:'AI_INVALID_RESPONSE',attempts:3,elapsedMs:321,validation:{reason,...facts,raw:'private provider transcript'},validationFailures:[{reason:'TRANSCRIPT_MISMATCH',expected:3,actual:1,raw:'private transcript'},{reason,...facts,raw:'private response'},{reason:'INVALID_TIMING'}],providerUsage:{input_tokens:12,output_tokens:4,total_tokens:16,seconds:2.5,input_tokens_details:{audio_tokens:12,raw:'private audio'},raw:'private response'}});
}

test('failed ASR publishes its safe reason and persists all provider attempts and measured usage',async t=>{
  const f=await fixture(t,{transcribe:async()=>{throw providerFailure('MISSING_WORD_TIMING',{count:3});},translateSegments:async()=>{throw new Error('translation must not begin');}});
  assert.equal(f.job.status,'failed');
  assert.equal(f.job.error.code,'AI_INVALID_RESPONSE');
  assert.match(f.job.error.message,/mốc thời gian/i);
  assert.deepEqual(f.job.error.validation,{reason:'MISSING_WORD_TIMING',count:3});
  const failed=f.job.usage.steps.find(step=>step.stage==='transcribe'&&step.status==='failed');
  assert.equal(failed.providerAttempts,3);
  assert.deepEqual(failed.validation,{reason:'MISSING_WORD_TIMING',count:3});
  assert.deepEqual(failed.validationFailures,[{reason:'TRANSCRIPT_MISMATCH',expected:3,actual:1},{reason:'MISSING_WORD_TIMING',count:3}]);
  assert.deepEqual(failed.providerUsage,{input_tokens:12,output_tokens:4,total_tokens:16,seconds:2.5,input_tokens_details:{audio_tokens:12}});
  assert.deepEqual(f.internal.checkpoint,{translations:[]});
  assert.deepEqual(f.job.usage.transcription,[]);
  assert.doesNotMatch(JSON.stringify(f.job),/private|fixture-secret|provider payload/);
});

test('failed translation retains its reason and accounting without changing previous checkpoints',async t=>{
  const checkpoint={transcription:[{id:'s1',start:0,end:1,text:'One'},{id:'s2',start:1,end:2,text:'Two'}],translations:[{id:'s1',text:'Một'}]};
  const previousUsage={provider:'gemini',model:'fixture-model',input_tokens:7};
  const f=await fixture(t,{transcribe:async()=>{throw new Error('checkpoint ASR must not repeat');},translateSegments:async()=>{throw providerFailure('SEGMENT_COUNT_MISMATCH',{expected:1,actual:0});}},{checkpoint,usage:{translation:[previousUsage]}});
  assert.equal(f.job.status,'failed');assert.equal(f.job.error.code,'AI_INVALID_RESPONSE');
  assert.match(f.job.error.message,/số đoạn/i);
  assert.deepEqual(f.job.error.validation,{reason:'SEGMENT_COUNT_MISMATCH',expected:1,actual:0});
  const failed=f.job.usage.steps.find(step=>step.stage==='translate'&&step.status==='failed');
  assert.equal(failed.providerAttempts,3);
  assert.deepEqual(failed.validation,{reason:'SEGMENT_COUNT_MISMATCH',expected:1,actual:0});
  assert.deepEqual(failed.validationFailures,[{reason:'TRANSCRIPT_MISMATCH',expected:3,actual:1},{reason:'SEGMENT_COUNT_MISMATCH',expected:1,actual:0}]);
  assert.deepEqual(failed.providerUsage,{input_tokens:12,output_tokens:4,total_tokens:16,seconds:2.5,input_tokens_details:{audio_tokens:12}});
  assert.deepEqual(f.internal.checkpoint,checkpoint);
  assert.deepEqual(f.job.usage.translation,[previousUsage]);
  assert.doesNotMatch(JSON.stringify(f.job),/private|fixture-secret|provider payload/);
});

test('unrecognized external diagnostics and provider fields cannot enter public job errors or usage',async t=>{
  const f=await fixture(t,{transcribe:async()=>{throw Object.assign(new Error('private'),{code:'AI_INVALID_RESPONSE',validation:{reason:'private reason',index:1},providerUsage:{raw:'private response',input_tokens:'private token count'}});}});
  assert.equal(f.job.status,'failed');assert.equal(f.job.error.code,'AI_INVALID_RESPONSE');
  assert.equal(f.job.error.validation,undefined);
  const failed=f.job.usage.steps.find(step=>step.status==='failed');
  assert.equal(failed.validation,undefined);assert.equal(failed.providerUsage,undefined);
  assert.doesNotMatch(JSON.stringify(f.job),/private/);
});
