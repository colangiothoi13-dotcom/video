import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createServer, request as httpRequest} from 'node:http';
import {mkdtemp, mkdir, writeFile, readFile, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createStore} from '../lib/store.mjs';
import {createApi} from '../lib/api.mjs';

const toolStatus={ffmpeg:{available:true,subtitles:true},ffprobe:{available:true},ytdlp:{available:false},font:{available:true}};
async function fixture(t, options={}) {
  const fixtureRoot=await mkdtemp(path.join(tmpdir(),'vietsub-api-'));
  const dataDir=options.hiddenRoot?path.join(fixtureRoot,'.data'):fixtureRoot;
  await mkdir(dataDir,{recursive:true});
  const store=createStore(path.join(dataDir,'jobs.sqlite'));
  let probes=0;
  const app=express();app.use('/api',createApi({store,dataDir,config:{env:{},...options.config},tools:{getToolStatus:async()=>{probes++;return toolStatus;},...options.tools}}));
  const server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();await rm(fixtureRoot,{recursive:true,force:true});});
  const call=(route,init={})=>fetch(base+'/api'+route,{...init,headers:{...(init.body && !(init.body instanceof FormData)?{'content-type':'application/json'}:{}),...init.headers}});
  const seed=()=>store.createJob({title:'Video kiểm thử',sourceType:'upload'});
  return {dataDir,store,base,call,seed,probes:()=>probes};
}
test('settings remain secret and health caches expensive tool checks',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('/settings/test',{method:'POST'})).status,400);
  const saved=await f.call('/settings',{method:'PUT',body:JSON.stringify({apiKey:'sk-private-test',translationModel:'gemini-test-model'})});
  assert.deepEqual(await saved.json(),{provider:'gemini',configured:true,translationModel:'gemini-test-model',transcriptionModel:'gemini-3.5-transcribe'});
  const text=await (await f.call('/settings')).text();assert.ok(!text.includes('sk-private'));
  const health=await (await f.call('/health')).json();await f.call('/health');
  assert.equal(health.configured,true);assert.deepEqual(health.worker,{active:false,workerId:null,heartbeatAt:null});assert.equal(health.tools.ytdlp.available,false);assert.equal(f.probes(),1);
  assert.equal((await f.call('/settings',{method:'PUT',body:JSON.stringify({translationModel:'x',baseUrl:'https://evil.example'})})).status,400);
});

test('settings reject another provider model with a safe Gemini instruction and preserve the saved model',async t=>{
  const f=await fixture(t);
  await f.call('/settings',{method:'PUT',body:JSON.stringify({apiKey:'fixture-gemini-key'})});
  const response=await f.call('/settings',{method:'PUT',body:JSON.stringify({translationModel:'gpt-5.6-terra'})});
  assert.equal(response.status,400);const payload=await response.json();
  assert.equal(payload.error.code,'INVALID_GEMINI_MODEL');assert.match(payload.error.message,/Gemini/);
  assert.equal((await(await f.call('/settings')).json()).translationModel,'gemini-3.5-flash-lite');
});

test('connection check uses both Gemini models and exposes actual models without the key',async t=>{
  let received;const f=await fixture(t,{tools:{testAiConnection:async options=>{
    received=options;return {ok:true,translationModel:options.model,transcriptionModel:options.transcriptionModel};
  }}});
  await f.call('/settings',{method:'PUT',body:JSON.stringify({apiKey:'fixture-gemini-secret',translationModel:'gemini-custom'})});
  const response=await f.call('/settings/test',{method:'POST'});assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true,provider:'gemini',translationModel:'gemini-custom',transcriptionModel:'gemini-3.5-transcribe'});
  assert.equal(received.apiKey,'fixture-gemini-secret');assert.equal(received.model,'gemini-custom');assert.equal(received.transcriptionModel,'gemini-3.5-transcribe');
});
test('mutation guard rejects foreign Origin, foreign Host and oversized JSON',async t=>{
  const f=await fixture(t);
  for(const headers of [{origin:'https://evil.example'},{origin:'http://localhost:9999'}]) assert.equal((await f.call('/settings',{method:'PUT',headers,body:'{}'})).status,403);
  const hostStatus=await new Promise((resolve,reject)=>{const req=httpRequest(f.base+'/api/settings',{method:'PUT',headers:{host:'evil.example','content-type':'application/json'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end('{}');});assert.equal(hostStatus,403);
  assert.equal((await f.call('/settings',{method:'PUT',headers:{origin:f.base},body:'{}'})).status,200);
  assert.equal((await f.call('/settings',{method:'PUT',body:JSON.stringify({apiKey:'x'.repeat(1100000)})})).status,413);
});
test('completed upload is private, ignores malicious filename and queues only complete bytes',async t=>{
  const f=await fixture(t);await f.call('/settings',{method:'PUT',body:'{"apiKey":"sk-test"}'});
  const form=new FormData();form.set('video',new Blob(['actual-video-bytes']),'../../escaped.mp4');form.set('language','vi');form.set('style','classic');
  const response=await f.call('/jobs',{method:'POST',body:form});assert.equal(response.status,202);const {job}=await response.json();
  assert.equal(job.sourceType,'upload');assert.ok(!JSON.stringify(job).includes(f.dataDir));
  const internal=f.store.getJobInternal(job.id);assert.equal(await readFile(internal.artifacts.inputPath,'utf8'),'actual-video-bytes');assert.equal(internal.upload.size,18);
  assert.equal(path.basename(internal.artifacts.inputPath),'input');assert.ok(internal.artifacts.inputPath.startsWith(path.join(f.dataDir,'uploads')+path.sep));
  assert.equal((await (await f.call('/jobs')).json()).jobs.length,1);
});
test('streaming upload limit removes partial files and never queues a job',async t=>{
  const f=await fixture(t,{config:{maxUploadBytes:128}});await f.call('/settings',{method:'PUT',body:'{"apiKey":"sk-test"}'});
  const form=new FormData();form.set('video',new Blob(['x'.repeat(10000)]),'large.mp4');
  assert.equal((await f.call('/jobs',{method:'POST',body:form})).status,413);assert.equal(f.store.listJobs().length,0);
  const uploads=await readdir(path.join(f.dataDir,'uploads'));assert.deepEqual(uploads,[]);
});
test('oversized streaming upload is refused before sender finishes multipart body',async t=>{
  const f=await fixture(t,{config:{maxUploadBytes:128}});await f.call('/settings',{method:'PUT',body:'{"apiKey":"sk-test"}'});
  const status=await new Promise((resolve,reject)=>{
    const req=httpRequest(f.base+'/api/jobs',{method:'POST',headers:{'content-type':'multipart/form-data; boundary=streaming-test'}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',error=>{if(error.code!=='ECONNRESET')reject(error);});
    const timer=setTimeout(()=>{req.destroy();reject(new Error('Server waited for the rest of the oversized upload'));},2000);
    req.once('close',()=>clearTimeout(timer));
    req.write('--streaming-test\r\nContent-Disposition: form-data; name="video"; filename="large.mp4"\r\nContent-Type: video/mp4\r\n\r\n'+'x'.repeat(10000));
  });assert.equal(status,413);assert.equal(f.store.listJobs().length,0);
});
test('missing key and missing URL tool reject creation before queueing',async t=>{
  const f=await fixture(t);const form=()=>{const body=new FormData();body.set('url','https://www.youtube.com/watch?v=BaW_jenozKc');return body;};
  let response=await f.call('/jobs',{method:'POST',body:form()});assert.equal(response.status,400);assert.equal((await response.json()).error.code,'AI_NOT_CONFIGURED');
  await f.call('/settings',{method:'PUT',body:'{"apiKey":"sk-test"}'});response=await f.call('/jobs',{method:'POST',body:form()});assert.equal(response.status,503);assert.equal(f.store.listJobs().length,0);
});
async function withCues(f) {
  const job=f.seed();f.store.updateJob(job.id,{duration:8,status:'completed'});
  f.store.saveCues(job.id,0,[{id:'cue-1',sourceId:'source-1',start:0,end:4,original:'hello',text:'Xin chào'}]);return job.id;
}
test('subtitle edits keep identity/timing, wrap graphemes, reject stale and excessive text; SRT reflects latest save',async t=>{
  const f=await fixture(t);const id=await withCues(f);
  const save=(version,text,extra={})=>f.call(`/jobs/${id}/subtitles`,{method:'PUT',body:JSON.stringify({version,cues:[{id:'cue-1',text,...extra}]})});
  assert.equal((await save(0,'mới')).status,409);
  assert.equal((await save(1,'')).status,400);assert.equal((await save(1,'a'.repeat(85))).status,400);
  assert.equal((await save(1,'mới',{start:2})).status,400);
  const response=await save(1,'👩🏽‍💻'.repeat(60));assert.equal(response.status,200);const result=await response.json();assert.equal(result.job.subtitleVersion,2);assert.equal(result.cues[0].id,'cue-1');assert.equal(result.cues[0].start,0);assert.equal(result.cues[0].end,4);assert.equal(result.cues[0].text.split('\n').length,2);assert.equal(result.cues[0].readingWarning,false);
  const srt=await (await f.call(`/jobs/${id}/files/srt`)).text();assert.ok(srt.includes('00:00:00,000 --> 00:00:04,000'));assert.ok(srt.includes('👩🏽‍💻'));
});
test('video range serves last successful artifact; invalid kind/path and expired jobs are refused',async t=>{
  const f=await fixture(t);const id=await withCues(f);const dir=path.join(f.dataDir,'jobs',id);await mkdir(dir,{recursive:true});const video=path.join(dir,'output.mp4');await writeFile(video,'0123456789');f.store.updateJob(id,{artifacts:{videoPath:video},renderedVersion:1});
  const range=await f.call(`/jobs/${id}/files/video`,{headers:{range:'bytes=2-5'}});assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),'bytes 2-5/10');assert.equal(await range.text(),'2345');
  assert.equal((await f.call(`/jobs/${id}/files/video`,{headers:{range:'bytes=20-'}})).status,416);
  assert.equal((await f.call(`/jobs/${id}/files/secret`)).status,404);
  f.store.updateJob(id,{artifacts:{videoPath:path.join(f.dataDir,'config.json')}});assert.equal((await f.call(`/jobs/${id}/files/video`)).status,404);
  f.store.updateJob(id,{status:'expired'});assert.equal((await f.call(`/jobs/${id}`)).status,410);assert.equal((await f.call(`/jobs/${id}/files/srt`)).status,410);
});
test('source served after upload handoff has inert video MIME, including misleading filename',async t=>{
  const f=await fixture(t);const job=f.seed();const dir=path.join(f.dataDir,'jobs',job.id);await mkdir(dir,{recursive:true});const source=path.join(dir,'input.bin');await writeFile(source,'source-video');
  f.store.updateJob(job.id,{artifacts:{inputPath:source},upload:{originalName:'film.mp4'}});
  let response=await f.call(`/jobs/${job.id}/files/source`);assert.equal(response.headers.get('content-type'),'video/mp4');assert.equal(await response.text(),'source-video');
  f.store.updateJob(job.id,{upload:{originalName:'exploit.html'}});response=await f.call(`/jobs/${job.id}/files/source`);assert.ok(!response.headers.get('content-type').includes('text/html'));
});
test('hidden data ancestor serves allowlisted artifacts and ranges without crossing job or expiry boundaries',async t=>{
  const f=await fixture(t,{hiddenRoot:true});const id=await withCues(f);const directory=path.join(f.dataDir,'jobs',id);await mkdir(directory,{recursive:true});
  const artifacts={inputPath:path.join(directory,'input.bin'),videoPath:path.join(directory,'video.mp4'),posterPath:path.join(directory,'poster.jpg')};
  for(const file of Object.values(artifacts))await writeFile(file,'0123456789');
  f.store.updateJob(id,{artifacts,renderedVersion:1,upload:{originalName:'film.mp4'}});
  for(const [kind,type] of [['source','video/mp4'],['video','video/mp4'],['poster','image/jpeg']]){
    const response=await f.call(`/jobs/${id}/files/${kind}`);assert.equal(response.status,200,kind);assert.equal(response.headers.get('content-type'),type);assert.equal(await response.text(),'0123456789');
    if(kind!=='poster'){const range=await f.call(`/jobs/${id}/files/${kind}`,{headers:{range:'bytes=2-5'}});assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),'bytes 2-5/10');assert.equal(await range.text(),'2345');}
  }
  const other=await withCues(f);const otherDirectory=path.join(f.dataDir,'jobs',other);await mkdir(otherDirectory);const outside=path.join(otherDirectory,'video.mp4');await writeFile(outside,'private other job');
  for(const [kind,field] of [['source','inputPath'],['video','videoPath'],['poster','posterPath']]){f.store.updateJob(id,{artifacts:{[field]:outside}});assert.equal((await f.call(`/jobs/${id}/files/${kind}`)).status,404,kind);}
  f.store.updateJob(id,{artifacts,status:'expired'});
  for(const kind of ['source','video','poster','srt'])assert.equal((await f.call(`/jobs/${id}/files/${kind}`)).status,410,kind);
});
test('cancel queued immediately; running waits for worker; retry/render retain checkpoints and expiry',async t=>{
  const f=await fixture(t);const queued=f.seed();let response=await f.call(`/jobs/${queued.id}/cancel`,{method:'POST'});assert.equal((await response.json()).job.status,'cancelled');
  const running=f.seed();f.store.updateJob(running.id,{status:'running'});response=await f.call(`/jobs/${running.id}/cancel`,{method:'POST'});assert.equal((await response.json()).job.status,'running');assert.equal(f.store.getJobInternal(running.id).cancelRequested,true);
  const id=await withCues(f);f.store.updateJob(id,{checkpoint:{transcription:[1],translations:[2]},renderedVersion:1});const expiry=f.store.getJob(id).expiresAt;
  response=await f.call(`/jobs/${id}/render`,{method:'POST'});assert.equal(response.status,202);assert.equal((await response.json()).job.status,'queued');assert.deepEqual(f.store.getJobInternal(id).checkpoint,{transcription:[1],translations:[2]});assert.equal(f.store.getJob(id).expiresAt,expiry);assert.equal(f.store.getJob(id).renderedVersion,1);
  f.store.updateJob(id,{status:'failed'});response=await f.call(`/jobs/${id}/retry`,{method:'POST'});assert.equal(response.status,202);assert.equal(f.store.getJob(id).expiresAt,expiry);
});
test('retry and render refuse stale terminal reads after another actor claims the job',async t=>{
  for(const action of ['retry','render']){
    const f=await fixture(t);const id=await withCues(f);f.store.updateJob(id,{status:action==='retry'?'failed':'completed'});
    const get=f.store.getJob;let interleaved=false;
    f.store.getJob=function(jobId){const snapshot=get(jobId);if(jobId===id&&!interleaved){interleaved=true;f.store.updateJob(id,{status:'running'});}return snapshot;};
    const response=await f.call(`/jobs/${id}/${action}`,{method:'POST'});assert.equal(response.status,409);assert.equal(get(id).status,'running');
  }
});
test('settings connection failures expose only safe error and never provider diagnostics',async t=>{
  let checks=0;const f=await fixture(t,{tools:{testAiConnection:async()=>{checks++;throw Object.assign(new Error('sk-secret D:\\private stderr'),{code:'AI_AUTH'});}}});
  await f.call('/settings',{method:'PUT',body:'{"apiKey":"sk-secret"}'});const response=await f.call('/settings/test',{method:'POST'});assert.equal(response.status,400);const payload=await response.text();assert.ok(!payload.includes('sk-secret'));assert.ok(!payload.includes('stderr'));assert.equal(checks,1);
});
test('custom server binds loopback and mounts API before page handler',async t=>{
  const module=await import('../server.mjs');
  const dataDir=await mkdtemp(path.join(tmpdir(),'vietsub-server-'));let closed=false;
  const server=await module.createWebServer({dataDir,port:0,config:{env:{}},tools:{getToolStatus:async()=>toolStatus},nextApp:{prepare:async()=>{},getRequestHandler:()=>((req,res)=>{res.end('trang ứng dụng');}),close:async()=>{closed=true;}}});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  assert.equal(server.address.address,'127.0.0.1');const base=`http://127.0.0.1:${server.address.port}`;assert.equal((await fetch(base+'/api/health')).status,200);assert.equal(await(await fetch(base+'/')).text(),'trang ứng dụng');await server.close();assert.equal(closed,true);
});
test('launcher owns separate children, forwards production and waits for graceful IPC shutdown',async t=>{
  const module=await import('../scripts/start.mjs');
  const dir=await mkdtemp(path.join(tmpdir(),'vietsub-launch-'));const script=path.join(dir,'child.mjs');
  await writeFile(script,"import{writeFileSync}from'node:fs';process.send({ready:true,args:process.argv.slice(2)});process.on('message',m=>{if(m?.type==='shutdown'){writeFileSync(process.env.MARKER_BASE+'-'+process.pid,'stopped');process.disconnect();}});");
  const studio=module.startStudio({production:true,cwd:dir,serverScript:script,workerScript:script,env:{...process.env,MARKER_BASE:path.join(dir,'marker')}});
  t.after(async()=>{await studio.stop();await rm(dir,{recursive:true,force:true});});
  assert.notEqual(studio.children[0].pid,studio.children[1].pid);
  const ready=await Promise.all(studio.children.map(child=>new Promise(resolve=>child.once('message',resolve))));assert.ok(ready[0].args.includes('--production'));
  await studio.stop();for(const child of studio.children){assert.equal(child.exitCode,0);assert.equal(await readFile(path.join(dir,'marker-'+child.pid),'utf8'),'stopped');}
});
for(const action of ['shutdown','disconnect'])test(`${action} during Next preparation closes the eventual server`, {timeout:10000},async t=>{
  const serverUrl=pathToFileURL(path.resolve('server.mjs')).href;
    const dir=await mkdtemp(path.join(tmpdir(),'vietsub-startup-'));const script=path.join(dir,'child.mjs');const marker=path.join(dir,'closed');
    await writeFile(script,`import {runWebServer} from ${JSON.stringify(serverUrl)};import {writeFileSync} from 'node:fs';process.on('message',m=>{if(m?.type==='shutdown')process.send({shutdownObserved:true});});process.on('disconnect',()=>console.log('launcher-disconnected'));await runWebServer({port:0,dataDir:${JSON.stringify(path.join(dir,'data'))},nextApp:{prepare:async()=>{process.send({preparing:true});await new Promise(resolve=>process.stdin.once('data',()=>{process.stdin.pause();resolve();}));},getRequestHandler:()=>((req,res)=>res.end('page')),close:async()=>writeFileSync(${JSON.stringify(marker)},'closed')}});console.log('startup-returned');`);
    const child=fork(script,[],{windowsHide:true,stdio:['pipe','pipe','pipe','ipc']});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
    const exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
    t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){if(child.connected)child.send({type:'shutdown'});else child.kill();await exit;}await rm(dir,{recursive:true,force:true});});
    const ready=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('exit',code=>reject(new Error('Startup child exited early: '+code+' '+output)));});assert.equal(ready.preparing,true);
    if(action==='shutdown') {const observed=new Promise(resolve=>child.once('message',resolve));child.send({type:'shutdown'});assert.equal((await observed).shutdownObserved,true);}
    else {const observed=new Promise(resolve=>child.stdout.on('data',()=>{if(output.includes('launcher-disconnected'))resolve();}));child.disconnect();await observed;}
    const returned=new Promise(resolve=>child.stdout.on('data',()=>{if(output.includes('startup-returned'))resolve();}));child.stdin.end('release preparation');await returned;
    assert.equal(await readFile(marker,'utf8').catch(()=>null),'closed');
    const result=await exit;assert.deepEqual(result,{code:0,signal:null});assert.ok(!output.includes('VietSub Studio:'));
});
