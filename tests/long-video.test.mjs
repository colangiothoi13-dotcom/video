import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import * as media from '../lib/media.mjs';
import {createStore} from '../lib/store.mjs';
import {mapSpeakersToCues,validateDubbingProfile} from '../lib/dubbing.mjs';
import express from 'express';
import {createServer} from 'node:http';
import {createApi} from '../lib/api.mjs';

const metadata=duration=>({duration,width:640,height:360,hasAudio:true});

test('source metadata retains full finite duration instead of imposing a minute cap',()=>{
  for(const duration of [1500.001,1801,5400,86400])assert.equal(media.validateVideoMetadata(metadata(duration),1_000_000_000).duration,duration);
  for(const duration of [0,-1,NaN,Infinity])assert.throws(()=>media.validateVideoMetadata(metadata(duration)),{code:'INVALID_VIDEO'});
  assert.throws(()=>media.validateVideoMetadata(metadata(5400),5_000_000_001),{code:'VIDEO_TOO_LARGE'});
});

test('generated artifacts can be probed independently of the source download size limit',()=>{
  assert.equal(media.validateVideoMetadata(metadata(7200),6_000_000_000,{maxBytes:Infinity}).duration,7200);
});

test('full source duration persists in SQLite and cannot become infinite',t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  const job=store.createJob({title:'Long source',sourceType:'url',sourceUrl:'https://www.youtube.com/watch?v=C5kR-exHmr4'});
  store.updateJob(job.id,{duration:86400});
  assert.equal(store.getJob(job.id).duration,86400);
  assert.throws(()=>store.updateJob(job.id,{duration:Infinity}),{code:'INVALID_JOB'});
});

test('URL import automatically reads full duration and downloads without a minute filter',async t=>{
  assert.equal(typeof media.createVideoImporter,'function');
  const directory=await mkdtemp(path.join(tmpdir(),'full-video-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const commands=[];
  const importer=media.createVideoImporter({run:async(_tool,args)=>{
    commands.push(args);
    if(args.includes('--dump-single-json'))return {stdout:JSON.stringify({duration:7265.25,title:'Full source',filesize_approx:1_200_000_000})};
    const filename=args[args.indexOf('--output')+1].replace('%(ext)s','mp4');await writeFile(filename,'fixture');return {stdout:filename};
  },probe:async()=>metadata(7265.25)});
  const result=await importer('https://youtu.be/C5kR-exHmr4',directory);
  assert.equal(result.metadata.duration,7265.25);assert.equal(result.title,'Full source');
  const download=commands[1],filter=download[download.indexOf('--match-filter')+1];
  assert.ok(filter.includes('!is_live'));assert.ok(!filter.includes('duration'));
  assert.equal(download[download.indexOf('--max-filesize')+1],'5000000000');
  assert.ok(!download.includes('--download-sections'));
});

test('URL preflight rejects ongoing streams and oversized sources before download',async t=>{
  assert.equal(typeof media.createVideoImporter,'function');
  const directory=await mkdtemp(path.join(tmpdir(),'invalid-full-video-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  for(const [info,code] of [[{duration:7200,is_live:true},'VIDEO_TOO_LONG'],[{duration:null},'VIDEO_TOO_LONG'],[{duration:7200,filesize:5_000_000_001},'VIDEO_TOO_LARGE']]){
    let calls=0;const importer=media.createVideoImporter({run:async()=>{calls++;return {stdout:JSON.stringify(info)};}});
    await assert.rejects(importer('https://youtu.be/C5kR-exHmr4',directory),{code});assert.equal(calls,1);
    assert.deepEqual(await readdir(directory),[]);
  }
});

test('speaker labels from later audio chunks remain distinct editable roles',()=>{
  const segments=Array.from({length:12},(_,i)=>({id:`s${i}`,start:i*1200,end:i*1200+1,speaker:`chunk${i+1}:speaker1`}));
  const cues=segments.map(s=>({...s,sourceId:s.id,text:'Hello',original:'Hello'}));
  const profile=mapSpeakersToCues(cues,segments,1);
  assert.equal(profile.speakers.length,12);assert.equal(new Set(profile.assignments.map(a=>a.speakerId)).size,12);
  assert.equal(validateDubbingProfile(profile,cues,1).assignments.length,12);
});

test('speaker overlap still remains uncertain when a cue retains one source ID',()=>{
  const profile=mapSpeakersToCues([{id:'a',sourceId:'a',start:0,end:2}], [{id:'a',start:0,end:2,speaker:'one'},{id:'b',start:0,end:2,speaker:'two'}],1);
  assert.equal(profile.assignments[0].uncertain,true);
});

test('a long video can save more than 1 MB of subtitle edits through the local API',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'long-video-api-')),store=createStore(':memory:');
  const router=createApi({store,dataDir:directory,config:{env:{}}}),app=express();app.use('/api',router);
  const server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await router.close();store.close();await rm(directory,{recursive:true,force:true});});
  const job=store.createJob({title:'Long editable source'}),count=14000,text='A short line with forty two characters 1234';
  store.updateJob(job.id,{status:'completed',duration:count});
  store.saveCues(job.id,0,Array.from({length:count},(_,i)=>({id:`source-segment-${i}`,sourceId:`source-segment-${i}`,start:i,end:i+0.9,text,original:text})));
  const body=JSON.stringify({version:1,cues:store.getCues(job.id).map(({id,text})=>({id,text}))});assert.ok(Buffer.byteLength(body)>1024*1024);
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/jobs/${job.id}/subtitles`,{method:'PUT',headers:{'Content-Type':'application/json'},body});
  assert.equal(response.status,200);assert.equal(store.getJob(job.id).subtitleVersion,2);assert.equal(store.getCues(job.id).length,count);
});
