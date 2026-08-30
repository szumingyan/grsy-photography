# GRSY · 个人摄影作品集

一个简洁优雅的个人摄影作品集网站，支持作品集展示、作品管理（增删改）、分类检索，并且可以在同一局域网内的任何设备（手机、平板、其他电脑）上访问。

## ✨ 功能特性

- 📸 **响应式作品集展示**：瀑布流布局，移动端/平板/桌面自适应
- 🖼️ **图片灯箱**：点击大图查看、支持键盘方向键切换
- 📂 **分类管理**：自定义分类，按分类筛选作品
- 🏷️ **标签系统**：为每张图片添加标签以便搜索
- ⚙️ **管理后台**：`/admin` 路径，支持上传、编辑、删除、批量操作
- 📤 **批量上传**：支持拖拽上传，一次上传多张
- 🔍 **搜索与过滤**：按标题、分类、标签搜索
- 🌐 **跨设备访问**：监听 `0.0.0.0`，局域网内任何设备都能访问
- 💾 **JSON 文件存储**：无需数据库，开箱即用

## 🛠️ 技术栈

- **后端**: Node.js + Express + Multer
- **前端**: 原生 HTML/CSS/JS（无框架依赖，轻量高效）
- **存储**: 本地 JSON 文件 + 本地图片文件

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动服务

```bash
npm start
```

启动后终端会显示：

```
============================================
  摄影作品集站点已启动
  本机访问:  http://localhost:3000
  管理后台:  http://localhost:3000/admin
  局域网其他设备可使用本机 IP 访问
============================================
```

### 3. 访问网站

- **本机访问**：`http://localhost:3000`
- **管理后台**：`http://localhost:3000/admin`

### 4. 其他设备访问（手机/平板等）

确保你的手机/平板与电脑连接在**同一局域网**下，然后：

1. 在命令行运行 `ipconfig`（Windows）或 `ifconfig`（Mac/Linux）查看本机 IPv4 地址（例如 `192.168.1.100`）
2. 其他设备浏览器访问：`http://192.168.1.100:3000`
3. 管理后台：`http://192.168.1.100:3000/admin`

> 🔒 **防火墙配置（重要）**：如果其他设备无法访问，需要配置防火墙放行 3000 端口：
> 
> **方法一：使用配置脚本（推荐）**
> 1. 右键点击项目目录下的 `setup-firewall.bat`
> 2. 选择「以管理员身份运行」
> 
> **方法二：手动配置**
> 1. 以管理员身份打开 PowerShell
> 2. 运行：`netsh advfirewall firewall add rule name="GRSY Server" dir=in action=allow protocol=TCP localport=3000`
> 
> 配置完成后，其他设备即可通过 `http://<本机IP>:3000` 访问。

## 📁 项目结构

```
grsy/
├── server.js              # 后端入口
├── package.json
├── .gitignore
├── README.md
├── data/                  # 作品元数据存储（自动创建）
│   └── works.json
├── uploads/               # 上传图片存储（自动创建）
└── public/                # 前端静态资源
    ├── index.html         # 作品集主页
    ├── styles.css         # 主页样式
    ├── app.js             # 主页脚本
    ├── admin.html         # 管理后台
    ├── admin.css          # 后台样式
    └── admin.js           # 后台脚本
```

## 📡 API 接口

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET | `/api/works` | 获取所有作品 |
| POST | `/api/works` | 上传作品（multipart/form-data，字段：`images`, `title`, `description`, `category`, `tags`） |
| PUT | `/api/works/:id` | 更新作品信息 |
| DELETE | `/api/works/:id` | 删除单个作品 |
| POST | `/api/works/batch-delete` | 批量删除（`{ ids: [] }`） |
| GET | `/api/categories` | 获取分类统计 |

## 🔧 自定义

### 修改端口

```bash
PORT=8080 npm start
```

### 更换站点标题与 Logo

编辑 `public/index.html` 中的 `<title>`、`.logo` 以及 Hero 区域文案。

### 修改主题色

编辑 `public/styles.css` 中的 `--accent`、`--accent-2` CSS 变量即可。

## 📝 使用建议

1. 首次启动后立即访问 `/admin` 上传一批作品
2. 作品分类建议按拍摄类型命名（如「风景」「人像」「城市」「黑白」）
3. 单张图片建议控制在 10MB 以内以获得最佳加载速度
4. 可定期备份 `data/works.json` 与 `uploads/` 目录

## 📄 License

MIT © GRSY