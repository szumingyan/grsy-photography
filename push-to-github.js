// 把项目源码推送到 GitHub 仓库（无需本机安装 Git）
// 用法（PowerShell）：
//   $env:GITHUB_TOKEN='ghp_xxx'; $env:GITHUB_REPO='你的用户名/仓库名'; node push-to-github.js
// 说明：
//   - 仓库不存在时自动创建（私有仓库）
//   - 新增/修改的文件放在构建目录（本脚本所在目录），其余从项目目录读取

const fs = require('fs');
const path = require('path');
const { apiCall, encodePath } = require('./sync');

// 项目源目录（只读）与构建目录（本脚本所在，存放新增/修改的文件）
const PROJECT_DIR = 'C:\\Users\\ym\\Documents\\trae_projects\\grsy';
const BUILD_DIR = __dirname;

// 仓库文件清单：repo 路径 -> 来源
const FILES = [
  { p: 'server.js', src: 'build' },
  { p: 'sync.js', src: 'build' },
  { p: 'push-to-github.js', src: 'build' },
  { p: 'package.json', src: 'build' },
  { p: '.gitignore', src: 'project' },
  { p: 'README.md', src: 'project' },
  { p: 'public/index.html', src: 'project' },
  { p: 'public/styles.css', src: 'project' },
  { p: 'public/app.js', src: 'project' },
  { p: 'public/admin.html', src: 'project' },
  { p: 'public/admin.css', src: 'project' },
  { p: 'public/admin.js', src: 'project' },
  { p: 'data/works.json', src: 'project' },
];

async function main() {
  if (!process.env.GITHUB_TOKEN) { console.error('错误: 未设置 GITHUB_TOKEN 环境变量'); process.exit(1); }
  if (!process.env.GITHUB_REPO || !process.env.GITHUB_REPO.includes('/')) {
    console.error('错误: GITHUB_REPO 需要设置为 "用户名/仓库名" 格式');
    process.exit(1);
  }
  const [owner, repoName] = process.env.GITHUB_REPO.split('/');

  // 1. 验证令牌
  const me = await apiCall('GET', '/user');
  console.log(`令牌有效，当前账号: ${me.login}`);

  // 2. 确保仓库存在（不存在则创建私有仓库）
  try {
    await apiCall('GET', `/repos/${owner}/${repoName}`);
    console.log(`仓库已存在: ${owner}/${repoName}`);
  } catch (e) {
    console.log(`仓库不存在，正在创建私有仓库 ${owner}/${repoName} ...`);
    await apiCall('POST', '/user/repos', {
      name: repoName,
      private: true,
      default_branch: 'main',
      description: '个人摄影作品集网站 (GRSY)',
      has_issues: false,
      has_wiki: false,
      has_projects: false,
    });
    console.log('仓库创建成功');
  }

  // 3. 逐个推送文件
  let ok = 0, fail = 0;
  for (const item of FILES) {
    const localPath = item.src === 'build'
      ? path.join(BUILD_DIR, item.p)
      : path.join(PROJECT_DIR, item.p);
    if (!fs.existsSync(localPath)) {
      console.warn(`跳过（本地不存在）: ${item.p}`);
      continue;
    }
    try {
      const content = fs.readFileSync(localPath);
      const body = {
        message: `deploy: ${item.p}`,
        content: content.toString('base64'),
        branch: process.env.GITHUB_BRANCH || 'main',
      };
      // 已存在的文件需要带 sha
      try {
        const info = await apiCall('GET', `/repos/${owner}/${repoName}/contents/${encodePath(item.p)}`);
        if (info && info.sha) body.sha = info.sha;
      } catch (e) { /* 文件不存在，无需 sha */ }

      await apiCall('PUT', `/repos/${owner}/${repoName}/contents/${encodePath(item.p)}`, body, { timeout: 120000 });
      ok++;
      console.log(`已推送: ${item.p} (${content.length} 字节)`);
    } catch (err) {
      fail++;
      console.error(`推送失败: ${item.p} - ${err.message}`);
    }
  }

  console.log('============================================');
  console.log(`完成！成功 ${ok} 个，失败 ${fail} 个`);
  console.log(`仓库地址: https://github.com/${owner}/${repoName}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('执行失败:', err.message);
  process.exit(1);
});
