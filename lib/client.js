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
  return { screen: ['history', 'settings'].includes(screen) ? screen : 'create', jobId: null };
}
export function routeHash(screen, id) { return screen === 'job' ? `#job/${encodeURIComponent(id)}` : `#${screen}`; }
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
