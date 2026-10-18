'use client';
import { useEffect, useRef, useState } from 'react';
import Icon from './Icons';
import DubbingPanel from './DubbingPanel';
import { fileUrl, formatDate, formatTime, isJobExpired, jobProgress, languageLabels, mergeDraft, previewMedia, request, stageLabels, statusLabels } from '../lib/client';

export default function JobView({ jobId, onNavigate, onChanged, registerDirty }) {
  const [data, setData] = useState(null); const [error, setError] = useState(''); const [responseStatus, setResponseStatus] = useState(null); const [busy, setBusy] = useState('');
  const [changes, setChanges] = useState({}); const changesRef = useRef({}); const [baseVersion, setBaseVersion] = useState(null);
  const [dubbingDirty, setDubbingDirty] = useState(false);
  const [sourceFailed, setSourceFailed] = useState(false); const [currentTime, setCurrentTime] = useState(0); const [failedPreviewKey, setFailedPreviewKey] = useState(null); const [message, setMessage] = useState('');
  const videoRef = useRef(null); const alive = useRef(true); const loadSequence = useRef(0); const statusRef = useRef('queued'); const dirty = Object.keys(changes).length > 0;
  const job = data?.job; const cues = data?.cues || []; const draft = mergeDraft(cues, changes);
  const expired = isJobExpired(job, responseStatus); const running = !expired && job && ['queued', 'running'].includes(job.status);
  const preview = previewMedia(jobId, job, sourceFailed); const renderedPreview = preview.rendered; const videoError = failedPreviewKey === preview.key;
  const conflict = dirty && baseVersion !== job?.subtitleVersion;
  const stale = job && job.subtitleVersion > job.renderedVersion;
  useEffect(() => { setCurrentTime(0); }, [preview.key]);
  useEffect(() => { registerDirty(dirty || dubbingDirty); return () => registerDirty(false); }, [dirty, dubbingDirty, registerDirty]);
  async function load({ reset = false } = {}) {
    const sequence = ++loadSequence.current;
    try {
      const next = await request(`/api/jobs/${encodeURIComponent(jobId)}`);
      if (!alive.current || sequence !== loadSequence.current) return;
      statusRef.current = next.job.status;
      if (reset) { changesRef.current = {}; setChanges({}); }
      const keepDraft = !reset && Object.keys(changesRef.current).length > 0;
      setData(previous => keepDraft && previous ? { job: next.job, cues: previous.cues } : next);
      if (!keepDraft) setBaseVersion(next.job.subtitleVersion);
      setError(''); setResponseStatus(null); return next;
    } catch (e) { if (alive.current && sequence === loadSequence.current) { setError(e.message); setResponseStatus(e.status || null); } }
  }
  useEffect(() => {
    alive.current = true; setData(null); changesRef.current = {}; setChanges({}); setDubbingDirty(false); setFailedPreviewKey(null); setSourceFailed(false); setError(''); setResponseStatus(null);
    load(); let timer;
    const tick = async () => { if (!document.hidden) await load(); if (alive.current) timer = setTimeout(tick, document.hidden ? 10000 : ['queued', 'running'].includes(statusRef.current) ? 2000 : 15000); };
    timer = setTimeout(tick, 2000);
    const onVisible = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive.current = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [jobId]);
  useEffect(() => { const protect = event => { if (dirty || dubbingDirty) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect); }, [dirty, dubbingDirty]);
  function edit(cue, text) {
    const next = { ...changesRef.current }; if (text === cue.text) delete next[cue.id]; else next[cue.id] = text;
    changesRef.current = next; setChanges(next); setMessage('');
  }
  function seek(cue) { if (videoRef.current) { videoRef.current.currentTime = cue.start; setCurrentTime(cue.start); videoRef.current.focus(); } }
  async function action(kind) {
    setBusy(kind); setError(''); setMessage('');
    try {
      if (kind === 'save') {
        const result = await request(`/api/jobs/${encodeURIComponent(jobId)}/subtitles`, { method: 'PUT', body: { version: baseVersion, cues: cues.map(cue => ({ id: cue.id, text: draft[cue.id] })) } });
        // Clear only after a confirmed successful write; HTTP conflict/network loss keeps every edit.
        ++loadSequence.current; changesRef.current = {}; setChanges({});
        if (result?.job && result?.cues) { setData(result); setBaseVersion(result.job.subtitleVersion); }
        else await load({ reset: true });
        setMessage('Đã lưu phụ đề. Xuất lại video để áp dụng bản mới vào MP4.');
      } else {
        await request(`/api/jobs/${encodeURIComponent(jobId)}/${kind}`, { method: 'POST' });
        await load(); setMessage(kind === 'render' ? 'Đã xếp hàng xuất video với phụ đề đã lưu.' : kind === 'cancel' ? 'Đã gửi yêu cầu hủy. Vui lòng chờ công việc dừng.' : 'Đã xếp hàng thử lại.');
      }
      onChanged();
    } catch (e) { setError(e.status === 409 && kind === 'save' ? 'Phụ đề đã thay đổi ở một phiên khác. Bản sửa của bạn vẫn được giữ. Sao chép nội dung cần giữ trước khi nạp bản trên máy chủ.' : e.message); }
    finally { setBusy(''); }
  }
  if (!data) return <div className="panel loading-panel">{error ? <><Icon name={expired ? 'clock' : 'warning'} /><p role="alert">{error}</p><button className="button secondary" onClick={() => expired ? onNavigate('create') : load()}>{expired ? 'Tạo video mới' : 'Thử kết nối lại'}</button></> : <><Icon name="loader" className="spin" /><p>Đang mở video…</p></>}</div>;
  const activeCue = cues.find(cue => currentTime >= cue.start && currentTime < cue.end);
  const progress = jobProgress(job);
  const stages = ['import', 'probe', 'transcribe', 'translate', 'render']; const stageIndex = stages.indexOf(job.stage);
  return <>
    <button className="text-button muted back-link" onClick={() => onNavigate('history')}><Icon name="arrowLeft" size={16} /> Lịch sử video</button>
    <div className="result-heading"><div><div className="eyebrow">KHÔNG GIAN CHỈNH SỬA</div><h1>{job.title || 'Video của bạn'}</h1><p>{languageLabels[job.targetLanguage] || job.targetLanguage} · {job.duration ? formatTime(job.duration) : 'Đang kiểm tra thời lượng'} · Tạo lúc {formatDate(job.createdAt)}</p></div><span className={`status-pill ${expired ? 'expired' : job.status}`}><span />{expired ? statusLabels.expired : statusLabels[job.status] || job.status}</span></div>
    {error && <div className="notice error" role="alert"><Icon name="warning" /><span>{error}</span><button className="text-button" onClick={() => load()}>Kết nối lại</button></div>}
    {message && <div className="notice success" role="status"><Icon name="checkCircle" /><span>{message}</span></div>}
    {job.error && <div className="notice error"><Icon name="warning" /><span>{typeof job.error === 'string' ? job.error : job.error.message || 'Không xử lý được video. Hãy kiểm tra nguồn và thử lại.'}</span></div>}
    {expired && <div className="notice warning"><Icon name="clock" /><span>Kết quả đã hết hạn và không còn để tải xuống. Bạn có thể tạo một video mới từ nguồn ban đầu.</span><button className="text-button" onClick={() => onNavigate('create')}>Tạo video mới</button></div>}
    {running && <section className="panel processing-panel" aria-label="Tiến độ xử lý thật"><div className="row-heading"><div><h2>{job.status === 'queued' ? 'Video đang trong hàng đợi' : stageLabels[job.stage]}</h2><p>{job.status === 'queued' ? 'Mỗi lần xử lý một video. Công việc sẽ tự bắt đầu khi đến lượt.' : 'Bạn có thể rời màn hình này và mở lại từ lịch sử.'}</p></div><span className={`progress-value ${progress.value == null ? 'indeterminate' : ''}`}>{progress.value != null && <small>{progress.label}</small>}{progress.text}</span></div><progress max="100" {...(progress.value == null ? {} : { value: progress.value })} aria-label={progress.label} /><ol className="processing-stages">{stages.map((stage, index) => <li key={stage} className={index < stageIndex ? 'complete' : index === stageIndex && job.status === 'running' ? 'current' : ''}><span>{index < stageIndex ? <Icon name="check" size={12} /> : index + 1}</span>{stageLabels[stage]}</li>)}</ol><button className="text-button muted" onClick={() => action('cancel')} disabled={!!busy}>{busy === 'cancel' ? 'Đang yêu cầu hủy…' : 'Hủy công việc'}</button></section>}
    {!expired && ['failed', 'cancelled'].includes(job.status) && <div className="retry-row"><button className="button secondary" disabled={!!busy} onClick={() => action('retry')}><Icon name="refresh" size={17} />{busy === 'retry' ? 'Đang xếp hàng…' : 'Thử lại từ bước hợp lệ'}</button></div>}
    {!!cues.length && !expired && <>
      <div className="editor-grid"><section className="video-column">{renderedPreview && <div className="notice warning"><Icon name="info" /><span>Định dạng nguồn chưa phát được trong trình duyệt. Đang xem MP4 đã xuất; hãy xuất lại để xem các phụ đề vừa sửa.</span></div>}<div className="video-frame"><video key={preview.key} ref={videoRef} controls preload="metadata" src={preview.src} onTimeUpdate={event => setCurrentTime(event.currentTarget.currentTime)} onError={() => { if (!renderedPreview) setSourceFailed(true); setFailedPreviewKey(preview.key); }} aria-label="Video gốc để xem trước phụ đề" /><div className={`editor-caption ${job.subtitleStyle}`} aria-hidden="true">{preview.showCaptions && activeCue && <span>{draft[activeCue.id]}</span>}</div></div>{videoError && <div className="notice warning"><Icon name="info" /><span>Trình duyệt chưa phát được định dạng nguồn. Bạn vẫn có thể sửa phụ đề và tải MP4 đã xuất.</span></div>}<div className="video-meta"><Icon name="monitor" size={16} /><span>{renderedPreview ? 'MP4 đã xuất · Xuất lại để xem các sửa đổi mới' : 'Video gốc + xem trước phụ đề đang sửa'}</span></div><div className="panel export-details"><h3>Tệp kết quả</h3><p>MP4 giữ nguyên âm thanh gốc, phụ đề được ghép vào hình ảnh. SRT dùng cho chỉnh sửa và đăng tải.</p><div className="version-line"><span>Phụ đề đã lưu</span><strong>Phiên bản {job.subtitleVersion}</strong></div><div className="version-line"><span>MP4 đã xuất</span><strong>{job.renderedVersion ? `Phiên bản ${job.renderedVersion}` : 'Chưa có'}</strong></div>{job.expiresAt && <div className="expiry"><Icon name="clock" size={15} /> Tải kết quả trước {formatDate(job.expiresAt)}</div>}</div></section>
      <section className="panel subtitle-editor"><div className="editor-heading"><div><h2>Biên tập phụ đề</h2><p>{cues.length} đoạn · Nhấn thời gian để xem video</p></div><span className={`edit-state ${dirty ? 'unsaved' : ''}`}>{dirty ? 'Chưa lưu' : 'Đã lưu'}</span></div><div className="cue-list">{cues.map((cue, index) => <div className={`cue-row ${activeCue?.id === cue.id ? 'is-active' : ''} ${Object.hasOwn(changes, cue.id) ? 'is-edited' : ''}`} key={cue.id}><div className="cue-top"><span className="cue-number">{String(index + 1).padStart(2, '0')}</span><button className="cue-time" onClick={() => seek(cue)} aria-label={`Tua đến đoạn ${index + 1}, ${formatTime(cue.start)}`}><Icon name="play" size={11} />{formatTime(cue.start)} → {formatTime(cue.end)}</button></div><p className="cue-original" lang="auto">{cue.original}</p><label className="visually-hidden" htmlFor={`cue-${cue.id}`}>Phụ đề dịch đoạn {index + 1}</label><textarea id={`cue-${cue.id}`} value={draft[cue.id] || ''} rows={2} onChange={event => edit(cue, event.target.value)} disabled={!!busy || running} />{(cue.readingWarning || Array.from(draft[cue.id] || '').length / (cue.end - cue.start) > 22) && <p className="reading-warning"><Icon name="info" size={13} />Câu hơi dài, hãy rút gọn để dễ đọc.</p>}</div>)}</div></section></div>
      {conflict && <div className="notice warning"><Icon name="warning" /><span>Máy chủ có phiên bản mới. Bản sửa chưa lưu vẫn được giữ trên màn hình này.</span><button className="text-button" onClick={() => { if (window.confirm('Nạp bản đã lưu trên máy chủ? Các chỉnh sửa chưa lưu sẽ bị thay thế.')) load({ reset: true }); }}>Nạp bản máy chủ</button></div>}
      {(stale || dirty) && <div className="notice warning"><Icon name="info" /><span>{dirty ? 'Phụ đề đang sửa chưa được lưu. Hãy lưu trước khi tải SRT hoặc xuất lại MP4.' : 'MP4 đang dùng phiên bản phụ đề cũ. Xuất lại để đưa các chỉnh sửa mới vào video.'}</span></div>}
      <div className="editor-action-bar"><div><span className={`save-dot ${dirty ? 'unsaved' : ''}`} /><span>{dirty ? `${Object.keys(changes).length} đoạn chưa lưu` : `Phụ đề v${job.subtitleVersion} đã lưu`}</span></div><div className="editor-actions"><button className="button secondary" disabled={!dirty || !!busy || running || conflict} onClick={() => action('save')}><Icon name={busy === 'save' ? 'loader' : 'save'} className={busy === 'save' ? 'spin' : ''} size={17} />{busy === 'save' ? 'Đang lưu…' : 'Lưu phụ đề'}</button><a className={`button secondary ${dirty ? 'disabled' : ''}`} href={dirty ? undefined : fileUrl(jobId, 'srt')} download aria-disabled={dirty} tabIndex={dirty ? -1 : 0}><Icon name="arrowDown" size={17} />SRT</a><button className="button secondary" disabled={dirty || !!busy || running} onClick={() => action('render')}><Icon name={busy === 'render' ? 'loader' : 'refresh'} className={busy === 'render' ? 'spin' : ''} size={17} />Xuất lại</button>{job.renderedVersion > 0 && <a className="button primary" href={fileUrl(jobId, 'video')} download><Icon name="arrowDown" size={17} />{stale ? 'MP4 bản cũ' : 'Tải MP4'}</a>}</div></div>
      <DubbingPanel key={jobId} job={job} cues={cues} subtitleDirty={dirty} busy={!!busy || running} onSeek={seek} onChanged={async () => { await load(); await onChanged(); }} onDirtyChange={setDubbingDirty} />
    </>}
    {!cues.length && !running && !expired && <div className="panel empty-state"><Icon name="subtitles" size={36} /><h2>Chưa có phụ đề để biên tập</h2><p>Kết quả sẽ xuất hiện sau khi video được nhận dạng và dịch thành công.</p></div>}
  </>;
}
