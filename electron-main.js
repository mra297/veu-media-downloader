// Electron main process — wraps Veu Media Downloader
const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, shell, nativeImage, Notification } = require('electron');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
const path = require('path');
const fs = require('fs');

// ===== Cập nhật app qua GitHub Releases — POPUP đẹp giữa màn hình =====
let _updater = null;
let _updateInfo = null;
let updateWin = null;
function ulog(msg) { try { fs.appendFileSync(path.join(__dirname, 'electron.log'), `[${new Date().toISOString()}] ${msg}\n`); } catch {} }
function sendToUpdateWin(fn, arg) {
  if (updateWin && !updateWin.isDestroyed()) {
    updateWin.webContents.executeJavaScript(`window.${fn} && window.${fn}(${JSON.stringify(arg)})`).catch(() => {});
  }
}
function openUpdateWindow(info) {
  if (updateWin && !updateWin.isDestroyed()) { updateWin.focus(); return; }
  updateWin = new BrowserWindow({
    width: 560, height: 520, resizable: false, minimizable: false, maximizable: false,
    title: 'Cập nhật Veu Downloader', parent: mainWindow || undefined, modal: false,
    icon: fs.existsSync(ICON) ? ICON : undefined, backgroundColor: '#ffffff',
    webPreferences: { preload: path.join(__dirname, 'preload-update.js'), contextIsolation: true, nodeIntegration: false },
  });
  updateWin.setMenuBarVisibility(false);
  updateWin.loadFile(path.join(__dirname, 'public', 'update.html'));
  updateWin.webContents.on('did-finish-load', () => {
    sendToUpdateWin('_updInfo', { version: info.version, notes: (info.releaseNotes && typeof info.releaseNotes === 'string') ? info.releaseNotes.replace(/<[^>]+>/g, '') : '' });
  });
  updateWin.on('closed', () => { updateWin = null; });
}
function setupAutoUpdater() {
  try {
    const { autoUpdater } = require('electron-updater');
    _updater = autoUpdater;
    autoUpdater.autoDownload = false;          // KHÔNG tự tải — chờ bấm nút trong popup
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (info) => {
      _updateInfo = info;
      ulog('update-available: ' + info.version);
      openUpdateWindow(info);                   // Hiện POPUP giữa màn hình
    });
    autoUpdater.on('download-progress', (p) => { sendToUpdateWin('_updProgress', Math.round(p.percent)); });
    autoUpdater.on('update-downloaded', (info) => { ulog('update-downloaded: ' + info.version); sendToUpdateWin('_updDownloaded', info.version); });
    autoUpdater.on('error', (err) => { ulog('updater err: ' + err.message); sendToUpdateWin('_updError', String(err.message || err)); });
    setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 6000);
    setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 2 * 60 * 60 * 1000);
  } catch (e) {
    ulog('setupAutoUpdater fail: ' + e.message);
  }
}

// Set app identity (Windows notification header + taskbar)
app.setName('Veu Downloader');
if (process.platform === 'win32') app.setAppUserModelId('com.veu.downloader');

let mainWindow = null;
let tray = null;
let serverStarted = false;

// Start the Node server in-process — but only if port 8770 is not already in use
function startServer() {
  if (serverStarted) return;
  const net = require('net');
  const tester = net.createConnection({ host: '127.0.0.1', port: 8770 }, () => {
    tester.end();
    serverStarted = true;
    console.log('server already running on 8770, skipping');
  });
  tester.on('error', () => {
    serverStarted = true;
    try {
      require('./server.js');
      console.log('server.js loaded OK');
    } catch (e) {
      console.error('SERVER LOAD FAIL:', e.stack || e.message);
      try {
        fs.appendFileSync(path.join(__dirname, 'electron.log'),
          `[${new Date().toISOString()}] SERVER FAIL:\n${e.stack || e.message}\n\n`);
      } catch {}
    }
  });
}

// Wait until port 8770 responds, then load UI. Retry until 30s, show error if fail.
function waitServerThenLoad() {
  if (!mainWindow) return;
  let attempts = 0;
  const maxAttempts = 60; // 60 × 500ms = 30s
  const tryLoad = () => {
    attempts++;
    const net = require('net');
    const t = net.createConnection({ host: '127.0.0.1', port: 8770 }, () => {
      t.end();
      mainWindow.loadURL('http://127.0.0.1:8770/ui');
    });
    t.on('error', () => {
      if (attempts >= maxAttempts) {
        const errMsg = `<h2 style="font-family:sans-serif;padding:30px;color:#e6e9ef;background:#1a1f29">
          ❌ Server (port 8770) khong khoi dong duoc sau 30s<br><br>
          <p style="color:#9ca3af;font-size:14px">Co the do:</p>
          <ul style="color:#9ca3af;font-size:14px">
            <li>Node.js chua cai dat dung</li>
            <li>node_modules bi loi (chay: <code>npm install</code> trong folder media-downloader)</li>
            <li>Port 8770 bi app khac chiem</li>
          </ul>
          <p>Mo file <code>electron.log</code> trong folder app de xem chi tiet loi.</p>
        </h2>`;
        mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errMsg));
        return;
      }
      setTimeout(tryLoad, 500);
    });
  };
  tryLoad();
}

const ICON = path.join(__dirname, 'icon.ico');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000, height: 720, minWidth: 700, minHeight: 500,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    title: 'Veu Downloader',
    backgroundColor: '#0f1419',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setBackgroundThrottling(false);
  // Mở external link trong browser ngoài
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Smart wait — retry until server responds (up to 30s), show error if fail
  waitServerThenLoad();
  mainWindow.on('close', (e) => {
    if (!app.isQuiting) { e.preventDefault(); mainWindow.hide(); }
  });
}

function createTray() {
  const img = fs.existsSync(ICON) ? nativeImage.createFromPath(ICON) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('Veu Media Downloader');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '🌐 Mở giao diện', click: () => { mainWindow ? mainWindow.show() : createWindow(); } },
    { label: '📂 Mở thư mục tải', click: () => shell.openPath(path.join(__dirname, 'downloads')) },
    { type: 'separator' },
    { label: '❌ Thoát', click: () => { app.isQuiting = true; app.quit(); } },
  ]));
  tray.on('click', () => { mainWindow ? (mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show()) : createWindow(); });
}

app.whenReady().then(() => {
  // Custom HTML toast — 2s rồi tự tắt, không vào Action Center
  let toastWin = null; let toastTimer = null;
  ipcMain.handle('show-notification', async (e, opts) => {
    try {
      if (toastWin && !toastWin.isDestroyed()) { toastWin.close(); toastWin = null; }
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
      const { screen } = require('electron');
      const disp = screen.getPrimaryDisplay();
      const W = 380, H = 100;
      const x = disp.workArea.x + disp.workArea.width - W - 20;
      const y = disp.workArea.y + disp.workArea.height - H - 20;
      toastWin = new BrowserWindow({
        width: W, height: H, x, y,
        frame: false, transparent: true, resizable: false,
        alwaysOnTop: true, skipTaskbar: true, focusable: false,
        hasShadow: false, show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      });
      toastWin.setAlwaysOnTop(true, 'screen-saver');
      const iconUrl = fs.existsSync(ICON) ? 'file:///' + ICON.replace(/\\/g,'/') : '';
      const params = new URLSearchParams({
        title: opts.title || 'Veu Downloader',
        msg: opts.body || '',
        icon: iconUrl,
      });
      toastWin.loadURL('file://' + path.join(__dirname, 'public', 'toast.html').replace(/\\/g,'/') + '?' + params.toString());
      toastWin.once('ready-to-show', () => toastWin && toastWin.showInactive());
      toastTimer = setTimeout(() => { if (toastWin && !toastWin.isDestroyed()) toastWin.close(); }, 3500);
      return { ok: true };
    } catch(err) { return { ok: false, error: err.message }; }
  });

  // ===== YouTube login → xuất cookies.txt (Netscape) =====
  const COOKIE_FILE = path.join(__dirname, 'cookies.txt');
  function toNetscape(cookies) {
    let out = '# Netscape HTTP Cookie File\n# Auto-exported by Veu Downloader\n\n';
    for (const c of cookies) {
      const domain = c.domain.startsWith('.') ? c.domain : (c.hostOnly ? c.domain : '.' + c.domain);
      const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
      const secure = c.secure ? 'TRUE' : 'FALSE';
      const expiry = c.expirationDate ? Math.round(c.expirationDate) : 0;
      out += `${domain}\t${flag}\t${c.path || '/'}\t${secure}\t${expiry}\t${c.name}\t${c.value}\n`;
    }
    return out;
  }
  async function exportCookiesFromSession(ses) {
    const domains = ['youtube.com', 'google.com'];
    let all = [];
    for (const d of domains) {
      try { const cs = await ses.cookies.get({ domain: d }); all = all.concat(cs); } catch {}
    }
    // loại trùng theo name+domain
    const seen = new Set();
    all = all.filter(c => { const k = c.name + '|' + c.domain; if (seen.has(k)) return false; seen.add(k); return true; });
    if (!all.length) return { ok: false, count: 0 };
    fs.writeFileSync(COOKIE_FILE, toNetscape(all), 'utf8');
    return { ok: true, count: all.length };
  }
  ipcMain.handle('yt-login', async () => {
    return new Promise((resolve) => {
      const { session } = require('electron');
      const ses = session.fromPartition('persist:ytlogin');
      const loginWin = new BrowserWindow({
        width: 480, height: 640, title: 'Đăng nhập YouTube',
        parent: mainWindow, modal: false,
        webPreferences: { partition: 'persist:ytlogin', contextIsolation: true, nodeIntegration: false },
      });
      loginWin.setMenuBarVisibility(false);
      loginWin.loadURL('https://www.youtube.com/');
      let done = false;
      const finish = async () => {
        if (done) return; done = true;
        const r = await exportCookiesFromSession(ses).catch(() => ({ ok: false, count: 0 }));
        try { if (!loginWin.isDestroyed()) loginWin.close(); } catch {}
        resolve(r);
      };
      // Nút đóng cửa sổ = xong đăng nhập → xuất cookies
      loginWin.on('close', () => { if (!done) { done = true; exportCookiesFromSession(ses).then(r => resolve(r)).catch(() => resolve({ ok: false, count: 0 })); } });
    });
  });
  ipcMain.handle('cookies-status', async () => {
    try {
      if (!fs.existsSync(COOKIE_FILE)) return { exists: false };
      const st = fs.statSync(COOKIE_FILE);
      const lines = fs.readFileSync(COOKIE_FILE, 'utf8').split('\n').filter(l => l && !l.startsWith('#')).length;
      return { exists: true, count: lines, mtime: st.mtime };
    } catch { return { exists: false }; }
  });

  // ===== IPC cho nút Update =====
  ipcMain.handle('update-check', async () => {
    if (!_updater) return { ok: false, error: 'updater chưa sẵn sàng' };
    try { const r = await _updater.checkForUpdates(); return { ok: true, version: r && r.updateInfo ? r.updateInfo.version : null }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('update-download', async () => {
    if (!_updater) return { ok: false, error: 'updater chưa sẵn sàng' };
    try { _updater.downloadUpdate().catch(() => {}); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('update-install', async () => {
    if (!_updater) return { ok: false };
    try { app.isQuiting = true; setImmediate(() => _updater.quitAndInstall(false, true)); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('update-close', async () => {
    if (updateWin && !updateWin.isDestroyed()) updateWin.close();
    return { ok: true };
  });

  // IPC: native folder picker — INSTANT (Electron exposes Windows IFileDialog directly)
  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Chọn thư mục lưu video',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true };
    return { ok: true, path: r.filePaths[0] };
  });
  startServer();
  createWindow();
  createTray();
  setupAutoUpdater();
});

app.on('window-all-closed', (e) => {
  // keep app running in tray
  if (process.platform !== 'darwin') {/* don't quit */}
});

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else app.on('second-instance', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });

// swallow EADDRINUSE etc so user doesn't see scary popup
process.on('uncaughtException', (err) => {
  try { fs.appendFileSync(path.join(__dirname, 'electron.log'), `[${new Date().toISOString()}] ${err.stack || err}\n`); } catch {}
  if (err.code === 'EADDRINUSE') return; // server already running, ignore
});
