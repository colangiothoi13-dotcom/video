'use client';
import { useEffect, useId, useRef, useState } from 'react';
import Icon from './Icons';
import { isJobExpired, request } from '../lib/client';
import { clipActionState, clipDownloadUrl, clipOutputState, clipSources, formatClipTime, initialClipDraft, parseClipTime } from '../lib/clips-client.mjs';
import styles from './ClipPanel.module.css';

const durationLabel = seconds => `${Number(seconds.toFixed(3)).toLocaleString('vi-VN')} giây`;

export default function ClipPanel({ job, currentTime = 0, onSeek, onChanged, busy = false, dirty = false }) {
  const [draft, setDraft] = useState(() => {
    const initial = initialClipDraft(job);
    return { ...initial, ranges: initial.ranges.map((range, id) => ({ ...range, id })) };
  });
  const [pending, setPending] = useState(false);
  const [accepted, setAccepted] = useState(null);
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [responseStatus, setResponseStatus] = useState(null);
  const requestLock = useRef(false); const alive = useRef(true); const nextRangeId = useRef(1);
  const instanceId = useId(); const titleId = `clips-title-${instanceId}`; const helpId = `clips-help-${instanceId}`;
  const expired = isJobExpired(job, responseStatus);
  const sources = clipSources(job); const selected = sources.find(item => item.value === draft.source);
  const action = clipActionState(job, draft.source, draft.ranges, { busy: busy || pending || Boolean(accepted), dirty, expired });
  const { validation } = action; const output = job.clipsOutput; const outputState = clipOutputState(job, { dirty });
  const fieldsLocked = pending || expired;
  const position = Number.isFinite(currentTime) && currentTime >= 0 && Number.isFinite(job.duration) && job.duration > 0 ? Math.min(currentTime, job.duration) : null;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (accepted && (['queued', 'running'].includes(job.status) || job.updatedAt !== accepted.updatedAt || job.clipsOutput?.token !== accepted.token || job.status !== accepted.status)) setAccepted(null);
  }, [accepted, job.status, job.updatedAt, job.clipsOutput?.token]);

  function editRange(id, field, value) {
    setDraft(current => ({ ...current, ranges: current.ranges.map(range => range.id === id ? { ...range, [field]: value } : range) }));
    setError(''); setMessage('');
  }
  function addRange() {
    if (fieldsLocked || draft.ranges.length >= 20) return;
    const previousEnd = parseClipTime(draft.ranges.at(-1)?.end);
    const start = previousEnd !== null && previousEnd <= job.duration - 0.25 ? previousEnd : 0;
    const range = { id: nextRangeId.current++, start: formatClipTime(start), end: formatClipTime(Math.min(start + 30, job.duration)) };
    setDraft(current => ({ ...current, ranges: [...current.ranges, range] }));
    setError(''); setMessage('');
  }
  function removeRange(id) {
    if (fieldsLocked || draft.ranges.length <= 1) return;
    setDraft(current => ({ ...current, ranges: current.ranges.filter(range => range.id !== id) }));
    setError(''); setMessage('');
  }
  async function queueClips(event) {
    event.preventDefault();
    if (requestLock.current || !action.canQueue) return;
    requestLock.current = true; setPending(true); setError(''); setMessage('');
    try {
      await request(`/api/jobs/${encodeURIComponent(job.id)}/clips`, { method: 'POST', body: { source: draft.source, subtitleVersion: job.subtitleVersion, dubbingVersion: job.dubbing?.version ?? 0, ranges: validation.ranges } });
      if (!alive.current) return;
      // Keep the local lock until parent polling acknowledges a newer job snapshot.
      setAccepted({ status: job.status, updatedAt: job.updatedAt, token: job.clipsOutput?.token });
      setResponseStatus(null);
      setMessage('Đã xếp hàng cắt video. Mỗi đoạn sẽ có một tệp MP4 riêng để tải khi hoàn tất.');
      try { await onChanged?.(); }
      catch { if (alive.current) setMessage('Đã xếp hàng cắt video. Đang chờ kết nối lại để cập nhật kết quả.'); }
    } catch (cause) {
      if (alive.current) {
        setResponseStatus(cause.status || null);
        setError(cause.status === 409 ? 'Nguồn hoặc phiên bản video đã thay đổi. Các mốc cắt vẫn được giữ; kiểm tra nguồn hiện tại rồi thử lại.' : cause.message);
      }
    } finally { requestLock.current = false; if (alive.current) setPending(false); }
  }

  return <section id="clips-panel" className={`panel ${styles.panel}`} aria-labelledby={titleId}>
    <div className={styles.heading}>
      <div><div className="eyebrow">CHỌN ĐOẠN VÀ TẢI RIÊNG</div><h2 id={titleId}><Icon name="film" size={23} />Cắt video thành nhiều đoạn</h2><p>Chọn điểm bắt đầu, kết thúc cho từng đoạn rồi xuất các tệp MP4 để tải xuống.</p></div>
      <span className={styles.limit}>{draft.ranges.length}/20 đoạn</span>
    </div>
    {error && <div className="notice error" role="alert"><span>{error}</span></div>}
    {message && <div className="notice success" role="status"><span>{message}</span></div>}
    <form onSubmit={queueClips} noValidate>
      <div className={styles.sourceRow}>
        <div><label htmlFor={`clips-source-${instanceId}`}>Nguồn để cắt</label><select id={`clips-source-${instanceId}`} value={draft.source} disabled={fieldsLocked} aria-describedby={`clips-source-help-${instanceId}`} onChange={event => { setDraft(current => ({ ...current, source: event.target.value })); setError(''); setMessage(''); }}>{sources.map(source => <option key={source.value} value={source.value} disabled={!source.available}>{source.label}{!source.available ? ' · chưa có bản hiện tại' : ''}</option>)}</select></div>
        <p id={`clips-source-help-${instanceId}`} className={styles.sourceHelp}>{selected?.description}</p>
      </div>
      {!selected?.available && <p className={styles.sourceError} role="alert">Nguồn đã chọn chưa có bản phù hợp. {selected?.reason} Chọn một nguồn đang có để tiếp tục; các mốc cắt vẫn được giữ.</p>}
      <div className={styles.timelineInfo}><span><Icon name="clock" size={15} />Vị trí đang xem: <strong>{position === null ? 'Chưa xác định' : formatClipTime(position)}</strong></span><span>Video dài {formatClipTime(job.duration)}</span></div>
      <p id={helpId} className={styles.help}>Nhập MM:SS.mmm, HH:MM:SS.mmm hoặc số giây. Mỗi đoạn ít nhất 0,25 giây; tổng tối đa 25 phút. Các đoạn có thể chồng lên nhau.</p>
      <ol className={styles.rangeList}>
        {draft.ranges.map((range, index) => {
          const start = parseClipTime(range.start); const end = parseClipTime(range.end);
          const issue = validation.errors[index]; const rangeError = issue?.start || issue?.end || issue?.range;
          const rangeErrorId = `clips-error-${instanceId}-${range.id}`;
          const seekable = start !== null && start <= job.duration && !expired;
          return <li key={range.id}>
            <fieldset className={styles.rangeCard} disabled={fieldsLocked}>
              <legend>Đoạn {String(index + 1).padStart(2, '0')}</legend>
              <div className={styles.rangeTop}><span>{!rangeError && start !== null && end !== null ? durationLabel(end - start) : 'Kiểm tra mốc thời gian'}</span><button type="button" className="text-button" disabled={fieldsLocked || draft.ranges.length <= 1} aria-label={`Xóa đoạn ${index + 1}`} onClick={() => removeRange(range.id)}><Icon name="trash" size={15} />Xóa</button></div>
              <div className={styles.timeFields}>
                {['start', 'end'].map(field => {
                  const label = field === 'start' ? 'Bắt đầu' : 'Kết thúc'; const inputId = `clips-${field}-${instanceId}-${range.id}`;
                  return <div key={field}><label htmlFor={inputId}>{label}</label><input id={inputId} type="text" inputMode="decimal" value={range[field]} placeholder="00:00.000" autoComplete="off" spellCheck={false} maxLength={24} aria-invalid={Boolean(issue?.[field] || issue?.range)} aria-describedby={`${helpId}${rangeError ? ` ${rangeErrorId}` : ''}`} onChange={event => editRange(range.id, field, event.target.value)} /><button type="button" className={`text-button ${styles.markButton}`} disabled={fieldsLocked || position === null} aria-label={`Lấy vị trí đang xem làm điểm ${label.toLocaleLowerCase('vi-VN')} đoạn ${index + 1}`} onClick={() => editRange(range.id, field, formatClipTime(position))}><Icon name="clock" size={13} />Lấy vị trí đang xem</button></div>;
                })}
              </div>
              {rangeError && <p id={rangeErrorId} className={styles.rangeError}>{rangeError}</p>}
              <button type="button" className={`text-button ${styles.seekButton}`} disabled={fieldsLocked || !seekable} onClick={() => onSeek?.({ start })}><Icon name="play" size={14} />Xem từ điểm bắt đầu</button>
            </fieldset>
          </li>;
        })}
      </ol>
      <div className={styles.addRow}><button type="button" className="button secondary" disabled={fieldsLocked || draft.ranges.length >= 20} onClick={addRange}><Icon name="plus" size={16} />Thêm đoạn</button><span>{validation.valid ? `Tổng ${durationLabel(validation.totalDuration)}` : 'Kiểm tra các mốc trước khi xuất'}</span></div>
      <div className={styles.actions}><div><p>Mỗi đoạn được xuất thành một tệp MP4 riêng.</p>{!action.canQueue && <p className={styles.actionReason} aria-live="polite">{action.reason}</p>}</div><button type="submit" className="button primary" disabled={!action.canQueue}><Icon name="film" size={17} />{pending ? 'Đang xếp hàng…' : accepted || ['queued', 'running'].includes(job.status) ? 'Đang chờ xử lý…' : `Xuất ${draft.ranges.length} đoạn MP4`}</button></div>
    </form>
    {outputState.available && <div className={styles.results}>
      <div className={styles.resultHeading}><h3>Các đoạn đã xuất</h3><span className={outputState.stale ? styles.stale : styles.current}>{outputState.stale ? 'Bản cũ' : output.source === 'source' ? 'Video gốc' : 'Đúng phiên bản đã lưu'}</span></div>
      <p className={styles.outputMeta}>{output.source === 'dubbed' ? `MP4 lồng tiếng · phụ đề v${output.subtitleVersion} · phân vai v${output.dubbingVersion}` : output.source === 'video' ? `MP4 có phụ đề · phụ đề v${output.subtitleVersion}` : 'Video gốc · không thêm phụ đề hoặc lồng tiếng'}</p>
      <p className={styles.help}>{expired ? 'Video đã hết hạn; các tệp không còn tải được.' : outputState.stale ? 'Các tệp này giữ nội dung của lần xuất trước và chưa gồm thay đổi hiện tại. Xuất các đoạn mới để cập nhật.' : 'Kết quả lần xuất thành công gần nhất. Xuất một bộ đoạn mới sẽ thay thế bộ này.'}</p>
      <ul className={styles.downloads}>{output.clips.map(clip => <li key={clip.index}><div><strong>Đoạn {String(clip.index + 1).padStart(2, '0')}</strong><span>{formatClipTime(clip.start)} → {formatClipTime(clip.end)}</span><small>{durationLabel(clip.duration)}</small></div><a className={`button secondary ${expired ? 'disabled' : ''}`} href={expired ? undefined : clipDownloadUrl(job.id, output.token, clip.index)} aria-disabled={expired} tabIndex={expired ? -1 : 0} download aria-label={`Tải MP4 đoạn ${clip.index + 1}`}><Icon name="arrowDown" size={16} />MP4</a></li>)}</ul>
    </div>}
  </section>;
}
