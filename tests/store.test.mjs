import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
  assert.deepEqual(getConfigStatus({ dataDir: dir }), { configured: false, translationModel: 'gpt-5.6-terra' });
  const status = writeConfig({ apiKey: 'sk-secret-unit-test', translationModel: 'gpt-example' }, { dataDir: dir });
  assert.deepEqual(status, { configured: true, translationModel: 'gpt-example' });
  assert.equal(readConfig({ dataDir: dir }).apiKey, 'sk-secret-unit-test');
  writeConfig({ translationModel: 'gpt-second' }, { dataDir: dir });
  assert.equal(readConfig({ dataDir: dir }).apiKey, 'sk-secret-unit-test');
  assert.equal(JSON.stringify(getConfigStatus({ dataDir: dir })).includes('secret'), false);
});
