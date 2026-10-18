import {setTimeout as delay} from 'node:timers/promises';
import {VOICES} from './dubbing-voices.mjs';

export {VOICES} from './dubbing-voices.mjs';
export const TTS_MODEL='gemini-3.8-flash-lite-tts';
const API_BASE='https://generativelanguage.googleapis.com/v1beta';
const MAX_AUDIO_BYTES=16*1024*1024;
const MAX_BASE64_LENGTH=Math.ceil(MAX_AUDIO_BYTES/3)*4;
const MAX_RESPONSE_BYTES=MAX_BASE64_LENGTH+1024*1024;
const VOICE_IDS=new Set(VOICES.map(voice=>voice.id));
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const finiteCount=value=>Number.isFinite(value)&&value>=0;
const bounded=(value,fallback,maximum)=>Number.isFinite(value)&&value>0?Math.min(value,maximum):fallback;
const failure=(code,message)=>Object.assign(new Error(message),{code});
const invalidResponse=()=>failure('AI_INVALID_RESPONSE','Gemini trả về âm thanh không hợp lệ. Vui lòng thử lại.');
const requestError=()=>failure('AI_REQUEST','Nội dung hoặc cấu hình giọng đọc không hợp lệ. Vui lòng kiểm tra lại.');

/** Only the fixed production endpoint and loopback HTTP test fixtures may receive a key. */
function apiBase(value) {
  let url;
  try {url=new URL(value??API_BASE);} catch {throw requestError();}
  if(url.username||url.password||url.search||url.hash)throw requestError();
  const fixture=url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if(url.href.replace(/\/$/,'')!==API_BASE&&!fixture)throw requestError();
  return url.href.replace(/\/$/,'');
}

function measuredUsage(usage) {
  const result={};
  for(const [source,target] of [['total_input_tokens','input_tokens'],['total_output_tokens','output_tokens'],['total_tokens','total_tokens'],['seconds','seconds']]) {
    if(finiteCount(usage?.[source]))result[target]=usage[source];
  }
  const input={},output={};
  if(finiteCount(usage?.total_cached_tokens))input.cached_tokens=usage.total_cached_tokens;
  if(finiteCount(usage?.total_thought_tokens))output.reasoning_tokens=usage.total_thought_tokens;
  for(const [source,target] of [['input_tokens_by_modality',input],['output_tokens_by_modality',output]]) {
    if(!Array.isArray(usage?.[source]))continue;
    for(const entry of usage[source])if(['text','audio','image'].includes(entry?.modality)&&finiteCount(entry.tokens))target[`${entry.modality}_tokens`]=entry.tokens;
  }
  if(Object.keys(input).length)result.input_tokens_details=input;
  if(Object.keys(output).length)result.output_tokens_details=output;
  return result;
}

function providerError(status,data) {
  const details=Array.isArray(data?.error?.details)?data.error.details:[];
  const reasons=details.filter(isObject).map(item=>item.reason);
  const message=typeof data?.error?.message==='string'?data.error.message:'';
  if(status===401||status===403||data?.error?.status==='UNAUTHENTICATED'||reasons.some(reason=>['API_KEY_INVALID','API_KEY_EXPIRED','API_KEY_REVOKED'].includes(reason))||/api key (?:not valid|is invalid|expired)/i.test(message)) {
    return failure('AI_AUTH','API key Gemini không hợp lệ hoặc chưa có quyền tạo giọng đọc. Hãy kiểm tra Cài đặt.');
  }
  const quotas=details.filter(item=>item?.['@type']==='type.googleapis.com/google.rpc.QuotaFailure').flatMap(item=>Array.isArray(item.violations)?item.violations:[]);
  const exhausted=quotas.some(item=>item?.quotaValue==='0'||item?.quotaValue===0||/per.?day|daily|billing|limit\s*:\s*0\b/i.test(`${item?.quotaId??''} ${item?.quotaMetric??''} ${item?.description??''}`));
  if(reasons.some(reason=>['BILLING_DISABLED','BILLING_NOT_ACTIVE','INSUFFICIENT_QUOTA'].includes(reason))||(status===429&&(exhausted||/limit\s*:\s*0\b|per.?day|daily quota|billing (?:is disabled|not enabled)/i.test(message)))) {
    return failure('AI_QUOTA','Gemini đã hết hạn mức tạo giọng đọc. Hãy kiểm tra hạn mức và thanh toán trong Google AI Studio.');
  }
  if(status===429)return failure('AI_RATE_LIMIT','Gemini đang giới hạn tần suất tạo giọng đọc. Vui lòng chờ rồi thử lại.');
  if(status>=500)return failure('AI_UNAVAILABLE','Dịch vụ tạo giọng đọc Gemini tạm thời không sẵn sàng. Vui lòng thử lại sau.');
  return failure('AI_REQUEST','Gemini từ chối yêu cầu tạo giọng đọc. Hãy kiểm tra nội dung và cấu hình.');
}

function retryWait(response,data,attempt,options) {
  const maximum=bounded(options.maxRetryDelayMs,10_000,10_000);
  const backoff=bounded(options.retryDelayMs,750,10_000)*2**(attempt-1);
  const raw=response?.headers.get('retry-after');
  let suggested=raw&&/^\d+(?:\.\d+)?$/.test(raw)?Number(raw)*1000:Date.parse(raw??'')-Date.now();
  const details=Array.isArray(data?.error?.details)?data.error.details:[];
  for(const item of details) {
    if(item?.['@type']!=='type.googleapis.com/google.rpc.RetryInfo'||typeof item.retryDelay!=='string')continue;
    const match=/^(\d+(?:\.\d+)?)s$/.exec(item.retryDelay);
    if(match)suggested=Math.max(suggested||0,Number(match[1])*1000);
  }
  return Math.min(maximum,Math.max(backoff,Number.isFinite(suggested)?suggested:0));
}

/** Bound encoded audio plus envelope before allocating a parsed provider document. */
async function responseData(response) {
  if(Number(response.headers.get('content-length'))>MAX_RESPONSE_BYTES) {
    await response.body?.cancel();throw invalidResponse();
  }
  const chunks=[];let length=0;
  if(response.body) {
    const reader=response.body.getReader();
    try {
      while(true) {
        const {done,value}=await reader.read();if(done)break;
        length+=value.byteLength;
        if(length>MAX_RESPONSE_BYTES) {await reader.cancel();throw invalidResponse();}
        chunks.push(value);
      }
    } finally {reader.releaseLock();}
  }
  try {return JSON.parse(Buffer.concat(chunks,length).toString('utf8'));}
  catch {if(response.ok)throw invalidResponse();return undefined;}
}

/** Validate RIFF chunks, basic sample format and complete, nonempty sample data. */
function validateWav(audio) {
  if(audio.length<44||audio.length>MAX_AUDIO_BYTES||audio.toString('ascii',0,4)!=='RIFF'||audio.toString('ascii',8,12)!=='WAVE'||audio.readUInt32LE(4)+8!==audio.length)throw invalidResponse();
  let offset=12,format,dataLength;
  while(offset+8<=audio.length) {
    const type=audio.toString('ascii',offset,offset+4),size=audio.readUInt32LE(offset+4),start=offset+8,end=start+size;
    if(end>audio.length)throw invalidResponse();
    if(type==='fmt ') {
      if(format||size<16)throw invalidResponse();
      const encoding=audio.readUInt16LE(start),channels=audio.readUInt16LE(start+2),sampleRate=audio.readUInt32LE(start+4),byteRate=audio.readUInt32LE(start+8),blockAlign=audio.readUInt16LE(start+12),bits=audio.readUInt16LE(start+14);
      if(![1,3].includes(encoding)||channels<1||channels>8||sampleRate<8000||sampleRate>192000||!(encoding===1?[8,16,24,32]:[32,64]).includes(bits)||blockAlign!==channels*bits/8||byteRate!==sampleRate*blockAlign)throw invalidResponse();
      format={blockAlign};
    }
    if(type==='data') {if(dataLength!==undefined||!size)throw invalidResponse();dataLength=size;}
    offset=end+(size%2);
  }
  if(offset!==audio.length||!format||!dataLength||dataLength%format.blockAlign!==0)throw invalidResponse();
  return audio;
}

function outputAudio(data) {
  if(!isObject(data)||data.status!=='completed'||data.error||!Array.isArray(data.steps))throw invalidResponse();
  let last;
  for(const step of data.steps) {
    if(!isObject(step))throw invalidResponse();
    if(step.type==='thought'||step.type==='user_input')continue;
    if(step.type!=='model_output'||!Array.isArray(step.content))throw invalidResponse();
    for(const content of step.content) {
      if(!isObject(content))throw invalidResponse();
      if(content.type==='audio')last=content;
    }
  }
  const encoded=last?.data;
  if(last?.mime_type!=='audio/wav'||typeof encoded!=='string'||!encoded.length||encoded.length>MAX_BASE64_LENGTH||encoded.length%4||/[^A-Za-z0-9+/=]/.test(encoded))throw invalidResponse();
  const padding=encoded.indexOf('=');
  if(padding!==-1&&(padding<encoded.length-2||!/^[=]{1,2}$/.test(encoded.slice(padding))))throw invalidResponse();
  const audio=Buffer.from(encoded,'base64');
  if(audio.toString('base64')!==encoded)throw invalidResponse();
  return validateWav(audio);
}

/** Synthesize one exact Vietnamese utterance without retaining provider response data. */
export async function synthesizeSpeech(text,options={}) {
  const {apiKey,voice,signal}=options;
  signal?.throwIfAborted();
  if(typeof text!=='string'||!text.trim()||text.length>2000||!VOICE_IDS.has(voice))throw requestError();
  if(typeof apiKey!=='string'||!apiKey.trim()||/[\r\n]/.test(apiKey))throw failure('AI_AUTH','Hãy nhập API key Gemini hợp lệ trong Cài đặt để tạo giọng đọc.');
  const url=`${apiBase(options.apiBase)}/interactions`;
  const body=JSON.stringify({
    model:TTS_MODEL,store:false,
    input:[{type:'user_input',content:[{type:'text',text,annotations:[{type:'speech_metadata',style:'Speak naturally in Vietnamese, clearly, at a conversational pace.'}]}]}],
    response_format:{type:'audio',mime_type:'audio/wav',sample_rate:24000},generation_config:{speech_config:[{voice}]},
  });
  const started=Date.now();
  for(let attempt=1;attempt<=3;attempt++) {
    signal?.throwIfAborted();
    const controller=new AbortController();
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const timer=setTimeout(()=>controller.abort(),bounded(options.timeoutMs,120_000,300_000));
    let response,data,retry;
    try {
      response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':apiKey.trim()},body,redirect:'error',signal:combined});
      data=await responseData(response);
      if(!response.ok)throw providerError(response.status,data);
      const audio=outputAudio(data);
      return {audio,usage:{provider:'gemini',model:TTS_MODEL,...measuredUsage(data.usage),attempts:attempt,elapsedMs:Date.now()-started}};
    } catch (cause) {
      signal?.throwIfAborted();
      const error=controller.signal.aborted?failure('AI_TIMEOUT','Gemini tạo giọng đọc quá lâu. Vui lòng thử lại.'):cause?.code?.startsWith('AI_')?cause:failure('AI_CONNECTION','Không thể kết nối Gemini để tạo giọng đọc. Hãy kiểm tra mạng rồi thử lại.');
      const transient=['AI_RATE_LIMIT','AI_UNAVAILABLE','AI_TIMEOUT','AI_CONNECTION'].includes(error.code);
      if(!transient||attempt===3)throw Object.assign(error,{attempts:attempt,elapsedMs:Date.now()-started});
      retry=retryWait(response,data,attempt,options);
    } finally {clearTimeout(timer);}
    await delay(retry,undefined,{signal});
  }
}
