import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {access, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import {runProcess} from './process.mjs';
import {normalizeCues, toAss} from './subtitles.mjs';
import {validateSourceUrl} from './validation.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const toolPaths=Object.freeze({ffmpeg:ffmpegPath,ffprobe:ffprobeStatic.path,ytDlp:path.join(root,'.tools','yt-dlp.exe')});
const MAX_BYTES=500_000_000;
function mediaError(code,message) { return Object.assign(new Error(message),{code}); }

export function fitDimensions(width,height) {
  if(!Number.isFinite(width) || !Number.isFinite(height) || width<2 || height<2) throw mediaError('INVALID_VIDEO','Kích thước video không hợp lệ.');
  const landscape=width>=height;
  const scale=Math.min(1,(landscape?1280:720)/width,(landscape?720:1280)/height);
  return {width:Math.max(2,Math.floor(width*scale/2)*2),height:Math.max(2,Math.floor(height*scale/2)*2)};
}

export function validateVideoMetadata(metadata,size=0) {
  if(!Number.isFinite(size) || size>MAX_BYTES) throw mediaError('VIDEO_TOO_LARGE','Video vượt giới hạn 500.000.000 byte.');
  if(!Number.isFinite(metadata.duration) || metadata.duration<=0 || !Number.isFinite(metadata.width) || !Number.isFinite(metadata.height) || metadata.width<2 || metadata.height<2) throw mediaError('INVALID_VIDEO','Tệp không chứa video có thời lượng và kích thước hợp lệ.');
  if(metadata.duration>600) throw mediaError('VIDEO_TOO_LONG','Video phải có thời lượng không quá 600 giây.');
  if(!metadata.hasAudio) throw mediaError('NO_AUDIO','Video không có âm thanh để nhận dạng lời nói.');
  return metadata;
}

export async function probeVideo(inputPath,{signal}={}) {
  const info=await stat(inputPath);
  if(info.size>MAX_BYTES) throw mediaError('VIDEO_TOO_LARGE','Video vượt giới hạn 500.000.000 byte.');
  let data;
  try { data=JSON.parse((await runProcess(toolPaths.ffprobe,['-v','error','-show_format','-show_streams','-of','json',path.resolve(inputPath)],{signal})).stdout); }
  catch(error) { if(error.name==='AbortError') throw error; throw mediaError('INVALID_VIDEO','Không thể đọc tệp video. Vui lòng dùng một tệp video hợp lệ.'); }
  const video=data.streams?.find(stream=>stream.codec_type==='video' && !stream.disposition?.attached_pic);
  const rotation=Number(video?.side_data_list?.find(item=>item.rotation!==undefined)?.rotation ?? video?.tags?.rotate ?? 0);
  const rotated=Math.abs(rotation)%180===90;
  return validateVideoMetadata({duration:Number(data.format?.duration ?? video?.duration),width:Number(rotated ? video?.height : video?.width),height:Number(rotated ? video?.width : video?.height),hasAudio:Boolean(data.streams?.some(stream=>stream.codec_type==='audio'))},info.size);
}

export async function extractAudio(input,output,{signal}={}) {
  await probeVideo(input,{signal});
  await runProcess(toolPaths.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-i',path.resolve(input),'-map','0:a:0','-vn','-ac','1','-ar','16000','-codec:a','libmp3lame','-b:a','64k','-f','mp3','-y',path.resolve(output)],{signal});
  const info=await stat(output);
  if(info.size>=25_000_000) { await rm(output,{force:true}); throw mediaError('AUDIO_TOO_LARGE','Âm thanh vượt giới hạn 25 MB cho nhận dạng.'); }
  return {path:path.resolve(output),size:info.size};
}

export function ytDlpBaseArgs() {
  return ['--ignore-config','--no-plugin-dirs','--no-cache-dir','--no-playlist','--no-js-runtimes','--js-runtimes',`node:${process.execPath}`,'--no-remote-components','--socket-timeout','30','--retries','2','--fragment-retries','2','--ffmpeg-location',toolPaths.ffmpeg];
}

export async function importVideo(url,jobDir,{signal}={}) {
  const canonicalUrl=validateSourceUrl(url);
  await mkdir(jobDir,{recursive:true});
  const directory=await mkdtemp(path.join(path.resolve(jobDir),'import-'));
  let keep=false;
  try {
    let info;
    try { info=JSON.parse((await runProcess(toolPaths.ytDlp,[...ytDlpBaseArgs(),'--dump-single-json','--skip-download','--',canonicalUrl],{signal})).stdout); }
    catch(error) { if(error.name==='AbortError') throw error; throw mediaError('IMPORT_FAILED','Không thể đọc video công khai từ liên kết này. Video có thể bị chặn, riêng tư hoặc yêu cầu đăng nhập.'); }
    if(info.is_live || info.live_status==='is_live' || !Number.isFinite(info.duration) || info.duration<=0 || info.duration>600) throw mediaError('VIDEO_TOO_LONG','Chỉ nhận video đã kết thúc và có thời lượng không quá 600 giây.');
    if((info.filesize ?? info.filesize_approx ?? 0)>MAX_BYTES) throw mediaError('VIDEO_TOO_LARGE','Video vượt giới hạn 500.000.000 byte.');
    const limitController=new AbortController();
    const combined=signal ? AbortSignal.any([signal,limitController.signal]) : limitController.signal;
    let tooLarge=false;
    let checking=false;
    const timer=setInterval(async()=>{
      if(checking) return;
      checking=true;
      try {
        const files=await readdir(directory);
        const entries=await Promise.all(files.map(file=>stat(path.join(directory,file)).then(item=>({file,size:item.isFile()?item.size:0})).catch(()=>({file,size:0}))));
        // Muxing temporarily retains both component streams and the merged output.
        const merged=entries.filter(item=>/^source\.[^.]+$/.test(item.file));
        const components=entries.filter(item=>!/^source\.[^.]+$/.test(item.file));
        const largest=Math.max(0,...merged.map(item=>item.size),components.reduce((sum,item)=>sum+item.size,0));
        if(largest>MAX_BYTES) { tooLarge=true; limitController.abort(); }
      } catch {} finally { checking=false; }
    },250);
    let result;
    try {
      result=await runProcess(toolPaths.ytDlp,[...ytDlpBaseArgs(),'--max-filesize',String(MAX_BYTES),'--match-filter','!is_live & duration <= 600','--restrict-filenames','--no-write-info-json','--no-write-thumbnail','--no-write-subs','--no-write-auto-subs','--no-mtime','--format','bv*[height<=1280][width<=1280]+ba/b[height<=1280][width<=1280]/best','--merge-output-format','mp4','--output',path.join(directory,'source.%(ext)s'),'--print','after_move:filepath','--',canonicalUrl],{signal:combined});
    } catch(error) {
      if(tooLarge) throw mediaError('VIDEO_TOO_LARGE','Video vượt giới hạn 500.000.000 byte.');
      if(error.name==='AbortError') throw error;
      throw mediaError('IMPORT_FAILED','Không tải được video công khai. Video có thể bị chặn, riêng tư hoặc yêu cầu đăng nhập.');
    } finally { clearInterval(timer); }
    const inputPath=path.resolve(result.stdout.trim().split(/\r?\n/).at(-1) || '');
    if(path.dirname(inputPath)!==directory || !path.basename(inputPath).startsWith('source.')) throw mediaError('IMPORT_FAILED','Công cụ tải không tạo được tệp video hợp lệ.');
    const metadata=await probeVideo(inputPath,{signal});
    keep=true;
    return {inputPath,title:String(info.title || 'Video đã nhập').slice(0,300),metadata};
  } finally { if(!keep) await rm(directory,{recursive:true,force:true}); }
}

async function fontFiles() {
  const candidates=process.platform==='win32' ? [path.join(process.env.WINDIR || 'C:\\Windows','Fonts','arial.ttf'),path.join(process.env.WINDIR || 'C:\\Windows','Fonts','arialbd.ttf'),path.join(process.env.WINDIR || 'C:\\Windows','Fonts','seguiemj.ttf')] : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];
  const available=[];
  for(const file of candidates) { try { await access(file); available.push(file); } catch {} }
  return available;
}

export async function renderVideo({inputPath,outputPath,cues,style='classic',duration,signal,onProgress}) {
  if(path.resolve(inputPath)===path.resolve(outputPath)) throw mediaError('INVALID_OUTPUT','Tệp xuất phải khác video nguồn.');
  const source=await probeVideo(inputPath,{signal});
  const dimensions=fitDimensions(source.width,source.height);
  const normalized=normalizeCues(cues,source.duration);
  await mkdir(path.dirname(path.resolve(outputPath)),{recursive:true});
  const temp=await mkdtemp(path.join(path.dirname(path.resolve(outputPath)),'.render-'));
  try {
    const fonts=await fontFiles();
    if(!fonts.length) throw mediaError('FONT_MISSING','Không tìm thấy phông chữ để hiển thị phụ đề. Hãy chạy npm run setup.');
    await mkdir(path.join(temp,'fonts'));
    for(const font of fonts) await copyFile(font,path.join(temp,'fonts',path.basename(font)));
    // Relative filter paths avoid FFmpeg filter-grammar issues with Windows drive letters.
    let ass=toAss(normalized,style);
    if(source.height>source.width) ass=ass.replace('PlayResX: 1280\nPlayResY: 720','PlayResX: 720\nPlayResY: 1280').replace('Default,Arial,40,','Default,Arial,28,');
    await writeFile(path.join(temp,'captions.ass'),ass,'utf8');
    const output=path.join(temp,'render.mp4');
    await runProcess(toolPaths.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-i',path.resolve(inputPath),'-map','0:v:0','-map','0:a:0','-vf',`scale=${dimensions.width}:${dimensions.height},setsar=1,ass=filename=captions.ass:fontsdir=fonts`,'-c:v','libx264','-preset','fast','-crf','22','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart','-progress','pipe:1','-nostats','-y',output],{cwd:temp,signal,onProgress:line=>{
      const match=line.match(/^out_time_us=(\d+)$/);
      if(match) onProgress?.(Math.min(1,Number(match[1])/1_000_000/source.duration));
      if(line==='progress=end') onProgress?.(1);
    }});
    const metadata=await probeVideo(output,{signal});
    signal?.throwIfAborted();
    await rename(output,path.resolve(outputPath));
    return metadata;
  } finally { await rm(temp,{recursive:true,force:true}); }
}

export async function getToolStatus() {
  const status={};
  for(const [name,exe] of Object.entries(toolPaths)) {
    try {
      const output=await runProcess(exe,name==='ytDlp'?['--ignore-config','--no-plugin-dirs','--version']:['-version']);
      status[name==='ytDlp'?'ytdlp':name]={available:true,version:output.stdout.trim().split(/\r?\n/)[0]};
    } catch { status[name==='ytDlp'?'ytdlp':name]={available:false,message:'Chưa cài công cụ. Hãy chạy npm run setup.'}; }
  }
  try { status.ffmpeg.subtitles=/\bass\s+V->V/.test((await runProcess(toolPaths.ffmpeg,['-hide_banner','-filters'])).stdout); }
  catch { status.ffmpeg.subtitles=false; }
  status.font={available:(await fontFiles()).length>0};
  try {
    const manifest=JSON.parse(await readFile(path.join(root,'.tools','manifest.json'),'utf8'));
    status.ytdlp.ejs=status.ytdlp.available && manifest.officialStandalone===true && manifest.sha256Verified===true && Number(process.versions.node.split('.')[0])>=22;
  } catch { status.ytdlp.ejs=false; }
  return status;
}
