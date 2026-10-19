import {spawn} from 'node:child_process';
import path from 'node:path';

function terminateOwnedTree(child) {
  if(process.platform!=='win32') {
    // Each subprocess owns a new process group; never signal the server's group.
    try { process.kill(-child.pid,'SIGKILL'); } catch(error) { if(error.code!=='ESRCH') return Promise.reject(error); }
    return Promise.resolve();
  }
  return new Promise((resolve,reject)=>{
    const taskkill=path.join(process.env.SystemRoot || 'C:\\Windows','System32','taskkill.exe');
    const killer=spawn(taskkill,['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore'});
    killer.once('error',reject);
    killer.once('close',code=>{
      // A natural exit racing cancellation is already quiescent.
      if(code===0 || child.exitCode!==null || child.signalCode!==null) resolve();
      else reject(Object.assign(new Error('Không thể dừng cây tiến trình xử lý video.'),{code:'PROCESS_TERMINATION_FAILED'}));
    });
  });
}

/** Execute directly, never through a shell. Progress receives complete output lines. */
export function runProcess(exe, args, {cwd, signal, onProgress} = {}) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new TypeError('Tham số tiến trình phải là một mảng chuỗi.');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {cwd, windowsHide:true, shell:false, detached:process.platform!=='win32', stdio:['ignore','pipe','pipe']});
    let processError, closed=false, stopping=false;
    let termination=Promise.resolve();
    const abort=()=>{
      if(closed || stopping || !child.pid) return;
      stopping=true;
      termination=terminateOwnedTree(child);
      // Attach immediately: process close may follow a taskkill failure later.
      termination.catch(()=>{});
    };
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted) abort();
    let stdout = '', stderr = '';
    const pending = {stdout:'',stderr:''};
    for (const stream of ['stdout','stderr']) child[stream].setEncoding('utf8').on('data', text => {
      if (stream === 'stdout') stdout = (stdout + text).slice(-4_000_000);
      else stderr = (stderr + text).slice(-1_000_000);
      pending[stream] += text;
      const lines = pending[stream].split(/\r\n|[\r\n]/);
      pending[stream] = lines.pop();
      for (const line of lines) onProgress?.(line, {stream});
    });
    child.on('error', error=>{ processError=error; });
    child.on('close', async (code, terminationSignal) => {
      closed=true;
      signal?.removeEventListener('abort',abort);
      // Do not release callers to cleanup until both the child and tree-killer close.
      try { await termination; } catch(error) { reject(error); return; }
      for (const stream of ['stdout','stderr']) if (pending[stream]) onProgress?.(pending[stream],{stream});
      if (signal?.aborted) {
        const error = new Error('Đã hủy xử lý video.', {cause:signal.reason});
        error.name='AbortError'; reject(error); return;
      }
      if(processError) { reject(processError); return; }
      if (code !== 0) {
        const error = new Error('Công cụ xử lý video không hoàn tất. Vui lòng kiểm tra nguồn video và thử lại.');
        Object.assign(error,{code:'PROCESS_FAILED',exitCode:code,terminationSignal,stderr});
        reject(error); return;
      }
      resolve({stdout,stderr,code});
    });
  });
}
