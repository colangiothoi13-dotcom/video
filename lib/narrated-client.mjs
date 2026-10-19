const runningStatuses = new Set(['queued', 'importing', 'transcribing', 'planning', 'generating', 'assembling']);

export function narratedTime(seconds = 0) {
  const ticks = Math.round(Math.max(0, Number(seconds) || 0) * 100);
  const hours = Math.floor(ticks / 360000);
  const minutes = Math.floor(ticks / 6000);
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(hours ? minutes % 60 : minutes).padStart(2, '0')}:${String(Math.floor(ticks / 100) % 60).padStart(2, '0')}.${String(ticks % 100).padStart(2, '0')}`;
}

export function narratedActions(project, drafts = {}, busy = '', configured = true) {
  const dirty = Object.keys(drafts).length > 0;
  const running = Boolean(project?.busy || runningStatuses.has(project?.status) || project?.scenes?.some(scene => ['starting', 'generating'].includes(scene.status)) || ['assembling', 'rendering'].includes(project?.assembly?.status));
  const locked = Boolean(busy || running);
  const scenes = project?.scenes || [];
  const completed = scenes.filter(scene => scene.status === 'completed' && scene.videoUrl && !scene.stale).length;
  const renderReason = !project ? 'Mở một dự án trước.' : locked ? 'Đợi tác vụ đang xử lý hoàn tất.' : dirty ? 'Lưu hoặc bỏ các prompt chưa lưu trước khi ghép.' : !scenes.length || completed !== scenes.length ? 'Mọi cảnh cần có clip đúng phiên bản trước khi ghép.' : '';
  return { dirty, running, completed, canRender: !renderReason, renderReason, canResume: Boolean(project && project.status === 'failed' && !locked && !dirty && configured), canDelete: Boolean(project && !locked) };
}

export function narratedSceneAction(scene, { dirty = false, busy = false, configured = true } = {}) {
  const reason = dirty ? 'Lưu hoặc bỏ prompt chưa lưu trước khi tạo clip.' : busy || ['starting', 'generating'].includes(scene.status) ? 'Đợi tác vụ đang xử lý hoàn tất.' : !configured ? 'Cấu hình khóa Google có quyền Veo trong Cài đặt.' : '';
  return { canGenerate: !reason, reason };
}

export function updateNarratedDraft(scene, drafts, prompt) {
  const previous = drafts[scene.id] || { version: scene.version, originalPrompt: scene.prompt };
  const next = { ...drafts };
  if (prompt === previous.originalPrompt) delete next[scene.id];
  else next[scene.id] = { ...previous, prompt };
  return next;
}

export function clearNarratedDraft(drafts, sceneId, submitted) {
  if (drafts[sceneId] !== submitted) return drafts;
  const next = { ...drafts }; delete next[sceneId]; return next;
}

export function newerNarratedProject(previous, incoming) {
  return previous?.id === incoming.id && previous.updatedAt > incoming.updatedAt ? previous : incoming;
}

// Reads belong to a selection epoch and cannot cross a foreground mutation.
export function createNarratedWorkspace() {
  let epoch = 0; let projectId = null; let serial = 0; let readSerial = 0; let revision = 0; let active = null;
  const current = ticket => Boolean(ticket && ticket === active && ticket.epoch === epoch && ticket.projectId === projectId);
  return {
    select(id) { ++epoch; ++revision; projectId = id; active = null; },
    read() { return Object.freeze({ epoch, projectId, revision, serial: ++readSerial }); },
    accepts(ticket) { return Boolean(ticket && ticket.epoch === epoch && ticket.projectId === projectId && ticket.revision === revision && ticket.serial === readSerial); },
    start(action) { if (active) return null; ++revision; active = Object.freeze({ epoch, projectId, action, serial: ++serial }); return active; },
    current,
    finish(ticket) { if (!current(ticket)) return false; ++revision; active = null; return true; },
  };
}

export function narratedPreview(scene, selectedId) {
  const selected = scene.history?.find(item => item.id === selectedId && item.status === 'completed' && item.videoUrl);
  if (selected) return selected;
  if (scene.videoUrl) return { id: 'current', videoUrl: scene.videoUrl, version: scene.version };
  return scene.history?.find(item => item.status === 'completed' && item.videoUrl) || null;
}

export const narratedStatusLabels = {
  queued: 'Đang xếp hàng', importing: 'Đang tải nguồn', transcribing: 'Đang nhận dạng lời đọc', planning: 'Đang lên cảnh',
  generating: 'Đang tạo clip', assembling: 'Đang ghép video', ready: 'Sẵn sàng ghép', completed: 'Hoàn thành', failed: 'Cần xử lý lỗi',
  draft: 'Chưa tạo clip', starting: 'Đang gửi yêu cầu', idle: 'Chưa ghép video',
};
