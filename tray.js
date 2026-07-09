const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const SysTray = require('systray2').default;

const ROOT = __dirname;
const SERVER_JS = path.join(ROOT, 'server.js');
const LOG_FILE = path.join(ROOT, 'app.log');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

let child = null;
function alog(l){ try{ fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [tray] ${l}\n`); }catch{} }
function start(){ if(child) return; child = spawn(process.execPath,[SERVER_JS],{cwd:ROOT,windowsHide:true,stdio:['ignore','pipe','pipe']}); child.stdout.on('data',d=>{try{fs.appendFileSync(LOG_FILE,d);}catch{}}); child.stderr.on('data',d=>{try{fs.appendFileSync(LOG_FILE,d);}catch{}}); child.on('exit',c=>{alog('server exit '+c);child=null;}); alog('server started'); }
function stop(){ if(child){try{child.kill();}catch{}} }

const ICON_PATH = path.join(ROOT, 'icon.ico');
const ICON_B64 = fs.existsSync(ICON_PATH) ? fs.readFileSync(ICON_PATH).toString('base64') : '';
const systray = new SysTray({
  menu: {
    icon: ICON_B64, isTemplateIcon:false, title:'Veu Downloader', tooltip:'Veu Downloader',
    items: [
      { title:'🌐 Mở giao diện', enabled:true },
      { title:'📄 Xem log', enabled:true },
      { title:'📂 Mở thư mục tải', enabled:true },
      SysTray.separator,
      { title:'❌ Thoát', enabled:true },
    ],
  }, debug:false, copyDir:true,
});
systray.onClick(a=>{
  const i=a.seq_id;
  if(i===0) spawn('cmd',['/c','start','',`http://localhost:${cfg.port}/ui`],{detached:true,stdio:'ignore'}).unref();
  else if(i===1) spawn('notepad.exe',[LOG_FILE],{detached:true,stdio:'ignore'}).unref();
  else if(i===2){ const d=path.isAbsolute(cfg.downloadsDir)?cfg.downloadsDir:path.join(ROOT,cfg.downloadsDir); if(!fs.existsSync(d))fs.mkdirSync(d,{recursive:true}); spawn('explorer.exe',[d],{detached:true,stdio:'ignore'}).unref(); }
  else if(i===4){ stop(); setTimeout(()=>{systray.kill(false);process.exit(0);},400); }
});
systray.ready().then(()=>{ alog('tray ready'); start(); }).catch(e=>{ alog('tray fail '+e.message); console.error(e); });
