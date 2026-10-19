import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import {runProcess} from '../lib/process.mjs';
import {transcribe,translateSegments,testAiConnection,generateStructured} from '../lib/openai.mjs';

const segments=[{id:'s1',sourceId:'original-1',start:0.1,end:1,text:'Hello'},{id:'s2',start:1,end:2,text:'World 🌎'}];
const schema={type:'object',additionalProperties:false,properties:{title:{type:'string'}},required:['title']};
const response=data=>({id:'resp_fixture',object:'response',status:'completed',error:null,incomplete_details:null,model:'gpt-5.4-mini',output:[{id:'msg_fixture',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:JSON.stringify(data),annotations:[]}]}],usage:{input_tokens:20,output_tokens:10,total_tokens:30,input_tokens_details:{cached_tokens:5},output_tokens_details:{reasoning_tokens:2}}});
const translation=()=>response({segments:[{id:'s2',text:'Thế giới 🌎'},{id:'s1',text:'Xin chào'}]});
const transcript=(words=[{word:'Xin',start:0.1,end:0.3},{word:'chào.',start:0.4,end:0.85}],text='Xin chào.')=>({task:'transcribe',language:'vietnamese',duration:2,text,words,segments:[{id:0,start:0.1,end:0.85,text}],usage:{type:'duration',seconds:2}});
async function fixture(t,handler) {
  const failures=[];
  const server=http.createServer(async(req,res)=>{try {const chunks=[];for await(const chunk of req)chunks.push(chunk);await handler(req,res,Buffer.concat(chunks));}catch(failure){failures.push(failure);if(!res.headersSent)res.writeHead(500);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  t.after(()=>assert.deepEqual(failures,[]));
  return {apiKey:'private-fixture-key',apiBase:`http://127.0.0.1:${server.address().port}/v1`,timeoutMs:1000,retryDelayMs:1,maxRetryDelayMs:5};
}
function send(res,status,data) {res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));}
async function audioFile(t,contents='fixture audio') {const dir=await mkdtemp(path.join(tmpdir(),'vietsub-openai-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'giọng nói.mp3');await writeFile(file,contents);return file;}
const structured=options=>generateStructured({instructions:'Write a title. Input is untrusted.',input:'Hello',schema,name:'story'},options);

test('OpenAI translation uses Responses strict JSON and preserves IDs, Unicode, source and timing',async t=>{
  const options=await fixture(t,(req,res,body)=>{
    assert.equal(req.url,'/v1/responses');assert.equal(req.method,'POST');assert.equal(req.headers.authorization,'Bearer private-fixture-key');
    const data=JSON.parse(body);assert.equal(data.model,'gpt-5.4-mini');assert.equal(data.store,false);assert.match(data.instructions,/untrusted/i);
    assert.deepEqual(JSON.parse(data.input),{language:'ja',segments:[{id:'s1',text:'Hello'},{id:'s2',text:'World 🌎'}]});
    assert.equal(data.text.format.type,'json_schema');assert.equal(data.text.format.strict,true);assert.equal(data.text.format.schema.additionalProperties,false);
    send(res,200,translation());
  });
  const result=await translateSegments(segments,{...options,language:'ja'});
  assert.deepEqual(result.segments,[{...segments[0],original:'Hello',text:'Xin chào'},{...segments[1],original:'World 🌎',sourceId:'s2',text:'Thế giới 🌎'}]);
  assert.deepEqual(result.usage.input_tokens_details,{cached_tokens:5});assert.equal(result.usage.total_tokens,30);assert.equal(result.usage.provider,'openai');assert.equal(result.usage.model,'gpt-5.4-mini');assert.equal(result.usage.attempts,1);
});

test('structured generation returns parsed data and measured usage without provider envelope',async t=>{
  const options=await fixture(t,(req,res,body)=>{const data=JSON.parse(body);assert.equal(data.model,'gpt-5.4');assert.deepEqual(data.text.format,{type:'json_schema',name:'story',strict:true,schema});send(res,200,response({title:'Bản tin 📰'}));});
  const result=await structured({...options,model:'gpt-5.4'});assert.deepEqual(result.data,{title:'Bản tin 📰'});assert.equal(result.usage.input_tokens,20);assert.equal(result.usage.provider,'openai');assert.equal(result.model,'gpt-5.4-mini');assert.equal(result.attempts,1);assert.ok(result.elapsedMs>=0);assert.equal(result.output,undefined);
});

test('structured generation preserves typed user text and inline reference images in Responses input',async t=>{
  const input=[{role:'user',content:[{type:'input_text',text:'Use this reference for the story.'},{type:'input_image',image_url:'data:image/png;base64,aGVsbG8='}]}];
  let requests=0;const options=await fixture(t,(req,res,body)=>{requests++;const data=JSON.parse(body);assert.equal(req.url,'/v1/responses');assert.deepEqual(data.input,input);assert.equal(data.store,false);assert.equal(data.text.format.strict,true);send(res,200,response({title:'Reference story'}));});
  const result=await generateStructured({instructions:'Write a story from the user brief and reference image.',input,schema,name:'story'},options);
  assert.deepEqual(result.data,{title:'Reference story'});assert.equal(requests,1);
});
for(const [label,input] of [
  ['tool call',[{type:'function_call',name:'untrusted_tool',arguments:'{}'}]],
  ['tool message',[{role:'tool',content:[{type:'input_text',text:'Unexpected'}]}]],
  ['empty message',[{role:'user',content:[]}]],
  ['unknown content',[{role:'user',content:[{type:'input_audio',data:'private'}]}]],
  ['remote image',[{role:'user',content:[{type:'input_image',image_url:'https://attacker.invalid/image.png'}]}]],
])test(`structured generation rejects unsupported ${label} input before requesting`,async t=>{
  let requests=0;const options=await fixture(t,(_,res)=>{requests++;send(res,200,response({title:'Unexpected'}));});await assert.rejects(generateStructured({instructions:'Write a title.',input,schema,name:'story'},options),{code:'AI_REQUEST'});assert.equal(requests,0);
});

for(const [label,changes] of [
  ['incomplete',{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}],
  ['failed',{status:'failed',error:{message:'private-fixture-key'}}],
  ['refusal',{output:[{type:'message',status:'completed',role:'assistant',content:[{type:'refusal',refusal:'private-fixture-key'}]}]}],
  ['missing output',{output:[]}],['unfinished message',{output:[{type:'message',status:'in_progress',role:'assistant',content:[{type:'output_text',text:'{"title":"X"}'}]}]}],
  ['non JSON',{output:[{type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'not JSON private-fixture-key'}]}]}],
])test(`structured generation rejects ${label} with redacted errors`,async t=>{const options=await fixture(t,(_,res)=>send(res,200,{...response({title:'X'}),...changes}));await assert.rejects(structured(options),failure=>failure.code==='AI_INVALID_RESPONSE'&&!failure.message.includes('private-fixture-key'));});

test('structured generation ignores reasoning metadata and never returns reasoning text',async t=>{
  const value=response({title:'Public'});value.output.unshift({id:'rs_fixture',type:'reasoning',summary:[{type:'summary_text',text:'private reasoning'}]});
  const options=await fixture(t,(_,res)=>send(res,200,value));const result=await structured(options);assert.deepEqual(result.data,{title:'Public'});assert.doesNotMatch(JSON.stringify(result),/private reasoning/);
});
for(const [label,data] of [['missing field',{}],['wrong type',{title:42}],['extra field',{title:'X',secret:'private'}],['null',null]])test(`structured generation rejects schema ${label}`,async t=>{const options=await fixture(t,(_,res)=>send(res,200,response(data)));await assert.rejects(structured(options),{code:'AI_INVALID_RESPONSE'});});

for(const [label,value] of [['missing',[{id:'s1',text:'A'}]],['duplicate',[{id:'s1',text:'A'},{id:'s1',text:'B'}]],['unknown',[{id:'s1',text:'A'},{id:'other',text:'B'}]],['empty',[{id:'s1',text:' '},{id:'s2',text:'B'}]],['extra fields',[{id:'s1',text:'A',extra:true},{id:'s2',text:'B'}]]])test(`translation rejects ${label} output`,async t=>{const options=await fixture(t,(_,res)=>send(res,200,response({segments:value})));await assert.rejects(translateSegments(segments,options),{code:'AI_INVALID_RESPONSE'});});

test('transcription sends multipart whisper word timestamps and groups only true word spans',async t=>{
  const audio=await audioFile(t);const options=await fixture(t,(req,res,body)=>{
    assert.equal(req.url,'/v1/audio/transcriptions');assert.equal(req.method,'POST');assert.equal(req.headers.authorization,'Bearer private-fixture-key');assert.match(req.headers['content-type'],/^multipart\/form-data; boundary=/);
    const data=body.toString();assert.match(data,/name="model"\r\n\r\nwhisper-1/);assert.match(data,/name="response_format"\r\n\r\nverbose_json/);assert.match(data,/name="timestamp_granularities\[\]"\r\n\r\nword/);assert.match(data,/name="file"; filename="audio.mp3"/);assert.match(data,/fixture audio/);assert.doesNotMatch(data,/giọng nói/);
    send(res,200,transcript());
  });
  const result=await transcribe(audio,{...options,duration:2});assert.deepEqual(result.segments,[{id:'s1',sourceId:'s1',start:0.1,end:0.85,text:'Xin chào.'}]);assert.equal(result.usage.provider,'openai');assert.equal(result.usage.model,'whisper-1');assert.equal(result.usage.audioSeconds,2);assert.equal(result.usage.seconds,2);
});
test('transcription groups punctuation and pauses without estimated offsets',async t=>{
  const words=[{word:'Hello,',start:0.1,end:0.35},{word:'世界!',start:0.4,end:0.8},{word:'Xin',start:1.5,end:1.7},{word:'chào',start:1.8,end:2}];
  const options=await fixture(t,(_,res)=>send(res,200,transcript(words,'Hello, 世界! Xin chào')));const result=await transcribe(await audioFile(t),{...options,duration:3});assert.deepEqual(result.segments,[{id:'s1',sourceId:'s1',start:0.1,end:0.8,text:'Hello, 世界!'},{id:'s2',sourceId:'s2',start:1.5,end:2,text:'Xin chào'}]);
});
test('transcription bounds subtitle size and duration using received timestamps',async t=>{
  const words=Array.from({length:32},(_,i)=>({word:'hello',start:i/4,end:i/4+0.2}));const options=await fixture(t,(_,res)=>send(res,200,transcript(words,words.map(w=>w.word).join(' '))));const result=await transcribe(await audioFile(t),{...options,duration:9});assert.ok(result.segments.length>=3);assert.equal(result.segments.map(s=>s.text).join(' '),words.map(w=>w.word).join(' '));for(const s of result.segments){assert.ok(s.text.length<=84);assert.ok(s.end-s.start<=6);assert.ok(words.some(w=>w.start===s.start));assert.ok(words.some(w=>w.end===s.end));}
});
for(const [label,value,code] of [
  ['silence',transcript([],''),'NO_SPEECH'],['missing words',{text:'Hello'},'AI_INVALID_RESPONSE'],
  ['no timestamp',transcript([{word:'Hello',end:1}],'Hello'),'AI_INVALID_RESPONSE'],
  ['negative',transcript([{word:'Hello',start:-0.1,end:1}],'Hello'),'AI_INVALID_RESPONSE'],
  ['string timestamp',transcript([{word:'Hello',start:'0',end:1}],'Hello'),'AI_INVALID_RESPONSE'],
  ['zero span',transcript([{word:'Hello',start:1,end:1}],'Hello'),'AI_INVALID_RESPONSE'],
  ['past duration',transcript([{word:'Hello',start:0,end:3}],'Hello'),'AI_INVALID_RESPONSE'],
  ['overlap',transcript([{word:'Hello',start:0,end:1},{word:'world',start:0.9,end:1.2}],'Hello world'),'AI_INVALID_RESPONSE'],
  ['missing content',transcript([{word:'Hello',start:0,end:1}],'Hello world'),'AI_INVALID_RESPONSE'],
  ['empty word',transcript([{word:' ',start:0,end:1}],'Hello'),'AI_INVALID_RESPONSE'],
])test(`transcription rejects ${label}`,async t=>{const options=await fixture(t,(_,res)=>send(res,200,value));await assert.rejects(transcribe(await audioFile(t),{...options,duration:2}),{code});});

test('invalid duration, empty audio, unsupported transcription model and missing key cause no external work',async t=>{
  let requests=0;const options=await fixture(t,(_,res)=>{requests++;send(res,200,transcript());});const file=await audioFile(t);
  for(const duration of [undefined,0,-1,NaN,Infinity])await assert.rejects(transcribe(file,{...options,duration}),{code:'AI_INVALID_SEGMENTS'});
  await assert.rejects(transcribe(await audioFile(t,''),{...options,duration:1}),{code:'AUDIO_TOO_LARGE'});await assert.rejects(transcribe(file,{...options,duration:1,model:'gpt-4o-transcribe'}),{code:'AI_MODEL_ACCESS'});await assert.rejects(structured({...options,apiKey:''}),{code:'AI_NOT_CONFIGURED'});assert.equal(requests,0);
});

test('long Whisper transcription splits a local source and returns the complete source timeline',async t=>{
  const audio=await audioFile(t);await runProcess(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','anullsrc=r=8000:cl=mono','-t','1800.25','-c:a','libmp3lame','-b:a','8k','-y',audio]);
  let parts=0;
  const options=await fixture(t,(req,res,body)=>{parts++;assert.equal(req.url,'/v1/audio/transcriptions');assert.ok(body.length<25_000_000);send(res,200,transcript());});
  const result=await transcribe(audio,{...options,duration:1800.25});
  assert.equal(parts,2);assert.deepEqual(result.segments,[{id:'s1',sourceId:'s1',start:0.1,end:0.85,text:'Xin chào.'},{id:'s2',sourceId:'s2',start:1200.1,end:1200.85,text:'Xin chào.'}]);
  assert.equal(result.usage.audioSeconds,1800.25);assert.equal(result.usage.attempts,2);assert.equal(result.usage.seconds,4);
});

test('silent Whisper responses retain measured provider usage and attempts',async t=>{
  const options=await fixture(t,(_,res)=>send(res,200,transcript([],'')));
  await assert.rejects(transcribe(await audioFile(t),{...options,duration:2}),failure=>failure.code==='NO_SPEECH'&&failure.attempts===1&&failure.providerUsage.seconds===2);
});

test('an already-expired short Whisper request preserves the safe OpenAI timeout error',async t=>{
  const controller=new AbortController();controller.abort(new DOMException('fixture deadline','TimeoutError'));
  await assert.rejects(transcribe(await audioFile(t),{duration:2,signal:controller.signal}),{code:'AI_TIMEOUT'});
});

test('connection check only retrieves selected text and whisper metadata with no inference',async t=>{
  const calls=[];const options=await fixture(t,(req,res,body)=>{calls.push(`${req.method} ${req.url}`);assert.equal(req.method,'GET');assert.equal(body.length,0);const id=decodeURIComponent(req.url.split('/').at(-1));send(res,200,{id,object:'model',created:1,owned_by:'openai'});});
  assert.deepEqual(await testAiConnection({...options,model:'gpt-5.4'}),{ok:true,provider:'openai',translationModel:'gpt-5.4',transcriptionModel:'whisper-1'});assert.deepEqual(calls,['GET /v1/models/gpt-5.4','GET /v1/models/whisper-1']);
});
test('connection check rejects unrelated or malformed model metadata',async t=>{const options=await fixture(t,(_,res)=>send(res,200,{id:'other',object:'model'}));await assert.rejects(testAiConnection(options),{code:'AI_INVALID_RESPONSE'});});

for(const [status,detail,want,code] of [[401,{},1,'AI_AUTH'],[403,{},1,'AI_MODEL_ACCESS'],[404,{},1,'AI_MODEL_ACCESS'],[429,{code:'insufficient_quota'},1,'AI_QUOTA'],[429,{type:'insufficient_quota'},1,'AI_QUOTA'],[429,{code:'rate_limit_exceeded'},3,'AI_RATE_LIMIT'],[503,{},3,'AI_UNAVAILABLE'],[400,{},1,'AI_REQUEST']])test(`OpenAI maps ${status}/${code}, bounds retries and redacts remote content`,async t=>{
  let calls=0;const options=await fixture(t,(_,res)=>{calls++;send(res,status,{error:{...detail,message:'private-fixture-key C:\\secret\\file'}});});await assert.rejects(structured(options),failure=>failure.code===code&&!failure.message.includes('private-fixture-key')&&!failure.message.includes('C:'));assert.equal(calls,want);
});
test('retryable responses can recover with measured attempt count',async t=>{let calls=0;const options=await fixture(t,(_,res)=>++calls<3?send(res,503,{error:{}}):send(res,200,response({title:'Recovered'})));const result=await structured(options);assert.equal(result.data.title,'Recovered');assert.equal(result.attempts,3);});

for(const [label,cause] of [
  ['EACCES',Object.assign(new Error('private-fixture-key D:\\private'),{code:'EACCES'})],
  ['EPERM',Object.assign(new Error('private-fixture-key D:\\private'),{code:'EPERM'})],
  ['aggregate code',Object.assign(new AggregateError([],'private-fixture-key D:\\private'),{code:'EACCES'})],
  ['nested aggregate',new AggregateError([Object.assign(new Error('socket'),{code:'ECONNRESET'}),new Error('wrapper',{cause:new AggregateError([Object.assign(new Error('private-fixture-key D:\\private'),{code:'EPERM'})])})])],
])test(`OpenAI identifies restricted Internet permission from ${label} without exposing transport details`,async t=>{
  const fetch=t.mock.method(globalThis,'fetch',async()=>{throw new TypeError('private-fixture-key D:\\private',{cause});});
  await assert.rejects(structured({apiKey:'private-fixture-key'}),failure=>{
    assert.equal(failure.code,'AI_NETWORK_BLOCKED');assert.match(failure.message,/quyền truy cập Internet/);assert.match(failure.message,/Khoi-dong\.cmd/);
    assert.equal(failure.attempts,1);assert.ok(failure.elapsedMs>=0);assert.equal(failure.cause,undefined);
    assert.doesNotMatch(`${failure.stack} ${JSON.stringify(failure)}`,/private-fixture-key|D:\\private|EACCES|EPERM|ECONNRESET/);return true;
  });
  assert.equal(fetch.mock.callCount(),1);
});

test('OpenAI leaves unrelated and cyclic transport failures as generic connection errors',async t=>{
  const cause=Object.assign(new Error('private-fixture-key EACCES is only text'),{code:'ECONNRESET'});cause.cause=cause;
  t.mock.method(globalThis,'fetch',async()=>{throw new TypeError('fetch failed',{cause});});
  await assert.rejects(structured({apiKey:'private-fixture-key'}),failure=>failure.code==='AI_CONNECTION'&&!failure.message.includes('private-fixture-key'));
});

test('custom URLs never receive keys and redirects are never followed',async t=>{
  for(const apiBase of ['https://attacker.invalid/v1','http://api.openai.com/v1','https://api.openai.com/v2','http://127.0.0.1:1/v1?key=x','http://user:pass@127.0.0.1:1/v1'])await assert.rejects(structured({apiKey:'private-fixture-key',apiBase}),{code:'AI_INVALID_RESPONSE'});
  let redirected=0;const destination=await fixture(t,(_,res)=>{redirected++;send(res,200,response({title:'Leaked'}));});const options=await fixture(t,(_,res)=>{res.writeHead(307,{location:`${destination.apiBase}/responses`});res.end();});await assert.rejects(structured(options),{code:'AI_CONNECTION'});assert.equal(redirected,0);
});
test('timeouts and caller cancellation terminate requests without remote error details',async t=>{
  const options=await fixture(t,()=>{});const started=Date.now();await assert.rejects(structured({...options,timeoutMs:20}),{code:'AI_TIMEOUT'});assert.ok(Date.now()-started<1000);
  const controller=new AbortController();const pending=structured({...options,signal:controller.signal});setTimeout(()=>controller.abort(),20);await assert.rejects(pending,failure=>failure.name==='AbortError');
});
test('OpenAI maps a supplied native deadline to a safe AI timeout',async t=>{
  const options=await fixture(t,()=>{});
  await assert.rejects(structured({...options,signal:AbortSignal.timeout(20)}),{code:'AI_TIMEOUT'});
});
test('OpenAI maps an already-aborted deadline to a safe AI timeout before requesting',async t=>{
  const fetch=t.mock.method(globalThis,'fetch',async()=>{throw new Error('must not request');});
  await assert.rejects(structured({apiKey:'private-fixture-key',signal:AbortSignal.abort(new DOMException('private-fixture-key','TimeoutError'))}),failure=>failure.code==='AI_TIMEOUT'&&!failure.message.includes('private-fixture-key'));
  assert.equal(fetch.mock.callCount(),0);
});
test('OpenAI maps a supplied deadline during retry delay to AI timeout',async t=>{
  let calls=0;const options=await fixture(t,(_,res)=>{calls++;send(res,503,{error:{}});});
  await assert.rejects(structured({...options,signal:AbortSignal.timeout(30),retryDelayMs:1000,maxRetryDelayMs:1000}),{code:'AI_TIMEOUT'});assert.equal(calls,1);
});
test('OpenAI preserves the original reason for caller cancellation',async t=>{
  const options=await fixture(t,()=>{}),reason=new Error('private cancellation reason');
  await assert.rejects(structured({...options,signal:AbortSignal.abort(reason)}),failure=>failure===reason);
  const controller=new AbortController(),pending=structured({...options,signal:controller.signal});setTimeout(()=>controller.abort(reason),20);
  await assert.rejects(pending,failure=>failure===reason);
});
test('OpenAI preserves the original caller cancellation reason during retry delay',async t=>{
  const controller=new AbortController(),reason=new Error('private cancellation reason');let calls=0;
  const options=await fixture(t,(_,res)=>{calls++;send(res,503,{error:{}});setTimeout(()=>controller.abort(reason),20);});
  await assert.rejects(structured({...options,signal:controller.signal,retryDelayMs:1000,maxRetryDelayMs:1000}),failure=>failure===reason);assert.equal(calls,1);
});
test('caller cancellation interrupts retry delay',async t=>{let calls=0;const controller=new AbortController();const options=await fixture(t,(_,res)=>{calls++;send(res,503,{error:{}});setTimeout(()=>controller.abort(),20);});await assert.rejects(structured({...options,signal:controller.signal,retryDelayMs:1000,maxRetryDelayMs:1000}),failure=>failure.name==='AbortError');assert.equal(calls,1);});
