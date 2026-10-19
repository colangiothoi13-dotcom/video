import {mkdirSync,readFileSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

// Gemini remains the default for existing installations and fixtures.
export const AI_PROVIDER='gemini';
export const DEFAULT_TRANSCRIPTION_MODEL='gemini-3.5-transcribe';
export const DEFAULT_TRANSLATION_MODEL='gemini-3.5-flash-lite';
export const OPENAI_TRANSLATION_MODEL='gpt-5.4-mini';
export const OPENAI_TRANSCRIPTION_MODEL='whisper-1';
const names=['openai','gemini'];
const defaults={openai:{translationModel:OPENAI_TRANSLATION_MODEL,transcriptionModel:OPENAI_TRANSCRIPTION_MODEL},gemini:{translationModel:DEFAULT_TRANSLATION_MODEL,transcriptionModel:DEFAULT_TRANSLATION_MODEL}};
const catalogs={
  openai:[{id:'gpt-5.4-mini',label:'GPT-5.4 mini'},{id:'gpt-5.4',label:'GPT-5.4'},{id:'gpt-4.1-mini',label:'GPT-4.1 mini'}],
  gemini:[{id:DEFAULT_TRANSLATION_MODEL,label:'Gemini 3.5 Flash-Lite'},{id:'gemini-3.1-pro-preview',label:'Gemini 3.1 Pro (Preview)'},{id:'gemini-4-argon',label:'Gemini 4 Argon'}],
};
const fail=(code,message)=>Object.assign(new Error(message),{code});
function validateProvider(provider){if(!names.includes(provider))throw fail('INVALID_SETTINGS','Nhà cung cấp AI không hợp lệ.');return provider;}
function validateModel(model,provider){
  const pattern=provider==='openai'?/^gpt-[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/:/^gemini-[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
  if(typeof model!=='string'||!pattern.test(model))throw fail(provider==='openai'?'INVALID_OPENAI_MODEL':'INVALID_GEMINI_MODEL',provider==='openai'?'Hãy chọn mô hình GPT trong danh sách OpenAI.':'Hãy chọn mô hình Gemini trong danh sách.');
  return model;
}
function validateKey(key,provider){
  if(typeof key!=='string'||key.length>4096||/[\r\n]/.test(key))throw fail('INVALID_SETTINGS','API key không hợp lệ.');
  const value=key.trim();
  if((provider==='gemini'&&value.startsWith('sk-'))||(provider==='openai'&&value.startsWith('AIza')))throw fail('INVALID_KEY_PROVIDER','Khóa API không thuộc dịch vụ đã chọn. Chọn OpenAI cho khóa OpenAI; Veo cần khóa Google riêng.');
  return value;
}
function configPath(options={}){return options.configPath??resolve(options.dataDir??resolve(process.cwd(),'.data'),'config.json');}
function readSavedConfig(options={}){
  let saved;
  try{saved=JSON.parse(readFileSync(configPath(options),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const providers=Object.fromEntries(names.map(name=>[name,{apiKey:'',translationModel:defaults[name].translationModel}]));
  let provider=names.includes(saved?.provider)?saved.provider:AI_PROVIDER;
  if(saved?.version===2&&saved.providers){
    for(const name of names){const entry=saved.providers[name];if(!entry)continue;providers[name]={apiKey:entry.apiKey??'',translationModel:validateModel(entry.translationModel??defaults[name].translationModel,name)};}
  }else if(names.includes(saved?.provider)){
    providers[provider]={apiKey:saved.apiKey??'',translationModel:validateModel(saved.translationModel??defaults[provider].translationModel,provider)};
  }else if(typeof saved?.apiKey==='string'&&saved.apiKey.startsWith('sk-')){
    provider='openai';providers.openai={apiKey:saved.apiKey,translationModel:typeof saved.translationModel==='string'&&saved.translationModel.startsWith('gpt-')?validateModel(saved.translationModel,'openai'):OPENAI_TRANSLATION_MODEL};
  }
  // Repair the previous Gemini-only form when an OpenAI key was pasted there.
  // Reads never rewrite the user's file, and this key can never become a Veo key.
  if(typeof providers.gemini.apiKey==='string'&&providers.gemini.apiKey.startsWith('sk-')){
    if(!providers.openai.apiKey)providers.openai.apiKey=providers.gemini.apiKey;
    providers.gemini.apiKey='';provider='openai';
  }
  for(const name of names)providers[name].apiKey=validateKey(providers[name].apiKey,name);
  return {provider,providers,hasSaved:Boolean(saved)};
}

/** Private, server-only credentials. Public responses must use configStatus. */
export function readConfig(options={}){
  const saved=readSavedConfig(options),env=options.env??process.env;
  const provider=validateProvider(env.AI_PROVIDER?.trim()||(!saved.hasSaved&&env.OPENAI_API_KEY?.trim()&&!env.GEMINI_API_KEY?.trim()?'openai':saved.provider));
  const providerConfigs={};
  for(const name of names){
    const prefix=name.toUpperCase(),entry=saved.providers[name],translationModel=validateModel(env[`${prefix}_TRANSLATION_MODEL`]?.trim()||entry.translationModel,name);
    providerConfigs[name]={apiKey:validateKey(env[`${prefix}_API_KEY`]?.trim()||entry.apiKey,name),translationModel,transcriptionModel:name==='gemini'?translationModel:defaults[name].transcriptionModel};
  }
  return {provider,...providerConfigs[provider],videoApiKey:providerConfigs.gemini.apiKey,providerConfigs};
}
function modelsFor(provider,model){const models=catalogs[provider].map(item=>({...item}));if(!models.some(item=>item.id===model))models.push({id:model,label:`${model} (đã lưu)`});return models;}
/** Also supports dependency-injected legacy credentials without returning secrets. */
export function configStatus(config){
  const provider=validateProvider(config.provider??AI_PROVIDER),providers={};
  for(const name of names){
    const entry=config.providerConfigs?.[name]??(name===provider?config:{}),translationModel=entry.translationModel??defaults[name].translationModel;
    providers[name]={configured:Boolean(entry.apiKey),translationModel,transcriptionModel:name==='gemini'?translationModel:(entry.transcriptionModel??defaults[name].transcriptionModel),translationModels:modelsFor(name,translationModel)};
  }
  return {provider,...providers[provider],videoConfigured:Boolean(config.videoApiKey??(provider==='gemini'?config.apiKey:'')),providers};
}
export function getConfigStatus(options={}){return configStatus(readConfig(options));}

/** Validate the complete patch before atomically replacing the private file. */
export function writeConfig(patch,options={}){
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!['provider','apiKey','translationModel','videoApiKey'].includes(key)))throw fail('INVALID_SETTINGS','Cấu hình không hợp lệ.');
  const saved=readSavedConfig(options);
  let provider=validateProvider(patch.provider??saved.provider);
  if(!Object.hasOwn(patch,'provider')&&typeof patch.apiKey==='string'&&patch.apiKey.trim().startsWith('sk-')&&!patch.translationModel?.startsWith('gemini-'))provider='openai';
  const entry=saved.providers[provider];
  if(Object.hasOwn(patch,'apiKey'))entry.apiKey=validateKey(patch.apiKey,provider);
  if(Object.hasOwn(patch,'translationModel'))entry.translationModel=validateModel(patch.translationModel,provider);
  if(Object.hasOwn(patch,'videoApiKey'))saved.providers.gemini.apiKey=validateKey(patch.videoApiKey,'gemini');
  const target=configPath(options),temporary=`${target}.${randomUUID()}.tmp`;
  mkdirSync(dirname(target),{recursive:true});
  try{writeFileSync(temporary,JSON.stringify({version:2,provider,providers:saved.providers},null,2),{mode:0o600});renameSync(temporary,target);}finally{try{rmSync(temporary,{force:true});}catch{}}
  return getConfigStatus(options);
}
