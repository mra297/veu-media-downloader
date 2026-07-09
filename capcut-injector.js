// capcut-injector.js — clone Capcut template, inject video path
// Defensive: dùng regex để tìm field "path" video, không hard-code field name
// Compatible: Capcut Desktop 8.x (draft format 164-171+)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CAPCUT_PROJECTS_ROOT = path.join(process.env.LOCALAPPDATA || '', 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft');
const META_FILE = path.join(CAPCUT_PROJECTS_ROOT, 'root_meta_info.json');

function log(...a){ console.log('[capcut]', ...a); }

// UUID v4 uppercase, Capcut style
function uuid() {
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex').toUpperCase();
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

// List all templates: scan root_meta_info.json
function listTemplates() {
  if (!fs.existsSync(META_FILE)) return { error: 'Capcut chưa cài hoặc không tìm thấy folder Projects', templates: [] };
  try {
    const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    const drafts = meta.all_draft_store || [];
    const templates = drafts.map(d => ({
      id: d.draft_id,
      name: d.draft_name,
      folder: d.draft_fold_path,
      jsonFile: d.draft_json_file,
      duration: d.tm_duration,  // nanoseconds
      cover: d.draft_cover,
      modified: d.tm_draft_modified,
    })).filter(t => t.folder && fs.existsSync(t.folder));
    return { templates, root: meta.root_path, count: templates.length };
  } catch (e) { return { error: e.message, templates: [] }; }
}

// Find video paths in draft_content.json
function findVideoPaths(jsonStr) {
  const paths = [];
  // Match "path":"..." where ... ends with .mp4/.mov/.mkv/.m4v/.webm
  const re = /"path":"([^"]*\.(?:mp4|mov|mkv|m4v|webm|avi|flv|wmv))"/gi;
  let m;
  while ((m = re.exec(jsonStr)) !== null) paths.push({ index: m.index, raw: m[0], path: m[1] });
  return paths;
}

// Clone template folder + inject video
function injectVideo(templateId, newVideoPath, newProjectName) {
  if (!fs.existsSync(newVideoPath)) throw new Error('Video không tồn tại: ' + newVideoPath);
  const list = listTemplates();
  const tpl = list.templates.find(t => t.id === templateId);
  if (!tpl) throw new Error('Template không tồn tại: ' + templateId);

  const tplFolder = tpl.folder;
  const tplJsonFile = tpl.jsonFile;
  if (!fs.existsSync(tplJsonFile)) throw new Error('draft_content.json không có: ' + tplJsonFile);

  // 1. Tạo folder mới — đặt cùng root_path với template (vd F:\CapCut Drafts)
  const rootPath = path.dirname(tplFolder);
  const safeName = (newProjectName || `VEU_${Date.now()}`).replace(/[<>:"/\\|?*]/g, '_').slice(0, 80);
  const newFolder = path.join(rootPath, safeName);
  if (fs.existsSync(newFolder)) throw new Error('Folder đã tồn tại: ' + newFolder);

  // 2. Clone toàn bộ folder template → folder mới
  copyDirRecursive(tplFolder, newFolder);
  log(`Cloned ${tplFolder} -> ${newFolder}`);

  // 3. Sửa draft_content.json: thay tất cả video path → newVideoPath
  const newJsonFile = path.join(newFolder, 'draft_content.json');
  let content = fs.readFileSync(newJsonFile, 'utf8');
  // Backup
  fs.writeFileSync(newJsonFile + '.bak', content, 'utf8');

  const paths = findVideoPaths(content);
  log(`Found ${paths.length} video path(s) in template`);
  const normalized = newVideoPath.replace(/\\/g, '/');
  // Thay tất cả path video bằng path mới (giữ nguyên các path khác)
  content = content.replace(/"path":"([^"]*\.(?:mp4|mov|mkv|m4v|webm|avi|flv|wmv))"/gi, `"path":"${normalized}"`);

  // Đổi project id để không xung đột
  const newDraftId = uuid();
  // First UUID-shaped id at top-level "id":
  content = content.replace(/^(\{"id":")[0-9A-F-]{36}(")/i, `$1${newDraftId}$2`);

  fs.writeFileSync(newJsonFile, content, 'utf8');
  log(`Wrote ${newJsonFile} (${content.length} chars)`);

  // 4. Đăng ký vào root_meta_info.json để Capcut hiện trên Home
  registerInMeta({
    draft_id: newDraftId,
    draft_name: safeName,
    draft_fold_path: newFolder,
    draft_json_file: newJsonFile,
    draft_root_path: rootPath,
    draft_cover: path.join(newFolder, 'draft_cover.jpg'),
    tm_duration: tpl.duration,
    tm_draft_create: Date.now() * 1000,
    tm_draft_modified: Date.now() * 1000,
    draft_new_version: '171.0.0',
  });

  return { ok: true, newFolder, newDraftId, name: safeName, videoPathsReplaced: paths.length };
}

function registerInMeta(entry) {
  const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  const full = {
    cloud_draft_cover: false, cloud_draft_sync: false,
    draft_cloud_last_action_download: false,
    draft_cloud_purchase_info: '', draft_cloud_template_id: '',
    draft_cloud_tutorial_info: '', draft_cloud_videocut_purchase_info: '',
    draft_cover: entry.draft_cover,
    draft_fold_path: entry.draft_fold_path,
    draft_id: entry.draft_id,
    draft_is_ai_shorts: false, draft_is_cloud_temp_draft: false,
    draft_is_invisible: false, draft_is_web_article_video: false,
    draft_json_file: entry.draft_json_file,
    draft_name: entry.draft_name,
    draft_new_version: entry.draft_new_version || '171.0.0',
    draft_root_path: entry.draft_root_path,
    draft_timeline_materials_size: 0,
    draft_type: '', draft_web_article_video_enter_from: '',
    streaming_edit_draft_ready: true,
    tm_draft_cloud_completed: '',
    tm_draft_cloud_entry_id: -1, tm_draft_cloud_modified: 0,
    tm_draft_cloud_parent_entry_id: -1, tm_draft_cloud_space_id: -1,
    tm_draft_cloud_user_id: -1,
    tm_draft_create: entry.tm_draft_create,
    tm_draft_modified: entry.tm_draft_modified,
    tm_draft_removed: 0,
    tm_duration: entry.tm_duration || 0,
  };
  // Insert vào đầu để hiện đầu tiên
  meta.all_draft_store = [full, ...(meta.all_draft_store || [])];
  meta.draft_ids = (meta.draft_ids || 0) + 1;
  // Backup
  fs.writeFileSync(META_FILE + '.bak', fs.readFileSync(META_FILE, 'utf8'), 'utf8');
  fs.writeFileSync(META_FILE, JSON.stringify(meta), 'utf8');
  log(`Registered ${entry.draft_name} in root_meta_info.json`);
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function openCapcut() {
  const { spawn } = require('child_process');
  // Capcut launcher: %LOCALAPPDATA%\CapCut\Apps\CapCut.exe
  const exe = path.join(process.env.LOCALAPPDATA || '', 'CapCut', 'Apps', 'CapCut.exe');
  if (!fs.existsSync(exe)) return { ok: false, error: 'Capcut.exe không tìm thấy: ' + exe };
  spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
}

module.exports = { listTemplates, injectVideo, openCapcut, findVideoPaths, CAPCUT_PROJECTS_ROOT, META_FILE };
