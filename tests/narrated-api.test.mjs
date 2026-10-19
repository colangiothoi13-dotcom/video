import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createNarratedApi} from '../lib/narrated-api.mjs';
import {createNarratedStore} from '../lib/narrated-store.mjs';

const test=(name,run)=>nodeTest(name,{timeout:30000},run);
function waitForAbort(signal,onAbort=()=>{}){
 return new Promise((resolve,reject)=>{
  const abort=()=>Promise.resolve().then(onAbort).then(()=>reject(signal.reason),reject);
  if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
 });
}

test('blocking fixtures settle when shutdown happened before listener registration',async()=>{
 const controller=new AbortController(),reason=new Error('already closed');controller.abort(reason);let cleaned=false;
 await assert.rejects(waitForAbort(controller.signal,()=>{cleaned=true;}),error=>error===reason);assert.equal(cleaned,true);
});

async function fixture(t,{config={apiKey:'secret-ai',provider:'openai',videoApiKey:'secret-video'},overrides={},duration=10}={}){
 const dataDir=await mkdtemp(path.join(tmpdir(),'narrated-api-'));let router,server,base;const calls={imports:0,asr:0,plans:[],starts:[],assemblies:[]};
 const tools={narratedPollIntervalMs:0,narratedTickMs:2,
 importVideo:async(url,dir)=>{calls.imports++;const inputPath=path.join(dir,'source.mp4');await writeFile(inputPath,'source-original');return {inputPath,title:'Original title',metadata:{duration,width:720,height:1280,hasAudio:true}};},
 extractAudio:async(input,destination)=>{await writeFile(destination,'asr-only');return {path:destination};},
 narratedAi:{transcribe:async()=>{calls.asr++;return {segments:[{id:'t1',start:0,end:duration,text:'Original words'}],usage:{tokens:2}};}},
 narratedProvider:{generateNarratedPlan:async({windows})=>{calls.plans.push(windows);return {title:'Plan',continuity:'Natural light',scenes:windows.map(w=>({id:w.id,title:w.id,visual:'real motion',prompt:'Natural motion'}))};},startSceneVideo:async(input)=>{calls.starts.push(input);return {operationName:`operations/${calls.starts.length}`};},pollSceneVideo:async()=>({done:true,videoUri:'https://provider.invalid/private'}),downloadSceneVideo:async(uri,destination)=>{await writeFile(destination,'scene-video');}},
 narratedMedia:{buildNarratedTimeline:(transcript,duration)=>Array.from({length:Math.ceil(duration/8)},(_,i)=>({id:`scene-${i+1}`,start:i*8,end:Math.min(duration,(i+1)*8),generationDurationSeconds:8,transcriptIds:['t1'],transcriptText:'Original words'})),probeNarratedClip:async()=>({duration:8}),assembleNarratedVideo:async args=>{calls.assemblies.push(args);await writeFile(args.outputPath,'final-original');return {duration};}},
 ...overrides,narratedProvider:{...({generateNarratedPlan:async({windows})=>{calls.plans.push(windows);return {title:'Plan',continuity:'Natural light',scenes:windows.map(w=>({id:w.id,title:w.id,visual:'real motion',prompt:'Natural motion'}))};},startSceneVideo:async(input)=>{calls.starts.push(input);return {operationName:`operations/${calls.starts.length}`};},pollSceneVideo:async()=>({done:true,videoUri:'https://provider.invalid/private'}),downloadSceneVideo:async(uri,destination)=>{await writeFile(destination,'scene-video');}}),...overrides.narratedProvider}};
 async function open(){router=createNarratedApi({dataDir,readConfig:()=>config,tools});const app=express();app.use(express.json());app.use('/api/narrated',router);server=createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}/api/narrated`;}
 async function close(){await router.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
 await open();t.after(async()=>{await close();await rm(dataDir,{recursive:true,force:true});});
 const call=(route='',method='GET',body)=>fetch(base+route,{method,signal:AbortSignal.timeout(5000),headers:{'content-type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 const get=async id=>(await (await call(`/projects/${id}`)).json()).project;
 const until=async(id,predicate)=>{for(let n=0;n<300;n++){const p=await get(id);if(predicate(p))return p;await new Promise(r=>setTimeout(r,5));}assert.fail('project did not settle');};
 const create=async()=>{const r=await call('/projects','POST',{url:'https://youtu.be/abcdefghijk',aspectRatio:'9:16'});assert.equal(r.status,202,await r.clone().text());return(await r.json()).project;};
 return {dataDir,calls,call,get,until,create,shutdown:()=>router.close(),reopen:async()=>{await close();await open();}};
}

test('URL project completes without TTS, redacts internal state and survives restart with source soundtrack',async t=>{
 const f=await fixture(t);const initial=await f.create();assert.equal(initial.sourceUrl,'https://www.youtube.com/watch?v=abcdefghijk');const p=await f.until(initial.id,p=>p.status==='completed');assert.equal(p.scenes.length,2);assert.equal(f.calls.starts.length,2);assert.equal(f.calls.assemblies[0].inputPath.endsWith('source.mp4'),true);assert.doesNotMatch(JSON.stringify(p),/secret-|operations\/|provider.invalid|inputPath|audioPath|artifact|[A-Z]:\\/);await f.reopen();assert.equal((await f.get(p.id)).status,'completed');assert.equal(f.calls.imports,1);assert.equal(f.calls.asr,1);
 const preview=await f.call(p.assembly.videoUrl.replace('/api/narrated',''));assert.equal(await preview.text(),'final-original');
 const ranged=await fetch(preview.url,{headers:{range:'bytes=0-4'}});assert.equal(ranged.status,206);assert.equal(await ranged.text(),'final');
});

test('validation and missing video config fail before importing or charging',async t=>{
 const f=await fixture(t,{config:{apiKey:'openai',provider:'openai',videoApiKey:''}});
 for(const body of [{url:'http://127.0.0.1/private'},{url:'https://youtu.be/abcdefghijk',aspectRatio:'1:1'},{url:'https://youtu.be/abcdefghijk',inputPath:'private'}])assert.equal((await f.call('/projects','POST',body)).status,400);
 const r=await f.call('/projects','POST',{url:'https://youtu.be/abcdefghijk'});assert.equal((await r.json()).error.code,'AI_VIDEO_NOT_CONFIGURED');assert.equal(f.calls.imports,0);
});

test('prompt versions retain history and stale previews; single regeneration waits for explicit render',async t=>{
 const f=await fixture(t),p=await f.create(),done=await f.until(p.id,p=>p.status==='completed');
 const edit=await f.call(`/projects/${p.id}/scenes/scene-1`,'PUT',{version:1,prompt:'Updated realistic motion'});assert.equal(edit.status,200);const saved=(await edit.json()).project;assert.equal(saved.scenes[0].version,2);assert.equal(saved.assembly.stale,true);assert.ok(saved.assembly.videoUrl);assert.equal(saved.scenes[0].history[0].prompt,'Natural motion');
 assert.equal((await f.call(`/projects/${p.id}/scenes/scene-1`,'PUT',{version:1,prompt:'conflict'})).status,409);
 assert.equal((await f.call(`/projects/${p.id}/render`,'POST',{})).status,409);
 assert.equal((await f.call(`/projects/${p.id}/scenes/scene-1/generate`,'POST',{version:2})).status,202);
 const updated=await f.until(p.id,p=>!p.busy&&p.scenes[0].status==='completed');assert.equal(updated.scenes[0].history.length,2);assert.equal(f.calls.starts.length,3);assert.equal(f.calls.assemblies.length,1);assert.equal(updated.assembly.stale,true);assert.equal((await f.call(`/projects/${p.id}/render`,'POST',{})).status,202);await f.until(p.id,p=>p.status==='completed'&&!p.assembly.stale);assert.equal(f.calls.assemblies.length,2);
 const old=await f.call(done.scenes[0].history[0].videoUrl.replace('/api/narrated',''));assert.equal(await old.text(),'scene-video');
});

test('planning batches are checkpointed at no more than twenty windows',async t=>{const f=await fixture(t,{duration:168});const p=await f.create();await f.until(p.id,p=>p.status==='completed');assert.deepEqual(f.calls.plans.map(w=>w.length),[20,1]);});

test('busy deletion is blocked and shutdown aborts and awaits ASR work',async t=>{
 let stopped=false;const f=await fixture(t,{overrides:{narratedAi:{transcribe:async(file,{signal})=>waitForAbort(signal,async()=>{await new Promise(resolve=>setTimeout(resolve,20));stopped=true;})}}});const p=await f.create();await f.until(p.id,p=>p.status==='transcribing');assert.equal((await f.call(`/projects/${p.id}`,'DELETE')).status,409);await f.shutdown();assert.equal(stopped,true);await f.reopen();const interrupted=await f.get(p.id);assert.equal(interrupted.status,'failed');assert.equal(interrupted.error.code,'NARRATED_INTERRUPTED');
});

test('paid start is durable before submission and ambiguous shutdown requires explicit resume',async t=>{
 let f,attempts=0,snapshot;
 f=await fixture(t,{overrides:{narratedProvider:{startSceneVideo:async(input,{signal})=>{attempts++;const store=createNarratedStore(path.join(f.dataDir,'narrated.sqlite'));snapshot=store.list()[0];store.close();if(attempts>1)return {operationName:'operations/retried'};return waitForAbort(signal);}}}});
 const p=await f.create();await f.until(p.id,p=>p.scenes[0]?.status==='starting');assert.equal(snapshot.scenes[0].history[0].status,'starting');assert.equal(snapshot.scenes[0].operation.name,null);await f.shutdown();await f.reopen();const failed=await f.get(p.id);assert.equal(failed.status,'failed');assert.equal(failed.error.code,'NARRATED_INTERRUPTED');assert.equal(attempts,1);assert.equal((await f.call(`/projects/${p.id}/resume`,'POST',{})).status,202);const done=await f.until(p.id,p=>p.status==='completed');assert.equal(attempts,3);assert.equal(done.scenes[0].history.length,2);assert.equal(done.scenes[0].history[1].status,'failed');
});

test('known operation restart polls without another paid submission',async t=>{
 let pending=true,polls=0;
 const f=await fixture(t,{overrides:{narratedProvider:{pollSceneVideo:async(name,{signal})=>{polls++;if(!pending)return {done:true,videoUri:'https://provider.invalid/private'};return waitForAbort(signal);}}}});
 const p=await f.create();await f.until(p.id,p=>p.scenes[0]?.status==='generating');await f.shutdown();pending=false;await f.reopen();await f.until(p.id,p=>p.status==='completed');assert.equal(f.calls.starts.length,2);assert.ok(polls>=3);
});

test('explicit resume retains completed planning batches and good clips',async t=>{
 let plans=0,starts=0;
 const f=await fixture(t,{duration:168,overrides:{narratedProvider:{generateNarratedPlan:async({windows})=>{plans++;if(plans===2)throw Object.assign(new Error('secret /disk/provider'),{code:'AI_QUOTA'});return {title:'Plan',continuity:'Natural light',scenes:windows.map(w=>({id:w.id,title:w.id,visual:'real motion',prompt:'Natural motion'}))};},startSceneVideo:async()=>{starts++;if(starts===3)throw Object.assign(new Error('secret https://provider.invalid'),{code:'AI_QUOTA'});return {operationName:`operations/${starts}`};}}}});
 const p=await f.create();const failed=await f.until(p.id,p=>p.status==='failed');assert.equal(failed.scenes.length,20);assert.doesNotMatch(JSON.stringify(failed),/secret|\/disk|provider.invalid/);assert.equal((await f.call(`/projects/${p.id}/resume`,'POST',{})).status,202);await f.until(p.id,p=>p.status==='failed');assert.equal(plans,3);assert.equal(starts,3);assert.equal((await f.call(`/projects/${p.id}/resume`,'POST',{})).status,202);await f.until(p.id,p=>p.status==='completed');assert.equal(plans,3);assert.equal(starts,22);
});

test('corrupt artifact paths and generation selectors cannot escape project files',async t=>{
 const f=await fixture(t),p=await f.create();await f.until(p.id,p=>p.status==='completed');const foreign=path.join(f.dataDir,'secret.mp4');await writeFile(foreign,'private');const store=createNarratedStore(path.join(f.dataDir,'narrated.sqlite'));store.mutate(p.id,p=>{p.assembly.artifact.path=foreign;p.scenes[0].artifact.path=foreign;});store.close();for(const kind of ['video','scene-1'])assert.equal((await f.call(`/projects/${p.id}/files/${kind}`)).status,404);assert.equal((await f.call(`/projects/${p.id}/files/source?generation=../../secret`)).status,404);assert.equal((await f.call(`/projects/${p.id}`,'DELETE')).status,200);assert.equal((await f.call(`/projects/${p.id}`)).status,404);
});

test('explicit resume retries expired operations but preserves known IDs for transient download failure',async t=>{
 let polls=0,downloads=0;const f=await fixture(t,{duration:4,overrides:{narratedProvider:{pollSceneVideo:async()=>{polls++;if(polls===1)throw Object.assign(new Error('expired'),{code:'AI_OPERATION_EXPIRED'});return {done:true,videoUri:'https://provider.invalid/private'};},downloadSceneVideo:async(uri,destination)=>{downloads++;if(downloads===1)throw Object.assign(new Error('offline'),{code:'AI_DOWNLOAD'});await writeFile(destination,'good');}}}});
 const p=await f.create();await f.until(p.id,p=>p.status==='failed');assert.equal(f.calls.starts.length,1);await f.call(`/projects/${p.id}/resume`,'POST',{});await f.until(p.id,p=>p.status==='failed');assert.equal(f.calls.starts.length,2);await f.call(`/projects/${p.id}/resume`,'POST',{});await f.until(p.id,p=>p.status==='completed');assert.equal(f.calls.starts.length,2);
});

test('partial planning cannot be abandoned through manual scene actions',async t=>{
 let plans=0;const f=await fixture(t,{duration:168,overrides:{narratedProvider:{generateNarratedPlan:async({windows})=>{if(++plans===2)throw Object.assign(new Error('quota'),{code:'AI_QUOTA'});return {title:'Plan',continuity:'Natural light',scenes:windows.map(w=>({id:w.id,title:w.id,visual:'real motion',prompt:'Natural motion'}))};}}}});
 const p=await f.create();await f.until(p.id,p=>p.status==='failed');
 for(const [route,method,body] of [[`/scenes/scene-1`,'PUT',{version:1,prompt:'edited'}],[`/scenes/scene-1/generate`,'POST',{version:1}],['/render','POST',{}]])assert.equal((await f.call(`/projects/${p.id}${route}`,method,body)).status,409);
 assert.equal((await f.get(p.id)).status,'failed');await f.call(`/projects/${p.id}/resume`,'POST',{});await f.until(p.id,p=>p.status==='completed');assert.equal(plans,3);
});

test('default ASR extraction uses the narrated timestamp-preserving helper',async t=>{
 let extracted=0,transcribed=0;
 const f=await fixture(t,{overrides:{extractAudio:undefined,narratedMedia:{extractNarratedAudio:async(input,destination)=>{assert.ok(input.endsWith('source.mp4'));extracted++;await writeFile(destination,'timestamp-preserved-audio');}},narratedAi:{transcribe:async()=>{transcribed++;throw Object.assign(new Error('stop after extraction'),{code:'AI_QUOTA'});}}}});
 const p=await f.create();await f.until(p.id,p=>p.status==='failed');assert.equal(extracted,1);assert.equal(transcribed,1);
});
