'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icons';
import { fileUrl, formatTime, isJobExpired, request } from '../lib/client';
import { dubbingActionState, dubbingConflict, dubbingDirty, dubbingMediaState, dubbingPreviewCue, receiveDubbingSnapshot, setDubbingAssignment } from '../lib/dubbing-client.mjs';

export default function DubbingPanel({ job, cues, subtitleDirty = false, busy = false, onSeek, onChanged, onDirtyChange }) {
  const [snapshot, setSnapshot] = useState(null);
  const [pending, setPending] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [responseStatus, setResponseStatus] = useState(null);
  const alive = useRef(true); const sequence = useRef(0); const actionLock = useRef(false);
  const profile = snapshot?.profile; const dirty = dubbingDirty(snapshot?.saved, profile);
  const expired = isJobExpired(job, responseStatus); const locked = busy || Boolean(pending) || expired;
  const remote = job.dubbing && job.dubbing.version > (snapshot?.remote?.version ?? -1) ? job.dubbing : snapshot?.remote;
  const conflict = dubbingConflict(profile, remote);
  const subtitleStale = Boolean(profile && profile.subtitleVersion !== job.subtitleVersion);
  const actions = dubbingActionState(profile, { dirty, subtitleDirty, subtitleVersion: job.subtitleVersion, busy: busy || Boolean(pending), expired, conflict, configured: snapshot?.configured ?? false });
  const assignments = new Map((profile?.assignments || []).map(item => [item.cueId, item]));
  const uncertainCount = profile?.assignments.filter(item => item.uncertain).length || 0;
  const output = job.dubbingOutput ?? snapshot?.output; const preview = job.dubbingPreview ?? snapshot?.preview;
  const outputState = dubbingMediaState(output, remote || profile, job.subtitleVersion, { dirty, subtitleDirty });
  const previewState = dubbingMediaState(preview, remote || profile, job.subtitleVersion, { dirty, subtitleDirty });
  const previewSpeaker = profile?.speakers.find(speaker => speaker.id === preview?.speakerId);
  const previewUrl = previewState.available ? `${fileUrl(job.id, 'dub-preview')}?v=${encodeURIComponent(preview.token)}` : '';

  const load = useCallback(async ({ reset = false } = {}) => {
    const ticket = ++sequence.current;
    try {
      const next = await request(`/api/jobs/${encodeURIComponent(job.id)}/dubbing`);
      if (!alive.current || ticket !== sequence.current) return;
      setSnapshot(current => receiveDubbingSnapshot(current, next, { reset }));
      setError(''); setResponseStatus(null);
      return next;
    } catch (cause) {
      if (alive.current && ticket === sequence.current) { setError(cause.message); setResponseStatus(cause.status || null); }
    }
  }, [job.id]);

  useEffect(() => { alive.current = true; return () => { alive.current = false; ++sequence.current; }; }, []);
  useEffect(() => { load(); }, [load, job.dubbing?.version, job.subtitleVersion, job.dubbingOutput?.token, job.dubbingPreview?.token]);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);

  function edit(update) {
    setSnapshot(current => current ? { ...current, profile: update(current.profile) } : current);
    setMessage('');
  }
  function editSpeaker(id, patch) { edit(current => ({ ...current, speakers: current.speakers.map(speaker => speaker.id === id ? { ...speaker, ...patch } : speaker) })); }
  function addSpeaker() {
    if (!profile || locked || profile.speakers.length >= 8) return;
    const id = Array.from({ length: 8 }, (_, index) => `spk_${index + 1}`).find(candidate => !profile.speakers.some(speaker => speaker.id === candidate));
    const voice = snapshot.voices[profile.speakers.length % snapshot.voices.length]?.id || profile.speakers[0]?.voice;
    edit(current => ({ ...current, speakers: [...current.speakers, { id, name: `Vai ${id.slice(4)}`, voice }] }));
  }
  function removeSpeaker(id) {
    if (!profile || locked || profile.speakers.length <= 1 || profile.assignments.some(item => item.speakerId === id)) return;
    edit(current => ({ ...current, speakers: current.speakers.filter(speaker => speaker.id !== id) }));
  }
  async function action(kind, speakerId) {
    const allowed = kind === 'save' ? actions.canSave : kind === 'analyze' ? actions.canAnalyze : kind === 'preview' ? actions.canPreview && dubbingPreviewCue(profile, cues, speakerId) : actions.canRender;
    if (actionLock.current || !allowed) return;
    actionLock.current = true; setPending(kind === 'preview' ? `preview:${speakerId}` : kind); setError(''); setMessage('');
    try {
      const root = `/api/jobs/${encodeURIComponent(job.id)}/dubbing`;
      if (kind === 'save') {
        const result = await request(root, { method: 'PUT', body: { ...profile, subtitleVersion: job.subtitleVersion } });
        if (!alive.current) return;
        // Only a confirmed write clears the draft. A failed refresh still retains this saved version.
        if (result.job?.dubbing) {
          ++sequence.current;
          setSnapshot(current => receiveDubbingSnapshot(current, { ...current, profile: result.job.dubbing }, { reset: true }));
          await load();
        } else await load({ reset: true });
        if (alive.current) setMessage('Đã lưu phân vai và giọng. Bạn có thể nghe thử từng vai hoặc xuất video.');
      } else {
        await request(`${root}/${kind}`, { method: 'POST', body: { version: profile.version, subtitleVersion: job.subtitleVersion, ...(kind === 'preview' ? { speakerId } : {}) } });
        if (alive.current) setMessage(kind === 'analyze' ? 'Đã xếp hàng phân vai từ tiếng nói. Hãy kiểm tra và sửa gợi ý khi hoàn tất.' : kind === 'preview' ? 'Đã xếp hàng tạo câu nghe thử. Âm thanh sẽ xuất hiện bên dưới khi hoàn tất.' : 'Đã xếp hàng xuất MP4 lồng tiếng. Kết quả sẽ xuất hiện bên dưới khi hoàn tất.');
      }
      if (alive.current) await onChanged();
    } catch (cause) {
      if (alive.current) {
        setResponseStatus(cause.status || null);
        setError(cause.status === 409 ? 'Cấu hình hoặc phụ đề đã thay đổi. Bản sửa của bạn vẫn được giữ. Tải lại trạng thái để kiểm tra phiên bản hiện tại.' : cause.message);
      }
    } finally { actionLock.current = false; if (alive.current) setPending(''); }
  }
  function reload() {
    if (dirty && !window.confirm('Nạp phân vai và giọng đã lưu trên máy chủ? Các chỉnh sửa lồng tiếng chưa lưu sẽ bị thay thế.')) return;
    setMessage(''); load({ reset: true });
  }

  return <section className="panel dubbing-panel" aria-labelledby="dubbing-title">
    <div className="dubbing-heading"><div><div className="eyebrow">GIỌNG VIỆT THEO NHÂN VẬT</div><h2 id="dubbing-title"><Icon name="audio" size={23} />Lồng tiếng</h2><p>Chọn giọng cho từng vai, kiểm tra câu thoại rồi xuất video lồng tiếng.</p></div><span className={`edit-state ${dirty || subtitleStale ? 'unsaved' : ''}`}>{dirty ? 'Chưa lưu' : subtitleStale ? 'Cần lưu lại' : profile?.version > 0 ? `Đã lưu · v${profile.version}` : 'Chưa lưu cấu hình'}</span></div>
    <p className="dubbing-description">Âm thanh gốc giảm khi có lời Việt và giữ trong khoảng trống. Nhạc, hiệu ứng và lời gốc đều giảm cùng nhau.</p>
    {error && <div className="notice error" role="alert"><Icon name="warning" /><span>{error}</span><button className="text-button" disabled={Boolean(pending)} onClick={() => load()}>Tải lại trạng thái</button></div>}
    {message && <div className="notice success" role="status"><Icon name="checkCircle" /><span>{message}</span></div>}
    {!snapshot ? <div className="dubbing-loading">{error ? <span>Cấu hình chưa tải được. Bản sửa đang có sẽ được giữ khi kết nối lại.</span> : <><Icon name="loader" className="spin" /><span>Đang tải giọng và phân vai…</span></>}</div> : <>
      {!snapshot.configured && <div className="notice warning"><Icon name="info" /><span>Thêm khóa Google trong <a href="#settings">Cài đặt</a> để phân vai, nghe thử và xuất bằng Gemini. Bạn vẫn có thể sửa và lưu cấu hình.</span></div>}
      {conflict && <div className="notice warning"><Icon name="warning" /><span>Máy chủ có cấu hình mới. Các thay đổi lồng tiếng chưa lưu vẫn được giữ trên màn hình này.</span><button className="text-button" onClick={reload} disabled={locked}>Nạp bản máy chủ</button></div>}
      {subtitleStale && !conflict && <div className="notice warning"><Icon name="info" /><span>Phụ đề đã đổi. Kiểm tra phân vai và lưu lại cho phụ đề v{job.subtitleVersion} trước khi nghe thử hoặc xuất.</span></div>}
      <div className="dubbing-analysis"><div><strong>Phân vai từ tiếng nói</strong><p>Video mới dùng Gemini tự nhận diện người nói trong lần nhận dạng phụ đề đầu tiên và phân vai khi dịch xong. Bạn có thể sửa tên vai, gán lại từng câu và chọn giọng có sẵn. Phân biệt từ 3 người nói trở lên còn thử nghiệm.</p></div><button className="button secondary" disabled={!actions.canAnalyze} title={actions.reason || (profile.version > 0 ? 'Chạy lại nhận dạng tiếng nói để cập nhật gợi ý phân vai.' : 'Nhận dạng tiếng nói để gợi ý phân vai cho video này.')} onClick={() => action('analyze')}><Icon name={pending === 'analyze' ? 'loader' : 'sparkles'} className={pending === 'analyze' ? 'spin' : ''} size={17} />{pending === 'analyze' ? 'Đang xếp hàng…' : profile.version > 0 ? 'Nhận diện lại người nói' : 'Phân vai tự động'}</button></div>
      <div className="dubbing-section-heading"><h3>Vai và giọng <span>{profile.speakers.length}/8</span></h3><button className="text-button" disabled={locked || profile.speakers.length >= 8} onClick={addSpeaker}><Icon name="plus" size={16} />Thêm vai</button></div>
      <div className="dubbing-speakers">{profile.speakers.map((speaker, index) => {
        const assigned = profile.assignments.filter(item => item.speakerId === speaker.id).length;
        const cue = dubbingPreviewCue(profile, cues, speaker.id); const previewing = pending === `preview:${speaker.id}`;
        const canRemove = profile.speakers.length > 1 && assigned === 0;
        return <div className="dubbing-speaker" key={speaker.id}>
          <div className="dubbing-speaker-top"><span className="dubbing-role-number">{String(index + 1).padStart(2, '0')}</span><span>{assigned} câu</span><button className="icon-button" aria-label={`Xóa ${speaker.name || `vai ${index + 1}`}`} title={canRemove ? 'Xóa vai chưa được gán câu.' : assigned ? `Gán lại ${assigned} câu sang vai khác trước khi xóa.` : 'Cần giữ ít nhất một vai.'} disabled={locked || !canRemove} onClick={() => removeSpeaker(speaker.id)}><Icon name="trash" size={16} /></button></div>
          <label htmlFor={`dubbing-name-${speaker.id}`}>Tên vai</label><input id={`dubbing-name-${speaker.id}`} value={speaker.name} maxLength={60} disabled={locked} onChange={event => editSpeaker(speaker.id, { name: event.target.value })} />
          <label htmlFor={`dubbing-voice-${speaker.id}`}>Giọng đọc</label><select id={`dubbing-voice-${speaker.id}`} value={speaker.voice} disabled={locked} onChange={event => editSpeaker(speaker.id, { voice: event.target.value })}>{snapshot.voices.map(voice => <option key={voice.id} value={voice.id}>{voice.label}</option>)}</select>
          <button className="button secondary dubbing-preview-button" disabled={!actions.canPreview || !cue} title={!cue ? 'Gán ít nhất một câu có lời dịch cho vai này để nghe thử.' : actions.savedReason || `Nghe thử câu đầu tiên của vai tại ${formatTime(cue.start)}.`} onClick={() => action('preview', speaker.id)}><Icon name={previewing ? 'loader' : 'play'} className={previewing ? 'spin' : ''} size={15} />{previewing ? 'Đang xếp hàng…' : 'Nghe thử một câu'}</button>
          <p className="dubbing-speaker-help">{cue ? `Câu đầu tiên · ${formatTime(cue.start)}` : 'Chưa có câu để nghe thử.'}{assigned > 0 && ' Gán lại các câu trước khi xóa vai.'}</p>
        </div>;
      })}</div>
      <div className="dubbing-section-heading"><h3>Gán vai cho câu thoại <span>{cues.length} câu</span></h3>{uncertainCount > 0 && <span className="dubbing-uncertain">{uncertainCount} câu cần kiểm tra</span>}</div>
      <p className="dubbing-cue-help">Nhấn thời gian để xem video. Chọn vai hoặc xác nhận sau khi kiểm tra các câu được đánh dấu.</p>
      <div className="dubbing-cues">{cues.map((cue, index) => {
        const assignment = assignments.get(cue.id);
        return <div className={`dubbing-cue ${assignment?.uncertain ? 'dubbing-cue-uncertain' : ''}`} key={cue.id}>
          <div className="dubbing-cue-top"><span className="cue-number">{String(index + 1).padStart(2, '0')}</span><button className="cue-time" onClick={() => onSeek(cue)} aria-label={`Xem câu ${index + 1}, ${formatTime(cue.start)}`}><Icon name="play" size={11} />{formatTime(cue.start)} → {formatTime(cue.end)}</button>{assignment?.uncertain && <span className="dubbing-uncertain">Cần kiểm tra vai</span>}</div>
          <p className="cue-original" lang="auto">{cue.original}</p><p className="dubbing-cue-text">{cue.text}</p>
          <div className="dubbing-assignment"><label htmlFor={`dubbing-cue-${cue.id}`}>Vai đọc</label><select id={`dubbing-cue-${cue.id}`} value={assignment?.speakerId || ''} disabled={locked} onChange={event => edit(current => setDubbingAssignment(current, cue.id, event.target.value))}>{!assignment && <option value="" disabled>Chọn vai</option>}{profile.speakers.map(speaker => <option value={speaker.id} key={speaker.id}>{speaker.name || speaker.id}</option>)}</select>{assignment?.uncertain && <button className="text-button" disabled={locked} onClick={() => edit(current => setDubbingAssignment(current, cue.id, assignment.speakerId))}><Icon name="check" size={14} />Xác nhận vai</button>}</div>
        </div>;
      })}</div>
      <div className="dubbing-actions"><div><p className="dubbing-quota">Phân vai/nghe thử/xuất dùng hạn mức Gemini.</p>{actions.savedReason && <p className="dubbing-action-reason">{actions.savedReason}</p>}</div><div className="dubbing-action-buttons"><button className="button secondary" disabled={!actions.canSave} onClick={() => action('save')}><Icon name={pending === 'save' ? 'loader' : 'save'} className={pending === 'save' ? 'spin' : ''} size={17} />{pending === 'save' ? 'Đang lưu…' : 'Lưu phân vai và giọng'}</button><button className="button primary" disabled={!actions.canRender} title={actions.savedReason} onClick={() => action('render')}><Icon name={pending === 'render' ? 'loader' : 'audio'} className={pending === 'render' ? 'spin' : ''} size={17} />{pending === 'render' ? 'Đang xếp hàng…' : 'Xuất MP4 lồng tiếng'}</button></div></div>
      {(previewState.available || outputState.available) && !expired && <div className="dubbing-results">
        {previewState.available && <div className="dubbing-audio"><div className="dubbing-result-heading"><h3>Nghe thử · {previewSpeaker?.name || preview.speakerId}</h3><span className={previewState.stale ? 'dubbing-uncertain' : 'dubbing-current'}>{previewState.stale ? 'Bản nghe thử cũ' : 'Đúng phiên bản đã lưu'}</span></div><audio key={previewUrl} controls preload="none" src={previewUrl} aria-label={`Câu nghe thử của ${previewSpeaker?.name || preview.speakerId}`} />{previewState.stale && <p className="dubbing-cue-help">Tạo câu nghe thử mới để kiểm tra các thay đổi hiện tại.</p>}</div>}
        {outputState.available && <div className="dubbing-output"><div><h3>MP4 lồng tiếng {outputState.stale && <span className="dubbing-uncertain">Bản cũ</span>}</h3><p>Phụ đề v{output.subtitleVersion} · Phân vai v{output.version}{outputState.stale ? ' · Xuất lại để áp dụng thay đổi hiện tại.' : ' · Đã ghép giọng Việt và giảm âm thanh gốc.'}</p></div><a className="button primary" href={`${fileUrl(job.id, 'dubbed')}?v=${encodeURIComponent(output.token)}`} download><Icon name="arrowDown" size={17} />{outputState.stale ? 'Tải MP4 lồng tiếng bản cũ' : 'Tải MP4 lồng tiếng'}</a></div>}
      </div>}
    </>}
  </section>;
}
