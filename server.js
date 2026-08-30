// 零依赖版本 - 仅使用 Node.js 内置模块
// 本地启动: node server.js
// Vercel serverless: 见 api/index.js 调用 module.exports.handleRequest
// Render / 其他容器: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const ROOT = __dirname;

// ============== 密码：支持环境变量 ADMIN_PASSWORD ==============
function getAdminPasswordHash() {
  const pwd = process.env.ADMIN_PASSWORD || '522428';
  return crypto.createHash('sha256').update(pwd).digest('hex');
}

// ============== 会话（内存中，重启/冷启动会重置） ==============
const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000;

function generateSessionToken() { return crypto.randomBytes(32).toString('hex'); }
function verifySession(req) {
  const cookies = req.headers['cookie'] || '';
  const m = cookies.match(/grsy_session=([^;]+)/);
  if (!m) return false;
  const token = m[1];
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() - s.createdAt > SESSION_TTL) { sessions.delete(token); return false; }
  return true;
}

// ============== 目录回退（可写性探测） ==============
function isDirectoryWritable(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const t = path.join(dir, '.w_' + Date.now() + Math.random());
    fs.writeFileSync(t, 'x'); fs.unlinkSync(t); return true;
  } catch (e) { return false; }
}
function requireDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); return d; }

function getUploadDir() {
  const osTmp = require('os').tmpdir();
  // 部署环境优先 tmp；本地开发优先项目 uploads/
  const candidates = (process.env.VERCEL || process.env.RENDER || process.env.GITHUB_TOKEN)
    ? [path.join(osTmp, 'grsy_uploads')]
    : [path.join(ROOT, 'uploads'), path.join(osTmp, 'grsy_uploads')];
  for (const d of candidates) if (isDirectoryWritable(d)) return requireDir(d);
  return requireDir(candidates[0]);
}
function getDataDir() {
  const osTmp = require('os').tmpdir();
  const candidates = (process.env.VERCEL || process.env.RENDER || process.env.GITHUB_TOKEN)
    ? [path.join(osTmp, 'grsy_data')]
    : [path.join(ROOT, 'data'), path.join(osTmp, 'grsy_data')];
  for (const d of candidates) if (isDirectoryWritable(d)) return requireDir(d);
  return requireDir(candidates[0]);
}

const UPLOAD_DIR = getUploadDir();
const DATA_DIR = getDataDir();
const DATA_FILE = path.join(DATA_DIR, 'works.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
requireDir(UPLOAD_DIR); requireDir(DATA_DIR);
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));

function readWorks() { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); } catch (e) { return []; } }
function writeWorks(works) {
  const data = JSON.stringify(works, null, 2);
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, data, 'utf-8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    try { fs.writeFileSync(DATA_FILE, data, 'utf-8'); } catch (_) {}
  }
}

// ============== GitHub 同步（Vercel/Render 冷启动数据不丢的关键） ==============
let __restored = false;
const GH_API = 'https://api.github.com';
function ghHeaders(acceptRaw) {
  return {
    'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
    'User-Agent': 'grsy-photography',
    'Accept': acceptRaw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}
async function ghSyncPut(filepath, content, isBinary) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) return { skipped: true };
  const url = `${GH_API}/repos/${repo}/contents/${filepath}`;
  let sha = null;
  try {
    const r = await fetch(url, { headers: ghHeaders(false) });
    if (r.ok) { const j = await r.json(); sha = j.sha; }
  } catch (_) {}
  const payload = { message: `sync ${filepath} ${Date.now()}`, branch: 'main' };
  if (Buffer.isBuffer(content)) {
    payload.content = content.toString('base64');
  } else if (isBinary) {
    payload.content = Buffer.from(content, 'binary').toString('base64');
  } else {
    payload.content = Buffer.from(content, 'utf-8').toString('base64');
  }
  if (sha) payload.sha = sha;
  try {
    const r = await fetch(url, { method: 'PUT', headers: ghHeaders(false), body: JSON.stringify(payload) });
    return { ok: r.ok, status: r.status };
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 200) }; }
}
async function ghDelete(filepath) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) return { skipped: true };
  const url = `${GH_API}/repos/${repo}/contents/${filepath}`;
  try {
    const g = await fetch(url, { headers: ghHeaders(false) });
    if (!g.ok) return { ok: true, not_found: true };
    const j = await g.json();
    const r = await fetch(url, { method: 'DELETE', headers: ghHeaders(false), body: JSON.stringify({ message: `del ${filepath}`, sha: j.sha, branch: 'main' }) });
    return { ok: r.ok };
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 200) }; }
}
async function ghRestoreAll() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) return { skipped: true };
  let worksRestored = 0, imagesRestored = 0;
  try {
    const r1 = await fetch(`${GH_API}/repos/${repo}/contents/data/works.json`, { headers: ghHeaders(true) });
    if (r1.ok) {
      const text = await r1.text();
      const remoteWorks = JSON.parse(text);
      const local = readWorks();
      const ids = new Set(local.map(w => w.id));
      const merged = [...local];
      for (const w of remoteWorks) if (!ids.has(w.id)) { merged.push(w); ids.add(w.id); worksRestored++; }
      if (worksRestored > 0) writeWorks(merged);
      for (const w of merged) {
        if (!w.filename) continue;
        const localPath = path.join(UPLOAD_DIR, w.filename);
        if (fs.existsSync(localPath)) continue;
        try {
          const r2 = await fetch(`${GH_API}/repos/${repo}/contents/uploads/${w.filename}`, { headers: ghHeaders(true) });
          if (r2.ok) {
            const buf = Buffer.from(await r2.arrayBuffer());
            fs.writeFileSync(localPath, buf);
            imagesRestored++;
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
  return { worksRestored, imagesRestored };
}
async function ensureRestored() {
  if (__restored) return;
  __restored = true;
  if (process.env.VERCEL || process.env.RENDER || process.env.GITHUB_TOKEN) {
    try { await ghRestoreAll(); } catch (_) {}
  }
}
function bg(fn) { if (typeof setImmediate !== 'undefined') setImmediate(fn); else Promise.resolve().then(fn); }
function syncAfterWriteWorks() {
  bg(async () => { try { await ghSyncPut('data/works.json', JSON.stringify(readWorks(), null, 2), false); } catch (_) {} });
}
function syncAfterUpload(filename, buffer) {
  bg(async () => { try { await ghSyncPut(`uploads/${filename}`, buffer, true); } catch (_) {} });
}
function syncAfterDelete(filename) {
  bg(async () => { try { await ghDelete(`uploads/${filename}`); } catch (_) {} });
}

// ============== 响应工具 ==============
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
};
function getMIME(p) { return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream'; }
function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
function sendFile(res, filePath) {
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const isImg = ['.jpg','.jpeg','.png','.gif','.webp','.svg'].includes(ext);
  res.writeHead(200, {
    'Content-Type': getMIME(filePath),
    'Content-Length': stat.size,
    'Cache-Control': isImg ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

// ============== Body 解析 ==============
function parseMultipart(req, maxBytes = 100 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    const m = ct.match(/boundary=(.+)/);
    if (!m) return reject(new Error('non-multipart'));
    const boundary = '--' + m[1];
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > maxBytes) { reject(new Error('too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const parts = []; let s = 0;
        while (s < buf.length) {
          const idx = buf.indexOf(boundary, s); if (idx === -1) break;
          const hs = idx + boundary.length + 2;
          const he = buf.indexOf('\r\n\r\n', hs); if (he === -1) break;
          const headers = buf.slice(hs, he).toString('utf-8');
          const nb = buf.indexOf(boundary, he + 4); if (nb === -1) break;
          const body = buf.slice(he + 4, nb - 2);
          const dm = headers.match(/name="([^"]+)"(?:;\s*filename="([^"]*)")?/);
          if (dm) parts.push({ name: dm[1], filename: dm[2] || null, data: body });
          s = nb;
        }
        const fields = {}; const files = [];
        parts.forEach(p => p.filename === null ? (fields[p.name] = p.data.toString('utf-8')) : files.push(p));
        resolve({ fields, files });
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function parseJSON(req, max = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let s = 0;
    req.on('data', c => { s += c.length; if (s > max) { reject(new Error('too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { try { const t = Buffer.concat(chunks).toString('utf-8'); resolve(t ? JSON.parse(t) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function safeFilename(orig) {
  const ext = path.extname(orig || '').toLowerCase();
  const rand = crypto.randomBytes(4).toString('hex');
  const name = (orig || 'image').replace(ext, '');
  const base = name.replace(/[^\x00-\x7F]/g, 'x').replace(/[^a-zA-Z0-9_\-.]/g, '_').slice(0, 40);
  return `${Date.now()}_${rand}_${base}${ext}`;
}

// ============== 主请求处理（共享给 server.js 和 Vercel handler） ==============
async function handleRequest(req, res) {
  if (!__restored) { try { await ensureRestored(); } catch (_) {} }

  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);
  const method = (req.method || 'GET').toUpperCase();
  const ADMIN_PASSWORD_HASH = getAdminPasswordHash();

  try {
    // === 登录/鉴权 ===
    if (method === 'POST' && pathname === '/api/admin/login') {
      const body = await parseJSON(req);
      const hash = crypto.createHash('sha256').update(body.password || '').digest('hex');
      if (hash === ADMIN_PASSWORD_HASH) {
        const token = generateSessionToken();
        sessions.set(token, { createdAt: Date.now() });
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': `grsy_session=${token}; Path=/; HttpOnly; Max-Age=${SESSION_TTL / 1000}; SameSite=Lax`,
        });
        res.end(JSON.stringify({ success: true }));
        return;
      }
      return sendJSON(res, { success: false, message: '密码错误' }, 401);
    }
    if (method === 'POST' && pathname === '/api/admin/logout') {
      const c = req.headers['cookie'] || ''; const m = c.match(/grsy_session=([^;]+)/);
      if (m) sessions.delete(m[1]);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': 'grsy_session=; Path=/; HttpOnly; Max-Age=0' });
      res.end(JSON.stringify({ success: true }));
      return;
    }
    if (method === 'GET' && pathname === '/api/admin/check') return sendJSON(res, { authenticated: verifySession(req) });

    // === 数据读取（公开） ===
    if (method === 'GET' && pathname === '/api/works') {
      const w = readWorks(); w.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return sendJSON(res, w);
    }
    if (method === 'GET' && pathname === '/api/categories') {
      const w = readWorks(); const map = {};
      w.forEach(x => { const cat = x.subcategory || x.category || '未分类'; map[cat] = (map[cat] || 0) + 1; });
      return sendJSON(res, Object.keys(map).map(name => ({ name, count: map[name] })));
    }

    // === 手动触发全量同步（测试/诊断用） ===
    if (method === 'POST' && pathname === '/api/admin/sync-now') {
      if (!verifySession(req)) return sendJSON(res, { success: false }, 401);
      const w = readWorks();
      const rMeta = await ghSyncPut('data/works.json', JSON.stringify(w, null, 2), false);
      let imgCount = 0;
      for (const x of w) {
        if (!x.filename) continue;
        const fp = path.join(UPLOAD_DIR, x.filename);
        if (fs.existsSync(fp)) {
          try { await ghSyncPut(`uploads/${x.filename}`, fs.readFileSync(fp), true); imgCount++; } catch (_) {}
        }
      }
      return sendJSON(res, { success: true, metadata: rMeta, images: imgCount });
    }

    // === 上传 ===
    if (method === 'POST' && pathname === '/api/works') {
      if (!verifySession(req)) return sendJSON(res, { success: false, message: '未登录' }, 401);
      let parsed;
      try { parsed = await parseMultipart(req); }
      catch (e) { return sendJSON(res, { success: false, message: '请求解析失败: ' + e.message }, 400); }
      const { fields, files } = parsed;
      if (!files || files.length === 0) return sendJSON(res, { success: false, message: '没有上传文件' }, 400);

      const works = readWorks();
      const title = (fields.title || '未命名作品').toString();
      const description = (fields.description || '').toString();
      const category = (fields.category || '作品集').toString();
      const subcategory = (fields.subcategory || '').toString();
      const tags = (fields.tags || '').toString().split(',').map(t => t.trim()).filter(Boolean);
      const newEntries = []; const errors = [];
      const allowedExt = ['.jpg','.jpeg','.png','.gif','.webp','.svg','.bmp'];
      for (const f of files) {
        if (!f || !f.data || !f.filename) { errors.push('无效文件数据'); continue; }
        const ext = path.extname(f.filename || '').toLowerCase();
        if (!allowedExt.includes(ext)) { errors.push(`${f.filename} 格式不支持`); continue; }
        if (f.data.length > 50 * 1024 * 1024) { errors.push(`${f.filename} 超过50MB`); continue; }
        const ok = f.data.length >= 4 && (
          (f.data[0] === 0xFF && f.data[1] === 0xD8) ||
          (f.data[0] === 0x89 && f.data[1] === 0x50 && f.data[2] === 0x4E && f.data[3] === 0x47) ||
          (f.data[0] === 0x47 && f.data[1] === 0x49 && f.data[2] === 0x46) ||
          (f.data[0] === 0x52 && f.data[1] === 0x49 && f.data[2] === 0x46 && f.data[3] === 0x46) ||
          (f.data[0] === 0x42 && f.data[1] === 0x4D) ||
          ext === '.svg'
        );
        if (!ok) { errors.push(`${f.filename} 不是有效图片`); continue; }
        const filename = safeFilename(f.filename);
        try { fs.writeFileSync(path.join(UPLOAD_DIR, filename), f.data); }
        catch (e) { errors.push(`${f.filename} 保存失败`); continue; }
        newEntries.push({
          id: `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
          title: files.length > 1 ? `${title} - ${path.parse(f.filename || '').name}` : title,
          description, category, subcategory, tags,
          filename, originalName: f.filename, size: f.data.length,
          url: `/uploads/${filename}`, createdAt: Date.now(),
        });
        syncAfterUpload(filename, f.data);
      }
      if (newEntries.length === 0) return sendJSON(res, { success: false, message: errors.join('; ') || '未成功上传' }, 400);
      works.push(...newEntries);
      try { writeWorks(works); }
      catch (e) {
        newEntries.forEach(x => { try { fs.unlinkSync(path.join(UPLOAD_DIR, x.filename)); } catch(_) {} });
        return sendJSON(res, { success: false, message: '保存作品数据失败' }, 500);
      }
      syncAfterWriteWorks();
      const em = errors.length ? ` (${errors.length} 个失败: ${errors.join('; ')})` : '';
      return sendJSON(res, { success: true, message: `成功上传 ${newEntries.length} 张${em}`, works: newEntries });
    }

    // === 批量删除 ===
    if (method === 'POST' && pathname === '/api/works/batch-delete') {
      if (!verifySession(req)) return sendJSON(res, { success: false, message: '未登录' }, 401);
      const body = await parseJSON(req); const ids = body.ids || [];
      if (!Array.isArray(ids)) return sendJSON(res, { success: false }, 400);
      const works = readWorks(); let removed = 0;
      ids.forEach(id => {
        const i = works.findIndex(w => w.id === id);
        if (i !== -1) {
          const [r] = works.splice(i, 1);
          try { const fp = path.join(UPLOAD_DIR, r.filename); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {}
          syncAfterDelete(r.filename);
          removed++;
        }
      });
      writeWorks(works); syncAfterWriteWorks();
      return sendJSON(res, { success: true, removedCount: removed });
    }

    // === 更新 / 删除单条 ===
    const upd = pathname.match(/^\/api\/works\/(.+)$/);
    if (method === 'PUT' && upd) {
      if (!verifySession(req)) return sendJSON(res, { success: false, message: '未登录' }, 401);
      const id = upd[1]; const works = readWorks();
      const i = works.findIndex(w => w.id === id); if (i === -1) return sendJSON(res, { success: false, message: '不存在' }, 404);
      const body = await parseJSON(req);
      if (body.title !== undefined) works[i].title = body.title;
      if (body.description !== undefined) works[i].description = body.description;
      if (body.category !== undefined) works[i].category = body.category;
      if (body.subcategory !== undefined) works[i].subcategory = body.subcategory;
      if (body.tags !== undefined) works[i].tags = Array.isArray(body.tags) ? body.tags : String(body.tags).split(',').map(t => t.trim()).filter(Boolean);
      works[i].updatedAt = Date.now();
      writeWorks(works); syncAfterWriteWorks();
      return sendJSON(res, { success: true, data: works[i] });
    }
    if (method === 'DELETE' && upd) {
      if (!verifySession(req)) return sendJSON(res, { success: false, message: '未登录' }, 401);
      const id = upd[1]; const works = readWorks();
      const i = works.findIndex(w => w.id === id); if (i === -1) return sendJSON(res, { success: false, message: '不存在' }, 404);
      const [r] = works.splice(i, 1);
      try { const fp = path.join(UPLOAD_DIR, r.filename); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {}
      syncAfterDelete(r.filename);
      writeWorks(works); syncAfterWriteWorks();
      return sendJSON(res, { success: true });
    }

    // === 静态资源：上传文件 ===
    if (pathname.startsWith('/uploads/')) {
      const rel = pathname.slice('/uploads/'.length);
      const fp = path.join(UPLOAD_DIR, rel);
      if (!fp.startsWith(UPLOAD_DIR)) return sendJSON(res, { error: '禁止访问' }, 403);
      if (sendFile(res, fp)) return;
      return sendJSON(res, { error: '文件不存在' }, 404);
    }

    // === 页面路由 ===
    if (pathname === '/admin' || pathname === '/admin/') return sendFile(res, path.join(PUBLIC_DIR, 'admin.html'));
    if (pathname === '/' || pathname === '/index.html') return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));

    // === 其他静态（css/js/图片等） ===
    if (!pathname.startsWith('/api')) {
      const safe = path.normalize(pathname).replace(/^\\/, '').replace(/^\//, '');
      const fp = path.join(PUBLIC_DIR, safe);
      if (fp.startsWith(PUBLIC_DIR) && fs.existsSync(fp) && fs.statSync(fp).isFile()) return sendFile(res, fp);
    }

    sendJSON(res, { error: 'Not Found' }, 404);
  } catch (err) {
    console.error('req error:', err);
    sendJSON(res, { success: false, message: err.message || '服务器错误' }, 500);
  }
}

// ============== 本机局域网 IP ==============
function getLocalIP() {
  const ifaces = require('os').networkInterfaces();
  for (const n of Object.keys(ifaces)) for (const it of ifaces[n]) if (it.family === 'IPv4' && !it.internal) return it.address;
  return null;
}

// ============== 仅在直接运行 node server.js 时启动 HTTP 监听 ==============
if (require.main === module) {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      console.error(err);
      try { sendJSON(res, { success: false, message: err.message }, 500); } catch (_) {}
    });
  });
  server.listen(PORT, HOST, () => {
    const localIP = getLocalIP();
    console.log('============================================');
    console.log('  摄影作品集站点已启动 (零依赖版本)');
    console.log(`  本机访问:  http://localhost:${PORT}`);
    console.log(`  管理后台:  http://localhost:${PORT}/admin`);
    if (localIP) console.log(`  局域网访问: http://${localIP}:${PORT}`);
    console.log('============================================');
  });
}

module.exports = { handleRequest, getLocalIP, ROOT, getAdminPasswordHash };
