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
  let server,next,closing;
  try {
    next=nextApp??(await import('next')).default({dev:!production,dir:projectRoot,hostname:'127.0.0.1',port});
    await next.prepare();const app=express();app.disable('x-powered-by');app.use('/api',createApi({store,dataDir,config,tools}));
    const handler=next.getRequestHandler();app.use((req,res)=>handler(req,res));
    server=createServer(app);server.requestTimeout=30*60*1000;server.headersTimeout=30000;
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
    return {address:server.address(),async close(){
      if(!closing)closing=(async()=>{
        await new Promise(resolve=>{const timer=setTimeout(()=>server.closeAllConnections(),10000);timer.unref();server.close(()=>{clearTimeout(timer);resolve();});server.closeIdleConnections();});
        await next.close?.();store.close();
      })();return closing;
    }};
  }catch(error){server?.close();await next?.close?.();store.close();throw error;}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const server=await createWebServer({production:process.argv.includes('--production')});
    console.log('VietSub Studio: http://127.0.0.1:3000');
    let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await server.close();if(process.connected)process.disconnect();};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);process.once('disconnect',stop);
    process.on('message',message=>{if(message?.type==='shutdown')void stop();});
  }catch {console.error('Không thể mở VietSub Studio. Hãy kiểm tra cổng 3000 và dữ liệu ứng dụng.');process.exitCode=1;if(process.connected)process.disconnect();}
}
