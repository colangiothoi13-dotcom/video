'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icons';
import { formatDate, request, validateSource } from '../lib/client';
import { clearNarratedDraft, createNarratedWorkspace, narratedActions, narratedPreview, narratedSceneAction, narratedStatusLabels, narratedTime, newerNarratedProject, updateNarratedDraft } from '../lib/narrated-client.mjs';
import styles from './NarratedStudio.module.css';

const api = '/api/narrated';
const messageOf = error => typeof error === 'string' ? error : error?.message;
const labelOf = status => narratedStatusLabels[status] || status;

export default function NarratedStudio({ onNavigate, registerDirty }) {
  const [projects, setProjects] = useState([]); const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState(null); const [listError, setListError] = useState('');
  const [url, setUrl] = useState(''); const [aspectRatio, setAspectRatio] = useState('9:16');
  const [projectId, setProjectId] = useState(null); const [project, setProject] = useState(null);
  const [drafts, setDrafts] = useState({}); const draftsRef = useRef({});
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [connectionError, setConnectionError] = useState(''); const [message, setMessage] = useState('');
  const [previews, setPreviews] = useState({}); const [openPreviews, setOpenPreviews] = useState({});
  const alive = useRef(false); const selected = useRef(null); const listSequence = useRef(0);
  const workspace = useRef(null); if (!workspace.current) workspace.current = createNarratedWorkspace();
  const configured = Boolean(config?.configured && config?.videoConfigured);
  const actions = narratedActions(project, drafts, busy, configured);
  const dirty = actions.dirty || (!projectId && Boolean(url.trim() || aspectRatio !== '9:16'));

  const refreshProjects = useCallback(async () => {
    const ticket = ++listSequence.current;
    try {
      const data = await request(api);
      if (!alive.current || ticket !== listSequence.current) return;
      setConfig(data); setProjects(previous => (data.projects || []).map(next => newerNarratedProject(previous.find(item => item.id === next.id), next))); setListError('');
    } catch (cause) { if (alive.current && ticket === listSequence.current) setListError(cause.message); }
    finally { if (alive.current && ticket === listSequence.current) setLoading(false); }
  }, []);

  function receiveProject(next) {
    if (!alive.current || selected.current !== next.id) return;
    setProject(previous => newerNarratedProject(previous, next));
    setProjects(previous => [newerNarratedProject(previous.find(item => item.id === next.id), next), ...previous.filter(item => item.id !== next.id)]);
  }
  async function loadProject(id) {
    const ticket = workspace.current.read();
    try {
      const data = await request(`${api}/projects/${encodeURIComponent(id)}`);
      if (!alive.current || !workspace.current.accepts(ticket)) return;
      receiveProject(data.project); setConnectionError('');
    } catch (cause) { if (alive.current && workspace.current.accepts(ticket)) setConnectionError(cause.message); }
  }
  useEffect(() => {
    alive.current = true; let timer;
    const tick = async () => { if (!document.hidden) await refreshProjects(); if (alive.current) timer = setTimeout(tick, 15000); };
    tick();
    return () => { alive.current = false; ++listSequence.current; workspace.current.select(null); clearTimeout(timer); };
  }, [refreshProjects]);
  useEffect(() => {
    if (!projectId) return;
    let active = true; let timer;
    const tick = async () => { if (!document.hidden) await loadProject(projectId); if (active) timer = setTimeout(tick, 10000); };
    const resume = () => { if (!document.hidden) { loadProject(projectId); refreshProjects(); } };
    tick(); document.addEventListener('visibilitychange', resume);
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', resume); };
  }, [projectId, refreshProjects]);
  useEffect(() => { registerDirty?.(dirty); return () => registerDirty?.(false); }, [dirty, registerDirty]);
  useEffect(() => {
    const protect = event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);

  function setAllDrafts(next) { draftsRef.current = next; setDrafts(next); }
  function resetWorkspace(id = null) {
    workspace.current.select(id); selected.current = id; setProjectId(id); setProject(null); setAllDrafts({});
    setBusy(''); setUrl(''); setAspectRatio('9:16'); setPreviews({}); setOpenPreviews({}); setError(''); setConnectionError(''); setMessage('');
  }
  function selectProject(id) {
    if (id && id === selected.current) return;
    if (dirty && !window.confirm('Bỏ các chỉnh sửa chưa lưu để mở dự án khác? Dữ liệu đã lưu vẫn được giữ.')) return;
    resetWorkspace(id);
  }
  function begin(action) {
    const ticket = workspace.current.start(action); if (!ticket) return null;
    setBusy(action); setError(''); setMessage(''); return ticket;
  }
  const current = ticket => alive.current && workspace.current.current(ticket);
  function finish(ticket) { if (workspace.current.finish(ticket) && alive.current) setBusy(''); }

  async function create(event) {
    event.preventDefault();
    const validation = validateSource('url', null, url); if (validation) { setError(validation); return; }
    if (!configured) { setError('Thêm cấu hình AI và Google Veo trong Cài đặt trước khi tạo.'); return; }
    const ticket = begin('create'); if (!ticket) return;
    try {
      const data = await request(`${api}/projects`, { method: 'POST', body: { url: url.trim(), aspectRatio } });
      if (!current(ticket)) return;
      resetWorkspace(data.project.id); receiveProject(data.project); setMessage('Đã lưu dự án. Máy chủ sẽ tự tải nguồn, tạo cảnh và ghép video.'); refreshProjects();
    } catch (cause) { if (current(ticket)) setError(cause.message); }
    finally { finish(ticket); }
  }
  async function mutate(action, path, body, success, after) {
    const ticket = begin(action); if (!ticket) return;
    const id = selected.current; let conflict = false;
    try {
      const data = await request(`${api}/projects/${encodeURIComponent(id)}${path}`, { method: action.endsWith(':save') ? 'PUT' : 'POST', body });
      if (!current(ticket)) return;
      receiveProject(data.project); after?.(); setMessage(success); setConnectionError(''); refreshProjects();
    } catch (cause) {
      if (current(ticket)) { setError(cause.message); conflict = cause.status === 409; }
    } finally {
      const stillSelected = current(ticket); finish(ticket);
      if (stillSelected && conflict) loadProject(id);
    }
  }
  function saveScene(scene) {
    const draft = draftsRef.current[scene.id]; if (!draft?.prompt.trim()) return;
    mutate(`${scene.id}:save`, `/scenes/${encodeURIComponent(scene.id)}`, { version: draft.version, prompt: draft.prompt }, 'Đã lưu prompt. Clip chỉ được tạo khi bạn bấm Tạo clip.', () => setAllDrafts(clearNarratedDraft(draftsRef.current, scene.id, draft)));
  }
  async function deleteProject() {
    if (!actions.canDelete || !window.confirm('Xóa vĩnh viễn dự án này cùng video nguồn, clip và toàn bộ lịch sử?')) return;
    const ticket = begin('delete'); if (!ticket) return;
    try {
      await request(`${api}/projects/${encodeURIComponent(selected.current)}`, { method: 'DELETE' });
      if (!current(ticket)) return;
      const id = selected.current; resetWorkspace(); setProjects(previous => previous.filter(item => item.id !== id)); setMessage('Đã xóa dự án.'); refreshProjects();
    } catch (cause) { if (current(ticket)) setError(cause.message); }
    finally { finish(ticket); }
  }
  function discard(sceneId) { const next = { ...draftsRef.current }; delete next[sceneId]; setAllDrafts(next); }
  function preview(sceneId, attemptId) { setPreviews(previous => ({ ...previous, [sceneId]: attemptId || 'current' })); setOpenPreviews(previous => ({ ...previous, [sceneId]: true })); }

  return <div className={styles.root}>
    <header className={styles.intro}>
      <div><span className={styles.eyebrow}><Icon name="audio" size={16} />GIỌNG ĐỌC CỦA BẠN · HÌNH ẢNH MỚI</span><h1>Video từ <span>giọng gốc</span></h1><p>Giữ lời đọc và âm thanh nguồn. Để những thước phim mới kể tiếp câu chuyện.</p></div>
      <div className={styles.formatBadge}><Icon name="film" size={22} /><div><strong>Chuyển động tự nhiên</strong><span>720p · 24 fps · Âm thanh gốc</span></div></div>
    </header>
    {config && !configured && <div className={styles.notice} role="status"><Icon name="settings" size={19} /><div><strong>Cấu hình cho Video từ giọng gốc</strong><p>{!config.configured ? 'Cần cấu hình AI để nhận dạng lời đọc và lên cảnh. ' : ''}{!config.videoConfigured ? 'Cần khóa Google có quyền truy cập Veo để tạo clip.' : ''} Bạn vẫn có thể xem các dự án đã lưu.</p></div><button type="button" className={styles.textButton} onClick={() => onNavigate('settings')}>Mở Cài đặt <Icon name="chevron" size={15} /></button></div>}
    {listError && <div className={`${styles.notice} ${styles.error}`} role="alert"><Icon name="warning" size={18} /><span>Chưa tải được danh sách dự án. {listError}</span><button type="button" className={styles.textButton} onClick={refreshProjects}>Thử lại</button></div>}
    {error && <div className={`${styles.notice} ${styles.error}`} role="alert"><Icon name="warning" size={18} /><span>{error}</span><button type="button" className={styles.iconButton} aria-label="Đóng thông báo lỗi" onClick={() => setError('')}><Icon name="x" size={16} /></button></div>}
    {message && <div className={`${styles.notice} ${styles.success}`} role="status"><Icon name="checkCircle" size={18} /><span>{message}</span></div>}
    <div className={styles.workspace}>
      <aside className={styles.library} aria-label="Dự án Video từ giọng gốc">
        <div className={styles.libraryHeading}><div><span className={styles.eyebrow}>THƯ VIỆN CỦA BẠN</span><h2>Dự án đã lưu <span>{projects.length}</span></h2></div><button type="button" className={styles.iconButton} onClick={() => selectProject(null)} title="Tạo dự án mới" aria-label="Tạo dự án mới"><Icon name="plus" size={19} /></button></div>
        <button type="button" className={styles.newProject} onClick={() => selectProject(null)}><Icon name="plus" size={17} />Dự án mới</button>
        {loading ? <p className={styles.empty} role="status">Đang tải dự án…</p> : !projects.length ? <div className={styles.empty}><Icon name="file" size={27} /><strong>Câu chuyện đầu tiên</strong><p>Dán một liên kết để bắt đầu. Dự án và các bản clip sẽ được lưu trên máy.</p></div> : <ul className={styles.projectList}>{projects.map(item => <li key={item.id}><button type="button" className={`${styles.projectButton} ${item.id === projectId ? styles.selectedProject : ''}`} aria-current={item.id === projectId ? 'true' : undefined} onClick={() => selectProject(item.id)}><span className={styles.projectGlyph}><Icon name="film" size={17} /></span><span className={styles.projectInfo}><strong>{item.title || 'Dự án đang chuẩn bị'}</strong><small>{labelOf(item.status)} · {item.aspectRatio}</small><time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time></span><Icon name="chevron" size={14} /></button></li>)}</ul>}
        <div className={styles.libraryNote}><Icon name="shield" size={16} /><p>Lưu trên máy này.<br />Mở lại dự án để tiếp tục bất cứ lúc nào.</p></div>
      </aside>
      <div className={styles.content}>
        {!projectId ? <>
          <form onSubmit={create} className={styles.createPanel}>
            <div className={styles.panelHeading}><span className={styles.number}>01</span><div><h2>Bắt đầu từ một giọng đọc</h2><p>Dán liên kết video YouTube hoặc Facebook công khai.</p></div><Icon name="link" size={23} /></div>
            <label htmlFor="narrated-url">Liên kết video nguồn</label><div className={styles.urlInput}><Icon name="link" size={18} /><input id="narrated-url" type="url" required maxLength={2048} placeholder="https://www.youtube.com/watch?v=…" value={url} disabled={Boolean(busy)} onChange={event => setUrl(event.target.value)} aria-describedby="narrated-source-help" /></div>
            <p id="narrated-source-help" className={styles.help}>YouTube / Facebook · HTTPS công khai · Web tự đọc và xử lý toàn bộ thời lượng · Nguồn tối đa 5 GB</p>
            <fieldset className={styles.ratioField}><legend>Tỷ lệ video mới</legend><div className={styles.ratioOptions}>{[['9:16', 'Dọc', 'TikTok · Reels · Shorts'], ['16:9', 'Ngang', 'YouTube · Màn hình rộng']].map(([value, title, subtitle]) => <label key={value} className={`${styles.ratioOption} ${aspectRatio === value ? styles.selectedRatio : ''}`}><input type="radio" name="narrated-ratio" value={value} checked={aspectRatio === value} disabled={Boolean(busy)} onChange={() => setAspectRatio(value)} /><span className={value === '9:16' ? styles.portraitIcon : styles.landscapeIcon} /><span><strong>{title} <small>{value}</small></strong><span>{subtitle}</span></span>{aspectRatio === value && <Icon name="checkCircle" size={16} />}</label>)}</div></fieldset>
            <div className={styles.costHint}><Icon name="info" size={17} /><p>Nhận dạng, lên cảnh và tạo clip dùng khóa / hạn mức AI đã cấu hình. Tạo clip có thể phát sinh phí; video càng dài càng cần nhiều cảnh.</p></div>
            <button type="submit" className={`${styles.button} ${styles.primary} ${styles.fullWidth}`} disabled={!configured || Boolean(busy)}><Icon name={busy === 'create' ? 'loader' : 'sparkles'} className={busy === 'create' ? styles.spin : ''} size={18} />{busy === 'create' ? 'Đang lưu dự án…' : 'Tạo video từ giọng gốc'}<Icon name="arrowRight" size={17} /></button>
            <p className={styles.formNote}><Icon name="audio" size={14} />Giữ lời đọc, nhạc nền và hiệu ứng trong âm thanh nguồn.</p>
          </form>
          <div className={styles.storyboard} aria-label="Quy trình tạo video"><span className={styles.eyebrow}>TỪ LỜI ĐỌC ĐẾN THƯỚC PHIM</span><div className={styles.storyboardSteps}>{[['link', 'Tải nguồn', 'Lưu video gốc'], ['audio', 'Nghe lời đọc', 'Nhận dạng theo thời gian'], ['film', 'Tạo cảnh', 'Chuyển động chân thực'], ['play', 'Ghép video', 'Hình mới, âm thanh gốc']].map(([icon, title, subtitle], index) => <div key={title}><span><Icon name={icon} size={20} /><small>0{index + 1}</small></span><strong>{title}</strong><p>{subtitle}</p></div>)}</div><p className={styles.help}>Tự động xử lý sau khi tạo. Bạn có thể xem từng cảnh, sửa prompt và chủ động tạo lại.</p></div>
        </> : <>
          {connectionError && <div className={`${styles.notice} ${styles.error}`} role="alert"><Icon name="warning" size={18} /><span>Chưa cập nhật được dự án. {connectionError} Các bản sửa của bạn vẫn được giữ.</span><button type="button" className={styles.textButton} onClick={() => loadProject(projectId)}>Thử lại</button></div>}
          {!project ? <div className={styles.loading} role="status"><Icon name="loader" className={styles.spin} />Đang mở dự án…</div> : <>
            <section className={styles.projectHeader} aria-label="Thông tin dự án"><div className={styles.projectTitle}><span className={styles.eyebrow}>DỰ ÁN · {project.aspectRatio} · 720P</span><h2>{project.title || 'Đang chuẩn bị câu chuyện'}</h2><a href={project.sourceUrl} target="_blank" rel="noreferrer" className={styles.sourceLink}><Icon name="external" size={13} /><span>{project.sourceUrl}</span></a></div><button type="button" className={`${styles.iconButton} ${styles.deleteButton}`} disabled={!actions.canDelete} onClick={deleteProject} title={actions.canDelete ? 'Xóa dự án' : 'Đợi tác vụ đang chạy hoàn tất để xóa'} aria-label="Xóa dự án"><Icon name="trash" size={18} /></button><div className={styles.progressRow}><span className={`${styles.status} ${project.status === 'failed' ? styles.failedStatus : ''}`} role="status">{actions.running && <Icon name="loader" className={styles.spin} size={14} />}{labelOf(project.status)}</span><span><Icon name="clock" size={14} />{project.duration ? narratedTime(project.duration) : 'Đang kiểm tra thời lượng'}</span><span><Icon name="film" size={14} />{actions.completed}/{project.scenes?.length || 0} cảnh đúng phiên bản</span></div>{actions.running && <p className={styles.help}>Máy chủ tiếp tục xử lý khi bạn rời màn hình. Trạng thái tự cập nhật từ dự án đã lưu.</p>}
              {project.error && <div className={`${styles.notice} ${styles.error}`} role="alert"><Icon name="warning" size={18} /><span>{messageOf(project.error)}</span></div>}
              {project.status === 'failed' && <div className={styles.resumeRow}><div><strong>Tiếp tục khi bạn sẵn sàng</strong><p>Tái sử dụng các bước đã hoàn thành. Thử lại bước tạo clip bị lỗi có thể phát sinh phí.</p></div><button type="button" className={`${styles.button} ${styles.secondary}`} disabled={!actions.canResume} onClick={() => mutate('resume', '/resume', {}, 'Đã yêu cầu tiếp tục dự án.')}><Icon name="refresh" size={16} />Tiếp tục bước bị lỗi</button></div>}
            </section>
            <section className={styles.finalPanel} aria-label="Video hoàn chỉnh"><div className={styles.finalHeading}><div><span className={styles.eyebrow}>BẢN GHÉP HOÀN CHỈNH</span><h2>Hình ảnh mới. Giọng đọc nguyên bản.</h2></div><span className={styles.outputTag}>MP4 · {project.aspectRatio}</span></div>
              {project.assembly?.videoUrl ? <><video key={project.assembly.videoUrl} className={styles.finalVideo} src={project.assembly.videoUrl} controls playsInline preload="metadata" aria-label="Video hoàn chỉnh với âm thanh gốc" /><div className={styles.finalActions}><a className={`${styles.button} ${styles.primary}`} href={project.assembly.videoUrl} download><Icon name="arrowDown" size={17} />Tải MP4</a><span className={styles.help}>Âm thanh lấy từ video nguồn đã lưu.</span></div></> : <div className={styles.finalEmpty}><span><Icon name="play" size={26} /></span><strong>{project.status === 'assembling' ? 'Đang ghép những thước phim của bạn' : 'Video hoàn chỉnh sẽ xuất hiện tại đây'}</strong><p>{project.scenes?.length ? 'Xem các clip và theo dõi từng cảnh bên dưới.' : 'Nguồn sẽ được nhận dạng và chia cảnh theo lời đọc.'}</p></div>}
              {project.assembly?.stale && <div className={styles.staleNote}><Icon name="info" size={17} /><span>Bản ghép này dùng các cảnh trước đó. Tạo đủ clip đúng phiên bản rồi ghép lại để cập nhật.</span></div>}
              {project.assembly?.error && <p className={styles.inlineError} role="alert">{messageOf(project.assembly.error)}</p>}
              <div className={styles.renderRow}><button type="button" className={`${styles.button} ${styles.secondary}`} disabled={!actions.canRender} title={actions.renderReason} onClick={() => mutate('render', '/render', {}, 'Đã yêu cầu ghép video từ các clip hiện tại.')}><Icon name={busy === 'render' || project.status === 'assembling' ? 'loader' : 'film'} className={busy === 'render' || project.status === 'assembling' ? styles.spin : ''} size={16} />{project.assembly?.videoUrl ? 'Ghép lại video' : 'Ghép video'}</button><p className={styles.help}>{actions.renderReason || 'Chỉ ghép các clip đã có; không gửi yêu cầu tạo clip.'}</p></div>
            </section>
            {Boolean(project.scenes?.length) && <div className={styles.scenesHeading}><div><span className={styles.eyebrow}>TIMELINE THEO LỜI ĐỌC</span><h2>{project.scenes.length} cảnh trong câu chuyện</h2></div><span>Thời gian cố định · Sửa hình ảnh riêng từng cảnh</span></div>}
            {(project.scenes || []).map((scene, index) => {
              const draft = drafts[scene.id]; const conflict = Boolean(draft && draft.version !== scene.version);
              const sceneAction = narratedSceneAction(scene, { dirty: Boolean(draft), busy: Boolean(busy || actions.running), configured: Boolean(config?.videoConfigured) });
              const selectedPreview = narratedPreview(scene, previews[scene.id]); const saving = busy === `${scene.id}:save`;
              return <section key={scene.id} className={`${styles.sceneCard} ${draft ? styles.dirtyCard : ''}`} aria-label={`Cảnh ${index + 1}: ${scene.title || ''}`}><div className={styles.sceneHeading}><span className={styles.number}>{String(index + 1).padStart(2, '0')}</span><div><h3>{scene.title || `Cảnh ${index + 1}`}</h3><span>{narratedTime(scene.start)} — {narratedTime(scene.end)} · v{scene.version}</span></div><span className={`${styles.status} ${scene.status === 'failed' ? styles.failedStatus : ''}`}>{labelOf(scene.status)}</span></div>
                <div className={styles.transcript}><span>LỜI ĐỌC GỐC</span><p>{scene.transcriptText || 'Khoảng lặng trong âm thanh nguồn.'}</p></div>{scene.visual && <p className={styles.visualDescription}>{scene.visual}</p>}
                <details className={styles.promptEditor}><summary>Prompt hình ảnh <span className={draft ? styles.unsavedLabel : styles.savedLabel}>{draft ? 'Chưa lưu' : 'Đã lưu'}</span></summary><label htmlFor={`narrated-prompt-${scene.id}`}>Chỉ dẫn riêng · Cảnh {index + 1}</label><textarea id={`narrated-prompt-${scene.id}`} rows={6} maxLength={6000} value={draft?.prompt ?? scene.prompt ?? ''} disabled={Boolean(busy || actions.running)} onChange={event => { setAllDrafts(updateNarratedDraft(scene, draftsRef.current, event.target.value)); setMessage(''); }} /><div className={styles.promptActions}><button type="button" className={`${styles.button} ${styles.secondary}`} disabled={!draft || !draft.prompt.trim() || conflict || Boolean(busy || actions.running)} onClick={() => saveScene(scene)}><Icon name={saving ? 'loader' : 'save'} className={saving ? styles.spin : ''} size={15} />Lưu prompt</button>{draft && <button type="button" className={styles.textButton} disabled={Boolean(busy)} onClick={() => discard(scene.id)}>Bỏ bản sửa</button>}<span className={styles.help}>Lưu prompt không tự tạo clip.</span></div></details>
                {conflict && <div className={styles.staleNote}><Icon name="warning" size={17} /><span>Cảnh đã có phiên bản mới. Bản sửa của bạn vẫn được giữ; bỏ bản sửa để nạp prompt mới.</span></div>}
                {scene.error && <p className={styles.inlineError} role="alert">{messageOf(scene.error)}</p>}
                {scene.stale && <p className={styles.staleNote}><Icon name="info" size={15} />Clip cũ vẫn xem được. Tạo lại để dùng prompt hiện tại.</p>}
                <div className={styles.sceneActions}><button type="button" className={`${styles.button} ${styles.primary}`} disabled={!sceneAction.canGenerate} title={sceneAction.reason || 'Dùng prompt đã lưu để tạo clip. Có thể phát sinh phí.'} onClick={() => mutate(`${scene.id}:generate`, `/scenes/${encodeURIComponent(scene.id)}/generate`, { version: scene.version }, `Đã yêu cầu tạo clip cảnh ${index + 1}.`)}><Icon name="sparkles" size={16} />{scene.videoUrl || scene.history?.length ? 'Tạo lại cảnh' : 'Tạo clip'}</button><button type="button" className={`${styles.button} ${styles.secondary}`} disabled={!selectedPreview} aria-expanded={Boolean(openPreviews[scene.id])} onClick={() => preview(scene.id, previews[scene.id])}><Icon name="play" size={16} />Xem clip</button><span className={styles.help}>{sceneAction.reason || 'Tạo riêng cảnh này · Dùng hạn mức Veo'}</span></div>
                {openPreviews[scene.id] && selectedPreview && <div className={styles.clipPreview}><video key={selectedPreview.videoUrl} src={selectedPreview.videoUrl} controls playsInline preload="metadata" aria-label={`Clip cảnh ${index + 1}`} /><div><span>{selectedPreview.id === 'current' ? 'Clip hiện tại' : `Bản lịch sử · v${selectedPreview.version}`}</span><a className={styles.textButton} href={selectedPreview.videoUrl} download><Icon name="arrowDown" size={14} />Tải clip</a></div><p className={styles.help}>Âm thanh của clip không được dùng trong bản ghép; bản ghép giữ âm thanh nguồn.</p></div>}
                <details className={styles.history}><summary><Icon name="history" size={15} />Lịch sử tạo <span>{scene.history?.length || 0}</span></summary>{!scene.history?.length ? <p className={styles.help}>Chưa có lần tạo được lưu.</p> : <ol>{scene.history.map(attempt => <li key={attempt.id}><div className={styles.historyMeta}><strong>v{attempt.version}</strong><span>{labelOf(attempt.status)}</span><time dateTime={attempt.createdAt || attempt.time}>{formatDate(attempt.createdAt || attempt.time)}</time>{attempt.model && <small>{attempt.model}</small>}</div><details><summary>Prompt của lần tạo</summary><pre>{attempt.effectivePrompt || attempt.prompt}</pre></details>{attempt.status === 'completed' && attempt.videoUrl && <button type="button" className={styles.textButton} onClick={() => preview(scene.id, attempt.id)}><Icon name="play" size={14} />{previews[scene.id] === attempt.id ? 'Đang chọn bản này' : 'Xem bản này'}</button>}{attempt.error && <p className={styles.inlineError}>{messageOf(attempt.error)}</p>}</li>)}</ol>}</details>
              </section>;
            })}
          </>}
        </>}
      </div>
    </div>
  </div>;
}
