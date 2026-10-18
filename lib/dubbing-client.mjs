export function dubbingDirty(saved, profile) {
  if (!saved || !profile) return false;
  return JSON.stringify({ speakers: saved.speakers, assignments: saved.assignments }) !== JSON.stringify({ speakers: profile.speakers, assignments: profile.assignments });
}

export function dubbingConflict(profile, remote) {
  return Boolean(profile && remote && profile.version !== remote.version);
}

export function receiveDubbingSnapshot(current, incoming, { reset = false } = {}) {
  const keepDraft = !reset && dubbingDirty(current?.saved, current?.profile);
  return { ...incoming, remote: incoming.profile, saved: keepDraft ? current.saved : incoming.profile, profile: keepDraft ? current.profile : incoming.profile };
}

export function setDubbingAssignment(profile, cueId, speakerId) {
  return { ...profile, assignments: profile.assignments.map(item => item.cueId === cueId ? { ...item, speakerId, uncertain: false } : item) };
}

export function dubbingActionState(profile, { dirty = false, subtitleDirty = false, subtitleVersion = profile?.subtitleVersion, busy = false, expired = false, conflict = false, configured = true } = {}) {
  const lockedReason = expired ? 'Video đã hết hạn.' : busy ? 'Đợi tác vụ đang xử lý hoàn tất.' : !profile ? 'Đang tải cấu hình lồng tiếng.' : subtitleDirty ? 'Lưu phụ đề trước khi tiếp tục lồng tiếng.' : conflict ? 'Nạp cấu hình hiện tại từ máy chủ trước khi tiếp tục.' : '';
  const reason = lockedReason || (dirty ? 'Lưu phân vai và giọng trước khi phân vai lại, nghe thử hoặc xuất.' : !configured ? 'Thêm khóa Google trong Cài đặt để dùng lồng tiếng Gemini.' : '');
  const subtitleStale = Boolean(profile && profile.subtitleVersion !== subtitleVersion);
  const savedReason = reason || (subtitleStale ? 'Lưu lại phân vai cho phiên bản phụ đề hiện tại trước khi nghe thử hoặc xuất.' : profile?.version > 0 ? '' : 'Lưu phân vai và giọng trước khi nghe thử hoặc xuất.');
  return { canSave: Boolean((dirty || profile?.version === 0 || subtitleStale) && !lockedReason), canAnalyze: !reason, canPreview: !savedReason, canRender: !savedReason, reason, savedReason };
}

export function dubbingPreviewCue(profile, cues, speakerId) {
  const assigned = new Set((profile?.assignments || []).filter(item => item.speakerId === speakerId).map(item => item.cueId));
  return cues.find(cue => assigned.has(cue.id) && cue.text?.trim()) || null;
}

export function dubbingMediaState(media, profile, subtitleVersion, { dirty = false, subtitleDirty = false } = {}) {
  const available = Boolean(media?.token);
  return { available, stale: Boolean(available && (dirty || subtitleDirty || media.version !== profile?.version || media.subtitleVersion !== subtitleVersion)) };
}
