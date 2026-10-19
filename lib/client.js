import { validateSourceUrl } from './validation.mjs';

export async function request(url, options = {}) {
  const init = { ...options, cache: 'no-store', headers: { ...options.headers } };
  if (init.body && !(init.body instanceof FormData)) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(init.body);
  }
  let response;
  try { response = await fetch(url, init); }
  catch (cause) { if (cause.name === 'AbortError') throw cause; throw new Error('Không kết nối được với máy chủ. Kiểm tra ứng dụng còn đang chạy rồi thử lại.'); }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error?.message || `Yêu cầu chưa thành công (${response.status}). Vui lòng thử lại.`);
    error.status = response.status; error.code = data?.error?.code; throw error;
  }
  return data;
}
export function readRoute(hash = '') {
  const [screen, encoded] = hash.replace(/^#\/?/, '').split('/');
  if (screen === 'job' && encoded) { try { return { screen, jobId: decodeURIComponent(encoded) }; } catch {} }
  return { screen: ['studio', 'narrated', 'history', 'settings'].includes(screen) ? screen : 'create', jobId: null };
}
export function routeHash(screen, id) { return screen === 'job' ? `#job/${encodeURIComponent(id)}` : `#${screen}`; }
export function createNavigationGuard({ getRoute, readHash, writeHash, confirmLeave, applyRoute }) {
  let dirty = false; let allowNavigation = false; let restoringHash = null;
  return {
    setDirty(value) { dirty = value; },
    navigate(screen, jobId) {
      const current = getRoute();
      if (current.screen === screen && current.jobId === (jobId || null)) return;
      if (dirty && !confirmLeave()) return;
      restoringHash = null; allowNavigation = true; dirty = false; writeHash(routeHash(screen, jobId));
    },
    handleHashChange() {
      if (restoringHash !== null) {
        const isRestoration = readHash() === restoringHash; restoringHash = null;
        if (isRestoration) return;
      }
      if (!allowNavigation && dirty && !confirmLeave()) { const current = getRoute(); restoringHash = routeHash(current.screen, current.jobId); writeHash(restoringHash); return; }
      allowNavigation = false; dirty = false; applyRoute(readRoute(readHash()));
    },
  };
}
export async function refreshHealthState(previousHealth, url = '/api/health') {
  try { return { health: await request(url), stale: false, error: '' }; }
  catch (error) { return { health: previousHealth, stale: Boolean(previousHealth), error: error.message }; }
}
export function validateSource(source, file, url) {
  if (source === 'upload') {
    if (!file) return 'Chọn một video để bắt đầu.';
    if (file.size > 500000000) return 'Video vượt quá 500 MB. Hãy chọn tệp nhỏ hơn.';
    if (!file.size) return 'Tệp video trống. Hãy chọn tệp khác.';
    return '';
  }
  try { validateSourceUrl(url); }
  catch { return 'Nhập liên kết video HTTPS công khai từ YouTube hoặc Facebook.'; }
  return '';
}
export function buildJobForm({ source, file, url, language, style }) {
  const form = new FormData();
  if (source === 'upload') form.append('video', file); else form.append('url', url.trim());
  form.append('language', language); form.append('style', style); return form;
}
export function mergeDraft(cues, changes) { return Object.fromEntries(cues.map(cue => [cue.id, Object.hasOwn(changes, cue.id) ? changes[cue.id] : cue.text])); }
export function updateSceneDraft(scene, drafts, patch) {
  const previous = drafts[scene.id] || { version: scene.version, prompt: scene.prompt, durationSeconds: scene.durationSeconds, originalPrompt: scene.prompt, originalDuration: scene.durationSeconds };
  const draft = { ...previous, ...patch }; const next = { ...drafts };
  if (draft.prompt === draft.originalPrompt && draft.durationSeconds === draft.originalDuration) delete next[scene.id];
  else next[scene.id] = draft;
  return next;
}
export function sceneGenerationState(project, drafts = {}) {
  const scenes = project?.scenes || []; const dirty = Object.keys(drafts).length > 0;
  const running = project?.assembly?.status === 'rendering' || scenes.some(scene => ['starting', 'generating'].includes(scene.status));
  const missing = scenes.filter(scene => scene.status !== 'completed' || !scene.videoUrl || scene.stale).length;
  return { dirty, running, missing, ready: scenes.length > 0 && !dirty && !running && missing === 0 };
}
export function sceneBriefDirty(brief, references = {}) {
  return Boolean(brief.idea || brief.character || brief.product || brief.style !== 'cinematic' || brief.aspectRatio !== '9:16' || Object.keys(references).length);
}
export function prepareSceneBrief(brief, references = []) {
  if (![brief.idea, brief.character].every(value => typeof value === 'string' && value.trim())) throw new Error('Nhập ý tưởng và mô tả các nhân vật trước khi tạo kịch bản.');
  return {
    idea: brief.idea.trim(), character: brief.character.trim(), product: brief.product?.trim() || '',
    style: brief.style?.trim() || 'cinematic', aspectRatio: brief.aspectRatio,
    references: references.map(({ kind, label, mimeType, data }) => ({ kind, ...(label?.trim() ? { label: label.trim() } : {}), mimeType, data })),
  };
}
export function createSceneReferenceSelection({ readFile = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('Chưa đọc được ảnh. Hãy chọn lại tệp.'));
  reader.readAsDataURL(file);
}), onChange = () => {} } = {}) {
  let references = [], pending = false, revision = 0, nextId = 0;
  const getState = () => ({ references, pending });
  const publish = () => onChange(getState());
  return {
    getState,
    async add(kind, input) {
      const files = Array.from(input || []);
      if (!files.length) return false;
      if (pending) throw new Error('Đợi ảnh đang chọn đọc xong trước khi thêm ảnh.');
      if (!['character', 'product'].includes(kind) || (kind === 'product' && files.length !== 1)) throw new Error('Chọn một ảnh sản phẩm / đạo cụ mỗi lần.');
      const retained = kind === 'product' ? references.filter(ref => ref.kind !== 'product') : references;
      if (retained.length + files.length > 3) throw new Error('Tối đa 3 ảnh tham chiếu tổng cộng. Bỏ bớt ảnh đã chọn hoặc chọn ít ảnh hơn.');
      if (files.some(file => !['image/png', 'image/jpeg'].includes(file.type) || !file.size || file.size > 256 * 1024)) throw new Error('Ảnh tham chiếu cần là PNG hoặc JPEG, tối đa 256 KiB mỗi ảnh.');
      const ticket = ++revision;
      pending = true; publish();
      try {
        const loaded = await Promise.all(files.map(async file => ({ id: `reference-${++nextId}`, kind, label: '', name: file.name, mimeType: file.type, data: String(await readFile(file)).split(',')[1] })));
        if (ticket !== revision) return false;
        references = [...retained, ...loaded];
        return true;
      } catch (error) {
        if (ticket !== revision) return false;
        throw error;
      } finally {
        if (ticket === revision) { pending = false; publish(); }
      }
    },
    remove(id) { if (pending) return; references = references.filter(ref => ref.id !== id); publish(); },
    setLabel(id, label) { if (pending) return; references = references.map(ref => ref.id === id ? { ...ref, label: label.slice(0, 100) } : ref); publish(); },
    clear() { revision++; references = []; pending = false; publish(); },
  };
}
export function sceneActionState(scene, { dirty = false, busy = false, configured = true, locked = false } = {}) {
  const common = dirty ? 'Lưu hoặc bỏ bản sửa của cảnh trước khi tạo clip.' : busy || locked || ['starting', 'generating'].includes(scene.status) ? 'Đợi tác vụ đang xử lý hoàn tất.' : !configured ? 'Thêm khóa Google có quyền truy cập Veo trong Cài đặt để tạo clip.' : '';
  const current = scene.status === 'completed' && scene.videoUrl && !scene.stale;
  const attempted = Boolean(scene.videoUrl || scene.legacyVideoUrl || scene.history?.length || scene.status === 'failed');
  const generateReason = common || (current ? 'Clip đúng phiên bản đã có. Dùng Regenerate để tạo lại.' : '');
  const regenerateReason = common || (!attempted ? 'Dùng Generate để tạo clip đầu tiên của cảnh.' : '');
  return { canGenerate: !generateReason, canRegenerate: !regenerateReason, generateReason, regenerateReason };
}
export function scenePreview(scene, selectedId) {
  const successful = (scene.history || []).filter(item => item.status === 'completed' && item.videoUrl);
  const legacyUrl = scene.legacyVideoUrl || (!successful.length && scene.videoUrl);
  const legacy = legacyUrl ? { id: 'legacy', videoUrl: legacyUrl, legacy: true } : null;
  if (selectedId === 'legacy' && legacy) return legacy;
  return successful.find(item => item.id === selectedId) || successful[0] || legacy;
}
export function createSceneWorkspaceController() {
  let epoch = 0; let serial = 0; let active = null;
  const isCurrent = ticket => Boolean(ticket && active === ticket && ticket.epoch === epoch);
  return {
    start(action) { if (active) return null; active = Object.freeze({ epoch, id: ++serial, action }); return active; },
    isCurrent,
    finish(ticket) { if (!isCurrent(ticket)) return false; active = null; return true; },
    reset() { ++epoch; active = null; },
    busy() { return active?.action || ''; },
  };
}
export function sceneWorkflow(project, drafts = {}, busy = '', focus = 0) {
  const generation = sceneGenerationState(project, drafts);
  const saved = Boolean(project?.scenes?.length);
  const previewAvailable = Boolean(project?.assembly?.videoUrl || project?.scenes?.some(scene => scenePreview(scene)));
  const previewReady = Boolean(saved && generation.ready && !busy && project.assembly?.status === 'completed' && project.assembly?.videoUrl);
  const current = busy === 'create' ? 1 : !saved ? 0 : generation.dirty ? 3 : focus === 3 ? 3 : previewReady || (focus === 4 && previewAvailable) ? 4 : 2;
  const ready = [saved || busy === 'create', saved, saved, saved && !generation.dirty, previewReady];
  return { current, previewReady, previewAvailable, previewStale: previewAvailable && !previewReady, steps: ready.map((available, index) => ({ ready: Boolean(available), state: index === current ? 'current' : available ? 'done' : 'pending' })) };
}
export function newerSceneProject(previous, incoming) {
  return previous?.id === incoming.id && previous.updatedAt > incoming.updatedAt ? previous : incoming;
}
export function isJobExpired(job, responseStatus) { return job?.status === 'expired' || responseStatus === 410; }
export function jobProgress(job) {
  if (job.status === 'queued') return { value: null, text: 'Đang chờ', label: 'Trạng thái hàng đợi' };
  if (job.stage === 'render' && typeof job.progress === 'number' && Number.isFinite(job.progress)) {
    const value = Math.max(0, Math.min(100, job.progress));
    return { value, text: `${Math.round(value)}%`, label: 'Tiến độ xuất video' };
  }
  return { value: null, text: 'Đang xử lý', label: 'Tiến độ xử lý' };
}
export function formatTime(seconds = 0) { const n = Math.max(0, Number(seconds) || 0); return `${Math.floor(n / 60).toString().padStart(2, '0')}:${Math.floor(n % 60).toString().padStart(2, '0')}`; }
export function formatDate(date) { return date ? new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(date)) : '—'; }
export const statusLabels = { queued: 'Đang xếp hàng', running: 'Đang xử lý', completed: 'Hoàn thành', failed: 'Cần thử lại', cancelled: 'Đã hủy', expired: 'Đã hết hạn' };
export const stageLabels = { import: 'Nhập video', probe: 'Kiểm tra video', transcribe: 'Nhận dạng lời nói', translate: 'Dịch phụ đề', render: 'Xuất video', done: 'Hoàn thành' };
export const languageLabels = { vi: 'Tiếng Việt', en: 'Tiếng Anh', ja: 'Tiếng Nhật', ko: 'Tiếng Hàn', zh: 'Tiếng Trung' };
export function fileUrl(id, kind) { return `/api/jobs/${encodeURIComponent(id)}/files/${kind}`; }
export function previewMedia(id, job, sourceFailed) {
  const rendered = Boolean(sourceFailed && job?.renderedVersion > 0);
  const src = rendered ? `${fileUrl(id, 'video')}?v=${job.renderedVersion}` : fileUrl(id, 'source');
  return { rendered, src, key: src, showCaptions: !rendered };
}
