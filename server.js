// Veu Media Downloader — HTTP server + queue manager + SSE progress
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const engine = require('./engine.js');
const capcut = require('./capcut-injector.js');

const ROOT = __dirname;
const DEFAULT_CFG = { port: 8770, notifierUrl: 'http://localhost:8765', ytDlpPath: 'yt-dlp', maxConcurrent: 3, ffmpegPath: 'ffmpeg', downloadsDir: 'downloads', defaultQuality: '1080' };
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
} catch {
  cfg = { ...DEFAULT_CFG };
  try { fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(cfg, null, 2)); } catch {}
}
engine.init(cfg);

function defaultDownloadDir() {
  // Thư mục an toàn cho mọi máy: Videos\VeuDownloader trong user profile
  const home = process.env.USERPROFILE || process.env.HOME || ROOT;
  return path.join(home, 'Videos', 'VeuDownloader');
}
function getDownloadDir() {
  let d = path.isAbsolute(cfg.downloadsDir) ? cfg.downloadsDir : path.join(ROOT, cfg.downloadsDir);
  // Nếu ổ đĩa/đường dẫn không truy cập được (vd T:\ trên máy khác) → fallback an toàn
  try {
    const drive = path.parse(d).root; // vd "T:\"
    if (drive && drive.match(/^[A-Za-z]:\\$/) && !fs.existsSync(drive)) {
      d = defaultDownloadDir();
    }
  } catch { d = defaultDownloadDir(); }
  return d;
}
{
  try {
    let d = getDownloadDir();
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  } catch (e) {
    // Nếu vẫn lỗi → dùng thư mục mặc định, không để app chết
    try {
      const d = defaultDownloadDir();
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      cfg.downloadsDir = d;
    } catch {}
  }
}
const STATE_FILE = path.join(ROOT, 'queue-state.json');
const LOG_FILE = path.join(ROOT, 'app.log');

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// ---------- Queue ----------
// item: { id, url, quality, status, percent, title, uploader, platform, thumbnail, file, error, addedAt, proc(runtime) }
let queue = [];
let idSeq = 1;
const sseClients = new Set();

function loadQueue() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    queue = (data.queue || []).map(q => ({ ...q, proc: null }));
    idSeq = data.idSeq || (queue.reduce((m, q) => Math.max(m, q.id), 0) + 1);
    // reset running -> pending on restart (resume)
    for (const q of queue) if (q.status === 'running') { q.status = 'pending'; q.percent = q.percent || 0; }
  } catch { queue = []; }
}
function saveQueue() {
  const serializable = { queue: queue.map(({ proc, ...rest }) => rest), idSeq };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(serializable, null, 2), 'utf8'); } catch {}
}
function broadcast() {
  const payload = JSON.stringify(queue.map(({ proc, ...rest }) => rest));
  for (const res of sseClients) {
    try { res.write(`data: ${payload}\n\n`); } catch {}
  }
}
function isDownloaded(url) {
  // dedup: same url already completed
  return queue.some(q => q.url === url && q.status === 'done');
}

function addToQueue(url, quality, meta, opts) {
  const item = {
    id: idSeq++, url, quality: quality || cfg.defaultQuality,
    status: 'queued', percent: 0,
    title: meta?.title || url, uploader: meta?.uploader || '',
    platform: meta?.platform || engine.detectPlatform(url),
    thumbnail: meta?.thumbnail || null,
    file: null, error: null, retries: 0,
    dlThumb: !!(opts && opts.dlThumb),
    subdir: meta?.subdir || meta?.subfolder || null,
    customFilename: meta?.customFilename || null,
    addedAt: Date.now(), proc: null,
  };
  queue.push(item);
  saveQueue(); broadcast();
  // NOTE: no auto-pump — user must approve via /api/start-all or /api/start/:id
  return item;
}

function startItem(id) {
  const it = queue.find(q => q.id === id);
  if (it && it.status === 'queued') { it.status = 'pending'; saveQueue(); broadcast(); pump(); return true; }
  return false;
}
function startAll() {
  let n = 0;
  for (const q of queue) if (q.status === 'queued') { q.status = 'pending'; n++; }
  saveQueue(); broadcast(); pump();
  return n;
}

function runningCount() { return queue.filter(q => q.status === 'running').length; }

let lastStartAt = 0;
let pumpScheduled = false;
const START_GAP_MS = 4000; // giãn cách khởi động giữa các video → tránh YouTube chặn hàng loạt
async function pump() {
  if (runningCount() >= (cfg.maxConcurrent || 2)) return;
  const next = queue.find(q => q.status === 'pending');
  if (!next) return;
  // Stagger: nếu vừa mới bắt đầu 1 video < START_GAP_MS trước đó → chờ, tránh bung nhiều request cùng lúc
  const sinceLast = Date.now() - lastStartAt;
  if (sinceLast < START_GAP_MS) {
    if (!pumpScheduled) {
      pumpScheduled = true;
      setTimeout(() => { pumpScheduled = false; pump(); }, START_GAP_MS - sinceLast);
    }
    return;
  }
  lastStartAt = Date.now();
  next.status = 'running'; next.percent = 0;
  broadcast();

  // fetch metadata if missing
  if (!next.title || next.title === next.url) {
    const m = await engine.fetchMetadata(next.url);
    if (m.ok) { next.title = m.meta.title; next.uploader = m.meta.uploader; next.platform = m.meta.platform; next.thumbnail = m.meta.thumbnail; }
  }

  // Pass baseDir + subdir riêng để engine.js chỉ join 1 lần (không double-nest)
  const baseDir = getDownloadDir();
  const { proc, promise } = engine.download({
    url: next.url, quality: next.quality, platform: next.platform, uploader: next.uploader,
    downloadsDir: baseDir,
    dlThumb: next.dlThumb,
    customFilename: next.customFilename,
    subdir: next.subdir,
    useCookies: !!next.useCookies,
    onProgress: (pct) => { next.percent = pct; broadcast(); },
    log,
  });
  next.proc = proc;
  saveQueue();

  promise.then(result => {
    next.proc = null;
    if (result.ok) {
      next.status = 'done'; next.percent = 100; next.file = result.file; next.error = null;
      log(`done #${next.id}: ${next.title}`);
      consecutiveFailures = 0; lastErrorPattern = '';
      // Broadcast SSE event để UI play sound + notification
      try {
        const evt = `event: done\ndata: ${JSON.stringify({ id: next.id, title: next.title, file: next.file, quality: next.quality })}\n\n`;
        for (const c of sseClients) { try { c.write(evt); } catch {} }
      } catch {}
      // Notify Telegram if this came from a Telegram button click OR auto-downloader
      if (next.notify && next.notify.tgChatId) {
        notifyTelegramDone(next).catch(e => log('tg-notify err: ' + e.message));
      }
    }
    else {
      next.retries = (next.retries || 0) + 1;
      const maxRetries = 3;
      // Nếu lỗi bot-check → bật cookies cho lần retry sau + cho CẢ hàng đợi còn lại (chống chặn hàng loạt)
      if (/sign in to confirm|bot|cookies|not a bot|429|too many/i.test(result.error || '')) {
        next.useCookies = true;
        for (const q of queue) if (q.status === 'pending' || q.status === 'stopped') q.useCookies = true;
        log(`#${next.id}: bot-check detected → bật cookies cho cả hàng đợi`);
      }
      if (next.retries < maxRetries) {
        // Delay tăng dần: 5s → 15s → 30s
        const delays = [5000, 15000, 30000];
        const wait = delays[next.retries - 1] || 30000;
        next.status = 'pending';
        next.error = `Lỗi: ${result.error}. Tự thử lại sau ${Math.round(wait/1000)}s (${next.retries}/${maxRetries})`;
        log(`retry #${next.id} (${next.retries}/${maxRetries}) sau ${wait}ms: ${result.error}`);
        saveQueue(); broadcast();
        setTimeout(() => { saveQueue(); broadcast(); pump(); }, wait);
        return;
      } else {
        next.status = 'error'; next.error = result.error;
        log(`fail #${next.id}: ${result.error}`);
        // Append vào errors.log
        try { fs.appendFileSync(path.join(__dirname, 'errors.log'), `[${new Date().toISOString()}] #${next.id} "${next.title}" → ${result.error}\n  URL: ${next.url}\n  Uploader: ${next.uploader || ''}\n\n`); } catch {}
        // Broadcast error event để UI toast
        try {
          const evt = `event: error\ndata: ${JSON.stringify({ id: next.id, title: next.title, error: result.error, uploader: next.uploader, url: next.url })}\n\n`;
          for (const c of sseClients) { try { c.write(evt); } catch {} }
        } catch {}
        // Telegram báo lỗi
        notifyTelegramFail(next).catch(e => log('tg-fail err: ' + e.message));
        checkSmartPause(result.error);
      }
    }
    saveQueue(); broadcast(); pump();
  });
  pump(); // try to fill other slots
}

function stopAll() {
  for (const q of queue) {
    if (q.proc) { try { q.proc.kill(); } catch {} q.proc = null; }
    if (q.status === 'running' || q.status === 'pending') q.status = 'stopped';
  }
  saveQueue(); broadcast();
  log('STOP ALL triggered');
}
function moveToRecycleBin(filePath) {
  // Dùng PowerShell + Microsoft.VisualBasic để đẩy file vào Recycle Bin (khôi phục được)
  try {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const { execFileSync } = require('child_process');
    const ps = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${filePath.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin')`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 });
    return true;
  } catch (e) { log('recycle err: ' + e.message); return false; }
}
function clearDone(deleteFiles) {
  const doneItems = queue.filter(q => q.status === 'done');
  let trashed = 0;
  if (deleteFiles) {
    for (const it of doneItems) {
      if (it.file && moveToRecycleBin(it.file)) trashed++;
    }
    log(`clear-done: da chuyen ${trashed}/${doneItems.length} file vao Thung rac`);
  }
  queue = queue.filter(q => q.status !== 'done');
  saveQueue(); broadcast();
  return { cleared: doneItems.length, trashed };
}
function removeItem(id) {
  const it = queue.find(q => q.id === id);
  if (it && it.proc) { try { it.proc.kill(); } catch {} }
  queue = queue.filter(q => q.id !== id);
  saveQueue(); broadcast();
}
// Xoá NHIỀU video 1 lần (nhanh, chỉ 1 lần save+broadcast). ids=[] -> xoá theo danh sách;
// hoặc status='stopped' -> xoá tất cả video có trạng thái đó.
function removeMany(ids, status) {
  const idSet = new Set(ids || []);
  let removed = 0;
  const keep = [];
  for (const q of queue) {
    const match = (idSet.size && idSet.has(q.id)) || (status && q.status === status);
    if (match) {
      if (q.proc) { try { q.proc.kill(); } catch {} }
      removed++;
    } else keep.push(q);
  }
  queue = keep;
  saveQueue(); broadcast();
  return removed;
}
function retryItem(id) {
  const it = queue.find(q => q.id === id);
  if (it && (it.status === 'error' || it.status === 'stopped')) { it.status = 'pending'; it.error = null; it.retries = 0; saveQueue(); broadcast(); pump(); }
}
function retryAllErrors() {
  let n = 0;
  for (const q of queue) if (q.status === 'error' || q.status === 'stopped') {
    q.status = 'pending'; q.error = null; q.retries = 0; n++;
  }
  consecutiveFailures = 0; // reset counter when user manually retries
  saveQueue(); broadcast(); pump();
  return n;
}

// Smart pause: nếu N video liên tiếp fail cùng error pattern → tự pause
let consecutiveFailures = 0;
let lastErrorPattern = '';
const FAIL_THRESHOLD = 5;
function checkSmartPause(errorMsg) {
  const sig = String(errorMsg || '').slice(0, 80);
  if (sig === lastErrorPattern) {
    consecutiveFailures++;
  } else {
    consecutiveFailures = 1;
    lastErrorPattern = sig;
  }
  if (consecutiveFailures >= FAIL_THRESHOLD) {
    log(`[smart-pause] ${consecutiveFailures} consecutive fails with same error → pausing queue`);
    // pause: chuyển mọi pending → stopped, smart_paused flag
    for (const q of queue) if (q.status === 'pending') { q.status = 'stopped'; q.error = q.error || 'Auto-paused do quá nhiều lỗi liên tiếp'; }
    consecutiveFailures = 0;
    saveQueue(); broadcast();
  }
}

// ---------- HTTP ----------
function readBody(req) {
  return new Promise(resolve => { const c = []; req.on('data', x => c.push(x)); req.on('end', () => {
    let s = Buffer.concat(c).toString('utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // strip BOM
    resolve(s);
  }); });
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${cfg.port}`);
  const isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  if (!isLocal) { res.writeHead(403); res.end('local only'); return; }

  try {
    if (u.pathname === '/' || u.pathname === '/ui') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(ROOT, 'public', 'ui.html'), 'utf8')); return;
    }
    if (u.pathname.startsWith('/sounds/')) {
      const sf = path.join(ROOT, 'sounds', u.pathname.replace('/sounds/',''));
      if (fs.existsSync(sf)) {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' });
        fs.createReadStream(sf).pipe(res); return;
      }
      res.writeHead(404); res.end('not found'); return;
    }
    if (u.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(queue.map(({ proc, ...r }) => r))}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (u.pathname === '/api/preview' && req.method === 'POST') {
      const { url } = JSON.parse(await readBody(req) || '{}');
      if (!url) return json(res, 400, { error: 'missing url' });
      const m = await engine.fetchMetadata(url);
      return json(res, m.ok ? 200 : 422, m.ok ? m.meta : { error: m.error });
    }
    if (u.pathname === '/api/start-all' && req.method === 'POST') {
      const n = startAll();
      return json(res, 200, { ok: true, started: n });
    }
    if (u.pathname === '/api/retry-all-errors' && req.method === 'POST') {
      const n = retryAllErrors();
      return json(res, 200, { ok: true, retried: n });
    }
    if (u.pathname === '/api/self-update' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'Connection':'keep-alive' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const sendLog = (s) => send({ log: s });
      try {
        sendLog('🔍 Lấy thông tin bản mới nhất...');
        const https = require('https');
        const rel = await new Promise((resolve, reject) => {
          https.get('https://api.github.com/repos/mra297/veu-tools/releases/latest', { headers:{'User-Agent':'VeuTools'} }, (r) => {
            let body=''; r.on('data', c=>body+=c); r.on('end', () => { try { resolve(JSON.parse(body)); } catch(e){ reject(e); } });
          }).on('error', reject);
        });
        const latestTag = rel.tag_name;
        const asset = (rel.assets||[]).find(a => /\.zip$/i.test(a.name));
        if (!asset) { send({ status:'error', message:'Không tìm thấy zip' }); res.end(); return; }
        sendLog(`Bản mới: ${latestTag}`);
        const verFile = path.join(__dirname, '.veu-version');
        let curVer = ''; try { curVer = fs.readFileSync(verFile, 'utf8').trim(); } catch {}
        if (curVer === latestTag) {
          send({ status:'noupdate', message:`Đã ở bản mới nhất (${curVer})` });
          res.end(); return;
        }
        sendLog(`⬇️ Tải ${(asset.size/1024).toFixed(0)} KB...`);
        const tmpZip = path.join(__dirname, '..', '_veu-update.zip');
        await new Promise((resolve, reject) => {
          const file = fs.createWriteStream(tmpZip);
          const dr = (uu, rc=0) => {
            if (rc>5) return reject(new Error('redirects'));
            https.get(uu, { headers:{'User-Agent':'VeuTools'} }, r => {
              if (r.statusCode>=300 && r.statusCode<400 && r.headers.location) return dr(r.headers.location, rc+1);
              if (r.statusCode!==200) return reject(new Error('HTTP '+r.statusCode));
              r.pipe(file);
              file.on('finish', () => { file.close(); resolve(); });
            }).on('error', reject);
          };
          dr(asset.browser_download_url);
        });
        sendLog('📦 Giải nén...');
        const extractDir = path.join(__dirname, '..', '_veu-update-extract');
        if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive:true, force:true });
        const { spawn } = require('child_process');
        await new Promise((resolve, reject) => {
          const ps = spawn('powershell.exe', ['-NoProfile','-Command',`Expand-Archive -Path '${tmpZip}' -DestinationPath '${extractDir}' -Force`], { windowsHide:true });
          ps.on('close', code => code===0?resolve():reject(new Error('extract failed')));
        });
        const base = path.join(__dirname, '..');
        const copyR = (s, d) => {
          if (!fs.existsSync(s)) return;
          if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive:true });
          for (const f of fs.readdirSync(s)) {
            const ss = path.join(s, f), dd = path.join(d, f);
            if (fs.statSync(ss).isDirectory()) copyR(ss, dd);
            else { try { fs.copyFileSync(ss, dd); } catch(e) { sendLog(`⚠️ ${f}: ${e.message}`); } }
          }
        };
        for (const app of ['yt-notifier-app', 'media-downloader']) {
          const ssrc = path.join(extractDir, app);
          if (fs.existsSync(ssrc)) { sendLog(`• ${app}/`); copyR(ssrc, path.join(base, app)); }
        }
        sendLog('⬇️ Cập nhật yt-dlp.exe...');
        const dlYt = (target) => new Promise((resolve) => {
          const f = fs.createWriteStream(target+'.tmp');
          const dr2 = (uu, rc=0) => {
            if (rc>5) return resolve({ok:false});
            https.get(uu, { headers:{'User-Agent':'VeuTools'} }, r => {
              if (r.statusCode>=300 && r.statusCode<400 && r.headers.location) return dr2(r.headers.location, rc+1);
              if (r.statusCode!==200) return resolve({ok:false});
              r.pipe(f); f.on('finish', () => { f.close(); try { fs.renameSync(target+'.tmp', target); resolve({ok:true}); } catch{ resolve({ok:false}); } });
            }).on('error', () => resolve({ok:false}));
          };
          dr2('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe');
        });
        for (const app of ['yt-notifier-app','media-downloader']) {
          const t = path.join(base, app, 'bin', 'yt-dlp.exe');
          if (fs.existsSync(path.dirname(t))) { const r = await dlYt(t); if (r.ok) sendLog(`✓ ${app}/bin/yt-dlp.exe`); }
        }
        try { fs.writeFileSync(verFile, latestTag); } catch {}
        try { fs.unlinkSync(tmpZip); } catch {}
        try { fs.rmSync(extractDir, { recursive:true, force:true }); } catch {}
        sendLog('🔄 Khởi động lại...');
        send({ status:'done', message:`Đã cập nhật lên ${latestTag}. Restart trong 3s.` });
        res.end();
        setTimeout(() => {
          try {
            const nVbs = path.join(base, 'yt-notifier-app','bin','_launcher.vbs');
            const dVbs = path.join(base, 'media-downloader','bin','_launcher.vbs');
            if (fs.existsSync(nVbs)) spawn('wscript.exe', [nVbs], { detached:true, stdio:'ignore' }).unref();
            if (fs.existsSync(dVbs)) spawn('wscript.exe', [dVbs], { detached:true, stdio:'ignore' }).unref();
            setTimeout(() => process.exit(0), 1000);
          } catch {}
        }, 3000);
        return;
      } catch(e) { try { send({ status:'error', message:e.message }); res.end(); } catch{} return; }
    }
    if (u.pathname === '/api/clear-cache' && req.method === 'POST') {
      const targets = [path.join(__dirname, 'app.log'), path.join(__dirname, 'errors.log')];
      let deleted = 0, totalSize = 0;
      for (const f of targets) {
        try {
          if (fs.existsSync(f)) { totalSize += fs.statSync(f).size; fs.unlinkSync(f); deleted++; }
        } catch {}
      }
      // Cleanup queue: xoá item status=done > 30 ngày
      const cutoff = Date.now() - 30*24*3600*1000;
      const before = queue.length;
      queue = queue.filter(it => !(it.status === 'done' && (it.addedAt || 0) < cutoff));
      const cleanedItems = before - queue.length;
      if (cleanedItems > 0) { saveQueue(); broadcast(); }
      const freed = totalSize > 1048576 ? (totalSize/1048576).toFixed(1)+' MB' : (totalSize/1024).toFixed(1)+' KB';
      return json(res, 200, { ok: true, deleted, cleanedItems, freed });
    }
    if (u.pathname === '/api/env-check' && req.method === 'GET') {
      const result = await envCheck();
      return json(res, 200, result);
    }
    if (u.pathname === '/api/env-update' && req.method === 'POST') {
      json(res, 200, { ok: true, started: true });
      envUpdate().catch(e => envBroadcast({ step:'error', msg: e.message }));
      return;
    }
    if (u.pathname === '/api/env-events') {
      res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'Connection':'keep-alive' });
      res.write('\n'); envClients.push(res);
      req.on('close', () => { const i=envClients.indexOf(res); if(i>=0) envClients.splice(i,1); });
      return;
    }
    const startMatch = u.pathname.match(/^\/api\/start\/(\d+)$/);
    if (startMatch && req.method === 'POST') {
      const ok = startItem(parseInt(startMatch[1]));
      return json(res, ok?200:404, { ok });
    }
    if (u.pathname === '/api/expand' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.url) return json(res, 400, { error: 'missing url' });
      const limit = body.limit || 50;
      const r = await engine.expandChannel(body.url, limit);
      if (!r.ok) return json(res, 422, { error: r.error });
      // apply filters
      let entries = r.entries;
      const f = body.filters || {};
      // type filter works on flat data
      if (f.videoType === 'shorts') entries = entries.filter(e => e.isShort);
      else if (f.videoType === 'long') entries = entries.filter(e => !e.isShort);
      // global platform/kind filter (from top dropdown)
      if (f.platform && f.platform !== 'all') {
        const p = f.platform;
        entries = entries.filter(e => {
          const ep = engine.detectPlatform(e.url);
          return ep === p;
        });
      }
      if (f.kind && f.kind !== 'all') {
        if (f.kind === 'shorts') entries = entries.filter(e => e.isShort);
        else if (f.kind === 'long') entries = entries.filter(e => !e.isShort);
        // other kinds (live/reels/photo) need deep metadata — leave as-is for flat scan
      }
      // view filter needs deep metadata (flat-playlist has viewCount=0)
      let deepScanned = 0, deepSkipped = 0;
      if (f.minViews && f.minViews > 0) {
        const DEEP_LIMIT = 30; // cap deep scan to avoid huge waits
        const toScan = entries.slice(0, DEEP_LIMIT);
        deepSkipped = entries.length - toScan.length;
        const deep = [];
        for (const e of toScan) {
          const m = await engine.fetchMetadata(e.url);
          deepScanned++;
          if (m.ok) {
            e.viewCount = m.meta.viewCount;
            e.likeCount = m.meta.likeCount;
            e.uploadDate = m.meta.uploadDate;
            if (m.meta.viewCount >= f.minViews) deep.push(e);
          }
        }
        entries = deep;
      }
      return json(res, 200, { ok: true, channelTitle: r.channelTitle, total: r.count, filtered: entries.length, entries, deepScanned, deepSkipped });
    }
    if (u.pathname === '/api/add' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      // accept either `urls` (array of strings) or `entries` (array of {url, title, uploader, thumbnail, platform})
      const items = Array.isArray(body.entries) && body.entries.length
        ? body.entries
        : (Array.isArray(body.urls) ? body.urls : [body.url]).filter(Boolean).map(u => ({ url: u }));
      const quality = body.quality || cfg.defaultQuality;
      const skipDup = body.skipDup !== false;
      let added = 0, skipped = 0;
      const addedItems = [];
      for (const it of items) {
        if (!it.url) continue;
        if (skipDup && isDownloaded(it.url)) { skipped++; continue; }
        const newItem = addToQueue(it.url, quality, { title: it.title, uploader: it.uploader, thumbnail: it.thumbnail, platform: it.platform, subdir: it.subdir || it.subfolder, customFilename: it.customFilename }, { dlThumb: body.dlThumb });
        if (newItem && it.notify) newItem.notify = it.notify;
        added++;
        if (newItem) addedItems.push(newItem.id);
      }
      // autoStart: skip queued status, tải ngay
      if (body.autoStart) {
        for (const id of addedItems) startItem(id);
      }
      return json(res, 200, { ok: true, added, skipped, started: body.autoStart ? addedItems.length : 0 });
    }
    if (u.pathname === '/api/stop' && req.method === 'POST') { stopAll(); return json(res, 200, { ok: true }); }
    if (u.pathname === '/api/clear-done' && req.method === 'POST') { const b = JSON.parse(await readBody(req) || '{}'); const r = clearDone(!!b.deleteFiles); return json(res, 200, { ok: true, ...r }); }
    const rmM = u.pathname.match(/^\/api\/remove\/(\d+)$/);
    if (rmM && req.method === 'POST') { removeItem(parseInt(rmM[1])); return json(res, 200, { ok: true }); }
    if (u.pathname === '/api/remove-many' && req.method === 'POST') {
      const rmBody = JSON.parse(await readBody(req) || '{}');
      const removed = removeMany(rmBody.ids, rmBody.status);
      return json(res, 200, { ok: true, removed });
    }
    const rtM = u.pathname.match(/^\/api\/retry\/(\d+)$/);
    if (rtM && req.method === 'POST') { retryItem(parseInt(rtM[1])); return json(res, 200, { ok: true }); }
    if (u.pathname === '/api/open-folder' && req.method === 'POST') {
      const { spawn } = require('child_process');
      const d = getDownloadDir();
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      spawn('explorer.exe', [d], { detached: true, stdio: 'ignore' }).unref();
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/api/list-folder' && req.method === 'GET') {
      const p = u.searchParams.get('path') || '';
      try {
        // root: return drives
        if (!p) {
          const drives = [];
          for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
            const drive = letter + ':\\';
            try {
              if (fs.existsSync(drive)) {
                let free = 0;
                try { const s = fs.statfsSync(drive); free = Math.round(s.bavail * s.bsize / 1024 / 1024 / 1024); } catch {}
                drives.push({ name: `${letter}: ${free>0?'('+free+'GB free)':''}`, path: drive, isDir: true });
              }
            } catch {}
          }
          return json(res, 200, { path: '', parent: null, items: drives });
        }
        const items = fs.readdirSync(p, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .filter(d => !d.name.startsWith('.') && d.name !== 'System Volume Information' && d.name !== '$RECYCLE.BIN')
          .map(d => ({ name: d.name, path: path.join(p, d.name), isDir: true }))
          .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
        const parent = path.dirname(p);
        return json(res, 200, { path: p, parent: parent === p ? '' : parent, items });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (u.pathname === '/api/create-folder' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.parent || !body.name) return json(res, 400, { error: 'missing parent/name' });
      const safe = body.name.replace(/[<>:"/\\|?*]/g, '_');
      const full = path.join(body.parent, safe);
      try { fs.mkdirSync(full, { recursive: true }); return json(res, 200, { ok: true, path: full }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (u.pathname === '/api/pick-folder' && req.method === 'POST') {
      const { spawn } = require('child_process');
      const os = require('os');
      // Use VBScript Shell.BrowseForFolder — gives Windows tree picker, opens in ~0.5-1s
      const vbs = `Set sh = CreateObject("Shell.Application")\r\nSet f = sh.BrowseForFolder(0, "Chon thu muc luu video", &H10 Or &H40, 17)\r\nIf Not (f Is Nothing) Then WScript.Echo f.Self.Path`;
      const tmp = path.join(os.tmpdir(), 'pick_folder_' + Date.now() + '.vbs');
      try { fs.writeFileSync(tmp, vbs, 'utf8'); } catch (e) { return json(res, 500, { error: e.message }); }
      const r = await new Promise(resolve => {
        const p = spawn('cscript.exe', ['//Nologo', tmp], { windowsHide: true });
        let out = '';
        p.stdout.on('data', d => out += d.toString());
        p.on('exit', () => resolve(out.trim()));
        p.on('error', () => resolve(''));
      });
      try { fs.unlinkSync(tmp); } catch {}
      if (r) return json(res, 200, { ok: true, path: r });
      return json(res, 200, { ok: false, cancelled: true });
    }
    // === Capcut endpoints ===
    if (u.pathname === '/api/capcut/templates' && req.method === 'GET') {
      try { return json(res, 200, capcut.listTemplates()); }
      catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (u.pathname === '/api/capcut/inject' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req) || '{}');
        if (!body.templateId || !body.videoPath) return json(res, 400, { error: 'thiếu templateId hoặc videoPath' });
        const r = capcut.injectVideo(body.templateId, body.videoPath, body.projectName);
        if (body.openCapcut) capcut.openCapcut();
        return json(res, 200, r);
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (u.pathname === '/api/capcut/open' && req.method === 'POST') {
      try { return json(res, 200, capcut.openCapcut()); }
      catch (e) { return json(res, 500, { error: e.message }); }
    }

    if (u.pathname === '/api/settings' && req.method === 'GET') {
      return json(res, 200, { downloadsDir: cfg.downloadsDir, resolvedDir: getDownloadDir(), maxConcurrent: cfg.maxConcurrent });
    }
    if (u.pathname === '/api/settings' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (body.downloadsDir && body.downloadsDir.trim()) {
        cfg.downloadsDir = body.downloadsDir.trim();
      }
      if (body.maxConcurrent) cfg.maxConcurrent = Math.max(1, Math.min(5, parseInt(body.maxConcurrent) || 2));
      fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
      const d = getDownloadDir();
      if (!fs.existsSync(d)) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) { return json(res, 400, { error: 'Không tạo được thư mục: ' + e.message }); } }
      log('settings updated: dir=' + cfg.downloadsDir);
      return json(res, 200, { ok: true, resolvedDir: d });
    }
    res.writeHead(404); res.end('not found');
  } catch (e) { log('http err', e.message); json(res, 500, { error: e.message }); }
});

loadQueue();
// ---------- Notify Telegram khi tải xong (cho video click từ Telegram) ----------
async function notifyTelegramDone(item) {
  const body = JSON.stringify({
    chatId: item.notify.tgChatId,
    replyTo: item.notify.tgMsgId,
    autoMode: !!item.notify.autoMode,
    title: item.title || 'Video',
    file: item.file,
    quality: item.quality,
  });
  return new Promise((resolve) => {
    const req = require('http').request({
      method: 'POST', hostname: '127.0.0.1', port: 8765, path: '/api/notify-download-done',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    }, res => { res.on('data',()=>{}); res.on('end',resolve); });
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(body); req.end();
  });
}

// Báo Telegram khi tải FAIL (qua Notifier endpoint)
async function notifyTelegramFail(item) {
  const body = JSON.stringify({
    title: item.title || 'Video',
    uploader: item.uploader || '',
    url: item.url || '',
    error: item.error || '',
    retries: item.retries || 0,
  });
  return new Promise((resolve) => {
    const req = require('http').request({
      method: 'POST', hostname: '127.0.0.1', port: 8765, path: '/api/notify-download-fail',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    }, res => { res.on('data',()=>{}); res.on('end',resolve); });
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(body); req.end();
  });
}

// ---------- Environment check & update ----------
const APPS_ENV = {
  notifier:   { name: 'Veu Notifier',   folder: 'C:\\Users\\tungb\\.openclaw\\workspace-main\\yt-notifier-app' },
  downloader: { name: 'Veu Downloader', folder: __dirname },
};
const envClients = [];
function envBroadcast(ev) { const data = `data: ${JSON.stringify(ev)}\n\n`; for (const c of envClients) { try { c.write(data); } catch {} } }

function _envExec(cmd, args=[], opts={}) {
  const { spawn } = require('child_process');
  return new Promise(resolve => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let out='', err='';
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('error', e => resolve({ ok:false, error: e.message }));
    p.on('exit', code => resolve({ ok: code===0, code, out: out.trim(), err: err.trim() }));
  });
}
function _envHttpsJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    require('https').get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent':'Veu-Downloader/1.0' }}, res => {
      let body=''; res.on('data', d=>body+=d); res.on('end', () => { try{ resolve(JSON.parse(body)); }catch(e){reject(e);} });
    }).on('error', reject);
  });
}

async function envCheck() {
  const ytdlp = await _envExec('yt-dlp', ['--version']);
  let ytLatest = null;
  try { const r = await _envHttpsJson('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'); ytLatest = r.tag_name || null; } catch {}
  const ffmpeg = await _envExec('ffmpeg', ['-version']);
  const ffVer = ffmpeg.ok ? (ffmpeg.out.match(/ffmpeg version ([\w.-]+)/)||[])[1] : null;

  const drives = [];
  for (const letter of ['C','D','E','F']) {
    try { if (fs.existsSync(letter+':\\')) { const s = fs.statfsSync(letter+':\\'); drives.push({ drive: letter+':', freeGB: Math.round(s.bavail*s.bsize/1073741824) }); } } catch {}
  }

  return {
    tools: [
      { name: 'yt-dlp', installed: ytdlp.ok ? ytdlp.out : null, latest: ytLatest, status: ytdlp.ok ? (ytLatest && ytdlp.out === ytLatest ? 'up-to-date' : 'outdated') : 'missing' },
      { name: 'ffmpeg', installed: ffVer, status: ffVer ? 'installed' : 'missing' },
      { name: 'Node.js', installed: process.version, status: 'installed' },
    ],
    apps: Object.entries(APPS_ENV).map(([k,a]) => {
      let v = null, electron = null;
      try { v = JSON.parse(fs.readFileSync(path.join(a.folder,'package.json'),'utf8')).version; } catch {}
      try { electron = JSON.parse(fs.readFileSync(path.join(a.folder,'node_modules','electron','package.json'),'utf8')).version; } catch {}
      return { key:k, name: a.name, version: v, electron };
    }),
    drives,
    timestamp: Date.now(),
  };
}

async function envUpdate() {
  const steps = [];
  const tick = (key, status, msg) => { steps.push({ key, status, msg }); envBroadcast({ step:'tick', key, status, msg, allSteps: steps }); };
  envBroadcast({ step:'start' });

  // 1. yt-dlp self-update
  tick('ytdlp','running','Đang check yt-dlp...');
  try {
    const cur = await _envExec('yt-dlp', ['--version']);
    if (!cur.ok) { tick('ytdlp','fail','❌ yt-dlp chưa cài. Tải: https://github.com/yt-dlp/yt-dlp/releases'); }
    else {
      let latest = null; try { const r = await _envHttpsJson('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'); latest = r.tag_name; } catch {}
      if (latest && cur.out === latest) tick('ytdlp','done',`✅ yt-dlp đã bản mới nhất (${cur.out})`);
      else {
        tick('ytdlp','running',`⚡ Đang update yt-dlp ${cur.out} → ${latest||'latest'}...`);
        // Try yt-dlp -U first; if it complains about pip → fallback to pip install -U
        let r = await _envExec('yt-dlp', ['-U']);
        if (!r.ok || /pip|wheel|PyPi/i.test(r.err + r.out)) {
          tick('ytdlp','running','↪️ Detect cài qua pip → dùng pip install -U yt-dlp...');
          r = await _envExec('cmd.exe', ['/c','python','-m','pip','install','-U','yt-dlp','--quiet']);
        }
        tick('ytdlp', r.ok ? 'done':'fail', r.ok ? `✅ yt-dlp đã update lên ${latest||'mới'}` : `❌ ${(r.err||r.out).slice(-200)}`);
      }
    }
  } catch (e) { tick('ytdlp','fail','❌ '+e.message); }

  // 2. ffmpeg
  tick('ffmpeg','running','Đang check ffmpeg...');
  const ff = await _envExec('ffmpeg', ['-version']);
  if (ff.ok) tick('ffmpeg','done','✅ ffmpeg đã cài');
  else tick('ffmpeg','fail','❌ ffmpeg chưa cài. Tải: https://www.gyan.dev/ffmpeg/builds/');

  // 3-4. npm update cho 2 app
  // Resolve npm.cmd path (Electron không kế thừa PATH gốc)
  const fs2 = require('fs');
  const npmCandidates = [
    'C:\\Program Files\\nodejs\\npm.cmd',
    'C:\\Program Files (x86)\\nodejs\\npm.cmd',
    require('path').join(process.env.APPDATA || '', 'npm', 'npm.cmd'),
    require('path').join(process.env.USERPROFILE || '', 'AppData', 'Roaming', 'crawbot', 'nodejs', 'npm.cmd')
  ];
  const npmCmd = npmCandidates.find(p => p && fs2.existsSync(p)) || 'npm.cmd';
  for (const [key, app] of Object.entries(APPS_ENV)) {
    tick(key,'running',`Đang npm update ${app.name}...`);
    const r = await _envExec(npmCmd, ['update','--no-audit','--no-fund'], { cwd: app.folder, shell: true });
    if (r.ok) tick(key,'done',`✅ ${app.name}: dependencies up-to-date`);
    else tick(key,'fail',`⚠️ ${app.name}: ${(r.err||r.out).slice(-200)}`);
  }

  envBroadcast({ step:'finish', summary: steps });
}

server.listen(cfg.port, '127.0.0.1', () => log(`Media Downloader on http://127.0.0.1:${cfg.port}`));
setTimeout(pump, 1000); // resume pending after restart

// ===== Auto-update yt-dlp lúc khởi động (chạy nền, không chặn app) =====
function autoUpdateYtDlp() {
  try {
    const { execFile } = require('child_process');
    const exe = engine.resolveYtDlp ? engine.resolveYtDlp() : path.join(ROOT, 'bin', 'yt-dlp.exe');
    if (!exe || (!fs.existsSync(exe) && exe.includes('\\'))) { log('[auto-update] khong tim thay yt-dlp, bo qua'); return; }
    log('[auto-update] Dang kiem tra ban moi yt-dlp...');
    execFile(exe, ['-U'], { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
      const out = ((stdout || '') + (stderr || '')).trim();
      if (/is up to date|already.*latest/i.test(out)) log('[auto-update] yt-dlp da la ban moi nhat');
      else if (/Updated|Updating to/i.test(out)) log('[auto-update] yt-dlp DA UPDATE: ' + out.slice(-120));
      else if (err) log('[auto-update] loi (bo qua): ' + (err.message || '').slice(0, 120));
      else log('[auto-update] ket qua: ' + out.slice(-120));
    });
  } catch (e) { log('[auto-update] exception: ' + e.message); }
}
setTimeout(autoUpdateYtDlp, 4000); // chờ app ổn định 4s rồi mới check update

process.on('SIGINT', () => { stopAll(); process.exit(0); });
process.on('SIGTERM', () => { stopAll(); process.exit(0); });
