import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_TRANSLATION_MODEL = 'gpt-5.6-terra';

function configPath(options = {}) {
  return options.configPath ?? resolve(options.dataDir ?? resolve(process.cwd(), '.data'), 'config.json');
}

/** Server-only: contains credentials. Use getConfigStatus for every public response. */
export function readConfig(options = {}) {
  let saved;
  try { saved = JSON.parse(readFileSync(configPath(options), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { apiKey: saved?.apiKey ?? '', translationModel: saved?.translationModel ?? DEFAULT_TRANSLATION_MODEL };
}

export function getConfigStatus(options = {}) {
  const config = readConfig(options);
  return { configured: Boolean(config.apiKey), translationModel: config.translationModel };
}

/** Atomic replacement keeps an interrupted write from destroying working settings. */
export function writeConfig(patch, options = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Object.assign(new Error('Cấu hình không hợp lệ.'), { code: 'INVALID_SETTINGS' });
  const config = readConfig(options);
  if ('apiKey' in patch) {
    if (typeof patch.apiKey !== 'string' || patch.apiKey.length > 4096 || /[\r\n]/.test(patch.apiKey)) throw Object.assign(new Error('API key không hợp lệ.'), { code: 'INVALID_SETTINGS' });
    config.apiKey = patch.apiKey.trim();
  }
  if ('translationModel' in patch) {
    if (typeof patch.translationModel !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(patch.translationModel)) throw Object.assign(new Error('Tên mô hình không hợp lệ.'), { code: 'INVALID_SETTINGS' });
    config.translationModel = patch.translationModel;
  }
  const path = configPath(options);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporaryPath, path);
  } finally { rmSync(temporaryPath, { force: true }); }
  return { configured: Boolean(config.apiKey), translationModel: config.translationModel };
}
