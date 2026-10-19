import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createNarratedStore} from '../lib/narrated-store.mjs';
import {createNarratedPipeline,safeError} from '../lib/narrated-pipeline.mjs';
import {narratedTime} from '../lib/narrated-client.mjs';

async function setup(t,{duration,segments}){
  const directory=await mkdtemp(path.join(tmpdir(),'narrated-long-')),root=path.join(directory,'projects'),store=createNarratedStore(':memory:');
  const calls={plans:[],starts:[],assembly:[]};
  let dispatcher;
  t.after(async()=>{await dispatcher?.close();store.close();await rm(directory,{recursive:true,force:true});});
  const project=store.create({sourceUrl:'https://www.youtube.com/watch?v=C5kR-exHmr4'});
  await mkdir(path.join(root,project.id),{recursive:true});
  const source=path.join(root,project.id,'source.mp4');await writeFile(source,'original source');
  const tools={narratedPollIntervalMs:0,narratedTickMs:2,
    importVideo:async()=>({inputPath:source,title:'Long source',metadata:{duration,width:640,height:360,hasAudio:true}}),
    extractAudio:async(_input,output)=>{await writeFile(output,'audio fixture');},
    narratedAi:{transcribe:async(_file,options)=>{assert.equal(options.duration,duration);return {segments,usage:{audioSeconds:duration}};}},
    narratedProvider:{generateNarratedPlan:async({windows})=>{calls.plans.push(windows);return {title:'Long source',continuity:'Consistent setting',scenes:windows.map(w=>({id:w.id,title:w.id,visual:'Natural motion',prompt:'Keep natural motion'}))};},
      startSceneVideo:async(input)=>{calls.starts.push(input);throw Object.assign(new Error('fixture stops before paid video generation'),{code:'AI_QUOTA'});}},
  };
  dispatcher=createNarratedPipeline({store,root,readConfig:()=>({provider:'gemini',apiKey:'fixture-ai',videoApiKey:'fixture-video'}),tools});
  const settle=async()=>{
    for(let attempts=0;attempts<400;attempts++){
      const current=store.get(project.id);if(current.status==='failed'||current.status==='completed')return current;
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.fail('Narrated project did not settle');
  };
  return {store,id:project.id,calls,settle};
}

test('narrated planning covers an hour-long source and final speech in batches of twenty',async t=>{
  const duration=3600.25,segments=[{id:'first',start:0,end:2,text:'First words.'},{id:'last',start:3599,end:duration,text:'Final words.'}];
  const f=await setup(t,{duration,segments}),result=await f.settle();
  assert.equal(result.error?.code,'AI_QUOTA');assert.equal(result.duration,duration);
  assert.equal(result.windows[0].start,0);assert.equal(result.windows.at(-1).end,duration);
  assert.ok(result.windows.at(-1).transcriptIds.includes('last'));
  assert.ok(f.calls.plans.length>20);assert.ok(f.calls.plans.every(batch=>batch.length<=20));
  assert.deepEqual(f.calls.plans.flat().map(w=>w.id),result.windows.map(w=>w.id));
  assert.equal(result.scenes.length,result.windows.length);assert.equal(f.calls.starts.length,1);
});

test('long narrated transcripts are not truncated or rejected at twenty thousand segments',async t=>{
  const duration=2200,segments=Array.from({length:20001},(_,i)=>({id:`line-${i}`,start:i/10,end:i/10+.05,text:'A word.'}));
  const f=await setup(t,{duration,segments}),result=await f.settle();
  assert.equal(result.error?.code,'AI_QUOTA');assert.equal(result.transcript.length,segments.length);
  assert.ok(result.windows.some(w=>w.transcriptIds.includes('line-20000')));
  assert.equal(result.windows.at(-1).end,duration);assert.equal(result.scenes.length,result.windows.length);
});

test('narrated long durations display hours without losing hundredths',()=>{
  assert.equal(narratedTime(62.25),'01:02.25');
  assert.equal(narratedTime(3600.25),'01:00:00.25');
  assert.equal(narratedTime(7265.25),'02:01:05.25');
});

test('narrated input errors describe completed sources and the current 5 GB budget',()=>{
  assert.doesNotMatch(safeError({code:'VIDEO_TOO_LONG'}).message,/25/);
  assert.match(safeError({code:'VIDEO_TOO_LARGE'}).message,/5 GB/);
});
