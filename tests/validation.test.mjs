import test from 'node:test';
import assert from 'node:assert/strict';
const moduleUrl = new URL('../lib/validation.mjs', import.meta.url).href;

test('source URLs accept direct HTTPS YouTube and Facebook video links and remove tracking', async () => {
  const { validateSourceUrl } = await import(moduleUrl);
  assert.equal(validateSourceUrl(' https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&utm_source=x '), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(validateSourceUrl('https://youtu.be/dQw4w9WgXcQ?t=8'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(validateSourceUrl('https://m.youtube.com/shorts/dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(validateSourceUrl('https://www.facebook.com/person/videos/123456/?utm_source=x'), 'https://www.facebook.com/person/videos/123456/');
  assert.equal(validateSourceUrl('https://www.facebook.com/watch/?v=123456'), 'https://www.facebook.com/watch/?v=123456');
  assert.equal(validateSourceUrl('https://fb.watch/AbCd123/'), 'https://fb.watch/AbCd123/');
});

test('source URLs reject spoofed hosts, local addresses, credentials, playlists and unsupported resources', async () => {
  const { validateSourceUrl } = await import(moduleUrl);
  for (const url of ['https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ', 'https://localhost/a', 'https://127.0.0.1/a', 'https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ', 'https://evil@youtube.com/watch?v=dQw4w9WgXcQ', 'http://youtube.com/watch?v=dQw4w9WgXcQ', 'file:///tmp/a', 'https://youtube.com/playlist?list=PL123', 'https://youtube.com/watch?list=PL123', 'https://youtube.com/', 'https://www.facebook.com/profile.php?id=123', 'https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ', 'https://youtu.be/bad', 'not a URL']) {
    assert.throws(() => validateSourceUrl(url), { code: 'INVALID_SOURCE_URL' }, url);
  }
});

test('job options have supported defaults and reject arbitrary language or subtitle style', async () => {
  const { validateJobOptions } = await import(moduleUrl);
  assert.deepEqual(validateJobOptions({}), { targetLanguage: 'vi', subtitleStyle: 'classic' });
  assert.deepEqual(validateJobOptions({ language: 'ja', style: 'box' }), { targetLanguage: 'ja', subtitleStyle: 'box' });
  assert.deepEqual(validateJobOptions({ targetLanguage: 'zh', subtitleStyle: 'classic' }), { targetLanguage: 'zh', subtitleStyle: 'classic' });
  assert.throws(() => validateJobOptions({ language: 'xx' }), { code: 'INVALID_OPTIONS' });
  assert.throws(() => validateJobOptions({ style: 'minimal' }), { code: 'INVALID_OPTIONS' });
});

test('URL normalization cannot conceal empty userinfo or control characters', async () => {
  const { validateSourceUrl } = await import(moduleUrl);
  assert.throws(() => validateSourceUrl('https://@youtube.com/watch?v=dQw4w9WgXcQ'), { code: 'INVALID_SOURCE_URL' });
  assert.throws(() => validateSourceUrl('https://you\ttube.com/watch?v=dQw4w9WgXcQ'), { code: 'INVALID_SOURCE_URL' });
});
