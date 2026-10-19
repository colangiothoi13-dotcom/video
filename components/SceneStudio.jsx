'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icons';
import SceneCard from './SceneCard';
import { createSceneWorkspaceController, formatDate, newerSceneProject, request, sceneActionState, sceneBriefDirty, sceneGenerationState, sceneWorkflow, updateSceneDraft } from '../lib/client';

const api = '/api/studio';
const assemblyLabels = { idle: 'Chưa ghép video', rendering: 'Đang ghép video', completed: 'Đã ghép video', failed: 'Ghép chưa thành công' };
const errorMessage = error => typeof error === 'string' ? error : error?.message;
const emptyBrief = { idea: '', character: '', product: '', style: 'cinematic', aspectRatio: '9:16' };
const exampleBrief = {
  idea: 'Video cô gái giới thiệu thời trang trong quán cafe hiện đại',
  character: 'Một phụ nữ Việt Nam trưởng thành, 25 tuổi, tóc đen dài ngang vai uốn nhẹ, gương mặt tự nhiên và phong thái tự tin. Luôn mặc blazer linen màu kem với hai nút nâu, áo thun trắng cổ tròn, quần âu be ống suông và giày bệt nâu; đeo khuyên tai tròn nhỏ màu vàng. Giữ nguyên nhân vật, tóc và trang phục qua cả 5 cảnh.',
  product: 'Bộ trang phục thời trang nữ gồm blazer linen màu kem hai nút nâu, áo thun trắng cổ tròn và quần âu be ống suông. Sản phẩm chính là blazer: ve áo chữ V, hai túi nắp phía trước, chất vải linen có vân tự nhiên, phom hơi rộng. Giữ đúng màu kem, nút nâu, chất liệu và chi tiết ở mọi cảnh.',
  style: 'Cinematic fashion film trong quán café hiện đại: cửa kính lớn, nội thất gỗ sáng và bê tông màu trung tính, ánh sáng cửa sổ mềm buổi sáng, tông kem ấm, chuyển động máy mượt, cận chi tiết vải xen góc trung nhân vật; không chữ phủ lên hình.',
  aspectRatio: '9:16',
};

export default function SceneStudio({ onNavigate, registerDirty }) {
  const [projects, setProjects] = useState([]); const [listLoading, setListLoading] = useState(true);
  const [configured, setConfigured] = useState(null); const [videoConfigured, setVideoConfigured] = useState(null); const [provider, setProvider] = useState(''); const [videoModel, setVideoModel] = useState('');
  const [brief, setBrief] = useState(emptyBrief); const [references, setReferences] = useState({});
  const [projectId, setProjectId] = useState(null); const [project, setProject] = useState(null);
  const [drafts, setDrafts] = useState({}); const draftsRef = useRef({});
  const [busy, setBusy] = useState(''); const busyRef = useRef('');
  const workspace = useRef(null);
  if (!workspace.current) workspace.current = createSceneWorkspaceController();
  const [error, setError] = useState(''); const [connectionError, setConnectionError] = useState(''); const [listError, setListError] = useState('');
  const [message, setMessage] = useState(''); const [copied, setCopied] = useState('');
  const [selectedPreviews, setSelectedPreviews] = useState({});
  const [phase, setPhase] = useState(0);
  const [referenceReading, setReferenceReading] = useState({});
  const alive = useRef(true); const selectedRef = useRef(null); const sequence = useRef(0); const referenceSequence = useRef({});
  const referencePending = useRef({});
  const generation = sceneGenerationState(project, drafts);
  const workflow = sceneWorkflow(project, drafts, busy, phase);
  const dirty = generation.dirty || (!projectId && (sceneBriefDirty(brief, references) || Object.values(referenceReading).some(Boolean)));
  const providerName = provider === 'openai' ? 'OpenAI' : provider === 'gemini' ? 'Google Gemini' : 'nhà cung cấp AI đã chọn';

  const refreshProjects = useCallback(async ({ listOnly = false } = {}) => {
    try {
      const data = await request(api);
      if (!alive.current) return;
      setProjects(data.projects || []);
      if (!listOnly) { setConfigured(Boolean(data.configured)); setVideoConfigured(Boolean(data.videoConfigured)); setProvider(data.provider || ''); setVideoModel(data.videoModel || ''); setListError(''); }
    } catch (e) { if (alive.current && !listOnly) setListError(e.message); }
    finally { if (alive.current && !listOnly) setListLoading(false); }
  }, []);

  function receiveProject(next) {
    if (!alive.current || selectedRef.current !== next.id) return;
    setProject(previous => newerSceneProject(previous, next));
    setProjects(previous => [newerSceneProject(previous.find(item => item.id === next.id), next), ...previous.filter(item => item.id !== next.id)]);
  }
  async function loadProject(id) {
    const ticket = ++sequence.current;
    try {
      const data = await request(`${api}/projects/${encodeURIComponent(id)}`);
      if (!alive.current || selectedRef.current !== id || ticket !== sequence.current) return;
      receiveProject(data.project); setConnectionError('');
    } catch (e) {
      if (alive.current && selectedRef.current === id && ticket === sequence.current) setConnectionError(e.message);
    }
  }
  useEffect(() => {
    alive.current = true; refreshProjects();
    return () => { alive.current = false; ++sequence.current; workspace.current.reset(); };
  }, [refreshProjects]);
  useEffect(() => {
    if (!projectId) return;
    let active = true; let timer;
    const tick = async () => {
      if (!document.hidden) await loadProject(projectId);
      if (active) timer = setTimeout(tick, 10000);
    };
    tick();
    const resume = () => { if (!document.hidden) { loadProject(projectId); refreshProjects(); } };
    document.addEventListener('visibilitychange', resume);
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', resume); };
  }, [projectId, refreshProjects]);
  useEffect(() => { registerDirty(dirty); return () => registerDirty(false); }, [dirty, registerDirty]);
  useEffect(() => {
    const protect = event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);

  function setAllDrafts(next) { draftsRef.current = next; setDrafts(next); }
  function clearWorkspace(id = null) {
    workspace.current.reset(); busyRef.current = ''; setBusy('');
    ++sequence.current;
    for (const kind of ['character', 'product']) referenceSequence.current[kind] = (referenceSequence.current[kind] || 0) + 1;
    referencePending.current = {}; setReferenceReading({});
    selectedRef.current = id; setProjectId(id); setProject(null); setAllDrafts({}); setPhase(id ? 2 : 0);
    setBrief({ ...emptyBrief }); setReferences({}); setSelectedPreviews({}); setCopied('');
    setError(''); setConnectionError(''); setMessage('');
  }
  function resetProject() {
    if (dirty && !window.confirm('Bỏ các chỉnh sửa chưa lưu và mở biểu mẫu ý tưởng trống? Dự án đã lưu và toàn bộ lịch sử clip vẫn được giữ.')) return;
    clearWorkspace();
    setMessage('Đã mở ý tưởng trống. Dự án đã lưu và toàn bộ lịch sử clip vẫn có trong danh sách dự án.');
    refreshProjects();
  }
  function selectProject(id) {
    if (busyRef.current || id === selectedRef.current) return;
    if (!id) { resetProject(); return; }
    if (dirty && !window.confirm('Bỏ các chỉnh sửa chưa lưu và mở dự án khác? Dữ liệu đã lưu vẫn được giữ.')) return;
    clearWorkspace(id);
  }
  function start(action) { const ticket = workspace.current.start(action); if (!ticket) return null; busyRef.current = action; setBusy(action); setError(''); setMessage(''); return ticket; }
  function isCurrent(ticket) { return alive.current && workspace.current.isCurrent(ticket); }
  function finish(ticket) { if (workspace.current.finish(ticket)) { busyRef.current = ''; if (alive.current) setBusy(''); } }
  function editScene(scene, patch) { setAllDrafts(updateSceneDraft(scene, draftsRef.current, patch)); setPhase(3); setMessage(''); }
  function removeReference(kind) {
    referenceSequence.current[kind] = (referenceSequence.current[kind] || 0) + 1;
    referencePending.current[kind] = false; setReferenceReading(previous => ({ ...previous, [kind]: false }));
    setReferences(previous => { const next = { ...previous }; delete next[kind]; return next; });
  }

  async function chooseReference(kind, file) {
    const ticket = (referenceSequence.current[kind] || 0) + 1; referenceSequence.current[kind] = ticket;
    if (!file) return;
    referencePending.current[kind] = false; setReferenceReading(previous => ({ ...previous, [kind]: false }));
    if (!['image/png', 'image/jpeg'].includes(file.type) || !file.size || file.size > 256 * 1024) { setError('Ảnh tham chiếu cần là PNG hoặc JPEG, tối đa 256 KiB mỗi ảnh.'); return; }
    referencePending.current[kind] = true; setReferenceReading(previous => ({ ...previous, [kind]: true }));
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Chưa đọc được ảnh. Hãy chọn lại tệp.')); reader.readAsDataURL(file);
      });
      if (alive.current && referenceSequence.current[kind] === ticket) {
        setReferences(previous => ({ ...previous, [kind]: { kind, name: file.name, mimeType: file.type, data: String(dataUrl).split(',')[1] } })); setError('');
      }
    } catch (e) { if (alive.current && referenceSequence.current[kind] === ticket) setError(e.message); }
    finally { if (alive.current && referenceSequence.current[kind] === ticket) { referencePending.current[kind] = false; setReferenceReading(previous => ({ ...previous, [kind]: false })); } }
  }
  async function create(event) {
    event.preventDefault();
    if (Object.values(referencePending.current).some(Boolean)) { setError('Đợi ảnh tham chiếu đọc xong trước khi tạo kịch bản.'); return; }
    if (![brief.idea, brief.character, brief.product].every(value => value.trim())) { setError('Nhập ý tưởng, mô tả nhân vật và sản phẩm trước khi tạo kịch bản.'); return; }
    const ticket = start('create'); if (!ticket) return;
    setPhase(1);
    try {
      const data = await request(`${api}/projects`, { method: 'POST', body: { ...brief, idea: brief.idea.trim(), character: brief.character.trim(), product: brief.product.trim(), style: brief.style.trim() || 'cinematic', references: Object.values(references).map(({ kind, mimeType, data }) => ({ kind, mimeType, data })) } });
      if (!isCurrent(ticket)) { if (alive.current) refreshProjects({ listOnly: true }); return; }
      ++sequence.current; selectedRef.current = data.project.id; setProjectId(data.project.id); setPhase(2); setBrief({ ...emptyBrief }); setReferences({}); setSelectedPreviews({}); setAllDrafts({}); receiveProject(data.project); setMessage('Đã lưu hồ sơ chung và kịch bản 5 cảnh. Xem lại từng prompt trước khi tạo clip.'); refreshProjects();
    } catch (e) { if (isCurrent(ticket)) { setError(e.message); setPhase(0); } }
    finally { finish(ticket); }
  }
  async function saveScene(scene) {
    const draft = draftsRef.current[scene.id];
    if (!draft || !draft.prompt.trim()) return;
    const ticket = start(`${scene.id}:save`); if (!ticket) return;
    try {
      const data = await request(`${api}/projects/${encodeURIComponent(project.id)}/scenes/${encodeURIComponent(scene.id)}`, { method: 'PUT', body: { version: draft.version, prompt: draft.prompt, durationSeconds: draft.durationSeconds } });
      if (!isCurrent(ticket)) { if (alive.current) refreshProjects({ listOnly: true }); return; }
      ++sequence.current; receiveProject(data.project);
      const next = { ...draftsRef.current }; if (next[scene.id] === draft) delete next[scene.id]; setAllDrafts(next);
      setMessage(`Đã lưu cảnh ${project.scenes.findIndex(item => item.id === scene.id) + 1}. Các cảnh khác giữ nguyên nội dung.`);
    } catch (e) { if (isCurrent(ticket)) setError(e.status === 409 ? 'Cảnh đã thay đổi ở một phiên khác. Bản sửa của bạn được giữ; sao chép nội dung cần dùng trước khi nạp bản đã lưu của cảnh này.' : e.message); }
    finally { finish(ticket); }
  }
  async function generate(kind, scene) {
    if (scene ? draftsRef.current[scene.id] : Object.keys(draftsRef.current).length) { setError('Lưu các chỉnh sửa cần dùng trước khi tạo video.'); return; }
    if (kind !== 'render' && videoConfigured !== true) { setError('Thêm khóa Google có quyền truy cập Veo trong Cài đặt để tạo clip.'); return; }
    if (scene) {
      const eligibility = sceneActionState(scene, { dirty: Boolean(draftsRef.current[scene.id]), busy: Boolean(busyRef.current), configured: videoConfigured === true, locked: project.assembly.status === 'rendering' });
      const reason = kind === 'regenerate' ? eligibility.regenerateReason : eligibility.generateReason;
      if (reason) { setError(reason); return; }
    }
    const ticket = start(scene ? `${scene.id}:${kind === 'regenerate' ? 'regenerate' : 'generate'}` : kind); if (!ticket) return;
    try {
      const route = scene ? `scenes/${encodeURIComponent(scene.id)}/generate` : kind === 'render' ? 'render' : 'generate-all';
      const body = scene ? { version: scene.version } : kind === 'video' ? { render: true } : {};
      const data = await request(`${api}/projects/${encodeURIComponent(project.id)}/${route}`, { method: 'POST', body });
      if (!isCurrent(ticket)) { if (alive.current) refreshProjects({ listOnly: true }); return; }
      ++sequence.current; receiveProject(data.project); setMessage(kind === 'render' ? 'Đã gửi yêu cầu ghép các clip đã lưu.' : kind === 'video' ? 'Đã gửi yêu cầu tạo các cảnh còn thiếu và ghép video theo thứ tự.' : kind === 'regenerate' ? 'Đã gửi yêu cầu tạo lại riêng cảnh theo prompt đã lưu. Các clip trước vẫn được giữ trong lịch sử.' : 'Đã gửi yêu cầu tạo clip. Trạng thái từng cảnh sẽ được cập nhật tự động.');
    } catch (e) { if (isCurrent(ticket)) setError(e.message); }
    finally { finish(ticket); }
  }
  async function deleteProject() {
    if (!window.confirm('Xóa dự án và các clip đã tạo trên máy này? Thao tác này không thể hoàn tác.')) return;
    const ticket = start('delete'); if (!ticket) return;
    try {
      await request(`${api}/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
      if (!isCurrent(ticket)) { if (alive.current) refreshProjects({ listOnly: true }); return; }
      clearWorkspace(); setMessage('Đã xóa dự án.'); refreshProjects();
    } catch (e) { if (isCurrent(ticket)) setError(e.message); }
    finally { finish(ticket); }
  }
  async function copyPrompt(id, prompt) {
    try { await navigator.clipboard.writeText(prompt); setCopied(id); setMessage('Đã sao chép prompt hiệu lực đã lưu.'); }
    catch { setError('Chưa sao chép được. Bạn có thể chọn nội dung trong ô prompt hiệu lực và sao chép thủ công.'); }
  }
  function discardScene(scene, index) {
    if (draftsRef.current[scene.id] && window.confirm(`Nạp bản đã lưu của cảnh ${index + 1} và bỏ riêng bản sửa của cảnh này?`)) { const next = { ...draftsRef.current }; delete next[scene.id]; setAllDrafts(next); }
  }

  return <>
    <div className="standard-intro scene-intro"><div className="eyebrow">TÍNH NĂNG MỞ RỘNG · TỪ Ý TƯỞNG ĐẾN TỪNG KHUNG HÌNH</div><div className="row-heading"><div><h1>Video từ ý tưởng</h1><p>Lên kịch bản sản phẩm 5 cảnh, giữ hồ sơ chung và tinh chỉnh từng cảnh.</p></div><div className="scene-reset"><button type="button" className="button secondary" onClick={resetProject}><Icon name="plus" size={17} />Reset Project · Ý tưởng mới</button><span className="field-help">Mở biểu mẫu trống; giữ dự án đã lưu và mọi lịch sử clip. Tác vụ đã gửi vẫn tiếp tục xử lý.</span></div></div></div>
    <nav className="scene-flow" aria-label="Quy trình tạo video"><ol>{['Ý tưởng', 'Kịch bản', 'Danh sách Scene', 'Prompt', 'Video Preview'].map((label, index) => <li key={label} className={workflow.steps[index].state} data-ready={workflow.steps[index].ready} aria-current={index === workflow.current ? 'step' : undefined} title={index === 4 && workflow.previewStale ? 'Có clip đã lưu; kết quả chưa phản ánh đầy đủ nội dung hiện tại.' : workflow.steps[index].ready ? 'Nội dung đã sẵn sàng' : 'Chưa hoàn tất'}><span>{workflow.steps[index].state === 'done' ? <Icon name="check" size={13} /> : String(index + 1).padStart(2, '0')}</span>{label}{index === 4 && workflow.previewStale && <small>Cần cập nhật</small>}{index < 4 && <Icon name="arrowRight" size={15} />}</li>)}</ol></nav>
    {configured === false && <div className="notice warning"><Icon name="info" /><span>Thêm khóa {providerName} trong Cài đặt để tạo kịch bản.</span><button className="text-button" onClick={() => onNavigate('settings')}>Mở cài đặt <Icon name="arrowRight" size={16} /></button></div>}
    {configured === true && videoConfigured === false && <div className="notice warning"><Icon name="info" /><span>Bạn có thể viết kịch bản bằng {providerName}. Thêm khóa Google có quyền truy cập Veo khi muốn tạo clip.</span><button className="text-button" onClick={() => onNavigate('settings')}>Mở cài đặt <Icon name="arrowRight" size={16} /></button></div>}
    {listError && <div className="notice error" role="alert"><Icon name="warning" /><span>{listError}</span><button className="text-button" onClick={refreshProjects}>Thử tải lại</button></div>}
    {connectionError && <div className="notice error" role="alert"><Icon name="warning" /><span>{connectionError} Bản sửa trên màn hình vẫn được giữ.</span><button className="text-button" onClick={() => loadProject(projectId)}>Kết nối lại</button></div>}
    {error && <div className="notice error" role="alert"><Icon name="warning" /><span>{error}</span></div>}
    {message && <div className="notice success" role="status"><Icon name="checkCircle" /><span>{message}</span></div>}
    <div className="scene-workspace">
      <aside className="panel scene-project-list" aria-label="Dự án video từ ý tưởng"><div className="row-heading"><h2>Dự án đã lưu <span className="count-badge">{projects.length}</span></h2><button className="icon-button" aria-label="Làm mới dự án" onClick={refreshProjects}><Icon name="refresh" size={16} /></button></div>{listLoading ? <p className="field-help">Đang tải dự án…</p> : projects.length ? <div className="scene-project-items">{projects.map(item => <button key={item.id} className={`scene-project-item ${projectId === item.id ? 'selected' : ''}`} aria-pressed={projectId === item.id} disabled={!!busy} onClick={() => selectProject(item.id)}><Icon name="film" size={18} /><span><strong>{item.title || 'Video sản phẩm'}</strong><small>{formatDate(item.updatedAt || item.createdAt)}</small></span><Icon name="chevron" size={14} /></button>)}</div> : <p className="field-help">Kịch bản và clip của bạn sẽ được lưu tại đây để mở lại.</p>}<p className="scene-storage-note"><Icon name="shield" size={14} />Dự án được giữ trên máy đến khi bạn xóa.</p></aside>
      <div className="scene-main">
        {!projectId && <form className="panel scene-brief" onSubmit={create}>
          <div className="section-heading"><span className="step-number">01</span><div><h2>Kể ý tưởng của bạn</h2><p>Mô tả cụ thể giúp năm cảnh có chung nhân vật và sản phẩm.</p></div></div>
          <div className="scene-example"><div><strong>Ví dụ: Thời trang trong quán café</strong><p>“Video cô gái giới thiệu thời trang trong quán cafe hiện đại”</p><span>Chỉ điền biểu mẫu; chưa tạo kịch bản hoặc clip.</span></div><button className="button secondary" type="button" disabled={!!busy} onClick={() => { setBrief({ ...exampleBrief }); setError(''); setMessage('Đã điền ví dụ. Bạn có thể sửa nội dung trước khi tạo kịch bản.'); }}><Icon name="file" size={16} />Điền ví dụ</button></div>
          <label htmlFor="scene-idea">Ý tưởng video</label><textarea id="scene-idea" rows={3} maxLength={4000} required placeholder="Ví dụ: Video cô gái giới thiệu thời trang trong quán cafe hiện đại…" value={brief.idea} onChange={event => setBrief({ ...brief, idea: event.target.value })} disabled={!!busy} />
          <div className="scene-brief-pair"><div><label htmlFor="scene-character">Nhân vật xuyên suốt</label><textarea id="scene-character" rows={4} maxLength={3000} required placeholder="Ngoại hình, trang phục, tóc, phụ kiện và những đặc điểm cần giữ qua mọi cảnh." value={brief.character} onChange={event => setBrief({ ...brief, character: event.target.value })} disabled={!!busy} /></div><div><label htmlFor="scene-product">Sản phẩm xuyên suốt</label><textarea id="scene-product" rows={4} maxLength={3000} required placeholder="Tên, hình dáng, kích thước, màu sắc, chất liệu, nhãn và chi tiết nhận diện." value={brief.product} onChange={event => setBrief({ ...brief, product: event.target.value })} disabled={!!busy} /></div></div>
          <div className="scene-brief-pair"><div><label htmlFor="scene-style">Phong cách hình ảnh</label><input id="scene-style" maxLength={1000} value={brief.style} onChange={event => setBrief({ ...brief, style: event.target.value })} placeholder="cinematic" disabled={!!busy} /></div><div><label htmlFor="scene-ratio">Tỉ lệ khung hình</label><select id="scene-ratio" value={brief.aspectRatio} onChange={event => setBrief({ ...brief, aspectRatio: event.target.value })} disabled={!!busy}><option value="9:16">9:16 · Video dọc</option><option value="16:9">16:9 · Video ngang</option></select></div></div>
          <fieldset className="scene-reference-fields"><legend>Ảnh tham chiếu <span>không bắt buộc</span></legend><p className="field-help">PNG hoặc JPEG, tối đa 256 KiB mỗi ảnh. Có ảnh tham chiếu: mỗi cảnh dài 8 giây.</p><div className="scene-brief-pair">{[['character', 'Ảnh nhân vật'], ['product', 'Ảnh sản phẩm']].map(([kind, label]) => <div className="scene-reference" key={kind}><label htmlFor={`reference-${kind}`}>{label}</label><input id={`reference-${kind}`} type="file" accept="image/png,image/jpeg" disabled={!!busy} onChange={event => { chooseReference(kind, event.target.files?.[0]); event.target.value = ''; }} />{referenceReading[kind] && <p className="field-help" role="status">Đang đọc ảnh…</p>}{references[kind] && <div className="scene-reference-selected"><img alt={`${label} đã chọn`} src={`data:${references[kind].mimeType};base64,${references[kind].data}`} /><span>{references[kind].name}</span><button className="icon-button" type="button" aria-label={`Bỏ ${label.toLowerCase()}`} disabled={!!busy} onClick={() => removeReference(kind)}><Icon name="x" size={16} /></button></div>}</div>)}</div></fieldset>
          <p className="field-help">Hồ sơ chung được khóa khi lưu kịch bản. Bạn có thể sửa chỉ dẫn từng cảnh hoặc tạo dự án mới với hồ sơ khác. Kết quả hình ảnh cần được xem lại để kiểm tra mức độ giống nhân vật và sản phẩm.</p>
          <button className="button primary scene-create-button" type="submit" disabled={!!busy || configured !== true || Object.values(referenceReading).some(Boolean)}><Icon name={busy === 'create' ? 'loader' : 'sparkles'} className={busy === 'create' ? 'spin' : ''} size={18} />{busy === 'create' ? 'Đang viết kịch bản…' : 'Tạo kịch bản 5 cảnh'}</button>
        </form>}
        {projectId && !project && <div className="panel loading-panel">{connectionError ? <p>Chưa mở được dự án. Hãy kết nối lại để tiếp tục.</p> : <><Icon name="loader" className="spin" /><p>Đang mở kịch bản…</p></>}</div>}
        {project && <>
          <section className="panel scene-identity" aria-label="Hồ sơ chung đã khóa"><div className="row-heading"><div><div className="eyebrow">HỒ SƠ CHUNG ĐÃ KHÓA</div><h2>{project.title}</h2></div><span className="scene-identity-tag"><Icon name="shield" size={14} />Dùng cho cả 5 cảnh</span></div><p className="scene-project-idea">{project.idea}</p><dl><div><dt>Nhân vật</dt><dd>{project.identity.character}</dd></div><div><dt>Sản phẩm</dt><dd>{project.identity.product}</dd></div><div><dt>Phong cách</dt><dd>{project.identity.style}</dd></div><div><dt>Khung hình · Tham chiếu</dt><dd>{project.identity.aspectRatio} · {project.identity.referenceCount || 0} ảnh{project.identity.referenceCount > 0 && ' · 8 giây/cảnh'}</dd></div></dl><p className="field-help">Mỗi prompt hiệu lực tự chứa hồ sơ này. Để thay hồ sơ, hãy tạo một dự án mới. Ảnh tham chiếu hỗ trợ nhận diện; xem lại từng clip trước khi dùng.</p></section>
          <section className="panel scene-generation-bar" aria-label="Tạo clip và video"><div className="scene-model-note"><Icon name="info" size={18} /><p>Veo có thể phát sinh phí và cần quyền truy cập từ tài khoản Google của bạn.{videoModel && <span> Mô hình: <strong>{videoModel}</strong>.</span>} Chỉ bấm tạo khi đã xem lại prompt.</p></div><div className="scene-batch-actions"><button className="button secondary" disabled={videoConfigured !== true || !!busy || dirty || generation.running || generation.missing === 0} onClick={() => generate('all')}><Icon name={busy === 'all' ? 'loader' : 'film'} className={busy === 'all' ? 'spin' : ''} size={17} />Generate All Scenes</button><button className="button primary" disabled={videoConfigured !== true || !!busy || dirty || generation.running} onClick={() => generate('video')}><Icon name={busy === 'video' ? 'loader' : 'sparkles'} className={busy === 'video' ? 'spin' : ''} size={17} />Generate Video</button></div><p className="field-help">{dirty ? 'Lưu các cảnh đang sửa để mở thao tác tạo toàn bộ.' : generation.running ? 'Đang xử lý. Bạn có thể mở lại dự án để theo dõi kết quả.' : `${generation.missing} cảnh cần tạo hoặc cập nhật. Cảnh đã hoàn thành đúng phiên bản được giữ lại.`}</p></section>
          <section className="scene-list-heading" aria-label="Danh sách Scene"><div><div className="eyebrow">DANH SÁCH SCENE</div><h2>Kịch bản gồm {project.scenes.length} cảnh</h2></div><p className="field-help">Mở Prompt để kiểm tra từng cảnh, Generate khi sẵn sàng, rồi Preview clip đã lưu.</p></section>
          <div className="scene-cards">{project.scenes.map((scene, index) => <SceneCard key={`${project.id}:${scene.id}`} scene={scene} index={index} project={project} draft={drafts[scene.id]} busy={busy} configured={videoConfigured === true} copied={copied} selectedPreview={selectedPreviews[scene.id]} onSelectPreview={(id, attemptId) => setSelectedPreviews(previous => ({ ...previous, [id]: attemptId }))} onPhaseChange={setPhase} onEdit={editScene} onSave={saveScene} onGenerate={generate} onCopy={copyPrompt} onDiscard={discardScene} />)}</div>
          <section className="panel scene-assembly" aria-label="Video hoàn chỉnh"><div className="row-heading"><div><h2>Video hoàn chỉnh</h2><p className="field-help">Ghép 5 cảnh theo thứ tự: cận sản phẩm → nhân vật → trải nghiệm → chi tiết → kết thúc.</p></div><span className={`scene-status ${project.assembly.status}`} role="status">{project.assembly.status === 'rendering' && <Icon name="loader" className="spin" size={13} />}{assemblyLabels[project.assembly.status] || project.assembly.status}</span></div>{project.assembly.error && <div className="notice error" role="alert"><Icon name="warning" size={17} /><span>{errorMessage(project.assembly.error)}</span></div>}{project.assembly.videoUrl ? <><video key={project.assembly.videoUrl} src={project.assembly.videoUrl} onPlay={() => setPhase(4)} controls preload="metadata" aria-label="Video sản phẩm ghép đủ 5 cảnh" />{(!generation.ready || project.assembly.status !== 'completed') && <p className="scene-stale-note"><Icon name="info" size={14} />Bản ghép này chưa phản ánh đầy đủ các chỉnh sửa hiện tại.</p>}<a className="button primary" href={project.assembly.videoUrl} download><Icon name="arrowDown" size={17} />{generation.ready && project.assembly.status === 'completed' ? 'Tải MP4' : 'Tải MP4 bản cũ'}</a></> : <div className="scene-assembly-empty"><Icon name="film" size={26} /><p>{project.assembly.status === 'rendering' ? 'Đang ghép các clip thành một video. Kết quả sẽ xuất hiện tại đây.' : 'Bấm Generate Video để tạo các cảnh còn thiếu rồi ghép thành một MP4.'}</p></div>}{generation.ready && project.assembly.status !== 'completed' && <button className="button secondary" disabled={!!busy} onClick={() => generate('render')}><Icon name="refresh" size={16} />Ghép các clip đã có</button>}</section>
          <div className="scene-delete-row"><p className="field-help">Hồ sơ và clip được giữ trên máy. Xóa dự án sẽ xóa cả các tệp của dự án này.</p><button className="text-button scene-delete-button" disabled={!!busy || generation.running} onClick={deleteProject}><Icon name="trash" size={16} />Xóa dự án</button></div>
        </>}
      </div>
    </div>
  </>;
}
