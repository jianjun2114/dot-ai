/**
 * mcpClient.ts —— MCP 客户端封装（供智能配置与本地模式 AI 对话复用）
 *
 * - parseMcpEntries：解析配置 JSON（兼容 mcpServers 包裹格式与直接的对象格式）
 * - rpcCall：JSON-RPC 请求（Streamable HTTP 直连失败自动降级 HTTP+SSE）
 * - listMcpTools / callMcpTool：tools/list 与 tools/call
 */
/* ---------------- 配置解析 ---------------- */

/** 单个 MCP 服务条目 */
export interface McpEntry {
  name: string
  url?: string
  command?: string
}

/** 解析配置 JSON（兼容 mcpServers 包裹格式与直接的对象格式） */
export function parseMcpEntries(json: string): McpEntry[] {
  const obj = JSON.parse(json) as Record<string, Record<string, unknown>>
  const servers = (obj.mcpServers ?? obj) as Record<string, Record<string, unknown>>
  return Object.entries(servers).map(([name, cfg]) => ({
    name,
    url: typeof cfg.url === 'string' ? cfg.url : undefined,
    command: typeof cfg.command === 'string' ? cfg.command : undefined
  }))
}

/* ---------------- 传输层 ---------------- */

/** 从响应文本中解析 JSON（兼容 SSE data: 行格式） */
function parseRpcPayload(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    const line = raw.split('\n').find((l) => l.trim().startsWith('data:'))
    if (line) {
      return JSON.parse(line.trim().slice(5)) as Record<string, unknown>
    }
    throw new Error('响应格式无法解析')
  }
}

/** 传输层失败（可降级为 SSE 传输重试的错误，区别于 JSON-RPC 业务错误） */
class HttpTransportError extends Error {}

/** 发送一次 JSON-RPC 请求（Streamable HTTP：直接 POST 并解析响应） */
async function rpcCallDirect(
  url: string,
  method: string,
  params?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await window.dot.httpRequest(
    'POST',
    url,
    JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, ...(params ? { params } : {}) }),
    { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  )
  if (res.status < 200 || res.status >= 300) throw new HttpTransportError(`HTTP ${res.status}`)
  let payload: Record<string, unknown>
  try {
    payload = parseRpcPayload(res.data)
  } catch {
    throw new HttpTransportError('响应格式无法解析')
  }
  if (payload.error) throw new Error(JSON.stringify(payload.error))
  return (payload.result ?? {}) as Record<string, unknown>
}

/** HTTP+SSE 会话 */
interface SseSession {
  rpc: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  close: () => void
}

/** SSE 连接超时（毫秒） */
const SSE_OPEN_TIMEOUT = 10_000
/** SSE 会话内单次 RPC 超时（毫秒） */
const SSE_RPC_TIMEOUT = 15_000

/**
 * 建立经典 HTTP+SSE 会话：GET 打开事件流并从首个 endpoint 事件获得消息发送地址，
 * 之后 POST 发送 JSON-RPC 请求，响应经事件流异步返回。
 * 注意：主进程未提供 SSE 流的中止接口，close 仅取消监听，连接由服务端超时回收。
 */
async function openSseSession(sseUrl: string): Promise<SseSession> {
  let messageUrl: string | null = null
  let streamError: Error | null = null
  let buffer = ''
  const pending = new Map<number, (payload: Record<string, unknown>) => void>()

  // 监听 SSE 数据块并解析事件（以空行分隔）。期间会收到本应用所有 SSE 流的
  // 数据块，设置弹窗内同一时刻只会有一个 SSE 会话，直接消费即可。
  const unsubscribe = window.dot.toolbox.net.onHttpChunk(({ chunk }) => {
    if (!chunk) return
    buffer += chunk
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) > -1) {
      const rawEvent = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const data = rawEvent
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.replace(/^data:\s?/, '').trim())
        .join('\n')
      if (!data) continue
      if (messageUrl === null) {
        // 首个事件携带消息发送地址（相对或绝对路径）
        messageUrl = new URL(data, sseUrl).toString()
        continue
      }
      try {
        const payload = JSON.parse(data) as {
          id?: number
          result?: Record<string, unknown>
          error?: unknown
        }
        if (typeof payload.id === 'number') {
          const resolver = pending.get(payload.id)
          if (resolver) {
            pending.delete(payload.id)
            resolver(payload as Record<string, unknown>)
          }
        }
      } catch {
        /* 忽略无法解析的事件 */
      }
    }
  })

  // GET 打开 SSE 长连接（不会主动结束，只需捕获连接失败）
  window.dot.toolbox.net
    .httpRequest({ method: 'GET', url: sseUrl, headers: { Accept: 'text/event-stream' } })
    .then((res) => {
      if (res.status >= 400) throw new Error(`SSE 连接失败（HTTP ${res.status}）`)
    })
    .catch((e: unknown) => {
      streamError = e instanceof Error ? e : new Error(String(e))
    })

  try {
    // 等待 endpoint 事件以获得消息发送地址
    const deadline = Date.now() + SSE_OPEN_TIMEOUT
    while (!messageUrl) {
      if (streamError) throw streamError
      if (Date.now() > deadline) throw new Error('SSE 连接超时：未收到 endpoint 事件')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const target = messageUrl
    let seq = 0

    return {
      rpc: (method, params) => {
        const id = ++seq
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error('请求超时'))
          }, SSE_RPC_TIMEOUT)
          pending.set(id, (payload) => {
            clearTimeout(timer)
            if (payload.error) reject(new Error(JSON.stringify(payload.error)))
            else resolve((payload.result ?? {}) as Record<string, unknown>)
          })
          window.dot
            .httpRequest(
              'POST',
              target,
              JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
              { 'Content-Type': 'application/json' }
            )
            .then((res) => {
              if (res.status >= 300) {
                clearTimeout(timer)
                pending.delete(id)
                reject(new Error(`消息发送失败（HTTP ${res.status}）`))
              }
            })
            .catch((e: unknown) => {
              clearTimeout(timer)
              pending.delete(id)
              reject(e instanceof Error ? e : new Error(String(e)))
            })
        })
      },
      close: unsubscribe
    }
  } catch (error) {
    unsubscribe()
    throw error
  }
}

/** 发送 JSON-RPC 请求：优先 Streamable HTTP 直连，传输层失败自动降级 HTTP+SSE */
export async function rpcCall(
  url: string,
  method: string,
  params?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  try {
    return await rpcCallDirect(url, method, params)
  } catch (error) {
    if (!(error instanceof HttpTransportError)) throw error
    const session = await openSseSession(url)
    try {
      return await session.rpc(method, params)
    } finally {
      session.close()
    }
  }
}

/* ---------------- 工具列表与调用 ---------------- */

/** JSON-RPC initialize 参数 */
export const INITIALIZE_PARAMS = {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'dot', version: '1.0.0' }
}

/** MCP 工具描述（name + 入参 JSON Schema） */
export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * 获取指定 MCP 服务（url 类型）的工具列表：先 initialize（失败不阻断）后 tools/list
 */
export async function listMcpTools(url: string): Promise<McpTool[]> {
  try {
    await rpcCall(url, 'initialize', INITIALIZE_PARAMS)
  } catch {
    /* 忽略初始化失败（部分服务可直接 tools/list） */
  }
  const result = await rpcCall(url, 'tools/list')
  const list = (result.tools as Record<string, unknown>[] | undefined) ?? []
  return list.map((t) => ({
    name: typeof t.name === 'string' ? t.name : '',
    description: typeof t.description === 'string' ? t.description : '',
    inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }
  }))
}

/** MCP 工具调用结果文本（兼容 content 数组与纯文本） */
export async function callMcpTool(url: string, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await rpcCall(url, 'tools/call', { name, arguments: args })
  const content = result.content
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'object' && c !== null && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n')
  }
  if (typeof result.result === 'string') return result.result
  return JSON.stringify(result)
}
