import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, dirname } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { exec } from 'child_process'
import http from 'http'
import https from 'https'
import fs from 'fs'
import { registerToolboxShellIpc } from './toolboxShell'
import { registerToolboxNetIpc } from './toolboxNet'

let mainWindow: BrowserWindow | null = null

const DEFAULT_CONFIG = {
  apiUrl: 'http://localhost:8000'
}

function createWindow(): void {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // 百宝箱浏览器页面需要使用 <webview> 标签
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  // IPC 事件处理  start
  // 获取应用数据目录（优先安装目录，不可写则回退到 userData）
  ipcMain.handle('app-path', () => {
    // 开发模式下 getPath('exe') 指向 node_modules 中的 electron 二进制，
    // 不是项目目录，直接用 userData
    if (is.dev) {
      return app.getPath('userData')
    }

    const installDir = dirname(app.getPath('exe'))
    const userDataDir = app.getPath('userData')

    // 检测安装目录是否可写：尝试创建/删除一个临时文件
    try {
      const testFile = join(installDir, '.dot-ai-write-test')
      fs.writeFileSync(testFile, '', 'utf-8')
      fs.unlinkSync(testFile)
    } catch {
      // Program Files 等受保护目录无写权限，回退到 userData
      console.warn(
        `[app-path] 安装目录 ${installDir} 不可写，回退到 userData: ${userDataDir}`
      )
      return userDataDir
    }

    // 生产环境 + 安装目录可写 → 返回安装目录，并迁移旧版本残留
    // 如果旧 userData 里有 dot.json 但安装目录没有，说明是首次升级，做一次性迁移
    const oldConfigFile = join(userDataDir, 'dot.json')
    const newConfigFile = join(installDir, 'dot.json')
    if (!fs.existsSync(newConfigFile) && fs.existsSync(oldConfigFile)) {
      try {
        fs.copyFileSync(oldConfigFile, newConfigFile)
        // 迁移日历记事本等用户数据目录（如果存在）
        const oldNotesDir = join(userDataDir, 'calendarNotes')
        const newNotesDir = join(installDir, 'calendarNotes')
        if (fs.existsSync(oldNotesDir) && !fs.existsSync(newNotesDir)) {
          fs.cpSync(oldNotesDir, newNotesDir, { recursive: true })
        }
        console.info('[app-path] 已将旧 userData 中的配置迁移到安装目录')
      } catch (err) {
        console.warn('[app-path] 迁移旧配置失败:', err)
      }
    }

    return installDir
  })
  // HTTP 请求代理 - 避免渲染进程 CORS 问题
  ipcMain.handle(
    'http-request',
    async (
      _event,
      options: {
        method: 'GET' | 'POST' | 'PUT' | 'DELETE'
        path: string
        body?: string
        headers?: Record<string, string>
      }
    ) => {
      const { method, path, body, headers } = options
      const url = /^https?:\/\//.test(path) ? path : `${DEFAULT_CONFIG.apiUrl}${path}`

      return new Promise<{
        status: number
        data: string
        headers: Record<string, string | string[] | undefined>
      }>((resolve, reject) => {
        const urlObj = new URL(url)
        const client = urlObj.protocol === 'https:' ? https : http

        const req = client.request(
          {
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method,
            headers: {
              'Content-Type': 'application/json',
              ...headers
            }
          },
          (res) => {
            let data = ''
            res.on('data', (chunk) => {
              data += chunk
            })
            res.on('end', () => {
              resolve({
                status: res.statusCode || 500,
                data,
                headers: res.headers
              })
            })
          }
        )

        req.on('error', (err) => {
          reject(err.message)
        })

        if (body) {
          req.write(body)
        }
        req.end()
      })
    }
  )

  // 选择目录
  ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  // 文件操作统一处理函数
  ipcMain.handle('local-files', async (_event, action: string, ...args: unknown[]) => {
    switch (action) {
      case 'list': {
        const dirPath = args[0] as string
        try {
          if (!fs.existsSync(dirPath)) return []
          return fs.readdirSync(dirPath)
        } catch {
          return []
        }
      }
      case 'create': {
        const filePath = args[0] as string
        try {
          const dir = join(filePath, '..')
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
          if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', 'utf-8')
          return true
        } catch {
          return false
        }
      }
      case 'read': {
        const filePath = args[0] as string
        try {
          if (!fs.existsSync(filePath)) return ''
          return fs.readFileSync(filePath, 'utf-8')
        } catch {
          return ''
        }
      }
      case 'write': {
        const [filePath, content] = args as [string, string]
        try {
          const dir = join(filePath, '..')
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(filePath, content, 'utf-8')
          return true
        } catch {
          return false
        }
      }
      case 'read-base64': {
        // 以 base64 读取二进制文件（图片等），供渲染进程内嵌到编辑器
        const filePath = args[0] as string
        try {
          if (!fs.existsSync(filePath)) return null
          return fs.readFileSync(filePath).toString('base64')
        } catch {
          return null
        }
      }
      case 'rename': {
        const [oldPath, newPath] = args as [string, string]
        try {
          if (!fs.existsSync(oldPath)) return false
          fs.renameSync(oldPath, newPath)
          return true
        } catch {
          return false
        }
      }
      case 'exists': {
        const filePath = args[0] as string
        return fs.existsSync(filePath)
      }
      case 'mkdir': {
        const dirPath = args[0] as string
        try {
          if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true })
          return true
        } catch {
          return false
        }
      }
      case 'delete': {
        const filePath = args[0] as string
        try {
          if (!fs.existsSync(filePath)) return false
          const stats = fs.statSync(filePath)
          if (stats.isDirectory()) {
            fs.rmdirSync(filePath, { recursive: true })
          } else {
            fs.unlinkSync(filePath)
          }
          return true
        } catch {
          return false
        }
      }
      default:
        return null
    }
  })

  // 执行本地powershell命令
  ipcMain.handle(
    'execute-command',
    async (
      _event,
      options: {
        command: string
        timeout?: number
        cwd?: string
      }
    ) => {
      const { command, timeout = 30000, cwd } = options
      return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        let execCommand = ''
        const execOpts: {
          timeout: number
          maxBuffer: number
          cwd?: string
          windowsVerbatimArguments?: boolean
          encoding?: BufferEncoding
        } = {
          timeout,
          maxBuffer: 1024 * 1024 * 10,
          encoding: 'utf-8'
        }

        if (cwd) {
          execOpts.cwd = cwd
        }
        const escapedCmd = command.replace(/"/g, '`"').replace(/\$/g, '`$')
        execCommand = `powershell.exe -NoProfile -OutputFormat Text -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${escapedCmd}"`
        execOpts.windowsVerbatimArguments = true

        exec(execCommand, execOpts, (error, stdout, stderr) => {
          // Normalize output encoding: replace garbled sequences
          const cleanStdout = (stdout || '').replace(/\r\n/g, '\n')
          const cleanStderr = (stderr || '').replace(/\r\n/g, '\n')
          if (error) {
            resolve({
              stdout: cleanStdout,
              stderr: cleanStderr || error.message,
              exitCode: error.code ?? 1
            })
          } else {
            resolve({ stdout: cleanStdout, stderr: cleanStderr, exitCode: 0 })
          }
        }).on('error', (err) => {
          resolve({ stdout: '', stderr: err.message, exitCode: 1 })
        })
      })
    }
  )

  // 注册百宝箱模块（多会话 Shell/SFTP + HTTP/WS/TCP 网络代理）
  registerToolboxShellIpc()
  registerToolboxNetIpc()

  // 打开百宝箱 Shell 独立窗口
  ipcMain.handle('tb:open-shell-window', () => {
    const shellWindow = new BrowserWindow({
      width: 1200,
      height: 760,
      title: '终端 - 百宝箱',
      autoHideMenuBar: true,
      ...(process.platform === 'linux' ? { icon } : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false
      }
    })

    // 开发环境加载 dev server，生产环境加载本地文件，hash 路由指向 Shell 页面
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      shellWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/toolbox/shell`)
    } else {
      shellWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/toolbox/shell' })
    }
    return { success: true }
  })

  // 打开百宝箱浏览器独立窗口
  ipcMain.handle('tb:open-browser-window', () => {
    const browserWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      title: '浏览器 - 百宝箱',
      autoHideMenuBar: true,
      ...(process.platform === 'linux' ? { icon } : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        // 浏览器页面需要使用 <webview> 标签
        webviewTag: true
      }
    })

    // 开发环境加载 dev server，生产环境加载本地文件，hash 路由指向浏览器页面
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      browserWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/toolbox/browser`)
    } else {
      browserWindow.loadFile(join(__dirname, '../renderer/index.html'), {
        hash: '/toolbox/browser'
      })
    }
    return { success: true }
  })

  // 用系统默认浏览器打开外部链接
  ipcMain.handle('tb:open-external', (_event, url: string) => {
    if (/^https?:\/\//.test(url)) {
      shell.openExternal(url)
      return { success: true }
    }
    return { success: false, message: '仅支持 http/https 链接' }
  })

  // webview 内打开新窗口（target=_blank / window.open）：拦截并通知渲染进程新建标签页
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return
    contents.setWindowOpenHandler(({ url }) => {
      // 转发给承载该 webview 的宿主窗口渲染进程
      if (/^https?:\/\//.test(url) && contents.hostWebContents) {
        contents.hostWebContents.send('tb:webview-new-window', {
          openerId: contents.id,
          url
        })
      }
      // 始终阻止弹出独立窗口，由渲染进程在内部以标签页打开
      return { action: 'deny' }
    })
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
