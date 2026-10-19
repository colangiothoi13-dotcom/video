'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icons';
import { request } from '../lib/client';
import { geminiModelOptions } from '../lib/gemini-models-client.mjs';

const PROVIDERS = {
  openai: { name: 'OpenAI', keyName: 'OpenAI API', keyUrl: 'https://platform.openai.com/api-keys', keySource: 'OpenAI Platform' },
  gemini: { name: 'Google Gemini', keyName: 'Gemini API', keyUrl: 'https://aistudio.google.com/api-keys', keySource: 'Google AI Studio' },
};

export default function Settings({ health, healthError, refreshHealth }) {
  const [settings, setSettings] = useState(null);
  const [provider, setProvider] = useState('openai');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [videoApiKey, setVideoApiKey] = useState('');
  const [busy, setBusy] = useState('load');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [geminiCatalog, setGeminiCatalog] = useState(null);
  const [geminiCatalogBusy, setGeminiCatalogBusy] = useState(false);
  const [geminiCatalogError, setGeminiCatalogError] = useState('');
  const [geminiKeyRevision, setGeminiKeyRevision] = useState(0);
  const modelDrafts = useRef({});
  const geminiCatalogAttempt = useRef(null);
  const geminiCatalogRequest = useRef({ sequence: 0, controller: null });

  const cancelGeminiCatalog = useCallback(() => {
    const current = geminiCatalogRequest.current;
    current.sequence += 1;
    current.controller?.abort();
    current.controller = null;
  }, []);

  const loadGeminiCatalog = useCallback(async (refresh = false) => {
    cancelGeminiCatalog();
    const current = geminiCatalogRequest.current;
    const sequence = current.sequence;
    const controller = new AbortController();
    current.controller = controller;
    const isCurrent = () => current.sequence === sequence && !controller.signal.aborted;
    setGeminiCatalogBusy(true);
    setGeminiCatalogError('');
    try {
      const data = await request(`/api/settings/models?provider=gemini${refresh ? '&refresh=1' : ''}`, { signal: controller.signal });
      if (!isCurrent()) return;
      if (data?.provider !== 'gemini' || !Array.isArray(data.models)) throw new Error('Không đọc được danh sách mô hình từ Google API. Hãy thử làm mới danh sách.');
      geminiCatalogAttempt.current = geminiKeyRevision;
      setGeminiCatalog(data);
    } catch (e) {
      if (!isCurrent()) return;
      geminiCatalogAttempt.current = geminiKeyRevision;
      setGeminiCatalogError(e.message);
    } finally {
      if (isCurrent()) {
        current.controller = null;
        setGeminiCatalogBusy(false);
      }
    }
  }, [cancelGeminiCatalog, geminiKeyRevision]);

  function applySettings(data) {
    const savedModel = data.translationModel || data.providers?.[data.provider]?.translationModels?.[0]?.id || '';
    setSettings(data);
    setProvider(data.provider);
    setModel(savedModel);
    modelDrafts.current[data.provider] = savedModel;
  }

  useEffect(() => {
    let mounted = true;
    request('/api/settings').then(data => {
      if (mounted) applySettings(data);
    }).catch(e => {
      if (mounted) setError(e.message);
    }).finally(() => {
      if (mounted) setBusy('');
    });
    return () => { mounted = false; };
  }, []);

  const selectedProvider = PROVIDERS[provider];
  const providerSettings = settings?.providers?.[provider];
  const configured = settings ? !!providerSettings?.configured : null;
  const geminiConfigured = !!settings?.providers?.gemini?.configured;
  const geminiOptions = geminiModelOptions({
    catalogModels: geminiCatalog?.models,
    fallbackModels: settings?.providers?.gemini?.translationModels || [],
    savedModel: settings?.providers?.gemini?.translationModel,
    selectedModel: provider === 'gemini' ? model : modelDrafts.current.gemini,
  });
  const models = provider === 'gemini' ? geminiOptions.models : providerSettings?.translationModels || [];
  const selectedModel = models.find(item => item.id === model);
  const hasUnsavedChanges = !!settings && (provider !== settings.provider || model !== providerSettings?.translationModel || !!apiKey.trim() || !!videoApiKey.trim());

  useEffect(() => {
    if (provider === 'gemini' && geminiConfigured && geminiCatalogAttempt.current !== geminiKeyRevision) {
      void loadGeminiCatalog();
    } else {
      setGeminiCatalogBusy(false);
    }
    return cancelGeminiCatalog;
  }, [provider, geminiConfigured, geminiKeyRevision, loadGeminiCatalog, cancelGeminiCatalog]);

  function changeProvider(nextProvider) {
    modelDrafts.current[provider] = model;
    cancelGeminiCatalog();
    setGeminiCatalogBusy(false);
    setProvider(nextProvider);
    const savedProvider = settings?.providers?.[nextProvider];
    setModel(modelDrafts.current[nextProvider] || savedProvider?.translationModel || savedProvider?.translationModels?.[0]?.id || '');
    setApiKey('');
    setVideoApiKey('');
    setError('');
    setMessage('');
  }

  async function save(event) {
    event.preventDefault();
    const changesGoogleKey = provider === 'gemini' ? !!apiKey.trim() : !!videoApiKey.trim();
    setBusy('save'); setError(''); setMessage('');
    try {
      const data = await request('/api/settings', {
        method: 'PUT',
        body: {
          provider,
          translationModel: model,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(videoApiKey.trim() ? { videoApiKey: videoApiKey.trim() } : {}),
        },
      });
      if (changesGoogleKey) {
        cancelGeminiCatalog();
        geminiCatalogAttempt.current = null;
        setGeminiCatalog(null);
        setGeminiCatalogError('');
        setGeminiCatalogBusy(false);
        setGeminiKeyRevision(previous => previous + 1);
      }
      applySettings(data);
      setApiKey(''); setVideoApiKey('');
      setMessage('Đã lưu cài đặt trên máy này.');
      await refreshHealth();
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }

  async function testConnection() {
    setBusy('test'); setError(''); setMessage('');
    try {
      const data = await request('/api/settings/test', { method: 'POST' });
      if (data?.ok === false) throw new Error(data.error?.message || 'Chưa xác nhận được quyền truy cập. Kiểm tra khóa và mô hình rồi thử lại.');
      setMessage(`Đã xác nhận quyền truy cập mô hình ${selectedProvider.name} đã lưu. Kiểm tra này không tạo nội dung và không phát sinh phí tạo nội dung; chưa xác nhận hạn mức hay toàn bộ quy trình xử lý video.`);
      await refreshHealth();
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }

  const tools = health?.tools;
  const activeProvider = PROVIDERS[settings?.provider];
  const checks = [
    [`Nhận dạng & dịch · ${selectedProvider.name}`, configured, configured ? `Đã có khóa API${provider !== settings?.provider ? ' · Chưa áp dụng lựa chọn này' : ''}` : 'Cần thêm khóa API'],
    ['Tạo video Veo · Tùy chọn', settings ? !!settings.videoConfigured : null, settings?.videoConfigured ? 'Đã có khóa Google · Cần quyền truy cập Veo' : 'Thêm khóa Google khi cần tạo clip', true],
    ['Bộ xử lý nền', health?.worker?.active, 'Tự xử lý video trong hàng đợi'],
    ['Xử lý hình & âm thanh', tools ? !!(tools.ffmpeg?.available && tools.ffprobe?.available && tools.ffmpeg?.subtitles !== false) : null, 'FFmpeg & FFprobe'],
    ['Nhập video qua đường dẫn', tools ? !!tools.ytdlp?.available : null, 'yt-dlp · Chỉ cần cho đường dẫn'],
    ['Phông chữ phụ đề', tools?.font ? !!tools.font.available : null, 'Hỗ trợ dấu tiếng Việt'],
  ];

  return <>
    <div className="standard-intro">
      <div className="eyebrow">KHÔNG GIAN CỦA BẠN</div>
      <h1>Cài đặt</h1>
      <p>Kết nối AI để nhận dạng lời nói, dịch phụ đề và viết kịch bản.</p>
    </div>
    <div className="settings-grid">
      <form className="panel settings-form" onSubmit={save}>
        <div className="section-heading">
          <span className="round-icon"><Icon name="sparkles" /></span>
          <div><h2>Kết nối AI</h2><p>Chọn nhà cung cấp và mô hình cho công việc mới.</p></div>
        </div>
        <label htmlFor="ai-provider">Nhà cung cấp AI</label>
        <select id="ai-provider" value={provider} onChange={event => changeProvider(event.target.value)} disabled={!!busy || !settings} aria-describedby="ai-provider-help">
          <option value="openai">OpenAI</option>
          <option value="gemini">Google Gemini</option>
        </select>
        <p className="field-help" id="ai-provider-help">{selectedProvider.name} xử lý lời nói, bản dịch và kịch bản. Mỗi nhà cung cấp có khóa và mô hình được lưu riêng.</p>
        <div className={`key-status ${configured ? 'configured' : ''}`}>
          <Icon name={configured ? 'shield' : 'info'} size={18} />
          <span>{configured === null ? 'Đang tải cấu hình…' : configured ? `Đã có khóa ${selectedProvider.keyName} trên máy này` : `Chưa có khóa ${selectedProvider.keyName}`}</span>
        </div>
        <label htmlFor="api-key">{configured ? `Thay khóa ${selectedProvider.keyName}` : `Khóa ${selectedProvider.keyName}`}</label>
        <input id="api-key" type="password" autoComplete="new-password" spellCheck={false} value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={configured ? 'Để trống để giữ khóa hiện tại' : `Nhập khóa từ ${selectedProvider.keySource}`} disabled={!!busy || !settings} aria-describedby="api-key-help" />
        <p className="field-help" id="api-key-help">Tạo khóa tại <a href={selectedProvider.keyUrl} target="_blank" rel="noreferrer">{selectedProvider.keySource}</a>. Khóa được lưu trên máy chạy ứng dụng và không hiển thị lại. {provider === 'openai' ? 'Tài khoản API có thể khác tài khoản ChatGPT đang đăng nhập; phí API tính theo dự án của khóa, riêng với gói ChatGPT.' : 'Khóa Google này cũng dùng cho Veo khi bạn tạo clip. Phí và hạn mức API phụ thuộc dự án Google của khóa.'}</p>
        <label htmlFor="translation-model">{provider === 'gemini' ? 'Mô hình AI · Nghe, dịch & viết kịch bản' : 'Mô hình dịch & viết kịch bản'}</label>
        <select id="translation-model" value={model} onChange={event => { setModel(event.target.value); modelDrafts.current[provider] = event.target.value; setMessage(''); }} required disabled={!!busy || !settings || !models.length} aria-describedby={provider === 'gemini' ? 'translation-model-help gemini-model-list-help' : 'translation-model-help'}>
          {!models.length && <option value="">Đang tải danh sách mô hình…</option>}
          {models.map(item => <option key={item.id} value={item.id}>{item.label === item.id ? item.id : `${item.label} (${item.id})`}{item.source === 'saved' ? ' · Đã lưu' : item.source === 'selected' ? ' · Đang chọn' : ''}</option>)}
        </select>
        {provider === 'gemini' && <>
          <div className="settings-actions">
            <button className="button secondary" type="button" onClick={() => loadGeminiCatalog(true)} disabled={!!busy || !configured || geminiCatalogBusy}><Icon name={geminiCatalogBusy ? 'loader' : 'refresh'} className={geminiCatalogBusy ? 'spin' : ''} size={17} />Làm mới danh sách</button>
          </div>
          <p className="field-help" id="gemini-model-list-help" role="status">{geminiCatalogBusy ? 'Đang tải danh sách từ Google API… Bạn vẫn có thể chọn và lưu mô hình hiện tại.' : geminiOptions.source === 'google' ? `Danh sách từ Google API${geminiCatalog.cached ? ' (bản lưu tạm)' : ''}, dùng khóa Google đã lưu. Mô hình đã lưu hoặc đang chọn vẫn được giữ lại nếu Google không liệt kê.` : configured ? 'Đang dùng danh sách dự phòng. Làm mới để lấy danh sách từ Google API bằng khóa đã lưu.' : 'Danh sách dự phòng. Lưu khóa Google để tải danh sách từ Google API.'}{apiKey.trim() && ' Lưu khóa mới trước khi làm mới danh sách cho khóa đó.'}</p>
          {geminiCatalogError && <div className="notice error" role="alert"><Icon name="warning" /><span>{geminiCatalogError} {geminiCatalog ? 'Vẫn giữ danh sách Google API đã tải trước đó.' : 'Vẫn có thể chọn và lưu mô hình trong danh sách dự phòng.'} Bấm “Làm mới danh sách” để thử lại.</span></div>}
        </>}
        <p className="field-help" id="translation-model-help">{selectedModel ? <>Đang chọn: <strong>{selectedModel.label}</strong>. {provider === 'gemini' ? 'Dùng chính mô hình này để nhận dạng lời nói, lấy mốc thời gian, dịch phụ đề và viết kịch bản. Lưu cài đặt để áp dụng cho các bước xử lý mới. Tạo clip chuyển động dùng Veo.' : <>Mô hình này dùng để dịch phụ đề và viết kịch bản. {providerSettings?.transcriptionModel && <>Nhận dạng lời nói và mốc thời gian dùng <strong>{providerSettings.transcriptionModel}</strong>.</>}</>}</> : 'Chọn mô hình trong danh sách. '}</p>
        {provider === 'gemini' && <p className="field-help">Google AI Pro trong ứng dụng Gemini và quyền dùng Gemini API được quản lý riêng. Web dùng API key đã lưu; quyền truy cập, hạn mức và phí phụ thuộc dự án Google của khóa. Xem <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noreferrer">hạn mức và thanh toán API</a>.</p>}
        {provider === 'openai' && <>
          <div className="section-divider" />
          <label htmlFor="video-api-key">Khóa Google API cho Veo · Tùy chọn</label>
          <input id="video-api-key" type="password" autoComplete="new-password" spellCheck={false} value={videoApiKey} onChange={event => setVideoApiKey(event.target.value)} placeholder={settings?.videoConfigured ? 'Để trống để giữ khóa Google hiện tại' : 'Nhập khóa Google khi cần tạo clip Veo'} disabled={!!busy || !settings} aria-describedby="video-api-key-help" />
          <p className="field-help" id="video-api-key-help">Google API chỉ cần thêm khi bạn muốn tạo clip bằng Veo; dịch phụ đề và viết kịch bản với OpenAI không cần khóa này. Tạo khóa tại <a href="https://aistudio.google.com/api-keys" target="_blank" rel="noreferrer">Google AI Studio</a> với quyền truy cập Veo. Phí tạo clip tính theo dự án Google của khóa.</p>
        </>}
        {error && <div className="notice error" role="alert"><Icon name="warning" /><span>{error}</span></div>}
        {message && <div className="notice success" role="status"><Icon name="checkCircle" /><span>{message}</span></div>}
        <div className="settings-actions">
          <button className="button primary" type="submit" disabled={!!busy || !settings || !model}><Icon name={busy === 'save' ? 'loader' : 'save'} className={busy === 'save' ? 'spin' : ''} size={17} />{busy === 'save' ? 'Đang lưu…' : 'Lưu cài đặt'}</button>
          <button className="button secondary" type="button" onClick={testConnection} disabled={!!busy || !configured || hasUnsavedChanges}><Icon name={busy === 'test' ? 'loader' : 'refresh'} className={busy === 'test' ? 'spin' : ''} size={17} />{busy === 'test' ? 'Đang kiểm tra…' : 'Kiểm tra kết nối'}</button>
        </div>
        {hasUnsavedChanges && <p className="field-help" role="status">Có thay đổi chưa lưu. Lưu cài đặt trước khi kiểm tra kết nối.</p>}
      </form>
      <aside>
        <div className="panel health-panel">
          <div className="row-heading"><h2>Trạng thái hệ thống</h2><button className="icon-button" aria-label="Kiểm tra lại hệ thống" onClick={refreshHealth}><Icon name="refresh" size={17} /></button></div>
          {healthError && <div className="notice error" role="alert"><Icon name="warning" /><span>{healthError} {health ? 'Các trạng thái bên dưới là lần kiểm tra trước, có thể đã thay đổi.' : 'Chưa tải được trạng thái hệ thống.'}</span><button type="button" className="text-button" onClick={refreshHealth}>Thử kiểm tra lại</button></div>}
          <div className="health-checks">{checks.map(([title, available, detail, optional]) => <div className="health-check" key={title}>
            <span className={`health-check-icon ${available === true ? 'ok' : available === false && !optional ? 'needs-setup' : ''}`}><Icon name={available === true ? 'check' : optional ? 'info' : available === false ? 'warning' : 'clock'} size={16} /></span>
            <div><strong>{title}</strong><p>{available == null ? 'Chưa có thông tin' : detail}</p></div>
            <span className="health-check-state">{available == null ? '—' : available ? optional ? 'Đã cấu hình' : 'Sẵn sàng' : optional ? 'Tùy chọn' : 'Cần kiểm tra'}</span>
          </div>)}</div>
        </div>
        <div className="privacy-note"><Icon name="shield" size={22} /><div><h3>Không gian riêng trên máy bạn</h3><p>{activeProvider ? `Nhà cung cấp đang dùng: ${activeProvider.name}, theo cài đặt đã lưu trên máy này. Âm thanh và nội dung được gửi tới nhà cung cấp đó bằng khóa của bạn. ` : 'Cài đặt và khóa API được lưu trên máy chạy ứng dụng. '}Veo gửi prompt và ảnh tham chiếu tới Google khi bạn tạo clip. Kết quả phụ đề lưu 24 giờ trên máy. Hãy giữ ứng dụng chạy đến khi xuất video xong.</p></div></div>
      </aside>
    </div>
  </>;
}
