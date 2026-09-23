import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

/** 数据库类型（MySQL / OceanBase MySQL 租户 / PostgreSQL / Oracle / OceanBase Oracle 租户） */
export type DbKind = 'mysql' | 'oceanbase-mysql' | 'pgsql' | 'oracle' | 'oceanbase-oracle'

/** 数据库连接配置 */
export interface DbConfig {
  kind: DbKind
  host: string
  port: number
  user: string
  password: string
  database?: string
  serviceName?: string
  sid?: string
  ssl?: boolean
}

/** 数据库字段元信息 */
export interface DbColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  pk: boolean
  comment?: string
}

/** 索引/约束元信息 */
export interface DbIndexInfo {
  name: string
  kind: 'INDEX' | 'UNIQUE' | 'FOREIGN'
  columns: string
  refTable?: string
  refColumns?: string
}

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

  /** 打开独立数据库窗口（最大化全屏） */
  openDatabaseWindow: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('tb:open-database-window'),

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

    /** 上传本地文件到远程（transferId 用于进度上报） */
    upload: (
      sessionId: string,
      localPath: string,
      remotePath: string,
      transferId?: string
    ): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('tb:sftp-upload', { sessionId, localPath, remotePath, transferId }),

    /** 下载远程文件到本地（transferId 用于进度上报） */
    download: (
      sessionId: string,
      remotePath: string,
      localPath: string,
      transferId?: string
    ): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('tb:sftp-download', { sessionId, remotePath, localPath, transferId }),

    /** 监听传输进度（upload/download 携带 transferId 时回调） */
    onSftpProgress: (callback: (data: { transferId: string; percent: number }) => void): void => {
      ipcRenderer.on('tb:sftp-progress', (_event, data) => callback(data))
    },

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
    ): (() => void) => on('tb:ws-event', callback as (payload: unknown) => void)
  },

  // ---------- 数据库管理 ----------
  db: {
    /** 测试连接（连通后立即断开）；深拷贝以剥离 Vue 响应式 Proxy（IPC 无法结构化克隆） */
    test: (config: DbConfig): Promise<{ success: boolean; message: string }> =>
      ipcRenderer.invoke('tb:db-test', JSON.parse(JSON.stringify(config))),

    /** 建立连接，返回会话 ID 与当前库/Schema */
    connect: (
      config: DbConfig
    ): Promise<{
      connId: string
      kind: string
      currentDatabase?: string
      currentSchema?: string
    }> => ipcRenderer.invoke('tb:db-connect', JSON.parse(JSON.stringify(config))),

    /** 关闭连接 */
    disconnect: (connId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('tb:db-disconnect', connId),

    /** 浏览目录：databases / schemas / tables / columns / sequences / procedures / indexes */
    catalog: (
      connId: string,
      scope:
        'databases' | 'schemas' | 'tables' | 'columns' | 'sequences' | 'procedures' | 'indexes',
      parent?: { database?: string; schema?: string; table?: string }
    ): Promise<Array<{ name: string; type?: string }> | DbColumnInfo[] | DbIndexInfo[]> =>
      ipcRenderer.invoke('tb:db-catalog', { connId, scope, parent }),

    /** 执行任意 SQL（查询最多返回 1000 行）；queryId 用于取消，database 切换当前库 */
    query: (
      connId: string,
      sql: string,
      queryId?: string,
      database?: string
    ): Promise<{
      columns: string[]
      rows: Record<string, unknown>[]
      affectedRows: number
      insertId?: string
      truncated: boolean
    }> => ipcRenderer.invoke('tb:db-query', { connId, sql, queryId, database }),

    /** 取消正在执行的查询 */
    cancel: (queryId: string): Promise<{ success: boolean; message?: string }> =>
      ipcRenderer.invoke('tb:db-cancel', queryId),

    /** 分页查询表数据 */
    page: (params: {
      connId: string
      database?: string
      schema?: string
      table: string
      page: number
      pageSize: number
    }): Promise<{
      columns: string[]
      rows: Record<string, unknown>[]
      affectedRows: number
      truncated: boolean
      total: number
    }> => ipcRenderer.invoke('tb:db-page', params),

    /** 行增删改 */
    modify: (params: {
      connId: string
      database?: string
      schema?: string
      table: string
      action: 'insert' | 'update' | 'delete'
      primaryKey: { name: string; value: unknown }[]
      changes: { name: string; value: unknown }[]
    }): Promise<{ affectedRows: number }> => ipcRenderer.invoke('tb:db-modify', params),

    /** 修改表字段（名称/类型/可空/注释）；深拷贝剥离 Vue 响应式 Proxy */
    alterColumn: (params: {
      connId: string
      database?: string
      schema?: string
      table: string
      oldName: string
      newName?: string
      dataType: string
      nullable: boolean
      wasNullable?: boolean
      comment?: string
    }): Promise<{ executed: string[] }> =>
      ipcRenderer.invoke('tb:db-alter-column', JSON.parse(JSON.stringify(params)))
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
      ipcRenderer.invoke('tb:save-file', { path, dataBase64 }),

    /** Office 高保真转换（word→pdf / pdf→word，使用本机 Microsoft Word） */
    officeConvert: (options: {
      inputPath: string
      outputPath: string
    }): Promise<{ success: boolean; engine?: string; message?: string }> =>
      ipcRenderer.invoke('tb:office-convert', options)
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
      | 'read-base64'
      | 'write-base64',
    ...args: unknown[]
  ): Promise<string | string[] | boolean | null> =>
    ipcRenderer.invoke('local-files', action, ...args),
  listFiles: (dir: string): Promise<string[]> => ipcRenderer.invoke('local-files', 'list', dir),
  httpRequest: (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: string,
    headers?: Record<string, string>,
    bodyBase64?: string,
    binary?: boolean
  ): Promise<{
    status: number
    data: string
    dataBase64?: string
    headers: Record<string, string | string[] | undefined>
  }> => ipcRenderer.invoke('http-request', { method, path, body, headers, bodyBase64, binary }),
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
