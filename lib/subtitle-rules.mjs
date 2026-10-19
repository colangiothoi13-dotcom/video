import {open} from 'node:fs/promises';

const RULES_URL=new URL('../prompts/gemini-subtitles.md',import.meta.url);
const MAX_RULES_BYTES=16*1024;
const invalidRules=()=>Object.assign(new Error('Quy tắc dịch Gemini không hợp lệ. Hãy kiểm tra tệp Markdown UTF-8, có nội dung và không vượt quá 16 KiB.'),{code:'AI_RULES_INVALID'});

/** Read each batch afresh without exposing filesystem errors or rule contents. */
export async function readGeminiSubtitleRules() {
  let file;
  try {
    file=await open(RULES_URL,'r');
    const info=await file.stat();
    if(!info.isFile()||info.size>MAX_RULES_BYTES)throw invalidRules();
    // The extra byte also catches a file that grows after stat, without an unbounded read.
    const buffer=Buffer.allocUnsafe(MAX_RULES_BYTES+1);
    let length=0;
    while(length<buffer.length) {
      const {bytesRead}=await file.read(buffer,length,buffer.length-length,null);
      if(!bytesRead)break;
      length+=bytesRead;
    }
    if(length>MAX_RULES_BYTES)throw invalidRules();
    const rules=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length)).trim();
    if(!rules)throw invalidRules();
    return rules;
  } catch {
    throw invalidRules();
  } finally {
    await file?.close().catch(()=>{});
  }
}
