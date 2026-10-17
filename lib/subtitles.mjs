const graphemes = new Intl.Segmenter('vi', {granularity:'grapheme'});
const units = text => [...graphemes.segment(text)].map(item => item.segment);
const length = text => units(text).length;
const cleanText = text => String(text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').replace(/\s+/gu,' ').trim();

export function formatSrtTimestamp(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Thời gian phụ đề không hợp lệ.');
  const milliseconds = Math.round(seconds * 1000);
  const pad = (value,size=2) => String(value).padStart(size,'0');
  return `${pad(Math.floor(milliseconds/3600000))}:${pad(Math.floor(milliseconds/60000)%60)}:${pad(Math.floor(milliseconds/1000)%60)},${pad(milliseconds%1000,3)}`;
}

function wrapLines(text) {
  const lines=[];
  let line='';
  for (const word of text.split(' ')) {
    const parts=units(word);
    if (parts.length > 42) {
      if(line) { lines.push(line); line=''; }
      while(parts.length > 42) lines.push(parts.splice(0,42).join(''));
      line=parts.join('');
    } else if (!line || length(line)+1+parts.length <= 42) line += `${line ? ' ' : ''}${word}`;
    else { lines.push(line); line=word; }
  }
  if(line) lines.push(line);
  return lines;
}

/** Normalize original or translated segments; retain source identity across splits. */
export function normalizeCues(segments, duration) {
  if (!Array.isArray(segments) || !Number.isFinite(duration) || duration <= 0) throw new Error('Thời gian video không hợp lệ.');
  const result=[];
  let previousEnd=0;
  for(const [index, segment] of segments.entries()) {
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end <= segment.start) throw new Error('Thời gian phụ đề không hợp lệ hoặc bị đảo.');
    const start=Math.max(segment.start,previousEnd);
    const end=Math.min(segment.end,duration);
    const text=cleanText(segment.text);
    if (!text || start >= end) continue;
    const lines=wrapLines(text);
    const chunks=[];
    for(let i=0;i<lines.length;i+=2) chunks.push(lines.slice(i,i+2).join('\n'));
    const total=chunks.reduce((sum,chunk)=>sum+length(chunk),0);
    let cursor=start;
    const sourceId=segment.sourceId ?? segment.id ?? `segment-${index+1}`;
    for(const [part,chunk] of chunks.entries()) {
      const until=part===chunks.length-1 ? end : cursor + (end-start)*length(chunk)/total;
      result.push({id:chunks.length===1 ? String(segment.id ?? `cue-${index+1}`) : `${segment.id ?? `cue-${index+1}`}-${part+1}`,sourceId,start:cursor,end:until,original:String(segment.original ?? segment.text ?? ''),text:chunk,readingWarning:length(chunk.replaceAll('\n',' '))/(until-cursor)>22});
      cursor=until;
    }
    previousEnd=end;
  }
  return result;
}

export function toSrt(cues) {
  return cues.map((cue,index)=>`${index+1}\n${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}\n${String(cue.text).replaceAll('\r','').trim()}\n`).join('\n');
}

function assTimestamp(seconds) {
  const centiseconds=Math.round(seconds*100);
  const pad=value=>String(value).padStart(2,'0');
  return `${Math.floor(centiseconds/360000)}:${pad(Math.floor(centiseconds/6000)%60)}:${pad(Math.floor(centiseconds/100)%60)}.${pad(centiseconds%100)}`;
}

export function toAss(cues, style='classic') {
  if (!['classic','box'].includes(style)) throw new Error('Kiểu phụ đề không hợp lệ.');
  // Treat all user text as literal text, including ASS override syntax.
  const escape=text=>String(text).replaceAll('\\','＼').replaceAll('{','｛').replaceAll('}','｝').replace(/[\u0000-\u0008\u000B-\u001F]/g,'').replace(/\r?\n/g,'\\N');
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,${style==='box' ? '3,3,0' : '1,2,1'},2,52,52,38,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${cues.map(cue=>`Dialogue: 0,${assTimestamp(cue.start)},${assTimestamp(cue.end)},Default,,0,0,0,,${escape(cue.text)}`).join('\n')}\n`;
}
