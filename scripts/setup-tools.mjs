import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import {runProcess} from '../lib/process.mjs';
import {getToolStatus, toolPaths, ytDlpBaseArgs} from '../lib/media.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const toolsDirectory=path.join(root,'.tools');
const headers={'User-Agent':'Vietsub-Studio-local-setup','Accept':'application/vnd.github+json'};

async function request(url) {
  const response=await fetch(url,{headers,signal:AbortSignal.timeout(180_000)});
  if(!response.ok) throw new Error(`Không tải được công cụ từ GitHub (HTTP ${response.status}).`);
  return response;
}

/** Download only the official bundled executable and verify the upstream SHA-256. */
export async function setupTools() {
  if(process.platform!=='win32') throw new Error('Bản cài công cụ này dành cho Windows.');
  if(Number(process.versions.node.split('.')[0])<22) throw new Error('Cần Node.js 22 trở lên để chạy JavaScript của yt-dlp.');
  await mkdir(toolsDirectory,{recursive:true});
  const release=await (await request('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest')).json();
  const tag=release.tag_name;
  if(typeof tag!=='string' || !/^[A-Za-z0-9._-]+$/.test(tag)) throw new Error('Phản hồi phiên bản yt-dlp không hợp lệ.');
  const upstream=`https://github.com/yt-dlp/yt-dlp/releases/download/${tag}`;
  const checksums=await (await request(`${upstream}/SHA2-256SUMS`)).text();
  const digest=checksums.split(/\r?\n/).map(line=>line.match(/^([a-f0-9]{64})\s+\*?yt-dlp\.exe$/i)).find(Boolean)?.[1]?.toLowerCase();
  if(!digest) throw new Error('Không tìm thấy mã kiểm tra cho yt-dlp.exe chính thức.');
  let existingDigest;
  try { existingDigest=createHash('sha256').update(await readFile(toolPaths.ytDlp)).digest('hex'); } catch {}
  if(existingDigest!==digest) {
    const partial=`${toolPaths.ytDlp}.partial`;
    const hash=createHash('sha256');
    let bytes=0;
    try {
      const response=await request(`${upstream}/yt-dlp.exe`);
      await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,encoding,callback){
        bytes+=chunk.length;
        if(bytes>150_000_000) { callback(new Error('Tệp công cụ tải xuống vượt giới hạn an toàn.')); return; }
        hash.update(chunk); callback(null,chunk);
      }}),createWriteStream(partial,{flags:'w'}));
      if(hash.digest('hex')!==digest) throw new Error('Mã SHA-256 của yt-dlp không khớp nguồn chính thức.');
      await rename(partial,toolPaths.ytDlp);
    } finally { await rm(partial,{force:true}); }
  }
  const help=(await runProcess(toolPaths.ytDlp,[...ytDlpBaseArgs(),'--help'])).stdout;
  if(!help.includes('--js-runtimes') || !help.includes('--no-plugin-dirs')) throw new Error('yt-dlp không hỗ trợ JavaScript hoặc cách ly plugin theo yêu cầu.');
  // Official PyInstaller standalone includes yt-dlp-ejs (official EJS setup guide).
  // Pin provenance and checksum to this exact release, without Python/global installs.
  await writeFile(path.join(toolsDirectory,'manifest.json'),JSON.stringify({version:tag,source:`${upstream}/yt-dlp.exe`,sha256:digest,sha256Verified:true,officialStandalone:true,ejs:'bundled',jsRuntime:'node',installedAt:new Date().toISOString()},null,2),'utf8');
  const status=await getToolStatus();
  const unavailable=Object.entries(status).filter(([,value])=>!value.available).map(([name])=>name);
  if(!status.ffmpeg.subtitles) unavailable.push('libass');
  if(!status.ytdlp.ejs) unavailable.push('EJS');
  if(unavailable.length) throw new Error(`Công cụ chưa sẵn sàng: ${unavailable.join(', ')}. Cài lại phụ thuộc bằng npm install rồi chạy npm run setup.`);
  return status;
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  setupTools().then(status=>{
    console.log('Công cụ video, libass, phông chữ và EJS đã sẵn sàng.');
    console.log(JSON.stringify(status,null,2));
  }).catch(error=>{ console.error(error.message); process.exitCode=1; });
}
