/**
 * 百宝箱 - Shell 会话管理模块
 *
 * 负责管理多个终端会话（远程 SSH / 本地 PowerShell）以及 SFTP 文件传输。
 * 本地终端优先使用 node-pty（真实 PTY，支持 ANSI 颜色与窗口 resize）；
 * node-pty 加载失败时降级为 child_process 管道模式（无颜色）。
 *
 * 会话数据流：
 *   渲染进程 --tb:shell-write--> 主进程 --写入--> 终端(STDIN/SSH Stream/PTY)
 *   终端输出(STDOUT/SSH Stream/PTY) --> 主进程 --tb:shell-data--> 渲染进程 --> xterm 展示
 */
import { ipcMain, BrowserWindow, dialog } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { statSync, readdirSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2'

/** node-pty 类型与实例（动态加载，失败时降级） */
interface PtyProcess {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(listener: (data: string) => void): void
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void
}
type PtySpawn = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd?: string; env?: Record<string, string> }
) => PtyProcess

/** 尝试加载 node-pty（原生模块，可能因编译/ABI 问题不可用） */
const loadPty = (): PtySpawn | null => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pty = require('node-pty') as { spawn: PtySpawn }
    return typeof pty.spawn === 'function' ? pty.spawn : null
  } catch (e) {
    console.warn('node-pty 不可用，本地终端降级为无颜色模式:', (e as Error).message)
    return null
  }
}
const ptySpawn = loadPty()

/** SSH 连接参数 */
export interface SshConnectOptions {
  host: string
  port: number
  username: string
  password: string
}

/** 终端会话：一个会话对应 Shell 窗口的一个 Tab */
interface ShellSession {
  id: string
  type: 'ssh' | 'local'
  title: string
  /** SSH 连接客户端（远程会话） */
  client?: Client
  /** SSH shell 通道（远程会话） */
  stream?: ClientChannel
  /** 本地 PTY 终端进程（node-pty 模式，支持颜色/resize） */
  pty?: PtyProcess
  /** 本地子进程（降级模式） */
  proc?: ChildProcess
}

/** 全部活跃会话，key 为会话 ID */
const sessions = new Map<string, ShellSession>()

/** 生成唯一会话 ID */
const nextId = ((): (() => number) => {
  let seq = 0
  return () => ++seq
})()

/** 向所有窗口广播事件（Shell 窗口通过 sessionId 过滤属于自己的消息） */
const broadcast = (channel: string, payload: unknown): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/** 通过会话 ID 获取会话，不存在则抛错 */
const getSession = (sessionId: string): ShellSession => {
  const session = sessions.get(sessionId)
  if (!session) {
    throw new Error(`会话 ${sessionId} 不存在或已关闭`)
  }
  return session
}

/** 清理会话资源并通知渲染进程 */
const destroySession = (session: ShellSession, reason: string): void => {
  if (session.stream) {
    session.stream.close()
    session.stream = undefined
  }
  if (session.client) {
    session.client.end()
    session.client = undefined
  }
  if (session.pty) {
    try {
      session.pty.kill()
    } catch {
      // 进程可能已退出
    }
    session.pty = undefined
  }
  if (session.proc) {
    session.proc.kill()
    session.proc = undefined
  }
  if (sessions.has(session.id)) {
    sessions.delete(session.id)
    broadcast('tb:shell-exit', { sessionId: session.id, message: reason })
  }
}

/**
 * SSH 连接吞吐调优：
 * - windowSize：SSH 通道流控窗口，默认仅 2MB，高延迟链路上会频繁等窗口刷新导致吞吐受限；
 *   调大后多个 SFTP 分片可以同时「在途」，配合 fastPut/fastGet 并发才能真正吃满带宽
 * - highWaterMark：通道流缓冲水位，调大减少背压停顿
 * - cipher 优先 aes128-gcm/aes128-ctr：AES-128 硬件加速下比默认 aes256-ctr 快 30%~100%
 */
const SSH_TUNING = {
  windowSize: 8 * 1024 * 1024,
  highWaterMark: 1024 * 1024,
  algorithms: {
    cipher: ['aes128-gcm@openssh.com', 'aes128-ctr', 'aes192-ctr', 'aes256-ctr']
  }
} as const

/** 创建远程 SSH 会话：连接服务器并打开交互式 shell */
const createSshSession = (
  sessionId: string,
  title: string,
  options: SshConnectOptions
): Promise<ShellSession> => {
  return new Promise((resolve, reject) => {
    const client = new Client()
    const session: ShellSession = { id: sessionId, type: 'ssh', title, client }

    client.on('ready', () => {
      // 请求一个 PTY 交互式 shell，交互式程序（vim/top 等）可正常运行
      client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
        if (err) {
          destroySession(session, err.message)
          reject(err)
          return
        }
        session.stream = stream
        sessions.set(sessionId, session)
        // 远程输出转发给渲染进程
        stream.on('data', (data: Buffer) => {
          broadcast('tb:shell-data', { sessionId, data: data.toString('utf-8') })
        })
        stream.on('close', () => destroySession(session, '远程连接已关闭'))
        stream.on('error', (e: Error) => destroySession(session, e.message))
        resolve(session)
      })
    })

    client.on('error', (err) => {
      destroySession(session, err.message)
      reject(err)
    })
    client.on('close', () => destroySession(session, 'SSH 连接已断开'))

    client.connect({
      host: options.host,
      port: options.port || 22,
      username: options.username,
      password: options.password,
      readyTimeout: 15000,
      tryKeyboard: true,
      ...SSH_TUNING
    })
  })
}

/** 创建本地 PowerShell 会话：优先 node-pty（真实 PTY，支持颜色与 resize） */
const createLocalSession = (sessionId: string): ShellSession => {
  const session: ShellSession = { id: sessionId, type: 'local', title: '本地 PowerShell' }
  sessions.set(sessionId, session)

  if (ptySpawn) {
    // PTY 模式：PowerShell 检测到 TTY，会输出 ANSI 颜色（dir / npm 等均带颜色）
    const pty = ptySpawn('powershell.exe', ['-NoLogo'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        LANG: 'zh_CN.UTF-8'
      } as Record<string, string>
    })
    session.pty = pty
    pty.onData((data) => {
      broadcast('tb:shell-data', { sessionId, data })
    })
    pty.onExit(({ exitCode }) => destroySession(session, `进程已退出（code=${exitCode}）`))
    return session
  }

  // 降级模式：spawn 管道（无 TTY，PowerShell 不输出颜色）
  // 预先设置 UTF-8 编码，避免中文乱码
  const proc = spawn('powershell.exe', [
    '-NoLogo',
    '-NoExit',
    '-Command',
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;[Console]::InputEncoding=[System.Text.Encoding]::UTF8'
  ])
  session.proc = proc

  proc.stdout?.on('data', (data: Buffer) => {
    broadcast('tb:shell-data', { sessionId, data: data.toString('utf-8') })
  })
  proc.stderr?.on('data', (data: Buffer) => {
    broadcast('tb:shell-data', { sessionId, data: data.toString('utf-8') })
  })
  proc.on('exit', (code) => destroySession(session, `进程已退出（code=${code}）`))
  proc.on('error', (err) => destroySession(session, err.message))

  return session
}

/** 打开 SSH 会话的 SFTP 通道（一次性使用后关闭） */
const openSftp = (session: ShellSession): Promise<SFTPWrapper> => {
  return new Promise((resolve, reject) => {
    if (!session.client) {
      reject(new Error('该会话不是 SSH 连接，无法使用 SFTP'))
      return
    }
    session.client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
  })
}

/** 注册 Shell 相关的所有 IPC 处理器 */
export function registerToolboxShellIpc(): void {
  // 测试 SSH 连接：连通后立即断开，不创建会话（用于新建连接时的「测试连接」按钮）
  ipcMain.handle('tb:ssh-test', async (_event, options: SshConnectOptions) => {
    return new Promise<{ success: boolean; message: string }>((resolve) => {
      const client = new Client()
      // 保证只 resolve 一次
      let settled = false
      const finish = (success: boolean, message: string): void => {
        if (settled) return
        settled = true
        client.end()
        resolve({ success, message })
      }
      client.on('ready', () => finish(true, '连接成功'))
      client.on('error', (err) => finish(false, err.message))
      client.connect({
        host: options.host,
        port: options.port || 22,
        username: options.username,
        password: options.password,
        readyTimeout: 10000,
        tryKeyboard: true
      })
    })
  })

  // 列出本地目录（带类型/大小/修改时间，供 SFTP 本地文件栏使用）
  ipcMain.handle('tb:fs-list', (_event, dirPath: string) => {
    try {
      const entries = readdirSync(dirPath || homedir(), { withFileTypes: true })
      return entries
        .filter((e) => !e.name.startsWith('.')) // 隐藏文件不展示
        .map((e) => {
          try {
            const stat = statSync(join(dirPath, e.name))
            return {
              name: e.name,
              type: e.isDirectory() ? 'directory' : 'file',
              size: e.isDirectory() ? 0 : stat.size,
              modifyTime: Math.floor(stat.mtimeMs / 1000)
            }
          } catch {
            // 无权限读取的文件仅展示名称
            return {
              name: e.name,
              type: e.isDirectory() ? 'directory' : 'file',
              size: 0,
              modifyTime: 0
            }
          }
        })
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
          return a.name.localeCompare(b.name)
        })
    } catch (err) {
      throw new Error(`读取本地目录失败: ${(err as Error).message}`)
    }
  })

  // 获取本地用户主目录（SFTP 本地栏初始目录）
  ipcMain.handle('tb:home-dir', () => homedir())
  // 创建终端会话（远程 SSH 或本地 PowerShell）
  ipcMain.handle(
    'tb:shell-create',
    async (
      _event,
      options: { type: 'ssh' | 'local'; ssh?: SshConnectOptions }
    ): Promise<{ sessionId: string; title: string }> => {
      const sessionId = `shell-${nextId()}`
      if (options.type === 'ssh') {
        if (!options.ssh) throw new Error('缺少 SSH 连接参数')
        const title = `${options.ssh.username}@${options.ssh.host}`
        await createSshSession(sessionId, title, options.ssh)
        return { sessionId, title }
      }
      createLocalSession(sessionId)
      return { sessionId, title: '本地 PowerShell' }
    }
  )

  // 向终端写入数据（键盘输入）
  ipcMain.handle('tb:shell-write', (_event, options: { sessionId: string; data: string }) => {
    const session = getSession(options.sessionId)
    if (session.stream?.writable) {
      session.stream.write(options.data)
    } else if (session.pty) {
      session.pty.write(options.data)
    } else if (session.proc?.stdin?.writable) {
      session.proc.stdin.write(options.data)
    }
  })

  // 调整终端尺寸（SSH PTY 与本地 node-pty 均支持）
  ipcMain.handle(
    'tb:shell-resize',
    (_event, options: { sessionId: string; cols: number; rows: number }) => {
      const session = getSession(options.sessionId)
      if (session.stream) {
        session.stream.setWindow(options.rows, options.cols, 0, 0)
      } else if (session.pty) {
        session.pty.resize(options.cols, options.rows)
      }
    }
  )

  // 关闭终端会话
  ipcMain.handle('tb:shell-close', (_event, options: { sessionId: string }) => {
    const session = sessions.get(options.sessionId)
    if (session) {
      destroySession(session, '会话已手动关闭')
    }
    return { success: true }
  })

  // ==================== SFTP 文件传输 ====================

  // 解析远程路径（path 传 '.' 可获取用户 home 目录绝对路径）
  ipcMain.handle(
    'tb:sftp-realpath',
    async (_event, options: { sessionId: string; path: string }) => {
      const session = getSession(options.sessionId)
      const sftp = await openSftp(session)
      return new Promise((resolve, reject) => {
        sftp.realpath(options.path || '.', (err, absPath) => {
          sftp.end()
          if (err) {
            reject(err)
            return
          }
          resolve(absPath)
        })
      })
    }
  )

  // 列出远程目录
  ipcMain.handle('tb:sftp-list', async (_event, options: { sessionId: string; path: string }) => {
    const session = getSession(options.sessionId)
    const sftp = await openSftp(session)
    return new Promise((resolve, reject) => {
      sftp.readdir(options.path || '.', (err, list) => {
        sftp.end()
        if (err) {
          reject(err)
          return
        }
        resolve(
          list.map((item) => ({
            name: item.filename,
            type: item.attrs.isDirectory() ? 'directory' : 'file',
            size: item.attrs.size,
            modifyTime: item.attrs.mtime
          }))
        )
      })
    })
  })

  /** fastPut/fastGet 并发传输进度回调：按百分比节流上报，避免 IPC 洪泛 */
  const makeProgressReporter = (
    sender: Electron.WebContents,
    transferId: string | undefined
  ): ((transferred: number, _chunk: number, total: number) => void) => {
    let lastPercent = -1
    return (transferred, _chunk, total) => {
      if (!transferId || total <= 0) return
      const percent = Math.min(99, Math.round((transferred / total) * 100))
      if (percent !== lastPercent) {
        lastPercent = percent
        sender.send('tb:sftp-progress', { transferId, percent })
      }
    }
  }

  // 上传本地文件到远程目录（fastPut 并发传输，远快于单请求 pipe）
  ipcMain.handle(
    'tb:sftp-upload',
    async (
      _event,
      options: { sessionId: string; localPath: string; remotePath: string; transferId?: string }
    ) => {
      const session = getSession(options.sessionId)
      const sftp = await openSftp(session)
      return new Promise((resolve, reject) => {
        sftp.fastPut(
          options.localPath,
          options.remotePath,
          {
            // 并发 64 路、每片 64KB：吞吐瓶颈从 RTT 变为带宽
            concurrency: 64,
            chunkSize: 65536,
            step: makeProgressReporter(_event.sender, options.transferId)
          },
          (err) => {
            sftp.end()
            if (err) reject(err)
            else {
              if (options.transferId) {
                _event.sender.send('tb:sftp-progress', {
                  transferId: options.transferId,
                  percent: 100
                })
              }
              resolve({ success: true })
            }
          }
        )
      })
    }
  )

  // 下载远程文件到本地（fastGet 并发传输）
  ipcMain.handle(
    'tb:sftp-download',
    async (
      _event,
      options: { sessionId: string; remotePath: string; localPath: string; transferId?: string }
    ) => {
      const session = getSession(options.sessionId)
      const sftp = await openSftp(session)
      return new Promise((resolve, reject) => {
        sftp.fastGet(
          options.remotePath,
          options.localPath,
          {
            concurrency: 64,
            chunkSize: 65536,
            step: makeProgressReporter(_event.sender, options.transferId)
          },
          (err) => {
            sftp.end()
            if (err) reject(err)
            else {
              if (options.transferId) {
                _event.sender.send('tb:sftp-progress', {
                  transferId: options.transferId,
                  percent: 100
                })
              }
              resolve({ success: true })
            }
          }
        )
      })
    }
  )

  // 在远程创建目录
  ipcMain.handle('tb:sftp-mkdir', async (_event, options: { sessionId: string; path: string }) => {
    const session = getSession(options.sessionId)
    const sftp = await openSftp(session)
    return new Promise((resolve) => {
      sftp.mkdir(options.path, (err) => {
        sftp.end()
        resolve({ success: !err, message: err?.message })
      })
    })
  })

  // 删除远程文件或目录
  ipcMain.handle(
    'tb:sftp-delete',
    async (_event, options: { sessionId: string; path: string; isDir: boolean }) => {
      const session = getSession(options.sessionId)
      const sftp = await openSftp(session)
      return new Promise((resolve) => {
        const cb = (err?: Error | null): void => {
          sftp.end()
          resolve({ success: !err, message: err?.message })
        }
        if (options.isDir) {
          sftp.rmdir(options.path, cb)
        } else {
          sftp.unlink(options.path, cb)
        }
      })
    }
  )

  // ==================== 文件对话框（Shell/SFTP/文档转换共用） ====================

  // 选择本地文件（filters 形如 [{ name: '图片', extensions: ['png','jpg'] }]）
  ipcMain.handle(
    'tb:select-file',
    async (_event, options?: { filters?: { name: string; extensions: string[] }[] }) => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: options?.filters
      })
      return result.canceled ? null : result.filePaths[0]
    }
  )

  // 选择保存位置，返回用户选择的完整文件路径
  ipcMain.handle(
    'tb:select-save-path',
    async (
      _event,
      options: { defaultName: string; filters?: { name: string; extensions: string[] }[] }
    ) => {
      const result = await dialog.showSaveDialog({
        defaultPath: options.defaultName,
        filters: options.filters
      })
      return result.canceled ? null : result.filePath
    }
  )

  // 保存文件（data 为 base64 编码内容，支持二进制）
  ipcMain.handle('tb:save-file', async (_event, options: { path: string; dataBase64: string }) => {
    const { writeFileSync } = await import('fs')
    writeFileSync(options.path, Buffer.from(options.dataBase64, 'base64'))
    return { success: true }
  })

  // 获取本地文件大小（SFTP 传输进度提示用）
  ipcMain.handle('tb:file-size', (_event, path: string) => {
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  })

  // 取文件名工具（渲染进程展示用）
  ipcMain.handle('tb:basename', (_event, path: string) => basename(path || ''))
}
