import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import * as client from '../lib/client.js';
import { readRoute, routeHash, validateSource, buildJobForm, mergeDraft, request, jobProgress, isJobExpired, createNavigationGuard, refreshHealthState } from '../lib/client.js';

// Browser acceptance, run with a real Gemini API key and spoken source before release:
// 1. Upload + URL independently: choose source, language and both styles; create,
//    observe actual stage/progress, open real video and seek through the last cue.
// 2. Edit cue, leave/reload warning, save, download UTF-8 SRT, render saved version,
//    download MP4; verify old MP4 is marked stale until render succeeds.
// 3. Concurrent version change preserves draft and offers explicit reload.
// 4. History -> result -> reload preserves job; failed/cancelled jobs can retry.
// 5. Missing key/tool/worker, invalid URL/video, oversized upload and network loss
//    show actionable errors without erasing input. No seeded jobs/fake progress.
// 6. At 390px viewport: source tabs, settings, editor and action bar work without
//    horizontal scrolling; keyboard labels/focus and mobile navigation work.
// 7. User-approved duration cap is 25 minutes / 1500 seconds: verify a spoken
//    source at the boundary is accepted and >1500 seconds is rejected by probe.
//    The Gemini migration has not been verified with a live key; upload/URL AI E2E remains unverified.

test('unsupported source switches after polling completes and reloads every rendered version without duplicate captions',()=>{
  assert.equal(typeof client.previewMedia,'function','preview resource must follow current job and source failure');
  const job={status:'running',renderedVersion:0};
  const initial=client.previewMedia('job 1',job,false);
  assert.deepEqual(initial,{rendered:false,src:'/api/jobs/job%201/files/source',key:'/api/jobs/job%201/files/source',showCaptions:true});
  const failed=client.previewMedia('job 1',job,true);assert.equal(failed.src,initial.src);assert.equal(failed.rendered,false);
  const completed=client.previewMedia('job 1',{status:'completed',renderedVersion:1},true);
  assert.deepEqual(completed,{rendered:true,src:'/api/jobs/job%201/files/video?v=1',key:'/api/jobs/job%201/files/video?v=1',showCaptions:false});
  const rerendered=client.previewMedia('job 1',{status:'completed',renderedVersion:2},true);
  assert.equal(rerendered.src,'/api/jobs/job%201/files/video?v=2');assert.equal(rerendered.key,'/api/jobs/job%201/files/video?v=2');assert.equal(rerendered.showCaptions,false);
  assert.notEqual(rerendered.src,completed.src);assert.notEqual(rerendered.key,completed.key);
  assert.equal(client.previewMedia('job 1',{renderedVersion:2},false).showCaptions,true,'playable source still previews unsaved edits');
});

test('reload route retains the selected job and rejects unknown screens', () => {
  assert.deepEqual(readRoute('#job/abc%20def'), { screen: 'job', jobId: 'abc def' });
  assert.equal(routeHash('job', 'abc def'), '#job/abc%20def');
  assert.deepEqual(readRoute('#unknown'), { screen: 'create', jobId: null });
  assert.deepEqual(readRoute('#history'), { screen: 'history', jobId: null });
});

test('reject oversized upload, absent source and non-web URLs before POST', () => {
  assert.ok(validateSource('upload', null, ''));
  assert.ok(validateSource('upload', { size: 500000001 }, ''));
  assert.equal(validateSource('upload', { size: 500000000 }, ''), '');
  assert.ok(validateSource('url', null, 'file:///C:/video.mp4'));
  assert.ok(validateSource('url', null, 'https://example.com/video'));
  assert.ok(validateSource('url', null, 'http://www.youtube.com/watch?v=dQw4w9WgXcQ'));
  assert.equal(validateSource('url', null, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'), '');
});

test('job form submits only the chosen source and contracted language/style fields', () => {
  const form = buildJobForm({ source: 'url', url: ' https://example.com/v ', language: 'ja', style: 'box' });
  assert.deepEqual([...form.entries()], [['url', 'https://example.com/v'], ['language', 'ja'], ['style', 'box']]);
});

test('polling keeps changed subtitle text while accepting fresh untouched cues', () => {
  const next = [{ id: 'a', text: 'Mới' }, { id: 'b', text: 'Máy chủ cập nhật' }];
  assert.deepEqual(mergeDraft(next, { a: 'Bản tôi đang sửa' }), { a: 'Bản tôi đang sửa', b: 'Máy chủ cập nhật' });
});

test('only measured render progress displays a percentage; unknown stages stay indeterminate', () => {
  assert.deepEqual(jobProgress({ status: 'queued', stage: 'render', progress: null }), { value: null, text: 'Đang chờ', label: 'Trạng thái hàng đợi' });
  for (const stage of ['import', 'probe', 'transcribe', 'translate']) {
    assert.deepEqual(jobProgress({ status: 'running', stage, progress: null }), { value: null, text: 'Đang xử lý', label: 'Tiến độ xử lý' });
  }
  assert.equal(jobProgress({ status: 'running', stage: 'translate', progress: 75 }).value, null);
  assert.equal(jobProgress({ status: 'running', stage: 'render', progress: null }).value, null);
  assert.deepEqual(jobProgress({ status: 'running', stage: 'render', progress: 42.6 }), { value: 42.6, text: '43%', label: 'Tiến độ xuất video' });
});

test('a 410 response expires an already-open result as well as a directly opened missing result', () => {
  assert.equal(isJobExpired({ status: 'completed' }, 410), true);
  assert.equal(isJobExpired(null, 410), true);
  assert.equal(isJobExpired({ status: 'expired' }, null), true);
  assert.equal(isJobExpired({ status: 'completed' }, 404), false);
});

test('cancelling browser Back keeps draft protection for a later sidebar navigation', () => {
  let route = { screen: 'job', jobId: 'edited' }; let hash = '#job/edited'; let prompts = 0; let allowed = false;
  const guard = createNavigationGuard({ getRoute: () => route, readHash: () => hash, writeHash: value => { hash = value; }, confirmLeave: () => { prompts++; return allowed; }, applyRoute: next => { route = next; } });
  guard.setDirty(true);
  hash = '#history'; guard.handleHashChange();
  assert.equal(hash, '#job/edited'); assert.equal(prompts, 1);
  guard.handleHashChange(); // The browser fires this event for the restored hash.
  guard.navigate('settings');
  assert.equal(prompts, 2, 'the second navigation must still warn about the dirty editor');
  assert.equal(hash, '#job/edited'); assert.deepEqual(route, { screen: 'job', jobId: 'edited' });
  allowed = true; guard.navigate('history'); guard.handleHashChange();
  assert.equal(prompts, 3); assert.deepEqual(route, { screen: 'history', jobId: null });
  guard.navigate('settings'); guard.handleHashChange();
  assert.equal(prompts, 3, 'confirmed departure clears draft protection');
  assert.deepEqual(route, { screen: 'settings', jobId: null });
});

test('failed health refresh propagates the error with stale data and retry clears it', async t => {
  let failing = true;
  const latest = { ok: true, configured: false, provider: 'gemini', translationModel: 'gemini-3.5-flash-lite', transcriptionModel: 'gemini-3.5-transcribe', worker: { active: true, workerId: 'worker', heartbeatAt: null }, tools: { ffmpeg: { available: true, subtitles: true }, ffprobe: { available: true }, ytdlp: { available: true, ejs: true }, font: { available: true } } };
  const server = createServer((req, res) => { res.writeHead(failing ? 503 : 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(failing ? { error: { code: 'UNAVAILABLE', message: 'Máy chủ tạm ngừng. Hãy thử lại.' } } : latest)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/health`;
  const previous = { ...latest, worker: { active: false, workerId: null, heartbeatAt: null } };
  const failed = await refreshHealthState(previous, endpoint);
  assert.equal(failed.health, previous); assert.equal(failed.stale, true); assert.equal(failed.error, 'Máy chủ tạm ngừng. Hãy thử lại.');
  const missing = await refreshHealthState(null, endpoint); assert.equal(missing.health, null); assert.equal(missing.stale, false); assert.ok(missing.error);
  failing = false; const recovered = await refreshHealthState(previous, endpoint);
  assert.deepEqual(recovered, { health: latest, stale: false, error: '' });
});

test('API preserves server error code/status and sends JSON updates correctly', async (t) => {
  const server = createServer(async (req, res) => {
    if (req.url === '/conflict') { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: 'Phiên bản đã đổi.' } })); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ body: JSON.parse(body) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(request(`${base}/conflict`), e => e.status === 409 && e.code === 'VERSION_CONFLICT');
  const result = await request(base, { method: 'PUT', body: { version: 3, cues: [{ id: 'a', text: 'Tiếng Việt ✨' }] } });
  assert.deepEqual(result.body, { version: 3, cues: [{ id: 'a', text: 'Tiếng Việt ✨' }] });
});
