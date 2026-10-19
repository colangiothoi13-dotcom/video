import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import {runProcess} from '../lib/process.mjs';

let chunks={};
try {chunks=await import('../lib/audio-chunks.mjs');} catch(failure) {if(failure.code!=='ERR_MODULE_NOT_FOUND')throw failure;}
const cue=(text='Hello.',extra={})=>({id:'s1',sourceId:'s1',start:0.1,end:0.7,text,...extra});
const speech=(extra={})=>({segments:[cue()],usage:{provider:'gemini',model:'gemini-fixture',input_tokens:10,output_tokens:3,total_tokens:13,audioSeconds:1200,attempts:2,elapsedMs:1,...extra}});
async function audioFile(t) {
  const dir=await mkdtemp(path.join(tmpdir(),'vietsub-chunks-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const audio=path.join(dir,'source.mp3');await writeFile(audio,'source fixture');
  return {dir,audio};
}
const fixtureSplit=async(_exe,args)=>writeFile(args.at(-1),'bounded part fixture');
function requireHelper() {assert.equal(typeof chunks.transcribeAudioChunks,'function','long audio helper must exist');return chunks.transcribeAudioChunks;}

test('part planning covers a long source and the exact fractional tail without gaps',()=>{
  assert.equal(typeof chunks.planAudioParts,'function','audio part planner must exist');
  assert.deepEqual(chunks.planAudioParts(3600.25),[{index:0,start:0,duration:1200},{index:1,start:1200,duration:1200},{index:2,start:2400,duration:1200},{index:3,start:3600,duration:0.25}]);
  assert.deepEqual(chunks.planAudioParts(2400),[{index:0,start:0,duration:1200},{index:1,start:1200,duration:1200}]);
});

test('short audio keeps the original path, options and single-part result unchanged',async t=>{
  const transcribe=requireHelper(),{audio,dir}=await audioFile(t),options={duration:1800,diarization:true},expected=speech();
  const result=await transcribe(audio,options,async(file,received)=>{assert.equal(file,audio);assert.equal(received,options);return expected;},{run:()=>assert.fail('short audio must not be split')});
  assert.equal(result,expected);assert.deepEqual(await readdir(dir),['source.mp3']);
});

test('long audio offsets timestamps, assigns unique IDs and preserves separate chunk speakers',async t=>{
  const transcribe=requireHelper(),{audio,dir}=await audioFile(t);let active=0;const received=[];
  const result=await transcribe(audio,{duration:2401,diarization:true},async(file,options)=>{
    active++;assert.equal(active,1);received.push(options.duration);assert.equal(path.dirname(path.dirname(file)),dir);assert.equal((await stat(file)).size,20);
    await new Promise(resolve=>setTimeout(resolve,1));active--;
    return {segments:[cue('Hello.',{speaker:'speaker_1'})],usage:{provider:'gemini',model:'gemini-fixture',input_tokens:10,output_tokens:3,total_tokens:13,input_tokens_details:{audio_tokens:6,cached_tokens:2},audioSeconds:options.duration,attempts:2,validationAttempts:1,elapsedMs:1}};
  },{run:fixtureSplit});
  assert.deepEqual(received,[1200,1200,1]);
  assert.deepEqual(result.segments,[cue('Hello.',{speaker:'chunk1:speaker_1'}),{...cue('Hello.',{speaker:'chunk2:speaker_1'}),id:'s2',sourceId:'s2',start:1200.1,end:1200.7},{...cue('Hello.',{speaker:'chunk3:speaker_1'}),id:'s3',sourceId:'s3',start:2400.1,end:2400.7}]);
  assert.equal(result.usage.total_tokens,39);assert.equal(result.usage.input_tokens,30);assert.equal(result.usage.output_tokens,9);assert.deepEqual(result.usage.input_tokens_details,{audio_tokens:18,cached_tokens:6});assert.equal(result.usage.attempts,6);assert.equal(result.usage.validationAttempts,3);assert.equal(result.usage.audioSeconds,2401);assert.ok(result.usage.elapsedMs>=0);
  assert.deepEqual(await readdir(dir),['source.mp3']);
});

test('a silent middle chunk retains its measured usage and keeps later speech on the original timeline',async t=>{
  const transcribe=requireHelper(),{audio,dir}=await audioFile(t);let index=0;
  const result=await transcribe(audio,{duration:3600},async(_file,options)=>{
    index++;if(index===2)throw Object.assign(new Error('silent'),{code:'NO_SPEECH',attempts:1,providerUsage:{input_tokens:5,total_tokens:5,seconds:1200}});
    return speech({audioSeconds:options.duration});
  },{run:fixtureSplit});
  assert.deepEqual(result.segments.map(({start,end})=>({start,end})),[{start:0.1,end:0.7},{start:2400.1,end:2400.7}]);
  assert.equal(result.usage.input_tokens,25);assert.equal(result.usage.total_tokens,31);assert.equal(result.usage.seconds,1200);assert.equal(result.usage.attempts,5);assert.equal(result.usage.audioSeconds,3600);assert.deepEqual(await readdir(dir),['source.mp3']);
});

test('a wholly silent long source reports NO_SPEECH after visiting every part and cleaning up',async t=>{
  const transcribe=requireHelper(),{audio,dir}=await audioFile(t);let parts=0;
  await assert.rejects(transcribe(audio,{duration:2401},async()=>{parts++;throw Object.assign(new Error('silent'),{code:'NO_SPEECH',attempts:1,providerUsage:{seconds:1200}});},{run:fixtureSplit}),failure=>failure.code==='NO_SPEECH'&&failure.attempts===3&&failure.audioSeconds===2401);
  assert.equal(parts,3);assert.deepEqual(await readdir(dir),['source.mp3']);
});

test('failed later part preserves known accounting and removes all owned temporary files',async t=>{
  const transcribe=requireHelper(),{audio,dir}=await audioFile(t);let parts=0;
  await assert.rejects(transcribe(audio,{duration:2401},async()=>{if(++parts===2)throw Object.assign(new Error('provider rejected'),{code:'AI_AUTH',attempts:1,providerUsage:{input_tokens:4}});return speech();},{run:fixtureSplit}),failure=>failure.code==='AI_AUTH'&&failure.attempts===3&&failure.providerUsage.input_tokens===14&&failure.audioSeconds===2400);
  assert.equal(parts,2);assert.deepEqual(await readdir(dir),['source.mp3']);
});

test('cancellation during splitting removes the partial output before returning',async t=>{
  const transcribe=requireHelper(),{audio,dir}=await audioFile(t),controller=new AbortController();
  await assert.rejects(transcribe(audio,{duration:2401,signal:controller.signal},()=>assert.fail('cancelled part must never reach a provider'),{run:async(_exe,args)=>{await writeFile(args.at(-1),'partial');controller.abort();controller.signal.throwIfAborted();}}),{name:'AbortError'});
  assert.deepEqual(await readdir(dir),['source.mp3']);
});

test('cancellation between parts stops further transcription and keeps completed usage',async t=>{
  const transcribe=requireHelper(),{audio,dir}=await audioFile(t),controller=new AbortController();let parts=0;
  await assert.rejects(transcribe(audio,{duration:2401,signal:controller.signal},async()=>{parts++;controller.abort();return speech();},{run:fixtureSplit}),failure=>failure.name==='AbortError'&&failure.attempts===2&&failure.providerUsage.total_tokens===13);
  assert.equal(parts,1);assert.deepEqual(await readdir(dir),['source.mp3']);
});

test('invalid metadata never starts splitting or provider work',async t=>{
  const transcribe=requireHelper(),{audio,dir}=await audioFile(t);
  for(const duration of [undefined,0,-1,NaN,Infinity])await assert.rejects(transcribe(audio,{duration},()=>assert.fail('invalid duration must not transcribe'),{run:()=>assert.fail('invalid duration must not split')}),{code:'AI_INVALID_SEGMENTS'});
  assert.deepEqual(await readdir(dir),['source.mp3']);
});

test('invalid part timestamps and duplicate IDs are rejected before publishing any aggregate transcript',async t=>{
  const transcribe=requireHelper(),{audio,dir}=await audioFile(t);
  for(const segments of [[cue('bad',{end:1200.01})],[cue('bad',{start:-1})],[cue(),cue()],[cue('bad',{speaker:42})],[]]) {
    await assert.rejects(transcribe(audio,{duration:2401},async()=>({...speech(),segments}),{run:fixtureSplit}),{code:'AI_INVALID_RESPONSE'});
    assert.deepEqual(await readdir(dir),['source.mp3']);
  }
});

test('bundled FFmpeg creates bounded decodable MP3 files from a real local fixture',async t=>{
  const transcribe=requireHelper(),{audio,dir}=await audioFile(t);
  await runProcess(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=2.6','-c:a','libmp3lame','-b:a','64k','-y',audio]);
  const received=[];
  const result=await transcribe(audio,{duration:2.6},async(file,options)=>{
    const probe=JSON.parse((await runProcess(ffprobe.path,['-v','error','-show_format','-show_streams','-of','json',file])).stdout);
    received.push(options.duration);assert.equal(probe.streams[0].codec_name,'mp3');assert.ok(Number(probe.format.duration)<=options.duration+0.15);assert.ok((await stat(file)).size<25_000_000);
    return {segments:[cue('Sound.',{end:Math.min(0.5,options.duration)})],usage:{provider:'openai',model:'whisper-1',audioSeconds:options.duration,attempts:1}};
  },{partSeconds:1,splitAfterSeconds:2});
  assert.deepEqual(received,[1,1,0.6000000000000001]);assert.equal(result.segments.length,3);assert.equal(result.segments[2].start,2.1);assert.equal(result.usage.audioSeconds,2.6);assert.deepEqual(await readdir(dir),['source.mp3']);
});
