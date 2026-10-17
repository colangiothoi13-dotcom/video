import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {transcribe, translateSegments, testAiConnection} from '../lib/ai.mjs';

const segments=[{id:'s1',start:0,end:1,text:'Hello'},{id:'s2',start:1,end:2,text:'World'}];
const response=translated=>({id:'resp_fixture',object:'response',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({segments:translated})}]}],usage:{input_tokens:20,output_tokens:10,total_tokens:30}});
async function fixture(t,handler) {
  const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req) body+=chunk;await handler(req,res,body);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return {apiKey:'private-fixture-key',apiBase:`http://127.0.0.1:${server.address().port}/v1`,retryDelayMs:1,timeoutMs:1000};
}
function send(res,status,data) {res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));}

test('Responses sends strict schema and preserves source timing while mapping returned IDs',async t=>{
  const options=await fixture(t,(req,res,body)=>{
    assert.equal(req.url,'/v1/responses');assert.equal(req.headers.authorization,'Bearer private-fixture-key');
    const data=JSON.parse(body);assert.equal(data.model,'gpt-5.6-terra');assert.equal(data.store,false);assert.deepEqual(data.reasoning,{effort:'none'});
    assert.equal(data.text.format.type,'json_schema');assert.equal(data.text.format.strict,true);assert.equal(data.text.format.schema.additionalProperties,false);
    assert.equal(data.input[0].role,'developer');assert.match(data.input[1].content,/'|s1/);
    send(res,200,response([{id:'s2',text:'Thế giới 🌎'},{id:'s1',text:'Xin chào'}]));
  });
  const result=await translateSegments(segments,{...options,language:'vi'});
  assert.deepEqual(result.segments,[{...segments[0],text:'Xin chào',original:'Hello',sourceId:'s1'},{...segments[1],text:'Thế giới 🌎',original:'World',sourceId:'s2'}]);
  assert.equal(result.usage.total_tokens,30);assert.equal(result.usage.attempts,1);
});
for(const [label,translated] of [['missing',[{id:'s1',text:'A'}]],['duplicate',[{id:'s1',text:'A'},{id:'s1',text:'B'}]],['extra',[{id:'s1',text:'A'},{id:'s2',text:'B'},{id:'s3',text:'C'}]],['empty',[{id:'s1',text:' '},{id:'s2',text:'B'}]]]) {
  test(`rejects ${label} translated segment IDs or content`,async t=>{
    const options=await fixture(t,(_,res)=>send(res,200,response(translated)));
    await assert.rejects(translateSegments(segments,options),{code:'AI_INVALID_RESPONSE'});
  });
}
for(const [status,code,want] of [[401,'invalid_api_key',1],[429,'insufficient_quota',1],[429,'rate_limit_exceeded',3],[500,'server_error',3]]) {
  test(`provider ${status}/${code} makes ${want} total attempts without leaking provider text`,async t=>{
    let requests=0;const options=await fixture(t,(_,res)=>{requests++;send(res,status,{error:{code,message:'private-fixture-key C:\\secret\\file'}});});
    await assert.rejects(translateSegments(segments,options),error=>!error.message.includes('private-fixture-key')&&!error.message.includes('C:')&&Boolean(error.code));
    assert.equal(requests,want);
  });
}
test('temporary failures retry then succeed with actual attempt usage',async t=>{
  let requests=0;const options=await fixture(t,(_,res)=>++requests<3?send(res,503,{error:{code:'server_error'}}):send(res,200,response([{id:'s1',text:'A'},{id:'s2',text:'B'}])));
  assert.equal((await translateSegments(segments,options)).usage.attempts,3);
});
test('transcription uses multipart whisper segment timestamps and rejects no speech',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'vietsub-ai-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const audio=path.join(dir,'giọng nói.mp3');await writeFile(audio,'fixture audio');let request=0;
  const options=await fixture(t,(req,res,body)=>{
    assert.match(req.headers['content-type'],/^multipart\/form-data; boundary=/);assert.match(body,/whisper-1/);assert.match(body,/verbose_json/);assert.match(body,/timestamp_granularities\[\]/);
    send(res,200,++request===1?{text:'Hello',duration:2,segments:[{id:0,start:0,end:1,text:'Hello'}]}:{text:'',duration:2,segments:[]});
  });
  const result=await transcribe(audio,options);assert.deepEqual(result.segments,[{id:'0',sourceId:'0',start:0,end:1,text:'Hello'}]);assert.equal(result.usage.audioSeconds,2);
  await assert.rejects(transcribe(audio,options),{code:'NO_SPEECH'});
});
test('timeouts and caller abort bound external requests',async t=>{
  const options=await fixture(t,()=>{});
  await assert.rejects(translateSegments(segments,{...options,timeoutMs:20}),{code:'AI_TIMEOUT'});
  const controller=new AbortController();const pending=translateSegments(segments,{...options,signal:controller.signal});controller.abort();
  await assert.rejects(pending,error=>error.name==='AbortError');
});
test('refusal, incomplete, invalid JSON and malformed timestamps are rejected',async t=>{
  const results=[{status:'incomplete',output:[]},{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]},{status:'completed',output:[{content:[{type:'output_text',text:'oops'}]}]}];
  const options=await fixture(t,(_,res)=>send(res,200,results.shift()));
  for(let i=0;i<3;i++) await assert.rejects(translateSegments(segments,options),{code:'AI_INVALID_RESPONSE'});
  await assert.rejects(translateSegments([{id:'s1',start:1,end:0,text:'bad'}],options),{code:'AI_INVALID_SEGMENTS'});
});
test('connection test only reads access to requested model and whisper, never performs paid work',async t=>{
  const requests=[];const options=await fixture(t,(req,res)=>{requests.push(`${req.method} ${req.url}`);send(res,200,{id:decodeURIComponent(req.url.split('/').at(-1)),object:'model'});});
  const result=await testAiConnection({...options,model:'custom-model'});assert.equal(result.ok,true);
  assert.deepEqual(requests,['GET /v1/models/custom-model','GET /v1/models/whisper-1']);
});
test('malformed external envelopes and transcription entries fail with a safe validation error',async t=>{
  const malformed=[null,{status:'completed',output:[null]},{status:'completed',output:[{content:[null]}]}];
  const options=await fixture(t,(_,res)=>send(res,200,malformed.shift()));
  for(let i=0;i<3;i++)await assert.rejects(translateSegments(segments,options),{code:'AI_INVALID_RESPONSE'});
  const dir=await mkdtemp(path.join(tmpdir(),'vietsub-asr-invalid-'));t.after(()=>rm(dir,{recursive:true,force:true}));const audio=path.join(dir,'audio.mp3');await writeFile(audio,'mp3');
  const asrOptions=await fixture(t,(_,res)=>send(res,200,{duration:2,segments:[null]}));
  await assert.rejects(transcribe(audio,asrOptions),{code:'AI_INVALID_RESPONSE'});
});
test('public usage contains measured token fields, excluding unrecognized provider diagnostics',async t=>{
  const options=await fixture(t,(_,res)=>send(res,200,{...response([{id:'s1',text:'A'},{id:'s2',text:'B'}]),usage:{input_tokens:20,output_tokens:10,total_tokens:30,input_tokens_details:{cached_tokens:5,diagnostic:'private-fixture-key'},diagnostic:'private-fixture-key'}}));
  const result=await translateSegments(segments,options);assert.equal(result.usage.total_tokens,30);assert.equal(result.usage.input_tokens_details.cached_tokens,5);assert.doesNotMatch(JSON.stringify(result.usage),/private-fixture-key|diagnostic/);
});
