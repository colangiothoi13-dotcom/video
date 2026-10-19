import test from 'node:test';
import assert from 'node:assert/strict';
const clips=await import('../lib/clips.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const job=()=>({duration:120,subtitleVersion:3,renderedVersion:3,dubbing:{version:2},dubbingOutput:{version:2,subtitleVersion:3},artifacts:{inputPath:'original.mp4',videoPath:'captioned.mp4',dubbedPath:'dubbed.mp4'}});
const request=()=>({source:'video',subtitleVersion:3,dubbingVersion:2,ranges:[{start:2.25,end:8.5},{start:17,end:21}]});

test('manual ranges preserve exact requested boundaries and select only the explicit artifact',()=>{
 assert.equal(typeof clips.validateClipRequest,'function');assert.equal(typeof clips.clipSourceArtifact,'function');
 for(const [source,file]of [['source','original.mp4'],['video','captioned.mp4'],['dubbed','dubbed.mp4']]){const input={...request(),source},checked=clips.validateClipRequest(input,job());assert.deepEqual(checked,input);assert.notEqual(checked.ranges,input.ranges);assert.equal(clips.clipSourceArtifact(job(),checked),file);}
 assert.doesNotThrow(()=>clips.validateClipRequest({...request(),ranges:[{start:0.751,end:1.001}]},job()),'decimal timestamp subtraction must allow a quarter-second clip');
});
test('manual cuts reject malformed, excessive, reversed or out-of-bounds ranges',()=>{
 assert.equal(typeof clips.validateClipRequest,'function');
 for(const patch of [{source:'https://bad.example'}, {path:'C:/private.mp4'}, {ranges:[]}, {ranges:Array(21).fill({start:0,end:1})}, ...[NaN,Infinity,-1,'1',null].map(start=>({ranges:[{start,end:4}]})), {ranges:[{start:4,end:4}]}, {ranges:[{start:4,end:3}]}, {ranges:[{start:0,end:120.01}]}, {ranges:[{start:0,end:0.1}]}, {ranges:[{start:0,end:1,path:'bad'}]}])assert.throws(()=>clips.validateClipRequest({...request(),...patch},job()),{code:'INVALID_CLIPS'});
 const long={...job(),duration:1500};assert.throws(()=>clips.validateClipRequest({...request(),ranges:[{start:0,end:1500},{start:0,end:1}]},long),{code:'INVALID_CLIPS'});
});
test('clips refuse stale subtitle/dubbing versions and unavailable outputs without changing the selected source',()=>{
 assert.equal(typeof clips.validateClipRequest,'function');
 assert.throws(()=>clips.validateClipRequest({...request(),subtitleVersion:2},job()),{code:'VERSION_CONFLICT'});
 assert.throws(()=>clips.validateClipRequest({...request(),source:'dubbed',dubbingVersion:1},job()),{code:'DUBBING_VERSION_CONFLICT'});
 assert.throws(()=>clips.validateClipRequest(request(),{...job(),renderedVersion:2}),{code:'CLIP_SOURCE_UNAVAILABLE'});
 assert.throws(()=>clips.validateClipRequest({...request(),source:'dubbed'},{...job(),dubbingOutput:{version:1,subtitleVersion:3}}),{code:'CLIP_SOURCE_UNAVAILABLE'});
 assert.throws(()=>clips.clipSourceArtifact({...job(),artifacts:{}},request()),{code:'CLIP_SOURCE_UNAVAILABLE'});
});
