import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {transcribe, translateSegments, testAiConnection} from '../lib/ai.mjs';

const segments=[{id:'s1',start:0,end:1,text:'Hello'},{id:'s2',start:1,end:2,text:'World'}];
const interaction=(text,annotations)=>({id:'interactions/fixture',status:'completed',steps:[{type:'model_output',content:[{type:'text',text,...(annotations?{annotations}:{})}]}],usage:{total_input_tokens:20,total_output_tokens:10,total_tokens:30}});
const response=translated=>interaction(JSON.stringify({segments:translated}));
const word=(text,start,end,extra={})=>({type:'word_info',text,start_offset:start,end_offset:end,...extra});
async function fixture(t,handler) {
  const failures=[];
  const server=http.createServer(async(req,res)=>{
    try {const chunks=[];for await(const chunk of req) chunks.push(chunk);await handler(req,res,Buffer.concat(chunks));}
    catch(failure) {failures.push(failure);if(!res.headersSent)res.writeHead(500);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  t.after(()=>assert.deepEqual(failures,[]));
  const origin=`http://127.0.0.1:${server.address().port}`;
  return {apiKey:'private-fixture-key',apiBase:`${origin}/v1beta`,uploadBase:`${origin}/upload/v1beta`,retryDelayMs:1,maxRetryDelayMs:10,pollDelayMs:1,timeoutMs:1000,cleanupTimeoutMs:100,origin};
}
function send(res,status,data) {res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));}
async function audioFile(t,contents='fixture audio') {
  const dir=await mkdtemp(path.join(tmpdir(),'vietsub-gemini-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const audio=path.join(dir,'giọng nói.mp3');await writeFile(audio,contents);return audio;
}
async function asrFixture(t,{result=interaction('Xin chào.',[word('Xin','0.100s','0.300s'),word('chào.','0.400s','0.850s')]),state='ACTIVE',onRequest,metadata,uploadUrl}={}) {
  const calls=[];let options;
  options=await fixture(t,async(req,res,body)=>{
    calls.push(`${req.method} ${req.url}`);assert.equal(req.headers.authorization,undefined);assert.equal(req.headers['x-goog-api-key'],'private-fixture-key');
    if(await onRequest?.(req,res,body,options))return;
    const file={name:'files/fixture-audio',uri:`${options.origin}/v1beta/files/fixture-audio`,mimeType:'audio/mp3',state,...metadata};
    if(req.url==='/upload/v1beta/files') {
      assert.equal(req.method,'POST');assert.equal(req.headers['x-goog-upload-protocol'],'resumable');assert.equal(req.headers['x-goog-upload-command'],'start');assert.equal(req.headers['x-goog-upload-header-content-type'],'audio/mp3');
      assert.equal(req.headers['x-goog-upload-header-content-length'],'13');assert.deepEqual(JSON.parse(body),{file:{display_name:'vietsub-audio'}});
      res.writeHead(200,{'x-goog-upload-url':uploadUrl??`${options.origin}/upload/session`});res.end();return;
    }
    if(req.url==='/upload/session') {
      assert.equal(req.method,'POST');assert.equal(req.headers['x-goog-upload-offset'],'0');assert.equal(req.headers['x-goog-upload-command'],'upload, finalize');assert.equal(body.toString(),'fixture audio');send(res,200,{file});return;
    }
    if(req.url==='/v1beta/files/fixture-audio') {
      if(req.method==='DELETE') {send(res,200,{});return;}
      assert.equal(req.method,'GET');send(res,200,{...file,state:'ACTIVE'});return;
    }
    assert.equal(req.url,'/v1beta/interactions');assert.equal(req.method,'POST');
    const data=JSON.parse(body);assert.equal(data.model,'gemini-3.5-transcribe');assert.equal(data.store,false);
    assert.deepEqual(data.input,[{type:'audio',uri:file.uri,mime_type:'audio/mp3'}]);
    assert.deepEqual(data.generation_config,{transcription_config:{mode:{type:'verbatim',timestamp_granularities:['word']}}});
    send(res,200,result);
  });
  return {options,calls};
}

test('Gemini translation sends documented structured output and maps Unicode IDs without changing timing',async t=>{
  const options=await fixture(t,(req,res,body)=>{
    assert.equal(req.url,'/v1beta/interactions');assert.equal(req.headers['x-goog-api-key'],'private-fixture-key');assert.equal(req.headers.authorization,undefined);
    const data=JSON.parse(body);assert.equal(data.model,'gemini-3.5-flash-lite');assert.equal(data.store,false);
    assert.deepEqual(JSON.parse(data.input),{language:'vi',segments:[{id:'s1',text:'Hello'},{id:'s2',text:'World'}]});
    assert.match(data.system_instruction,/untrusted/i);assert.equal(data.response_format.type,'text');assert.equal(data.response_format.mime_type,'application/json');
    assert.equal(data.response_format.schema.additionalProperties,false);assert.deepEqual(data.response_format.schema.properties.segments.items.required,['id','text']);
    send(res,200,response([{id:'s2',text:'Thế giới 🌎'},{id:'s1',text:'Xin chào'}]));
  });
  const result=await translateSegments(segments,{...options,model:'gemini-3.5-flash-lite',language:'vi'});
  assert.deepEqual(result.segments,[{...segments[0],text:'Xin chào',original:'Hello',sourceId:'s1'},{...segments[1],text:'Thế giới 🌎',original:'World',sourceId:'s2'}]);
  assert.equal(result.usage.total_tokens,30);assert.equal(result.usage.input_tokens,20);assert.equal(result.usage.output_tokens,10);assert.equal(result.usage.attempts,1);
  assert.equal(result.usage.provider,'gemini');assert.equal(result.usage.model,'gemini-3.5-flash-lite');
});
test('documented thought and user input steps never become translated output',async t=>{
  const options=await fixture(t,(_,res)=>send(res,200,{...response([{id:'s1',text:'A'},{id:'s2',text:'B'}]),steps:[{type:'user_input',content:[{type:'text',text:'private source instructions'}]},{type:'thought',signature:'thought_sig_fixture',summary:[{type:'text',text:'private reasoning'}]},...response([{id:'s1',text:'A'},{id:'s2',text:'B'}]).steps]}));
  const result=await translateSegments(segments,options);assert.deepEqual(result.segments.map(s=>s.text),['A','B']);assert.doesNotMatch(JSON.stringify(result),/private/);
});
for(const [label,translated] of [['missing',[{id:'s1',text:'A'}]],['duplicate',[{id:'s1',text:'A'},{id:'s1',text:'B'}]],['extra',[{id:'s1',text:'A'},{id:'s2',text:'B'},{id:'s3',text:'C'}]],['empty',[{id:'s1',text:' '},{id:'s2',text:'B'}]],['unknown',[{id:'s1',text:'A'},{id:'unknown',text:'B'}]],['fields',[{id:'s1',text:'A',extra:true},{id:'s2',text:'B'}]]]) {
  test(`rejects ${label} translated segment IDs or content`,async t=>{
    const options=await fixture(t,(_,res)=>send(res,200,response(translated)));
    await assert.rejects(translateSegments(segments,options),{code:'AI_INVALID_RESPONSE'});
  });
}
for(const [status,details,want,code] of [
  [400,{status:'INVALID_ARGUMENT',details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:'API_KEY_INVALID'}]},1,'AI_AUTH'],
  [401,{status:'UNAUTHENTICATED'},1,'AI_AUTH'],[403,{status:'PERMISSION_DENIED'},1,'AI_MODEL_ACCESS'],
  [429,{status:'RESOURCE_EXHAUSTED',details:[{'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaValue:'0'}]}]},1,'AI_QUOTA'],
  [429,{status:'RESOURCE_EXHAUSTED',details:[{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'1s'}]},3,'AI_RATE_LIMIT'],
  [503,{status:'UNAVAILABLE'},3,'AI_UNAVAILABLE']]) {
  test(`Gemini ${status}/${code} makes ${want} attempts and redacts provider errors`,async t=>{
    let requests=0;const options=await fixture(t,(_,res)=>{requests++;send(res,status,{error:{...details,message:'private-fixture-key C:\\secret\\file'}});});
    await assert.rejects(translateSegments(segments,options),failure=>failure.code===code&&!failure.message.includes('private-fixture-key')&&!failure.message.includes('C:'));
    assert.equal(requests,want);
  });
}
test('temporary Gemini failures retry then succeed with actual attempt usage',async t=>{
  let requests=0;const options=await fixture(t,(_,res)=>++requests<3?send(res,503,{error:{status:'UNAVAILABLE'}}):send(res,200,response([{id:'s1',text:'A'},{id:'s2',text:'B'}])));
  assert.equal((await translateSegments(segments,options)).usage.attempts,3);
});
test('transcription uploads bytes, polls processing, uses real word offsets and deletes owned upload',async t=>{
  const audio=await audioFile(t);const {options,calls}=await asrFixture(t,{state:'PROCESSING'});
  const result=await transcribe(audio,{...options,duration:2,model:'gemini-3.5-transcribe'});
  assert.deepEqual(result.segments,[{id:'s1',sourceId:'s1',start:0.1,end:0.85,text:'Xin chào.'}]);assert.equal(result.usage.audioSeconds,2);assert.equal(result.usage.total_tokens,30);assert.equal(result.usage.provider,'gemini');assert.equal(result.usage.model,'gemini-3.5-transcribe');
  assert.deepEqual(calls,['POST /upload/v1beta/files','POST /upload/session','GET /v1beta/files/fixture-audio','POST /v1beta/interactions','DELETE /v1beta/files/fixture-audio']);
});
test('subtitle grouping respects punctuation, pauses and speaker turns, retaining exact first and last offsets',async t=>{
  const audio=await audioFile(t);const words=[word('Hello,','0.100s','0.350s'),word('世界!','0.400s','0.800s'),word('Xin','1.500s','1.700s'),word('chào','1.800s','2.000s'),word('bạn','2.100s','2.300s',{speaker:'spk_2'})];
  const {options}=await asrFixture(t,{result:interaction('Hello, 世界! Xin chào bạn',words)});
  const result=await transcribe(audio,{...options,duration:3});
  assert.deepEqual(result.segments,[{id:'s1',sourceId:'s1',start:0.1,end:0.8,text:'Hello, 世界!'},{id:'s2',sourceId:'s2',start:1.5,end:2,text:'Xin chào'},{id:'s3',sourceId:'s3',start:2.1,end:2.3,text:'bạn'}]);
});
test('long word streams are grouped to bounded subtitle lengths without inventing offsets',async t=>{
  const audio=await audioFile(t);const words=Array.from({length:32},(_,i)=>word('hello',`${i/4}s`,`${i/4+0.2}s`));const {options}=await asrFixture(t,{result:interaction(words.map(w=>w.text).join(' '),words)});
  const result=await transcribe(audio,{...options,duration:9});assert.ok(result.segments.length>=3);
  assert.equal(result.segments.map(s=>s.text).join(' '),words.map(w=>w.text).join(' '));
  for(const segment of result.segments) {assert.ok(segment.text.length<=84);assert.ok(segment.end-segment.start<=6);assert.ok(words.some(w=>Number.parseFloat(w.start_offset)===segment.start));assert.ok(words.some(w=>Number.parseFloat(w.end_offset)===segment.end));}
});
for(const [label,words,want] of [
  ['leading',[word('Start','0.100s','0.100s'),word('here.','0.100s','0.600s')],[{start:0.1,end:0.6,text:'Start here.'}]],
  ['trailing',[word('End','0.100s','0.600s'),word('here.','0.600s','0.600s')],[{start:0.1,end:0.6,text:'End here.'}]],
  ['between',[word('Keep','0.100s','0.500s'),word('every','0.500s','0.500s'),word('word.','0.500s','1s')],[{start:0.1,end:1,text:'Keep every word.'}]],
  ['consecutive',[word('Keep','0.100s','0.500s'),word('all','0.500s','0.500s'),word('these','0.500s','0.500s'),word('words.','0.500s','1s')],[{start:0.1,end:1,text:'Keep all these words.'}]],
  ['punctuation',[word('Finish','0.100s','0.500s'),word('now.','0.500s','0.500s'),word('Next.','1s','1.500s')],[{start:0.1,end:0.5,text:'Finish now.'},{start:1,end:1.5,text:'Next.'}]],
  ['leading punctuation',[word('Yes.','0.100s','0.100s'),word('Continue.','0.100s','0.600s')],[{start:0.1,end:0.6,text:'Yes. Continue.'}]],
  ['after sentence break',[word('Done.','0.100s','0.600s'),word('Next','0.600s','0.600s'),word('chapter.','0.600s','0.900s')],[{start:0.1,end:0.6,text:'Done.'},{start:0.6,end:0.9,text:'Next chapter.'}]],
  ['chapter pause',[word('Before.','0.100s','0.600s'),word('New','9s','9s'),word('chapter.','9s','9.500s')],[{start:0.1,end:0.6,text:'Before.'},{start:9,end:9.5,text:'New chapter.'}]],
  ['trailing sentence break',[word('Done.','0.100s','0.600s'),word('Really.','0.600s','0.600s')],[{start:0.1,end:0.6,text:'Done. Really.'}]],
]) {
  test(`transcription preserves ${label} zero-duration words using adjacent provider spans`,async t=>{
    const audio=await audioFile(t);const {options}=await asrFixture(t,{result:interaction(words.map(w=>w.text).join(' '),words)});
    const result=await transcribe(audio,{...options,duration:10});
    assert.deepEqual(result.segments.map(({start,end,text})=>({start,end,text})),want);
    assert.equal(result.segments.map(s=>s.text).join(' '),words.map(w=>w.text).join(' '));
    for(const [index,segment] of result.segments.entries()) {
      assert.ok(segment.end>segment.start);assert.ok(segment.end-segment.start<=6);assert.ok(segment.text.length<=84);
      assert.ok(!index||segment.start>=result.segments[index-1].end);
      assert.ok(words.some(w=>Number.parseFloat(w.start_offset)===segment.start));assert.ok(words.some(w=>Number.parseFloat(w.end_offset)===segment.end));
      assert.ok(words.some(w=>Number.parseFloat(w.end_offset)>Number.parseFloat(w.start_offset)&&Number.parseFloat(w.start_offset)>=segment.start&&Number.parseFloat(w.end_offset)<=segment.end));
    }
  });
}
for(const [label,result,code] of [
  ['silence',interaction('',[]),'NO_SPEECH'],['unannotated text',interaction('Hello',[]),'AI_INVALID_RESPONSE'],
  ['incomplete',{...interaction('Hello',[word('Hello','0s','1s')]),status:'incomplete'},'AI_INVALID_RESPONSE'],
  ['missing start',interaction('Hello',[{type:'word_info',text:'Hello',end_offset:'1s'}]),'AI_INVALID_RESPONSE'],
  ['nonfinite',interaction('Hello',[word('Hello','NaNs','1s')]),'AI_INVALID_RESPONSE'],
  ['negative',interaction('Hello',[word('Hello','-0.1s','1s')]),'AI_INVALID_RESPONSE'],
  ['zero duration',interaction('Hello',[word('Hello','1s','1s')]),'AI_INVALID_RESPONSE'],
  ['all zero words',interaction('Hello world',[word('Hello','0s','0s'),word('world','1s','1s')]),'AI_INVALID_RESPONSE'],
  ['reversed',interaction('Hello',[word('Hello','1s','0.5s')]),'AI_INVALID_RESPONSE'],
  ['missing end',interaction('Hello',[{type:'word_info',text:'Hello',start_offset:'0s'}]),'AI_INVALID_RESPONSE'],
  ['past duration',interaction('Hello',[word('Hello','0s','3s')]),'AI_INVALID_RESPONSE'],
  ['out of order',interaction('Hello world',[word('Hello','1s','1.5s'),word('world','0.2s','0.5s')]),'AI_INVALID_RESPONSE'],
  ['overlap',interaction('Hello world',[word('Hello','0s','1s'),word('world','0.8s','1.2s')]),'AI_INVALID_RESPONSE'],
  ['empty word',interaction('Hello',[word(' ','0s','1s')]),'AI_INVALID_RESPONSE'],
  ['lost words',interaction('Hello world',[word('Hello','0s','1s')]),'AI_INVALID_RESPONSE'],
  ['malformed content',{status:'completed',steps:[{type:'model_output',content:[null]}]},'AI_INVALID_RESPONSE']]) {
  test(`transcription rejects ${label} and still deletes uploaded file`,async t=>{
    const audio=await audioFile(t);const {options,calls}=await asrFixture(t,{result});
    await assert.rejects(transcribe(audio,{...options,duration:2}),{code});assert.equal(calls.at(-1),'DELETE /v1beta/files/fixture-audio');
  });
}
test('invalid duration and empty audio fail before any external work',async t=>{
  let requests=0;const options=await fixture(t,(_,res)=>{requests++;send(res,200,{});});const audio=await audioFile(t);
  for(const duration of [undefined,0,-1,NaN,Infinity,1801])await assert.rejects(transcribe(audio,{...options,duration}),{code:'AI_INVALID_SEGMENTS'});
  const empty=await audioFile(t,'');await assert.rejects(transcribe(empty,{...options,duration:1}),{code:'AUDIO_TOO_LARGE'});assert.equal(requests,0);
});
test('failed file processing cleans up without transcribing',async t=>{
  const audio=await audioFile(t);const {options,calls}=await asrFixture(t,{state:'FAILED'});
  await assert.rejects(transcribe(audio,{...options,duration:2}),{code:'AI_REQUEST'});assert.equal(calls.at(-1),'DELETE /v1beta/files/fixture-audio');assert.ok(!calls.includes('POST /v1beta/interactions'));
});
test('processing timeout remains bounded and deletes the file',async t=>{
  const audio=await audioFile(t);const {options,calls}=await asrFixture(t,{state:'PROCESSING',onRequest:(req,res,_,opts)=>{if(req.method==='GET') {send(res,200,{name:'files/fixture-audio',uri:`${opts.origin}/v1beta/files/fixture-audio`,mimeType:'audio/mp3',state:'PROCESSING'});return true;}}});
  await assert.rejects(transcribe(audio,{...options,duration:2,processingTimeoutMs:20}),{code:'AI_TIMEOUT'});assert.equal(calls.at(-1),'DELETE /v1beta/files/fixture-audio');
});
test('processing deadline also interrupts transient polling retries',async t=>{
  const audio=await audioFile(t);const {options,calls}=await asrFixture(t,{state:'PROCESSING',onRequest:(req,res)=>{if(req.method==='GET') {send(res,503,{error:{status:'UNAVAILABLE'}});return true;}}});const started=Date.now();
  await assert.rejects(transcribe(audio,{...options,duration:2,processingTimeoutMs:30,retryDelayMs:200,maxRetryDelayMs:200}),{code:'AI_TIMEOUT'});assert.ok(Date.now()-started<250);assert.equal(calls.at(-1),'DELETE /v1beta/files/fixture-audio');
});
test('caller abort during transcription still runs independent cleanup',async t=>{
  const audio=await audioFile(t);const controller=new AbortController();const {options,calls}=await asrFixture(t,{onRequest:(req)=>{if(req.url==='/v1beta/interactions') {controller.abort();return true;}}});
  await assert.rejects(transcribe(audio,{...options,duration:2,signal:controller.signal}),failure=>failure.name==='AbortError');assert.equal(calls.at(-1),'DELETE /v1beta/files/fixture-audio');
});
test('cleanup timeout does not erase a valid transcript or wait indefinitely',async t=>{
  const audio=await audioFile(t);const {options}=await asrFixture(t,{onRequest:(req)=>req.method==='DELETE'});const started=Date.now();
  const result=await transcribe(audio,{...options,duration:2,cleanupTimeoutMs:20});assert.equal(result.segments[0].text,'Xin chào.');assert.ok(Date.now()-started<1000);
});
test('untrusted upload URLs never receive a key or audio',async t=>{
  const audio=await audioFile(t);const {options,calls}=await asrFixture(t,{uploadUrl:'https://attacker.invalid/upload'});
  await assert.rejects(transcribe(audio,{...options,duration:2}),{code:'AI_INVALID_RESPONSE'});assert.deepEqual(calls,['POST /upload/v1beta/files']);
});
test('untrusted file URI is rejected while safe owned resource is deleted',async t=>{
  const audio=await audioFile(t);const {options,calls}=await asrFixture(t,{metadata:{uri:'https://attacker.invalid/file'}});
  await assert.rejects(transcribe(audio,{...options,duration:2}),{code:'AI_INVALID_RESPONSE'});assert.equal(calls.at(-1),'DELETE /v1beta/files/fixture-audio');assert.ok(!calls.includes('POST /v1beta/interactions'));
});
test('timeouts and caller abort bound translation requests',async t=>{
  const options=await fixture(t,()=>{});await assert.rejects(translateSegments(segments,{...options,timeoutMs:20}),{code:'AI_TIMEOUT'});
  const controller=new AbortController();const pending=translateSegments(segments,{...options,signal:controller.signal});controller.abort();await assert.rejects(pending,failure=>failure.name==='AbortError');
});
const validTranslation=[{id:'s1',text:'A'},{id:'s2',text:'B'}];
for(const [label,result] of [['incomplete',{...response(validTranslation),status:'incomplete'}],['failed',{...response(validTranslation),status:'failed'}],['refusal',interaction(JSON.stringify({segments:validTranslation}),[{type:'refusal'}])],['safety',{...response(validTranslation),error:{code:'SAFETY'}}],['nontext',{...response(validTranslation),steps:[{type:'model_output',content:[{type:'image',data:'x'}]}]}],['bad JSON',interaction('oops')],['null',null],['bad step',{status:'completed',steps:[null]}],['bad content',{status:'completed',steps:[{type:'model_output',content:[null]}]}]]) {
  test(`translation rejects ${label} response envelopes`,async t=>{
    const options=await fixture(t,(_,res)=>send(res,200,result));await assert.rejects(translateSegments(segments,options),{code:'AI_INVALID_RESPONSE'});
  });
}
test('invalid source segments fail before translation requests',async t=>{
  let requests=0;const options=await fixture(t,(_,res)=>{requests++;send(res,200,response([]));});
  for(const input of [[],[{id:'s1',start:1,end:0,text:'bad'}],[segments[0],segments[0]],[{...segments[0],text:' '}]])await assert.rejects(translateSegments(input,options),{code:'AI_INVALID_SEGMENTS'});assert.equal(requests,0);
});
test('connection test reads access to both selected Gemini models without inference',async t=>{
  const requests=[];const options=await fixture(t,(req,res)=>{requests.push(`${req.method} ${req.url}`);send(res,200,{name:`models/${decodeURIComponent(req.url.split('/').at(-1))}`,supportedGenerationMethods:['generateContent']});});
  const result=await testAiConnection({...options,model:'gemini-custom',transcriptionModel:'gemini-custom-asr'});assert.equal(result.ok,true);assert.match(result.message,/chưa/);
  assert.equal(result.transcriptionModel,'gemini-custom-asr');assert.deepEqual(requests,['GET /v1beta/models/gemini-custom','GET /v1beta/models/gemini-custom-asr']);
});
test('connection test rejects metadata for a different model',async t=>{
  const options=await fixture(t,(_,res)=>send(res,200,{name:'models/wrong'}));await assert.rejects(testAiConnection(options),{code:'AI_INVALID_RESPONSE'});
});
test('public usage maps only measured Gemini token fields',async t=>{
  const options=await fixture(t,(_,res)=>send(res,200,{...response([{id:'s1',text:'A'},{id:'s2',text:'B'}]),usage:{total_input_tokens:20,total_output_tokens:10,total_tokens:30,total_cached_tokens:5,total_thought_tokens:2,input_tokens_by_modality:[{modality:'audio',tokens:11},{modality:'text',tokens:9},{modality:'diagnostic',tokens:9}],diagnostic:'private-fixture-key'}}));
  const {usage}=await translateSegments(segments,options);assert.equal(usage.total_tokens,30);assert.deepEqual(usage.input_tokens_details,{cached_tokens:5,audio_tokens:11,text_tokens:9});assert.deepEqual(usage.output_tokens_details,{reasoning_tokens:2});assert.doesNotMatch(JSON.stringify(usage),/private-fixture-key|diagnostic/);
});

for(const [operation,requested,resolved] of [['transcription','gemini-3.5-transcribe','gemini-3.5-transcribe-001'],['translation','gemini-3.5-flash-lite','gemini-3.5-flash-lite-001']]) {
  for(const [label,returned,useResolved] of [['resolved',resolved,true],['absent',undefined,false],['empty','',false],['unsafe string','private-fixture-key https://attacker.invalid/model',false],['object',{diagnostic:'private-fixture-key'},false]]) {
    test(`${operation} usage handles ${label} provider model metadata without changing the requested model`,async t=>{
      let result;
      if(operation==='transcription') {
        const audio=await audioFile(t);const {options}=await asrFixture(t,{result:{...interaction('Hello.',[word('Hello.','0.1s','0.8s')]),model:returned}});
        result=await transcribe(audio,{...options,duration:2,model:requested});
      } else {
        const options=await fixture(t,(req,res,body)=>{
          assert.equal(req.url,'/v1beta/interactions');assert.equal(JSON.parse(body).model,'gemini-3.5-flash-lite');
          send(res,200,{...response([{id:'s1',text:'A'},{id:'s2',text:'B'}]),model:returned});
        });
        result=await translateSegments(segments,{...options,model:requested});
      }
      assert.equal(result.usage.model,useResolved?resolved:requested);assert.equal(result.usage.provider,'gemini');
      assert.equal(result.usage.input_tokens,20);assert.equal(result.usage.output_tokens,10);assert.equal(result.usage.total_tokens,30);assert.equal(result.usage.attempts,1);
      assert.doesNotMatch(JSON.stringify(result.usage),/private-fixture-key|attacker.invalid|diagnostic/);
    });
  }
}
