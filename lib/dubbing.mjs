import {VOICES} from './dubbing-voices.mjs';
const fail=code=>Object.assign(new Error(code==='VERSION_CONFLICT'?'Phụ đề đã thay đổi. Hãy tải lại trước khi lồng tiếng.':'Phân vai hoặc giọng đọc không hợp lệ. Hãy giữ đủ các câu và chọn giọng trong danh sách.'),{code});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
export function defaultDubbingProfile(cues,subtitleVersion) {
  return {version:0,subtitleVersion,speakers:VOICES.slice(0,3).map((v,i)=>({id:`spk_${i+1}`,name:`Vai ${i+1}`,voice:v.id})),assignments:cues.map(c=>({cueId:c.id,speakerId:'spk_1',uncertain:true}))};
}
export function validateDubbingProfile(profile,cues,subtitleVersion) {
  if(!object(profile)||Object.keys(profile).some(k=>!['version','subtitleVersion','speakers','assignments'].includes(k))||!Number.isInteger(profile.version)||profile.version<0)throw fail('INVALID_DUBBING');
  if(profile.subtitleVersion!==subtitleVersion)throw fail('VERSION_CONFLICT');
  if(!Array.isArray(profile.speakers)||!profile.speakers.length||profile.speakers.length>8||!Array.isArray(profile.assignments)||profile.assignments.length!==cues.length||!cues.length)throw fail('INVALID_DUBBING');
  const ids=new Set(),voices=new Set(VOICES.map(v=>v.id));
  const speakers=profile.speakers.map(s=>{
    if(!object(s)||Object.keys(s).some(k=>!['id','name','voice'].includes(k))||typeof s.id!=='string'||!/^spk_[1-8]$/.test(s.id)||ids.has(s.id)||typeof s.name!=='string'||!s.name.trim()||s.name.length>60||/[\u0000-\u001f]/u.test(s.name)||!voices.has(s.voice))throw fail('INVALID_DUBBING');
    ids.add(s.id);return {id:s.id,name:s.name.trim(),voice:s.voice};
  });
  const byId=new Map(),cueIds=new Set(cues.map(c=>c.id));
  for(const a of profile.assignments) {
    if(!object(a)||Object.keys(a).some(k=>!['cueId','speakerId','uncertain'].includes(k))||!cueIds.has(a.cueId)||byId.has(a.cueId)||!ids.has(a.speakerId)||(a.uncertain!==undefined&&typeof a.uncertain!=='boolean'))throw fail('INVALID_DUBBING');
    byId.set(a.cueId,{cueId:a.cueId,speakerId:a.speakerId,uncertain:a.uncertain??false});
  }
  return {version:profile.version,subtitleVersion,speakers,assignments:cues.map(c=>byId.get(c.id))};
}
export function mapSpeakersToCues(cues,segments,subtitleVersion) {
  const labels=[...new Set(segments.filter(s=>typeof s.speaker==='string'&&s.speaker).map(s=>s.speaker))].slice(0,8);
  if(!labels.length)return defaultDubbingProfile(cues,subtitleVersion);
  const speakers=labels.map((label,i)=>({id:`spk_${i+1}`,name:`Vai ${i+1}`,voice:VOICES[i%VOICES.length].id}));
  const mapping=new Map(labels.map((label,i)=>[label,speakers[i].id]));
  const assignments=cues.map(c=>{
    const scores=new Map();
    for(const s of segments){const overlap=Math.max(0,Math.min(c.end,s.end)-Math.max(c.start,s.start));const id=mapping.get(s.speaker);if(overlap&&id)scores.set(id,(scores.get(id)??0)+overlap);}
    const ranked=[...scores].sort((a,b)=>b[1]-a[1]),total=ranked.reduce((sum,[,score])=>sum+score,0),best=ranked[0];
    return {cueId:c.id,speakerId:best?.[0]??speakers[0].id,uncertain:!best||best[1]<0.5*(c.end-c.start)||best[1]<0.8*total};
  });
  return {version:0,subtitleVersion,speakers,assignments};
}
export function speechTurns(cues,profile) {
  const valid=validateDubbingProfile(profile,cues,profile.subtitleVersion),assignments=new Map(valid.assignments.map(a=>[a.cueId,a.speakerId])),speakers=new Map(valid.speakers.map(s=>[s.id,s]));
  const turns=[];
  for(const c of cues){
    const speakerId=assignments.get(c.id),text=c.text.replace(/\s+/gu,' ').trim(),previous=turns.at(-1);
    if(previous&&previous.speakerId===speakerId&&c.start-previous.end<=0.35&&c.end-previous.start<=20&&previous.text.length+text.length+1<=500){previous.text+=` ${text}`;previous.end=c.end;previous.cueIds.push(c.id);}
    else turns.push({speakerId,voice:speakers.get(speakerId).voice,text,start:c.start,end:c.end,cueIds:[c.id]});
  }
  return turns;
}
