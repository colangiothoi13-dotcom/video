const reasonMessages=Object.freeze({
  RESPONSE_JSON:'AI trả về dữ liệu JSON không hợp lệ. Vui lòng thử lại công việc.',
  INCOMPLETE_INTERACTION:'AI chưa hoàn tất phản hồi. Vui lòng thử lại công việc.',
  RESPONSE_STRUCTURE:'AI trả về cấu trúc nội dung không hợp lệ. Vui lòng thử lại công việc.',
  NO_MODEL_OUTPUT:'AI không trả về nội dung kết quả. Vui lòng thử lại công việc.',
  INVALID_ANNOTATION:'AI trả về chú thích lời nói không hợp lệ. Vui lòng thử lại công việc.',
  MISSING_WORD_TIMING:'AI không trả đủ mốc thời gian cho từng từ. Vui lòng thử lại công việc.',
  INVALID_OFFSET:'AI trả về mốc thời gian sai định dạng. Vui lòng thử lại công việc.',
  INVALID_TIMING:'AI trả về mốc thời gian ngoài phạm vi lời nói. Vui lòng thử lại công việc.',
  OUT_OF_ORDER_TIMING:'AI trả về các mốc thời gian không đúng thứ tự. Vui lòng thử lại công việc.',
  TRANSCRIPT_MISMATCH:'Nội dung lời nói và các từ có mốc thời gian không khớp. Vui lòng thử lại công việc.',
  UNANCHORED_WORD_TIMING:'AI không xác định rõ mốc thời gian của từ trong âm thanh. Vui lòng thử lại công việc.',
  INVALID_FILE_METADATA:'Dịch vụ AI trả về thông tin tệp âm thanh không hợp lệ. Vui lòng thử lại công việc.',
  INVALID_UPLOAD_SESSION:'Dịch vụ AI không tạo được phiên tải âm thanh hợp lệ. Vui lòng thử lại công việc.',
  TRANSLATION_JSON:'AI trả về bản dịch có dữ liệu JSON không hợp lệ. Vui lòng thử lại công việc.',
  SEGMENT_COUNT_MISMATCH:'AI trả về số đoạn dịch không khớp với lời nói. Vui lòng thử lại công việc.',
  INVALID_SEGMENT:'AI trả về một đoạn dịch không hợp lệ. Vui lòng thử lại công việc.',
  UNKNOWN_ID:'AI trả về đoạn dịch không thuộc lời nói đã gửi. Vui lòng thử lại công việc.',
  DUPLICATE_ID:'AI trả về các đoạn dịch bị trùng. Vui lòng thử lại công việc.',
  EMPTY_TRANSLATION:'AI trả về đoạn dịch trống. Vui lòng thử lại công việc.',
});

const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
// Read data properties only: inherited fields and accessors are not diagnostics.
function ownValue(value,key) {
  if(!isObject(value))return undefined;
  try {const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor&&'value' in descriptor?descriptor.value:undefined;}
  catch {return undefined;}
}
const knownReason=value=>typeof value==='string'&&Object.hasOwn(reasonMessages,value);
function diagnostic(reason,facts) {
  const result={reason};
  for(const key of ['index','count','expected','actual']) {
    const value=ownValue(facts,key);
    if(Number.isInteger(value)&&value>=0&&value<=1_000_000)result[key]=value;
  }
  return result;
}

/** Bounded structural facts only; never retain model output, IDs, paths, or errors. */
export function invalidAiResponse(reason='RESPONSE_STRUCTURE',facts={}) {
  const safeReason=knownReason(reason)?reason:'RESPONSE_STRUCTURE';
  return Object.assign(new Error(reasonMessages[safeReason]),{code:'AI_INVALID_RESPONSE',validation:diagnostic(safeReason,facts)});
}

export function safeValidationDiagnostic(error) {
  const value=ownValue(error,'validation'),reason=ownValue(value,'reason');
  return knownReason(reason)?diagnostic(reason,value):undefined;
}

export function safeAiMessage(error) {
  const validation=safeValidationDiagnostic(error);
  return validation?reasonMessages[validation.reason]:undefined;
}

/** Provider accounting contains measured numbers, never provider payload fields. */
export function safeProviderUsage(value) {
  if(!isObject(value))return undefined;
  const result={};
  const copy=(source,target,keys)=>{
    for(const key of keys) {
      const amount=ownValue(source,key);
      if(Number.isSafeInteger(amount)&&amount>=0)target[key]=amount;
    }
  };
  copy(value,result,['input_tokens','output_tokens','total_tokens']);
  const seconds=ownValue(value,'seconds');
  if(Number.isFinite(seconds)&&seconds>=0&&seconds<=Number.MAX_SAFE_INTEGER)result.seconds=seconds;
  for(const [key,fields] of [
    ['input_tokens_details',['cached_tokens','text_tokens','audio_tokens','image_tokens']],
    ['output_tokens_details',['reasoning_tokens','text_tokens','audio_tokens','image_tokens','accepted_prediction_tokens','rejected_prediction_tokens']],
  ]) {
    const details={};copy(ownValue(value,key),details,fields);
    if(Object.keys(details).length)result[key]=details;
  }
  return Object.keys(result).length?result:undefined;
}
