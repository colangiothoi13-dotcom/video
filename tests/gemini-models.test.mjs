import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as ai from '../lib/ai.mjs';

async function fixture(t,handler){
 const failures=[],server=http.createServer(async(req,res)=>{try{await handler(req,res);}catch(e){failures.push(e);res.writeHead(500);res.end('{}');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));assert.deepEqual(failures,[]);});
 return {apiKey:'private-model-list-key',apiBase:`http://127.0.0.1:${server.address().port}/v1beta`,timeoutMs:1000,retryDelayMs:1};
}
const model=(id,methods=['generateContent'],displayName=id)=>({name:`models/${id}`,displayName,supportedGenerationMethods:methods});
const send=(res,body,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};

test('Google catalog follows all pages using GET metadata, filters specialized models and returns only safe dropdown fields',async t=>{
 assert.equal(typeof ai.listGeminiTranslationModels,'function');let calls=0;
 const options=await fixture(t,(req,res)=>{calls++;assert.equal(req.method,'GET');assert.equal(req.headers['x-goog-api-key'],'private-model-list-key');assert.ok(!req.url.includes('private-'));const url=new URL(req.url,'http://localhost');assert.equal(url.pathname,'/v1beta/models');assert.equal(url.searchParams.get('pageSize'),'1000');
  if(!url.searchParams.has('pageToken'))send(res,{models:[model('gemini-4-argon',undefined,'Gemini 4 Argon'),model('gemini-embedding-001',['embedContent']),model('gemini-3.8-flash-image'),model('gemini-3.8-flash-lite-tts'),model('gemini-3.5-transcribe',['transcribe']),model('gemini-live-flash'),model('gemini-nano-banana-2.1'),model('gemini-2.5-computer-use-preview'),model('gemini-omni-flash-preview'),model('gemini-omni-1.1-flash'),model('other-provider-pro')],nextPageToken:'page 2/?'});
  else {assert.equal(url.searchParams.get('pageToken'),'page 2/?');send(res,{models:[model('gemini-3.8-flash',undefined,'Gemini 3.8 Flash'),model('gemini-4-argon'),{name:'models/gemini-unknown-no-methods'},{name:'models/../../private',supportedGenerationMethods:['generateContent']}]});}
 });
 const models=await ai.listGeminiTranslationModels(options);assert.equal(calls,2);assert.deepEqual(models,[{id:'gemini-3.8-flash',label:'Gemini 3.8 Flash'},{id:'gemini-4-argon',label:'Gemini 4 Argon'}]);assert.ok(!JSON.stringify(models).includes('private-model-list-key'));
});
test('a repeated Google pagination token is rejected rather than looping forever',async t=>{
 assert.equal(typeof ai.listGeminiTranslationModels,'function');let calls=0;const options=await fixture(t,(_,res)=>{calls++;send(res,{models:[model('gemini-4-argon')],nextPageToken:'same'});});
 await assert.rejects(()=>ai.listGeminiTranslationModels(options),{code:'AI_INVALID_RESPONSE'});assert.equal(calls,2);
});
test('catalog errors are redacted and arbitrary API hosts never receive credentials',async t=>{
 assert.equal(typeof ai.listGeminiTranslationModels,'function');let calls=0;const options=await fixture(t,(_,res)=>{calls++;send(res,{error:{message:'private-model-list-key should not appear'}},403);});
 await assert.rejects(()=>ai.listGeminiTranslationModels(options),e=>e.code==='AI_MODEL_ACCESS'&&!e.message.includes('private-model-list-key'));assert.equal(calls,1);
 await assert.rejects(()=>ai.listGeminiTranslationModels({...options,apiBase:'https://untrusted.example/v1beta'}),{code:'AI_INVALID_RESPONSE'});assert.equal(calls,1);
});
test('malformed catalog pages fail safely while an empty catalog is valid',async t=>{
 assert.equal(typeof ai.listGeminiTranslationModels,'function');let bad=true;const options=await fixture(t,(_,res)=>send(res,bad?{models:'private bad payload'}:{models:[]}));
 await assert.rejects(()=>ai.listGeminiTranslationModels(options),{code:'AI_INVALID_RESPONSE'});bad=false;assert.deepEqual(await ai.listGeminiTranslationModels(options),[]);
});
test('catalog cancellation stops before any request',async t=>{
 assert.equal(typeof ai.listGeminiTranslationModels,'function');let calls=0;const options=await fixture(t,(_,res)=>{calls++;send(res,{models:[]});});const controller=new AbortController();controller.abort();await assert.rejects(()=>ai.listGeminiTranslationModels({...options,signal:controller.signal}),{name:'AbortError'});assert.equal(calls,0);
});
