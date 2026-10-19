import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {generateNarratedPlan,startSceneVideo,pollSceneVideo,downloadSceneVideo} from '../lib/narrated-provider.mjs';
import * as sceneProvider from '../lib/scene-provider.mjs';

const windows=[{id:'scene-21',start:120,end:125,transcriptText:'A farmer works.'},{id:'scene-22',start:125,end:128,transcriptText:''}];
const plan=()=>({title:'Fields',continuity:'Same adult farmer in blue shirt; natural daylight.',scenes:windows.map(w=>({id:w.id,title:'Field',visual:'Farmer walking through a field.',prompt:'Photorealistic footage; farmer walks; slow camera pan, natural light.'}))});
const send=(res,data,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
async function fixture(t,handler){const failures=[];const server=http.createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);await handler(req,res,JSON.parse(Buffer.concat(chunks).toString()||'{}'));}catch(e){failures.push(e);res.writeHead(500);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));t.after(()=>assert.deepEqual(failures,[]));return {apiBase:`http://127.0.0.1:${server.address().port}/v1beta`,apiKey:'fixture-private-key',timeoutMs:1000};}
const gemini=(res,data)=>send(res,{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(data)}]}}]});

test('Gemini planning routes configured model/key and schema, preserving supplied IDs and order',async t=>{
 const options=await fixture(t,(req,res,body)=>{assert.match(req.url,/\/models\/gemini-test:generateContent$/);assert.equal(req.headers['x-goog-api-key'],'fixture-private-key');assert.equal(req.headers.authorization,undefined);assert.equal(body.generationConfig.responseFormat.text.schema.properties.scenes.minItems,2);assert.match(body.contents[0].parts[0].text,/A farmer works/);assert.match(body.systemInstruction.parts[0].text,/untrusted/i);const output=plan();output.scenes.reverse();gemini(res,output);});
 const result=await generateNarratedPlan({windows,continuity:'Blue shirt',sourceTitle:'Fields'},{...options,model:'gemini-test'});assert.deepEqual(result.scenes.map(s=>s.id),['scene-21','scene-22']);assert.equal(result.continuity,plan().continuity);
});

test('OpenAI planning uses Responses schema with configured model/key and reuses Veo adapters',async t=>{
 const options=await fixture(t,(req,res,body)=>{assert.match(req.url,/\/responses$/);assert.equal(req.headers.authorization,'Bearer fixture-private-key');assert.equal(req.headers['x-goog-api-key'],undefined);assert.equal(body.model,'gpt-5.4-mini');assert.equal(body.text.format.strict,true);assert.equal(body.store,false);send(res,{status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(plan())}]}]});});
 const result=await generateNarratedPlan({windows},{...options,provider:'openai',model:'gpt-5.4-mini'});assert.equal(result.scenes.length,2);
 assert.equal(startSceneVideo,sceneProvider.startSceneVideo);assert.equal(pollSceneVideo,sceneProvider.pollSceneVideo);assert.equal(downloadSceneVideo,sceneProvider.downloadSceneVideo);
});

test('malformed plans, changed IDs, duplicates, timing injection and overlong fields are rejected',async t=>{
 let payload;const options=await fixture(t,(_,res)=>gemini(res,payload));
 const cases=[{}, {...plan(),scenes:plan().scenes.slice(0,1)}, {...plan(),scenes:[plan().scenes[0],plan().scenes[0]]},{...plan(),scenes:plan().scenes.map((s,i)=>i?{...s,id:'scene-999'}:s)},{...plan(),scenes:plan().scenes.map(s=>({...s,start:0}))},{...plan(),continuity:'x'.repeat(6001)},{...plan(),scenes:plan().scenes.map(s=>({...s,prompt:''}))}];
 for(payload of cases)await assert.rejects(generateNarratedPlan({windows},options),{code:'AI_INVALID_RESPONSE'});
});

test('generated prompts fit the 6000-character editor and persistence limit',async t=>{
 let payload=plan();payload.scenes[0].prompt='x'.repeat(6000);
 const options=await fixture(t,(_,res)=>gemini(res,payload));
 const result=await generateNarratedPlan({windows},options);assert.equal(result.scenes[0].prompt.length,6000);
 payload.scenes[0].prompt+='x';await assert.rejects(generateNarratedPlan({windows},options),{code:'AI_INVALID_RESPONSE'});
});

test('invalid inputs and arbitrary API hosts are rejected before requests; provider failures are redacted',async t=>{
 let calls=0;const options=await fixture(t,(_,res)=>{calls++;send(res,{error:{message:'fixture-private-key C:\\secret'}},403);});
 for(const bad of [[],Array.from({length:21},(_,i)=>({...windows[0],id:`scene-${i+1}`})),[windows[0],windows[0]]])await assert.rejects(generateNarratedPlan({windows:bad},options));
 await assert.rejects(generateNarratedPlan({windows},{...options,provider:'unknown'}),{code:'AI_NOT_CONFIGURED'});
 await assert.rejects(generateNarratedPlan({windows},{...options,apiBase:'https://evil.example'}));assert.equal(calls,0);
 await assert.rejects(generateNarratedPlan({windows},options),e=>e.code==='AI_MODEL_ACCESS'&&!e.message.includes('fixture-private-key')&&!e.message.includes('secret'));assert.equal(calls,1);
});
