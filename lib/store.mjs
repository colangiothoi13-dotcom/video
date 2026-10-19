import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateJobOptions, validateSourceUrl } from './validation.mjs';
import {validateDubbingProfile} from './dubbing.mjs';
import {validateClipRequest,clipSourceArtifact} from './clips.mjs';

export const WORKER_LEASE_MS = 30_000;
export const RETENTION_MS = 24 * 60 * 60 * 1000;
const STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'expired'];
const STAGES = ['import', 'probe', 'transcribe', 'translate', 'render', 'done'];
const PUBLIC_FIELDS = ['id', 'title', 'sourceType', 'sourceUrl', 'targetLanguage', 'subtitleStyle', 'status', 'stage', 'progress', 'duration', 'createdAt', 'updatedAt', 'expiresAt', 'error', 'subtitleVersion', 'renderedVersion', 'usage','dubbing','dubbingOutput','dubbingPreview','clipsOutput'];
const PUBLIC_PATCH_FIELDS = PUBLIC_FIELDS.filter(key => !['id', 'createdAt', 'updatedAt', 'subtitleVersion'].includes(key));
const PRIVATE_FIELDS = ['artifacts', 'checkpoint', 'cancelRequested', 'firstCompletedAt', 'workerId', 'workerInstanceId', 'renderRequested', 'renderVersion', 'upload', 'metadata','dubbingRequest','clipsRequest'];
const fail = (code, message) => Object.assign(new Error(message), { code });
const publicJob = document => document ? Object.fromEntries(PUBLIC_FIELDS.map(key => [key, document[key]])) : null;
const graphemes = new Intl.Segmenter('vi', { granularity: 'grapheme' });

/** Synchronous SQLite operations make each read/modify/write transaction indivisible. */
export function createStore(databasePath = resolve('.data', 'jobs.sqlite'), { now = Date.now } = {}) {
  if (databasePath !== ':memory:') mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA busy_timeout=5000;
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      document TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs(status, created_at);
    CREATE TABLE IF NOT EXISTS cues (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      document TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worker_lease (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      worker_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      heartbeat_at INTEGER NOT NULL
    );
    PRAGMA user_version=1;
  `);
  const sql = {
    get: database.prepare('SELECT document FROM jobs WHERE id=?'),
    list: database.prepare('SELECT document FROM jobs ORDER BY created_at DESC, rowid DESC'),
    filtered: database.prepare('SELECT document FROM jobs WHERE status=? ORDER BY created_at DESC, rowid DESC'),
    next: database.prepare("SELECT document FROM jobs WHERE status='queued' ORDER BY created_at ASC, rowid ASC LIMIT 1"),
    running: database.prepare("SELECT document FROM jobs WHERE status='running'"),
    insert: database.prepare('INSERT INTO jobs(id,status,created_at,document) VALUES(?,?,?,?)'),
    update: database.prepare('UPDATE jobs SET status=?, document=? WHERE id=?'),
    cues: database.prepare('SELECT document FROM cues WHERE job_id=?'),
    saveCues: database.prepare('INSERT INTO cues(job_id,document) VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET document=excluded.document'),
    lease: database.prepare('SELECT * FROM worker_lease WHERE singleton=1'),
    own: database.prepare('INSERT INTO worker_lease VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET worker_id=excluded.worker_id, instance_id=excluded.instance_id, heartbeat_at=excluded.heartbeat_at'),
    beat: database.prepare('UPDATE worker_lease SET heartbeat_at=? WHERE worker_id=? AND instance_id=?'),
    release: database.prepare('DELETE FROM worker_lease WHERE worker_id=? AND instance_id=?'),
  };
  const instanceId = randomUUID();
  let closed = false;
  const timestamp = () => new Date(now()).toISOString();
  function transaction(action) {
    database.exec('BEGIN IMMEDIATE');
    try { const result = action(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  }
  function getInternal(id) { const row = sql.get.get(id); return row ? JSON.parse(row.document) : null; }
  function requireJob(id) { const job = getInternal(id); if (!job) throw fail('JOB_NOT_FOUND', 'Không tìm thấy công việc.'); return job; }
  function persist(job) { sql.update.run(job.status, JSON.stringify(job), job.id); }
  function validateJob(job) {
    Object.assign(job, validateJobOptions(job));
    if (!STATUSES.includes(job.status) || !STAGES.includes(job.stage) || !['upload', 'url'].includes(job.sourceType) || typeof job.title !== 'string' || job.title.length > 1000 || (job.progress !== null && (!Number.isFinite(job.progress) || job.progress < 0 || job.progress > 100)) || (job.duration !== null && (!Number.isFinite(job.duration) || job.duration <= 0)) || !Number.isInteger(job.renderedVersion) || job.renderedVersion < 0) {
      throw fail('INVALID_JOB', 'Dữ liệu công việc không hợp lệ.');
    }
  }
  function acquire(workerId) {
    if (typeof workerId !== 'string' || !workerId.trim()) throw fail('INVALID_WORKER', 'Mã worker không hợp lệ.');
    const lease = sql.lease.get();
    if (lease && lease.heartbeat_at + WORKER_LEASE_MS > now()) {
      return { acquired: lease.worker_id === workerId && lease.instance_id === instanceId, fresh: false };
    }
    sql.own.run(workerId, instanceId, now());
    return { acquired: true, fresh: true };
  }
  function recover() {
    const interrupted = sql.running.all();
    for (const row of interrupted) {
      const job = JSON.parse(row.document);
      job.status = 'queued';
      job.updatedAt = timestamp();
      job.workerId = null;
      job.workerInstanceId = null;
      persist(job);
    }
    return interrupted.length;
  }
  function checkOwner(workerId) {
    const lease = sql.lease.get();
    return Boolean(lease && lease.worker_id === workerId && lease.instance_id === instanceId && lease.heartbeat_at + WORKER_LEASE_MS > now());
  }
  const store = {
    createJob(input) {
      const options = validateJobOptions(input);
      const time = timestamp();
      const sourceType = input.sourceType ?? (input.sourceUrl ? 'url' : 'upload');
      const job = {
        id: randomUUID(), title: input.title ?? 'Video mới', sourceType,
        sourceUrl: sourceType === 'url' ? validateSourceUrl(input.sourceUrl) : null,
        ...options, status: 'queued', stage: 'import', progress: null, duration: null,
        createdAt: time, updatedAt: time, expiresAt: null, error: null,
        subtitleVersion: 0, renderedVersion: 0, usage: {},
        artifacts: input.artifacts ?? {}, checkpoint: input.checkpoint ?? null,
        cancelRequested: false, firstCompletedAt: null, workerId: null, workerInstanceId: null,
        metadata: input.metadata ?? {}, upload: input.upload ?? null,
      };
      validateJob(job);
      sql.insert.run(job.id, job.status, job.createdAt, JSON.stringify(job));
      return publicJob(job);
    },
    getJob(id) { return publicJob(getInternal(id)); },
    getJobInternal: getInternal,
    listJobs(status) {
      if (status !== undefined && !STATUSES.includes(status)) throw fail('INVALID_JOB', 'Trạng thái công việc không hợp lệ.');
      return (status === undefined ? sql.list.all() : sql.filtered.all(status)).map(row => publicJob(JSON.parse(row.document)));
    },
    /** Optional workerId fences writes from a worker that has lost its lease. */
    updateJob(id, patch, { workerId, expectedStatuses, requireUnexpired = false, requireNotCancelled = false,expectedSubtitleVersion,expectedDubbingVersion } = {}) {
      return transaction(() => {
        const job = requireJob(id);
        if (requireUnexpired && (job.status === 'expired' || (job.expiresAt && Date.parse(job.expiresAt) <= now()))) throw fail('JOB_EXPIRED', 'Công việc đã hết hạn.');
        if (expectedStatuses !== undefined && !expectedStatuses.includes(job.status)) throw fail('JOB_STATE_CONFLICT', 'Trạng thái công việc đã thay đổi. Vui lòng tải lại.');
        if (workerId !== undefined && !checkOwner(workerId)) throw fail('WORKER_LEASE_LOST', 'Worker đã mất quyền xử lý.');
        if (requireNotCancelled && job.cancelRequested) throw fail('JOB_CANCELLED', 'Đã hủy công việc.');
        if(expectedSubtitleVersion!==undefined&&job.subtitleVersion!==expectedSubtitleVersion)throw fail('VERSION_CONFLICT','Phụ đề đã thay đổi.');
        if(expectedDubbingVersion!==undefined&&(job.dubbing?.version??0)!==expectedDubbingVersion)throw fail('DUBBING_VERSION_CONFLICT','Phân vai đã thay đổi.');
        const previousStatus = job.status;
        for (const key of [...PUBLIC_PATCH_FIELDS, ...PRIVATE_FIELDS]) {
          if (!(key in patch)) continue;
          job[key] = key === 'artifacts' ? { ...job.artifacts, ...patch.artifacts } : patch[key];
        }
        job.updatedAt = timestamp();
        if (job.status === 'completed' && !job.firstCompletedAt) job.firstCompletedAt = job.updatedAt;
        if (job.firstCompletedAt) job.expiresAt = new Date(Date.parse(job.firstCompletedAt) + RETENTION_MS).toISOString();
        else if (['failed', 'cancelled'].includes(job.status) && job.status !== previousStatus) job.expiresAt = new Date(now() + RETENTION_MS).toISOString();
        validateJob(job);
        persist(job);
        return publicJob(job);
      });
    },
    requestCancellation(id) {
      return transaction(() => {
        const job = requireJob(id);
        if (job.status === 'expired' || (job.expiresAt && Date.parse(job.expiresAt) <= now())) throw fail('JOB_EXPIRED', 'Công việc đã hết hạn.');
        if (!['queued', 'running'].includes(job.status)) return publicJob(job);
        job.cancelRequested = true;
        job.updatedAt = timestamp();
        if (job.status === 'queued') {
          job.status = 'cancelled';
          job.expiresAt = new Date((job.firstCompletedAt ? Date.parse(job.firstCompletedAt) : now()) + RETENTION_MS).toISOString();
        }
        persist(job);
        return publicJob(job);
      });
    },
    getCues(id) { const row = sql.cues.get(id); return row ? JSON.parse(row.document) : []; },
    getCueSnapshot(id) {
      return transaction(() => ({ job: publicJob(requireJob(id)), cues: store.getCues(id) }));
    },
    saveDubbing(id,profile,{workerId}={}) {
      return transaction(()=>{
        const job=requireJob(id);
        if(workerId!==undefined&&!checkOwner(workerId))throw fail('WORKER_LEASE_LOST','Worker đã mất quyền xử lý.');
        if(job.status==='expired'||(job.expiresAt&&Date.parse(job.expiresAt)<=now()))throw fail('JOB_EXPIRED','Công việc đã hết hạn.');
        if(workerId===undefined&&['queued','running'].includes(job.status))throw fail('JOB_BUSY','Đợi công việc đang chạy hoàn tất trước khi sửa phân vai.');
        if(profile?.version!==(job.dubbing?.version??0))throw fail('DUBBING_VERSION_CONFLICT','Phân vai đã thay đổi. Hãy tải lại trước khi lưu.');
        job.dubbing={...validateDubbingProfile(profile,store.getCues(id),job.subtitleVersion),version:profile.version+1};
        if(workerId===undefined)job.dubbingRequest=null;
        job.updatedAt=timestamp();persist(job);return publicJob(job);
      });
    },
    queueDubbing(id,{action,version,subtitleVersion,speakerId}={}) {
      return transaction(()=>{
        const job=requireJob(id);
        if(job.status==='expired'||(job.expiresAt&&Date.parse(job.expiresAt)<=now()))throw fail('JOB_EXPIRED','Công việc đã hết hạn.');
        if(['queued','running'].includes(job.status))throw fail('JOB_BUSY','Công việc đang được xử lý.');
        if(!['analyze','preview','render'].includes(action)||!store.getCues(id).length)throw fail('INVALID_DUBBING','Yêu cầu lồng tiếng không hợp lệ.');
        if(subtitleVersion!==job.subtitleVersion)throw fail('VERSION_CONFLICT','Phụ đề đã thay đổi.');
        if(version!==(job.dubbing?.version??0))throw fail('DUBBING_VERSION_CONFLICT','Phân vai đã thay đổi.');
        if(action!=='analyze') {
          if(!job.dubbing)throw fail('INVALID_DUBBING','Hãy lưu phân vai trước khi tạo giọng.');
          validateDubbingProfile(job.dubbing,store.getCues(id),job.subtitleVersion);
          if(action==='preview'&&!job.dubbing.speakers.some(s=>s.id===speakerId))throw fail('INVALID_DUBBING','Chọn một vai hợp lệ.');
        }
        job.dubbingRequest={action,version,subtitleVersion,...(action==='preview'?{speakerId}:{})};job.clipsRequest=null;
        job.status='queued';job.stage=action==='analyze'?'transcribe':'render';job.progress=null;job.error=null;job.cancelRequested=false;job.updatedAt=timestamp();persist(job);return publicJob(job);
      });
    },
    queueClips(id,body) {
      return transaction(()=>{
        const job=requireJob(id);
        if(job.status==='expired'||(job.expiresAt&&Date.parse(job.expiresAt)<=now()))throw fail('JOB_EXPIRED','Công việc đã hết hạn.');
        if(['queued','running'].includes(job.status))throw fail('JOB_BUSY','Công việc đang được xử lý.');
        const request=validateClipRequest(body,job),sourcePath=clipSourceArtifact(job,request);
        job.clipsRequest={...request,sourcePath};job.dubbingRequest=null;job.renderRequested=false;
        job.status='queued';job.stage='render';job.progress=null;job.error=null;job.cancelRequested=false;job.updatedAt=timestamp();persist(job);return publicJob(job);
      });
    },
    saveCues(id, version, input, { workerId } = {}) {
      return transaction(() => {
        if (workerId !== undefined && !checkOwner(workerId)) throw fail('WORKER_LEASE_LOST', 'Worker đã mất quyền xử lý.');
        const job = requireJob(id);
        if(workerId===undefined&&(job.dubbingRequest||job.clipsRequest)&&['queued','running'].includes(job.status))throw fail('JOB_BUSY','Đợi công việc xuất video dừng trước khi sửa phụ đề.');
        if (!Number.isInteger(version) || version !== job.subtitleVersion) throw fail('VERSION_CONFLICT', 'Phụ đề đã thay đổi. Vui lòng tải lại trước khi lưu.');
        const existing = store.getCues(id);
        if (!Array.isArray(input) || !input.length) throw fail('INVALID_CUES', 'Dữ liệu phụ đề không hợp lệ.');
        const byId = new Map(existing.map(cue => [cue.id, cue]));
        const seen = new Set();
        let previousEnd = 0;
        const cues = input.map(cue => {
          const old = byId.get(cue.id);
          const merged = { ...old, ...cue };
          if (typeof merged.id !== 'string' || !merged.id || seen.has(merged.id) || typeof merged.sourceId !== 'string' || !merged.sourceId || !Number.isFinite(merged.start) || !Number.isFinite(merged.end) || merged.start < previousEnd || merged.end <= merged.start || merged.end > job.duration || typeof merged.original !== 'string' || typeof merged.text !== 'string' || !merged.text.trim()) {
            throw fail('INVALID_CUES', 'Thời gian hoặc nội dung phụ đề không hợp lệ.');
          }
          if (existing.length && (!old || ['sourceId', 'start', 'end', 'original'].some(key => merged[key] !== old[key]))) throw fail('INVALID_CUES', 'Không được thay đổi dữ liệu lời nói gốc.');
          seen.add(merged.id);
          previousEnd = merged.end;
          const { id: cueId, sourceId, start, end, original, text } = merged;
          return { id: cueId, sourceId, start, end, original, text, readingWarning: [...graphemes.segment(text.replaceAll('\n', ' '))].length / (end - start) > 22 };
        });
        if (existing.length && cues.length !== existing.length) throw fail('INVALID_CUES', 'Phải giữ đầy đủ các đoạn phụ đề.');
        job.subtitleVersion += 1;
        job.updatedAt = timestamp();
        sql.saveCues.run(id, JSON.stringify(cues));
        persist(job);
        return { job: publicJob(job), cues };
      });
    },
    claimNextJob(workerId) {
      return transaction(() => {
        const lease = acquire(workerId);
        if (!lease.acquired) return null;
        if (lease.fresh) recover();
        if (sql.running.get()) return null;
        const row = sql.next.get();
        if (!row) return null;
        const job = JSON.parse(row.document);
        job.status = 'running';
        job.updatedAt = timestamp();
        job.workerId = workerId;
        job.workerInstanceId = instanceId;
        persist(job);
        return publicJob(job);
      });
    },
    heartbeat(workerId) {
      return transaction(() => {
        if (!checkOwner(workerId)) return false;
        return sql.beat.run(now(), workerId, instanceId).changes === 1;
      });
    },
    releaseWorker(workerId) { return sql.release.run(workerId, instanceId).changes === 1; },
    recoverInterruptedJobs(workerId) {
      return transaction(() => { const lease = acquire(workerId); return lease.acquired && lease.fresh ? recover() : 0; });
    },
    getWorkerStatus() {
      const lease = sql.lease.get();
      return { active: Boolean(lease && lease.heartbeat_at + WORKER_LEASE_MS > now()), workerId: lease?.worker_id ?? null, heartbeatAt: lease ? new Date(lease.heartbeat_at).toISOString() : null };
    },
    // A crashed/closed connection retains its lease until expiry; only explicit release surrenders ownership.
    close() { if (!closed) { database.close(); closed = true; } },
  };
  return store;
}
