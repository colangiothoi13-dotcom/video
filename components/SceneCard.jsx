'use client';
import { useEffect, useRef, useState } from 'react';
import Icon from './Icons';
import { formatDate, sceneActionState, scenePreview } from '../lib/client';

const labels = { draft: 'Bản nháp', starting: 'Đang gửi yêu cầu', generating: 'Đang tạo clip', completed: 'Đã tạo clip', failed: 'Cần thử lại' };
const running = scene => ['starting', 'generating'].includes(scene.status);
const errorMessage = error => typeof error === 'string' ? error : error?.message;

export default function SceneCard({ scene, index, project, draft, busy, configured, copied, selectedPreview, onSelectPreview, onPhaseChange, onEdit, onSave, onGenerate, onCopy, onDiscard }) {
  const [promptOpen, setPromptOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [comparisonId, setComparisonId] = useState('');
  const promptRef = useRef(null); const videoRef = useRef(null);
  const sceneBusy = busy.startsWith(`${scene.id}:`);
  const locked = running(scene) || sceneBusy || project.assembly.status === 'rendering' || ['all', 'video', 'render'].includes(busy);
  const conflict = Boolean(draft && draft.version !== scene.version);
  const action = sceneActionState(scene, { dirty: Boolean(draft), busy: Boolean(busy), configured, locked });
  const preview = scenePreview(scene, selectedPreview);
  const history = scene.history || [];
  const comparison = history.find(item => item.id === comparisonId);
  const generationBusy = busy === `${scene.id}:generate` || busy === `${scene.id}:regenerate` || running(scene);

  useEffect(() => {
    if (previewOpen && preview?.videoUrl) videoRef.current?.play()?.catch(() => {});
  }, [previewOpen, preview?.videoUrl]);

  function openPrompt() {
    setPromptOpen(true); onPhaseChange(3);
    requestAnimationFrame(() => promptRef.current?.focus());
  }
  function openPreview(id) {
    if (id) onSelectPreview(scene.id, id);
    setPreviewOpen(true); onPhaseChange(4);
    requestAnimationFrame(() => { videoRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); videoRef.current?.play()?.catch(() => {}); });
  }

  return <section className={`panel scene-card ${draft ? 'has-draft' : ''}`} aria-label={`Cảnh ${index + 1}: ${scene.title}`}>
    <div className="scene-card-heading"><div className="scene-card-title"><span className="step-number">{String(index + 1).padStart(2, '0')}</span><div><h2>{scene.title}</h2><p>{scene.durationSeconds} giây · Phiên bản {scene.version}</p></div></div><span className={`scene-status ${scene.status}`} role={running(scene) ? 'status' : undefined}>{running(scene) && <Icon name="loader" className="spin" size={13} />}{labels[scene.status] || scene.status}</span></div>
    <div className="scene-shot-details"><div><h3>Hành động</h3><p>{scene.action}</p></div><div><h3>Hình ảnh</h3><p>{scene.visual}</p></div></div>

    <div className="scene-main-actions" role="group" aria-label={`Thao tác chính cảnh ${index + 1}`}>
      <button type="button" className={`button ${promptOpen ? 'secondary active' : 'secondary'}`} aria-expanded={promptOpen} aria-controls={`scene-editor-${scene.id}`} aria-describedby={`prompt-help-${scene.id}`} onClick={openPrompt}><Icon name="file" size={16} />Prompt</button>
      <button type="button" className="button primary" disabled={!action.canGenerate} title={action.generateReason || 'Tạo clip đầu tiên, còn thiếu hoặc cần cập nhật.'} aria-describedby={`generate-help-${scene.id}`} onClick={() => onGenerate('scene', scene)}><Icon name={generationBusy ? 'loader' : 'sparkles'} className={generationBusy ? 'spin' : ''} size={16} />Generate</button>
      <button type="button" className="button secondary" disabled={!preview} title={preview ? 'Phát clip đã lưu được chọn hoặc clip thành công mới nhất.' : 'Chưa có clip thành công để xem.'} aria-describedby={`preview-help-${scene.id}`} onClick={() => openPreview()}><Icon name="play" size={16} />Preview</button>
      <button type="button" className="button secondary" disabled={!action.canRegenerate} title={action.regenerateReason || 'Tạo lại riêng cảnh theo prompt đã lưu; giữ mọi bản cũ.'} aria-describedby={`regenerate-help-${scene.id}`} onClick={() => onGenerate('regenerate', scene)}><Icon name={generationBusy ? 'loader' : 'refresh'} className={generationBusy ? 'spin' : ''} size={16} />Regenerate</button>
    </div>
    <dl className="scene-action-help">
      <div id={`prompt-help-${scene.id}`}><dt>Prompt</dt><dd>Mở chỉ dẫn riêng và prompt hiệu lực đã lưu.</dd></div>
      <div id={`generate-help-${scene.id}`}><dt>Generate</dt><dd>{action.generateReason || 'Tạo clip đầu tiên, clip còn thiếu hoặc clip đã cũ.'}</dd></div>
      <div id={`preview-help-${scene.id}`}><dt>Preview</dt><dd>{preview ? 'Chỉ phát clip đã lưu; chọn bản cũ trong lịch sử bên dưới.' : 'Chưa có clip thành công để xem.'}</dd></div>
      <div id={`regenerate-help-${scene.id}`}><dt>Regenerate</dt><dd>{action.regenerateReason || 'Tạo lại riêng cảnh đã lưu. Mọi bản cũ vẫn được giữ.'}</dd></div>
    </dl>

    {promptOpen && <div className="scene-prompt-editor" id={`scene-editor-${scene.id}`}>
      <div className="scene-prompt-heading"><label htmlFor={`prompt-${scene.id}`}>Chỉ dẫn riêng của cảnh {index + 1}</label><span className={`edit-state ${draft ? 'unsaved' : ''}`}>{draft ? 'Chưa lưu' : 'Đã lưu'}</span></div>
      <textarea ref={promptRef} id={`prompt-${scene.id}`} rows={7} maxLength={6000} value={draft?.prompt ?? scene.prompt} onChange={event => onEdit(scene, { prompt: event.target.value })} disabled={locked} />
      <div className="scene-duration-row"><div><label htmlFor={`duration-${scene.id}`}>Thời lượng</label><select id={`duration-${scene.id}`} value={draft?.durationSeconds ?? scene.durationSeconds} disabled={locked || project.identity.referenceCount > 0} onChange={event => onEdit(scene, { durationSeconds: Number(event.target.value) })}>{[4, 6, 8].map(value => <option value={value} key={value}>{value} giây</option>)}</select></div><span className="field-help">{(draft?.prompt ?? scene.prompt).length}/6000 ký tự{project.identity.referenceCount > 0 && ' · 8 giây khi có ảnh tham chiếu'}</span></div>
      <div className="scene-save-actions"><button type="button" className="button secondary" disabled={!draft || !draft.prompt.trim() || locked || !!busy || conflict} onClick={() => onSave(scene)}><Icon name={busy === `${scene.id}:save` ? 'loader' : 'save'} className={busy === `${scene.id}:save` ? 'spin' : ''} size={16} />Lưu cảnh {index + 1}</button>{draft && <button type="button" className="text-button" disabled={!!busy} onClick={() => onDiscard(scene, index)}>Bỏ bản sửa cảnh này</button>}<span className="field-help">Lưu chỉ cập nhật chỉ dẫn, chưa tạo video.</span></div>
      <details className="scene-effective-prompt" open><summary>Prompt hiệu lực · hồ sơ chung + chỉ dẫn đã lưu</summary><p className="field-help">{draft ? 'Đây là bản đã lưu. Lưu cảnh để cập nhật prompt hiệu lực; bản sửa phía trên chưa được dùng để tạo clip.' : 'Đây là nội dung đầy đủ được gửi để tạo clip của cảnh này.'}</p><label className="visually-hidden" htmlFor={`effective-${scene.id}`}>Prompt hiệu lực cảnh {index + 1}</label><textarea id={`effective-${scene.id}`} value={scene.effectivePrompt || ''} readOnly rows={9} /><button type="button" className="text-button" disabled={!scene.effectivePrompt} onClick={() => onCopy(scene.id, scene.effectivePrompt)}><Icon name={copied === scene.id ? 'check' : 'file'} size={15} />{copied === scene.id ? 'Đã sao chép' : 'Sao chép prompt đã lưu'}</button></details>
    </div>}
    {conflict && <div className="notice warning"><Icon name="warning" size={17} /><span>Cảnh có phiên bản mới trên máy chủ. Bản sửa của bạn vẫn được giữ.</span><button type="button" className="text-button" disabled={!!busy} onClick={() => onDiscard(scene, index)}>Nạp bản cảnh này</button></div>}
    {scene.error && <div className="notice error" role="alert"><Icon name="warning" size={17} /><span>{errorMessage(scene.error)}</span></div>}
    {(scene.stale || draft) && preview && <p className="scene-stale-note"><Icon name="info" size={14} />Clip đã lưu dùng chỉ dẫn trước đó. Lưu cảnh rồi bấm Generate hoặc Regenerate để cập nhật.</p>}
    {previewOpen && preview && <div className="scene-video"><div className="scene-preview-heading"><h3>Video Preview · Cảnh {index + 1}</h3><span className="field-help">{preview.legacy ? 'Clip đã lưu trước khi có lịch sử' : `Phiên bản ${preview.version} · ${formatDate(preview.completedAt || preview.createdAt)}`}</span></div><video ref={videoRef} key={preview.videoUrl} src={preview.videoUrl} controls preload="metadata" aria-label={`Clip cảnh ${index + 1}`} /><a className="text-button" href={preview.videoUrl} download><Icon name="arrowDown" size={15} />Tải clip đang xem</a></div>}

    <details className="scene-history"><summary><Icon name="history" size={16} />Lịch sử cảnh <span className="count-badge">{history.length}</span></summary><p className="field-help">Mỗi lần tạo giữ riêng clip, prompt và kết quả. Xem lại lịch sử không sửa bản nháp hiện tại.</p>
      {!history.length && <p className="field-help">Chưa có lần tạo được ghi trong lịch sử của cảnh này.</p>}
      <ol className="scene-history-list">{history.map(attempt => <li key={attempt.id} className={selectedPreview === attempt.id ? 'selected' : ''}><div className="scene-history-meta"><strong>Phiên bản {attempt.version}</strong><span className={`scene-status ${attempt.status}`}>{labels[attempt.status] || attempt.status}</span><time dateTime={attempt.createdAt}>{formatDate(attempt.createdAt)}</time><span>{attempt.durationSeconds} giây</span></div>{attempt.error && <p className="scene-history-error">{errorMessage(attempt.error)}</p>}<div className="scene-history-actions">{attempt.status === 'completed' && attempt.videoUrl && <button type="button" className="text-button" aria-pressed={selectedPreview === attempt.id} onClick={() => openPreview(attempt.id)}><Icon name="play" size={14} />{selectedPreview === attempt.id ? 'Đang chọn để xem' : 'Chọn bản xem'}</button>}<button type="button" className="text-button" aria-expanded={comparisonId === attempt.id} onClick={() => setComparisonId(comparisonId === attempt.id ? '' : attempt.id)}>Xem / so sánh prompt</button><button type="button" className="text-button" disabled={!attempt.effectivePrompt} onClick={() => onCopy(attempt.id, attempt.effectivePrompt)}><Icon name={copied === attempt.id ? 'check' : 'file'} size={14} />{copied === attempt.id ? 'Đã sao chép' : 'Sao chép prompt'}</button></div></li>)}</ol>
      {scene.legacyVideoUrl && <div className="scene-legacy-history"><p>Clip đã lưu trước khi có lịch sử</p><p className="field-help">Bản này không có thông tin prompt hoặc thời điểm tạo được ghi lại.</p><button type="button" className="text-button" aria-pressed={selectedPreview === 'legacy'} onClick={() => openPreview('legacy')}><Icon name="play" size={14} />Chọn clip đã lưu để xem</button></div>}
      {comparison && <div className="scene-prompt-comparison"><h3>So sánh prompt · Phiên bản {comparison.version}</h3><p className="field-help">Chỉ đọc. Dùng sao chép nếu bạn muốn tự áp dụng vào chỉ dẫn riêng.</p><div><label htmlFor={`history-prompt-${scene.id}`}>Prompt của lần tạo đã chọn</label><textarea id={`history-prompt-${scene.id}`} readOnly rows={7} value={comparison.effectivePrompt || comparison.prompt || ''} /></div><div><label htmlFor={`current-prompt-${scene.id}`}>Prompt hiệu lực hiện đã lưu</label><textarea id={`current-prompt-${scene.id}`} readOnly rows={7} value={scene.effectivePrompt || ''} /></div></div>}
    </details>
  </section>;
}
