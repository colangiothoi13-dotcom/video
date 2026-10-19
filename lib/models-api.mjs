import express from 'express';
import {createHash} from 'node:crypto';
import {listGeminiTranslationModels} from './ai.mjs';
const fail=code=>Object.assign(new Error(code),{code});

/** Small per-key metadata cache; refreshing never changes the selected model or credentials. */
export function createModelsApi({readConfig,listModels=listGeminiTranslationModels,now=Date.now,cacheMs=60_000}) {
 const router=express.Router(),cache=new Map(),pending=new Map();
 router.get('/settings/models',async(req,res)=>{
  const provider=req.query.provider??'gemini';
  if(provider!=='gemini'||Object.keys(req.query).some(k=>!['provider','refresh'].includes(k))||(req.query.refresh!==undefined&&req.query.refresh!=='1'))throw fail('INVALID_SETTINGS');
  const config=readConfig(),apiKey=config.providerConfigs?.gemini?.apiKey||config.videoApiKey||((config.provider??'gemini')==='gemini'?config.apiKey:'');
  if(typeof apiKey!=='string'||!apiKey.trim())throw fail('AI_NOT_CONFIGURED');
  const identity=createHash('sha256').update(apiKey).digest('hex'),previous=cache.get(identity);
  if(req.query.refresh!=='1'&&previous&&previous.until>now()){res.json({...previous.value,cached:true});return;}
  let request=pending.get(identity);
  if(!request){
   request=Promise.resolve().then(()=>listModels({apiKey,timeoutMs:10000,signal:AbortSignal.timeout(15000)})).then(models=>{
    const value={provider:'gemini',models,fetchedAt:new Date(now()).toISOString()};cache.delete(identity);cache.set(identity,{value,until:now()+cacheMs});
    while(cache.size>4)cache.delete(cache.keys().next().value);return value;
   }).finally(()=>pending.delete(identity));
   pending.set(identity,request);
  }
  res.json({...await request,cached:false});
 });
 return router;
}
