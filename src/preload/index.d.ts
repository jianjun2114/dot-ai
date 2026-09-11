import { ElectronAPI } from '@electron-toolkit/preload'

/** SSH 连接参数 */
interface SshOptions {
  host: string
  port: number
  username: string
  password: string
}

/** 文件对话框过滤器 */
interface FileFilter {
  name: string
  extensions: string[]
}

/** 百宝箱 API 类型定义 */
export interface ToolboxApi {
  /** 打开独立 Shell 窗口 */
  openShellWindow: () => Promise<{ success: boolean }>
  /** 打开独立浏览器窗口 */
  openBrowserWindow: () => Promise<{ success: boolean }>
  /** webview 内新窗口事件：页面尝试打开新链接（target=_blank / window.open） */
  onWebviewNewWindow: (
    callback: (payload: { openerId: number; url: string }) => void
  ) => () => void
  /** 用系统默认浏览器打开链接 */
  openExternal: (url: string) => Promise<{ success: boolean; message?: string }>
  /** 测试 SSH 连接（连通后立即断开，不创建会话） */
  sshTest: (options: SshOptions) => Promise<{ success: boolean; message: string }>
  /** 获取本地用户主目录 */
  homeDir: () => Promise<string>
  /** 列出本地目录（带类型/大小/修改时间） */
  fsList: (
    dirPath: string
  ) => Promise<{ name: string; type: string; size: number; modifyTime: number }[]>

  shell: {
    create: (options: {
      type: 'ssh' | 'local'
      ssh?: SshOptions
    }) => Promise<{ sessionId: string; title: string }>
    write: (sessionId: string, data: string) => Promise<void>
    resize: (sessionId: string, cols: number, rows: number) => Promise<void>
    close: (sessionId: string) => Promise<{ success: boolean }>
    onData: (callback: (payload: { sessionId: string; data: string }) => void) => () => void
    onExit: (callback: (payload: { sessionId: string; message: string }) => void) => () => void
  }

  sftp: {
    realpath: (sessionId: string, path: string) => Promise<string>
    list: (
      sessionId: string,
      path: string
    ) => Promise<{ name: string; type: string; size: number; modifyTime: number }[]>
    upload: (
      sessionId: string,
      localPath: string,
      remotePath: string,
      transferId?: string
    ) => Promise<{ success: boolean }>
    download: (
      sessionId: string,
      remotePath: string,
      localPath: string,
      transferId?: string
    ) => Promise<{ success: boolean }>
    onSftpProgress: (callback: (data: { transferId: string; percent: number }) => void) => void
    mkdir: (sessionId: string, path: string) => Promise<{ success: boolean; message?: string }>
    remove: (
      sessionId: string,
      path: string,
      isDir: boolean
    ) => Promise<{ success: boolean; message?: string }>
  }

  net: {
    httpRequest: (options: {
      method: string
      url: string
      headers?: Record<string, string>
      body?: string
      bodyType?: 'none' | 'json' | 'form' | 'raw'
      /** 渲染进程预生成的请求 ID（用于实时匹配 SSE chunk），缺省时自动生成 */
      requestId?: string
    }) => Promise<{
      requestId: string
      status: number
      statusText: string
      headers: Record<string, string>
      body: string
      elapsed: number
      isSse: boolean
    }>
    onHttpChunk: (callback: (payload: { requestId: string; chunk: string }) => void) => () => void
    wsConnect: (connId: string, url: string) => Promise<{ success: boolean }>
    wsSend: (connId: string, data: string) => Promise<{ success: boolean }>
    wsClose: (connId: string) => Promise<{ success: boolean }>
    onWsEvent: (
      callback: (payload: { connId: string; type: string; data?: string }) => void
    ) => () => void
    tcpConnect: (connId: string, host: string, port: number) => Promise<{ success: boolean }>
    tcpSend: (connId: string, data: string) => Promise<{ success: boolean }>
    tcpClose: (connId: string) => Promise<{ success: boolean }>
    onTcpEvent: (
      callback: (payload: { connId: string; type: string; data?: string }) => void
    ) => () => void
  }

  file: {
    select: (filters?: FileFilter[]) => Promise<string | null>
    selectSavePath: (defaultName: string, filters?: FileFilter[]) => Promise<string | null>
    save: (path: string, dataBase64: string) => Promise<{ success: boolean }>
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    dot: {
      getAppPath: () => Promise<string>
      selectDirectory: () => Promise<string | null>
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
      ) => Promise<string | string[] | boolean | null>
      listFiles: (dir: string) => Promise<string[]>
      httpRequest: (
        method: 'GET' | 'POST' | 'PUT' | 'DELETE',
        path: string,
        body?: string,
        headers?: Record<string, string>
      ) => Promise<{
        status: number
        data: string
        headers: Record<string, string | string[] | undefined>
      }>
      executeCommand: (
        command: string,
        timeout?: number,
        cwd?: string
      ) => Promise<{ stdout: string; stderr: string; exitCode: number }>
      toolbox: ToolboxApi
    }
  }
}
