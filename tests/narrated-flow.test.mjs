import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createApi} from '../lib/api.mjs';
import {createStore} from '../lib/store.mjs';
import * as narratedProvider from '../lib/narrated-provider.mjs';
import {toolPaths,probeVideo} from '../lib/media.mjs';
import {runProcess} from '../lib/process.mjs';

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const stop=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
const send=(res,value)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
const toolsReady=()=>({ffmpeg:{available:true,subtitles:true},ffprobe:{available:true},ytdlp:{available:true,ejs:true},font:{available:true}});

function tonePower(bytes,frequency,rate=16000){
  let real=0,imaginary=0;const length=Math.min(bytes.length/2,rate);
  for(let i=0;i<length;i++){const value=bytes.readInt16LE(i*2);const angle=2*Math.PI*frequency*i/rate;real+=value*Math.cos(angle);imaginary+=value*Math.sin(angle);}
  return real*real+imaginary*imaginary;
}

test('YouTube/Facebook narration workflow preserves original audio through generation, history, restart and independent regeneration',{timeout:120000},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'narrated-flow-'));
  const source=path.join(directory,'source-fixture.mp4'),generated=path.join(directory,'generated-fixture.mp4'),silent=path.join(directory,'silent-fixture.mp4');
  const ff=async args=>runProcess(toolPaths.ffmpeg,['-hide_banner','-loglevel','error','-nostdin',...args]);
  await ff(['-f','lavfi','-i','color=c=green:s=128x72:r=24:d=9.3','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=9.3','-c:v','libx264','-c:a','aac','-y',source]);
  await ff(['-f','lavfi','-i','color=c=orange:s=128x72:r=24:d=8','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=8','-c:v','libx264','-c:a','aac','-y',generated]);
  await ff(['-f','lavfi','-i','color=c=blue:s=128x72:r=30:d=8','-c:v','libx264','-an','-y',silent]);
  const generatedBytes=await readFile(generated),silentBytes=await readFile(silent),failures=[],starts=[];
  let providerBase,planCalls=0,transcriptions=0,imports=0;
  const google=http.createServer(async(req,res)=>{
    try{
      assert.equal(req.headers['x-goog-api-key'],'narrated-fixture-google');
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=chunks.length?JSON.parse(Buffer.concat(chunks)):null;
      if(req.url.endsWith(':generateContent')){
        planCalls++;const prompt=body.contents[0].parts[0].text;
        const input=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1));
        assert.ok(input.windows.length>0&&input.windows.length<=20);
        send(res,{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({title:'Một buổi sáng ở làng quê',continuity:input.continuity||'Làng quê Việt Nam, ánh sáng tự nhiên, chuyển động chân thực.',scenes:input.windows.map(window=>({id:window.id,title:`Khung cảnh ${window.id}`,visual:'Đường làng, cây lay nhẹ trong gió và người đi bộ.',prompt:'Realistic live action in a Vietnamese village. People walking naturally, leaves moving, a slow camera pan, soft morning light. Use the existing narration as voiceover.'}))})}]}}]});return;
      }
      if(req.url.endsWith(':predictLongRunning')){
        starts.push(body);assert.ok([4,6,8].includes(body.parameters.durationSeconds));assert.equal(body.parameters.resolution,'720p');
        send(res,{name:`models/veo-3.1-generate-preview/operations/narrated-${starts.length}`});return;
      }
      const operation=/\/operations\/narrated-(\d+)$/.exec(req.url);
      if(operation){send(res,{done:true,response:{generateVideoResponse:{generatedSamples:[{video:{uri:`${providerBase}/files/narrated-${operation[1]}:download?alt=media`}}]}}});return;}
      const download=/\/files\/narrated-(\d+):download/.exec(req.url);
      if(download){res.setHeader('content-type','video/mp4');res.end(Number(download[1])%2?generatedBytes:silentBytes);return;}
      res.writeHead(404);res.end('{}');
    }catch(error){failures.push(error);res.writeHead(500);res.end('{}');}
  });
  await listen(google);providerBase=`http://127.0.0.1:${google.address().port}/v1beta`;
  const provider={};
  for(const name of ['generateNarratedPlan','startSceneVideo','pollSceneVideo','downloadSceneVideo'])provider[name]=(...args)=>{const options=args.pop();return narratedProvider[name](...args,{...options,apiBase:providerBase});};
  let server,api,store,base;
  async function open(){
    store=createStore(path.join(directory,'jobs.sqlite'));
    api=createApi({store,dataDir:directory,config:{readConfig:()=>({provider:'gemini',apiKey:'narrated-fixture-google',videoApiKey:'narrated-fixture-google',translationModel:'gemini-3.5-flash-lite',transcriptionModel:'gemini-3.5-transcribe'})},tools:{
      getToolStatus:toolsReady,narratedProvider:provider,narratedPollIntervalMs:0,narratedTickMs:10,
      async importVideo(url,jobDir){imports++;assert.match(url,/^https:\/\/(?:www\.youtube\.com\/watch\?v=|www\.facebook\.com\/reel\/)/);await mkdir(jobDir,{recursive:true});const inputPath=path.join(jobDir,'original.mp4');await copyFile(source,inputPath);return {inputPath,title:'Nguồn lời đọc ở làng quê',metadata:await probeVideo(inputPath)};},
      async extractAudio(input,output){assert.ok(input.endsWith('original.mp4'));await ff(['-f','lavfi','-i','sine=frequency=222:sample_rate=16000:duration=9.3','-ac','1','-c:a','libmp3lame','-y',output]);return {path:output};},
      narratedAi:{async transcribe(audio){transcriptions++;assert.match(audio,/\.mp3$/);return {segments:[{id:'line-1',start:0,end:4.1,text:'Buổi sáng trên con đường làng, mọi người bắt đầu đi làm.'},{id:'line-2',start:4.1,end:8.2,text:'Hàng cây rung nhẹ trong gió và nắng chiếu xuống mặt đường.'}],usage:{provider:'gemini',model:'fixture',audioSeconds:9.3}};}},
    }});
    const app=express();app.use('/api',api);server=http.createServer(app);await listen(server);base=`http://127.0.0.1:${server.address().port}`;
  }
  async function close(){await api?.close();if(server?.listening)await stop(server);store?.close();api=null;server=null;store=null;}
  t.after(async()=>{await close();await stop(google);await rm(directory,{recursive:true,force:true});assert.deepEqual(failures,[]);});
  await open();
  const call=async(route,method='GET',body,expected=200)=>{
    const response=await fetch(`${base}/api${route}`,{method,headers:{origin:base,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    assert.equal(response.status,expected,`${method} ${route}: ${await response.clone().text()}`);return response;
  };
  const get=async id=>(await (await call(`/narrated/projects/${id}`)).json()).project;
  const settle=async(id,predicate)=>{for(let attempt=0;attempt<1000;attempt++){const project=await get(id);if(predicate(project))return project;if(project.status==='failed')assert.fail(JSON.stringify(project.error));await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('Narrated fixture did not settle');};
  assert.deepEqual((await (await call('/jobs')).json()).jobs,[]);
  assert.equal((await (await call('/health')).json()).configured,true);
  assert.deepEqual((await (await call('/studio')).json()).projects,[]);
  await call('/narrated/projects','POST',{url:'https://example.com/video',aspectRatio:'16:9'},400);
  let project=(await (await call('/narrated/projects','POST',{url:'https://youtu.be/abcdefghijk?si=tracking',aspectRatio:'16:9'},202)).json()).project;
  project=await settle(project.id,p=>p.status==='completed');
  assert.equal(project.sourceUrl,'https://www.youtube.com/watch?v=abcdefghijk');assert.ok(project.scenes.length>=2);
  assert.equal(project.scenes[0].start,0);assert.ok(Math.abs(project.scenes.at(-1).end-project.duration)<0.001);
  assert.equal(transcriptions,1);assert.equal(imports,1);assert.equal(planCalls,1);assert.equal(starts.length,project.scenes.length);
  assert.equal(project.assembly.stale,false);assert.ok(project.assembly.videoUrl);
  assert.ok(!JSON.stringify(project).includes(directory));assert.ok(!JSON.stringify(project).includes('narrated-fixture-google'));assert.ok(!JSON.stringify(project).includes(providerBase));
  const output=path.join(directory,'verified-output.mp4');
  await writeFile(output,Buffer.from(await (await fetch(`${base}${project.assembly.videoUrl}`)).arrayBuffer()));
  const metadata=await probeVideo(output);assert.equal(metadata.width,1280);assert.equal(metadata.height,720);assert.ok(Math.abs(metadata.duration-project.duration)<=0.1);assert.equal(metadata.hasAudio,true);
  const pcm=path.join(directory,'voice.pcm');await ff(['-i',output,'-map','0:a:0','-ac','1','-ar','16000','-t','1','-f','s16le','-y',pcm]);
  const samples=await readFile(pcm);assert.ok(tonePower(samples,440)>tonePower(samples,880)*100,'must use original narration, not generated clip audio');assert.ok(tonePower(samples,440)>tonePower(samples,222)*100,'must not use the low-quality ASR analysis track');
  const scene=project.scenes[0],historyUrl=scene.history[0].videoUrl;assert.ok(historyUrl);
  const preview=await fetch(`${base}${historyUrl}`,{headers:{range:'bytes=0-15'}});assert.equal(preview.status,206);assert.equal(Buffer.from(await preview.arrayBuffer()).toString('ascii',4,8),'ftyp');
  const untouched=project.scenes.slice(1).map(s=>({id:s.id,version:s.version,videoUrl:s.videoUrl,prompt:s.prompt}));
  const updated=scene.prompt+' Máy quay đi chậm sát hàng cây.';
  project=(await (await call(`/narrated/projects/${project.id}/scenes/${scene.id}`,'PUT',{version:scene.version,prompt:updated})).json()).project;
  assert.equal(project.assembly.stale,true);
  await call(`/narrated/projects/${project.id}/scenes/${scene.id}/generate`,'POST',{version:project.scenes[0].version},202);
  project=await settle(project.id,p=>!p.busy&&p.scenes[0].status==='completed');
  assert.equal(starts.length,project.scenes.length+1);assert.equal(project.scenes[0].history.length,2);
  assert.deepEqual(project.scenes.slice(1).map(s=>({id:s.id,version:s.version,videoUrl:s.videoUrl,prompt:s.prompt})),untouched);
  assert.equal((await fetch(`${base}${historyUrl}`)).status,200);
  await call(`/narrated/projects/${project.id}/render`,'POST',{},202);project=await settle(project.id,p=>p.status==='completed'&&!p.assembly.stale);
  const count=starts.length;await close();await open();project=await get(project.id);
  assert.equal(project.scenes[0].history.length,2);assert.equal((await fetch(`${base}${historyUrl}`)).status,200);assert.equal(starts.length,count);assert.equal(imports,1);assert.equal(transcriptions,1);assert.equal(planCalls,1);
  const crossScene=await fetch(`${base}/api/narrated/projects/${project.id}/files/${project.scenes[1].id}?generation=${scene.history[0].id}`);assert.equal(crossScene.status,404);
  const facebook=(await (await call('/narrated/projects','POST',{url:'https://www.facebook.com/reel/123456789/?tracking=ignored',aspectRatio:'9:16'},202)).json()).project;
  const fbResult=await settle(facebook.id,p=>p.status==='completed');assert.equal(fbResult.sourceUrl,'https://www.facebook.com/reel/123456789/');
  const fbVideo=path.join(directory,'facebook-output.mp4');await writeFile(fbVideo,Buffer.from(await (await fetch(`${base}${fbResult.assembly.videoUrl}`)).arrayBuffer()));
  const fbMetadata=await probeVideo(fbVideo);assert.equal(fbMetadata.width,720);assert.equal(fbMetadata.height,1280);
  assert.deepEqual((await (await call('/jobs')).json()).jobs,[]);assert.deepEqual((await (await call('/studio')).json()).projects,[]);
});

test('missing Veo key is confined to narrated workflow and no generation is attempted',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'narrated-no-key-')),store=createStore(path.join(directory,'jobs.sqlite'));let imports=0;
  const api=createApi({store,dataDir:directory,config:{readConfig:()=>({provider:'openai',apiKey:'sk-proj-local-fixture',translationModel:'gpt-5.4-mini',videoApiKey:''})},tools:{getToolStatus:toolsReady,importVideo:async()=>{imports++;throw new Error('must not import');}}});
  const app=express();app.use('/api',api);const server=http.createServer(app);await listen(server);const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await api.close();await stop(server);store.close();await rm(directory,{recursive:true,force:true});});
  const health=await (await fetch(`${base}/api/health`)).json();assert.equal(health.configured,true);assert.equal(health.videoConfigured,false);
  const response=await fetch(`${base}/api/narrated/projects`,{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({url:'https://youtu.be/abcdefghijk',aspectRatio:'9:16'})});
  assert.equal(response.ok,false);assert.equal((await response.json()).error.code,'AI_VIDEO_NOT_CONFIGURED');assert.equal(imports,0);
  assert.equal((await fetch(`${base}/api/jobs`)).status,200);
});

test('delayed source audio retains its position in both default ASR extraction and final MP4',{timeout:90000},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'narrated-delayed-flow-')),source=path.join(directory,'delayed.mp4'),clip=path.join(directory,'silent.mp4');
  const ff=async args=>runProcess(toolPaths.ffmpeg,['-hide_banner','-loglevel','error','-nostdin',...args]);
  await ff(['-f','lavfi','-i','color=c=blue:s=96x64:r=24:d=12','-itsoffset','5','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=5','-c:v','libx264','-c:a','aac','-y',source]);
  await ff(['-f','lavfi','-i','color=c=green:s=96x64:r=24:d=8','-an','-c:v','libx264','-y',clip]);
  const rms=(bytes,start,end)=>{let sum=0,count=0;for(let i=Math.floor(start*16000);i<Math.min(bytes.length/2,end*16000);i++){const v=bytes.readInt16LE(i*2)/32768;sum+=v*v;count++;}return Math.sqrt(sum/count);};
  async function checkTiming(file,name){const pcm=path.join(directory,`${name}.pcm`);await ff(['-i',file,'-map','0:a:0','-ac','1','-ar','16000','-f','s16le','-y',pcm]);const bytes=await readFile(pcm);assert.ok(rms(bytes,.1,.8)<.005,`${name} must preserve initial silence`);assert.ok(rms(bytes,5.3,5.8)>.04,`${name} must place original speech at its source time`);assert.ok(rms(bytes,11,11.5)<.005,`${name} must pad trailing silence`);}
  let asrCalls=0,starts=0;const store=createStore(path.join(directory,'jobs.sqlite'));
  const api=createApi({store,dataDir:directory,config:{readConfig:()=>({provider:'gemini',apiKey:'local-fixture',videoApiKey:'local-fixture'})},tools:{getToolStatus:toolsReady,narratedPollIntervalMs:0,narratedTickMs:2,
    async importVideo(url,jobDir){await mkdir(jobDir,{recursive:true});const inputPath=path.join(jobDir,'original.mp4');await copyFile(source,inputPath);return {inputPath,title:'Giọng đọc bắt đầu sau khoảng lặng',metadata:await probeVideo(inputPath)};},
    narratedAi:{async transcribe(audio){asrCalls++;await checkTiming(audio,'asr');return {segments:[{id:'delayed-line',start:5.1,end:9.8,text:'Lời đọc gốc bắt đầu sau năm giây.'}]};}},
    narratedProvider:{async generateNarratedPlan({windows}){return {title:'Đúng nhịp lời đọc',continuity:'Cảnh quay tự nhiên.',scenes:windows.map(w=>({id:w.id,title:w.id,visual:'Cây rung nhẹ.',prompt:'Realistic natural moving scene.'}))};},async startSceneVideo(){starts++;return {operationName:`models/veo-3.1-generate-preview/operations/delayed-${starts}`};},async pollSceneVideo(){return {done:true,videoUri:'fixture-local'};},async downloadSceneVideo(uri,destination){await copyFile(clip,destination);}},
  }});
  const app=express();app.use('/api',api);const server=http.createServer(app);await listen(server);const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await api.close();await stop(server);store.close();await rm(directory,{recursive:true,force:true});});
  const response=await fetch(`${base}/api/narrated/projects`,{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({url:'https://youtu.be/abcdefghijk',aspectRatio:'16:9'})});assert.equal(response.status,202);
  const initial=(await response.json()).project;let completed;
  for(let attempt=0;attempt<800;attempt++){const project=(await (await fetch(`${base}/api/narrated/projects/${initial.id}`)).json()).project;if(project.status==='failed')assert.fail(JSON.stringify(project.error));if(project.status==='completed'){completed=project;break;}await new Promise(resolve=>setTimeout(resolve,20));}
  assert.ok(completed,'delayed workflow must complete');assert.equal(asrCalls,1);
  const output=path.join(directory,'output.mp4');await writeFile(output,Buffer.from(await (await fetch(`${base}${completed.assembly.videoUrl}`)).arrayBuffer()));await checkTiming(output,'final');assert.ok(Math.abs((await probeVideo(output)).duration-completed.duration)<=.1);
});
