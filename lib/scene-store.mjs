import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

const failure=(code,status)=>Object.assign(new Error(code),{code,status});
export const sceneBusy=project=>project.scenes.some(scene=>['starting','generating'].includes(scene.status))||project.assembly.status==='rendering';

// Earlier documents have no trustworthy generation prompt or timestamp. Keep
// their clip separately instead of inventing a historical snapshot for it.
function normalize(project) {
  for(const scene of project.scenes)if(!Array.isArray(scene.history)) {
    if(scene.artifact&&!scene.legacyArtifact)scene.legacyArtifact=structuredClone(scene.artifact);
    scene.history=[];
  }
  return project;
}

/** Scene projects have their own lifecycle; subtitle retention never applies here. */
export function createSceneStore(databasePath=resolve('.data','scenes.sqlite')) {
  if(databasePath!==':memory:')mkdirSync(dirname(resolve(databasePath)),{recursive:true});
  const database=new DatabaseSync(databasePath);let closed=false;
  database.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS scene_projects(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, document TEXT NOT NULL);`);
  const sql={get:database.prepare('SELECT document FROM scene_projects WHERE id=?'),list:database.prepare('SELECT document FROM scene_projects ORDER BY created_at DESC,rowid DESC'),insert:database.prepare('INSERT INTO scene_projects VALUES(?,?,?)'),save:database.prepare('UPDATE scene_projects SET document=? WHERE id=?'),delete:database.prepare('DELETE FROM scene_projects WHERE id=?')};
  const get=id=>{const row=sql.get.get(id);return row?normalize(JSON.parse(row.document)):null;};
  function mutate(id,action) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const project=get(id);if(!project)throw failure('SCENE_NOT_FOUND',404);
      const previousTime=Date.parse(project.updatedAt);action(project);
      project.updatedAt=new Date(Math.max(Date.now(),previousTime+1)).toISOString();sql.save.run(JSON.stringify(project),id);database.exec('COMMIT');return project;
    }catch(error){database.exec('ROLLBACK');throw error;}
  }
  return {
    get,list:()=>sql.list.all().map(row=>normalize(JSON.parse(row.document))),mutate,
    create(brief,script){
      const time=new Date().toISOString();
      const project={id:randomUUID(),title:script.title,idea:brief.idea,identity:{character:brief.character,product:brief.product,style:brief.style,aspectRatio:brief.aspectRatio,referenceCount:brief.references.length},references:brief.references,
        scenes:script.scenes.map(scene=>({id:scene.id,title:scene.title,durationSeconds:brief.references.length?8:scene.durationSeconds,action:scene.action,visual:scene.visual,prompt:scene.prompt,version:1,status:'draft',error:null,artifact:null,operation:null,history:[]})),
        assembly:{status:'idle',error:null,artifact:null,token:null},renderRequested:false,createdAt:time,updatedAt:time};
      sql.insert.run(project.id,time,JSON.stringify(project));return project;
    },
    recover(){
      for(const row of sql.list.all()) {
        const old=normalize(JSON.parse(row.document));
        if(!old.scenes.some(scene=>scene.status==='starting'||scene.history.some(entry=>entry.status==='starting'))&&old.assembly.status!=='rendering')continue;
        mutate(old.id,project=>{
          for(const scene of project.scenes) {
            const error={code:'SCENE_INTERRUPTED',message:'Yêu cầu tạo cảnh bị gián đoạn trước khi lưu mã tác vụ. Kiểm tra Google trước khi chủ động tạo lại để tránh tính phí trùng.'};
            if(scene.status==='starting'){scene.status='failed';scene.operation=null;scene.error=error;}
            for(const entry of scene.history)if(entry.status==='starting'){entry.status='failed';entry.error=error;entry.completedAt=new Date().toISOString();}
          }
          if(project.assembly.status==='rendering'){project.assembly.status='failed';project.assembly.token=null;project.assembly.error={code:'SCENE_INTERRUPTED',message:'Ghép video bị gián đoạn. Bạn có thể ghép lại từ các cảnh đã có.'};}
          project.renderRequested=false;
        });
      }
    },
    delete(id){
      database.exec('BEGIN IMMEDIATE');
      try {const project=get(id);if(!project)throw failure('SCENE_NOT_FOUND',404);if(sceneBusy(project))throw failure('SCENE_BUSY',409);sql.delete.run(id);database.exec('COMMIT');return project;}
      catch(error){database.exec('ROLLBACK');throw error;}
    },
    close(){if(!closed){closed=true;database.close();}},
  };
}
