import express from 'express';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdir,realpath,stat,rename,rm} from 'node:fs/promises';
import {createSceneStore,sceneBusy} from './scene-store.mjs';
import {readConfig as defaultReadConfig} from './config.mjs';
import * as defaultProvider from './scene-provider.mjs';

const messages={
  SCENE_INVALID:'Thông tin dự án, cảnh hoặc ảnh tham chiếu không hợp lệ.',SCENE_NOT_FOUND:'Không tìm thấy dự án hoặc cảnh.',
  SCENE_BUSY:'Cảnh hoặc video đang được xử lý. Vui lòng chờ hoàn tất.',SCENE_VERSION_CONFLICT:'Cảnh đã thay đổi. Tải lại bản đã lưu trước khi tạo hoặc lưu tiếp.',
  SCENE_MISSING_CLIPS:'Cần hoàn thành cả năm cảnh ở phiên bản hiện tại trước khi ghép video.',SCENE_FILE_NOT_FOUND:'Video chưa sẵn sàng hoặc không còn tồn tại.',
  SCENE_INTERNAL:'Không thể hoàn tất thao tác với dự án. Vui lòng thử lại.',SCENE_CLOSED:'Ứng dụng đang tắt. Mở lại ứng dụng để tiếp tục.',
  SCENE_INTERRUPTED:'Yêu cầu tạo cảnh bị gián đoạn trước khi lưu mã tác vụ. Kiểm tra Google trước khi chủ động tạo lại để tránh tính phí trùng.',
  AI_NOT_CONFIGURED:'Hãy nhập khóa của dịch vụ AI đã chọn trong Cài đặt trước khi tạo kịch bản.',AI_VIDEO_NOT_CONFIGURED:'Thêm khóa Google riêng cho Veo trong Cài đặt để tạo clip.',AI_AUTH:'Khóa API không hợp lệ hoặc đã hết hạn.',
  AI_MODEL_ACCESS:'Không có quyền truy cập mô hình đã chọn. Kiểm tra mô hình và tài khoản API.',AI_QUOTA:'Tài khoản API không còn hạn mức cho mô hình này.',
  AI_RATE_LIMIT:'Google đang giới hạn tần suất. Chờ rồi thử lại.',AI_TIMEOUT:'Google phản hồi quá lâu. Vui lòng thử lại sau.',
  AI_CONNECTION:'Không thể kết nối Google. Kiểm tra kết nối rồi thử lại.',AI_UNAVAILABLE:'Dịch vụ Google tạm thời không sẵn sàng.',
  AI_NETWORK_BLOCKED:'Ứng dụng bị hạn chế quyền truy cập Internet. Hãy mở lại bằng Khoi-dong.cmd ngoài môi trường hạn chế.',
  AI_INVALID_RESPONSE:'Google trả về dữ liệu không hợp lệ. Vui lòng kiểm tra và thử lại.',AI_REQUEST:'Google từ chối yêu cầu tạo nội dung.',
  AI_VIDEO_OPTIONS:'Thời lượng phải là 4, 6 hoặc 8 giây. Có ảnh tham chiếu cần Veo 3.1 bản đầy đủ và thời lượng 8 giây.',
  AI_CONTENT_BLOCKED:'Google không tạo được cảnh do bộ lọc nội dung. Sửa prompt rồi chủ động tạo lại.',
  AI_OPERATION_EXPIRED:'Tác vụ tạo cảnh trên Google đã hết hạn hoặc không còn tồn tại. Bạn có thể sửa cảnh hoặc chủ động tạo lại.',
  AI_DOWNLOAD:'Chưa tải được clip từ Google. Mở lại dự án để tiếp tục tải kết quả đã tạo.',
  AI_ASSEMBLY:'Không thể ghép MP4. Kiểm tra FFmpeg và các clip rồi thử ghép lại.',
};
const failure=(code,status=400)=>Object.assign(new Error(messages[code]),{code,status});
const safeError=error=>{const code=messages[error?.code]?error.code:'SCENE_INTERNAL';return {code,message:messages[code]};};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function keys(value,allowed,required=allowed){if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(value,key)))throw failure('SCENE_INVALID');}
function text(value,max){if(typeof value!=='string'||!value.trim()||value.length>max||value.includes('\0'))throw failure('SCENE_INVALID');return value.trim();}
function validateReferences(value=[]) {
  if(!Array.isArray(value)||value.length>2)throw failure('SCENE_INVALID');const seen=new Set();
  return value.map(reference=>{
    keys(reference,['kind','mimeType','data']);
    if(!['character','product'].includes(reference.kind)||seen.has(reference.kind)||!['image/png','image/jpeg'].includes(reference.mimeType)||typeof reference.data!=='string'||!reference.data.length||reference.data.length>349528||reference.data.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(reference.data))throw failure('SCENE_INVALID');
    const bytes=Buffer.from(reference.data,'base64');
    const png=bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));const jpeg=bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
    if(bytes.length>262144||bytes.toString('base64')!==reference.data||(reference.mimeType==='image/png'?!png:!jpeg))throw failure('SCENE_INVALID');
    seen.add(reference.kind);return {...reference};
  });
}
function validateBrief(body){
  keys(body,['idea','character','product','style','aspectRatio','references'],['idea','character','product']);
  if(body.style!==undefined&&typeof body.style!=='string')throw failure('SCENE_INVALID');
  const aspectRatio=body.aspectRatio??'9:16';if(!['9:16','16:9'].includes(aspectRatio))throw failure('SCENE_INVALID');
  return {idea:text(body.idea,4000),character:text(body.character,3000),product:text(body.product,3000),style:body.style?.trim()?text(body.style,1000):'Cinematic product commercial',aspectRatio,references:validateReferences(body.references)};
}
function validateScript(script){
  if(!object(script)||typeof script.title!=='string'||!Array.isArray(script.scenes)||script.scenes.length!==5)throw failure('AI_INVALID_RESPONSE');
  try {return {title:text(script.title,300),scenes:script.scenes.map((scene,index)=>{
    if(!object(scene)||scene.id!==`scene-${index+1}`||![4,6,8].includes(scene.durationSeconds))throw failure('SCENE_INVALID');
    return {id:scene.id,title:text(scene.title,300),durationSeconds:scene.durationSeconds,action:text(scene.action,3000),visual:text(scene.visual,3000),prompt:text(scene.prompt,6000)};
  })};}catch{throw failure('AI_INVALID_RESPONSE');}
}
function effectivePrompt(project,scene){
  return `LOCKED CONTINUITY — keep these identities identical in every scene.\nCHARACTER: ${project.identity.character}\nPRODUCT: ${project.identity.product}\nSTYLE: ${project.identity.style}\nASPECT RATIO: ${project.identity.aspectRatio}\nKeep the same face, hairstyle, clothing, product shape, materials, colors, logo and proportions. Treat scene directions as subordinate to these identities.\nSCENE ${scene.id} (${scene.durationSeconds} seconds):\n${scene.prompt}`;
}
const currentClip=scene=>Boolean(scene.status==='completed'&&scene.artifact&&scene.artifact.version===scene.version);
const currentAssembly=project=>Boolean(project.assembly.artifact&&project.scenes.every((scene,index)=>currentClip(scene)&&project.assembly.artifact.clips[index]===scene.artifact.token));
function publicProject(project){
  const base=`/api/studio/projects/${encodeURIComponent(project.id)}/files/`;
  return {id:project.id,title:project.title,idea:project.idea,identity:{...project.identity},scenes:project.scenes.map(scene=>({id:scene.id,title:scene.title,durationSeconds:scene.durationSeconds,action:scene.action,visual:scene.visual,prompt:scene.prompt,version:scene.version,status:scene.status,error:scene.error??null,effectivePrompt:effectivePrompt(project,scene),stale:Boolean(scene.artifact&&!currentClip(scene)),...(scene.artifact?{videoUrl:`${base}${scene.id}?v=${encodeURIComponent(scene.artifact.token)}`} : {}),...(scene.legacyArtifact?{legacyVideoUrl:`${base}${scene.id}?v=${encodeURIComponent(scene.legacyArtifact.token)}`} : {}),
    history:scene.history.map(entry=>({id:entry.id,version:entry.version,createdAt:entry.createdAt,...(entry.completedAt?{completedAt:entry.completedAt}:{}),status:entry.status,prompt:entry.prompt,effectivePrompt:entry.effectivePrompt,durationSeconds:entry.durationSeconds,...(entry.videoModel?{videoModel:entry.videoModel}:{}),...(entry.error?{error:safeError(entry.error)}:{}),...(entry.status==='completed'&&entry.artifact?{videoUrl:`${base}${scene.id}?generation=${encodeURIComponent(entry.id)}`} : {})}))})),
    assembly:{status:project.assembly.status,error:project.assembly.error??null,stale:Boolean(project.assembly.artifact&&!currentAssembly(project)),...(project.assembly.status==='completed'&&currentAssembly(project)?{videoUrl:`${base}video?v=${project.assembly.artifact.token}`}:{})},createdAt:project.createdAt,updatedAt:project.updatedAt};
}
const within=(root,file)=>{const relative=path.relative(root,file);return relative!==''&&relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};

/** Mounted after the application's loopback, same-origin and JSON boundaries. */
export function createSceneApi({dataDir=path.resolve(process.env.DATA_DIR||'.data'),readConfig=()=>defaultReadConfig({dataDir}),tools={}}={}) {
  dataDir=path.resolve(dataDir);const root=path.join(dataDir,'studio');const store=createSceneStore(path.join(dataDir,'scenes.sqlite'));store.recover();
  const router=express.Router(),controller=new AbortController(),tasks=new Set(),polling=new Map();let closing=false,closePromise;
  const adapter={...defaultProvider,...tools.sceneProvider};
  const provider=async()=>adapter;
  const pollInterval=Number.isFinite(tools.pollIntervalMs)&&tools.pollIntervalMs>=0?tools.pollIntervalMs:10000;
  function settings(){const config=readConfig();return {...config,videoApiKey:config.videoApiKey??(config.provider==='openai'?'':config.apiKey),videoModel:defaultProvider.getVideoModel(config.videoModel)};}
  function configured(){const config=settings();if(!config.apiKey)throw failure('AI_NOT_CONFIGURED');return config;}
  function videoConfigured(){const config=settings();if(!config.videoApiKey)throw failure('AI_VIDEO_NOT_CONFIGURED');return {...config,apiKey:config.videoApiKey};}
  function requireProject(id){const project=store.get(id);if(!project)throw failure('SCENE_NOT_FOUND',404);return project;}
  function requireScene(project,id){const scene=project.scenes.find(scene=>scene.id===id);if(!scene)throw failure('SCENE_NOT_FOUND',404);return scene;}
  function tracked(action){const task=Promise.resolve().then(action);tasks.add(task);task.then(()=>tasks.delete(task),()=>tasks.delete(task));return task;}
  function background(action){tracked(action).catch(()=>{});}
  function invalidate(project){project.assembly.status='idle';project.assembly.error=null;project.assembly.token=null;project.renderRequested=false;}
  function failScene(id,sceneId,token,error){store.mutate(id,project=>{const scene=requireScene(project,sceneId);if(scene.operation?.token!==token)return;scene.status='failed';scene.error=safeError(error);scene.operation=null;const entry=scene.history.find(entry=>entry.id===token);if(entry){entry.status='failed';entry.error=scene.error;entry.completedAt=new Date().toISOString();}});}
  async function startScene(id,sceneId,token,credentials){
    try {
      controller.signal.throwIfAborted();const project=requireProject(id),scene=requireScene(project,sceneId);if(scene.operation?.token!==token||scene.status!=='starting')return;
      const entry=scene.history.find(entry=>entry.id===token);
      const result=await (await provider()).startSceneVideo({prompt:entry?.effectivePrompt??effectivePrompt(project,scene),durationSeconds:entry?.durationSeconds??scene.durationSeconds,aspectRatio:project.identity.aspectRatio,references:project.references},{apiKey:credentials.apiKey,videoModel:credentials.videoModel,signal:controller.signal});
      if(typeof result?.operationName!=='string'||!result.operationName||result.operationName.length>1000)throw failure('SCENE_INTERRUPTED');
      store.mutate(id,current=>{const active=requireScene(current,sceneId);if(active.operation?.token!==token)return;active.operation.name=result.operationName;active.operation.nextPollAt=0;active.status='generating';active.error=null;const entry=active.history.find(entry=>entry.id===token);if(entry){entry.status='generating';delete entry.error;}});
    }catch(error){const unknown=controller.signal.aborted||['AI_TIMEOUT','AI_CONNECTION','AI_UNAVAILABLE'].includes(error.code);failScene(id,sceneId,token,unknown?failure('SCENE_INTERRUPTED'):error);}
  }
  async function pollScene(id,sceneId){
    const key=`${id}/${sceneId}`;if(polling.has(key))return polling.get(key);
    const action=tracked(async()=>{
      let snapshot;
      store.mutate(id,project=>{const scene=requireScene(project,sceneId);if(scene.status!=='generating'||!scene.operation?.name||scene.operation.nextPollAt>Date.now())return;scene.operation.nextPollAt=Date.now()+pollInterval;snapshot=structuredClone(scene.operation);});
      if(!snapshot)return;
      let pending,published;
      try {
        const config=videoConfigured();const adapter=await provider();
        const result=await adapter.pollSceneVideo(snapshot.name,{apiKey:config.apiKey,signal:controller.signal});if(!result?.done)return;
        if(typeof result.videoUri!=='string')throw failure('AI_INVALID_RESPONSE');
        const directory=path.join(root,id);await mkdir(directory,{recursive:true});pending=path.join(directory,`.pending-${randomUUID()}.mp4`);published=path.join(directory,`${sceneId}-v${snapshot.version}-${snapshot.token}.mp4`);
        await adapter.downloadSceneVideo(result.videoUri,pending,{apiKey:config.apiKey,signal:controller.signal});controller.signal.throwIfAborted();
        if(!(await stat(pending)).size)throw failure('AI_INVALID_RESPONSE');await rename(pending,published);pending=null;
        let committed=false;store.mutate(id,project=>{const scene=requireScene(project,sceneId);if(scene.operation?.token!==snapshot.token||scene.version!==snapshot.version)return;scene.artifact={path:published,version:snapshot.version,token:snapshot.token};scene.status='completed';scene.error=null;scene.operation=null;const entry=scene.history.find(entry=>entry.id===snapshot.token);if(entry){entry.artifact={...scene.artifact};entry.status='completed';entry.completedAt=new Date().toISOString();delete entry.error;}committed=true;});
        if(committed)published=null;
      }catch(error){
        if(controller.signal.aborted)return;
        const transient=['AI_TIMEOUT','AI_CONNECTION','AI_UNAVAILABLE','AI_RATE_LIMIT','AI_NOT_CONFIGURED','AI_DOWNLOAD','AI_AUTH','AI_MODEL_ACCESS','AI_QUOTA'].includes(error.code);
        if(transient)store.mutate(id,project=>{const scene=requireScene(project,sceneId);if(scene.operation?.token===snapshot.token){scene.error=safeError(error);const entry=scene.history.find(entry=>entry.id===snapshot.token);if(entry)entry.error=scene.error;}});
        else failScene(id,sceneId,snapshot.token,error);
      }finally {if(pending)await rm(pending,{force:true}).catch(()=>{});if(published)await rm(published,{force:true}).catch(()=>{});}
    });
    polling.set(key,action);try {await action;}finally{polling.delete(key);}
  }
  function queueAssembly(id){
    let snapshot;
    store.mutate(id,project=>{
      if(!project.renderRequested||project.assembly.status==='rendering'||!project.scenes.every(scene=>currentClip(scene)&&!['starting','generating'].includes(scene.status)))return;
      if(project.assembly.status==='completed'&&currentAssembly(project)){project.renderRequested=false;return;}
      const token=randomUUID();project.assembly.status='rendering';project.assembly.error=null;project.assembly.token=token;
      snapshot={token,clips:project.scenes.map(scene=>scene.artifact.token),paths:project.scenes.map(scene=>scene.artifact.path)};
    });
    if(!snapshot)return;
    background(async()=>{
      const directory=path.join(root,id);let pending=path.join(directory,`.assembly-${snapshot.token}.mp4`),published=path.join(directory,`video-${snapshot.token}.mp4`);
      try {
        controller.signal.throwIfAborted();await mkdir(directory,{recursive:true});
        for(const file of snapshot.paths){const resolved=await realpath(file);const canonicalRoot=await realpath(directory);if(!within(canonicalRoot,resolved)||(await stat(resolved)).isFile()!==true)throw failure('SCENE_FILE_NOT_FOUND',404);}
        await (await provider()).assembleSceneVideos(snapshot.paths,pending,{signal:controller.signal});controller.signal.throwIfAborted();if(!(await stat(pending)).size)throw failure('AI_INVALID_RESPONSE');await rename(pending,published);pending=null;
        let committed=false;store.mutate(id,project=>{if(project.assembly.token!==snapshot.token||!project.scenes.every((scene,index)=>currentClip(scene)&&scene.artifact.token===snapshot.clips[index]))return;project.assembly={status:'completed',error:null,token:null,artifact:{path:published,clips:snapshot.clips,token:snapshot.token}};project.renderRequested=false;committed=true;});if(committed)published=null;
      }catch(error){store.mutate(id,project=>{if(project.assembly.token!==snapshot.token)return;project.assembly.status='failed';project.assembly.error=safeError(error);project.assembly.token=null;project.renderRequested=false;});}
      finally {if(pending)await rm(pending,{force:true}).catch(()=>{});if(published)await rm(published,{force:true}).catch(()=>{});}
    });
  }
  async function refresh(id){const project=requireProject(id);await Promise.all(project.scenes.filter(scene=>scene.status==='generating').map(scene=>pollScene(id,scene.id)));queueAssembly(id);return publicProject(requireProject(id));}
  function markStart(project,scene,config){const token=randomUUID();scene.status='starting';scene.error=null;scene.operation={token,version:scene.version,name:null,nextPollAt:0};scene.history.unshift({id:token,version:scene.version,createdAt:new Date().toISOString(),status:'starting',prompt:scene.prompt,effectivePrompt:effectivePrompt(project,scene),durationSeconds:scene.durationSeconds,videoModel:config.videoModel});return {id:scene.id,token};}

  router.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');if(closing)return next(failure('SCENE_CLOSED',503));next();});
  router.get('/',(req,res)=>{const config=settings();res.json({projects:store.list().map(publicProject),configured:Boolean(config.apiKey),provider:config.provider??'gemini',videoConfigured:Boolean(config.videoApiKey),videoModel:config.videoModel});});
  router.post('/projects',async(req,res)=>{
    const brief=validateBrief(req.body),config=configured();
    const script=validateScript(await tracked(async()=>{const result=await (await provider()).generateSceneScript(brief,{provider:config.provider??'gemini',apiKey:config.apiKey,model:config.translationModel,signal:controller.signal});controller.signal.throwIfAborted();return result;}));
    const project=store.create(brief,script);res.status(201).json({project:publicProject(project)});
  });
  router.get('/projects/:id',async(req,res)=>res.json({project:await refresh(req.params.id)}));
  router.put('/projects/:id/scenes/:sceneId',(req,res)=>{
    keys(req.body,['version','prompt','durationSeconds']);const prompt=text(req.body.prompt,6000);if(![4,6,8].includes(req.body.durationSeconds))throw failure('SCENE_INVALID');
    const project=store.mutate(req.params.id,project=>{const scene=requireScene(project,req.params.sceneId);if(!Number.isInteger(req.body.version)||req.body.version!==scene.version)throw failure('SCENE_VERSION_CONFLICT',409);if(['starting','generating'].includes(scene.status)||project.assembly.status==='rendering')throw failure('SCENE_BUSY',409);if(project.references.length&&req.body.durationSeconds!==8)throw failure('SCENE_INVALID');if(scene.prompt===prompt&&scene.durationSeconds===req.body.durationSeconds)return;scene.prompt=prompt;scene.durationSeconds=req.body.durationSeconds;scene.version++;scene.status='draft';scene.error=null;scene.operation=null;invalidate(project);});
    res.json({project:publicProject(project)});
  });
  router.post('/projects/:id/scenes/:sceneId/generate',(req,res)=>{
    keys(req.body,['version']);const config=videoConfigured();let start;
    const project=store.mutate(req.params.id,project=>{const scene=requireScene(project,req.params.sceneId);if(!Number.isInteger(req.body.version)||scene.version!==req.body.version)throw failure('SCENE_VERSION_CONFLICT',409);if(['starting','generating'].includes(scene.status)||project.assembly.status==='rendering')throw failure('SCENE_BUSY',409);invalidate(project);start=markStart(project,scene,config);});
    background(()=>startScene(project.id,start.id,start.token,config));res.status(202).json({project:publicProject(project)});
  });
  router.post('/projects/:id/generate-all',(req,res)=>{
    keys(req.body??{},['render'],[]);if(req.body?.render!==undefined&&typeof req.body.render!=='boolean')throw failure('SCENE_INVALID');const config=videoConfigured();const starts=[];
    const project=store.mutate(req.params.id,project=>{if(project.assembly.status==='rendering')throw failure('SCENE_BUSY',409);for(const scene of project.scenes)if(!currentClip(scene)&&!['starting','generating'].includes(scene.status))starts.push(markStart(project,scene,config));if(starts.length){project.assembly.status='idle';project.assembly.error=null;}if(req.body?.render)project.renderRequested=true;});
    for(const start of starts)background(()=>startScene(project.id,start.id,start.token,config));queueAssembly(project.id);res.status(202).json({project:publicProject(requireProject(project.id))});
  });
  router.post('/projects/:id/render',(req,res)=>{
    keys(req.body??{},[],[]);store.mutate(req.params.id,project=>{if(sceneBusy(project))throw failure('SCENE_BUSY',409);if(!project.scenes.every(currentClip))throw failure('SCENE_MISSING_CLIPS',409);project.renderRequested=true;});queueAssembly(req.params.id);res.status(202).json({project:publicProject(requireProject(req.params.id))});
  });
  router.delete('/projects/:id',async(req,res)=>{
    const project=requireProject(req.params.id);if(sceneBusy(project))throw failure('SCENE_BUSY',409);
    // Mark removal synchronously before awaiting disk work so no new generation can begin.
    store.delete(project.id);const directory=path.resolve(root,project.id);if(!within(root,directory))throw failure('SCENE_INVALID');await rm(directory,{recursive:true,force:true});res.json({deleted:true});
  });
  router.get('/projects/:id/files/:kind',async(req,res)=>{
    const project=requireProject(req.params.id),kind=req.params.kind;let artifact;
    const generation=req.query.generation,versionToken=req.query.v;
    if(generation!==undefined&&(typeof generation!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(generation)))throw failure('SCENE_FILE_NOT_FOUND',404);
    if(versionToken!==undefined&&typeof versionToken!=='string')throw failure('SCENE_FILE_NOT_FOUND',404);
    if(kind==='video'){if(generation===undefined&&project.assembly.status==='completed'&&currentAssembly(project)&&(!versionToken||project.assembly.artifact.token===versionToken))artifact=project.assembly.artifact;}
    else if(/^scene-[1-5]$/.test(kind)) {
      const scene=requireScene(project,kind);
      if(generation!==undefined)artifact=scene.history.find(entry=>entry.id===generation&&entry.status==='completed')?.artifact;
      else if(versionToken!==undefined)artifact=[scene.artifact,scene.legacyArtifact,...scene.history.filter(entry=>entry.status==='completed').map(entry=>entry.artifact)].find(candidate=>candidate?.token===versionToken);
      else artifact=scene.artifact;
    }
    if(!artifact?.path)throw failure('SCENE_FILE_NOT_FOUND',404);const directory=path.join(root,project.id);let canonicalRoot,resolved;
    try{const canonicalStudio=await realpath(root);canonicalRoot=await realpath(directory);resolved=await realpath(artifact.path);if(path.relative(path.join(canonicalStudio,project.id),canonicalRoot)!==''||!within(canonicalRoot,resolved)||(await stat(resolved)).isFile()!==true)throw Error();}catch{throw failure('SCENE_FILE_NOT_FOUND',404);}
    res.type('video/mp4');res.sendFile(path.relative(canonicalRoot,resolved),{root:canonicalRoot,dotfiles:'deny',acceptRanges:true},error=>{if(error){if(res.headersSent)res.destroy();else if(error.status===416)res.status(416).end();else res.status(404).json({error:safeError(failure('SCENE_FILE_NOT_FOUND'))});}});
  });
  router.use((req,res,next)=>next(failure('SCENE_NOT_FOUND',404)));
  router.use((error,req,res,next)=>{if(res.headersSent)return next(error);const safe=safeError(error);res.status(error.status??(safe.code==='SCENE_INTERNAL'?500:400)).json({error:safe});});
  router.close=()=>{if(!closePromise){closing=true;controller.abort(failure('SCENE_CLOSED',503));closePromise=(async()=>{while(tasks.size)await Promise.allSettled([...tasks]);store.close();})();}return closePromise;};
  return router;
}
