import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {synthesizeSpeech} from '../lib/gemini-tts.mjs';

function wav(samples=4) {
  const result=Buffer.alloc(44+samples*2);
  result.write('RIFF');result.writeUInt32LE(result.length-8,4);result.write('WAVE',8);
  result.write('fmt ',12);result.writeUInt32LE(16,16);result.writeUInt16LE(1,20);result.writeUInt16LE(1,22);
  result.writeUInt32LE(24000,24);result.writeUInt32LE(48000,28);result.writeUInt16LE(2,32);result.writeUInt16LE(16,34);
  result.write('data',36);result.writeUInt32LE(samples*2,40);
  return result;
}
const audioContent=audio=>({type:'audio',mime_type:'audio/wav',data:audio.toString('base64')});
const interaction=(audio=wav(),extra={})=>({id:'interactions/fixture',status:'completed',steps:[{type:'model_output',content:[audioContent(audio)]}],...extra});
function send(res,status,data,headers={}) {res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(data));}
async function fixture(t,handler) {
  const failures=[];
  const server=http.createServer(async(req,res)=>{
    try {const chunks=[];for await(const chunk of req)chunks.push(chunk);await handler(req,res,Buffer.concat(chunks));}
    catch (failure) {failures.push(failure);if(!res.headersSent)res.writeHead(500);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  t.after(()=>assert.deepEqual(failures,[]));
  return {apiKey:'private-fixture-key',voice:'Kore',apiBase:`http://127.0.0.1:${server.address().port}/v1beta`,timeoutMs:1000,retryDelayMs:1,maxRetryDelayMs:10};
}

test('speech sends documented Interactions metadata and returns validated WAV with measured usage',async t=>{
  const options=await fixture(t,(req,res,raw)=>{
    assert.equal(req.url,'/v1beta/interactions');assert.equal(req.method,'POST');
    assert.equal(req.headers['x-goog-api-key'],'private-fixture-key');assert.equal(req.headers.authorization,undefined);
    assert.deepEqual(JSON.parse(raw),{
      model:'gemini-3.8-flash-lite-tts',store:false,
      input:[{type:'user_input',content:[{type:'text',text:'Xin chào Việt Nam.',annotations:[{type:'speech_metadata',style:'Speak naturally in Vietnamese, clearly, at a conversational pace.'}]}]}],
      response_format:{type:'audio',mime_type:'audio/wav',sample_rate:24000},generation_config:{speech_config:[{voice:'Kore'}]},
    });
    send(res,200,interaction(wav(),{usage:{total_input_tokens:21,total_output_tokens:7,total_tokens:28,total_cached_tokens:2,total_thought_tokens:1,input_tokens_by_modality:[{modality:'text',tokens:21}],output_tokens_by_modality:[{modality:'audio',tokens:7}],seconds:0.25,private:'private-fixture-key'}}));
  });
  const {audio,usage}=await synthesizeSpeech('Xin chào Việt Nam.',options);
  assert.ok(Buffer.isBuffer(audio));assert.deepEqual(audio,wav());
  assert.deepEqual({...usage,elapsedMs:0},{provider:'gemini',model:'gemini-3.8-flash-lite-tts',input_tokens:21,output_tokens:7,total_tokens:28,seconds:0.25,input_tokens_details:{cached_tokens:2,text_tokens:21},output_tokens_details:{reasoning_tokens:1,audio_tokens:7},attempts:1,elapsedMs:0});
  assert.ok(Number.isFinite(usage.elapsedMs)&&usage.elapsedMs>=0);
});

test('speech selects only the last generated audio and ignores echoed input and thoughts',async t=>{
  const result=interaction(wav(7),{steps:[
    {type:'user_input',content:[audioContent(Buffer.from('private input'))]},
    {type:'thought',summary:[audioContent(Buffer.from('private thought'))]},
    {type:'model_output',content:[audioContent(wav(2)),{type:'text',text:'private explanation'}]},
    {type:'model_output',content:[audioContent(wav(7))]},
  ]});
  const options=await fixture(t,(_,res)=>send(res,200,result));
  assert.deepEqual((await synthesizeSpeech('Xin chào.',options)).audio,wav(7));
});

test('missing usage is not replaced with estimated token or price counts',async t=>{
  const options=await fixture(t,(_,res)=>send(res,200,interaction(wav(),{model:'private-fixture-key',usage:{total_tokens:-1,total_input_tokens:'21',total_output_tokens:null,unknown:999,input_tokens_by_modality:[{modality:'diagnostic',tokens:8}]}})));
  const {usage}=await synthesizeSpeech('Chào.',options);
  assert.deepEqual(Object.keys(usage).sort(),['attempts','elapsedMs','model','provider']);
  assert.equal(usage.model,'gemini-3.8-flash-lite-tts');
});

for(const [label,text,patch] of [
  ['empty','',{}],['whitespace',' \n ',{}],['non-string',null,{}],['long','x'.repeat(2001),{}],
  ['unknown voice','Chào',{voice:'custom_voice'}],['missing voice','Chào',{voice:undefined}],
  ['missing key','Chào',{apiKey:''}],['header injection','Chào',{apiKey:'key\r\nX-Other: leak'}],
]) {
  test(`speech rejects ${label} before contacting provider`,async t=>{
    let calls=0;const options=await fixture(t,(_,res)=>{calls++;send(res,200,interaction());});
    await assert.rejects(synthesizeSpeech(text,{...options,...patch}),{code:label.includes('key')||label==='header injection'?'AI_AUTH':'AI_REQUEST'});
    assert.equal(calls,0);
  });
}

test('all client-safe curated voices can synthesize and unknown voices cannot escape the allowlist',async t=>{
  const {VOICES}=await import('../lib/dubbing-voices.mjs');
  assert.deepEqual(VOICES.map(value=>value.id),['Puck','Kore','Leda','Charon','Fenrir','Aoede','Enceladus','Sulafat']);
  const options=await fixture(t,(_,res)=>send(res,200,interaction()));
  for(const voice of VOICES) {
    assert.deepEqual(Object.keys(voice).sort(),['id','label']);assert.ok(voice.label.length>voice.id.length);
    assert.deepEqual((await synthesizeSpeech('Chào.',{...options,voice:voice.id})).audio,wav());
  }
});

for(const [status,details,code,attempts] of [
  [400,{status:'INVALID_ARGUMENT',details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:'API_KEY_INVALID'}]},'AI_AUTH',1],
  [401,{status:'UNAUTHENTICATED'},'AI_AUTH',1],
  [403,{status:'PERMISSION_DENIED'},'AI_AUTH',1],
  [429,{status:'RESOURCE_EXHAUSTED',details:[{'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaValue:'0'}]}]},'AI_QUOTA',1],
  [429,{status:'RESOURCE_EXHAUSTED',details:[{'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaId:'RequestsPerDayPerProject',quotaValue:'20'}]}]},'AI_QUOTA',1],
  [429,{status:'RESOURCE_EXHAUSTED'},'AI_RATE_LIMIT',3],
  [503,{status:'UNAVAILABLE'},'AI_UNAVAILABLE',3],
  [400,{status:'INVALID_ARGUMENT'},'AI_REQUEST',1],
]) {
  test(`speech ${status}/${code} redacts error data and makes ${attempts} attempts`,async t=>{
    let calls=0;const options=await fixture(t,(_,res)=>{calls++;send(res,status,{error:{...details,message:'private-fixture-key C:\\secret\\file'}});});
    await assert.rejects(synthesizeSpeech('Xin chào.',options),failure=>{
      assert.equal(failure.code,code);assert.equal(failure.attempts,attempts);assert.ok(failure.elapsedMs>=0);
      assert.doesNotMatch(`${failure.message} ${JSON.stringify(failure)}`,/private-fixture-key|C:\\secret/);return true;
    });
    assert.equal(calls,attempts);
  });
}

test('speech retries transient provider failures and records the successful attempt count',async t=>{
  let calls=0;const options=await fixture(t,(_,res)=>++calls<3?send(res,503,{error:{status:'UNAVAILABLE'}}):send(res,200,interaction()));
  assert.equal((await synthesizeSpeech('Xin chào.',options)).usage.attempts,3);assert.equal(calls,3);
});

test('speech caps excessive Retry-After and RetryInfo delays',async t=>{
  let calls=0;const options=await fixture(t,(_,res)=>++calls===1?send(res,429,{error:{details:[{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'86400s'}]}},{'retry-after':'86400'}):send(res,200,interaction()));
  const started=Date.now();const result=await synthesizeSpeech('Xin chào.',{...options,maxRetryDelayMs:15});
  assert.equal(result.usage.attempts,2);assert.ok(Date.now()-started<1000);
});

test('abort during a retry delay prevents the next request',async t=>{
  let calls=0;let notify;const first=new Promise(resolve=>{notify=resolve;});
  const options=await fixture(t,(_,res)=>{calls++;send(res,429,{error:{status:'RESOURCE_EXHAUSTED'}});notify();});
  const controller=new AbortController();const pending=synthesizeSpeech('Chào.',{...options,signal:controller.signal,retryDelayMs:1000,maxRetryDelayMs:1000});
  await first;controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(calls,1);
});

test('abort cancels an in-flight response without retrying',async t=>{
  let calls=0;let notify;const first=new Promise(resolve=>{notify=resolve;});
  const options=await fixture(t,()=>{calls++;notify();});
  const controller=new AbortController();const pending=synthesizeSpeech('Chào.',{...options,signal:controller.signal});
  await first;controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(calls,1);
});

test('already aborted calls never contact the provider',async t=>{
  let calls=0;const options=await fixture(t,(_,res)=>{calls++;send(res,200,interaction());});
  const controller=new AbortController();controller.abort();
  await assert.rejects(synthesizeSpeech('Chào.',{...options,signal:controller.signal}),{name:'AbortError'});assert.equal(calls,0);
});

test('speech times out a stalled response with three bounded attempts',async t=>{
  let calls=0;const options=await fixture(t,()=>{calls++;});
  await assert.rejects(synthesizeSpeech('Chào.',{...options,timeoutMs:25}),{code:'AI_TIMEOUT',attempts:3});assert.equal(calls,3);
});

test('speech redacts failed connections and retries at most three times',async t=>{
  let calls=0;const options=await fixture(t,req=>{calls++;req.socket.destroy();});
  await assert.rejects(synthesizeSpeech('Chào.',options),failure=>failure.code==='AI_CONNECTION'&&failure.attempts===3&&!failure.message.includes('private-fixture-key'));assert.equal(calls,3);
});

test('redirects are not followed even to another loopback origin',async t=>{
  let leaked=0;const target=await fixture(t,(_,res)=>{leaked++;send(res,200,interaction());});
  const source=await fixture(t,(_,res)=>{res.writeHead(307,{location:`${target.apiBase}/interactions`});res.end();});
  await assert.rejects(synthesizeSpeech('Chào.',source),{code:'AI_CONNECTION'});assert.equal(leaked,0);
});

for(const apiBase of ['https://attacker.invalid/v1beta','http://127.0.0.1.attacker.invalid/v1beta','http://user:pass@127.0.0.1/v1beta','http://127.0.0.1/v1beta?key=leak','http://127.0.0.1/v1beta#fragment','file:///tmp/api']) {
  test(`speech refuses unsafe API override ${apiBase}`,async()=>{
    await assert.rejects(synthesizeSpeech('Chào.',{apiKey:'private-fixture-key',voice:'Kore',apiBase}),{code:'AI_REQUEST'});
  });
}

const damaged=()=>{const audio=wav();audio.writeUInt32LE(1000000,40);return audio;};
const noData=()=>{const audio=wav(0);return audio;};
for(const [label,result] of [
  ['incomplete status',()=>interaction(wav(),{status:'in_progress'})],
  ['provider error inside success',()=>interaction(wav(),{error:{message:'private-fixture-key'}})],
  ['missing outputs',()=>interaction(wav(),{steps:[]})],
  ['thought only',()=>interaction(wav(),{steps:[{type:'thought',summary:[audioContent(wav())]}]})],
  ['text only',()=>interaction(wav(),{steps:[{type:'model_output',content:[{type:'text',text:'private-fixture-key'}]}]})],
  ['URL audio',()=>interaction(wav(),{steps:[{type:'model_output',content:[{type:'audio',mime_type:'audio/wav',uri:'file:///private.wav'}]}]})],
  ['wrong mime',()=>interaction(wav(),{steps:[{type:'model_output',content:[{...audioContent(wav()),mime_type:'audio/mp3'}]}]})],
  ['invalid base64',()=>interaction(wav(),{steps:[{type:'model_output',content:[{type:'audio',mime_type:'audio/wav',data:'AAAA%%%private-fixture-key'}]}]})],
  ['invalid WAV',()=>interaction(Buffer.from('RIFF0000WAVEnot real audio'))],
  ['truncated data chunk',()=>interaction(damaged())],
  ['empty data chunk',()=>interaction(noData())],
]) {
  test(`speech rejects ${label} without retries or provider content leakage`,async t=>{
    let calls=0;const options=await fixture(t,(_,res)=>{calls++;send(res,200,result());});
    await assert.rejects(synthesizeSpeech('Chào.',options),failure=>failure.code==='AI_INVALID_RESPONSE'&&!failure.message.includes('private-fixture-key'));assert.equal(calls,1);
  });
}

test('speech refuses oversized decoded audio',async t=>{
  const options=await fixture(t,(_,res)=>send(res,200,interaction(Buffer.alloc(16*1024*1024+1))));
  await assert.rejects(synthesizeSpeech('Chào.',options),{code:'AI_INVALID_RESPONSE'});
});

test('speech bounds response streaming before JSON decoding',async t=>{
  const options=await fixture(t,(_,res)=>{res.writeHead(200,{'content-type':'application/json','content-length':'100000000'});res.end('{}');});
  await assert.rejects(synthesizeSpeech('Chào.',options),{code:'AI_INVALID_RESPONSE'});
});

test('speech rejects malformed JSON without returning the provider body',async t=>{
  const options=await fixture(t,(_,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('private-fixture-key not json');});
  await assert.rejects(synthesizeSpeech('Chào.',options),failure=>failure.code==='AI_INVALID_RESPONSE'&&!failure.message.includes('private-fixture-key'));
});
