export const TARGET_LANGUAGES = Object.freeze(['vi', 'en', 'ja', 'ko', 'zh']);
export const SUBTITLE_STYLES = Object.freeze(['classic', 'box']);
export const MAX_DURATION_SECONDS = 1500;
export const MAX_UPLOAD_BYTES = 500_000_000;

function invalidUrl() {
  return Object.assign(new Error('Vui lòng nhập liên kết video HTTPS hợp lệ từ YouTube hoặc Facebook.'), { code: 'INVALID_SOURCE_URL' });
}

/** Validate a direct resource before passing the canonical URL to the importer. */
export function validateSourceUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw invalidUrl();
  if (/[\u0000-\u001f\u007f\\]/.test(value) || !/^https:\/\/[^/?#@]+(?:[/?#]|$)/i.test(value.trim())) throw invalidUrl();
  let url;
  try { url = new URL(value.trim()); } catch { throw invalidUrl(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw invalidUrl();
  const host = url.hostname;
  const ytHosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'];
  let videoId;
  if (host === 'youtu.be') videoId = url.pathname.match(/^\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
  if (ytHosts.includes(host)) {
    videoId = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
  }
  if (host === 'youtu.be' || ytHosts.includes(host)) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId ?? '')) throw invalidUrl();
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  if (host === 'fb.watch' && /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return `https://fb.watch${url.pathname}`;
  if (['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com'].includes(host)) {
    const v = url.searchParams.get('v');
    if ((url.pathname === '/watch' || url.pathname === '/watch/' || url.pathname === '/video.php') && /^\d+$/.test(v ?? '')) {
      return `https://www.facebook.com/watch/?v=${v}`;
    }
    if (/^\/(?:[^/]+\/videos\/(?:[^/]+\/)?\d+|reel\/\d+|share\/(?:v|r)\/[A-Za-z0-9]+)\/?$/.test(url.pathname)) {
      return `https://www.facebook.com${url.pathname}`;
    }
  }
  throw invalidUrl();
}

export function validateJobOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Tùy chọn video không hợp lệ.'), { code: 'INVALID_OPTIONS' });
  const targetLanguage = input.targetLanguage ?? input.language ?? 'vi';
  const subtitleStyle = input.subtitleStyle ?? input.style ?? 'classic';
  if (!TARGET_LANGUAGES.includes(targetLanguage) || !SUBTITLE_STYLES.includes(subtitleStyle)) {
    throw Object.assign(new Error('Ngôn ngữ hoặc kiểu phụ đề không được hỗ trợ.'), { code: 'INVALID_OPTIONS' });
  }
  return { targetLanguage, subtitleStyle };
}
