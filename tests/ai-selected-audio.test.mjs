import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import {runProcess} from '../lib/process.mjs';
import {transcribe,testAiConnection} from '../lib/ai.mjs';

const model='gemini-4-argon';
const timed=[{start:0.125,end:0.875,text:'Hello, 世界!'},{start:1.25,end:1.9,text:'Xin chào.'}];
const interaction=text=>({status:'completed',model,steps:[{type:'model_output',content:[{type:'text',text}]}],usage:{total_input_tokens:20,total_output_tokens:10,total_tokens:30}});
const result=segments=>interaction(JSON.stringify({segments}));
function send(res,status,data) {res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));}

async function fixture(t,{response=result(timed),onInteraction,state='ACTIVE',onPoll,onDelete,onUpload}={}) {
  const failures=[],calls=[],bodies=[];let origin;
  const server=http.createServer(async(req,res)=>{
    try {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const bytes=Buffer.concat(chunks);calls.push(`${req.method} ${req.url}`);
      assert.equal(req.headers['x-goog-api-key'],'private-fixture-key');
      const file={name:'files/selected-audio',uri:`${origin}/v1beta/files/selected-audio`,mimeType:'audio/mp3',state};
      if(req.url==='/upload/v1beta/files') {if(onUpload)return onUpload(req,res);res.writeHead(200,{'x-goog-upload-url':`${origin}/upload/session`});res.end();return;}
      if(req.url==='/upload/session') {assert.ok(bytes.length);send(res,200,{file});return;}
      if(req.method==='DELETE') {if(onDelete)return onDelete(req,res);send(res,200,{});return;}
      if(req.url==='/v1beta/files/selected-audio') {if(onPoll)return onPoll(req,res,file);send(res,200,{...file,state:'ACTIVE'});return;}
      if(req.url.startsWith('/v1beta/models/')) {send(res,200,{name:`models/${decodeURIComponent(req.url.split('/').at(-1))}`});return;}
      assert.equal(req.url,'/v1beta/interactions');
      const body=JSON.parse(bytes);bodies.push(body);
      if(onInteraction)return await onInteraction(req,res,body,bodies.length);
      send(res,200,response);
    } catch(failure) {failures.push(failure);if(!res.headersSent)res.writeHead(500);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  t.after(()=>assert.deepEqual(failures,[]));
  const directory=await mkdtemp(path.join(tmpdir(),'vietsub-selected-audio-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const audio=path.join(directory,'audio.mp3');await writeFile(audio,'fixture audio');
  return {audio,calls,bodies,origin,options:{model,apiKey:'private-fixture-key',apiBase:`${origin}/v1beta`,uploadBase:`${origin}/upload/v1beta`,duration:2,retryDelayMs:1,maxRetryDelayMs:1,validationRetryDelayMs:1,pollDelayMs:1,timeoutMs:1000,cleanupTimeoutMs:50}};
}

for(const diarization of [false,true]) {
  test(`selected Gemini audio uses the selected model and segment schema with diarization ${diarization}`,async t=>{
    const speakers=timed.map((segment,index)=>({...segment,speaker:`speaker_${index+1}`}));
    const {audio,options,bodies,calls,origin}=await fixture(t,{state:'PROCESSING',response:result(speakers)});
    const output=await transcribe(audio,{...options,diarization});
    const body=bodies[0];assert.equal(body.model,model);assert.equal(body.store,false);
    assert.equal(body.generation_config?.transcription_config,undefined);
    assert.deepEqual(body.input.filter(item=>item.type==='audio'),[{type:'audio',uri:`${origin}/v1beta/files/selected-audio`,mime_type:'audio/mp3'}]);
    const prompt=body.input.find(item=>item.type==='text')?.text;
    assert.match(prompt,/transcrib/i);assert.match(prompt,/seconds/i);assert.match(prompt,/2/);assert.match(prompt,/no speech/i);assert.match(prompt,/untrusted/i);
    assert.equal(body.response_format.type,'text');assert.equal(body.response_format.mime_type,'application/json');
    const schema=body.response_format.schema;assert.equal(schema.type,'object');assert.equal(schema.additionalProperties,false);assert.deepEqual(schema.required,['segments']);
    assert.equal(schema.properties.segments.type,'array');assert.equal(schema.properties.segments.maxItems,10000);
    const item=schema.properties.segments.items;assert.equal(item.additionalProperties,false);
    assert.deepEqual(Object.keys(item.properties).sort(),['end','speaker','start','text']);
    assert.deepEqual(item.properties.start,{type:'number',minimum:0,maximum:2});assert.deepEqual(item.properties.end,{type:'number',minimum:0,maximum:2});
    assert.deepEqual(item.required,diarization?['start','end','text','speaker']:['start','end','text']);
    assert.deepEqual(output.segments,speakers.map(({speaker,...segment},index)=>({id:`s${index+1}`,sourceId:`s${index+1}`,...segment,...(diarization?{speaker}:{})})));
    assert.equal(output.usage.model,model);assert.equal(output.usage.audioSeconds,2);assert.equal(output.usage.total_tokens,30);assert.equal(output.usage.attempts,1);
    assert.deepEqual(calls,['POST /upload/v1beta/files','POST /upload/session','GET /v1beta/files/selected-audio','POST /v1beta/interactions','DELETE /v1beta/files/selected-audio']);
  });
}

const invalidCases=[
  ['malformed JSON',interaction('not JSON'),'RESPONSE_JSON'],
  ['top-level extras',interaction(JSON.stringify({segments:timed,unexpected:'private-fixture-key'})),'RESPONSE_STRUCTURE'],
  ['missing segments',interaction('{}'),'RESPONSE_STRUCTURE'],
  ['non-array segments',interaction('{"segments":{}}'),'RESPONSE_STRUCTURE'],
  ['null segment',result([null]),'INVALID_SEGMENT'],
  ['unknown segment field',result([{...timed[0],id:'unsafe-id'}]),'INVALID_SEGMENT'],
  ['missing text',result([{start:0,end:1}]),'INVALID_SEGMENT'],
  ['empty text',result([{start:0,end:1,text:'  '}]),'INVALID_SEGMENT'],
  ['non-string text',result([{start:0,end:1,text:5}]),'INVALID_SEGMENT'],
  ['negative start',result([{...timed[0],start:-0.1}]),'INVALID_TIMING'],
  ['string timestamp',result([{...timed[0],start:'0.1'}]),'INVALID_TIMING'],
  ['nonfinite timestamp',interaction('{"segments":[{"start":0,"end":1e999,"text":"Hello"}]}'),'INVALID_TIMING'],
  ['missing end',result([{start:0,text:'Hello'}]),'INVALID_TIMING'],
  ['zero duration',result([{start:1,end:1,text:'Hello'}]),'INVALID_TIMING'],
  ['reversed timing',result([{start:1,end:0.5,text:'Hello'}]),'INVALID_TIMING'],
  ['past duration',result([{start:0,end:2.001,text:'Hello'}]),'INVALID_TIMING'],
  ['out of order',result([timed[1],timed[0]]),'OUT_OF_ORDER_TIMING'],
  ['overlap',result([{start:0,end:1,text:'Hello'},{start:0.9,end:1.5,text:'World'}]),'OUT_OF_ORDER_TIMING'],
  ['empty speaker',result([{...timed[0],speaker:' '}]),'INVALID_SEGMENT'],
  ['invalid speaker',result([{...timed[0],speaker:{secret:'private-fixture-key'}}]),'INVALID_SEGMENT'],
  ['oversized speaker',result([{...timed[0],speaker:'s'.repeat(65)}]),'INVALID_SEGMENT'],
  ['speaker control characters',result([{...timed[0],speaker:'speaker\n1'}]),'INVALID_SEGMENT'],
  ['missing required speaker',result(timed),'INVALID_SEGMENT',true],
  ['oversized text',result([{start:0,end:1,text:'x'.repeat(2001)}]),'INVALID_SEGMENT'],
  ['too many segments',result(Array.from({length:10001},()=>timed[0])),'RESPONSE_STRUCTURE'],
  ['incomplete interaction',{...result(timed),status:'incomplete'},'INCOMPLETE_INTERACTION'],
  ['refusal',{...result(timed),steps:[{type:'model_output',content:[{type:'refusal',text:'private-fixture-key'}]}]},'RESPONSE_STRUCTURE'],
  ['empty output',interaction(''),'RESPONSE_JSON'],
];
for(const [label,response,reason,diarization=false] of invalidCases) {
  test(`selected Gemini audio rejects ${label} without replacing the selected model`,async t=>{
    const {audio,options,bodies,calls}=await fixture(t,{response});
    await assert.rejects(transcribe(audio,{...options,diarization}),failure=>{
      assert.equal(failure.code,'AI_INVALID_RESPONSE');assert.equal(failure.validation.reason,reason);
      assert.equal(failure.attempts,2);assert.equal(failure.providerUsage.total_tokens,60);
      assert.doesNotMatch(failure.message,/private-fixture-key/);return true;
    });
    assert.equal(bodies.length,2);assert.ok(bodies.every(body=>body.model===model));
    assert.equal(calls.filter(call=>call==='POST /upload/v1beta/files').length,1);assert.equal(calls.at(-1),'DELETE /v1beta/files/selected-audio');
  });
}

test('selected Gemini audio keeps adjacent exact provider spans and source text trimming',async t=>{
  const {audio,options}=await fixture(t,{response:result([{start:0,end:1,text:'  Hello.  '},{start:1,end:2,text:'World.'}])});
  const output=await transcribe(audio,options);
  assert.deepEqual(output.segments,[{id:'s1',sourceId:'s1',start:0,end:1,text:'Hello.'},{id:'s2',sourceId:'s2',start:1,end:2,text:'World.'}]);
});

test('selected Gemini audio treats a valid empty segment array as no speech without regeneration',async t=>{
  const {audio,options,bodies,calls}=await fixture(t,{response:result([])});
  await assert.rejects(transcribe(audio,options),failure=>{assert.equal(failure.code,'NO_SPEECH');assert.equal(failure.attempts,1);assert.equal(failure.providerUsage.total_tokens,30);return true;});
  assert.equal(bodies.length,1);assert.equal(calls.at(-1),'DELETE /v1beta/files/selected-audio');
});

test('selected Gemini audio regenerates invalid segments using the same file and accounts for HTTP retries',async t=>{
  const {audio,options,bodies,calls}=await fixture(t,{onInteraction:(_,res,__,pass)=>{
    if(pass===1)send(res,503,{error:{status:'UNAVAILABLE'}});
    else send(res,200,pass===2?result([{start:-1,end:1,text:'Hello'}]):result(timed));
  }});
  const output=await transcribe(audio,options);assert.equal(output.usage.attempts,3);assert.equal(output.usage.validationAttempts,2);assert.equal(output.usage.total_tokens,60);
  assert.deepEqual(output.usage.validationFailures,[{reason:'INVALID_TIMING',index:0}]);
  assert.equal(bodies.length,3);assert.ok(bodies.every(body=>body.model===model));assert.equal(calls.filter(call=>call==='POST /upload/v1beta/files').length,1);
});

for(const [status,code] of [[400,'AI_AUDIO_UNSUPPORTED'],[403,'AI_MODEL_ACCESS'],[404,'AI_MODEL_ACCESS']]) {
  test(`selected Gemini audio ${status} stops without another model or generation`,async t=>{
    const {audio,options,bodies,calls}=await fixture(t,{onInteraction:(_,res)=>send(res,status,{error:{status:'INVALID_ARGUMENT',message:'private-fixture-key unsupported audio model'}})});
    await assert.rejects(transcribe(audio,options),failure=>{assert.equal(failure.code,code);assert.doesNotMatch(failure.message,/private-fixture-key/);return true;});
    assert.equal(bodies.length,1);assert.equal(bodies[0].model,model);assert.equal(calls.at(-1),'DELETE /v1beta/files/selected-audio');
  });
}

test('selected Gemini audio upload rejection keeps its original request error',async t=>{
  const {audio,options,bodies,calls}=await fixture(t,{onUpload:(_,res)=>send(res,400,{error:{status:'INVALID_ARGUMENT',message:'private-fixture-key'}})});
  await assert.rejects(transcribe(audio,options),{code:'AI_REQUEST'});
  assert.equal(bodies.length,0);assert.deepEqual(calls,['POST /upload/v1beta/files']);
});

for(const [status,details,code,attempts] of [
  [400,{status:'INVALID_ARGUMENT',details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:'API_KEY_INVALID'}]},'AI_AUTH',1],
  [429,{status:'RESOURCE_EXHAUSTED',details:[{'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaValue:'0'}]}]},'AI_QUOTA',1],
  [429,{status:'RESOURCE_EXHAUSTED'},'AI_RATE_LIMIT',3],
  [503,{status:'UNAVAILABLE'},'AI_UNAVAILABLE',3],
]) {
  test(`selected Gemini audio preserves ${code} and bounded retry attempts`,async t=>{
    const {audio,options,bodies,calls}=await fixture(t,{onInteraction:(_,res)=>send(res,status,{error:{...details,message:'private-fixture-key'}})});
    await assert.rejects(transcribe(audio,options),failure=>{assert.equal(failure.code,code);assert.equal(failure.attempts,attempts);assert.doesNotMatch(failure.message,/private-fixture-key/);return true;});
    assert.equal(bodies.length,attempts);assert.ok(bodies.every(body=>body.model===model));assert.equal(calls.at(-1),'DELETE /v1beta/files/selected-audio');
  });
}

test('selected Gemini audio cancellation during regeneration retains usage and deletes the uploaded file',async t=>{
  const controller=new AbortController();
  const {audio,options,bodies,calls}=await fixture(t,{onInteraction:(_,res,__,pass)=>{
    if(pass===1)send(res,200,result([{start:-1,end:1,text:'Hello'}]));
    else {controller.abort(Object.assign(new Error('Stopped'),{code:'JOB_CANCELLED'}));res.destroy();}
  }});
  await assert.rejects(transcribe(audio,{...options,signal:controller.signal}),failure=>{
    assert.equal(failure.code,'JOB_CANCELLED');assert.equal(failure.attempts,2);assert.equal(failure.providerUsage.total_tokens,30);
    assert.deepEqual(failure.validationFailures,[{reason:'INVALID_TIMING',index:0}]);return true;
  });
  assert.equal(bodies.length,2);assert.equal(calls.at(-1),'DELETE /v1beta/files/selected-audio');
});

test('selected Gemini audio cleanup timeout preserves valid exact timestamps',async t=>{
  const {audio,options}=await fixture(t,{onDelete:()=>{}});
  const output=await transcribe(audio,{...options,cleanupTimeoutMs:10});
  assert.deepEqual(output.segments.map(({start,end})=>({start,end})),[{start:0.125,end:0.875},{start:1.25,end:1.9}]);
});

test('selected Gemini audio chunking sends every part to the same selected model and namespaces speakers',async t=>{
  const {audio,options,bodies,calls}=await fixture(t,{response:result([{start:0.125,end:0.875,text:'Hello.',speaker:'speaker_1'}])});
  await runProcess(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','anullsrc=r=8000:cl=mono','-t','1800.25','-c:a','libmp3lame','-b:a','8k','-y',audio]);
  const output=await transcribe(audio,{...options,duration:1800.25,diarization:true});
  assert.equal(bodies.length,2);assert.ok(bodies.every(body=>body.model===model));
  assert.deepEqual(output.segments,[{id:'s1',sourceId:'s1',start:0.125,end:0.875,text:'Hello.',speaker:'chunk1:speaker_1'},{id:'s2',sourceId:'s2',start:1200.125,end:1200.875,text:'Hello.',speaker:'chunk2:speaker_1'}]);
  assert.equal(output.usage.audioSeconds,1800.25);assert.equal(output.usage.total_tokens,60);assert.equal(calls.filter(call=>call.startsWith('DELETE')).length,2);
});

test('connection test uses only the selected model when a separate transcription model is omitted',async t=>{
  const {options,calls}=await fixture(t);
  const output=await testAiConnection(options);assert.equal(output.transcriptionModel,model);assert.equal(output.translationModel,model);
  assert.deepEqual(calls,[`GET /v1beta/models/${model}`]);assert.doesNotMatch(output.message,/hai mô hình/);
});
