import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const AI_PROVIDER = 'gemini';
export const DEFAULT_TRANSCRIPTION_MODEL = 'gemini-3.5-transcribe';
export const DEFAULT_TRANSLATION_MODEL = 'gemini-3.5-flash-lite';

function validateModel(model) {
  if (typeof model !== 'string' || !/^gemini-[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(model)) throw Object.assign(new Error('Mô hình dịch phải là tên Gemini, ví dụ gemini-3.5-flash-lite.'), { code: 'INVALID_GEMINI_MODEL' });
  return model;
}

function configPath(options = {}) {
  return options.configPath ?? resolve(options.dataDir ?? resolve(process.cwd(), '.data'), 'config.json');
}

function readSavedConfig(options = {}) {
  let saved;
  try { saved = JSON.parse(readFileSync(configPath(options), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Unqualified settings belong to the previous provider and must never send its key to Google.
  return {
    provider: AI_PROVIDER,
    apiKey: saved?.provider === AI_PROVIDER ? saved.apiKey ?? '' : '',
    translationModel: saved?.provider === AI_PROVIDER ? validateModel(saved.translationModel ?? DEFAULT_TRANSLATION_MODEL) : DEFAULT_TRANSLATION_MODEL,
  };
}

/** Server-only: environment overrides disk. Use getConfigStatus for public responses. */
export function readConfig(options = {}) {
  const config = readSavedConfig(options);
  const env = options.env ?? process.env;
  return {
    provider: AI_PROVIDER,
    apiKey: env.GEMINI_API_KEY?.trim() || config.apiKey,
    translationModel: validateModel(env.GEMINI_TRANSLATION_MODEL?.trim() || config.translationModel),
    transcriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
  };
}

export function getConfigStatus(options = {}) {
  const config = readConfig(options);
  return { provider: AI_PROVIDER, configured: Boolean(config.apiKey), translationModel: config.translationModel, transcriptionModel: config.transcriptionModel };
}

/** Atomic replacement keeps an interrupted write from destroying working settings. */
export function writeConfig(patch, options = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Object.assign(new Error('Cấu hình không hợp lệ.'), { code: 'INVALID_SETTINGS' });
  const config = readSavedConfig(options);
  if ('apiKey' in patch) {
    if (typeof patch.apiKey !== 'string' || patch.apiKey.length > 4096 || /[\r\n]/.test(patch.apiKey)) throw Object.assign(new Error('API key không hợp lệ.'), { code: 'INVALID_SETTINGS' });
    config.apiKey = patch.apiKey.trim();
  }
  if ('translationModel' in patch) {
    config.translationModel = validateModel(patch.translationModel);
  }
  const path = configPath(options);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporaryPath, path);
  } finally { rmSync(temporaryPath, { force: true }); }
  return getConfigStatus(options);
}
