import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

/** 通用 IPC 事件监听器封装 */
const on = (channel: string, callback: (payload: unknown) => void): (() => void) => {
  const listener = (_event: IpcRendererEvent, payload: unknown): void => callback(payload)
  ipcRenderer.on(channel, listener)
  // 返回取消订阅函数
  return () => ipcRenderer.removeListener(channel, listener)
}

// 百宝箱 API：终端会话 / SFTP / 网络测试 / 文件对话框
const toolbox = {
  /** 打开独立 Shell 窗口 */
  openShellWindow: (): Promise<{ success: boolean }> => ipcRenderer.invoke('tb:open-shell-window'),

  /** 打开独立浏览器窗口 */
  openBrowserWindow: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('tb:open-browser-window'),

  /** webview 内新窗口事件：页面尝试打开新链接（target=_blank / window.open） */
  onWebviewNewWindow: (
    callback: (payload: { openerId: number; url: string }) => void
  ): (() => void) => on('tb:webview-new-window', callback as (payload: unknown) => void),

  /** 用系统默认浏览器打开链接 */
  openExternal: (url: string): Promise<{ success: boolean; message?: string }> =>
    ipcRenderer.invoke('tb:open-external', url),

  /** 测试 SSH 连接（连通后立即断开，不创建会话） */
  sshTest: (options: {
    host: string
    port: number
    username: string
    password: string
  }): Promise<{ success: boolean; message: string }> => ipcRenderer.invoke('tb:ssh-test', options),

  /** 获取本地用户主目录 */
  homeDir: (): Promise<string> => ipcRenderer.invoke('tb:home-dir'),

  /** 列出本地目录（带类型/大小/修改时间） */
  fsList: (
    dirPath: string
  ): Promise<{ name: string; type: string; size: number; modifyTime: number }[]> =>
    ipcRenderer.invoke('tb:fs-list', dirPath),

  // ---------- 终端会话 ----------
  shell: {
    /** 创建终端会话（远程 SSH 或本地 PowerShell） */
    create: (options: {
      type: 'ssh' | 'local'
      ssh?: { host: string; port: number; username: string; password: string }
    }): Promise<{ sessionId: string; title: string }> =>
      ipcRenderer.invoke('tb:shell-create', options),

    /** 向终端写入数据（键盘输入） */
    write: (sessionId: string, data: string): Promise<void> =>
      ipcRenderer.invoke('tb:shell-write', { sessionId, data }),

    /** 调整终端尺寸 */
    resize: (sessionId: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('tb:shell-resize', { sessionId, cols, rows }),

    /** 关闭终端会话 */
    close: (sessionId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('tb:shell-close', { sessionId }),

    /** 终端输出事件 */
    onData: (callback: (payload: { sessionId: string; data: string }) => void): (() => void) =>
      on('tb:shell-data', callback as (payload: unknown) => void),

    /** 终端退出事件 */
    onExit: (callback: (payload: { sessionId: string; message: string }) => void): (() => void) =>
      on('tb:shell-exit', callback as (payload: unknown) => void)
  },

  // ---------- SFTP 文件传输 ----------
  sftp: {
    /** 解析远程路径（'.' 返回 home 目录） */
    realpath: (sessionId: string, path: string): Promise<string> =>
      ipcRenderer.invoke('tb:sftp-realpath', { sessionId, path }),

    /** 列出远程目录 */
    list: (
      sessionId: string,
      path: string
    ): Promise<{ name: string; type: string; size: number; modifyTime: number }[]> =>
      ipcRenderer.invoke('tb:sftp-list', { sessionId, path }),

    /** 上传本地文件到远程 */
    upload: (
      sessionId: string,
      localPath: string,
      remotePath: string
    ): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('tb:sftp-upload', { sessionId, localPath, remotePath }),

    /** 下载远程文件到本地 */
    download: (
      sessionId: string,
      remotePath: string,
      localPath: string
    ): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('tb:sftp-download', { sessionId, remotePath, localPath }),

    /** 创建远程目录 */
    mkdir: (sessionId: string, path: string): Promise<{ success: boolean; message?: string }> =>
      ipcRenderer.invoke('tb:sftp-mkdir', { sessionId, path }),

    /** 删除远程文件/目录 */
    remove: (
      sessionId: string,
      path: string,
      isDir: boolean
    ): Promise<{ success: boolean; message?: string }> =>
      ipcRenderer.invoke('tb:sftp-delete', { sessionId, path, isDir })
  },

  // ---------- 接口测试 ----------
  net: {
    /** 发送 HTTP 请求（SSE 响应时通过 onHttpChunk 流式接收；requestId 用于实时匹配 chunk） */
    httpRequest: (options: {
      method: string
      url: string
      headers?: Record<string, string>
      body?: string
      bodyType?: 'none' | 'json' | 'form' | 'raw'
      requestId?: string
    }): Promise<{
      requestId: string
      status: number
      statusText: string
      headers: Record<string, string>
      body: string
      elapsed: number
      isSse: boolean
    }> => ipcRenderer.invoke('tb:http-request', options),

    /** SSE 流式响应数据块 */
    onHttpChunk: (
      callback: (payload: { requestId: string; chunk: string }) => void
    ): (() => void) => on('tb:http-chunk', callback as (payload: unknown) => void),

    /** 建立 WebSocket 连接 */
    wsConnect: (connId: string, url: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('tb:ws-connect', { connId, url }),

    /** 发送 WebSocket 消息 */
    wsSend: (connId: string, data: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('tb:ws-send', { connId, data }),

    /** 关闭 WebSocket 连接 */
    wsClose: (connId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('tb:ws-close', { connId }),

    /** WebSocket 连接事件（open/message/close/error） */
    onWsEvent: (
      callback: (payload: { connId: string; type: string; data?: string }) => void
    ): (() => void) => on('tb:ws-event', callback as (payload: unknown) => void),

    /** 建立 TCP 连接 */
    tcpConnect: (connId: string, host: string, port: number): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('tb:tcp-connect', { connId, host, port }),

    /** 发送 TCP 数据 */
    tcpSend: (connId: string, data: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('tb:tcp-send', { connId, data }),

    /** 关闭 TCP 连接 */
    tcpClose: (connId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('tb:tcp-close', { connId }),

    /** TCP 连接事件（open/data/close/error） */
    onTcpEvent: (
      callback: (payload: { connId: string; type: string; data?: string }) => void
    ): (() => void) => on('tb:tcp-event', callback as (payload: unknown) => void)
  },

  // ---------- 文件对话框（文档转换等） ----------
  file: {
    /** 选择本地文件 */
    select: (filters?: { name: string; extensions: string[] }[]): Promise<string | null> =>
      ipcRenderer.invoke('tb:select-file', { filters }),

    /** 选择保存路径 */
    selectSavePath: (
      defaultName: string,
      filters?: { name: string; extensions: string[] }[]
    ): Promise<string | null> =>
      ipcRenderer.invoke('tb:select-save-path', { defaultName, filters }),

    /** 保存文件（base64 内容，支持二进制） */
    save: (path: string, dataBase64: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('tb:save-file', { path, dataBase64 })
  }
}

// Custom APIs for renderer
const dotApi = {
  getAppPath: (): Promise<string> => ipcRenderer.invoke('app-path'),
  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke('select-directory'),
  localFiles: (
    action:
      | 'list'
      | 'create'
      | 'read'
      | 'write'
      | 'rename'
      | 'exists'
      | 'mkdir'
      | 'delete'
      | 'read-base64',
    ...args: unknown[]
  ): Promise<string | string[] | boolean | null> =>
    ipcRenderer.invoke('local-files', action, ...args),
  listFiles: (dir: string): Promise<string[]> => ipcRenderer.invoke('local-files', 'list', dir),
  httpRequest: (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: string,
    headers?: Record<string, string>
  ): Promise<{ status: number; data: string }> =>
    ipcRenderer.invoke('http-request', { method, path, body, headers }),
  executeCommand: (
    command: string,
    timeout?: number,
    cwd?: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    ipcRenderer.invoke('execute-command', { command, timeout, cwd }),
  toolbox
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('dot', dotApi)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.dot = dotApi
}
