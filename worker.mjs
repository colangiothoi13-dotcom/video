import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createStore} from './lib/store.mjs';
import {createPipeline} from './lib/pipeline.mjs';
import {readConfig} from './lib/config.mjs';

/** Owns one store connection. stop() aborts and awaits all in-flight work before release. */
export function createWorker({store,pipeline,workerId=randomUUID(),pollMs=1000,heartbeatMs=5000,cancelPollMs=250,cleanupMs=15*60*1000,closeStore=false,onError=()=>{}}={}) {
  if(!store||!pipeline)throw new TypeError('Worker cần kho dữ liệu và pipeline.');
  let stopping=false,loopPromise=null,controller=null,currentId=null,heartbeatTimer,cancelTimer,cleanupTimer,cleanupPromise=null,wake=null;
  function abort(code) {controller?.abort(Object.assign(new Error(code==='JOB_CANCELLED'?'Đã hủy công việc.':'Đã dừng xử lý.'),{code}));}
  function monitor() {
    try {
      if(currentId&&store.getJobInternal(currentId)?.cancelRequested)abort('JOB_CANCELLED');
    } catch(error){abort('WORKER_LEASE_LOST');onError(error);}
  }
  function cleanup() {
    if(stopping||cleanupPromise)return cleanupPromise;
    const lease=store.getWorkerStatus();
    if(!lease.active||lease.workerId!==workerId)return;
    cleanupPromise=Promise.resolve().then(()=>pipeline.cleanupExpired(Date.now())).catch(onError).finally(()=>{cleanupPromise=null;});
    return cleanupPromise;
  }
  async function loop() {
    heartbeatTimer=setInterval(()=>{
      try {if(!store.heartbeat(workerId))abort('WORKER_LEASE_LOST');}catch(error){abort('WORKER_LEASE_LOST');onError(error);}
    },heartbeatMs);
    cancelTimer=setInterval(monitor,cancelPollMs);
    cleanupTimer=setInterval(()=>{cleanup();},cleanupMs);
    try {
      while(!stopping) {
        try {
          const job=store.claimNextJob(workerId);
          if(stopping)break;
          if(!currentId&&job)await cleanup();
          if(stopping)break;
          if(job) {
            currentId=job.id;controller=new AbortController();monitor();
            await pipeline.runJob(job.id,controller.signal);controller=null;currentId=null;continue;
          }
        } catch(error){onError(error);controller=null;currentId=null;}
        if(!stopping)await new Promise(resolve=>{const timer=setTimeout(()=>{wake=null;resolve();},pollMs);wake=()=>{clearTimeout(timer);wake=null;resolve();};});
      }
    } finally {
      clearInterval(heartbeatTimer);clearInterval(cancelTimer);clearInterval(cleanupTimer);await cleanupPromise;store.releaseWorker(workerId);if(closeStore)store.close();
    }
  }
  const worker={
    workerId,
    start(){if(!loopPromise){stopping=false;loopPromise=loop();}return worker;},
    async stop(){stopping=true;abort('WORKER_SHUTDOWN');wake?.();await loopPromise;},
  };
  return worker;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const dataDir=path.resolve(process.env.DATA_DIR||'.data');const workerId=randomUUID();const store=createStore(path.join(dataDir,'jobs.sqlite'));
  const pipeline=createPipeline({store,dataDir,workerId,config:()=>readConfig({dataDir})});
  const worker=createWorker({store,pipeline,workerId,closeStore:true,onError:()=>console.error('Worker gặp lỗi xử lý. Công việc sẽ được kiểm tra lại.')}).start();
  let exiting=false;
  const stop=async()=>{if(exiting)return;exiting=true;await worker.stop();if(process.connected)process.disconnect();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  process.on('message',message=>{if(message?.type==='shutdown')void stop();});
  process.once('disconnect',()=>{void stop();});
}
