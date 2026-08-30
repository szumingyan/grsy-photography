// GitHub 数据同步模块 - 零依赖
// 作用：部署到 Render 等临时文件系统平台时，把上传的图片和作品数据
//       自动备份到 GitHub 仓库；服务冷启动时自动从 GitHub 拉取恢复。
//
// 启用条件（环境变量）：
//   GITHUB_TOKEN  - GitHub 个人访问令牌（需要该仓库的 Contents 读写权限）
//   GITHUB_REPO   - 仓库全名，如 "yourname/grsy-photo"
//   GITHUB_BRANCH - 分支名，默认 main
// 未配置时模块静默跳过，不影响本地使用。

const https = require('https');
const fs = require('fs');
const path = require('path');

const config = {
  token: process.env.GITHUB_TOKEN || '',
  repo: process.env.GITHUB_REPO || '',
  branch: process.env.GITHUB_BRANCH || 'main',
};

const DATA_PATH = 'data/works.json';
const UPLOAD_PREFIX = 'uploads/';

// 远端文件状态：path -> { sha, size }（已知两端一致的文件）
const synced = new Map();
let lastSyncedWorksContent = null;
let uploadDir = '';
let dataFile = '';
let initialized = false;
let syncTimer = null;

const enabled = !!(config.token && config.repo);

// ===== GitHub API 基础请求 =====
function apiCall(method, apiPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {
      'User-Agent': 'grsy-photo-site',
      'Authorization': `Bearer ${config.token}`,
      'Accept': opts.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = https.request({
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers,
      timeout: opts.timeout || 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (opts.raw) return resolve(buf);
          try { resolve(buf.length ? JSON.parse(buf.toString('utf-8')) : {}); }
          catch (e) { reject(new Error('GitHub 响应解析失败')); }
        } else {
          reject(new Error(`GitHub API ${res.statusCode}: ${buf.toString('utf-8').slice(0, 200)}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub 请求超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

// ===== 任务队列：保证拉取/推送严格串行，避免竞态 =====
let queue = Promise.resolve();
function enqueue(task) {
  queue = queue.then(task).catch(err => {
    console.error('[同步] 任务失败:', err.message);
  });
  return queue;
}

// ===== 启动时从 GitHub 拉取数据（远端为最新数据源） =====
async function pullFromGitHub() {
  const treeRes = await apiCall('GET', `/repos/${config.repo}/git/trees/${encodeURIComponent(config.branch)}?recursive=1`);
  const entries = (treeRes.tree || [])
    .filter(e => e.type === 'blob' && !path.basename(e.path).startsWith('.') && !e.path.includes('..'))
    .filter(e => e.path === DATA_PATH || e.path.startsWith(UPLOAD_PREFIX))
    // works.json 优先下载，让作品列表尽快可用
    .sort((a, b) => (a.path === DATA_PATH ? -1 : 0) - (b.path === DATA_PATH ? -1 : 0));

  for (const entry of entries) {
    try {
      const raw = await apiCall('GET',
        `/repos/${config.repo}/contents/${encodePath(entry.path)}?ref=${encodeURIComponent(config.branch)}`,
        null, { raw: true, timeout: 120000 });

      let localPath;
      if (entry.path === DATA_PATH) {
        localPath = dataFile;
      } else {
        localPath = path.join(uploadDir, entry.path.slice(UPLOAD_PREFIX.length));
        if (!localPath.startsWith(uploadDir)) continue; // 防路径穿越
      }
      // 本地缺失或大小不一致时覆盖
      if (!fs.existsSync(localPath) || fs.statSync(localPath).size !== entry.size) {
        fs.writeFileSync(localPath, raw);
        console.log(`  [同步] 已拉取 ${entry.path} (${entry.size} 字节)`);
      }
      synced.set(entry.path, { sha: entry.sha, size: entry.size });
    } catch (err) {
      // 拉取失败的文件不记入 synced，避免被误删
      console.error(`  [同步] 拉取 ${entry.path} 失败:`, err.message);
    }
  }

  if (fs.existsSync(dataFile)) {
    try { lastSyncedWorksContent = fs.readFileSync(dataFile, 'utf-8'); } catch (e) { /* 忽略 */ }
  }
  initialized = true;
  console.log(`  [同步] 启动拉取完成，远端共 ${synced.size} 个数据文件`);
}

// ===== 单个文件上传/更新到 GitHub =====
async function putFile(remotePath, content, message) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
  const body = {
    message,
    content: buf.toString('base64'),
    branch: config.branch,
  };
  const known = synced.get(remotePath);
  if (known) body.sha = known.sha;
  try {
    const res = await apiCall('PUT', `/repos/${config.repo}/contents/${encodePath(remotePath)}`, body, { timeout: 120000 });
    synced.set(remotePath, { sha: res.content.sha, size: buf.length });
  } catch (err) {
    // sha 过期（远端被其他实例更新）时刷新后重试一次
    if (!err.message.includes('409') || known) throw err;
    const info = await apiCall('GET', `/repos/${config.repo}/contents/${encodePath(remotePath)}?ref=${encodeURIComponent(config.branch)}`);
    const res = await apiCall('PUT', `/repos/${config.repo}/contents/${encodePath(remotePath)}`, {
      message, content: buf.toString('base64'), branch: config.branch, sha: info.sha,
    }, { timeout: 120000 });
    synced.set(remotePath, { sha: res.content.sha, size: buf.length });
  }
}

// ===== 删除远端文件 =====
async function deleteFile(remotePath, message) {
  const known = synced.get(remotePath);
  if (!known) return;
  await apiCall('DELETE', `/repos/${config.repo}/contents/${encodePath(remotePath)}`, {
    message, sha: known.sha, branch: config.branch,
  });
  synced.delete(remotePath);
}

// ===== 对账：把本地状态同步到远端 =====
async function reconcile() {
  let failed = 0;

  // 1. works.json（内容级比较）
  if (fs.existsSync(dataFile)) {
    try {
      const content = fs.readFileSync(dataFile, 'utf-8');
      if (content !== lastSyncedWorksContent) {
        await putFile(DATA_PATH, content, '更新作品数据 works.json');
        lastSyncedWorksContent = content;
        console.log('  [同步] 已推送 data/works.json');
      }
    } catch (err) { failed++; console.error('  [同步] works.json 推送失败:', err.message); }
  }

  // 2. 上传图片：本地有、远端没有（或大小不同）→ 上传
  let localFiles = [];
  try {
    localFiles = fs.existsSync(uploadDir)
      ? fs.readdirSync(uploadDir).filter(f => !f.startsWith('.') && fs.statSync(path.join(uploadDir, f)).isFile())
      : [];
  } catch (e) { /* 忽略 */ }

  for (const f of localFiles) {
    const remotePath = UPLOAD_PREFIX + f;
    const known = synced.get(remotePath);
    const size = fs.statSync(path.join(uploadDir, f)).size;
    if (known && known.size === size) continue;
    try {
      await putFile(remotePath, fs.readFileSync(path.join(uploadDir, f)), `上传作品 ${f}`);
      console.log(`  [同步] 已推送 ${remotePath}`);
    } catch (err) {
      failed++; console.error(`  [同步] 推送 ${remotePath} 失败:`, err.message);
    }
  }

  // 3. 远端有、本地没有 → 删除
  for (const remotePath of [...synced.keys()]) {
    if (!remotePath.startsWith(UPLOAD_PREFIX)) continue;
    const localName = remotePath.slice(UPLOAD_PREFIX.length);
    if (localFiles.includes(localName)) continue;
    try {
      await deleteFile(remotePath, `删除作品 ${localName}`);
      console.log(`  [同步] 已删除远端 ${remotePath}`);
    } catch (err) {
      failed++; console.error(`  [同步] 删除 ${remotePath} 失败:`, err.message);
    }
  }

  if (failed > 0) scheduleSync(60000); // 有失败项，稍后重试
}

// ===== 对外接口 =====
// 延迟触发一次对账（合并短时间内的多次数据变更）
function scheduleSync(delay = 3000) {
  if (!enabled) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    enqueue(async () => {
      if (!initialized) return; // 等启动拉取完成
      await reconcile();
    });
  }, delay);
}

// 初始化：server.js 启动时调用
function init(opts) {
  uploadDir = opts.uploadDir;
  dataFile = opts.dataFile;
  if (!enabled) {
    console.log('  [同步] 未配置 GITHUB_TOKEN/GITHUB_REPO，数据同步已关闭（仅本地存储）');
    return;
  }
  console.log(`  [同步] 已启用 GitHub 数据同步: ${config.repo} @ ${config.branch}`);
  enqueue(() => pullFromGitHub());
}

module.exports = { init, scheduleSync, apiCall, encodePath, config, enabled };
