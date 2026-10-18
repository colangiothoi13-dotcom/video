import test from 'node:test';
import assert from 'node:assert/strict';
import {invalidAiResponse,safeValidationDiagnostic,safeProviderUsage,safeAiMessage} from '../lib/ai-diagnostics.mjs';

test('invalid response diagnostics retain bounded facts without provider text or paths',()=>{
  const error=invalidAiResponse('SEGMENT_COUNT_MISMATCH',{index:0,count:1_000_000,expected:3,actual:2,text:'private transcript',path:'C:\\private',raw:{secret:'provider payload'}});
  assert.equal(error.code,'AI_INVALID_RESPONSE');
  assert.deepEqual(error.validation,{reason:'SEGMENT_COUNT_MISMATCH',index:0,count:1_000_000,expected:3,actual:2});
  assert.match(error.message,/số đoạn/i);
  assert.doesNotMatch(JSON.stringify(error),/private|secret|payload/);
  assert.deepEqual(invalidAiResponse('private reason').validation,{reason:'RESPONSE_STRUCTURE'});
  assert.deepEqual(invalidAiResponse().validation,{reason:'RESPONSE_STRUCTURE'});
});

test('diagnostics reject unknown reasons and unsafe fact values at the public boundary',()=>{
  assert.deepEqual(safeValidationDiagnostic({validation:{reason:'INVALID_OFFSET',index:4,count:1_000_001,expected:-1,actual:'2',source:'private'}}),{reason:'INVALID_OFFSET',index:4});
  for(const validation of [null,[],{},'INVALID_OFFSET',{reason:'private reason'},{reason:'toString'},{reason:{private:true}}])assert.equal(safeValidationDiagnostic({validation}),undefined);
  for(const bad of [NaN,Infinity,-1,1.5,1_000_001,'3',null,{valueOf:()=>3}])assert.deepEqual(safeValidationDiagnostic({validation:{reason:'INVALID_TIMING',index:bad,count:bad,expected:bad,actual:bad}}),{reason:'INVALID_TIMING'});
  assert.equal(safeValidationDiagnostic(null),undefined);
});

test('diagnostics copy allowlisted own data without invoking getters or inherited fields',()=>{
  let reads=0;
  const validation=Object.assign(Object.create({index:99}),{reason:'MISSING_WORD_TIMING',count:2});
  Object.defineProperty(validation,'actual',{get(){reads++;throw new Error('private getter');}});
  assert.deepEqual(safeValidationDiagnostic({validation}),{reason:'MISSING_WORD_TIMING',count:2});
  assert.equal(reads,0);
  assert.equal(safeValidationDiagnostic(Object.create({validation:{reason:'INVALID_TIMING'}})),undefined);
});

test('safe provider usage retains measured counts and durations while rejecting arbitrary data',()=>{
  const usage={input_tokens:15,output_tokens:6,total_tokens:21,seconds:1.25,input_tokens_details:{cached_tokens:2,text_tokens:4,audio_tokens:9,image_tokens:0,private:'secret'},output_tokens_details:{reasoning_tokens:3,text_tokens:2,audio_tokens:1,image_tokens:0,transcript:'private'},provider:'private',model:'private',message:'private transcript',raw:{private:true}};
  assert.deepEqual(safeProviderUsage(usage),{input_tokens:15,output_tokens:6,total_tokens:21,seconds:1.25,input_tokens_details:{cached_tokens:2,text_tokens:4,audio_tokens:9,image_tokens:0},output_tokens_details:{reasoning_tokens:3,text_tokens:2,audio_tokens:1,image_tokens:0}});
  assert.doesNotMatch(JSON.stringify(safeProviderUsage(usage)),/private|secret|transcript/);
  assert.equal(safeProviderUsage({input_tokens:-1,output_tokens:Infinity,total_tokens:'3',seconds:NaN,input_tokens_details:{cached_tokens:1.2},output_tokens_details:{reasoning_tokens:-1}}),undefined);
  assert.equal(safeProviderUsage({raw:'private'}),undefined);
  for(const value of [null,[],2,'private',undefined])assert.equal(safeProviderUsage(value),undefined);
});

test('provider usage excludes inherited values, unsafe integers, and accessor data',()=>{
  let reads=0;
  const usage=Object.assign(Object.create({input_tokens:22}),{total_tokens:Number.MAX_SAFE_INTEGER+1,seconds:0});
  Object.defineProperty(usage,'output_tokens',{get(){reads++;throw new Error('private getter');}});
  assert.deepEqual(safeProviderUsage(usage),{seconds:0});
  assert.equal(reads,0);
});

test('safe messages describe known validation failures without trusting error messages',()=>{
  const missing=invalidAiResponse('MISSING_WORD_TIMING');
  const count=invalidAiResponse('SEGMENT_COUNT_MISMATCH');
  missing.message='private provider payload';
  assert.match(safeAiMessage(missing),/mốc thời gian/i);
  assert.match(safeAiMessage(count),/số đoạn/i);
  assert.notEqual(safeAiMessage(missing),safeAiMessage(count));
  assert.equal(safeAiMessage({validation:{reason:'private reason'},message:'private text'}),undefined);
});
