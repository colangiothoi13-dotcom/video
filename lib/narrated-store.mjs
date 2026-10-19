import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

export const narratedBusy=project=>['queued','importing','transcribing','planning','generating','assembling'].includes(project.status);
const failure=(code,status)=>Object.assign(new Error(code),{code,status});
export const interruptedError={code:'NARRATED_INTERRUPTED',message:'Xử lý bị gián đoạn. Kiểm tra yêu cầu trước đó trước khi chủ động tiếp tục để tránh tính phí trùng.'};

/** Independent durable checkpoints; no subtitle retention or migrations apply. */
export function createNarratedStore(databasePath=resolve('.data','narrated.sqlite')){
 if(databasePath!==':memory:')mkdirSync(dirname(resolve(databasePath)),{recursive:true});
 const db=new DatabaseSync(databasePath);let closed=false;
 db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS narrated_projects(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,document TEXT NOT NULL)');
 const queries={get:db.prepare('SELECT document FROM narrated_projects WHERE id=?'),list:db.prepare('SELECT document FROM narrated_projects ORDER BY created_at DESC,rowid DESC'),insert:db.prepare('INSERT INTO narrated_projects VALUES(?,?,?)'),save:db.prepare('UPDATE narrated_projects SET document=? WHERE id=?'),delete:db.prepare('DELETE FROM narrated_projects WHERE id=?')};
 const get=id=>{const row=queries.get.get(id);return row?JSON.parse(row.document):null;};
 const list=()=>queries.list.all().map(row=>JSON.parse(row.document));
 function mutate(id,action){db.exec('BEGIN IMMEDIATE');try{const p=get(id);if(!p)throw failure('NARRATED_NOT_FOUND',404);action(p);p.updatedAt=new Date(Math.max(Date.now(),Date.parse(p.updatedAt)+1)).toISOString();queries.save.run(JSON.stringify(p),id);db.exec('COMMIT');return p;}catch(e){db.exec('ROLLBACK');throw e;}}
 return {get,list,mutate,
 create({sourceUrl,aspectRatio='9:16'}){const now=new Date().toISOString(),p={id:randomUUID(),title:'Video từ giọng gốc',sourceUrl,aspectRatio,duration:null,source:null,transcript:null,transcriptionUsage:null,continuity:'',windows:null,scenes:[],status:'queued',error:null,request:{type:'auto'},assembly:{status:'idle',error:null,artifact:null},createdAt:now,updatedAt:now};queries.insert.run(p.id,now,JSON.stringify(p));return p;},
 delete(id){const p=get(id);if(!p)throw failure('NARRATED_NOT_FOUND',404);if(narratedBusy(p))throw failure('NARRATED_BUSY',409);queries.delete.run(id);return p;},
 recover(){for(const p of list())if(narratedBusy(p))mutate(p.id,p=>{
   const ambiguous=['transcribing','planning'].includes(p.status)||p.scenes.some(s=>s.status==='starting'&&!s.operation?.name);
   if(ambiguous){p.status='failed';p.error={...interruptedError};for(const s of p.scenes)if(s.status==='starting'&&!s.operation?.name){s.status='failed';s.error={...interruptedError};for(const h of s.history??[])if(h.status==='starting'){h.status='failed';h.error={...interruptedError};h.completedAt=new Date().toISOString();}s.operation=null;}}
   else {p.status='queued';p.error=null;}
   if(p.assembly.status==='rendering'){p.assembly.status='idle';p.assembly.error=null;}
 });},
 close(){if(!closed){closed=true;db.close();}},
 };
}
