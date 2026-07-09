// yt-dlp engine: preview metadata + download with quality + progress parsing
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let cfg = {};
function init(config) { cfg = config; }

// Pool User-Agent thông dụng — rotate để giảm bot-check
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
];
function pickUserAgent() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }


function resolveYtDlp() {
  const local = path.join(__dirname, 'bin', 'yt-dlp.exe');
  if (fs.existsSync(local)) return local;
  return cfg.ytDlpPath || 'yt-dlp';
}
function resolveFfmpeg() {
  const local = path.join(__dirname, 'bin', 'ffmpeg.exe');
  if (fs.existsSync(local)) return local;
  return cfg.ffmpegPath || 'ffmpeg';
}
// Deno JS runtime — YouTube (2026+) yêu cầu JS runtime để giải mã link, tránh HTTP 403.
function resolveDeno() {
  const candidates = [
    path.join(__dirname, 'bin', 'deno.exe'),
    'C:\\veutools\\deno\\deno.exe',
  ];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  return null;
}
// Chèn --js-runtimes deno:<path> vào đầu args (nếu có Deno). Gọi trước mỗi spawn yt-dlp.
function withJsRuntime(args) {
  const deno = resolveDeno();
  if (deno) return ['--js-runtimes', 'deno:' + deno, ...args];
  return args;
}

function sanitize(s) {
  return String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';
}

// Detect platform from URL
function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'YouTube';
  if (/tiktok\.com|douyin\.com/i.test(url)) return 'TikTok';
  if (/instagram\.com/i.test(url)) return 'Instagram';
  if (/facebook\.com|fb\.watch|fb\.com/i.test(url)) return 'Facebook';
  if (/twitter\.com|x\.com/i.test(url)) return 'Twitter';
  return 'Other';
}

// Fetch metadata (preview) without downloading
function fetchMetadata(url) {
  return new Promise((resolve) => {
    const exe = resolveYtDlp();
    const args = ['--dump-single-json', '--no-warnings', '--no-playlist',
      '--extractor-args', 'youtube:lang=ja', url];
    const proc = spawn(exe, withJsRuntime(args), { windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('error', e => resolve({ ok: false, error: e.message }));
    proc.on('exit', code => {
      if (code !== 0) { resolve({ ok: false, error: err.slice(-200) || `exit ${code}` }); return; }
      try {
        const j = JSON.parse(out);
        resolve({
          ok: true,
          meta: {
            id: j.id,
            title: j.title || j.id,
            uploader: j.uploader || j.channel || j.uploader_id || '',
            duration: j.duration || 0,
            thumbnail: j.thumbnail || (j.thumbnails && j.thumbnails.length ? j.thumbnails[j.thumbnails.length-1].url : null),
            viewCount: j.view_count || 0,
            likeCount: j.like_count || 0,
            uploadDate: j.upload_date || '',
            platform: detectPlatform(url),
            webpageUrl: j.webpage_url || url,
            isShort: (j.duration && j.duration <= 60) || /shorts\//i.test(url),
          },
        });
      } catch (e) { resolve({ ok: false, error: 'parse: ' + e.message }); }
    });
  });
}

function buildFormatArgs(quality) {
  const q = String(quality || '1080').toLowerCase();
  if (q === 'mp3' || q === 'audio') return ['-x', '--audio-format', 'mp3', '--audio-quality', '0'];
  // Ưu tiên H.264 (avc1) + AAC để Windows 11 / mọi player đọc được + có thumbnail.
  // Fallback: nếu không có H.264 → tự chọn codec tốt nhất.
  if (q === '4k' || q === '2160') return ['-f', 'bv*[vcodec^=avc1][height<=2160]+ba[ext=m4a]/bv*[height<=2160]+ba/b[height<=2160]/best', '--merge-output-format', 'mp4'];
  if (q === '720') return ['-f', 'bv*[vcodec^=avc1][height<=720]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/best', '--merge-output-format', 'mp4'];
  return ['-f', 'bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/best', '--merge-output-format', 'mp4'];
}

/**
 * Download with live progress.
 * @param {Object} opts { url, quality, platform, uploader, downloadsDir, onProgress(percent, line), log }
 * @returns {child_process + promise} { proc, promise }
 */
function download(opts) {
  const { url, quality, platform, uploader, downloadsDir, dlThumb, customFilename, subdir, useCookies, onProgress, log } = opts;
  const plat = platform || detectPlatform(url);
  // Tải vào folder gốc + subdir nếu có (vd: nickname kênh)
  let folder = downloadsDir;
  if (subdir && typeof subdir === 'string' && subdir.trim()) {
    const safeSub = subdir.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 100);
    if (safeSub) folder = path.join(downloadsDir, safeSub);
  }
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

  // Nếu có customFilename → dùng làm tên file, nếu không → mặc định
  let outTemplate;
  if (customFilename && customFilename.trim()) {
    // Sanitize lần nữa cho chắc + cap 120 chars
    const safe = customFilename.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 120);
    // Dùng autonumber để tránh đè file: <name>.mp4 → nếu trùng thì <name> (2).mp4
    outTemplate = path.join(folder, `${safe}.%(ext)s`);
  } else {
    outTemplate = path.join(folder, '%(title).80s [%(id)s].%(ext)s');
  }
  const exe = resolveYtDlp();
  const ffmpeg = resolveFfmpeg();
  const args = [
    ...buildFormatArgs(quality),
    '-o', outTemplate,
    '--no-playlist',
    '--continue',         // resume partial
    '--no-overwrites',
    '--newline',
    '--print', 'after_move:filepath',
    '--ffmpeg-location', ffmpeg,
    // Bypass YouTube bot-check: thử android client + tvhtml5 + web (fallback)
    // Đa client xoay vòng — ưu tiên client BẤT TỬ với bot-check
    '--extractor-args', 'youtube:player_client=tv_simply,android_vr,ios,mweb,android,tv_embedded,web_safari,web;lang=;skip=translated_subs',
    // Rotate User-Agent (random từ pool)
    '--user-agent', pickUserAgent(),
    // Header giả lập browser thật + Referer
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
    '--add-header', 'Sec-Fetch-Dest:document',
    '--add-header', 'Sec-Fetch-Mode:navigate',
    // Sleep ngẫu nhiên → tránh rate-limit
    '--sleep-interval', '1',
    '--max-sleep-interval', '3',
    // Retry network errors
    '--retries', '10',
    '--fragment-retries', '10',
    '--retry-sleep', 'exp=1:5',
    // Force IPv4 (IPv6 hay bị YouTube nghi ngờ)
    '--force-ipv4',
  ];
  // Nếu có file cookies.txt (do anh đăng nhập YouTube trong app) → LUÔN dùng, chống chặn tốt nhất
  const cookieFile = path.join(__dirname, 'cookies.txt');
  if (fs.existsSync(cookieFile)) {
    args.push('--cookies', cookieFile);
  }
  // Retry với client mạnh hơn (không cần Chrome) — tránh cookies database lock
  if (useCookies) {
    // Thay vì cookies-from-browser → dùng web_creator + mweb (ít bị check nhất)
    // Override extractor-args ở cuối → yt-dlp ưu tiên cái sau
    args.push('--extractor-args', 'youtube:player_client=web_creator,mweb,android_creator,tv_simply;skip=hls,dash');
  }
  if (dlThumb) args.push('--write-thumbnail', '--convert-thumbnails', 'jpg');
  args.push(url);

  let filepath = '';
  let stderr = '';
  const captured = [];
  // ensure ffmpeg dir is in PATH for the child
  const ffmpegDir = path.dirname(resolveFfmpeg());
  const childEnv = { ...process.env };
  if (fs.existsSync(ffmpegDir)) childEnv.PATH = ffmpegDir + path.delimiter + (childEnv.PATH || '');
  const proc = spawn(exe, withJsRuntime(args), { windowsHide: true, env: childEnv });

  // Parse a chunk of output (yt-dlp prints progress on BOTH stdout and stderr depending on client/version)
  const handleChunk = (s) => {
    for (const line of s.split(/[\r\n]+/)) {
      const t = line.trim();
      if (!t) continue;
      // progress: [download]  45.2% of ...
      const m = t.match(/\[download\]\s+([\d.]+)%/);
      if (m && onProgress) onProgress(parseFloat(m[1]), t);
      // capture any absolute path lines (from --print after_move:filepath)
      if (/^[A-Za-z]:\\/.test(t) || t.startsWith('/')) { captured.push(t); filepath = t; }
      // also catch [Merger] / [download] Destination lines as fallback
      const destM = t.match(/\[(?:Merger|download|ExtractAudio)\].*?(?:to|Destination:|Merging formats into)\s+"?([A-Za-z]:\\[^"]+)"?/i);
      if (destM) captured.push(destM[1]);
    }
  };

  const promise = new Promise((resolve) => {
    proc.stdout.on('data', d => { handleChunk(d.toString()); });
    proc.stderr.on('data', d => { const s = d.toString(); stderr += s; handleChunk(s); });
    proc.on('error', e => resolve({ ok: false, error: e.message }));
    proc.on('exit', code => {
      // pick the last existing file from captured
      let file = null;
      for (let i = captured.length - 1; i >= 0; i--) {
        if (fs.existsSync(captured[i])) { file = captured[i]; break; }
      }
      if (!file && filepath && fs.existsSync(filepath)) file = filepath;
      if (code === 0 && file) {
        log && log(`[dl] OK ${file}`);
        resolve({ ok: true, file });
      } else if (code === 0) {
        log && log(`[dl] done but path uncertain; captured=${JSON.stringify(captured.slice(-3))}`);
        resolve({ ok: true, file: file || null });
      } else {
        resolve({ ok: false, error: stderr.slice(-300) || `exit ${code}` });
      }
    });
  });

  return { proc, promise };
}

// Expand a channel/playlist URL into individual video entries (flat, fast)
function expandChannel(url, limit) {
  return new Promise((resolve) => {
    const exe = resolveYtDlp();
    // decode URL-encoded chars (e.g. %E3%83%96 → 「ブ」) so yt-dlp gets clean unicode
    let cleanUrl = url;
    try { cleanUrl = decodeURI(url); } catch {}
    const args = [
      '--flat-playlist', '--dump-single-json', '--no-warnings',
      '--extractor-args', 'youtube:lang=ja',
    ];
    if (limit && limit > 0) args.push('--playlist-end', String(limit));
    args.push(cleanUrl);
    const proc = spawn(exe, withJsRuntime(args), { windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('error', e => resolve({ ok: false, error: e.message }));
    proc.on('exit', code => {
      if (code !== 0) { resolve({ ok: false, error: err.slice(-200) || `exit ${code}` }); return; }
      try {
        const j = JSON.parse(out);
        const entries = (j.entries || []).filter(Boolean).map(e => {
          // pick a real video thumbnail (skip avatar/channel images)
          let thumb = null;
          if (e.thumbnails && e.thumbnails.length) {
            const vid = e.thumbnails.find(t => t.url && /\/vi\//.test(t.url));
            if (vid) thumb = vid.url;
          }
          if (!thumb && e.id) thumb = `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`;
          const isYTUrl = /youtube\.com|youtu\.be/i.test(e.url || '');
          if (!thumb && isYTUrl && e.id) thumb = `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`;
          return {
            id: e.id,
            url: e.url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : null),
            title: e.title || e.id,
            uploader: e.uploader || j.uploader || j.channel || '',
            duration: e.duration || 0,
            viewCount: e.view_count || 0,
            thumbnail: thumb,
            isShort: (e.duration && e.duration <= 60) || /shorts\//i.test(e.url||''),
          };
        }).filter(e => e.url);
        resolve({
          ok: true,
          channelTitle: j.title || j.channel || j.uploader || '',
          count: entries.length,
          entries,
        });
      } catch (e) { resolve({ ok: false, error: 'parse: ' + e.message }); }
    });
  });
}

function isChannelOrPlaylist(url) {
  return /youtube\.com\/(@[^/]+|c\/|channel\/|user\/|playlist\?)/i.test(url)
      || /youtube\.com\/.*\/(videos|shorts|streams)/i.test(url)
      || /list=/i.test(url)
      || /tiktok\.com\/@[^/]+\/?$/i.test(url);
}

module.exports = { init, fetchMetadata, download, detectPlatform, sanitize, expandChannel, isChannelOrPlaylist, resolveYtDlp };
