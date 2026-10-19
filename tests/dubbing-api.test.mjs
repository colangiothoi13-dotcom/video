import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createStore} from '../lib/store.mjs';
import {createApi} from '../lib/api.mjs';
async function fixture(t){
 const dataDir=await mkdtemp(path.join(tmpdir(),'vietsub-dubbing-api-')),store=createStore(path.join(dataDir,'jobs.sqlite'));
 const job=store.createJob({title:'Test'});store.updateJob(job.id,{status:'completed',duration:5,renderedVersion:1});store.saveCues(job.id,0,[{id:'a',sourceId:'a',start:0,end:2,text:'Xin chào.',original:'Hello.'}]);
 const app=express(),api=createApi({store,dataDir,config:{readConfig:()=>({provider:'openai',apiKey:'sk-private-openai',videoApiKey:'private-google',providerConfigs:{gemini:{apiKey:'private-google'}}})}});app.use('/api',api);
 const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/api/jobs/${job.id}`;
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await api.close();store.close();await rm(dataDir,{recursive:true,force:true});});
 return {store,id:job.id,dataDir,call:(url,options={})=>fetch(base+url,{...options,headers:{'content-type':'application/json',...options.headers}})};
}
test('dubbing profile API uses Google credentials independently and preserves exact versions',async t=>{
 const f=await fixture(t);const response=await f.call('/dubbing');assert.equal(response.status,200);const data=await response.json();assert.equal(data.configured,true);assert.equal(data.profile.version,0);assert.ok(!JSON.stringify(data).includes('private-'));
 const saved=await f.call('/dubbing',{method:'PUT',body:JSON.stringify(data.profile)});assert.equal(saved.status,200);const {job}=await saved.json();assert.equal(job.dubbing.version,1);
 assert.equal((await f.call('/dubbing',{method:'PUT',body:JSON.stringify(data.profile)})).status,409);
 const queued=await f.call('/dubbing/preview',{method:'POST',body:JSON.stringify({version:1,subtitleVersion:1,speakerId:'spk_1'})});assert.equal(queued.status,202);assert.equal((await queued.json()).job.status,'queued');
 assert.equal((await f.call('/dubbing/render',{method:'POST',body:JSON.stringify({version:1,subtitleVersion:1})})).status,409);
});
test('dubbed and preview downloads stay confined to the job and expire normally',async t=>{
 const f=await fixture(t),jobRoot=path.join(f.dataDir,'jobs',f.id);await mkdir(jobRoot,{recursive:true});const output=path.join(jobRoot,'dub.mp4');await writeFile(output,'0123456789');
 f.store.updateJob(f.id,{artifacts:{dubbedPath:output},dubbingOutput:{version:1,subtitleVersion:1,token:'fixture'}});
 const range=await f.call('/files/dubbed',{headers:{Range:'bytes=0-3'}});assert.equal(range.status,206);assert.equal(await range.text(),'0123');
 f.store.updateJob(f.id,{artifacts:{dubbedPath:path.join(f.dataDir,'jobs.sqlite')}});assert.equal((await f.call('/files/dubbed')).status,404);
 f.store.updateJob(f.id,{status:'expired'});assert.equal((await f.call('/dubbing')).status,410);assert.equal((await f.call('/files/dubbed')).status,410);
});
