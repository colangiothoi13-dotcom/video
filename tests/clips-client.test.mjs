import test from 'node:test';
import assert from 'node:assert/strict';
import { clipActionState, clipDownloadUrl, clipOutputState, clipSources, formatClipTime, initialClipDraft, parseClipTime, validateClipRanges } from '../lib/clips-client.mjs';

const job = () => ({ id: 'job-1', status: 'completed', duration: 180, subtitleVersion: 4, renderedVersion: 4, dubbing: { version: 2, subtitleVersion: 4 }, dubbingOutput: { token: 'dub-1', version: 2, subtitleVersion: 4 } });

test('time entry accepts seconds, minutes and hours without losing milliseconds', () => {
  for (const [input, expected] of [['12.375', 12.375], [' 01:02.005 ', 62.005], ['90:00', 5400], ['01:02:03.250', 3723.25], [0, 0]]) assert.equal(parseClipTime(input), expected, String(input));
  assert.equal(formatClipTime(3723.25), '01:02:03.250');
  assert.equal(formatClipTime(62.005), '01:02.005');
  assert.equal(parseClipTime(formatClipTime(12.375)), 12.375);
});

test('malformed times never coerce to a valid seek or export boundary', () => {
  for (const input of ['', ' ', '-1', '+2', '1e2', '0x20', '1:2', '00:60', '01:60:00', '0:00:60', '1:02:03:04', '1.2345', 'NaN', 'Infinity', NaN, Infinity, null, true, {}]) assert.equal(parseClipTime(input), null, String(input));
});

test('valid ranges retain their order and allow deliberate overlap', () => {
  const result = validateClipRanges([{ start: '00:10.125', end: '00:15.375' }, { start: '12', end: '13' }], 20);
  assert.equal(result.valid, true);
  assert.deepEqual(result.ranges, [{ start: 10.125, end: 15.375 }, { start: 12, end: 13 }]);
  assert.equal(result.totalDuration, 6.25);
});

test('a clip must be at least a quarter second and stay within the video', () => {
  assert.equal(validateClipRanges([{ start: '0', end: '0.250' }], 1).valid, true);
  for (const ranges of [[{ start: '0', end: '0.249' }], [{ start: '1', end: '1' }], [{ start: '2', end: '1' }], [{ start: '0', end: '20.001' }], [{ start: 'NaN', end: '2' }], [{ start: '0', end: '' }]]) {
    const result = validateClipRanges(ranges, 20);
    assert.equal(result.valid, false, JSON.stringify(ranges));
    assert.ok(result.error);
    assert.equal(result.errors.length, 1);
  }
  for (const duration of [0, -1, NaN, Infinity, undefined]) assert.equal(validateClipRanges([{ start: '0', end: '1' }], duration).valid, false);
});

test('count and total duration limits apply to the entire export request', () => {
  assert.equal(validateClipRanges([], 1600).valid, false);
  const twenty = Array.from({ length: 20 }, () => ({ start: '0', end: '75' }));
  assert.equal(validateClipRanges(twenty, 1600).valid, true);
  assert.equal(validateClipRanges([...twenty, { start: '0', end: '1' }], 1600).valid, false);
  assert.equal(validateClipRanges([{ start: '0', end: '1500.001' }], 1600).valid, false);
});

test('the initial choice prefers a current dubbed export then captioned then original', () => {
  assert.equal(initialClipDraft(job()).source, 'dubbed');
  assert.equal(initialClipDraft({ ...job(), dubbingOutput: { ...job().dubbingOutput, version: 1 } }).source, 'video');
  assert.equal(initialClipDraft({ ...job(), subtitleVersion: 5 }).source, 'source');
  assert.deepEqual(initialClipDraft({ ...job(), duration: 12.375 }).ranges, [{ start: '00:00.000', end: '00:12.375' }]);
  assert.deepEqual(initialClipDraft(job()).ranges, [{ start: '00:00.000', end: '00:30.000' }]);
});

test('source eligibility rejects stale versions and absent dubbed files', () => {
  assert.equal(clipSources(job()).find(item => item.value === 'dubbed').available, true);
  for (const changed of [{ subtitleVersion: 5 }, { dubbing: { version: 3, subtitleVersion: 4 } }, { dubbingOutput: null }, { dubbingOutput: { ...job().dubbingOutput, token: '' } }]) {
    const option = clipSources({ ...job(), ...changed }).find(item => item.value === 'dubbed');
    assert.equal(option.available, false);
    assert.ok(option.reason);
  }
  assert.equal(clipSources({ ...job(), renderedVersion: 3 }).find(item => item.value === 'video').available, false);
  assert.equal(clipSources({ ...job(), subtitleVersion: 0, renderedVersion: 0 }).find(item => item.value === 'video').available, false);
});

test('a source that becomes stale stays selected but cannot queue after a poll', () => {
  const selected = initialClipDraft(job());
  const state = clipActionState({ ...job(), subtitleVersion: 5 }, selected.source, selected.ranges);
  assert.equal(state.canQueue, false);
  assert.ok(state.reason);
  assert.equal(selected.source, 'dubbed');
  assert.equal(clipActionState({ ...job(), subtitleVersion: 5 }, 'source', selected.ranges).canQueue, true);
});

test('pending jobs, local edits and expired jobs cannot queue a duplicate export', () => {
  const ranges = [{ start: '0', end: '1' }];
  assert.equal(clipActionState(job(), 'dubbed', ranges).canQueue, true);
  for (const options of [{ busy: true }, { dirty: true }, { expired: true }]) assert.equal(clipActionState(job(), 'dubbed', ranges, options).canQueue, false);
  for (const status of ['queued', 'running', 'expired']) assert.equal(clipActionState({ ...job(), status }, 'source', ranges).canQueue, false);
  assert.equal(clipActionState(job(), 'missing', ranges).canQueue, false);
});

test('downloaded exports report the saved content they actually contain', () => {
  const output = { token: 'clips-1', source: 'dubbed', subtitleVersion: 4, dubbingVersion: 2, clips: [{ index: 0, start: 10, end: 12, duration: 2 }] };
  assert.deepEqual(clipOutputState({ ...job(), clipsOutput: output }), { available: true, stale: false });
  assert.equal(clipOutputState({ ...job(), subtitleVersion: 5, clipsOutput: output }).stale, true);
  assert.equal(clipOutputState({ ...job(), dubbing: { version: 3 }, clipsOutput: output }).stale, true);
  assert.equal(clipOutputState({ ...job(), clipsOutput: { ...output, source: 'video' }, dubbing: { version: 3 } }).stale, false);
  assert.equal(clipOutputState({ ...job(), subtitleVersion: 5, clipsOutput: { ...output, source: 'source' } }).stale, false);
  assert.equal(clipOutputState({ ...job(), clipsOutput: output }, { dirty: true }).stale, true);
  assert.deepEqual(clipOutputState(job()), { available: false, stale: false });
});

test('clip download URLs encode each untrusted path segment', () => {
  assert.equal(clipDownloadUrl('job/a ?b', 'token/x#?', 0), '/api/jobs/job%2Fa%20%3Fb/clips/token%2Fx%23%3F/0');
});
