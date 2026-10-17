import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readRoute, routeHash, validateSource, buildJobForm, mergeDraft, request, jobProgress, isJobExpired } from '../lib/client.js';

// Browser acceptance, run with a real API/key and spoken source before release:
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
//    No API key is presently configured; paid upload/URL E2E remains unverified.

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
