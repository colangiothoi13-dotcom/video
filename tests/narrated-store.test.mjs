import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createNarratedStore} from '../lib/narrated-store.mjs';

test('independent durable documents preserve source, transcript, immutable attempt snapshots and previous artifacts',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'narrated-store-')),file=path.join(dir,'narrated.sqlite');let store=createNarratedStore(file);
  try {const p=store.create({sourceUrl:'https://www.youtube.com/watch?v=abcdefghijk',aspectRatio:'9:16'});
    store.mutate(p.id,p=>{p.source={inputPath:'private/source.mp4',audioPath:'private/asr.mp3'};p.transcript=[{id:'t1',start:0,end:3,text:'Original speech'}];p.scenes=[{id:'scene-1',start:0,end:3,prompt:'new',version:2,status:'draft',artifact:{path:'private/old.mp4',version:1},history:[{id:'attempt',version:1,prompt:'old',status:'completed'}]}];});
    store.close();store=createNarratedStore(file);const reopened=store.get(p.id);assert.equal(reopened.source.inputPath,'private/source.mp4');assert.equal(reopened.transcript[0].text,'Original speech');assert.equal(reopened.scenes[0].history[0].prompt,'old');assert.equal(reopened.scenes[0].artifact.version,1);assert.equal(store.list().length,1);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('recovery resumes known operations but fences ambiguous ASR, planning and paid starts',()=>{
  const store=createNarratedStore(':memory:');try{
    for(const status of ['transcribing','planning','generating']){
      const p=store.create({sourceUrl:'url',aspectRatio:'9:16'});store.mutate(p.id,p=>{p.status=status;p.scenes=status==='generating'?[{id:'scene-1',status:'starting',operation:{token:'a',name:null},history:[{id:'a',status:'starting'}]}]:[];});
    }
    const known=store.create({sourceUrl:'url',aspectRatio:'9:16'});store.mutate(known.id,p=>{p.status='generating';p.scenes=[{id:'scene-1',status:'generating',operation:{token:'k',name:'operations/known'},history:[]}];});
    store.recover();assert.equal(store.get(known.id).status,'queued');assert.equal(store.get(known.id).scenes[0].operation.name,'operations/known');
    for(const p of store.list().filter(p=>p.id!==known.id)){assert.equal(p.status,'failed');assert.equal(p.error.code,'NARRATED_INTERRUPTED');}
    assert.throws(()=>store.delete(known.id),{code:'NARRATED_BUSY'});
  }finally{store.close();}
});
