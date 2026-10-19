import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../lib/store.mjs';
import {defaultDubbingProfile,validateDubbingProfile,mapSpeakersToCues,speechTurns} from '../lib/dubbing.mjs';
const cues=[{id:'a',sourceId:'a',start:0,end:2,text:'Xin chào.',original:'Hello.'},{id:'b',sourceId:'b',start:2.1,end:4,text:'Bạn khỏe không?',original:'How are you?'},{id:'c',sourceId:'c',start:5,end:7,text:'Tôi khỏe.',original:'Fine.'}];
test('profiles retain every cue and validate exact role and voice references',()=>{
 const p=defaultDubbingProfile(cues,1);assert.equal(p.version,0);assert.equal(p.subtitleVersion,1);
 assert.equal(validateDubbingProfile(p,cues,1).assignments.length,3);
 for(const change of [{assignments:p.assignments.slice(1)},{assignments:[p.assignments[0],p.assignments[0],p.assignments[2]]},{speakers:[{id:'spk_1',name:'Vai',voice:'arbitrary'}]},{assignments:p.assignments.map(a=>({...a,speakerId:'missing'}))},{subtitleVersion:0}])assert.throws(()=>validateDubbingProfile({...p,...change},cues,1));
});
test('speaker mapping is editable and ambiguous overlap is marked uncertain',()=>{
 const mapped=mapSpeakersToCues(cues,[{start:0,end:2,speaker:'spk_1'},{start:2.1,end:3,speaker:'spk_1'},{start:3,end:4,speaker:'spk_2'},{start:5,end:7,speaker:'spk_2'}],1);
 assert.equal(mapped.speakers.length,2);assert.equal(mapped.assignments[0].speakerId,'spk_1');assert.equal(mapped.assignments[1].uncertain,true);assert.equal(mapped.assignments[2].speakerId,'spk_2');
 assert.deepEqual(speechTurns(cues,{...mapped,assignments:mapped.assignments.map(a=>({...a,speakerId:'spk_1'}))}).map(t=>t.cueIds),[['a','b'],['c']]);
});
function seeded(t){const store=createStore(':memory:');t.after(()=>store.close());const job=store.createJob({title:'Dubbing'});store.updateJob(job.id,{status:'completed',duration:8,renderedVersion:1});store.saveCues(job.id,0,cues);return {store,id:job.id};}
test('dubbing settings are versioned separately and queued atomically without changing subtitles',t=>{
 const {store,id}=seeded(t);const original=store.getCues(id);const p=defaultDubbingProfile(original,1);
 const saved=store.saveDubbing(id,p);assert.equal(saved.dubbing.version,1);assert.equal(saved.subtitleVersion,1);assert.deepEqual(store.getCues(id),original);
 assert.throws(()=>store.saveDubbing(id,p),{code:'DUBBING_VERSION_CONFLICT'});
 const queued=store.queueDubbing(id,{action:'preview',version:1,subtitleVersion:1,speakerId:'spk_1'});assert.equal(queued.status,'queued');assert.equal(store.getJobInternal(id).dubbingRequest.action,'preview');
 assert.throws(()=>store.saveDubbing(id,{...saved.dubbing}),{code:'JOB_BUSY'});assert.throws(()=>store.queueDubbing(id,{action:'render',version:1,subtitleVersion:1}),{code:'JOB_BUSY'});
 assert.throws(()=>store.saveCues(id,1,original.map(c=>({id:c.id,text:c.text+'!'}))),{code:'JOB_BUSY'});
});
test('changed subtitles invalidate old dubbing settings and expired jobs cannot enqueue',t=>{
 const {store,id}=seeded(t);const p=store.saveDubbing(id,defaultDubbingProfile(cues,1)).dubbing;
 store.saveCues(id,1,cues.map(c=>({id:c.id,text:c.text+'!'})));
 assert.throws(()=>store.queueDubbing(id,{action:'render',version:p.version,subtitleVersion:1}),{code:'VERSION_CONFLICT'});
 store.updateJob(id,{status:'expired'});assert.throws(()=>store.queueDubbing(id,{action:'analyze',version:p.version,subtitleVersion:2}),{code:'JOB_EXPIRED'});
});
test('publication version conditions are checked atomically against current job data',t=>{
 const {store,id}=seeded(t);store.saveDubbing(id,defaultDubbingProfile(cues,1));
 assert.throws(()=>store.updateJob(id,{dubbingOutput:{version:0,subtitleVersion:1}},{expectedDubbingVersion:0}),{code:'DUBBING_VERSION_CONFLICT'});
 assert.throws(()=>store.updateJob(id,{dubbingOutput:{version:1,subtitleVersion:0}},{expectedSubtitleVersion:0}),{code:'VERSION_CONFLICT'});
 assert.ok(!store.getJob(id).dubbingOutput);
});
