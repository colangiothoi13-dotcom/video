import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApi } from '../lib/api.mjs';
import { createStore } from '../lib/store.mjs';

test('the real studio JSON boundary admits three maximum-size images and rejects a fourth before inference', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'story-boundary-'));
  const store = createStore(path.join(dataDir, 'jobs.sqlite'));
  let scripts = 0;
  const api = createApi({ store, dataDir, config: { readConfig: () => ({ apiKey: 'fixture-only', translationModel: 'gemini-test' }) }, tools: { sceneProvider: {
    generateSceneScript: async brief => {
      scripts++;
      assert.equal(brief.references.length, 3);
      assert.ok(brief.references.every(ref => Buffer.from(ref.data, 'base64').length === 262144));
      return { title: 'Ba người bạn', scenes: Array.from({ length: 5 }, (_, i) => ({ id: `scene-${i + 1}`, title: `Cảnh ${i + 1}`, action: 'Bạn bè trò chuyện.', visual: 'Quán café.', prompt: 'Natural daylight and three friends.', durationSeconds: 8 })) };
    },
  } } });
  const app = express(); app.use('/api', api);
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const bytes = Buffer.alloc(262144); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  const ref = { kind: 'character', mimeType: 'image/png', data: bytes.toString('base64') };
  const body = { idea: 'Ba người bạn gặp lại.', character: 'Lan, Minh và Hà.', references: [ref, ref, ref] };
  assert.ok(Buffer.byteLength(JSON.stringify(body)) > 1048576);
  const send = (route, payload, method = 'POST') => fetch(`${base}/api${route}`, { method, headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const accepted = await send('/studio/projects', body);
  assert.equal(accepted.status, 201, await accepted.clone().text());
  assert.equal((await accepted.json()).project.identity.referenceCount, 3);
  assert.equal(scripts, 1);
  assert.equal((await send('/studio/projects', { ...body, references: [ref, ref, ref, ref] })).status, 400);
  assert.equal(scripts, 1);
  assert.equal((await send('/settings', { apiKey: 'x'.repeat(1048576) }, 'PUT')).status, 413);
});
