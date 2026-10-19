import test from 'node:test';
import assert from 'node:assert/strict';
import * as client from '../lib/client.js';

test('studio route reopens without falling back to the subtitle creation form', () => {
  assert.deepEqual(client.readRoute('#studio'), { screen: 'studio', jobId: null });
  assert.equal(client.routeHash('studio'), '#studio');
  assert.deepEqual(client.readRoute('#job/subtitle-1'), { screen: 'job', jobId: 'subtitle-1' });
});

test('scene edits keep their original version and leave every other scene draft intact', () => {
  assert.equal(typeof client.updateSceneDraft, 'function');
  const scene = { id: 'scene-1', prompt: 'Close product', durationSeconds: 4, version: 1 };
  const other = { version: 2, prompt: 'Keep my second edit', durationSeconds: 6, originalPrompt: 'Second', originalDuration: 6 };
  const initial = { 'scene-2': other };
  const first = client.updateSceneDraft(scene, initial, { prompt: 'Slow close product' });
  const afterPoll = client.updateSceneDraft({ ...scene, prompt: 'Another session saved', version: 3 }, first, { durationSeconds: 8 });
  assert.deepEqual(afterPoll['scene-1'], { version: 1, prompt: 'Slow close product', durationSeconds: 8, originalPrompt: 'Close product', originalDuration: 4 });
  assert.equal(afterPoll['scene-2'], other);
  assert.deepEqual(initial, { 'scene-2': other }, 'editing must not mutate the previous state');
  const restored = client.updateSceneDraft(scene, afterPoll, { prompt: 'Close product', durationSeconds: 4 });
  assert.deepEqual(restored, { 'scene-2': other }, 'restoring both saved values clears just that scene draft');
});

test('generation eligibility requires saved current clips and blocks unsaved or running scenes', () => {
  assert.equal(typeof client.sceneGenerationState, 'function');
  const scenes = [
    { id: 'scene-1', version: 2, status: 'completed', videoUrl: '/one', stale: false },
    { id: 'scene-2', version: 1, status: 'completed', videoUrl: '/two', stale: true },
  ];
  assert.deepEqual(client.sceneGenerationState({ scenes, assembly: { status: 'idle' } }, {}), { dirty: false, running: false, missing: 1, ready: false });
  assert.equal(client.sceneGenerationState({ scenes: [scenes[0]], assembly: { status: 'idle' } }, {}).ready, true);
  const draft = { 'scene-1': { version: 2, prompt: 'Unsaved' } };
  assert.equal(client.sceneGenerationState({ scenes: [scenes[0]], assembly: { status: 'idle' } }, draft).ready, false);
  assert.equal(client.sceneGenerationState({ scenes: [{ ...scenes[0], status: 'starting' }], assembly: { status: 'idle' } }, {}).running, true);
  assert.equal(client.sceneGenerationState({ scenes, assembly: { status: 'rendering' } }, {}).running, true);
});

test('a delayed scene save response cannot roll back a newer server update to another scene', () => {
  assert.equal(typeof client.newerSceneProject, 'function');
  const latest = { id: 'project-1', updatedAt: '2026-10-18T08:00:02.000Z', scenes: [{ id: 'scene-2', status: 'completed', videoUrl: '/new-clip' }] };
  const delayed = { id: 'project-1', updatedAt: '2026-10-18T08:00:01.000Z', scenes: [{ id: 'scene-2', status: 'generating' }] };
  assert.equal(client.newerSceneProject(latest, delayed), latest);
  assert.equal(client.newerSceneProject(delayed, latest), latest);
  assert.equal(client.newerSceneProject(null, delayed), delayed);
  const another = { id: 'another', updatedAt: '2026-10-17T08:00:01.000Z', scenes: [] };
  assert.equal(client.newerSceneProject(latest, another), another);
});

test('initial brief edits and image selections count as unsaved work before a project exists', () => {
  const initial = { idea: '', character: '', product: '', style: 'cinematic', aspectRatio: '9:16' };
  assert.equal(typeof client.sceneBriefDirty, 'function');
  assert.equal(client.sceneBriefDirty(initial, {}), false);
  assert.equal(client.sceneBriefDirty({ ...initial, idea: 'Cafe fashion' }, {}), true);
  assert.equal(client.sceneBriefDirty({ ...initial, style: '' }, {}), true);
  assert.equal(client.sceneBriefDirty({ ...initial, aspectRatio: '16:9' }, {}), true);
  assert.equal(client.sceneBriefDirty(initial, { character: { data: 'image' } }), true);
});

test('Generate fills missing or stale clips while Regenerate requires an earlier saved attempt', () => {
  assert.equal(typeof client.sceneActionState, 'function');
  const first = { status: 'draft', version: 1, history: [] };
  assert.equal(client.sceneActionState(first).canGenerate, true);
  assert.equal(client.sceneActionState(first).canRegenerate, false);
  const complete = { ...first, status: 'completed', videoUrl: '/current', history: [{ id: 'old', status: 'completed', videoUrl: '/current' }] };
  assert.equal(client.sceneActionState(complete).canGenerate, false);
  assert.equal(client.sceneActionState(complete).canRegenerate, true);
  assert.equal(client.sceneActionState({ ...complete, stale: true }).canGenerate, true);
  assert.equal(client.sceneActionState({ ...first, status: 'failed', history: [{ id: 'failed', status: 'failed' }] }).canRegenerate, true);
  for (const options of [{ dirty: true }, { busy: true }, { configured: false }, { locked: true }]) {
    const state = client.sceneActionState(complete, options);
    assert.equal(state.canGenerate, false);
    assert.equal(state.canRegenerate, false);
    assert.ok(state.generateReason);
    assert.ok(state.regenerateReason);
  }
});

test('Preview selects only successful persisted clips and falls back safely when a history selection disappears', () => {
  assert.equal(typeof client.scenePreview, 'function');
  const scene = { videoUrl: '/latest', history: [
    { id: 'failed', status: 'failed', videoUrl: '/must-not-play' },
    { id: 'latest', status: 'completed', videoUrl: '/latest', version: 2 },
    { id: 'older', status: 'completed', videoUrl: '/older', version: 1 },
  ] };
  assert.equal(client.scenePreview(scene).videoUrl, '/latest');
  assert.equal(client.scenePreview(scene, 'older').videoUrl, '/older');
  assert.equal(client.scenePreview(scene, 'failed').videoUrl, '/latest');
  assert.equal(client.scenePreview(scene, 'missing').videoUrl, '/latest');
  assert.equal(client.scenePreview({ videoUrl: '/legacy', history: [] }).videoUrl, '/legacy');
  assert.equal(client.scenePreview({ ...scene, legacyVideoUrl: '/legacy' }, 'legacy').videoUrl, '/legacy');
  assert.equal(client.scenePreview({ legacyVideoUrl: '/legacy', history: [] }).videoUrl, '/legacy');
  assert.equal(client.scenePreview({ history: [{ status: 'failed' }] }), null);
});

test('workspace reset fences old results and an old finish cannot release a newer request', () => {
  assert.equal(typeof client.createSceneWorkspaceController, 'function');
  const controller = client.createSceneWorkspaceController();
  const old = controller.start('create');
  assert.equal(controller.isCurrent(old), true);
  assert.equal(controller.start('another'), null, 'one foreground operation owns the workspace');
  controller.reset();
  assert.equal(controller.busy(), '');
  assert.equal(controller.isCurrent(old), false, 'the old response must not repopulate a reset form');
  const current = controller.start('scene-1:save');
  assert.equal(controller.finish(old), false);
  assert.equal(controller.busy(), 'scene-1:save', 'an old finally must not unlock a newer request');
  assert.equal(controller.isCurrent(current), true);
  assert.equal(controller.finish(current), true);
  assert.equal(controller.busy(), '');
  assert.equal(controller.isCurrent(current), false, 'a completed ticket cannot be reused');
});

test('workflow readiness follows saved results separately from Prompt or Preview focus', () => {
  assert.equal(typeof client.sceneWorkflow, 'function');
  const completed = { scenes: [{ id: 'scene-1', status: 'completed', videoUrl: '/clip', stale: false }], assembly: { status: 'completed', videoUrl: '/final' } };
  assert.equal(client.sceneWorkflow(null, {}, '', 0).current, 0);
  assert.equal(client.sceneWorkflow(null, {}, 'create', 0).current, 1);
  const reopened = client.sceneWorkflow(completed, {}, '', 2);
  assert.equal(reopened.current, 4, 'reopening completed output exposes the available preview stage');
  assert.equal(reopened.previewReady, true);
  assert.equal(reopened.steps[3].state, 'done');
  const focusedPrompt = client.sceneWorkflow(completed, {}, '', 3);
  assert.equal(focusedPrompt.current, 3);
  assert.equal(focusedPrompt.previewReady, true, 'focusing Prompt does not discard completed readiness');
  const edited = client.sceneWorkflow(completed, { 'scene-1': { prompt: 'unsaved' } }, '', 4);
  assert.equal(edited.current, 3);
  assert.equal(edited.previewReady, false);
  assert.equal(edited.previewStale, true);
  assert.equal(edited.steps[4].state, 'pending');
  const noClip = { scenes: [{ id: 'scene-1', status: 'draft' }], assembly: { status: 'idle' } };
  const opened = client.sceneWorkflow(noClip, {}, '', 3);
  assert.equal(opened.current, 3);
  assert.equal(opened.previewReady, false, 'opening Prompt must never imply a generated video exists');
  const generating = client.sceneWorkflow({ ...completed, scenes: [{ ...completed.scenes[0], status: 'generating' }] }, {}, '', 4);
  assert.equal(generating.previewReady, false);
  assert.equal(generating.previewStale, true);
});
