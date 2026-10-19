import test from 'node:test';
import assert from 'node:assert/strict';
import * as client from '../lib/client.js';

const photo = name => ({ name, type: 'image/png', size: 120 });
const readFile = async file => `data:${file.type};base64,${Buffer.from(file.name).toString('base64')}`;
function selection(options = {}) {
  assert.equal(typeof client.createSceneReferenceSelection, 'function');
  return client.createSceneReferenceSelection({ readFile, ...options });
}

test('three character photos retain their order and names in a story without a product', async () => {
  const images = selection();
  await images.add('character', [photo('lan.png'), photo('minh.png')]);
  await images.add('character', [photo('ha.png')]);
  const selected = images.getState().references;
  images.setLabel(selected[0].id, ' Lan ');
  images.setLabel(selected[1].id, 'Minh');
  images.setLabel(selected[2].id, 'Hà');
  assert.equal(typeof client.prepareSceneBrief, 'function');
  const body = client.prepareSceneBrief({ idea: ' Ba người bạn gặp lại nhau. ', character: ' Lan, Minh và Hà là ba người bạn. ', aspectRatio: '16:9', style: ' ' }, images.getState().references);
  assert.equal(body.product, '');
  assert.equal(body.idea, 'Ba người bạn gặp lại nhau.');
  assert.equal(body.character, 'Lan, Minh và Hà là ba người bạn.');
  assert.equal(body.style, 'cinematic');
  assert.deepEqual(body.references, [
    { kind: 'character', label: 'Lan', mimeType: 'image/png', data: 'bGFuLnBuZw==' },
    { kind: 'character', label: 'Minh', mimeType: 'image/png', data: 'bWluaC5wbmc=' },
    { kind: 'character', label: 'Hà', mimeType: 'image/png', data: 'aGEucG5n' },
  ]);
});

test('a fourth photo is rejected before reading and removing one frees just that slot', async () => {
  let reads = 0;
  const images = selection({ readFile: file => { reads++; return readFile(file); } });
  await images.add('character', [photo('a.png'), photo('b.png'), photo('c.png')]);
  await assert.rejects(images.add('product', [photo('prop.png')]), /3 ảnh/);
  assert.equal(reads, 3);
  const before = images.getState().references;
  images.remove(before[1].id);
  await images.add('product', [photo('prop.png')]);
  assert.deepEqual(images.getState().references.map(ref => ref.name), ['a.png', 'c.png', 'prop.png']);
});

test('a product photo replaces its own slot and a failed read preserves all existing selections', async () => {
  const images = selection({ readFile: file => file.name === 'broken.png' ? Promise.reject(new Error('Read failed')) : readFile(file) });
  await images.add('character', [photo('a.png'), photo('b.png')]);
  await images.add('product', [photo('old.png')]);
  await images.add('product', [photo('new.png')]);
  const before = images.getState().references;
  assert.deepEqual(before.map(ref => ref.name), ['a.png', 'b.png', 'new.png']);
  await assert.rejects(images.add('product', [photo('broken.png')]), /Read failed/);
  assert.deepEqual(images.getState().references, before);
  assert.equal(images.getState().pending, false);
});

test('a mixed batch with an invalid photo is rejected in full before reading any file', async () => {
  let reads = 0;
  const images = selection({ readFile: file => { reads++; return readFile(file); } });
  for (const invalid of [{ ...photo('a.png'), size: 0 }, { ...photo('a.png'), size: 262145 }, { ...photo('a.png'), type: 'image/webp' }]) {
    await assert.rejects(images.add('character', [photo('valid.png'), invalid]), /PNG|JPEG/);
    assert.deepEqual(images.getState(), { references: [], pending: false });
  }
  assert.equal(reads, 0);
});

test('reset fences late successful and failed reads from the new photo selection', async () => {
  for (const fail of [false, true]) {
    let resolveRead, rejectRead;
    const notifications = [];
    const images = selection({ onChange: state => notifications.push(state), readFile: file => file.name === 'old.png' ? new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject; }) : readFile(file) });
    const old = images.add('character', [photo('old.png')]);
    assert.equal(images.getState().pending, true);
    await assert.rejects(images.add('product', [photo('overlap.png')]), /Đợi/);
    images.clear();
    await images.add('character', [photo('new.png')]);
    const current = images.getState();
    if (fail) rejectRead(new Error('Old failure')); else resolveRead('data:image/png;base64,b2xk');
    assert.equal(await old, false);
    assert.deepEqual(images.getState(), current);
    assert.equal(notifications.at(-1).references[0].name, 'new.png');
  }
});
