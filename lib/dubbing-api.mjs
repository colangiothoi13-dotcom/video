import express from 'express';
import {defaultDubbingProfile} from './dubbing.mjs';
import {VOICES} from './dubbing-voices.mjs';
export function createDubbingApi({store,readConfig,requireJob}) {
  const router=express.Router();
  const fail=(code,status=400)=>Object.assign(new Error(code),{code,status});
  const json=body=>body&&typeof body==='object'&&!Array.isArray(body);
  router.get('/jobs/:id/dubbing',(req,res)=>{
    const job=requireJob(req.params.id),config=readConfig();
    const key=config.providerConfigs?.gemini?.apiKey||config.videoApiKey||((config.provider??'gemini')==='gemini'?config.apiKey:'');
    res.json({profile:job.dubbing??defaultDubbingProfile(store.getCues(job.id),job.subtitleVersion),voices:VOICES,configured:Boolean(key),output:job.dubbingOutput??null,preview:job.dubbingPreview??null});
  });
  router.put('/jobs/:id/dubbing',(req,res)=>{
    requireJob(req.params.id);if(!json(req.body))throw fail('INVALID_DUBBING');res.json({job:store.saveDubbing(req.params.id,req.body)});
  });
  router.post('/jobs/:id/dubbing/:action',(req,res)=>{
    requireJob(req.params.id);const body=req.body??{};
    if(!json(body)||Object.keys(body).some(k=>!['version','subtitleVersion','speakerId'].includes(k)))throw fail('INVALID_DUBBING');
    const config=readConfig(),key=config.providerConfigs?.gemini?.apiKey||config.videoApiKey||((config.provider??'gemini')==='gemini'?config.apiKey:'');
    if(!key)throw fail('AI_NOT_CONFIGURED');
    res.status(202).json({job:store.queueDubbing(req.params.id,{...body,action:req.params.action})});
  });
  return router;
}
