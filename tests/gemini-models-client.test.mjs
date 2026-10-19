import test from 'node:test';
import assert from 'node:assert/strict';
import * as catalogClient from '../lib/gemini-models-client.mjs';

test('Google catalog replaces fallback choices while retaining saved and draft model IDs', () => {
  const result = catalogClient.geminiModelOptions({
    catalogModels: [{ id: 'gemini-google', label: 'Google model' }],
    fallbackModels: [{ id: 'gemini-fallback', label: 'Fallback model' }],
    savedModel: 'gemini-saved',
    selectedModel: 'gemini-draft',
  });
  assert.deepEqual(result, {
    source: 'google',
    models: [
      { id: 'gemini-google', label: 'Google model', source: 'google' },
      { id: 'gemini-saved', label: 'gemini-saved', source: 'saved' },
      { id: 'gemini-draft', label: 'gemini-draft', source: 'selected' },
    ],
  });
});

test('unavailable catalog uses static choices and retains an unlisted selection', () => {
  assert.deepEqual(catalogClient.geminiModelOptions({
    fallbackModels: [{ id: 'gemini-fallback', label: 'Fallback model' }],
    savedModel: 'gemini-fallback',
    selectedModel: 'gemini-draft',
  }), {
    source: 'fallback',
    models: [
      { id: 'gemini-fallback', label: 'Fallback model', source: 'fallback' },
      { id: 'gemini-draft', label: 'gemini-draft', source: 'selected' },
    ],
  });
});

test('catalog deduplicates IDs without relabeling available saved or selected models', () => {
  const catalogModels = Object.freeze([
    Object.freeze({ id: 'gemini-known', label: 'Known Google model' }),
    Object.freeze({ id: 'gemini-known', label: 'Duplicate' }),
    Object.freeze({ id: 'gemini-no-label' }),
    null,
    Object.freeze({ id: '' }),
  ]);
  assert.deepEqual(catalogClient.geminiModelOptions({
    catalogModels,
    savedModel: 'gemini-known',
    selectedModel: 'gemini-known',
  }), {
    source: 'google',
    models: [
      { id: 'gemini-known', label: 'Known Google model', source: 'google' },
      { id: 'gemini-no-label', label: 'gemini-no-label', source: 'google' },
    ],
  });
});

test('empty Google catalog retains one saved selection without claiming it was listed', () => {
  assert.deepEqual(catalogClient.geminiModelOptions({
    catalogModels: [],
    fallbackModels: [{ id: 'gemini-fallback', label: 'Fallback model' }],
    savedModel: 'gemini-saved',
    selectedModel: 'gemini-saved',
  }), {
    source: 'google',
    models: [{ id: 'gemini-saved', label: 'gemini-saved', source: 'saved' }],
  });
});
