import express from 'express';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStore} from './lib/store.mjs';
import {createApi} from './lib/api.mjs';

const projectRoot=path.dirname(fileURLToPath(import.meta.url));

/** Custom Next server keeps HTTP and the independent SQLite worker separate. */
export async function createWebServer({production=false,dataDir=path.resolve(process.env.DATA_DIR||'.data'),port=3000,nextApp,config,tools}={}) {
  const store=createStore(path.join(dataDir,'jobs.sqlite'));
  let server,next,closing,api;
  try {
    next=nextApp??(await import('next')).default({dev:!production,dir:projectRoot,hostname:'127.0.0.1',port});
    await next.prepare();const app=express();app.disable('x-powered-by');api=createApi({store,dataDir,config,tools});app.use('/api',api);
    const handler=next.getRequestHandler();app.use((req,res)=>handler(req,res));
    server=createServer(app);server.requestTimeout=30*60*1000;server.headersTimeout=30000;
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
    return {address:server.address(),async close(){
      if(!closing)closing=(async()=>{
        await api?.close?.();
        await new Promise(resolve=>{const timer=setTimeout(()=>server.closeAllConnections(),10000);timer.unref();server.close(()=>{clearTimeout(timer);resolve();});server.closeIdleConnections();});
        await next.close?.();store.close();
      })();return closing;
    }};
  }catch(error){server?.close();await api?.close?.();await next?.close?.();store.close();throw error;}
}

/** Register ownership signals before preparation, retaining shutdown until close is possible. */
export async function runWebServer(options={}) {
  let server,stopRequested=typeof process.send==='function'&&!process.connected,closing;
  const removeHandlers=()=>{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);process.removeListener('disconnect',stop);process.removeListener('message',message);};
  const stop=async()=>{
    stopRequested=true;
    if(server&&!closing)closing=(async()=>{try{await server.close();}finally{removeHandlers();if(process.connected)process.disconnect();}})();
    return closing;
  };
  const message=value=>{if(value?.type==='shutdown')void stop();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);process.once('disconnect',stop);process.on('message',message);
  try {
    server=await createWebServer(options);
    if(stopRequested)await stop();else console.log('VietSub Studio: http://127.0.0.1:3000');
  }catch {
    removeHandlers();if(!stopRequested){console.error('Không thể mở VietSub Studio. Hãy kiểm tra cổng 3000 và dữ liệu ứng dụng.');process.exitCode=1;}
    if(process.connected)process.disconnect();
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  await runWebServer({production:process.argv.includes('--production')});
}
