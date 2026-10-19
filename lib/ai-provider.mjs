import * as gemini from './ai.mjs';
import * as openai from './openai.mjs';

function adapter(options){
  if(options.provider==='openai')return openai;
  if(options.provider===undefined||options.provider==='gemini')return gemini;
  throw Object.assign(new Error('Nhà cung cấp AI không hợp lệ.'),{code:'AI_NOT_CONFIGURED'});
}
export const transcribe=(file,options={})=>adapter(options).transcribe(file,options);
export const translateSegments=(segments,options={})=>adapter(options).translateSegments(segments,options);
export const testAiConnection=(options={})=>adapter(options).testAiConnection(options);
