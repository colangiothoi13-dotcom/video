import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm,mkdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createSceneApi} from '../lib/scene-api.mjs';
import {createSceneStore} from '../lib/scene-store.mjs';

const brief={idea:'Một ngày năng động cùng bình nước',character:'Linh, tóc đen ngang vai, áo khoác xanh',product:'Bình nước thép trắng, nắp xanh, logo M',style:'Ánh sáng tự nhiên',aspectRatio:'9:16'};
const script={title:'Mang theo năng lượng',scenes:Array.from({length:5},(_,i)=>({id:`scene-${i+1}`,title:['Cận sản phẩm','Nhân vật xuất hiện','Trải nghiệm','Cận chi tiết','Kết thúc'][i],durationSeconds:4,action:`Hành động ${i+1}`,visual:`Hình ảnh ${i+1}`,prompt:`Character, action, setting, camera angle, camera movement, lighting, material, cinematic style and audio for scene ${i+1}.`}))};

test('OpenAI can write scripts without a Google key, but video requests require separate Google credentials',async t=>{
  const f=await fixture(t,{config:{provider:'openai',apiKey:'sk-proj-script-fixture',translationModel:'gpt-5.4-mini',videoApiKey:''}});
  const project=await f.create();
  assert.equal(f.calls.scripts[0].options.provider,'openai');assert.equal(f.calls.scripts[0].options.apiKey,'sk-proj-script-fixture');
  const listing=await(await f.call()).json();assert.equal(listing.configured,true);assert.equal(listing.videoConfigured,false);
  const response=await f.call(`/projects/${project.id}/scenes/scene-1/generate`,{method:'POST',body:{version:1}});
  assert.equal(response.status,400);assert.equal((await response.json()).error.code,'AI_VIDEO_NOT_CONFIGURED');assert.equal(f.calls.starts.length,0);
});

test('video start and polling use the Google key while scripts use OpenAI',async t=>{
  const f=await fixture(t,{config:{provider:'openai',apiKey:'sk-proj-script-fixture',translationModel:'gpt-5.4-mini',videoApiKey:'AIza-veo-fixture'}});
  const project=await f.create();
  const response=await f.call(`/projects/${project.id}/scenes/scene-1/generate`,{method:'POST',body:{version:1}});
  assert.equal(response.status,202);await f.until(project.id,current=>current.scenes[0].status==='generating');
  assert.equal(f.calls.starts[0].options.apiKey,'AIza-veo-fixture');
  await f.get(project.id);assert.ok(f.calls.polls.length>0);assert.ok(f.calls.polls.every(call=>call.options.apiKey==='AIza-veo-fixture'));
});

async function fixture(t,{sceneProvider={},tools={},config={apiKey:'private-api-key',translationModel:'gemini-test'}}={}) {
  const dataDir=await mkdtemp(path.join(tmpdir(),'scene-api-'));const calls={scripts:[],starts:[],polls:[],downloads:[],assemblies:[]};let ready=false;
  const provider={
    generateSceneScript:async(input,options)=>{calls.scripts.push({input,options});return structuredClone(script);},
    startSceneVideo:async(input,options)=>{calls.starts.push({input,options});return {operationName:`models/veo/operations/private-${calls.starts.length}`};},
    pollSceneVideo:async(name,options)=>{calls.polls.push({name,options});return ready?{done:true,videoUri:'https://provider.invalid/private-video'}:{done:false};},
    downloadSceneVideo:async(uri,destination)=>{calls.downloads.push({uri,destination});await writeFile(destination,'scene-video');return {path:destination,size:11};},
    assembleSceneVideos:async(files,destination)=>{calls.assemblies.push(files);await writeFile(destination,'assembled-video');return {path:destination,duration:20};},
    ...sceneProvider,
  };
  let router,server,base;
  async function open() {router=createSceneApi({dataDir,readConfig:()=>config,tools:{sceneProvider:provider,pollIntervalMs:0,...tools}});const app=express();app.use(express.json({limit:'1mb'}));app.use('/api/studio',router);server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}/api/studio`;}
  async function close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await router.close();}
  await open();t.after(async()=>{await close();await rm(dataDir,{recursive:true,force:true});});
  const call=(route='',init={})=>fetch(base+route,{...init,headers:{'content-type':'application/json',...init.headers},...(init.body?{body:JSON.stringify(init.body)}:{})});
  const create=async(body=brief)=>{const response=await call('/projects',{method:'POST',body});assert.equal(response.status,201,await response.clone().text());return (await response.json()).project;};
  const get=async id=>(await (await call(`/projects/${id}`)).json()).project;
  async function until(id,predicate){for(let i=0;i<100;i++){const project=await get(id);if(predicate(project))return project;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('scene state did not settle');}
  return {dataDir,calls,call,create,get,until,ready:()=>{ready=true;},shutdown:()=>router.close(),reopen:async()=>{await close();await open();}};
}

test('script projects persist the five scenes and locked identity without disclosing private data',async t=>{
  const f=await fixture(t);const project=await f.create();
  assert.equal(project.scenes.length,5);assert.deepEqual(project.scenes.map(s=>s.id),['scene-1','scene-2','scene-3','scene-4','scene-5']);
  assert.equal(project.identity.character,brief.character);assert.equal(project.identity.product,brief.product);
  assert.ok(project.scenes.every(scene=>scene.effectivePrompt.includes(brief.character)&&scene.effectivePrompt.includes(brief.product)));
  assert.doesNotMatch(JSON.stringify(project),/private-api-key|operationName|references|artifactPath|dataDir/);
  await f.reopen();assert.equal((await f.get(project.id)).scenes[4].prompt,script.scenes[4].prompt);
  const listing=await (await f.call()).json();assert.equal(listing.projects[0].id,project.id);assert.equal(listing.configured,true);assert.match(listing.videoModel,/^veo-/);
});

test('brief and reference validation reject unexpected fields or disguised/oversized images before inference',async t=>{
  const f=await fixture(t);const png=Buffer.from([137,80,78,71,13,10,26,10,0]).toString('base64');
  for(const body of [{...brief,character:''},{...brief,style:17},{...brief,apiKey:'secret'},{...brief,references:[{kind:'product',mimeType:'image/png',data:'aGVsbG8='}]},{...brief,references:[{kind:'product',mimeType:'image/png',data:png+'\n'}]},{...brief,references:[{kind:'product',mimeType:'image/png',data:Buffer.alloc(262145).toString('base64')}]}]) {
    assert.equal((await f.call('/projects',{method:'POST',body})).status,400);
  }
  assert.equal(f.calls.scripts.length,0);
  const project=await f.create({...brief,references:[{kind:'product',mimeType:'image/png',data:png}]});
  assert.equal(project.identity.referenceCount,1);assert.ok(project.scenes.every(s=>s.durationSeconds===8));assert.doesNotMatch(JSON.stringify(project),new RegExp(png));
});

test('general stories accept an omitted or blank product and preserve the empty identity after reopening',async t=>{
  const f=await fixture(t);const {product,...story}=brief;
  for(const body of [{...story},{...story,product:''},{...story,product:'   '}]) {
    const project=await f.create(body);
    assert.equal(project.identity.product,'');assert.equal(f.calls.scripts.at(-1).input.product,'');
    await f.reopen();assert.equal((await f.get(project.id)).identity.product,'');
    const store=createSceneStore(path.join(f.dataDir,'scenes.sqlite'));
    try{assert.equal(store.get(project.id).identity.product,'');}finally{store.close();}
  }
});

test('story prompts preserve each character only when present and omit absent product and advertising demands',async t=>{
  const f=await fixture(t);const project=await f.create({...brief,character:'Lan: black hair, blue coat. Minh: curly hair, red coat.',product:'',style:''});
  assert.equal(project.identity.style,'Cinematic storytelling');
  for(const scene of project.scenes) {
    assert.match(scene.effectivePrompt,/Lan: black hair, blue coat\. Minh: curly hair, red coat\./);
    assert.match(scene.effectivePrompt,/each character.*when.*appears/i);
    assert.match(scene.effectivePrompt,/only.*characters.*scene/i);
    assert.doesNotMatch(scene.effectivePrompt,/PRODUCT:|product shape|logo|commercial|advertis|identical in every scene/i);
  }
});

test('three labeled character images retain order, identities and bytes across script, storage and video submission',async t=>{
  const f=await fixture(t);const references=[
    {kind:'character',label:'  Lan  ',mimeType:'image/png',data:Buffer.from([137,80,78,71,13,10,26,10,1]).toString('base64')},
    {kind:'character',label:'Minh',mimeType:'image/jpeg',data:Buffer.from([255,216,255,2]).toString('base64')},
    {kind:'character',label:'Mai',mimeType:'image/png',data:Buffer.from([137,80,78,71,13,10,26,10,3]).toString('base64')},
  ];
  const expected=[{...references[0],label:'Lan'},references[1],references[2]];
  const project=await f.create({...brief,product:'',references});
  assert.equal(project.identity.referenceCount,3);assert.deepEqual(f.calls.scripts[0].input.references,expected);
  assert.match(project.scenes[0].effectivePrompt,/Reference image 1: character — Lan\nReference image 2: character — Minh\nReference image 3: character — Mai/);
  assert.ok(project.scenes.every(scene=>scene.durationSeconds===8));
  assert.doesNotMatch(JSON.stringify(project),new RegExp(references[0].data));
  await f.reopen();const store=createSceneStore(path.join(f.dataDir,'scenes.sqlite'));
  try{assert.deepEqual(store.get(project.id).references,expected);}finally{store.close();}
  assert.equal((await f.call(`/projects/${project.id}/scenes/scene-1/generate`,{method:'POST',body:{version:1}})).status,202);
  await f.until(project.id,current=>current.scenes[0].status==='generating');
  assert.deepEqual(f.calls.starts[0].input.references,expected);
  assert.match(f.calls.starts[0].input.prompt,/Reference image 2: character — Minh/);
});

test('a fourth reference, a second product and invalid labels are rejected before inference or paid video submission',async t=>{
  const f=await fixture(t);const image={kind:'character',mimeType:'image/png',data:Buffer.from([137,80,78,71,13,10,26,10,1]).toString('base64')};
  for(const references of [[image,image,image,image],[{...image,kind:'product'},{...image,kind:'product'}],[{...image,label:17}],[{...image,label:'x'.repeat(101)}],[{...image,label:'bad\0label'}]]) {
    const response=await f.call('/projects',{method:'POST',body:{...brief,references}});
    assert.equal(response.status,400);assert.equal((await response.json()).error.code,'SCENE_INVALID');
  }
  assert.equal(f.calls.scripts.length,0);assert.equal(f.calls.starts.length,0);
});

test('legacy unlabeled references keep their shape and existing history snapshots when reopened',async t=>{
  const f=await fixture(t);const references=[
    {kind:'character',mimeType:'image/png',data:Buffer.from([137,80,78,71,13,10,26,10,1]).toString('base64')},
    {kind:'product',mimeType:'image/jpeg',data:Buffer.from([255,216,255,2]).toString('base64')},
  ];
  const project=await f.create({...brief,references});
  assert.deepEqual(f.calls.scripts[0].input.references,references);
  const entry={id:'92748349-cb18-4440-a6ae-21c451fd8c27',version:1,createdAt:'2026-10-18T00:00:00.000Z',completedAt:'2026-10-18T00:00:01.000Z',status:'failed',prompt:'Legacy user prompt',effectivePrompt:'Legacy locked character and product prompt',durationSeconds:8,error:{code:'AI_CONTENT_BLOCKED',message:'Safe historical error'}};
  const store=createSceneStore(path.join(f.dataDir,'scenes.sqlite'));
  try{store.mutate(project.id,current=>{current.scenes[0].history=[entry];});}finally{store.close();}
  await f.reopen();const reopened=await f.get(project.id);
  assert.match(reopened.scenes[0].effectivePrompt,/Reference image 1: character — Character 1\nReference image 2: product — Product/);
  assert.equal(reopened.identity.product,brief.product);assert.equal(reopened.scenes[0].history[0].effectivePrompt,entry.effectivePrompt);assert.equal(reopened.scenes[0].history[0].prompt,entry.prompt);assert.equal(reopened.scenes[0].history[0].id,entry.id);
  const reopenedStore=createSceneStore(path.join(f.dataDir,'scenes.sqlite'));
  try{assert.deepEqual(reopenedStore.get(project.id).references,references);assert.deepEqual(reopenedStore.get(project.id).scenes[0].history,[entry]);}finally{reopenedStore.close();}
});

test('blank reference labels normalize to the compatible unlabeled reference shape',async t=>{
  const f=await fixture(t);const image={kind:'character',mimeType:'image/png',data:Buffer.from([137,80,78,71,13,10,26,10,1]).toString('base64')};
  const project=await f.create({...brief,references:[{...image,label:'   '}]});
  assert.deepEqual(f.calls.scripts[0].input.references,[image]);
  assert.match(project.scenes[0].effectivePrompt,/Reference image 1: character — Character 1/);
});

test('missing credentials and provider diagnostics produce only safe errors',async t=>{
  const missing=await fixture(t,{config:{}});assert.equal((await missing.call('/projects',{method:'POST',body:brief})).status,400);assert.equal(missing.calls.scripts.length,0);
  const f=await fixture(t,{sceneProvider:{generateSceneScript:async()=>{throw Object.assign(new Error('private-api-key D:\\private provider diagnostics'),{code:'AI_AUTH'});}}});
  const response=await f.call('/projects',{method:'POST',body:brief});assert.equal(response.status,400);assert.doesNotMatch(await response.text(),/private-api-key|diagnostics|D:\\/);
});

test('scene edits isolate versions, reject identity patches and block unsaved generation',async t=>{
  const f=await fixture(t);const project=await f.create();const route=`/projects/${project.id}/scenes/scene-2`;
  let response=await f.call(route,{method:'PUT',body:{version:1,prompt:'My independently edited camera and audio instructions',durationSeconds:6}});assert.equal(response.status,200);
  const saved=(await response.json()).project;assert.equal(saved.scenes[1].version,2);assert.equal(saved.scenes[0].version,1);assert.equal(saved.scenes[0].prompt,script.scenes[0].prompt);
  assert.equal((await f.call(route,{method:'PUT',body:{version:1,prompt:'stale',durationSeconds:4}})).status,409);
  assert.equal((await f.call(route,{method:'PUT',body:{version:2,prompt:'change',durationSeconds:4,character:'new'}})).status,400);
  assert.equal((await f.call(route+'/generate',{method:'POST',body:{version:1}})).status,409);assert.equal(f.calls.starts.length,0);
});

test('duplicate paid starts are fenced and running scene edits/deletion are refused',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{sceneProvider:{startSceneVideo:async()=>{await gate;return {operationName:'models/veo/operations/delayed'};}}});const project=await f.create();const route=`/projects/${project.id}/scenes/scene-1`;
  assert.equal((await f.call(route+'/generate',{method:'POST',body:{version:1}})).status,202);
  assert.equal((await f.call(route+'/generate',{method:'POST',body:{version:1}})).status,409);
  assert.equal((await f.call(route,{method:'PUT',body:{version:1,prompt:'changed',durationSeconds:4}})).status,409);
  assert.equal((await f.call(`/projects/${project.id}`,{method:'DELETE'})).status,409);
  release();await f.until(project.id,p=>p.scenes[0].status==='generating');
});

test('pending operations resume after reopening without repeating billed creation',async t=>{
  const f=await fixture(t);const project=await f.create();await f.call(`/projects/${project.id}/scenes/scene-1/generate`,{method:'POST',body:{version:1}});
  await f.until(project.id,p=>p.scenes[0].status==='generating');assert.equal(f.calls.starts.length,1);await f.reopen();f.ready();
  const completed=await f.until(project.id,p=>p.scenes[0].status==='completed');assert.equal(f.calls.starts.length,1);assert.equal(f.calls.downloads.length,1);assert.match(completed.scenes[0].videoUrl,/scene-1/);
  assert.doesNotMatch(JSON.stringify(completed),/private-video|operations\/|destination|api-key/);
});

test('Generate All preserves completed clips and assembles only after all current revisions exist',async t=>{
  const f=await fixture(t);const project=await f.create();await f.call(`/projects/${project.id}/scenes/scene-1/generate`,{method:'POST',body:{version:1}});await f.until(project.id,p=>p.scenes[0].status==='generating');f.ready();await f.until(project.id,p=>p.scenes[0].status==='completed');
  const response=await f.call(`/projects/${project.id}/generate-all`,{method:'POST',body:{render:true}});assert.equal(response.status,202);
  const completed=await f.until(project.id,p=>p.assembly.status==='completed');assert.ok(completed.scenes.every(s=>s.status==='completed'));assert.equal(f.calls.starts.length,5);assert.equal(f.calls.assemblies.length,1);
  const video=await f.call(`/projects/${project.id}/files/video`);assert.equal(video.status,200);assert.equal(await video.text(),'assembled-video');
  const scene=await f.call(`/projects/${project.id}/files/scene-1`,{headers:{range:'bytes=0-4'}});assert.equal(scene.status,206);assert.equal(await scene.text(),'scene');
  const saved=await f.call(`/projects/${project.id}/scenes/scene-2`,{method:'PUT',body:{version:1,prompt:'New light and camera instructions',durationSeconds:6}});assert.equal(saved.status,200);
  const updated=(await saved.json()).project;assert.equal(updated.scenes[1].stale,true);assert.equal(updated.assembly.status,'idle');assert.equal(updated.assembly.videoUrl,undefined);assert.equal((await f.call(`/projects/${project.id}/files/video`)).status,404);
  assert.equal((await f.call(`/projects/${project.id}/render`,{method:'POST',body:{}})).status,409);
});

test('one failed scene preserves successful clips and retries only after explicit action',async t=>{
  let submissions=0;const f=await fixture(t,{sceneProvider:{startSceneVideo:async()=>{submissions++;if(submissions===2)throw Object.assign(new Error('private-api-key provider secret'),{code:'AI_QUOTA'});return {operationName:`models/veo/operations/safe-${submissions}`};}}});const project=await f.create();f.ready();
  await f.call(`/projects/${project.id}/generate-all`,{method:'POST',body:{}});const failed=await f.until(project.id,p=>p.scenes.every(s=>['failed','completed'].includes(s.status)));
  assert.equal(failed.scenes.filter(s=>s.status==='completed').length,4);assert.equal(failed.scenes[1].status,'failed');assert.doesNotMatch(JSON.stringify(failed),/private-api-key|provider secret/);
  await f.get(project.id);assert.equal(submissions,5);await f.call(`/projects/${project.id}/generate-all`,{method:'POST',body:{}});await f.until(project.id,p=>p.scenes.every(s=>s.status==='completed'));assert.equal(submissions,6);
  assert.equal((await f.call(`/projects/${project.id}`,{method:'DELETE'})).status,200);assert.equal((await f.call(`/projects/${project.id}`)).status,404);
});

test('poll intervals persist and prevent duplicated provider polling on overlapping reads',async t=>{
  const f=await fixture(t,{tools:{pollIntervalMs:10000}});const project=await f.create();await f.call(`/projects/${project.id}/scenes/scene-1/generate`,{method:'POST',body:{version:1}});await f.until(project.id,p=>p.scenes[0].status==='generating');
  await Promise.all(Array.from({length:5},()=>f.get(project.id)));assert.equal(f.calls.polls.length,1);await f.reopen();await f.get(project.id);assert.equal(f.calls.polls.length,1);
});

test('a failed download retains the paid operation and retries its result without another creation',async t=>{
  let attempts=0;const f=await fixture(t,{sceneProvider:{downloadSceneVideo:async(_,destination)=>{if(++attempts===1)throw Object.assign(new Error('private download URL'),{code:'AI_DOWNLOAD'});await writeFile(destination,'recovered-video');}}});const project=await f.create();f.ready();
  await f.call(`/projects/${project.id}/scenes/scene-1/generate`,{method:'POST',body:{version:1}});
  await f.until(project.id,p=>p.scenes[0].error?.code==='AI_DOWNLOAD');const recovered=await f.until(project.id,p=>p.scenes[0].status==='completed');
  assert.equal(attempts,2);assert.equal(f.calls.starts.length,1);assert.equal(recovered.scenes[0].error,null);
});

test('interrupted starts and assembly are recovered without automatic billed resubmission',async t=>{
  const f=await fixture(t);const project=await f.create();const store=createSceneStore(path.join(f.dataDir,'scenes.sqlite'));
  store.mutate(project.id,p=>{p.scenes[0].status='starting';p.scenes[0].operation={name:null,version:1,token:'interrupted'};p.assembly.status='rendering';p.assembly.token='old-instance';p.renderRequested=true;});store.close();
  await f.reopen();const recovered=await f.get(project.id);assert.equal(recovered.scenes[0].status,'failed');assert.equal(recovered.scenes[0].error.code,'SCENE_INTERRUPTED');assert.equal(recovered.assembly.status,'failed');assert.equal(f.calls.starts.length,0);assert.equal(f.calls.assemblies.length,0);
});

test('ambiguous paid creation failures stay failed until an explicit user generation action',async t=>{
  let attempts=0;const f=await fixture(t,{sceneProvider:{startSceneVideo:async()=>{attempts++;throw Object.assign(new Error('private timeout diagnostic'),{code:'AI_CONNECTION'});}}});const project=await f.create();
  await f.call(`/projects/${project.id}/scenes/scene-1/generate`,{method:'POST',body:{version:1}});const failed=await f.until(project.id,p=>p.scenes[0].status==='failed');assert.equal(failed.scenes[0].error.code,'SCENE_INTERRUPTED');
  await f.reopen();await f.get(project.id);assert.equal(attempts,1);assert.doesNotMatch(JSON.stringify(failed),/private timeout/);
});

test('artifact routes refuse another project and non-video private files even with a stored pointer',async t=>{
  const f=await fixture(t);const first=await f.create();const second=await f.create();await mkdir(path.join(f.dataDir,'studio',first.id),{recursive:true});const otherRoot=path.join(f.dataDir,'studio',second.id);await mkdir(otherRoot,{recursive:true});const foreign=path.join(otherRoot,'secret.mp4');await writeFile(foreign,'other project content');
  const store=createSceneStore(path.join(f.dataDir,'scenes.sqlite'));store.mutate(first.id,p=>{p.scenes[0].artifact={path:foreign,version:1,token:'foreign'};p.scenes[0].status='completed';});
  assert.equal((await f.call(`/projects/${first.id}/files/scene-1`)).status,404);assert.equal((await f.call(`/projects/${first.id}/files/config.json`)).status,404);store.close();
});

test('project update timestamps strictly increase even when multiple scene revisions save in one millisecond',t=>{
  t.mock.timers.enable({apis:['Date'],now:1000});const store=createSceneStore(':memory:');t.after(()=>store.close());
  const project=store.create({...brief,references:[]},script);const first=store.mutate(project.id,p=>{p.scenes[0].version++;});const second=store.mutate(project.id,p=>{p.scenes[1].version++;});
  assert.ok(Date.parse(first.updatedAt)>Date.parse(project.updatedAt));assert.ok(Date.parse(second.updatedAt)>Date.parse(first.updatedAt));
});

test('shutdown aborts and awaits in-flight polling while keeping its durable operation resumable',async t=>{
  let entered;const polling=new Promise(resolve=>{entered=resolve;});let settled=false;
  const f=await fixture(t,{sceneProvider:{pollSceneVideo:async(_,options)=>{entered();return new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>{settled=true;reject(options.signal.reason);},{once:true});});}}});const project=await f.create();
  await f.call(`/projects/${project.id}/scenes/scene-1/generate`,{method:'POST',body:{version:1}});const request=f.get(project.id);await polling;await f.shutdown();await request;assert.equal(settled,true);
  const store=createSceneStore(path.join(f.dataDir,'scenes.sqlite'));const saved=store.get(project.id);assert.equal(saved.scenes[0].status,'generating');assert.ok(saved.scenes[0].operation.name);store.close();
});

test('a failed same-revision regeneration keeps the previous clip but remains missing for Generate All and assembly',async t=>{
  let attempts=0;const f=await fixture(t,{sceneProvider:{startSceneVideo:async()=>{attempts++;if(attempts===6)throw Object.assign(new Error('denied recreation'),{code:'AI_CONTENT_BLOCKED'});return {operationName:`models/veo/operations/revision-${attempts}`};}}});const project=await f.create();f.ready();
  await f.call(`/projects/${project.id}/generate-all`,{method:'POST',body:{render:true}});const assembled=await f.until(project.id,p=>p.assembly.status==='completed');const previousUrl=assembled.scenes[0].videoUrl;
  await f.call(`/projects/${project.id}/scenes/scene-1/generate`,{method:'POST',body:{version:1}});const failed=await f.until(project.id,p=>p.scenes[0].status==='failed');assert.equal(failed.scenes[0].videoUrl,previousUrl);assert.equal(failed.scenes[0].stale,true);
  assert.equal((await f.call(`/projects/${project.id}/render`,{method:'POST',body:{}})).status,409);assert.equal((await f.call(`/projects/${project.id}/files/video`)).status,404);
  await f.call(`/projects/${project.id}/generate-all`,{method:'POST',body:{}});await f.until(project.id,p=>p.scenes.every(s=>s.status==='completed'));assert.equal(attempts,7);
});

test('expired provider operations fail only their scene and release editing, explicit regeneration and project deletion',async t=>{
  const f=await fixture(t,{sceneProvider:{pollSceneVideo:async()=>{throw Object.assign(new Error('private expired Google operation'),{code:'AI_OPERATION_EXPIRED'});}}});const project=await f.create();const route=`/projects/${project.id}/scenes/scene-1`;
  await f.call(route+'/generate',{method:'POST',body:{version:1}});const failed=await f.until(project.id,p=>p.scenes[0].status==='failed');
  assert.equal(failed.scenes[0].error.code,'AI_OPERATION_EXPIRED');assert.doesNotMatch(failed.scenes[0].error.message,/private expired/);assert.ok(failed.scenes.slice(1).every(scene=>scene.status==='draft'&&scene.version===1));
  assert.equal((await f.call(route,{method:'PUT',body:{version:1,prompt:'Updated camera and audio directions',durationSeconds:6}})).status,200);
  assert.equal((await f.call(route+'/generate',{method:'POST',body:{version:2}})).status,202);await f.until(project.id,p=>p.scenes[0].status==='failed');assert.equal(f.calls.starts.length,2);
  assert.equal((await f.call(`/projects/${project.id}`,{method:'DELETE'})).status,200);
});

test('generation history keeps immutable prompt and duration snapshots and both videos after reopening',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});let starts=0,downloads=0;
  const f=await fixture(t,{sceneProvider:{startSceneVideo:async()=>{if(++starts===1)await gate;return {operationName:`models/veo/operations/history-${starts}`};},downloadSceneVideo:async(_,destination)=>{await writeFile(destination,`history-video-${++downloads}`);}}});
  const project=await f.create(),route=`/projects/${project.id}/scenes/scene-1`;
  assert.deepEqual(project.scenes[0].history,[]);
  const response=await f.call(route+'/generate',{method:'POST',body:{version:1}});const starting=(await response.json()).project.scenes[0];
  const duplicate=await f.call(route+'/generate',{method:'POST',body:{version:1}});release();
  assert.equal(response.status,202);assert.equal(starting.history.length,1);assert.equal(starting.history[0].status,'starting');
  assert.match(starting.history[0].id,/^[0-9a-f]{8}-[0-9a-f-]{27}$/);assert.ok(Number.isFinite(Date.parse(starting.history[0].createdAt)));
  assert.equal(duplicate.status,409);
  const generating=await f.until(project.id,p=>p.scenes[0].status==='generating');assert.equal(generating.scenes[0].history[0].status,'generating');
  f.ready();const first=(await f.until(project.id,p=>p.scenes[0].status==='completed')).scenes[0];
  assert.equal(first.history.length,1);assert.equal(first.history[0].status,'completed');assert.ok(Number.isFinite(Date.parse(first.history[0].completedAt)));
  assert.equal(first.history[0].prompt,script.scenes[0].prompt);assert.equal(first.history[0].effectivePrompt,first.effectivePrompt);assert.equal(first.history[0].durationSeconds,4);assert.match(first.history[0].videoModel,/^veo-/);
  const editedPrompt='Second generation: slow camera, warm lighting, birdsong.';
  const edited=await f.call(route,{method:'PUT',body:{version:1,prompt:editedPrompt,durationSeconds:6}});assert.equal(edited.status,200);
  assert.deepEqual((await edited.json()).project.scenes[0].history,first.history);
  await f.call(route+'/generate',{method:'POST',body:{version:2}});await f.until(project.id,p=>p.scenes[0].status==='completed');await f.reopen();
  const saved=(await f.get(project.id)).scenes[0];assert.equal(saved.history.length,2);assert.equal(saved.history[0].prompt,editedPrompt);assert.equal(saved.history[0].durationSeconds,6);assert.equal(saved.history[0].version,2);assert.equal(saved.history[1].version,1);assert.deepEqual(saved.history[1],first.history[0]);
  assert.match(saved.history[0].effectivePrompt,/SCENE scene-1 \(6 seconds\):\nSecond generation/);
  for(const [entry,bytes] of [[saved.history[0],'history-video-2'],[saved.history[1],'history-video-1']]) {
    assert.equal(entry.videoUrl,`/api/studio/projects/${project.id}/files/scene-1?generation=${entry.id}`);
    const video=await f.call(entry.videoUrl.replace('/api/studio',''));assert.equal(video.status,200);assert.equal(await video.text(),bytes);
  }
  const originalLink=await f.call(first.videoUrl.replace('/api/studio',''));assert.equal(await originalLink.text(),'history-video-1');
  assert.equal((await f.call(route,{method:'PUT',body:{version:2,prompt:editedPrompt,durationSeconds:6,history:[]}})).status,400);
  assert.doesNotMatch(JSON.stringify(saved),/private-api-key|private-video|operations\/|"artifact"|"path"|"operation"|"token"/);
  assert.equal((await f.call(`/projects/${project.id}`,{method:'DELETE'})).status,200);
  await assert.rejects(stat(path.join(f.dataDir,'studio',project.id)),{code:'ENOENT'});
});

test('failed regeneration preserves the successful historical preview and records a safe terminal failure',async t=>{
  let starts=0;const f=await fixture(t,{sceneProvider:{startSceneVideo:async()=>{if(++starts===2)throw Object.assign(new Error('private-api-key provider failure diagnostics'),{code:'AI_CONTENT_BLOCKED'});return {operationName:'models/veo/operations/first-success'};}}});
  const project=await f.create(),route=`/projects/${project.id}/scenes/scene-1/generate`;f.ready();
  await f.call(route,{method:'POST',body:{version:1}});const first=(await f.until(project.id,p=>p.scenes[0].status==='completed')).scenes[0];
  await f.call(route,{method:'POST',body:{version:1}});const failed=(await f.until(project.id,p=>p.scenes[0].status==='failed')).scenes[0];
  assert.equal(failed.history.length,2);assert.equal(failed.history[0].status,'failed');assert.equal(failed.history[0].error.code,'AI_CONTENT_BLOCKED');assert.ok(failed.history[0].completedAt);assert.equal(failed.history[0].videoUrl,undefined);assert.deepEqual(failed.history[1],first.history[0]);assert.equal(failed.videoUrl,first.videoUrl);
  await f.reopen();assert.deepEqual((await f.get(project.id)).scenes[0].history,failed.history);
  const video=await f.call(failed.history[1].videoUrl.replace('/api/studio',''));assert.equal(await video.text(),'scene-video');assert.doesNotMatch(JSON.stringify(failed),/private-api-key|provider failure diagnostics/);
});

test('generation file lookups bind the attempt to its scene and project and reject foreign stored paths',async t=>{
  const f=await fixture(t),first=await f.create(),second=await f.create();f.ready();
  await f.call(`/projects/${first.id}/scenes/scene-1/generate`,{method:'POST',body:{version:1}});const completed=await f.until(first.id,p=>p.scenes[0].status==='completed');
  const id=completed.scenes[0].history[0].id;
  for(const route of [`/projects/${first.id}/files/scene-2?generation=${id}`,`/projects/${second.id}/files/scene-1?generation=${id}`,`/projects/${first.id}/files/video?generation=${id}`,`/projects/${first.id}/files/scene-1?generation=../private`, `/projects/${first.id}/files/scene-1?generation=${id}&generation=${id}`,`/projects/${first.id}/files/scene-1?v=unknown-token`,`/projects/${first.id}/files/scene-2?v=${id}`,`/projects/${second.id}/files/scene-1?v=${id}`])assert.equal((await f.call(route)).status,404,route);
  const otherRoot=path.join(f.dataDir,'studio',second.id);await mkdir(otherRoot,{recursive:true});const foreign=path.join(otherRoot,'private.mp4');await writeFile(foreign,'another project');
  const store=createSceneStore(path.join(f.dataDir,'scenes.sqlite'));store.mutate(first.id,p=>{p.scenes[0].history[0].artifact.path=foreign;});store.close();
  assert.equal((await f.call(`/projects/${first.id}/files/scene-1?generation=${id}`)).status,404);
});

test('interrupted starting attempts recover once as failed without fabricating legacy generation snapshots',async t=>{
  const f=await fixture(t),project=await f.create();const id='91748349-cb18-4440-a6ae-21c451fd8c27';
  const store=createSceneStore(path.join(f.dataDir,'scenes.sqlite'));store.mutate(project.id,p=>{const scene=p.scenes[0];scene.status='starting';scene.operation={name:null,version:1,token:id};scene.history=[{id,version:1,createdAt:'2026-10-18T00:00:00.000Z',status:'starting',prompt:scene.prompt,effectivePrompt:project.scenes[0].effectivePrompt,durationSeconds:4}];delete p.scenes[1].history;});store.close();
  await f.reopen();const recovered=(await f.get(project.id)).scenes[0];assert.equal(recovered.history.length,1);assert.equal(recovered.history[0].status,'failed');assert.equal(recovered.history[0].error.code,'SCENE_INTERRUPTED');assert.ok(recovered.history[0].completedAt);assert.equal(f.calls.starts.length,0);assert.deepEqual((await f.get(project.id)).scenes[1].history,[]);
  await f.reopen();assert.deepEqual((await f.get(project.id)).scenes[0].history,recovered.history);
});

test('transient polling and download failures keep one generating history entry until the same attempt succeeds',async t=>{
  let polls=0,downloads=0;const f=await fixture(t,{sceneProvider:{pollSceneVideo:async()=>{if(++polls===1)throw Object.assign(new Error('secret auth details'),{code:'AI_AUTH'});return {done:true,videoUri:'https://provider.invalid/private-video'};},downloadSceneVideo:async(_,destination)=>{if(++downloads===1)throw Object.assign(new Error('secret download details'),{code:'AI_DOWNLOAD'});await writeFile(destination,'retry-complete');}}});
  const project=await f.create();await f.call(`/projects/${project.id}/scenes/scene-1/generate`,{method:'POST',body:{version:1}});
  const auth=(await f.until(project.id,p=>p.scenes[0].error?.code==='AI_AUTH')).scenes[0];assert.equal(auth.history.length,1);assert.equal(auth.history[0].status,'generating');assert.equal(auth.history[0].error.code,'AI_AUTH');
  const download=(await f.until(project.id,p=>p.scenes[0].error?.code==='AI_DOWNLOAD')).scenes[0];assert.equal(download.history[0].id,auth.history[0].id);assert.equal(download.history[0].status,'generating');
  const completed=(await f.until(project.id,p=>p.scenes[0].status==='completed')).scenes[0];assert.equal(completed.history.length,1);assert.equal(completed.history[0].id,auth.history[0].id);assert.equal(completed.history[0].error,undefined);assert.equal(f.calls.starts.length,1);assert.doesNotMatch(JSON.stringify([auth,download,completed]),/secret auth|secret download|private-video/);
});

test('legacy artifacts retain their preview across future attempts without inventing old prompt snapshots',async t=>{
  const f=await fixture(t),project=await f.create();const directory=path.join(f.dataDir,'studio',project.id);await mkdir(directory,{recursive:true});const legacy=path.join(directory,'legacy.mp4');await writeFile(legacy,'legacy-video');
  const store=createSceneStore(path.join(f.dataDir,'scenes.sqlite'));store.mutate(project.id,p=>{const scene=p.scenes[0];delete scene.history;scene.artifact={path:legacy,version:1,token:'legacy-token'};scene.status='completed';});store.close();
  await f.reopen();const old=(await f.get(project.id)).scenes[0];assert.deepEqual(old.history,[]);assert.ok(old.videoUrl);assert.equal(await (await f.call(old.videoUrl.replace('/api/studio',''))).text(),'legacy-video');
  await f.call(`/projects/${project.id}/scenes/scene-1`,{method:'PUT',body:{version:1,prompt:'New known generation prompt',durationSeconds:6}});f.ready();await f.call(`/projects/${project.id}/scenes/scene-1/generate`,{method:'POST',body:{version:2}});const current=(await f.until(project.id,p=>p.scenes[0].status==='completed')).scenes[0];
  assert.equal(current.history.length,1);assert.equal(current.history[0].prompt,'New known generation prompt');assert.equal(current.legacyVideoUrl,old.videoUrl);assert.equal(await (await f.call(current.legacyVideoUrl.replace('/api/studio',''))).text(),'legacy-video');
  await f.reopen();assert.equal((await f.get(project.id)).scenes[0].legacyVideoUrl,old.videoUrl);
});
