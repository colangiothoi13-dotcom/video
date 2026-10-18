import express from 'express';
import path from 'node:path';
import {realpath,stat} from 'node:fs/promises';
import {clipFilename} from './clips.mjs';
const within=(root,file)=>{const rel=path.relative(root,file);return rel!==''&&rel!=='..'&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel);};
const missing=()=>Object.assign(new Error('Không tìm thấy đoạn video.'),{code:'FILE_NOT_FOUND',status:404});

export function createClipsApi({store,dataDir,requireJob}) {
 const router=express.Router();
 router.post('/jobs/:id/clips',(req,res)=>{requireJob(req.params.id);res.status(202).json({job:store.queueClips(req.params.id,req.body)});});
 router.get('/jobs/:id/clips/:token/:index',async(req,res)=>{
  const job=requireJob(req.params.id),internal=store.getJobInternal(job.id),batch=internal.clipsOutput,index=Number(req.params.index);
  if(!batch||req.params.token!==batch.token||!/^(0|[1-9]\d*)$/.test(req.params.index)||!Number.isSafeInteger(index)||index>=batch.clips.length)throw missing();
  let file,root;
  try {
   root=await realpath(path.join(dataDir,'jobs',job.id));
   const directory=await realpath(internal.artifacts.clipsDirectory);
   file=await realpath(path.join(directory,clipFilename(index)));
   if(!within(root,directory)||!within(directory,file)||!(await stat(file)).isFile())throw missing();
  }catch{throw missing();}
  res.type('video/mp4').attachment(`doan-${index+1}.mp4`).sendFile(path.relative(root,file),{root,acceptRanges:true,dotfiles:'deny'},error=>{
   if(error){if(res.headersSent)res.destroy();else if(error.status===416)res.status(416).end();else res.status(404).json({error:{code:'FILE_NOT_FOUND',message:'Đoạn video chưa sẵn sàng hoặc không còn tồn tại.'}});}
  });
 });
 return router;
}
