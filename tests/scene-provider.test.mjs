import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {toolPaths,probeVideo} from '../lib/media.mjs';
import {runProcess} from '../lib/process.mjs';

const provider=await import('../lib/scene-provider.mjs');
const brief={idea:'Quảng cáo bình nước',character:'Một phụ nữ trưởng thành, áo xanh, tóc ngắn.',product:'Bình thép xanh nhám 500ml.',style:'cinematic',aspectRatio:'9:16',references:[]};
const storyboard=()=>({title:'Một ngày cùng bình nước',scenes:Array.from({length:5},(_,i)=>({title:`Cảnh ${i+1}`,durationSeconds:8,action:'Nhân vật nâng bình lên.',visual:'Bình xanh nhám trên bàn.',setting:'Căn bếp buổi sáng',cameraAngle:'close-up',cameraMovement:'slow dolly-in',lighting:'soft daylight',texture:'matte steel',cinematic:'natural cinematic commercial',audio:'room tone and a gentle piano phrase'}))});
async function fixture(t,handler){
  const failures=[];const server=http.createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);await handler(req,res,Buffer.concat(chunks));}catch(e){failures.push(e);res.writeHead(500);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));t.after(()=>assert.deepEqual(failures,[]));
  return {apiKey:'private-fixture-scene-key',apiBase:`http://127.0.0.1:${server.address().port}/v1beta`,timeoutMs:1000};
}
const send=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};

test('scene provider exposes real script, operation, download and assembly adapters',()=>{
  for(const name of ['generateSceneScript','startSceneVideo','pollSceneVideo','downloadSceneVideo','assembleSceneVideos'])assert.equal(typeof provider[name],'function',name);
});
test('script generation requests structured five scenes and creates complete shot prompts',async t=>{
  const options=await fixture(t,(req,res,bytes)=>{
    assert.match(req.url,/:generateContent$/);assert.equal(req.headers['x-goog-api-key'],'private-fixture-scene-key');
    const body=JSON.parse(bytes);assert.equal(body.generationConfig.responseFormat.text.mimeType,'application/json');
    assert.match(body.contents[0].parts[0].text,/Bình thép xanh nhám/);
    send(res,{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(storyboard())}]}}]});
  });
  const result=await provider.generateSceneScript(brief,options);
  assert.equal(result.scenes.length,5);assert.deepEqual(result.scenes.map(s=>s.id),['scene-1','scene-2','scene-3','scene-4','scene-5']);
  for(const scene of result.scenes){for(const detail of ['Hành động:','Bối cảnh:','Góc máy:','Chuyển động máy:','Ánh sáng:','Chất liệu:','Cinematic:','Âm thanh:'])assert.ok(scene.prompt.includes(detail),detail);}
});
test('incomplete scripts are rejected instead of fabricating a successful storyboard',async t=>{
  const options=await fixture(t,(_,res)=>{const s=storyboard();delete s.scenes[2].audio;send(res,{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(s)}]}}]});});
  await assert.rejects(provider.generateSceneScript(brief,options),{code:'AI_INVALID_RESPONSE'});
});

test('OpenAI scripts use Responses JSON schema and image references, keeping the five-shot contract',async t=>{
  const image='iVBORw0KGgo=';
  const options=await fixture(t,(req,res,bytes)=>{
    assert.match(req.url,/\/responses$/);assert.equal(req.headers.authorization,'Bearer sk-proj-scene-fixture');assert.equal(req.headers['x-goog-api-key'],undefined);
    const body=JSON.parse(bytes);assert.equal(body.model,'gpt-5.4-mini');assert.equal(body.store,false);assert.equal(body.text.format.type,'json_schema');assert.equal(body.text.format.strict,true);
    const input=body.input[0].content;assert.ok(input.some(part=>part.type==='input_text'&&part.text.includes(brief.product)));
    assert.ok(input.some(part=>part.type==='input_image'&&part.image_url===`data:image/png;base64,${image}`));
    send(res,{status:'completed',model:'gpt-5.4-mini',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(storyboard())}]}]});
  });
  const result=await provider.generateSceneScript({...brief,references:[{kind:'product',mimeType:'image/png',data:image}]},{...options,provider:'openai',apiKey:'sk-proj-scene-fixture',model:'gpt-5.4-mini'});
  assert.equal(result.scenes.length,5);assert.ok(result.scenes.every(scene=>scene.durationSeconds===8&&scene.prompt.includes('Âm thanh:')));
});
test('Veo creation sends locked full prompt and references as assets without automatic retries',async t=>{
  const options=await fixture(t,(req,res,bytes)=>{
    assert.match(req.url,/veo-3\.1-generate-preview:predictLongRunning$/);const body=JSON.parse(bytes);
    assert.equal(body.instances[0].prompt,'shared identity then scene');
    assert.deepEqual(body.instances[0].referenceImages,[{image:{inlineData:{mimeType:'image/png',data:'aW1hZ2U='}},referenceType:'asset'}]);
    assert.deepEqual(body.parameters,{aspectRatio:'9:16',durationSeconds:8,resolution:'720p',sampleCount:1,personGeneration:'allow_adult'});
    send(res,{name:'models/veo-3.1-generate-preview/operations/op-one'});
  });
  assert.deepEqual(await provider.startSceneVideo({prompt:'shared identity then scene',durationSeconds:8,aspectRatio:'9:16',references:[{mimeType:'image/png',data:'aW1hZ2U='}]},options),{operationName:'models/veo-3.1-generate-preview/operations/op-one'});
  await assert.rejects(provider.startSceneVideo({prompt:'x',durationSeconds:4,aspectRatio:'9:16',references:[{mimeType:'image/png',data:'aW1hZ2U='}]},options),{code:'AI_VIDEO_OPTIONS'});
});
test('creation errors are redacted and sent only once',async t=>{
  let count=0;const options=await fixture(t,(_,res)=>{count++;send(res,{error:{message:'private-fixture-scene-key C:\\secret',status:'UNAVAILABLE'}},503);});
  await assert.rejects(provider.startSceneVideo({prompt:'scene',durationSeconds:8,aspectRatio:'9:16',references:[]},options),e=>e.code==='AI_UNAVAILABLE'&&!e.message.includes('secret'));
  assert.equal(count,1);
});
test('operation polling returns pending or a validated artifact and rejects provider blocks',async t=>{
  let payload={done:false};let options;
  options=await fixture(t,(_,res)=>send(res,payload));const op='models/veo-3.1-generate-preview/operations/op-one';
  assert.deepEqual(await provider.pollSceneVideo(op,options),{done:false});
  const uri=`${options.apiBase}/files/one:download?alt=media`;
  payload={done:true,response:{generateVideoResponse:{generatedSamples:[{video:{uri}}]}}};
  assert.deepEqual(await provider.pollSceneVideo(op,options),{done:true,videoUri:uri});
  payload={done:true,response:{generateVideoResponse:{raiMediaFilteredCount:1}}};
  await assert.rejects(provider.pollSceneVideo(op,options),{code:'AI_CONTENT_BLOCKED'});
  await assert.rejects(provider.pollSceneVideo('https://evil.example/steal',options),{code:'AI_INVALID_RESPONSE'});
});
test('missing operations and expired downloads fail terminally so the scene can be unlocked',async t=>{
  const options=await fixture(t,(_,res)=>send(res,{error:{status:'NOT_FOUND'}},404));
  await assert.rejects(provider.pollSceneVideo('models/veo-3.1-generate-preview/operations/gone',options),{code:'AI_OPERATION_EXPIRED'});
  const dir=await mkdtemp(path.join(tmpdir(),'scene-expired-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await assert.rejects(provider.downloadSceneVideo(`${options.apiBase}/files/gone:download?alt=media`,path.join(dir,'gone.mp4'),options),{code:'AI_OPERATION_EXPIRED'});
});
test('artifact download writes bounded MP4 bytes and never sends credentials to arbitrary URI',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'scene-download-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const video=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(20)]);
  const options=await fixture(t,(req,res)=>{assert.equal(req.headers['x-goog-api-key'],'private-fixture-scene-key');res.writeHead(200,{'content-type':'video/mp4'});res.end(video);});
  const dest=path.join(dir,'scene.mp4');await provider.downloadSceneVideo(`${options.apiBase}/files/one:download?alt=media`,dest,options);assert.deepEqual(await readFile(dest),video);
  await assert.rejects(provider.downloadSceneVideo('https://evil.example/key',dest,options),{code:'AI_INVALID_RESPONSE'});
});
test('real assembly keeps all five clips and normalizes video and audio streams',{timeout:60000},async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'scene-assembly-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const first=path.join(dir,'cảnh gốc.mp4'),second=path.join(dir,'second.mp4'),destination=path.join(dir,'final.mp4');
  for(const [file,rate,color] of [[first,'44100','blue'],[second,'48000','green']])await runProcess(toolPaths.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-f','lavfi','-i',`color=c=${color}:s=128x72:r=24:d=0.25`,'-f','lavfi','-i',`sine=frequency=440:sample_rate=${rate}:duration=0.25`,'-c:v','libx264','-c:a','aac','-shortest','-y',file]);
  const result=await provider.assembleSceneVideos([first,second,first,second,first],destination);
  const metadata=await probeVideo(destination);assert.ok(result.duration>=1.15&&result.duration<1.7);assert.equal(metadata.hasAudio,true);assert.equal(metadata.width,1280);
  await assert.rejects(provider.assembleSceneVideos([first],destination),{code:'AI_VIDEO_OPTIONS'});
});
