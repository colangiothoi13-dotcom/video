import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {createStore} from '../lib/store.mjs';
import {createApi} from '../lib/api.mjs';

async function fixture(t){
 const store=createStore(':memory:');let key='private-google-key',fail=false,count=0,observed;
 const api=createApi({store,config:{readConfig:()=>({provider:'openai',apiKey:'sk-private-openai',translationModel:'gpt-5.4-mini',providerConfigs:{gemini:{apiKey:key,translationModel:'gemini-4-argon'},openai:{apiKey:'sk-private-openai',translationModel:'gpt-5.4-mini'}}})},tools:{listGeminiTranslationModels:async options=>{count++;observed=options;await new Promise(r=>setTimeout(r,10));if(fail)throw Object.assign(new Error('private upstream key'),{code:'AI_AUTH'});return [{id:'gemini-4-argon',label:'Gemini 4 Argon'}];}}});
 const app=express();app.use('/api',api);const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/api/settings/models`;
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await api.close();store.close();});
 return {call:query=>fetch(base+(query??'?provider=gemini')),calls:()=>count,options:()=>observed,setKey:k=>key=k,setFail:v=>fail=v};
}
test('model discovery uses saved Google credentials independently of the active provider and never exposes keys',async t=>{
 const f=await fixture(t),r=await f.call();assert.equal(r.status,200);const d=await r.json();assert.equal(d.provider,'gemini');assert.deepEqual(d.models,[{id:'gemini-4-argon',label:'Gemini 4 Argon'}]);assert.equal(f.options().apiKey,'private-google-key');assert.ok(!JSON.stringify(d).includes('private'));assert.equal(d.cached,false);assert.ok(Number.isFinite(Date.parse(d.fetchedAt)));
});
test('concurrent model requests share one fetch; refresh bypasses cache and changed keys cannot reuse it',async t=>{
 const f=await fixture(t);const responses=await Promise.all([f.call(),f.call()]);assert.ok(responses.every(r=>r.status===200));assert.equal(f.calls(),1);assert.equal((await(await f.call()).json()).cached,true);assert.equal(f.calls(),1);
 assert.equal((await(await f.call('?provider=gemini&refresh=1')).json()).cached,false);assert.equal(f.calls(),2);f.setKey('private-google-replaced');await f.call();assert.equal(f.calls(),3);assert.equal(f.options().apiKey,'private-google-replaced');
});
test('a missing Google key is not substituted with an OpenAI key and unsupported queries are rejected',async t=>{
 const f=await fixture(t);for(const query of ['?provider=openai','?provider=gemini&refresh=bad','?provider=gemini&path=private','?provider=gemini&provider=gemini'])assert.equal((await f.call(query)).status,400);
 f.setKey('');const response=await f.call();assert.equal(response.status,400);assert.equal((await response.json()).error.code,'AI_NOT_CONFIGURED');assert.equal(f.calls(),0);
});
test('a failed refresh reports a safe error without destroying the last successful cache',async t=>{
 const f=await fixture(t);await f.call();f.setFail(true);const r=await f.call('?provider=gemini&refresh=1');assert.equal(r.status,400);const d=await r.json();assert.equal(d.error.code,'AI_AUTH');assert.ok(!JSON.stringify(d).includes('private'));assert.equal((await(await f.call()).json()).cached,true);assert.equal(f.calls(),2);
});
