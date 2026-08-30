// 零依赖版本 - 仅使用 Node.js 内置模块
// 启动: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const ROOT = __dirname;

// 管理后台密码 - 支持环境变量覆盖（部署到公网时务必设置 ADMIN_PASSWORD）
const ADMIN_PASSWORD_HASH = crypto.createHash('sha256').update(process.env.ADMIN_PASSWORD || '522428').digest('hex');

// 会话存储（内存中，服务器重启会失效）
const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24小时

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function verifySession(req) {
  const cookies = req.headers['cookie'] || '';
  const match = cookies.match(/grsy_session=([^;]+)/);
  if (!match) return false;
  const token = match[1];
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// 检测目录是否可写
function isDirectoryWritable(dir) {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const testFile = path.join(dir, '.write_test_' + Date.now());
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    return true;
  } catch (e) {
    return false;
  }
}

// 将项目目录中的文件迁移到临时目录
function migrateFilesFromProject(projectDir, tempDir) {
  try {
    if (fs.existsSync(projectDir) && fs.statSync(projectDir).isDirectory()) {
      const files = fs.readdirSync(projectDir).filter(f => {
        const fp = path.join(projectDir, f);
        return fs.statSync(fp).isFile() && !f.startsWith('.');
      });
      let migrated = 0;
      files.forEach(f => {
        const src = path.join(projectDir, f);
        const dst = path.join(tempDir, f);
        if (!fs.existsSync(dst)) {
          try { fs.copyFileSync(src, dst); migrated++; } catch (e) { /* 忽略 */ }
        }
      });
      if (migrated > 0) console.log(`  已从项目目录迁移 ${migrated} 个文件`);
    }
  } catch (e) { /* 忽略迁移错误 */ }
}

// 获取可写的上传目录（支持回退到系统临时目录）
function getUploadDir() {
  const projectUploadDir = path.join(ROOT, 'uploads');
  if (isDirectoryWritable(projectUploadDir)) {
    return projectUploadDir;
  }
  // 回退到系统临时目录
  const tempUploadDir = path.join(require('os').tmpdir(), 'grsy_uploads');
  fs.mkdirSync(tempUploadDir, { recursive: true });
  console.warn(`项目上传目录不可写，使用临时目录: ${tempUploadDir}`);
  // 迁移已有上传文件
  migrateFilesFromProject(projectUploadDir, tempUploadDir);
  return tempUploadDir;
}

// 获取可写的数据目录
function getDataDir() {
  const projectDataDir = path.join(ROOT, 'data');
  if (isDirectoryWritable(projectDataDir)) {
    return projectDataDir;
  }
  // 回退到系统临时目录
  const tempDataDir = path.join(require('os').tmpdir(), 'grsy_data');
  fs.mkdirSync(tempDataDir, { recursive: true });
  console.warn(`项目数据目录不可写，使用临时目录: ${tempDataDir}`);
  // 迁移已有数据文件
  const projectDataFile = path.join(projectDataDir, 'works.json');
  const tempDataFile = path.join(tempDataDir, 'works.json');
  if (fs.existsSync(projectDataFile)) {
    try {
      // 如果临时目录没有数据，或者项目目录数据更多，则合并
      const projectData = JSON.parse(fs.readFileSync(projectDataFile, 'utf-8'));
      let tempData = [];
      if (fs.existsSync(tempDataFile)) {
        try { tempData = JSON.parse(fs.readFileSync(tempDataFile, 'utf-8')); } catch (e) { /* 忽略 */ }
      }
      const existingIds = new Set(tempData.map(w => w.id));
      const merged = [...tempData, ...projectData.filter(w => !existingIds.has(w.id))];
      if (merged.length > tempData.length) {
        fs.writeFileSync(tempDataFile, JSON.stringify(merged, null, 2));
        console.log(`  已从项目数据迁移 ${merged.length - tempData.length} 条作品数据`);
      }
    } catch (e) { /* 忽略迁移错误 */ }
  }
  return tempDataDir;
}

const UPLOAD_DIR = getUploadDir();
const DATA_DIR = getDataDir();
const DATA_FILE = path.join(DATA_DIR, 'works.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

// 确保目录存在
[UPLOAD_DIR, DATA_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));
}

// GitHub 数据同步（可选）：数据变更后自动备份到仓库，冷启动时自动恢复
const sync = require('./sync');
sync.init({ uploadDir: UPLOAD_DIR, dataFile: DATA_FILE });

// 读取/写入作品数据
function readWorks() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
  catch (e) { return []; }
}
function writeWorks(works) {
  try {
    const data = JSON.stringify(works, null, 2);
    // 原子写入：先写临时文件，再重命名替换
    const tmpFile = DATA_FILE + '.tmp';
    fs.writeFileSync(tmpFile, data, 'utf-8');
    fs.renameSync(tmpFile, DATA_FILE);
    sync.scheduleSync();
  } catch (e) {
    console.error('写入作品数据失败:', e.message);
    // 回退方案：直接写
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(works, null, 2), 'utf-8');
      sync.scheduleSync();
    }
    catch (e2) { console.error('回退写入也失败:', e2.message); }
  }
}

// MIME 类型映射
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function getMIME(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// 发送 JSON 响应
function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// 发送静态文件（支持 Range，大图片更友好）
function sendFile(res, filePath) {
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const isImage = ['.jpg','.jpeg','.png','.gif','.webp','.svg'].includes(ext);
  if (isImage) {
    // 支持 Range 请求，方便浏览器缓存/加载
    res.writeHead(200, {
      'Content-Type': getMIME(filePath),
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  } else {
    res.writeHead(200, {
      'Content-Type': getMIME(filePath),
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
  }
  fs.createReadStream(filePath).pipe(res);
  return true;
}

// 解析 multipart/form-data（简化版，支持多文件上传）
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const match = contentType.match(/boundary=(.+)/);
    if (!match) return reject(new Error('非 multipart 请求'));
    const boundary = '--' + match[1];
    const chunks = [];
    let size = 0;
    const MAX = 100 * 1024 * 1024; // 100MB 限制
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX) {
        reject(new Error('请求过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const parts = [];
        let start = 0;
        while (start < buf.length) {
          // 找下一个 boundary
          const idx = buf.indexOf(boundary, start);
          if (idx === -1) break;
          // 跳过 boundary + \r\n
          let headerStart = idx + boundary.length + 2;
          const headerEnd = buf.indexOf('\r\n\r\n', headerStart);
          if (headerEnd === -1) break;
          const headerBuf = buf.slice(headerStart, headerEnd);
          const headerStr = headerBuf.toString('utf-8');
          const nextBoundary = buf.indexOf(boundary, headerEnd + 4);
          if (nextBoundary === -1) break;
          const bodyBuf = buf.slice(headerEnd + 4, nextBoundary - 2); // -2 for \r\n before boundary

          const dispositionMatch = headerStr.match(/name="([^"]+)"(?:;\s*filename="([^"]*)")?/);
          if (dispositionMatch) {
            parts.push({
              name: dispositionMatch[1],
              filename: dispositionMatch[2] || null,
              data: bodyBuf,
            });
          }
          start = nextBoundary;
        }
        // 字段解析
        const fields = {};
        const files = [];
        parts.forEach(p => {
          if (p.filename === null) {
            fields[p.name] = p.data.toString('utf-8');
          } else {
            files.push(p);
          }
        });
        resolve({ fields, files });
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// 解析 JSON body
function parseJSON(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) { reject(new Error('JSON 过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(body ? JSON.parse(body) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// 生成安全文件名
function safeFilename(originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  const rand = crypto.randomBytes(4).toString('hex');
  const nameWithoutExt = (originalName || 'image').replace(ext, '');
  const base = nameWithoutExt.replace(/[^\x00-\x7F]/g, 'x').replace(/[^a-zA-Z0-9_\-.]/g, '_').slice(0, 40);
  return `${Date.now()}_${rand}_${base}${ext}`;
}

// 路由处理
async function handleRequest(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);
  const query = parsed.query;
  const method = req.method.toUpperCase();

  try {
    // === API 路由 ===

    // 登录验证
    if (method === 'POST' && pathname === '/api/admin/login') {
      const body = await parseJSON(req);
      const password = body.password || '';
      const hash = crypto.createHash('sha256').update(password).digest('hex');
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

    // 登出
    if (method === 'POST' && pathname === '/api/admin/logout') {
      const cookies = req.headers['cookie'] || '';
      const match = cookies.match(/grsy_session=([^;]+)/);
      if (match) sessions.delete(match[1]);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': 'grsy_session=; Path=/; HttpOnly; Max-Age=0',
      });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // 检查登录状态
    if (method === 'GET' && pathname === '/api/admin/check') {
      return sendJSON(res, { authenticated: verifySession(req) });
    }

    // 获取所有作品
    if (method === 'GET' && pathname === '/api/works') {
      const works = readWorks();
      works.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return sendJSON(res, works);
    }

    // 分类统计
    if (method === 'GET' && pathname === '/api/categories') {
      const works = readWorks();
      const map = {};
      works.forEach(w => {
        const cat = w.subcategory || w.category || '未分类';
        map[cat] = (map[cat] || 0) + 1;
      });
      return sendJSON(res, Object.keys(map).map(name => ({ name, count: map[name] })));
    }

    // 上传作品
    if (method === 'POST' && pathname === '/api/works') {
      if (!verifySession(req)) return sendJSON(res, { success: false, message: '未登录' }, 401);
      let parsed;
      try {
        parsed = await parseMultipart(req);
      } catch (parseErr) {
        console.error('解析multipart数据失败:', parseErr);
        return sendJSON(res, { success: false, message: '请求解析失败：' + parseErr.message }, 400);
      }

      const { fields, files } = parsed;
      if (!files || files.length === 0) {
        return sendJSON(res, { success: false, message: '没有找到上传的文件' }, 400);
      }

      const works = readWorks();
      const title = (fields.title || '未命名作品').toString();
      const description = (fields.description || '').toString();
      const category = (fields.category || '作品集').toString();
      const subcategory = (fields.subcategory || '').toString();
      const tags = (fields.tags || '').toString().split(',').map(t => t.trim()).filter(Boolean);

      const newEntries = [];
      const errors = [];

      for (const f of files) {
        // 检查文件是否有效
        if (!f || !f.data || !f.filename) {
          errors.push('无效的文件数据');
          continue;
        }

        // 检查扩展名
        const ext = path.extname(f.filename || '').toLowerCase();
        const allowedExts = ['.jpg','.jpeg','.png','.gif','.webp','.svg','.bmp'];
        if (!allowedExts.includes(ext)) {
          errors.push(`文件 "${f.filename}" 格式不支持`);
          continue;
        }

        // 检查文件大小
        if (f.data.length > 50 * 1024 * 1024) {
          errors.push(`文件 "${f.filename}" 超过50MB限制`);
          continue;
        }

        // 检查是否为图片（通过文件头）
        const isImage = f.data.length >= 4 && (
          f.data[0] === 0xFF && f.data[1] === 0xD8 || // JPEG
          f.data[0] === 0x89 && f.data[1] === 0x50 && f.data[2] === 0x4E && f.data[3] === 0x47 || // PNG
          f.data[0] === 0x47 && f.data[1] === 0x49 && f.data[2] === 0x46 || // GIF
          f.data[0] === 0x52 && f.data[1] === 0x49 && f.data[2] === 0x46 && f.data[3] === 0x46 && // WEBP (RIFF)
          f.data[0] === 0x42 && f.data[1] === 0x4D || // BMP
          ext === '.svg' // SVG (文本格式)
        );

        if (!isImage) {
          errors.push(`文件 "${f.filename}" 不是有效的图片`);
          continue;
        }

        let filename;
        try {
          filename = safeFilename(f.filename);
          fs.writeFileSync(path.join(UPLOAD_DIR, filename), f.data);
        } catch (writeErr) {
          console.error(`写入文件失败 ${f.filename}:`, writeErr);
          errors.push(`保存文件 "${f.filename}" 失败`);
          continue;
        }

        newEntries.push({
          id: `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
          title: files.length > 1 ? `${title} - ${path.parse(f.filename || '').name}` : title,
          description,
          category,
          subcategory,
          tags,
          filename,
          originalName: f.filename,
          size: f.data.length,
          url: `/uploads/${filename}`,
          createdAt: Date.now(),
        });
      }

      if (newEntries.length === 0) {
        const msg = errors.length > 0 ? errors.join('; ') : '没有成功上传任何文件';
        return sendJSON(res, { success: false, message: msg }, 400);
      }

      works.push(...newEntries);
      try {
        writeWorks(works);
      } catch (writeErr) {
        console.error('保存作品数据失败:', writeErr);
        // 回滚已上传的文件
        for (const entry of newEntries) {
          try { fs.unlinkSync(path.join(UPLOAD_DIR, entry.filename)); } catch (_) {}
        }
        return sendJSON(res, { success: false, message: '保存作品数据失败' }, 500);
      }

      const successMsg = `成功上传 ${newEntries.length} 张作品`;
      const errorMsg = errors.length > 0 ? `（${errors.length} 个文件失败：${errors.join('; ')}）` : '';
      sendJSON(res, { success: true, message: successMsg + errorMsg, works: newEntries });
    }

    // 批量删除（必须在 updateMatch 之前，否则会被正则误匹配）
    if (method === 'POST' && pathname === '/api/works/batch-delete') {
      if (!verifySession(req)) return sendJSON(res, { success: false, message: '未登录' }, 401);
      const body = await parseJSON(req);
      const ids = body.ids || [];
      if (!Array.isArray(ids)) return sendJSON(res, { success: false }, 400);
      const works = readWorks();
      let removedCount = 0;
      ids.forEach(id => {
        const idx = works.findIndex(w => w.id === id);
        if (idx !== -1) {
          const [removed] = works.splice(idx, 1);
          try {
            const fp = path.join(UPLOAD_DIR, removed.filename);
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
          } catch (e) { /* 忽略 */ }
          removedCount++;
        }
      });
      writeWorks(works);
      return sendJSON(res, { success: true, removedCount });
    }

    // 更新作品
    const updateMatch = pathname.match(/^\/api\/works\/(.+)$/);
    if (method === 'PUT' && updateMatch) {
      if (!verifySession(req)) return sendJSON(res, { success: false, message: '未登录' }, 401);
      const id = updateMatch[1];
      const works = readWorks();
      const idx = works.findIndex(w => w.id === id);
      if (idx === -1) return sendJSON(res, { success: false, message: '作品不存在' }, 404);

      const body = await parseJSON(req);
      if (body.title !== undefined) works[idx].title = body.title;
      if (body.description !== undefined) works[idx].description = body.description;
      if (body.category !== undefined) works[idx].category = body.category;
      if (body.subcategory !== undefined) works[idx].subcategory = body.subcategory;
      if (body.tags !== undefined) {
        works[idx].tags = Array.isArray(body.tags) ? body.tags : String(body.tags).split(',').map(t => t.trim()).filter(Boolean);
      }
      works[idx].updatedAt = Date.now();
      writeWorks(works);
      return sendJSON(res, { success: true, data: works[idx] });
    }

    // 删除作品
    if (method === 'DELETE' && updateMatch) {
      if (!verifySession(req)) return sendJSON(res, { success: false, message: '未登录' }, 401);
      const id = updateMatch[1];
      const works = readWorks();
      const idx = works.findIndex(w => w.id === id);
      if (idx === -1) return sendJSON(res, { success: false, message: '作品不存在' }, 404);
      const [removed] = works.splice(idx, 1);
      try {
        const fp = path.join(UPLOAD_DIR, removed.filename);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      } catch (e) { /* 忽略 */ }
      writeWorks(works);
      return sendJSON(res, { success: true });
    }

    // === 静态资源 ===

    // 上传文件
    if (pathname.startsWith('/uploads/')) {
      const relPath = pathname.slice('/uploads/'.length);
      const fp = path.join(UPLOAD_DIR, relPath);
      // 防止路径穿越
      if (!fp.startsWith(UPLOAD_DIR)) return sendJSON(res, { error: '禁止访问' }, 403);
      if (sendFile(res, fp)) return;
      return sendJSON(res, { error: '文件不存在' }, 404);
    }

    // 管理后台
    if (pathname === '/admin' || pathname === '/admin/') {
      return sendFile(res, path.join(PUBLIC_DIR, 'admin.html'));
    }

    // 主页面或根
    if (pathname === '/' || pathname === '/index.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }

    // 其他静态资源
    if (!pathname.startsWith('/api')) {
      const safePath = path.normalize(pathname).replace(/^\\/, '').replace(/^\//, '');
      const fp = path.join(PUBLIC_DIR, safePath);
      if (fp.startsWith(PUBLIC_DIR) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        return sendFile(res, fp);
      }
    }

    // 404
    sendJSON(res, { error: 'Not Found' }, 404);
  } catch (err) {
    console.error('请求处理错误:', err);
    sendJSON(res, { success: false, message: err.message || '服务器错误' }, 500);
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error(err);
    try { sendJSON(res, { success: false, message: err.message }, 500); } catch (_) {}
  });
});

// 获取本机局域网IP地址
function getLocalIP() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

server.listen(PORT, HOST, () => {
  const localIP = getLocalIP();
  console.log('============================================');
  console.log('  摄影作品集站点已启动 (零依赖版本)');
  console.log(`  本机访问:  http://localhost:${PORT}`);
  console.log(`  管理后台:  http://localhost:${PORT}/admin`);
  if (localIP) {
    console.log(`  局域网访问: http://${localIP}:${PORT}`);
  }
  console.log('');
  console.log('  ⚠ 其他设备无法访问时，请：');
  console.log('  1. 以管理员身份打开 PowerShell');
  console.log('  2. 运行: netsh advfirewall firewall add rule name="GRSY Server" dir=in action=allow protocol=TCP localport=3000');
  console.log('============================================');
});
