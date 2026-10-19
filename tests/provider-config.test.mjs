import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readConfig,writeConfig,getConfigStatus} from '../lib/config.mjs';

async function fixture(t){
  const dataDir=await mkdtemp(path.join(tmpdir(),'vietsub-providers-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  return {dataDir,env:{}};
}

test('OpenAI can translate and transcribe without a Google key; provider secrets and models stay independent',async t=>{
  const options=await fixture(t);
  writeConfig({provider:'openai',apiKey:'sk-proj-fixture-openai',translationModel:'gpt-5.4-mini'},options);
  let value=readConfig(options);
  assert.equal(value.provider,'openai');assert.equal(value.apiKey,'sk-proj-fixture-openai');
  assert.equal(value.transcriptionModel,'whisper-1');assert.equal(value.videoApiKey,'');
  writeConfig({provider:'gemini',apiKey:'AIza-fixture-google',translationModel:'gemini-saved'},options);
  writeConfig({provider:'openai'},options);value=readConfig(options);
  assert.equal(value.apiKey,'sk-proj-fixture-openai');assert.equal(value.translationModel,'gpt-5.4-mini');
  assert.equal(value.videoApiKey,'AIza-fixture-google');
  const publicStatus=getConfigStatus(options);
  assert.equal(publicStatus.videoConfigured,true);
  assert.equal(publicStatus.providers.openai.configured,true);
  assert.equal(publicStatus.providers.gemini.translationModel,'gemini-saved');
  assert.ok(publicStatus.translationModels.some(model=>model.id==='gpt-5.4-mini'));
  assert.ok(!JSON.stringify(publicStatus).includes('fixture'));
});

test('an OpenAI key previously pasted into Gemini is recognized without sending it to Veo',async t=>{
  const options=await fixture(t);
  const original=JSON.stringify({provider:'gemini',apiKey:'sk-proj-misplaced-fixture',translationModel:'gemini-3.5-flash-lite'});
  await writeFile(path.join(options.dataDir,'config.json'),original);
  const value=readConfig(options);
  assert.equal(value.provider,'openai');assert.equal(value.apiKey,'sk-proj-misplaced-fixture');
  assert.equal(value.translationModel,'gpt-5.4-mini');assert.equal(value.videoApiKey,'');
  assert.equal(getConfigStatus(options).videoConfigured,false);
  assert.equal(await readFile(path.join(options.dataDir,'config.json'),'utf8'),original,'reading must not rewrite secrets');
  writeConfig({provider:'openai'},options);
  assert.equal(readConfig(options).apiKey,'sk-proj-misplaced-fixture');
});

test('Google video key can be saved while OpenAI is selected and cannot be confused with an OpenAI key',async t=>{
  const options=await fixture(t);
  writeConfig({provider:'openai',apiKey:'sk-proj-fixture',videoApiKey:'AIza-video-fixture'},options);
  assert.equal(readConfig(options).videoApiKey,'AIza-video-fixture');
  const before=await readFile(path.join(options.dataDir,'config.json'),'utf8');
  for(const patch of [{provider:'gemini',apiKey:'sk-proj-not-google'},{provider:'openai',apiKey:'AIza-not-openai'},{videoApiKey:'sk-proj-not-google'}])
    assert.throws(()=>writeConfig(patch,options),{code:'INVALID_KEY_PROVIDER'});
  assert.equal(await readFile(path.join(options.dataDir,'config.json'),'utf8'),before);
});

test('OpenAI environment overrides stay out of persisted settings and do not replace the Google video key',async t=>{
  const options=await fixture(t);
  writeConfig({provider:'openai',apiKey:'sk-proj-saved',translationModel:'gpt-5.4-mini',videoApiKey:'AIza-saved'},options);
  const env={OPENAI_API_KEY:'sk-proj-env-only',OPENAI_TRANSLATION_MODEL:'gpt-5.4',GEMINI_API_KEY:'AIza-env-only'};
  const value=readConfig({...options,env});
  assert.equal(value.apiKey,env.OPENAI_API_KEY);assert.equal(value.translationModel,'gpt-5.4');assert.equal(value.videoApiKey,env.GEMINI_API_KEY);
  writeConfig({provider:'openai',translationModel:'gpt-4.1-mini'},{...options,env});
  const saved=await readFile(path.join(options.dataDir,'config.json'),'utf8');assert.ok(!saved.includes('env-only'));
  assert.equal(readConfig(options).apiKey,'sk-proj-saved');assert.equal(readConfig(options).translationModel,'gpt-4.1-mini');
});

test('wrong-provider and non-text models are rejected atomically; saved model remains in dropdown',async t=>{
  const options=await fixture(t);
  writeConfig({provider:'openai',apiKey:'sk-proj-fixture',translationModel:'gpt-saved-snapshot'},options);
  const before=await readFile(path.join(options.dataDir,'config.json'),'utf8');
  for(const translationModel of ['gemini-3.5-flash-lite','whisper-1','https://evil.example/model'])
    assert.throws(()=>writeConfig({translationModel},options),{code:'INVALID_OPENAI_MODEL'});
  assert.equal(await readFile(path.join(options.dataDir,'config.json'),'utf8'),before);
  assert.ok(getConfigStatus(options).translationModels.some(model=>model.id==='gpt-saved-snapshot'));
});
