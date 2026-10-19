import {fork,spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function forceOwnedChild(child) {
  if(child.exitCode!==null||child.signalCode!==null||!child.pid)return;
  if(process.platform==='win32') {
    await new Promise(resolve=>{const killer=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});killer.once('error',resolve);killer.once('close',resolve);});
  }else child.kill('SIGKILL');
}

/** Only the two processes created here receive shutdown or forced termination. */
export function startStudio({production=false,cwd=projectRoot,serverScript=path.join(projectRoot,'server.mjs'),workerScript=path.join(projectRoot,'worker.mjs'),env=process.env}={}) {
  const children=[fork(serverScript,production?['--production']:[],{cwd,env,windowsHide:true,stdio:['inherit','inherit','inherit','ipc']}),fork(workerScript,[],{cwd,env,windowsHide:true,stdio:['inherit','inherit','inherit','ipc']})];
  const exits=children.map(child=>new Promise(resolve=>{child.once('error',()=>resolve(1));child.once('exit',code=>resolve(code??1));}));
  let stopping;
  const stop=()=>{
    if(!stopping)stopping=(async()=>{
      const timers=children.map(child=>{if(child.connected)child.send({type:'shutdown'},()=>{});return setTimeout(()=>void forceOwnedChild(child),35000);});
      const results=await Promise.all(exits);for(const timer of timers)clearTimeout(timer);return results;
    })();return stopping;
  };
  const done=Promise.race(exits).then(async code=>{await stop();return code;});
  return {children,stop,done};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const studio=startStudio({production:process.argv.includes('--production')});
  const stop=()=>void studio.stop();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  process.exitCode=await studio.done;
}
