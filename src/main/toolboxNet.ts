/**
 * 百宝箱 - 接口测试网络代理模块
 *
 * 在主进程代理网络请求，避免渲染进程 CORS 限制：
 * - HTTP：支持 GET/POST/PUT/DELETE/PATCH，JSON/表单/原始文本请求体，SSE 流式响应
 * - WebSocket：连接/发送/关闭，消息以事件推送给渲染进程
 * - TCP：原始 socket 连接，发送文本数据，收发以事件推送
 */
import { ipcMain, BrowserWindow } from 'electron'
import http from 'http'
import https from 'https'
import net from 'net'
import { URL } from 'url'

/** 请求体类型 */
export type HttpBodyType = 'none' | 'json' | 'form' | 'raw'

/** HTTP 请求参数 */
export interface HttpRequestOptions {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
  bodyType?: HttpBodyType
  /** 渲染进程预生成的请求 ID（用于实时匹配 SSE chunk），缺省时自动生成 */
  requestId?: string
  /** 空闲超时（毫秒）：连接阶段或响应中途超过该时长没有任何数据到达则中止请求，默认 60000 */
  idleTimeout?: number
}

/** HTTP 响应结果（非 SSE） */
export interface HttpResult {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  elapsed: number
  isSse: boolean
}

/** 请求 ID 自增序列 */
let requestSeq = 0

/** 向所有窗口广播事件 */
const broadcast = (channel: string, payload: unknown): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/** 根据请求体类型构造 Content-Type 请求头 */
const contentTypeFor = (bodyType: HttpBodyType = 'json'): string => {
  switch (bodyType) {
    case 'json':
      return 'application/json'
    case 'form':
      return 'application/x-www-form-urlencoded'
    case 'raw':
      return 'text/plain'
    default:
      return ''
  }
}

/** 创建 WebSocket / TCP 连接注册表（key 为连接 ID） */
const wsConnections = new Map<string, WebSocket>()
const tcpConnections = new Map<string, net.Socket>()

/** 注册接口测试相关的所有 IPC 处理器 */
export function registerToolboxNetIpc(): void {
  // ==================== HTTP（含 SSE） ====================

  ipcMain.handle(
    'tb:http-request',
    async (_event, options: HttpRequestOptions): Promise<HttpResult> => {
      const requestId = options.requestId || `http-${++requestSeq}`
      const startedAt = Date.now()
      const url = new URL(options.url)
      const client = url.protocol === 'https:' ? https : http
      // 空闲超时：连接阶段或响应中途 N 毫秒无数据到达即中止（流式每帧到达都会重置计时）
      const idleTimeout = options.idleTimeout ?? 60000

      const headers: Record<string, string> = { ...(options.headers || {}) }
      const contentType = contentTypeFor(options.bodyType)
      if (contentType && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = contentType
      }

      return new Promise<HttpResult>((resolve, reject) => {
        const req = client.request(
          {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: options.method,
            headers
          },
          (res) => {
            const resHeaders: Record<string, string> = {}
            for (const [key, value] of Object.entries(res.headers)) {
              resHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value ?? '')
            }

            // 空闲超时由外层 req.setTimeout 统一处理（socket 收到数据会自动重置计时）

            // 判断是否为 SSE 流式响应
            const isSse = /text\/event-stream/i.test(resHeaders['content-type'] || '')
            if (isSse) {
              // SSE：每个 chunk 实时推送给渲染进程
              broadcast('tb:http-chunk', { requestId, chunk: '' })
              res.on('data', (chunk: Buffer) => {
                broadcast('tb:http-chunk', { requestId, chunk: chunk.toString('utf-8') })
              })
              res.on('end', () => {
                resolve({
                  status: res.statusCode || 0,
                  statusText: res.statusMessage || '',
                  headers: resHeaders,
                  body: '',
                  elapsed: Date.now() - startedAt,
                  isSse: true
                })
              })
              return
            }

            // 普通响应：聚合后一次性返回
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () => {
              resolve({
                status: res.statusCode || 0,
                statusText: res.statusMessage || '',
                headers: resHeaders,
                body: Buffer.concat(chunks).toString('utf-8'),
                elapsed: Date.now() - startedAt,
                isSse: false
              })
            })
          }
        )

        // 空闲超时：连接阶段与响应阶段统一生效，收到数据自动重置计时，超时销毁连接
        req.setTimeout(idleTimeout, () => {
          req.destroy(new Error(`请求空闲超时（${idleTimeout}ms 内未收到任何数据）`))
        })
        req.on('error', (err) => reject(err.message))
        if (options.body && options.bodyType !== 'none') {
          req.write(options.body)
        }
        req.end()
      }).then((result: HttpResult) => {
        // 响应 ID 随结果返回，渲染进程用它匹配流式 chunk
        return { ...result, requestId }
      })
    }
  )

  // ==================== WebSocket ====================

  // 建立 WebSocket 连接
  ipcMain.handle('tb:ws-connect', async (_event, options: { connId: string; url: string }) => {
    // Electron 主进程内置 WebSocket（undici 实现）
    const WS = (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket
    if (!WS) {
      throw new Error('当前环境不支持 WebSocket')
    }
    if (wsConnections.has(options.connId)) {
      throw new Error('连接 ID 已存在')
    }

    return new Promise((resolve, reject) => {
      const ws = new WS(options.url)
      wsConnections.set(options.connId, ws)

      ws.onopen = () => {
        broadcast('tb:ws-event', { connId: options.connId, type: 'open' })
        resolve({ success: true })
      }
      ws.onmessage = (ev: MessageEvent) => {
        broadcast('tb:ws-event', {
          connId: options.connId,
          type: 'message',
          data: typeof ev.data === 'string' ? ev.data : '[二进制数据]'
        })
      }
      ws.onclose = () => {
        wsConnections.delete(options.connId)
        broadcast('tb:ws-event', { connId: options.connId, type: 'close' })
      }
      ws.onerror = () => {
        broadcast('tb:ws-event', { connId: options.connId, type: 'error', data: '连接发生错误' })
        reject(new Error('WebSocket 连接失败'))
      }
    })
  })

  // 发送 WebSocket 消息
  ipcMain.handle('tb:ws-send', (_event, options: { connId: string; data: string }) => {
    const ws = wsConnections.get(options.connId)
    if (!ws || ws.readyState !== 1) {
      throw new Error('WebSocket 未连接')
    }
    ws.send(options.data)
    return { success: true }
  })

  // 关闭 WebSocket 连接
  ipcMain.handle('tb:ws-close', (_event, options: { connId: string }) => {
    wsConnections.get(options.connId)?.close()
    return { success: true }
  })

  // ==================== TCP ====================

  // 建立 TCP 连接
  ipcMain.handle(
    'tb:tcp-connect',
    async (_event, options: { connId: string; host: string; port: number }) => {
      if (tcpConnections.has(options.connId)) {
        throw new Error('连接 ID 已存在')
      }

      return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: options.host, port: options.port })
        tcpConnections.set(options.connId, socket)

        socket.on('connect', () => {
          broadcast('tb:tcp-event', { connId: options.connId, type: 'open' })
          resolve({ success: true })
        })
        socket.on('data', (data: Buffer) => {
          broadcast('tb:tcp-event', {
            connId: options.connId,
            type: 'data',
            data: data.toString('utf-8')
          })
        })
        socket.on('close', () => {
          tcpConnections.delete(options.connId)
          broadcast('tb:tcp-event', { connId: options.connId, type: 'close' })
        })
        socket.on('error', (err: Error) => {
          broadcast('tb:tcp-event', { connId: options.connId, type: 'error', data: err.message })
          reject(err)
        })
      })
    }
  )

  // 发送 TCP 数据
  ipcMain.handle('tb:tcp-send', (_event, options: { connId: string; data: string }) => {
    const socket = tcpConnections.get(options.connId)
    if (!socket || socket.destroyed) {
      throw new Error('TCP 连接已断开')
    }
    socket.write(options.data)
    return { success: true }
  })

  // 关闭 TCP 连接
  ipcMain.handle('tb:tcp-close', (_event, options: { connId: string }) => {
    tcpConnections.get(options.connId)?.destroy()
    return { success: true }
  })
}
