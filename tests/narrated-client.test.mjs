import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavigationGuard, readRoute } from '../lib/client.js';
import * as client from '../lib/narrated-client.mjs';

test('narrated navigation retains the old default and obeys the unsaved-work guard', () => {
  assert.deepEqual(readRoute('#narrated'), { screen: 'narrated', jobId: null });
  assert.deepEqual(readRoute(''), { screen: 'create', jobId: null });
  assert.deepEqual(readRoute('#unknown'), { screen: 'create', jobId: null });
  let route = readRoute('#narrated'); let hash = '#narrated'; let allow = false;
  const guard = createNavigationGuard({ getRoute: () => route, readHash: () => hash, writeHash: value => { hash = value; }, confirmLeave: () => allow, applyRoute: value => { route = value; } });
  guard.setDirty(true); guard.navigate('create'); assert.equal(hash, '#narrated');
  hash = '#history'; guard.handleHashChange(); assert.equal(hash, '#narrated');
  guard.handleHashChange(); allow = true; guard.navigate('create'); guard.handleHashChange();
  assert.equal(route.screen, 'create');
});

test('timeline displays fractional boundaries without hiding subsecond scenes', () => {
  assert.equal(client.narratedTime(62.375), '01:02.38');
  assert.equal(client.narratedTime(0), '00:00.00');
  assert.equal(client.narratedTime(59.999), '01:00.00');
  assert.equal(client.narratedTime(-3), '00:00.00');
});

test('render needs every current clip and saved drafts; explicit resume only permits idle failed projects', () => {
  const scene = { id: 'scene-1', status: 'completed', videoUrl: '/clip', stale: false };
  const ready = { status: 'completed', busy: false, scenes: [scene], assembly: { status: 'completed', videoUrl: '/final' } };
  assert.equal(client.narratedActions(ready).canRender, true);
  assert.equal(client.narratedActions({ ...ready, scenes: [] }).canRender, false);
  assert.equal(client.narratedActions({ ...ready, scenes: [{ ...scene, stale: true }] }).canRender, false);
  assert.equal(client.narratedActions(ready, { 'scene-1': {} }).canRender, false);
  assert.equal(client.narratedActions({ ...ready, busy: true }).canDelete, false);
  assert.equal(client.narratedActions({ ...ready, status: 'importing' }).canDelete, false);
  assert.equal(client.narratedActions({ ...ready, status: 'failed' }).canResume, true);
  assert.equal(client.narratedActions(ready).canResume, false);
  assert.equal(client.narratedActions({ ...ready, status: 'failed' }, {}, '', false).canResume, false);
  for (const options of [{ dirty: true }, { busy: true }, { configured: false }]) {
    const action = client.narratedSceneAction(scene, options);
    assert.equal(action.canGenerate, false); assert.ok(action.reason);
  }
  assert.equal(client.narratedSceneAction(scene).canGenerate, true);
  assert.equal(client.narratedSceneAction({ ...scene, status: 'starting' }).canGenerate, false);
});

test('polling never rebases unsaved prompt edits, and save clears only the submitted draft', () => {
  const scene = { id: 'scene-1', prompt: 'Original', version: 1 };
  const other = { prompt: 'Other unsaved', version: 3, originalPrompt: 'Other' };
  const first = client.updateNarratedDraft(scene, { 'scene-2': other }, 'First edit');
  const second = client.updateNarratedDraft({ ...scene, version: 2, prompt: 'External save' }, first, 'Second edit');
  assert.deepEqual(second['scene-1'], { prompt: 'Second edit', version: 1, originalPrompt: 'Original' });
  assert.equal(second['scene-2'], other);
  assert.equal(client.clearNarratedDraft(second, scene.id, first[scene.id]), second, 'a late save cannot clear newer typing');
  assert.deepEqual(client.clearNarratedDraft(second, scene.id, second[scene.id]), { 'scene-2': other });
  assert.deepEqual(client.updateNarratedDraft(scene, second, 'Original'), { 'scene-2': other });
  assert.equal(client.newerNarratedProject({ id: 'p', updatedAt: '2026-10-19T01:00:02Z' }, { id: 'p', updatedAt: '2026-10-19T01:00:01Z' }).updatedAt, '2026-10-19T01:00:02Z');
});

test('selection, reset and creation fence late reads and mutation completions even after reopening the same project', () => {
  const workspace = client.createNarratedWorkspace();
  workspace.select('one'); const firstRead = workspace.read(); const secondRead = workspace.read();
  assert.equal(workspace.accepts(firstRead), false); assert.equal(workspace.accepts(secondRead), true);
  const save = workspace.start('save'); assert.equal(workspace.accepts(secondRead), false, 'pre-mutation polls cannot overwrite save');
  assert.equal(workspace.start('another'), null);
  workspace.select('two'); assert.equal(workspace.current(save), false); assert.equal(workspace.accepts(secondRead), false);
  workspace.select('one'); assert.equal(workspace.accepts(secondRead), false);
  const current = workspace.start('render'); assert.equal(workspace.finish(save), false);
  const duringMutation = workspace.read();
  assert.equal(workspace.current(current), true); assert.equal(workspace.finish(current), true);
  assert.equal(workspace.accepts(duringMutation), false, 'a refresh must begin after the foreground mutation settles');
  const afterMutation = workspace.read(); assert.equal(workspace.accepts(afterMutation), true);
  workspace.select(null); const create = workspace.start('create'); workspace.select(null);
  assert.equal(workspace.current(create), false, 'reset cannot be repopulated by late creation');
});

test('history preview ignores failed attempts and preserves explicit older clip selection', () => {
  const scene = { videoUrl: '/current', history: [
    { id: 'failed', status: 'failed', videoUrl: '/invalid' },
    { id: 'old', status: 'completed', videoUrl: '/old', version: 1 },
  ] };
  assert.equal(client.narratedPreview(scene).videoUrl, '/current');
  assert.equal(client.narratedPreview(scene, 'old').videoUrl, '/old');
  assert.equal(client.narratedPreview(scene, 'failed').videoUrl, '/current');
  assert.equal(client.narratedPreview({ history: [] }), null);
});
