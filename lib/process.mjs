import {spawn} from 'node:child_process';

/** Execute directly, never through a shell. Progress receives complete output lines. */
export function runProcess(exe, args, {cwd, signal, onProgress} = {}) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new TypeError('Tham số tiến trình phải là một mảng chuỗi.');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {cwd, signal, windowsHide:true, shell:false, stdio:['ignore','pipe','pipe']});
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
    child.on('error', reject);
    child.on('close', (code, terminationSignal) => {
      for (const stream of ['stdout','stderr']) if (pending[stream]) onProgress?.(pending[stream],{stream});
      if (signal?.aborted) {
        const error = new Error('Đã hủy xử lý video.', {cause:signal.reason});
        error.name='AbortError'; reject(error); return;
      }
      if (code !== 0) {
        const error = new Error('Công cụ xử lý video không hoàn tất. Vui lòng kiểm tra nguồn video và thử lại.');
        Object.assign(error,{code:'PROCESS_FAILED',exitCode:code,terminationSignal,stderr});
        reject(error); return;
      }
      resolve({stdout,stderr,code});
    });
  });
}
