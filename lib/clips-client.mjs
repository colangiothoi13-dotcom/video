export function parseClipTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^\d+(?:\.\d{1,3})?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? seconds : null;
  }
  const parts = text.match(/^(?:(\d+):)?(\d+):([0-5]\d)(\.\d{1,3})?$/);
  if (!parts || (parts[1] !== undefined && (!/^\d{2}$/.test(parts[2]) || Number(parts[2]) > 59))) return null;
  const seconds = Number(parts[1] || 0) * 3600 + Number(parts[2]) * 60 + Number(parts[3]) + Number(parts[4] || 0);
  return Number.isFinite(seconds) ? seconds : null;
}

export function formatClipTime(value) {
  if (!Number.isFinite(value) || value < 0) return '';
  // Floor rather than round so a mark at the very end cannot exceed the video.
  const milliseconds = Math.floor(value * 1000 + 0.000001);
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const tail = `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
  return hours ? `${String(hours).padStart(2, '0')}:${tail}` : tail;
}

export function validateClipRanges(entries, duration) {
  const errors = Array.isArray(entries) ? entries.map(() => ({ start: '', end: '', range: '' })) : [];
  const result = { valid: false, ranges: [], totalDuration: 0, errors, error: '' };
  if (!Number.isFinite(duration) || duration <= 0) return { ...result, error: 'Chưa có thời lượng video hợp lệ để cắt.' };
  if (!Array.isArray(entries) || !entries.length || entries.length > 20) return { ...result, error: 'Chọn từ 1 đến 20 đoạn trong mỗi lần xuất.' };
  for (const [index, entry] of entries.entries()) {
    const start = parseClipTime(entry?.start); const end = parseClipTime(entry?.end);
    const issue = errors[index];
    if (start === null) issue.start = 'Nhập thời gian bắt đầu hợp lệ.';
    if (end === null) issue.end = 'Nhập thời gian kết thúc hợp lệ.';
    if (start !== null && start > duration) issue.start = 'Điểm bắt đầu vượt thời lượng video.';
    if (end !== null && end > duration) issue.end = 'Điểm kết thúc vượt thời lượng video.';
    if (start !== null && end !== null) {
      if (end <= start) issue.range = 'Điểm kết thúc phải sau điểm bắt đầu.';
      else if (end - start < 0.25 - 1e-9) issue.range = 'Mỗi đoạn phải dài ít nhất 0,25 giây.';
      result.ranges.push({ start, end });
      result.totalDuration += end - start;
    }
    const message = issue.start || issue.end || issue.range;
    if (message && !result.error) result.error = `Đoạn ${index + 1}: ${message}`;
  }
  result.totalDuration = Number(result.totalDuration.toFixed(6));
  if (!result.error && result.totalDuration > 1500) result.error = 'Tổng thời lượng các đoạn không được vượt 25 phút (1.500 giây).';
  result.valid = !result.error;
  return result;
}

export function clipSources(job) {
  const subtitleVersion = job?.subtitleVersion;
  const captioned = subtitleVersion > 0 && job?.renderedVersion === subtitleVersion;
  const dubbed = Boolean(job?.dubbingOutput?.token && job?.dubbing?.version > 0 && job.dubbingOutput.subtitleVersion === subtitleVersion && job.dubbingOutput.version === job.dubbing.version);
  const source = Number.isFinite(job?.duration) && job.duration > 0;
  return [
    { value: 'dubbed', label: 'MP4 lồng tiếng', description: 'Giữ hình ảnh, phụ đề đã ghép và âm thanh của MP4 lồng tiếng đã xuất.', available: dubbed, reason: dubbed ? '' : 'Cần xuất MP4 lồng tiếng đúng phiên bản phụ đề và phân vai đã lưu.' },
    { value: 'video', label: 'MP4 có phụ đề', description: 'Giữ phụ đề đã ghép vào hình ảnh và âm thanh của MP4 có phụ đề đã xuất.', available: captioned, reason: captioned ? '' : 'Cần xuất lại MP4 với phiên bản phụ đề đã lưu hiện tại.' },
    { value: 'source', label: 'Video gốc', description: 'Giữ hình ảnh và âm thanh gốc. Không thêm phụ đề hoặc giọng lồng tiếng của ứng dụng.', available: source, reason: source ? '' : 'Chưa có thời lượng video gốc hợp lệ.' },
  ];
}

export function initialClipDraft(job) {
  const duration = Number.isFinite(job?.duration) && job.duration > 0 ? job.duration : 0;
  return { source: clipSources(job).find(option => option.available)?.value || 'source', ranges: [{ start: formatClipTime(0), end: formatClipTime(Math.min(30, duration)) }] };
}

export function clipActionState(job, source, ranges, { busy = false, dirty = false, expired = false } = {}) {
  const validation = validateClipRanges(ranges, job?.duration);
  const selected = clipSources(job).find(option => option.value === source);
  const reason = expired || job?.status === 'expired' ? 'Video đã hết hạn.'
    : busy || ['queued', 'running'].includes(job?.status) ? 'Đợi công việc đang xử lý hoàn tất trước khi xuất các đoạn.'
    : dirty ? 'Lưu hoặc bỏ các thay đổi phụ đề và lồng tiếng trước khi xuất các đoạn.'
    : !selected?.available ? selected?.reason || 'Chọn một nguồn video hợp lệ.'
    : validation.error;
  return { canQueue: !reason, reason, validation };
}

export function clipOutputState(job, { dirty = false } = {}) {
  const output = job?.clipsOutput;
  const available = Boolean(output?.token && Array.isArray(output.clips) && output.clips.length);
  const stale = available && output.source !== 'source' && (dirty || output.subtitleVersion !== job.subtitleVersion || (output.source === 'dubbed' && output.dubbingVersion !== (job.dubbing?.version ?? 0)) || !['video', 'dubbed'].includes(output.source));
  return { available, stale: Boolean(stale) };
}

export function clipDownloadUrl(jobId, token, index) {
  return `/api/jobs/${encodeURIComponent(jobId)}/clips/${encodeURIComponent(token)}/${encodeURIComponent(index)}`;
}
