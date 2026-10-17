import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);
const storeModule = new URL('../lib/store.mjs', import.meta.url).href;
const configModule = new URL('../lib/config.mjs', import.meta.url).href;
const makeInput = () => ({ title: 'Tiếng Việt 🎬', sourceType: 'upload', targetLanguage: 'vi', subtitleStyle: 'classic' });

function fixture(t, createStore) {
  const dir = mkdtempSync(join(tmpdir(), 'vietsub-store-'));
  const stores = [];
  t.after(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, path: join(dir, 'jobs.sqlite'), open: (...args) => { const store = createStore(...args); stores.push(store); return store; } };
}

test('jobs and private pipeline checkpoints survive reopening without exposing disk paths', async t => {
  const { createStore } = await import(storeModule);
  const { path, open } = fixture(t, createStore);
  let store = open(path);
  const job = store.createJob({ ...makeInput(), artifacts: { source: 'D:\\private\\video.mp4' } });
  store.updateJob(job.id, { duration: 12, checkpoint: { stage: 'transcribe', sourceHash: 'abc' }, artifacts: { audio: 'D:\\private\\audio.mp3' } });
  store.close();
  store = open(path);

  assert.equal(store.getJob(job.id).title, 'Tiếng Việt 🎬');
  assert.deepEqual(store.getJobInternal(job.id).checkpoint, { stage: 'transcribe', sourceHash: 'abc' });
  assert.equal(store.getJobInternal(job.id).artifacts.source, 'D:\\private\\video.mp4');
  assert.equal(store.getJobInternal(job.id).artifacts.audio, 'D:\\private\\audio.mp3');
  assert.equal(JSON.stringify(store.getJob(job.id)).includes('private'), false);
  assert.equal(store.getJob('missing'), null);
});

test('only the lease owner can claim, heartbeat, or recover, and stale recovery keeps checkpoints', async t => {
  const { createStore } = await import(storeModule);
  const { path, open } = fixture(t, createStore);
  let now = Date.parse('2026-10-17T00:00:00Z');
  const a = open(path, { now: () => now });
  const b = open(path, { now: () => now });

  const first = a.createJob(makeInput());
  a.createJob(makeInput());
  assert.equal(a.claimNextJob('a').id, first.id);
  a.updateJob(first.id, { checkpoint: { stage: 'translate' } });
  assert.equal(a.claimNextJob('a'), null, 'one running job even for the owner');
  assert.equal(b.claimNextJob('b'), null);
  assert.equal(b.heartbeat('b'), false);
  assert.equal(b.releaseWorker('a'), false);
  assert.equal(b.recoverInterruptedJobs('b'), 0);
  assert.equal(a.heartbeat('a'), true);
  assert.equal(a.recoverInterruptedJobs('a'), 0, 'a live owner cannot reset its running job');
  now += 30_001;
  assert.equal(b.recoverInterruptedJobs('b'), 1);
  assert.equal(a.heartbeat('a'), false);
  assert.throws(() => a.updateJob(first.id, { progress: 90 }, { workerId: 'a' }), { code: 'WORKER_LEASE_LOST' });
  assert.equal(b.getJob(first.id).status, 'queued');
  assert.deepEqual(b.getJobInternal(first.id).checkpoint, { stage: 'translate' });
  assert.equal(b.claimNextJob('b').id, first.id);
  assert.equal(b.getWorkerStatus().workerId, 'b');
});

test('two separate processes cannot both claim queued jobs', async t => {
  const { createStore } = await import(storeModule);
  const { path, open } = fixture(t, createStore);
  const store = open(path);
  store.createJob(makeInput());
  store.createJob(makeInput());
  store.close();
  const script = `import {createStore} from ${JSON.stringify(storeModule)}; const s=createStore(process.argv[1]); console.log(JSON.stringify(s.claimNextJob(process.argv[2])));`;
  const results = await Promise.all(['one', 'two'].map(id => run(process.execPath, ['--input-type=module', '-e', script, path, id])));
  const claimed = results.map(r => JSON.parse(r.stdout.trim())).filter(Boolean);
  assert.equal(claimed.length, 1);
});

test('subtitle versions reject lost updates and preserve original source data', async t => {
  const { createStore } = await import(storeModule);
  const { path, open } = fixture(t, createStore);
  const store = open(path);

  const job = store.createJob(makeInput());
  store.updateJob(job.id, { duration: 10 });
  const cue = { id: 'c1', sourceId: 's1', start: 0, end: 3, original: 'Hello', text: 'Xin chào 🎬', readingWarning: false };
  assert.equal(store.saveCues(job.id, 0, [cue]).job.subtitleVersion, 1);
  assert.throws(() => store.saveCues(job.id, 0, [{ id: 'c1', text: 'Mất dữ liệu' }]), { code: 'VERSION_CONFLICT' });
  const saved = store.saveCues(job.id, 1, [{ id: 'c1', text: 'Chào bạn' }]);
  assert.equal(saved.job.subtitleVersion, 2);
  assert.deepEqual(saved.cues, [{ ...cue, text: 'Chào bạn' }]);
  assert.deepEqual(store.getCues(job.id), saved.cues);
  assert.throws(() => store.saveCues(job.id, 2, [{ ...cue, end: 11 }]), { code: 'INVALID_CUES' });
});

test('job ordering, filtering and retention preserve the first successful expiry', async t => {
  const { createStore } = await import(storeModule);
  const { path, open } = fixture(t, createStore);
  let now = Date.parse('2026-10-17T00:00:00Z');
  const store = open(path, { now: () => now });

  const a = store.createJob(makeInput());
  now += 1000;
  const b = store.createJob(makeInput());
  assert.deepEqual(store.listJobs().map(j => j.id), [b.id, a.id]);
  const completed = store.updateJob(a.id, { status: 'completed' });
  now += 1000;
  store.updateJob(a.id, { status: 'queued' });
  const again = store.updateJob(a.id, { status: 'completed' });
  assert.equal(again.expiresAt, completed.expiresAt);
  assert.equal(store.listJobs('queued').length, 1);
  assert.throws(() => store.updateJob(b.id, { status: 'invented' }), { code: 'INVALID_JOB' });
});

test('configuration persists server secrets while public status never returns the key', async t => {
  const { readConfig, writeConfig, getConfigStatus } = await import(configModule);
  const { dir } = fixture(t);
  const options = { dataDir: dir, env: {} };
  assert.deepEqual(getConfigStatus(options), { configured: false, translationModel: 'gpt-5.6-terra' });
  const status = writeConfig({ apiKey: 'sk-secret-unit-test', translationModel: 'gpt-example' }, options);
  assert.deepEqual(status, { configured: true, translationModel: 'gpt-example' });
  assert.equal(readConfig(options).apiKey, 'sk-secret-unit-test');
  writeConfig({ translationModel: 'gpt-second' }, options);
  assert.equal(readConfig(options).apiKey, 'sk-secret-unit-test');
  assert.equal(JSON.stringify(getConfigStatus(options)).includes('secret'), false);
});

test('environment credentials override settings without being copied into saved configuration', async t => {
  const { readConfig, writeConfig, getConfigStatus } = await import(configModule);
  const { dir } = fixture(t);
  const options = { dataDir: dir, env: { OPENAI_API_KEY: 'sk-environment-only', OPENAI_TRANSLATION_MODEL: 'gpt-environment' } };
  writeConfig({ translationModel: 'gpt-saved' }, options);
  assert.deepEqual(readConfig(options), { apiKey: 'sk-environment-only', translationModel: 'gpt-environment' });
  assert.deepEqual(getConfigStatus(options), { configured: true, translationModel: 'gpt-environment' });
  assert.equal(readFileSync(join(dir, 'config.json'), 'utf8').includes('sk-environment-only'), false);
  writeConfig({ apiKey: 'sk-saved' }, options);
  assert.deepEqual(readConfig({ dataDir: dir, env: {} }), { apiKey: 'sk-saved', translationModel: 'gpt-saved' });
  assert.equal(readConfig(options).apiKey, 'sk-environment-only');
});

test('a stale worker cannot save initial or edited cues after lease takeover', async t => {
  const { createStore } = await import(storeModule);
  const { path, open } = fixture(t, createStore);
  let now = Date.parse('2026-10-17T00:00:00Z');
  const a = open(path, { now: () => now });
  const b = open(path, { now: () => now });
  const job = a.createJob(makeInput());
  a.updateJob(job.id, { duration: 10 });
  a.claimNextJob('a');
  const cue = { id: 'c1', sourceId: 's1', start: 0, end: 3, original: 'Hello', text: 'Xin chào', readingWarning: false };
  now += 30_001;
  assert.equal(b.claimNextJob('b').id, job.id);
  assert.throws(() => a.saveCues(job.id, 0, [cue], { workerId: 'a' }), { code: 'WORKER_LEASE_LOST' });
  assert.deepEqual(b.getCues(job.id), []);
  assert.equal(b.getJob(job.id).subtitleVersion, 0);
  const saved = b.saveCues(job.id, 0, [cue], { workerId: 'b' });
  assert.equal(saved.job.subtitleVersion, 1);
  assert.throws(() => a.saveCues(job.id, 1, [{ id: 'c1', text: 'Stale update' }], { workerId: 'a' }), { code: 'WORKER_LEASE_LOST' });
  assert.deepEqual(b.getCues(job.id), [cue]);
  assert.equal(b.getJob(job.id).subtitleVersion, 1);
  assert.equal(b.saveCues(job.id, 1, [{ id: 'c1', text: 'Chào bạn' }]).job.subtitleVersion, 2, 'browser edits can omit worker fencing');
});

test('job option updates persist normalized defaults rather than null values', async t => {
  const { createStore } = await import(storeModule);
  const { path, open } = fixture(t, createStore);
  let store = open(path);
  const job = store.createJob({ ...makeInput(), targetLanguage: 'ja', subtitleStyle: 'box' });
  const updated = store.updateJob(job.id, { targetLanguage: null, subtitleStyle: null });
  assert.equal(updated.targetLanguage, 'vi');
  assert.equal(updated.subtitleStyle, 'classic');
  store.close();
  store = open(path);
  assert.equal(store.getJob(job.id).targetLanguage, 'vi');
  assert.equal(store.getJob(job.id).subtitleStyle, 'classic');
});

test('unknown progress stays null until measured progress is saved', async t => {
  const { createStore } = await import(storeModule);
  const { path, open } = fixture(t, createStore);
  let store = open(path);
  const job = store.createJob(makeInput());
  assert.equal(job.progress, null);
  assert.equal(store.claimNextJob('worker').progress, null);
  assert.equal(store.updateJob(job.id, { stage: 'render', progress: 25 }).progress, 25);
  assert.equal(store.updateJob(job.id, { progress: null }).progress, null);
  for (const progress of [-1, 101, Infinity, NaN, '25']) {
    assert.throws(() => store.updateJob(job.id, { progress }), { code: 'INVALID_JOB' });
  }
  store.close();
  store = open(path);
  assert.equal(store.getJob(job.id).progress, null);
});

test('cue snapshots persist matching versions and text while omitting private artifacts', async t => {
  const { createStore } = await import(storeModule);
  const { path, open } = fixture(t, createStore);
  let store = open(path);
  const job = store.createJob({ ...makeInput(), artifacts: { source: 'D:\\private\\source.mp4' } });
  store.updateJob(job.id, { duration: 10, checkpoint: { secretPath: 'D:\\private\\audio.mp3' } });
  const cue = { id: 'c1', sourceId: 's1', start: 0, end: 3, original: 'Hello', text: 'Xin chào', readingWarning: false };
  store.saveCues(job.id, 0, [cue]);
  const first = store.getCueSnapshot(job.id);
  assert.equal(first.job.subtitleVersion, 1);
  assert.deepEqual(first.cues, [cue]);
  store.saveCues(job.id, 1, [{ id: 'c1', text: 'Chào bạn' }]);
  assert.equal(first.job.subtitleVersion, 1, 'snapshots remain detached from later updates');
  assert.equal(first.cues[0].text, 'Xin chào');
  store.close();
  store = open(path);
  const second = store.getCueSnapshot(job.id);
  assert.equal(second.job.subtitleVersion, 2);
  assert.deepEqual(second.cues, [{ ...cue, text: 'Chào bạn' }]);
  assert.equal('artifacts' in second.job, false);
  assert.equal('checkpoint' in second.job, false);
  assert.equal(JSON.stringify(second).includes('private'), false);
});

test('reading speed counts emoji graphemes consistently with subtitle normalization', async t => {
  const { createStore } = await import(storeModule);
  const { path, open } = fixture(t, createStore);
  const store = open(path);
  const job = store.createJob(makeInput());
  store.updateJob(job.id, { duration: 2 });
  const family = '👨‍👩‍👧‍👦';
  const cue = { id: 'c1', sourceId: 's1', start: 0, end: 1, original: 'Hello', text: family.repeat(4) };
  assert.equal(store.saveCues(job.id, 0, [cue]).cues[0].readingWarning, false);
  assert.equal(store.saveCues(job.id, 1, [{ id: 'c1', text: family.repeat(23) }]).cues[0].readingWarning, true);
  assert.equal(store.saveCues(job.id, 2, [{ id: 'c1', text: '12345678901 12345678901' }]).cues[0].readingWarning, true);
});

test('cancellation checks current state after a worker claims a previously queued job', async t => {
  const { createStore } = await import(storeModule);
  const { path, open } = fixture(t, createStore);
  let now = Date.parse('2026-10-17T00:00:00Z');
  const api = open(path, { now: () => now });
  const worker = open(path, { now: () => now });
  const job = api.createJob(makeInput());
  assert.equal(api.getJob(job.id).status, 'queued');
  worker.claimNextJob('worker');
  const cancelled = api.requestCancellation(job.id);
  assert.equal(cancelled.status, 'running');
  assert.equal(cancelled.expiresAt, null);
  assert.equal(worker.getJobInternal(job.id).cancelRequested, true);
  const queued = api.createJob(makeInput());
  const immediate = api.requestCancellation(queued.id);
  assert.equal(immediate.status, 'cancelled');
  assert.equal(api.getJobInternal(queued.id).cancelRequested, true);
  assert.equal(Date.parse(immediate.expiresAt) - Date.parse(immediate.updatedAt), 86_400_000);
  now += 1000;
  assert.deepEqual(api.requestCancellation(queued.id), immediate, 'terminal cancellation is unchanged');
});

test('a stale requeue request cannot replace a state already claimed by a worker', async t => {
  const { createStore } = await import(storeModule);
  const { path, open } = fixture(t, createStore);
  const api = open(path);
  const worker = open(path);
  const job = api.createJob(makeInput());
  api.updateJob(job.id, { status: 'failed' });
  assert.equal(api.getJob(job.id).status, 'failed');
  api.updateJob(job.id, { status: 'queued' }, { expectedStatuses: ['failed', 'cancelled'], requireUnexpired: true });
  worker.claimNextJob('worker');
  const before = api.getJobInternal(job.id);
  assert.throws(() => api.updateJob(job.id, { status: 'queued', cancelRequested: false }, { expectedStatuses: ['completed', 'failed', 'cancelled'], requireUnexpired: true }), { code: 'JOB_STATE_CONFLICT' });
  assert.deepEqual(api.getJobInternal(job.id), before);
});

test('expired cancellation and guarded updates reject without mutating the job', async t => {
  const { createStore } = await import(storeModule);
  const { path, open } = fixture(t, createStore);
  let now = Date.parse('2026-10-17T00:00:00Z');
  const store = open(path, { now: () => now });
  for (const expiresByStatus of [false, true]) {
    const job = store.createJob(makeInput());
    store.updateJob(job.id, expiresByStatus ? { status: 'expired' } : { status: 'failed' });
    now += 86_400_000;
    const before = store.getJobInternal(job.id);
    assert.throws(() => store.requestCancellation(job.id), { code: 'JOB_EXPIRED' });
    assert.throws(() => store.updateJob(job.id, { status: 'queued' }, { expectedStatuses: ['failed', 'cancelled'], requireUnexpired: true }), { code: 'JOB_EXPIRED' });
    assert.deepEqual(store.getJobInternal(job.id), before);
  }
});

test('guarded worker publication atomically rejects an accepted cancellation without changing artifacts',async t=>{
  const {createStore}=await import(storeModule);const {path,open}=fixture(t,createStore);
  const worker=open(path);const api=open(path);const job=api.createJob({...makeInput(),artifacts:{videoPath:'previous.mp4'}});worker.claimNextJob('worker');
  assert.equal(api.requestCancellation(job.id).status,'running');const before=api.getJobInternal(job.id);
  assert.throws(()=>worker.updateJob(job.id,{status:'completed',renderedVersion:2,artifacts:{videoPath:'replacement.mp4'}},{workerId:'worker',expectedStatuses:['running'],requireUnexpired:true,requireNotCancelled:true}),{code:'JOB_CANCELLED'});
  assert.deepEqual(api.getJobInternal(job.id),before);
});

test('worker publication deadline is exclusive and retains lease and state guards',async t=>{
  const {createStore}=await import(storeModule);const {path,open}=fixture(t,createStore);let now=Date.parse('2026-10-17T00:00:00Z');const store=open(path,{now:()=>now});
  for(const delta of [-1,0,1]){
    const job=store.createJob({...makeInput(),artifacts:{videoPath:'previous.mp4'}});const deadline=now+1000;store.updateJob(job.id,{expiresAt:new Date(deadline).toISOString()});store.claimNextJob('worker');now=deadline+delta;
    const options={workerId:'worker',expectedStatuses:['running'],requireUnexpired:true,requireNotCancelled:true};
    if(delta<0)assert.equal(store.updateJob(job.id,{status:'completed'},options).status,'completed');
    else {const before=store.getJobInternal(job.id);assert.throws(()=>store.updateJob(job.id,{status:'completed',artifacts:{videoPath:'replacement.mp4'}},options),{code:'JOB_EXPIRED'});assert.deepEqual(store.getJobInternal(job.id),before);store.updateJob(job.id,{status:'expired'});}
  }
  const job=store.createJob(makeInput());store.claimNextJob('worker');assert.throws(()=>store.updateJob(job.id,{status:'completed'},{workerId:'other',expectedStatuses:['running'],requireUnexpired:true,requireNotCancelled:true}),{code:'WORKER_LEASE_LOST'});
  store.updateJob(job.id,{status:'cancelled'});assert.throws(()=>store.updateJob(job.id,{status:'completed'},{workerId:'worker',expectedStatuses:['running'],requireUnexpired:true,requireNotCancelled:true}),{code:'JOB_STATE_CONFLICT'});
});
