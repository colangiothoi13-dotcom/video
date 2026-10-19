import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createApi} from '../lib/api.mjs';
import {createStore} from '../lib/store.mjs';
import * as provider from '../lib/scene-provider.mjs';
import {toolPaths,probeVideo} from '../lib/media.mjs';
import {runProcess} from '../lib/process.mjs';

const brief={idea:'Video cô gái giới thiệu thời trang trong quán cafe hiện đại',character:'Linh, phụ nữ trưởng thành, tóc đen ngang vai, đeo khuyên tai bạc nhỏ.',product:'Bộ trang phục gồm áo blazer linen màu be, áo trắng và quần âu màu kem, giữ nguyên kiểu dáng.',style:'Cinematic thời trang, ánh sáng cửa sổ dịu, không khí quán café hiện đại',aspectRatio:'16:9',references:[]};
function scriptResponse(){
  const descriptions=[['Cận chất vải','Cận tay áo blazer linen trên bàn café.','Máy quay lướt trên bề mặt vải màu be.'],['Linh bước vào quán','Linh bước qua cửa kính quán café.','Toàn thân với blazer be và quần kem.'],['Trải nghiệm trang phục','Linh ngồi cạnh cửa sổ và nhẹ nhàng xoay người.','Góc nghiêng thấy độ rủ tự nhiên của bộ trang phục.'],['Chi tiết hoàn thiện','Linh chỉnh cổ tay áo và chỉ đường may.','Cận đường may, khuy áo và chất vải.'],['Khung hình kết','Linh đứng cạnh cửa sổ nhìn máy quay.','Toàn cảnh bộ trang phục trong không gian café.']];
  return {title:'Một buổi sáng, một phong cách',scenes:descriptions.map(([title,action,visual],i)=>({title,action,visual,durationSeconds:4,setting:'Quán café hiện đại với bàn gỗ và cửa kính lớn',cameraAngle:i===0||i===3?'macro close-up':'eye-level medium shot',cameraMovement:'slow stabilized dolly',lighting:'soft window light',texture:'natural linen weave and realistic skin',cinematic:'editorial fashion commercial, warm neutral colors',audio:'quiet café ambience and soft instrumental piano, no spoken dialogue'}))};
}
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const closeServer=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});

test('café fashion idea runs through script, real clips, preview, regenerate and persisted history',{timeout:60000},async t=>{
  const dataDir=await mkdtemp(path.join(tmpdir(),'scene-flow-'));const clip=path.join(dataDir,'fixture.mp4');
  await runProcess(toolPaths.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-f','lavfi','-i','color=c=beige:s=128x72:r=24:d=0.25','-f','lavfi','-i','sine=frequency=330:sample_rate=48000:duration=0.25','-c:v','libx264','-c:a','aac','-shortest','-y',clip]);
  const clipBytes=await readFile(clip),failures=[],starts=[];let googleBase,scriptCalls=0,downloads=0;
  const google=http.createServer(async(req,res)=>{
    try{
      assert.equal(req.headers['x-goog-api-key'],'fixture-local-only');
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=chunks.length?JSON.parse(Buffer.concat(chunks)):undefined;
      res.setHeader('content-type','application/json');
      if(req.url.endsWith(':generateContent')){
        scriptCalls++;assert.ok(body.contents[0].parts[0].text.includes(brief.idea));
        res.end(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(scriptResponse())}]}}]}));return;
      }
      if(req.url.endsWith(':predictLongRunning')){
        starts.push(body);res.end(JSON.stringify({name:`models/veo-3.1-generate-preview/operations/op-${starts.length}`}));return;
      }
      const operation=/\/operations\/(op-\d+)$/.exec(req.url);
      if(operation){res.end(JSON.stringify({done:true,response:{generateVideoResponse:{generatedSamples:[{video:{uri:`${googleBase}/files/${operation[1]}:download?alt=media`}}]}}}));return;}
      if(req.url.includes(':download?alt=media')){downloads++;res.setHeader('content-type','video/mp4');res.end(clipBytes);return;}
      res.writeHead(404);res.end('{}');
    }catch(error){failures.push(error);res.writeHead(500);res.end('{}');}
  });
  await listen(google);googleBase=`http://127.0.0.1:${google.address().port}/v1beta`;
  const adapter={};for(const name of ['generateSceneScript','startSceneVideo','pollSceneVideo','downloadSceneVideo'])adapter[name]=(...args)=>{const options=args.pop();return provider[name](...args,{...options,apiBase:googleBase});};
  adapter.assembleSceneVideos=provider.assembleSceneVideos;
  let appServer,api,store,base;
  async function open(){
    store=createStore(path.join(dataDir,'jobs.sqlite'));api=createApi({store,dataDir,config:{readConfig:()=>({apiKey:'fixture-local-only',translationModel:'gemini-3.5-flash-lite'})},tools:{sceneProvider:adapter,pollIntervalMs:0}});
    const app=express();app.use('/api',api);appServer=http.createServer(app);await listen(appServer);base=`http://127.0.0.1:${appServer.address().port}`;
  }
  async function close(){await api?.close();if(appServer?.listening)await closeServer(appServer);store?.close();api=null;appServer=null;store=null;}
  t.after(async()=>{await close();await closeServer(google);await rm(dataDir,{recursive:true,force:true});assert.deepEqual(failures,[]);});
  await open();
  const call=async(route,method='GET',body)=>{
    const response=await fetch(`${base}/api/studio${route}`,{method,headers:{origin:base,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    assert.ok(response.ok,`${method} ${route}: ${response.status} ${response.ok?'':await response.clone().text()}`);return response;
  };
  const get=async id=>(await (await call(`/projects/${id}`)).json()).project;
  const settle=async(id,predicate)=>{
    for(let attempt=0;attempt<200;attempt++){const value=await get(id);if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.fail('The fixture workflow did not complete');
  };
  let project=(await (await call('/projects','POST',brief)).json()).project;
  assert.equal(project.scenes.length,5);assert.equal(scriptCalls,1);
  for(const scene of project.scenes){assert.ok(scene.effectivePrompt.includes(brief.character));assert.ok(scene.effectivePrompt.includes(brief.product));for(const dimension of ['Góc máy:','Chuyển động máy:','Ánh sáng:','Chất liệu:','Cinematic:','Âm thanh:'])assert.ok(scene.prompt.includes(dimension));}
  await call(`/projects/${project.id}/generate-all`,'POST',{render:true});
  project=await settle(project.id,p=>p.assembly.status==='completed');assert.equal(starts.length,5);assert.equal(downloads,5);
  const scene=project.scenes[2];assert.equal(scene.history.length,1);const first=scene.history[0];assert.equal(first.status,'completed');assert.ok(first.effectivePrompt.includes(brief.product));
  const video=await call(`/projects/${project.id}/files/video`);const output=Buffer.from(await video.arrayBuffer());assert.equal(output.toString('ascii',4,8),'ftyp');
  const preview=await fetch(`${base}${first.videoUrl}`,{headers:{range:'bytes=0-15'}});assert.equal(preview.status,206);assert.equal(Buffer.from(await preview.arrayBuffer()).toString('ascii',4,8),'ftyp');
  const untouched=project.scenes.filter(s=>s.id!=='scene-3').map(s=>({id:s.id,prompt:s.prompt,videoUrl:s.videoUrl,version:s.version}));
  const changedPrompt=scene.prompt+'\nChuyển động bổ sung: máy quay đi vòng chậm quanh Linh, vẫn giữ cùng bộ trang phục.';
  project=(await (await call(`/projects/${project.id}/scenes/scene-3`,'PUT',{version:scene.version,prompt:changedPrompt,durationSeconds:4})).json()).project;
  await call(`/projects/${project.id}/scenes/scene-3/generate`,'POST',{version:project.scenes[2].version});
  project=await settle(project.id,p=>p.scenes[2].status==='completed');
  assert.equal(starts.length,6);assert.equal(project.scenes[2].history.length,2);assert.equal(project.scenes[2].history[0].prompt,changedPrompt);assert.equal(project.scenes[2].history[1].prompt,scene.prompt);
  assert.deepEqual(project.scenes.filter(s=>s.id!=='scene-3').map(s=>({id:s.id,prompt:s.prompt,videoUrl:s.videoUrl,version:s.version})),untouched);
  await close();await open();project=await get(project.id);
  assert.equal(project.scenes[2].history.length,2);const historical=await fetch(`${base}${first.videoUrl}`);assert.equal(historical.status,200);assert.deepEqual(Buffer.from(await historical.arrayBuffer()),clipBytes);
  const otherScene=await fetch(`${base}/api/studio/projects/${project.id}/files/scene-1?generation=${first.id}`);assert.equal(otherScene.status,404);
  await call(`/projects/${project.id}/render`,'POST',{});project=await settle(project.id,p=>p.assembly.status==='completed');assert.equal(starts.length,6,'assembly must not buy more generated clips');
  assert.equal((await probeVideo(clip)).hasAudio,true);assert.equal(scriptCalls,1);assert.deepEqual(failures,[]);
});
