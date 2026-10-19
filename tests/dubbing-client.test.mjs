import test from 'node:test';
import assert from 'node:assert/strict';
import { dubbingActionState, dubbingConflict, dubbingDirty, dubbingMediaState, dubbingPreviewCue, receiveDubbingSnapshot, setDubbingAssignment } from '../lib/dubbing-client.mjs';

const profile = () => ({ version: 2, subtitleVersion: 4, speakers: [{ id: 'spk_1', name: 'Người kể', voice: 'Kore' }, { id: 'spk_2', name: 'Khách', voice: 'Puck' }], assignments: [{ cueId: 'c1', speakerId: 'spk_1', uncertain: true }, { cueId: 'c2', speakerId: 'spk_2', uncertain: false }] });
const cues = [{ id: 'c1', start: 0, end: 2, text: 'Xin chào.' }, { id: 'c2', start: 2, end: 4, text: 'Chào bạn.' }];

test('role edits and explicit assignment confirmation mark the profile dirty', () => {
  const saved = profile();
  assert.equal(dubbingDirty(saved, structuredClone(saved)), false);
  const edited = setDubbingAssignment(saved, 'c1', 'spk_1');
  assert.equal(edited.assignments[0].uncertain, false);
  assert.equal(saved.assignments[0].uncertain, true);
  assert.equal(dubbingDirty(saved, edited), true);
  assert.equal(dubbingDirty(saved, { ...saved, speakers: saved.speakers.map(s => ({ ...s, name: `${s.name}!` })) }), true);
});

test('incoming updates preserve dirty role edits and reveal a version conflict', () => {
  const saved = profile();
  const edited = { ...saved, speakers: saved.speakers.map(s => ({ ...s, voice: 'Zephyr' })) };
  const remote = { ...saved, version: 3 };
  const state = receiveDubbingSnapshot({ saved, profile: edited }, { profile: remote, voices: [], configured: true });
  assert.deepEqual(state.profile, edited);
  assert.deepEqual(state.saved, saved);
  assert.equal(state.remote.version, 3);
  assert.equal(dubbingConflict(state.profile, state.remote), true);
  assert.equal(dubbingConflict(saved, saved), false);
});

test('clean refresh and an explicit reload accept the server profile', () => {
  const saved = profile(); const remote = { ...saved, version: 3 };
  const incoming = { profile: remote, voices: [{ id: 'Kore', label: 'Kore' }], configured: true };
  assert.deepEqual(receiveDubbingSnapshot({ saved, profile: saved }, incoming).profile, remote);
  const edited = { ...saved, speakers: [] };
  const reset = receiveDubbingSnapshot({ saved, profile: edited }, incoming, { reset: true });
  assert.deepEqual(reset.saved, remote);
  assert.equal(dubbingDirty(reset.saved, reset.profile), false);
});

test('paid actions require saved subtitles and profiles but initial analysis is allowed', () => {
  const initial = { ...profile(), version: 0 };
  const defaults = dubbingActionState(initial);
  assert.equal(defaults.canAnalyze, true);
  assert.equal(defaults.canPreview, false);
  assert.equal(defaults.canRender, false);
  const saved = dubbingActionState(profile());
  assert.equal(saved.canPreview, true);
  assert.equal(saved.canRender, true);
  for (const blocked of [{ dirty: true }, { subtitleDirty: true }, { busy: true }, { expired: true }, { conflict: true }, { configured: false }]) {
    const state = dubbingActionState(profile(), blocked);
    assert.equal(state.canAnalyze, false, JSON.stringify(blocked));
    assert.equal(state.canPreview, false, JSON.stringify(blocked));
    assert.equal(state.canRender, false, JSON.stringify(blocked));
  }
});

test('saving role edits requires a current editable profile but no Google key', () => {
  assert.equal(dubbingActionState(profile(), { dirty: true, configured: false }).canSave, true);
  assert.equal(dubbingActionState({ ...profile(), version: 0 }).canSave, true);
  assert.equal(dubbingActionState(profile()).canSave, false);
  for (const blocked of [{ subtitleDirty: true }, { busy: true }, { expired: true }, { conflict: true }]) assert.equal(dubbingActionState(profile(), { dirty: true, ...blocked }).canSave, false);
});

test('subtitle changes allow resaving and reanalysis while blocking old-profile TTS', () => {
  const state = dubbingActionState(profile(), { subtitleVersion: 5 });
  assert.equal(state.canSave, true);
  assert.equal(state.canAnalyze, true);
  assert.equal(state.canPreview, false);
  assert.equal(state.canRender, false);
});

test('preview selects the first actual nonempty cue assigned to the role', () => {
  assert.equal(dubbingPreviewCue(profile(), [...cues].reverse(), 'spk_1')?.id, 'c1');
  assert.equal(dubbingPreviewCue(profile(), cues, 'spk_2')?.id, 'c2');
  assert.equal(dubbingPreviewCue(profile(), [{ ...cues[0], text: ' ' }], 'spk_1'), null);
  assert.equal(dubbingPreviewCue(profile(), cues, 'spk_3'), null);
});

test('dubbed output and previews compare both saved versions and current edits', () => {
  const media = { version: 2, subtitleVersion: 4, token: 'token' };
  assert.deepEqual(dubbingMediaState(media, profile(), 4), { available: true, stale: false });
  for (const [output, current, subtitleVersion, options] of [
    [{ ...media, version: 1 }, profile(), 4, {}],
    [media, profile(), 5, {}],
    [media, profile(), 4, { dirty: true }],
    [media, profile(), 4, { subtitleDirty: true }],
  ]) assert.equal(dubbingMediaState(output, current, subtitleVersion, options).stale, true);
  assert.deepEqual(dubbingMediaState(null, profile(), 4), { available: false, stale: false });
});
