import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {createStore} from '../lib/store.mjs';
import {createApi} from '../lib/api.mjs';
import {createPipeline} from '../lib/pipeline.mjs';
import {defaultDubbingProfile} from '../lib/dubbing.mjs';

async function fixture(t) {
 const dataDir=await mkdtemp(path.join(tmpdir(),'vietsub-clips-flow-')),store=createStore(path.join(dataDir,'jobs.sqlite')),created=store.createJob({title:'Manual clips'}),id=created.id,directory=path.join(dataDir,'jobs',id);await mkdir(directory,{recursive:true});
 const inputPath=path.join(directory,'input.mp4'),videoPath=path.join(directory,'captioned.mp4'),dubbedPath=path.join(directory,'dubbed.mp4');await Promise.all([[inputPath,'original'],[videoPath,'captioned'],[dubbedPath,'dubbed']].map(([p,c])=>writeFile(p,c)));
 store.updateJob(id,{status:'completed',duration:10,renderedVersion:1,artifacts:{inputPath,videoPath,dubbedPath,posterPath:inputPath}});
 const cues=[{id:'a',sourceId:'a',start:0,end:2,text:'Xin chào.',original:'Hello.'}];store.saveCues(id,0,cues);store.saveDubbing(id,defaultDubbingProfile(cues,1));store.updateJob(id,{dubbingOutput:{version:1,subtitleVersion:1,token:'dubbed-output'}});
 const calls=[];let onCut;
 const tools={probeVideo:async()=>({duration:10,width:320,height:180,hasAudio:true}),cutVideoClip:async options=>{calls.push({inputPath:options.inputPath,start:options.start,end:options.end});await writeFile(options.outputPath,`clip-${calls.length}`);options.onProgress?.(1);await onCut?.(options);return {duration:options.end-options.start,width:320,height:180,hasAudio:true};}};
 const pipeline=createPipeline({store,dataDir,workerId:'clip-worker',config:{},tools,ai:{transcribe:async()=>{throw Error('No AI for cutting');},translateSegments:async()=>{throw Error('No AI for cutting');}}});
 const api=createApi({store,dataDir,config:{readConfig:()=>({})}}),app=express();app.use('/api',api);const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/api/jobs/${id}`;
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await api.close();store.close();await rm(dataDir,{recursive:true,force:true});});
 const body={source:'video',subtitleVersion:1,dubbingVersion:1,ranges:[{start:1.25,end:3.5},{start:7,end:9}]};
 return {store,id,directory,dataDir,body,calls,setOnCut:cb=>onCut=cb,call:(url='',options={})=>fetch(base+url,{...options,headers:{'content-type':'application/json',...options.headers}}),run:async()=>{store.claimNextJob('clip-worker');await pipeline.runJob(id);return store.getJobInternal(id);}};
}

test('manual clip requests need no AI key, snapshot the explicit source and reject duplicates or stale state',async t=>{
 const f=await fixture(t);const response=await f.call('/clips',{method:'POST',body:JSON.stringify(f.body)});assert.equal(response.status,202);const data=await response.json();assert.equal(data.job.status,'queued');assert.ok(!JSON.stringify(data).includes(f.dataDir));assert.equal(f.store.getJobInternal(f.id).clipsRequest.sourcePath,path.join(f.directory,'captioned.mp4'));
 assert.equal((await f.call('/clips',{method:'POST',body:JSON.stringify(f.body)})).status,409);
});
test('manual clip API validates times and source state and expires with the parent job',async t=>{
 const f=await fixture(t);
 for(const patch of [{ranges:[{start:8,end:2}]},{ranges:[{start:0,end:11}]},{source:'private-path'},{inputPath:'C:/private'}])assert.equal((await f.call('/clips',{method:'POST',body:JSON.stringify({...f.body,...patch})})).status,400);
 assert.equal((await f.call('/clips',{method:'POST',body:JSON.stringify({...f.body,subtitleVersion:0})})).status,409);
 f.store.updateJob(f.id,{status:'expired'});assert.equal((await f.call('/clips',{method:'POST',body:JSON.stringify(f.body)})).status,410);
});
test('a clip batch publishes atomically, preserves source/subtitles/retention and supports confined ranged downloads',async t=>{
 const f=await fixture(t);assert.equal(typeof f.store.queueClips,'function');const before=f.store.getJob(f.id),cues=f.store.getCues(f.id);f.store.queueClips(f.id,f.body);const job=await f.run();assert.equal(job.status,'completed');assert.equal(job.clipsRequest,null);assert.equal(job.clipsOutput.clips.length,2);assert.equal(job.clipsOutput.source,'video');assert.equal(job.expiresAt,before.expiresAt);assert.equal(job.renderedVersion,1);assert.deepEqual(f.store.getCues(f.id),cues);assert.equal(await readFile(job.artifacts.videoPath,'utf8'),'captioned');assert.deepEqual(f.calls.map(c=>[c.start,c.end]),[[1.25,3.5],[7,9]]);assert.ok(!job.usage.transcription.length&&!job.usage.translation.length);
 const url=`/clips/${job.clipsOutput.token}/0`,r=await f.call(url,{headers:{Range:'bytes=0-3'}});assert.equal(r.status,206);assert.equal(await r.text(),'clip');
 for(const suffix of ['/clips/bad-token/0',`/clips/${job.clipsOutput.token}/99`,`/clips/${job.clipsOutput.token}/-1`,`/clips/${job.clipsOutput.token}/0abc`])assert.equal((await f.call(suffix)).status,404);
 f.store.updateJob(f.id,{artifacts:{clipsDirectory:f.dataDir}});assert.equal((await f.call(url)).status,404);
 f.store.updateJob(f.id,{status:'expired'});assert.equal((await f.call(url)).status,410);
});
test('failed or cancelled cuts keep the prior batch and remove unpublished partial files',async t=>{
 const f=await fixture(t);assert.equal(typeof f.store.queueClips,'function');f.store.queueClips(f.id,f.body);const first=await f.run();
 for(const cancel of [false,true]){f.store.queueClips(f.id,{...f.body,source:'dubbed'});f.setOnCut(async()=>{if(cancel)f.store.requestCancellation(f.id);else throw Error('private encoder error');});const job=await f.run();assert.equal(job.status,cancel?'cancelled':'failed');assert.deepEqual(job.clipsOutput,first.clipsOutput);assert.equal(job.artifacts.clipsDirectory,first.artifacts.clipsDirectory);assert.equal((await readdir(f.directory)).filter(n=>n.startsWith('.clips-')).length,0);}
});
test('clips refuse source paths outside their job and block subtitle edits while queued',async t=>{
 const f=await fixture(t);assert.equal(typeof f.store.queueClips,'function');f.store.updateJob(f.id,{artifacts:{videoPath:path.join(f.dataDir,'jobs.sqlite')}});f.store.queueClips(f.id,f.body);assert.throws(()=>f.store.saveCues(f.id,1,[{id:'a',text:'Changed'}]),{code:'JOB_BUSY'});const job=await f.run();assert.equal(job.status,'failed');assert.equal(job.error.code,'CLIP_INVALID_INPUT');assert.equal(f.calls.length,0);
});
test('changed subtitle version during a cut prevents stale batch publication',async t=>{
 const f=await fixture(t);assert.equal(typeof f.store.queueClips,'function');f.store.queueClips(f.id,f.body);f.setOnCut(()=>f.store.saveCues(f.id,1,[{id:'a',text:'New subtitles'}],{workerId:'clip-worker'}));const job=await f.run();assert.equal(job.status,'failed');assert.equal(job.error.code,'VERSION_CONFLICT');assert.ok(!job.clipsOutput);assert.equal(f.calls.length,1);
});
test('new operation requests replace the previous pending task and retries preserve a clip request',async t=>{
 const f=await fixture(t);assert.equal(typeof f.store.queueClips,'function');f.store.queueClips(f.id,f.body);f.store.requestCancellation(f.id);f.store.queueDubbing(f.id,{action:'analyze',version:1,subtitleVersion:1});assert.equal(f.store.getJobInternal(f.id).clipsRequest,null);f.store.requestCancellation(f.id);f.store.queueClips(f.id,f.body);assert.equal(f.store.getJobInternal(f.id).dubbingRequest,null);f.store.requestCancellation(f.id);
 assert.equal((await f.call('/retry',{method:'POST',body:'{}'})).status,202);assert.ok(f.store.getJobInternal(f.id).clipsRequest);f.store.requestCancellation(f.id);assert.equal((await f.call('/render',{method:'POST',body:'{}'})).status,202);assert.equal(f.store.getJobInternal(f.id).clipsRequest,null);
});

test('a download token and its directory are read from the same published batch snapshot',async t=>{
 const f=await fixture(t);f.store.queueClips(f.id,f.body);const old=await f.run(),get=f.store.getJobInternal;
 const nextDirectory=path.join(f.directory,'clips-replacement');await mkdir(nextDirectory);await writeFile(path.join(nextDirectory,'clip-01.mp4'),'replacement');
 f.store.getJobInternal=id=>{const current=get(id);return {...current,clipsOutput:{...current.clipsOutput,token:'new-token'},artifacts:{...current.artifacts,clipsDirectory:nextDirectory}};};
 assert.equal((await f.call(`/clips/${old.clipsOutput.token}/0`)).status,404,'an old token must never download the replacement batch');
});

test('cutting a saved MP4 does not require importing or probing the original again',async t=>{
 const f=await fixture(t);await rm(path.join(f.directory,'input.mp4'));f.store.queueClips(f.id,f.body);const job=await f.run();assert.equal(job.status,'completed');assert.equal(f.calls.length,2);
});
test('expiry between clips stops the next cut and prevents batch publication',async t=>{
 const f=await fixture(t);f.store.queueClips(f.id,f.body);f.setOnCut(()=>f.store.updateJob(f.id,{firstCompletedAt:new Date(Date.now()-25*60*60*1000).toISOString()}));const job=await f.run();assert.equal(job.status,'expired');assert.ok(!job.clipsOutput);assert.equal(f.calls.length,1);
});
test('lease loss fences publication and the recovered request can finish without AI work',async t=>{
 const f=await fixture(t);f.store.queueClips(f.id,f.body);f.setOnCut(()=>f.store.releaseWorker('clip-worker'));const interrupted=await f.run();assert.equal(interrupted.status,'running');assert.ok(!interrupted.clipsOutput);assert.ok(interrupted.clipsRequest);assert.equal(f.calls.length,1);assert.equal((await readdir(f.directory)).filter(n=>n.startsWith('.clips-')).length,0);
 f.setOnCut(null);const completed=await f.run();assert.equal(completed.status,'completed');assert.equal(completed.clipsOutput.clips.length,2);assert.equal(f.calls.length,3);
});
