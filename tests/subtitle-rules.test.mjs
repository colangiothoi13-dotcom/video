import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

async function fixture(t,content) {
  const root=await mkdtemp(path.join(tmpdir(),'vietsub-subtitle-rules-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'lib'));
  await mkdir(path.join(root,'prompts'));
  const modulePath=path.join(root,'lib','subtitle-rules.mjs');
  const rulesPath=path.join(root,'prompts','gemini-subtitles.md');
  await copyFile(new URL('../lib/subtitle-rules.mjs',import.meta.url),modulePath);
  if(content!==undefined)await writeFile(rulesPath,content);
  const {readGeminiSubtitleRules}=await import(pathToFileURL(modulePath).href);
  return {root,rulesPath,readGeminiSubtitleRules};
}

async function rejectsInvalidRules(readRules,privatePath) {
  await assert.rejects(readRules,failure=>{
    assert.equal(failure.code,'AI_RULES_INVALID');
    assert.ok(!failure.message.includes(privatePath));
    assert.ok(!failure.message.includes('PRIVATE-RULES-MARKER'));
    assert.ok(!/ENOENT|EISDIR|EACCES/.test(failure.message));
    assert.equal(failure.cause,undefined);
    return true;
  });
}

test('rules resolve relative to the loader module and preserve Vietnamese UTF-8',async t=>{
  const {readGeminiSubtitleRules}=await fixture(t,'\n  # Quy tắc dịch phụ đề\nGiữ tên Nguyễn, số 42 và ý nghĩa.\n\n');
  assert.equal(await readGeminiSubtitleRules(),'# Quy tắc dịch phụ đề\nGiữ tên Nguyễn, số 42 và ý nghĩa.');
});

test('the next load reads edits instead of caching the first rules',async t=>{
  const {rulesPath,readGeminiSubtitleRules}=await fixture(t,'Quy tắc cũ.');
  assert.equal(await readGeminiSubtitleRules(),'Quy tắc cũ.');
  await writeFile(rulesPath,'Quy tắc mới.');
  assert.equal(await readGeminiSubtitleRules(),'Quy tắc mới.');
});

test('a file containing exactly 16 KiB of UTF-8 is allowed',async t=>{
  const content='á'.repeat(8192);
  const {readGeminiSubtitleRules}=await fixture(t,content);
  assert.equal(await readGeminiSubtitleRules(),content);
});

test('rules exceeding 16 KiB by UTF-8 byte count are rejected without their content',async t=>{
  const {root,readGeminiSubtitleRules}=await fixture(t,'PRIVATE-RULES-MARKER'+'á'.repeat(8192));
  await rejectsInvalidRules(readGeminiSubtitleRules,root);
});

test('empty and whitespace-only rules fail instead of removing translation instructions',async t=>{
  const {root,rulesPath,readGeminiSubtitleRules}=await fixture(t,'');
  await rejectsInvalidRules(readGeminiSubtitleRules,root);
  await writeFile(rulesPath,' \t\r\n\uFEFF ');
  await rejectsInvalidRules(readGeminiSubtitleRules,root);
});

test('a missing rules file fails safely and the next load recovers after it is restored',async t=>{
  const {root,rulesPath,readGeminiSubtitleRules}=await fixture(t);
  await rejectsInvalidRules(readGeminiSubtitleRules,root);
  await writeFile(rulesPath,'Quy tắc đã khôi phục.');
  assert.equal(await readGeminiSubtitleRules(),'Quy tắc đã khôi phục.');
});

test('a directory in place of the rules file is rejected with a safe error',async t=>{
  const {root,rulesPath,readGeminiSubtitleRules}=await fixture(t);
  await mkdir(rulesPath);
  await rejectsInvalidRules(readGeminiSubtitleRules,root);
});

test('invalid UTF-8 is rejected instead of silently altering the rules',async t=>{
  const {root,readGeminiSubtitleRules}=await fixture(t,Buffer.from([0x61,0xc3,0x28]));
  await rejectsInvalidRules(readGeminiSubtitleRules,root);
});

test('the checked-in rules can be loaded from the deployed module layout',async()=>{
  const {readGeminiSubtitleRules}=await import('../lib/subtitle-rules.mjs');
  const content=await readFile(new URL('../prompts/gemini-subtitles.md',import.meta.url),'utf8');
  assert.equal(await readGeminiSubtitleRules(),content.trim());
});
