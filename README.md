# Windsurf API

将 Windsurf 订阅转换为 OpenAI / Anthropic 兼容的 API 服务器。

## ✨ 功能特点

- **双协议兼容** — OpenAI (`/v1/chat/completions`) + Anthropic (`/v1/messages`) 原生端点
- **100+ 模型** — Claude / GPT / Gemini / DeepSeek / Grok / Qwen / Kimi 等
- **多账号池** — 按剩余容量均衡分配，自动故障转移
- **CLI 管理** — 简单命令行管理账号，类似 copilot-api-plus
- **Dashboard** — Web 管理面板，账号/密钥/统计一目了然
- **API Key 管理** — 下游消费者密钥管理
- **Docker 支持** — 一键部署
- **零依赖** — 纯 Node.js 内置模块

## 🚀 快速开始

### 前置条件

- Node.js ≥ 20
- Windsurf Language Server 二进制文件
- 至少一个 Windsurf 账号

### 安装

```bash
git clone https://github.com/your-repo/windsurf-api.git
cd windsurf-api
npm install
npm run build
```

### 基本用法

```bash
# 1. 添加账号
node dist/index.js add-account --email your@email.com --password yourpassword

# 2. 启动服务
node dist/index.js start

# 或指定 Language Server 路径
node dist/index.js start --ls-path /path/to/language_server_linux_x64
```

服务器默认监听 `http://localhost:4000`。

### Language Server 获取

从 Windsurf 桌面端获取 LS 二进制文件：

- **Windows**: `%APPDATA%\Windsurf\bin\language_server_windows_x64.exe`
- **macOS**: `~/Library/Application Support/Windsurf/resources/app/extensions/windsurf/bin/language_server_macos_arm`
- **Linux**: `~/.windsurf/bin/language_server_linux_x64`

## 📋 CLI 命令

```bash
# 启动服务
windsurf-api start [--port 4000] [--ls-path /path/to/ls]

# 添加账号（邮箱+密码自动登录）
windsurf-api add-account --email user@example.com --password mypassword

# 添加账号（直接使用 session token）
windsurf-api add-account --email user@example.com --api-key <session_token>

# 查看账号列表
windsurf-api list-accounts

# 删除账号
windsurf-api remove-account <id>

# 帮助
windsurf-api help
```

## 📡 API 端点

### OpenAI 兼容

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-api-key" \
  -d '{
    "model": "claude-sonnet-4.6",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

### Anthropic 兼容

```bash
curl http://localhost:4000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-your-api-key" \
  -d '{
    "model": "claude-sonnet-4.6",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### 模型列表

```bash
curl http://localhost:4000/v1/models
```

## 💻 Claude Code 集成

```bash
# 设置环境变量
export ANTHROPIC_BASE_URL=http://localhost:4000
export ANTHROPIC_API_KEY=sk-your-api-key

# 启动 Claude Code
claude
```

## 🖥 Dashboard

访问 `http://localhost:4000/dashboard` 管理：

- 账号管理（添加/删除/状态）
- API Key 管理
- 使用统计

设置密码：`DASHBOARD_PASSWORD=your_password`

## ⚙️ 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `4000` | 服务端口 |
| `API_KEY` | 空 | 全局 API 密钥 |
| `DASHBOARD_PASSWORD` | 空 | Dashboard 密码 |
| `LS_BINARY_PATH` | 自动检测 | LS 二进制路径 |
| `LS_PORT` | `42100` | LS 端口 |
| `API_SERVER_URL` | `https://server.self-serve.windsurf.com` | Windsurf 云端 |
| `DEFAULT_MODEL` | `claude-sonnet-4.6` | 默认模型 |
| `LOG_LEVEL` | `info` | 日志级别 |
| `DATA_DIR` | `./data` | 数据目录 |

## 🐳 Docker 部署

```bash
# 1. 将 LS 二进制放到 ls-binary/ 目录
mkdir -p ls-binary
cp /path/to/language_server_linux_x64 ls-binary/

# 2. 启动
docker compose up -d --build

# 3. 添加账号
curl -X POST http://localhost:4000/dashboard/api/channels \
  -H "Content-Type: application/json" \
  -d '{"email": "your@email.com", "password": "yourpassword"}'
```

## 🏗 架构

```
Client (OpenAI SDK / Anthropic SDK / Claude Code / curl)
  │
  ▼
Windsurf API (Node.js HTTP, :4000)
  ├── /v1/chat/completions  (OpenAI format)
  ├── /v1/messages          (Anthropic format)
  ├── /v1/models            (Model list)
  ├── /dashboard            (Admin UI)
  └── /dashboard/api/*      (Admin API)
  │
  ▼
Language Server (gRPC, :42100)
  │
  ▼
Windsurf Cloud (server.self-serve.windsurf.com)
```

## ⚠️ 免责声明

本项目仅供个人学习和研究使用。请遵守 Windsurf 的使用条款。

## 📄 许可证

MIT
