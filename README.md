# dot-ai

> AI 驱动的桌面工作台 —— 集智能对话、智能体、Shell、浏览器、接口测试、文档转换于一体。

[![Electron](https://img.shields.io/badge/Electron-43-9feaf9?logo=electron&logoColor=black)](https://www.electronjs.org/)
[![Vue](https://img.shields.io/badge/Vue-3-42b883?logo=vite&logoColor=white)](https://vuejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## ✨ 闪光点

- **全栈 AI 智能体** — Shell 和浏览器页面自带 AI 面板，一条自然语言指令自动规划 → 调用工具 → 循环执行，支持 16 种浏览器操作和本地/远程 Shell 命令
- **多后端对话** — OpenAI 兼容 / SSE 流式 / STOMP WebSocket / HTTP 直连，思考模式、Function Calling、MCP 工具调用、内置本地工具集一站式支持
- **本地 + 远程 Shell** — node-pty 真实 PTY 彩色终端 + ssh2 远程会话 + SFTP 文件管理多标签并存；危险命令自动识别，气泡内确认并可加白名单
- **内嵌浏览器** — Electron webview 多标签浏览器，AI 可直接操作（点击、输入、滚动、抓取 DOM 结构、截图等）
- **零端口占用** — 生产模式不监听任何本地端口，纯客户端架构
- **跨平台打包** — 一键生成 Windows NSIS / macOS DMG / Linux AppImage，安装包支持自定义安装路径

## 📦 功能模块

| 模块 | 说明 |
|---|---|
| 💬 智能对话 | 多后端 LLM 接入、思考模式、Function Calling、MCP 工具调用 |
| 🤖 智能体（Shell） | AI 驱动的终端自动化：PowerShell / SSH 命令、危险命令防护、会话白名单 |
| 🤖 智能体（浏览器） | AI 驱动的网页自动化：navigate / click / input / scroll / read / structure 等 16 种操作 |
| 🖥️ 百宝箱 · Shell | 本地 PowerShell + 远程 SSH 多标签终端，SFTP 文件管理 |
| 🌐 百宝箱 · 浏览器 | 内嵌多标签 webview 浏览器 |
| 🔌 百宝箱 · 接口测试 | HTTP / SSE 真流式 / WebSocket / TCP 原始 socket，主进程代理规避 CORS |
| 📄 百宝箱 · 文档转换 | Word → Markdown、PDF 转图片、Markdown → HTML、批量处理 + ZIP 下载 |
| 📒 日历笔记 | Tiptap 富文本编辑器，按日期归档 |
| ⚙️ 设置中心 | 多 LLM endpoint、对话模式、内置工具、主题切换 |

## 🛠️ 技术栈

| 分层 | 选型 |
|---|---|
| 桌面框架 | Electron 43 |
| 构建 | electron-vite（主进程 / 预加载 / 渲染进程三入口） |
| 前端 | Vue 3 + TypeScript + Vue Router（hash）+ Element Plus |
| 编辑器 | Tiptap 3 |
| 终端 | xterm.js + node-pty + ssh2 |
| Markdown | marked + highlight.js + md-editor-v3 |
| 文档处理 | mammoth · pdfjs-dist · jsPDF + html2canvas · JSZip |
| 打包 | electron-builder（NSIS / DMG / AppImage + deb + snap） |

## 🚀 快速开始

### 环境

- Node.js 18+
- npm

### 安装与开发

```bash
# 安装（自动重建 node-pty 原生模块）
npm install

# 开发模式（热更新）
npm run dev
```

### 构建

```bash
# 仅编译
npm run build

# Windows NSIS 安装包（支持自定义安装路径）
npm run build:win

# macOS DMG
npm run build:mac

# Linux AppImage + deb + snap
npm run build:linux

# 调试解包
npm run build:unpack
```

### 代码签名（正式分发）

未签名的 exe 会触发 SmartScreen "无法识别的应用" 警告。EV 证书可立即消除，OV 证书需 2-4 周积累安装信誉。

```powershell
# 1. 把 .pfx 证书放到 build/
# 2. 在 electron-builder.yml 的 win: 段补充：
#    certificateFile: build/certificate.pfx
#    certificatePassword: env.CERT_PASSWORD
# 3. 打包
$env:CERT_PASSWORD = '证书密码'
npm run build:win
```

## 📂 项目结构

```
dot-ai/
├── build/                 # electron-builder 资源（icon、证书）
├── out/                   # 编译产物（gitignore）
├── resources/             # 运行时资源
├── src/
│   ├── main/              # 主进程（Node.js）
│   │   ├── index.ts           窗口 + 基础 IPC
│   │   ├── toolboxShell.ts    Shell / SSH / SFTP
│   │   └── toolboxNet.ts      HTTP / WS / TCP 代理
│   ├── preload/           # 预加载脚本（contextBridge → window.dot）
│   └── renderer/          # 渲染进程（Vue 3 SPA）
├── electron-builder.yml   # 打包配置（NSIS 自定义路径等）
├── electron.vite.config.ts
└── package.json
```

## 🔐 安全边界

- **不占端口** — 生产模式不监听任何本地端口，HTTP/WS/TCP 均为出站连接
- **本地静态加载** — 生产渲染进程走 `loadFile`，不启动本地 HTTP server
- **asar 归档 + Vite minify** — 前端代码压缩入 `app.asar`；敏感配置请让用户在设置中填写，不要硬编码
- **Shell 危险命令防护** — rm / del / format / dd / rd 等命令需确认，支持会话级父目录白名单

## 🖥️ 系统要求

- **开发**：Windows / macOS / Linux 均支持
- **运行**：Windows 10+（已打包）；macOS / Linux 可自行 `npm run build` 生成

## 📄 License

MIT
