# Windsurf API

将 Windsurf 订阅转换为 OpenAI / Anthropic 兼容的 API 服务器。

## ✨ 功能特点

| 功能 | 说明 |
|------|------|
| 🤖 双协议兼容 | 同时支持 OpenAI Chat Completions API 和 Anthropic Messages API |
| 💻 Claude Code 集成 | 一键生成 Claude Code 启动命令 (`--claude-code`) |
| 📊 使用量监控 | Web 仪表盘实时查看 API 使用情况 |
| 🔄 自动认证 | Token 过期自动刷新（每 30 分钟），无需手动干预 |
| ⚡ 速率限制 | 内置 RPM 频率控制（60 RPM/账号），避免触发上游限制 |
| 🌐 代理支持 | 支持 HTTP/HTTPS 代理，配置持久化 |
| 🐳 Docker 支持 | 提供完整的 Docker 部署方案 |
| 🔑 API Key 认证 | 可选的 API Key 鉴权，保护公开部署的服务 |
| 👥 多账号管理 | 支持多账号池，额度耗尽/限流/封禁时自动切换下一个 |
| 🔀 模型路由 | 灵活的模型名映射和每模型并发控制 |
| 📱 可视化管理 | Web 仪表盘支持账号管理、模型管理、运行统计 |
| 🛡️ 网络弹性 | 连接超时 + 流中断即时恢复 + 30s 心跳保活 + 动态停滞检测 |
| ✂️ 上下文透传 | 全量透传上下文至上游，由客户端（如 Claude Code）自行管理压缩 |
| 🔍 智能模型匹配 | 自动处理模型名格式差异（日期后缀、dash/dot 版本号、别名等） |
| 🧠 Thinking 思维链 | 自动为支持的模型启用深度思考（extended thinking），提升代码质量 |
| 🔧 工具仿真 | 将 OpenAI tools[] 转换为 Cascade 文本格式，兼容 Cursor / Aider / Continue.dev |
| 🧹 路径消毒 | 自动清理 Windsurf 内部路径，防止泄露服务器环境信息 |
| 🌍 零依赖 | 纯 Node.js 内置模块，无第三方依赖 |

## 🚀 快速开始

### 前置条件

- Node.js ≥ 20
- Windsurf Language Server 二进制文件
- 至少一个 Windsurf 账号

### 安装

```bash
git clone https://github.com/imbuxiangnan-cyber/windsurf-api.git
cd windsurf-api
npm install
npm run build
```

### 基本用法

```bash
# 方式一：已装 Windsurf 桌面客户端（零配置，自动提取 token + LS）
npx windsurf-api start

# 方式二：交互式登录（支持邮箱密码 / 手动粘贴 token）
npx windsurf-api auth
npx windsurf-api start

# 方式三：直接用 token 添加
npx windsurf-api add-account --token <session_token>
npx windsurf-api start --ls-path /path/to/language_server
```

服务器默认监听 `http://localhost:4000`。

### 登录方式

| 方式 | 前提 | 说明 |
|------|------|------|
| **自动提取** | 已装 Windsurf 桌面端并登录过 | 启动时自动从桌面 app 提取 token 和 LS |
| **邮箱密码** | 有 Windsurf 账号 | `npx windsurf-api auth` 选择 [2] |
| **手动粘贴** | 有 session token | `auth` 选 [3] 或 `add-account --token` |

### Language Server

启动时自动检测，无需手动指定。如未自动检测到，可手动指定：

- **Windows**: `<Windsurf安装目录>\resources\app\extensions\windsurf\bin\language_server_windows_x64.exe`
- **macOS**: `~/Library/Application Support/Windsurf/resources/app/extensions/windsurf/bin/language_server_macos_arm`
- **Linux**: `/opt/Windsurf/resources/app/extensions/windsurf/bin/language_server_linux_x64`

## 📋 CLI 命令

```bash
# 启动服务
windsurf-api start [--port 4000] [--ls-path /path/to/ls] [--claude-code]

# 添加账号
windsurf-api add-account --token <devin_session_token>
windsurf-api add-account --token <token> --label my-pro-account

# 查看账号列表
windsurf-api list-accounts

# 删除账号
windsurf-api remove-account <id>

# 代理配置
windsurf-api proxy                  # 查看
windsurf-api proxy --set            # 交互式设置
windsurf-api proxy --http-proxy URL # 命令行设置
windsurf-api proxy --enable         # 启用
windsurf-api proxy --disable        # 禁用
windsurf-api proxy --clear          # 清除

# 调试信息
windsurf-api debug

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

### 自动配置（推荐）

```bash
# 启动时带 --claude-code 自动显示集成命令
npx windsurf-api start --claude-code
```

### 手动配置

在项目根目录创建 `.claude/settings.json`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4000",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "claude-sonnet-4",
    "ANTHROPIC_SMALL_FAST_MODEL": "gpt-4.1",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1"
  }
}
```

或通过环境变量：

```bash
export ANTHROPIC_BASE_URL=http://localhost:4000
export ANTHROPIC_API_KEY=sk-your-api-key
claude
```

> **提示**：`ANTHROPIC_AUTH_TOKEN` 可以是任意值（如 `dummy`），只要你没有设置 `--api-key`。如果设置了 API Key，则填写对应的 Key。

## 🖥 Dashboard

访问 `http://localhost:4000/dashboard` 管理：

- 账号管理（添加/删除/状态）
- API Key 管理
- 使用统计

设置密码：`DASHBOARD_PASSWORD=your_password`

## 🌐 代理配置

支持持久化的 HTTP/HTTPS 代理设置，配置保存在 `%APPDATA%\windsurf-api\proxy.json`（Windows）或 `~/.config/windsurf-api/proxy.json`（Linux/macOS）。

### 设置代理

```bash
# 交互式设置（推荐）
npx windsurf-api proxy --set

# 命令行直接设置
npx windsurf-api proxy --http-proxy http://127.0.0.1:7890

# 指定 HTTPS 代理和排除列表
npx windsurf-api proxy --http-proxy http://127.0.0.1:7890 --https-proxy http://127.0.0.1:7890 --no-proxy localhost,127.0.0.1
```

### 管理代理

```bash
npx windsurf-api proxy              # 查看当前配置
npx windsurf-api proxy --enable     # 启用代理
npx windsurf-api proxy --disable    # 禁用代理（保留设置）
npx windsurf-api proxy --clear      # 清除所有代理配置
```

### 启动时生效

```bash
# 默认：自动读取持久化代理配置
npx windsurf-api start --claude-code

# 使用系统环境变量中的代理（忽略持久化配置）
npx windsurf-api start --claude-code --proxy-env
```

启动时如果代理已启用，日志会显示 `Proxy: http://127.0.0.1:7890`。

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
curl -X POST http://localhost:4000/api/accounts \
  -H "Content-Type: application/json" \
  -d '{"email": "my-account", "apiKey": "<devin_session_token>"}'
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
