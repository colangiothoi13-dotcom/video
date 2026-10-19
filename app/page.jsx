'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../components/Icons';
import CreateVideo from '../components/CreateVideo';
import JobView from '../components/JobView';
import History from '../components/History';
import Settings from '../components/Settings';
import SceneStudio from '../components/SceneStudio';
import NarratedStudio from '../components/NarratedStudio';
import { createNavigationGuard, refreshHealthState, request, routeHash } from '../lib/client';

const screens = { narrated: 'Video từ giọng gốc', create: 'Tạo video', studio: 'Video từ ý tưởng', history: 'Lịch sử video', settings: 'Cài đặt', job: 'Biên tập video' };
export default function Studio() {
  const [route, setRoute] = useState({ screen: 'create', jobId: null }); const routeRef = useRef(route);
  const [health, setHealth] = useState(null); const [healthError, setHealthError] = useState('');
  const healthRef = useRef(null);
  const [jobs, setJobs] = useState([]); const jobsRef = useRef([]); const [jobsError, setJobsError] = useState(''); const [loading, setLoading] = useState(true);
  const navigationRef = useRef(null);
  if (!navigationRef.current) navigationRef.current = createNavigationGuard({
    getRoute: () => routeRef.current,
    readHash: () => window.location.hash,
    writeHash: hash => { window.location.hash = hash; },
    confirmLeave: () => window.confirm('Bạn có chỉnh sửa chưa lưu. Rời màn hình và bỏ các chỉnh sửa này?'),
    applyRoute: next => { routeRef.current = next; setRoute(next); window.scrollTo({ top: 0, behavior: 'instant' }); },
  });
  const registerDirty = useCallback(value => { navigationRef.current.setDirty(value); }, []);
  const refreshHealth = useCallback(async () => { const next = await refreshHealthState(healthRef.current); healthRef.current = next.health; setHealth(next.health); setHealthError(next.error); }, []);
  const refreshJobs = useCallback(async () => { try { const data = await request('/api/jobs'); setJobs(data.jobs); jobsRef.current = data.jobs; setJobsError(''); } catch (e) { setJobsError(e.message); } finally { setLoading(false); } }, []);
  function navigate(screen, jobId) {
    navigationRef.current.navigate(screen, jobId);
  }
  useEffect(() => {
    const changed = () => navigationRef.current.handleHashChange();
    changed(); window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => {
    let active = true; let healthTimer; let jobsTimer;
    const checkHealth = async () => { if (!document.hidden) await refreshHealth(); if (active) healthTimer = setTimeout(checkHealth, 30000); };
    const checkJobs = async () => { if (!document.hidden) await refreshJobs(); if (active) jobsTimer = setTimeout(checkJobs, document.hidden ? 10000 : jobsRef.current.some(job => ['queued', 'running'].includes(job.status)) ? 2000 : 15000); };
    const resume = () => { if (!document.hidden) { refreshHealth(); refreshJobs(); } };
    checkHealth(); checkJobs(); document.addEventListener('visibilitychange', resume);
    return () => { active = false; clearTimeout(healthTimer); clearTimeout(jobsTimer); document.removeEventListener('visibilitychange', resume); };
  }, [refreshHealth, refreshJobs]);
  const ready = health && health.configured && health.worker?.active && health.tools?.ffmpeg?.available && health.tools?.ffprobe?.available && health.tools.ffmpeg.subtitles !== false;
  const healthText = healthError ? 'Mất kết nối máy chủ' : !health ? 'Đang kết nối' : ready ? 'Hệ thống sẵn sàng' : !health.configured ? 'Cần cấu hình API' : !health.worker?.active ? 'Bộ xử lý chưa sẵn sàng' : 'Cần kiểm tra công cụ';
  return <div className="app-shell"><a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Đi tới nội dung chính</a><aside className="sidebar"><a href="#create" className="brand" onClick={event => { event.preventDefault(); navigate('create'); }} aria-label="VietSub Studio — tạo video"><span className="brand-mark"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="m13 7 12 7-12 7Z" fill="currentColor" /><path d="M7 24h9m4 0h6M7 28h16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg></span><span>VietSub<small>STUDIO</small></span></a><div className="workspace-label"><span className="workspace-icon"><Icon name="monitor" size={16} /></span><span>Không gian cá nhân</span></div><span className="nav-label">KHÔNG GIAN LÀM VIỆC</span><nav aria-label="Điều hướng chính">{[['create', 'plus', 'Tạo video'], ['studio', 'sparkles', 'Video từ ý tưởng'], ['narrated', 'audio', 'Video từ giọng gốc'], ['history', 'history', 'Lịch sử video'], ['settings', 'settings', 'Cài đặt']].map(([screen, icon, title]) => <a href={routeHash(screen)} key={screen} className={`nav-item ${route.screen === screen || screen === 'history' && route.screen === 'job' ? 'active' : ''}`} aria-current={route.screen === screen ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate(screen); }}><Icon name={icon} size={19} /><span>{title}</span>{screen === 'create' && <span className="nav-plus">+</span>}</a>)}</nav><div className="sidebar-bottom"><div className="local-note"><Icon name="shield" size={21} /><strong>Câu chuyện của bạn.<br />Không gian của bạn.</strong><p>Một góc sáng tạo, ngay trên máy tính của bạn.</p></div><div className="local-status"><span />Chạy trên máy này<Icon name="monitor" size={14} /></div></div></aside><div className="main-shell"><header className="topbar"><div className="breadcrumb"><span>Không gian làm việc</span><Icon name="chevron" size={13} /><strong>{screens[route.screen]}</strong></div><button className={`system-status ${ready && !healthError ? 'ready' : 'pending'}`} onClick={() => navigate('settings')} title="Mở trạng thái hệ thống"><span />{healthText}<Icon name="chevron" size={13} /></button></header><main id="main-content" className={`main-content screen-${route.screen}`} tabIndex={-1}>{healthError && route.screen !== 'settings' && <div className="notice error" role="alert"><Icon name="warning" /><span>{healthError}</span><button className="text-button" onClick={() => { refreshHealth(); refreshJobs(); }}>Thử lại</button></div>}{route.screen === 'create' && <>{jobsError && !healthError && <div className="notice error" role="alert"><Icon name="warning" /><span>Chưa tải được lịch sử. {jobsError}</span></div>}<CreateVideo configured={health?.configured} recentJobs={jobs} onNavigate={navigate} onOpenJob={id => navigate('job', id)} onCreated={job => { refreshJobs(); navigate('job', job.id); }} /></>}{route.screen === 'studio' && <SceneStudio onNavigate={navigate} registerDirty={registerDirty} />}{route.screen === 'narrated' && <NarratedStudio onNavigate={navigate} registerDirty={registerDirty} />}{route.screen === 'history' && <History jobs={jobs} loading={loading} error={jobsError} onRefresh={refreshJobs} onOpenJob={id => navigate('job', id)} onNavigate={navigate} />}{route.screen === 'settings' && <Settings health={health} healthError={healthError} refreshHealth={refreshHealth} />}{route.screen === 'job' && <JobView key={route.jobId} jobId={route.jobId} onNavigate={navigate} onChanged={refreshJobs} registerDirty={registerDirty} />}</main><footer className="app-footer"><span>VietSub Studio</span><span>Tạo kết nối. Vượt ngôn ngữ.</span></footer></div></div>;
}
