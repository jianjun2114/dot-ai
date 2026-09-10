/**
 * aichat.ts —— AI 智能对话封装
 *
 * 读取「设置 → 智能对话」中启用的接口配置，按连接模式分发：
 * - ws：STOMP 流式对话（订阅 /topic/chat 接收，发送至 /app/chat）
 * - local：转发给关联的大模型配置（按其协议格式 completions / messages / responses，SSE 真实流式）
 * - http：POST { content, think }（服务端 HTTP 对话协议：问题内容 + 思考模式开关），
 *   回复优先取 reply 字段，兼容 OpenAI 格式
 *
 * 底层解析工具（错误摘要 / 非流式响应解析 / SSE 帧结构）复用 utils/aiRequest。
 */
import { useSettings } from './useSettings'
import { useStomp, type StompMessage } from './useStomp'
import { useAiLocalTools, executeLocalTool } from './aiLocalTool'
import type { Ref } from 'vue'
import type { ChatEndpoint, LlmConfig } from '../types/settings'
import {
  summarizeErrorBody,
  parseLlmResponse,
  getLlmApiFormat,
  normalizeLlmBase,
  type LlmChatMessage,
  type LlmMessage,
  type StreamPayload
} from '../utils/aiRequest'
import {
  parseMcpEntries,
  listMcpTools,
  callMcpTool,
  type McpEntry
} from '../utils/mcpClient'

/** 内置工具列表（供本地模式智能体收集工具定义） */
const { tools: aiLocalTools } = useAiLocalTools()

/* ================================ 类型定义 ================================ */

/** chat 可选项 */
export interface ChatOptions {
  /** 是否开启思考模式（http 模式随请求体透传；ws 模式协议无此字段，被忽略） */
  think?: boolean
  /** 历史对话（local 模式使用，按时间正序，不含本次用户消息） */
  history?: { role: 'user' | 'assistant'; content: string }[]
  /**
   * 流式增量回调：
   * - ws / local 模式：每收到一帧增量回调一次（真实流式）
   * - http 模式：主进程为聚合响应，收到完整回复后回调一次
   */
  onDelta?: (delta: string) => void
  /** 取消信号：中止后停止接收（ws 模式会真实断开连接）并抛出 AbortError */
  signal?: AbortSignal
}

/** chat 返回结果 */
export interface ChatResult {
  /** 回复文本 */
  reply: string
  /** 服务端对话会话 id（服务端未返回时为空字符串） */
  sessionId: string
}

/* ================================ 通用辅助 ================================ */

/** 创建中止异常（name 为 AbortError，调用方可据此静默处理） */
function abortError(): DOMException {
  return new DOMException('已停止生成', 'AbortError')
}

/* ================================ 会话登录与缓存 ================================ */

/** 读取启用中的智能对话接口（全局互斥，同时只有一个启用） */
function getActiveEndpoint(): ChatEndpoint {
  const { settings } = useSettings()
  const endpoint = settings.value.chatEndpoints.find((e) => e.enabled)
  if (!endpoint) throw new Error('尚未启用对话接口，请先在「设置 → 智能对话」中启用一个接口')
  return endpoint
}

/**
 * 会话缓存：登录成功后按接口缓存会话 Cookie，避免每次对话都重新登录。
 * 登录失效（对话请求返回 401/403）时清除并重新登录。
 */
let sessionCache: { endpointId: string; cookie: string } | null = null

/**
 * 登录对话接口，建立会话
 *
 * 会话保持由两部分合并而成：
 * 1. 服务端下发的 Set-Cookie（响应头，取每个 cookie 的 name=value 部分）
 * 2. 会话保持配置（sessionKeep）指定的字段值（如 user_code=admin，
 *    从登录响应顶层或 data 嵌套中提取；登录响应形如
 *    {"success":true,"message":"登录成功","user_code":"admin",...}）
 * 配置字段与 Set-Cookie 同名时以配置为准。
 * @returns 合并后的 Cookie 字符串，如 "SESSION=xxx; user_code=admin"
 */
async function loginEndpoint(endpoint: ChatEndpoint): Promise<string> {
  const { status, data, headers } = await window.dot.httpRequest(
    'POST',
    endpoint.login.loginUrl,
    endpoint.login.loginParams || '{}',
    { 'Content-Type': 'application/json' }
  )
  if (status !== 200) {
    throw new Error(`对话接口「${endpoint.name}」登录失败（HTTP ${status}）`)
  }

  let payload: {
    success?: boolean
    message?: string
    data?: Record<string, unknown>
  } & Record<string, unknown>
  try {
    payload = JSON.parse(data) as typeof payload
  } catch {
    throw new Error(`对话接口「${endpoint.name}」登录响应无法解析`)
  }
  if (payload.success === false) {
    throw new Error(`对话接口「${endpoint.name}」登录失败：${payload.message || '未知原因'}`)
  }

  // 1. 服务端下发的会话 Cookie：Set-Cookie 的 name=value 部分（跳过空值/删除类 cookie）
  const rawCookies = headers['set-cookie'] ?? []
  const cookieMap = new Map<string, string>()
  for (const raw of Array.isArray(rawCookies) ? rawCookies : [rawCookies]) {
    const nameValue = raw.split(';')[0].trim()
    const eq = nameValue.indexOf('=')
    if (eq <= 0) continue
    const value = nameValue.slice(eq + 1)
    if (!value.trim()) continue
    cookieMap.set(nameValue.slice(0, eq), value)
  }

  // 2. 配置的会话保持字段（顶层或 data 嵌套）
  const keepKey = endpoint.login.sessionKeep.trim()
  if (keepKey) {
    const value = payload[keepKey] ?? payload.data?.[keepKey]
    if (value === undefined || value === null || value === '') {
      throw new Error(
        `对话接口「${endpoint.name}」登录响应中未找到会话保持字段「${keepKey}」，请检查配置`
      )
    }
    cookieMap.set(keepKey, String(value))
  }

  if (cookieMap.size === 0) {
    throw new Error(
      `对话接口「${endpoint.name}」登录后未获得任何会话信息（无 Set-Cookie 且未配置会话保持字段）`
    )
  }
  return [...cookieMap].map(([k, v]) => `${k}=${v}`).join('; ')
}

/**
 * 确保启用中的对话接口已登录（存在会话缓存）。
 * 进入智能对话页面时调用一次完成预登录；后续对话复用缓存，
 * 登录失效（对话请求 401/403）时由 chat() 内部重新登录。
 */
export const ensureEndpointLogin = async (): Promise<void> => {
  const endpoint = getActiveEndpoint()
  // 仅 HTTP 模式且需要登录的接口需要维护会话
  if (endpoint.mode !== 'http' || !endpoint.needLogin || !endpoint.login.loginUrl) return
  if (sessionCache?.endpointId === endpoint.id) return
  const cookie = await loginEndpoint(endpoint)
  sessionCache = { endpointId: endpoint.id, cookie }
}

/* ================================ 对话入口：chat ================================ */

/**
 * AI 智能对话：发送一条用户消息，返回回复与服务端对话会话 id
 *
 * 按启用接口的连接模式分发：
 * - ws：STOMP 模式流式对话（订阅 /topic/chat 接收，发送至 /app/chat）
 * - local：转发给关联的大模型配置（按其协议格式 completions / messages / responses，SSE 真实流式）
 * - http：POST { content, think }（服务端 HTTP 对话协议：问题内容 + 思考模式开关），
 *   回复优先取 reply 字段，兼容 OpenAI 格式
 * @param message 用户消息
 * @param options 可选项：think / onDelta / signal
 * @returns 回复文本 + 服务端对话会话 id
 * @throws 未启用接口、请求失败或被中止（AbortError）时抛出异常
 */
export const chat = async (message: string, options: ChatOptions = {}): Promise<ChatResult> => {
  const { think = false, onDelta, signal } = options
  if (!message.trim()) throw new Error('消息内容不能为空')
  if (signal?.aborted) throw abortError()

  const endpoint = getActiveEndpoint()

  // WebSocket 模式：STOMP 流式对话
  if (endpoint.mode === 'ws') {
    return chatViaStomp(endpoint, message, { onDelta, signal })
  }

  // 本地模式：转发给关联的大模型配置（SSE 真实流式）
  if (endpoint.mode === 'local') {
    return chatViaLocalLlm(endpoint, message, { think, onDelta, signal })
  }

  // HTTP 模式：复用会话缓存（无缓存时先登录），请求以 Cookie 携带登录会话
  let cookie = ''
  if (endpoint.needLogin && endpoint.login.loginUrl) {
    if (sessionCache?.endpointId !== endpoint.id) {
      sessionCache = { endpointId: endpoint.id, cookie: await loginEndpoint(endpoint) }
    }
    cookie = sessionCache.cookie
  }

  // 请求体（服务端 HTTP 对话协议）：问题内容 content + 思考模式开关 think；
  // key 作为接口密钥以 Authorization 携带
  const sendChatRequest = (): Promise<{ status: number; data: string }> =>
    window.dot.httpRequest('POST', endpoint.apiUrl, JSON.stringify({ content: message, think }), {
      'Content-Type': 'application/json',
      ...(endpoint.key ? { Authorization: `Bearer ${endpoint.key}` } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    })

  let { status, data } = await sendChatRequest()

  // 登录失效：重新登录建立会话后重试一次
  if (status === 401 || status === 403) {
    cookie = await loginEndpoint(endpoint)
    sessionCache = { endpointId: endpoint.id, cookie }
    ;({ status, data } = await sendChatRequest())
  }

  if (status !== 200) {
    throw new Error(
      `对话接口「${endpoint.name}」请求失败（HTTP ${status}）${summarizeErrorBody(data)}`
    )
  }

  // 解析回复：优先自定义协议的 reply 字段，兼容 content / OpenAI 格式；同时提取对话会话 id
  let reply = ''
  let replySessionId = ''
  try {
    const payload = JSON.parse(data) as {
      reply?: string
      content?: string
      session_id?: string
      choices?: Array<{ message?: { content?: string } }>
    }
    reply = payload.reply ?? payload.content ?? payload.choices?.[0]?.message?.content ?? ''
    replySessionId = payload.session_id ?? ''
  } catch {
    /* 保持 reply 为空，走下方统一报错 */
  }
  if (!reply.trim()) {
    throw new Error(`对话接口「${endpoint.name}」未返回有效回复`)
  }
  onDelta?.(reply.trim())
  return { reply: reply.trim(), sessionId: replySessionId }
}

/* ================================ 本地模式（SSE 真实流式） ================================ */

/**
 * 本地模式流式对话：经主进程 SSE 代理请求关联大模型。
 * - 组装系统提示词（圆点AI 人设 + 当前时间 + 智能配置中的 SKILL 技能）
 * - 携带历史对话（options.history）
 * - completions 格式且存在可用工具时进入工具调用循环（内置工具 + MCP 工具，
 *   聚合模式，模型自主决定调用，结果回传直至产出最终回复）
 * - 无工具可用时保持 SSE 真实流式
 */
function chatViaLocalLlm(
  endpoint: ChatEndpoint,
  message: string,
  options: {
    think?: boolean
    history?: { role: 'user' | 'assistant'; content: string }[]
    onDelta?: (delta: string) => void
    signal?: AbortSignal
  }
): Promise<ChatResult> {
  const { think = false, history = [], onDelta, signal } = options
  const { settings } = useSettings()
  const llm = settings.value.llmConfigs.find((c) => c.id === endpoint.localModelId)
  if (!llm) {
    return Promise.reject(new Error(`对话接口「${endpoint.name}」关联的大模型不存在，请检查配置`))
  }
  if (!llm.baseUrl.trim() || !llm.model.trim()) {
    return Promise.reject(new Error(`大模型「${llm.name}」配置不完整，请补全接口地址与模型名称`))
  }

  // 收集工具（内置 + MCP），有工具则走提示词驱动的智能体循环（任意协议格式均可），
  // 无工具时保持 SSE 真实流式
  return collectLocalTools(settings)
    .then((tools) => {
      if (signal?.aborted) throw abortError()
      if (tools.length > 0) {
        return chatViaLocalAgent(endpoint, llm, message, { history, tools, onDelta, signal })
      }
      return chatViaLocalStream(endpoint, llm, message, {
        system: buildLocalSystemPrompt(settings),
        history,
        think,
        onDelta,
        signal
      })
    })
    .catch((error) => {
      throw error instanceof Error ? error : new Error(String(error))
    })
}

/* ---------------- 本地模式：系统提示词与工具收集 ---------------- */

/** 可执行工具：名称 / 描述 / 参数说明 / 统一执行入口 */
interface LocalAgentTool {
  name: string
  description: string
  /** 参数说明文本（无参时为空串） */
  paramsText: string
  execute: (args: Record<string, unknown>) => Promise<string>
}

/** 本地模式系统提示词：圆点AI 人设 + 当前时间 + SKILL 技能 + 可用工具与调用协议 */
function buildLocalSystemPrompt(
  settings: ReturnType<typeof useSettings>['settings'],
  tools: LocalAgentTool[] = []
): string {
  const now = new Date()
  const parts = [
    '# 角色\n' +
      '你是圆点AI（Dot AI），运行在 dot 应用中的智能助手。请用简体中文回答，' +
      '语气专业友好，回答准确简洁。',
    `# 当前时间\n${now.toLocaleString('zh-CN', { hour12: false })}`
  ]

  // SKILL 技能：以提示词形式注入
  const skills = settings.value.skillConfigs
  if (skills.length > 0) {
    parts.push(
      '# 可用技能\n' +
        '你掌握以下技能，当用户请求与技能匹配时，请严格遵循对应技能的提示词完成任务：\n' +
        skills.map((s) => `【技能：${s.name}】${s.description || ''}\n${s.prompt}`).join('\n\n')
    )
  }

  // 工具清单与调用协议
  if (tools.length > 0) {
    const toolList = tools
      .map((t) => `- ${t.name}：${t.description}${t.paramsText ? `。参数：${t.paramsText}` : '。参数：无'}`)
      .join('\n')
    parts.push(
      '# 可用工具\n' +
        '你可以调用以下工具获取信息或执行操作。请根据用户请求自主判断：' +
        '需要时调用一个或多个工具（有依赖关系时等待前序结果再调用下一个），无需要时直接回答。\n' +
        toolList +
        '\n\n# 工具调用协议\n' +
        '1. 需要调用工具时，你的本次回复只能包含调用语句，不要输出其他任何内容。' +
        '调用语句格式（可同时包含多个调用，每个单独一组标签）：\n' +
        '<tool_call>{"name":"工具名","args":{"参数名":"参数值"}}</tool_call>\n' +
        '2. 系统会执行工具，并以 <tool_result> 标签返回结果。你收到结果后继续判断：' +
        '仍需更多信息则再次输出 <tool_call>；信息充分则输出最终回答。\n' +
        '3. 最终回答使用简体中文自然语言，不得包含 <tool_call> 标签。' +
        '引用工具结果时应消化归纳，不要原样粘贴。\n' +
        '4. 工具返回失败时，可修正参数重试一次，或改用其他工具，或如实告知用户。'
    )
  }

  return parts.join('\n\n')
}

/** 从 MCP inputSchema 中提取参数说明文本 */
function schemaParamsText(schema: Record<string, unknown>): string {
  const props = (schema.properties ?? {}) as Record<string, { type?: string; description?: string }>
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
  const items = Object.entries(props).map(([name, p]) => {
    const desc = p.description || p.type || '参数'
    return required.includes(name) ? `${name}（必填，${desc}）` : `${name}（选填，${desc}）`
  })
  return items.join('、')
}

/** 收集可用工具：内置工具 + 智能配置中 url 类型 MCP 服务的工具（同名时 MCP 加服务名前缀） */
async function collectLocalTools(settings: ReturnType<typeof useSettings>['settings']): Promise<LocalAgentTool[]> {
  const tools: LocalAgentTool[] = []

  // 内置工具：params 拼接为参数说明文本
  for (const t of aiLocalTools) {
    const paramsText = t.params
      .map((p) => (p.required ? `${p.name}（必填，${p.description}）` : `${p.name}（选填，${p.description}）`))
      .join('、')
    tools.push({
      name: t.id,
      description: t.description,
      paramsText,
      execute: (args) => executeLocalTool(t.id, args)
    })
  }

  // MCP 工具：逐个 url 类型服务拉取 tools/list（单服务失败不阻断其余服务）
  for (const mcp of settings.value.mcpConfigs) {
    let entries: McpEntry[]
    try {
      entries = parseMcpEntries(mcp.configJson)
    } catch {
      continue
    }
    for (const e of entries.filter((x) => x.url)) {
      const url = e.url as string
      try {
        const list = await listMcpTools(url)
        for (const tool of list) {
          if (!tool.name) continue
          tools.push({
            // 同名工具以服务名前缀区分
            name: tools.some((t) => t.name === tool.name) ? `${e.name}__${tool.name}` : tool.name,
            description: `[MCP服务：${e.name}] ${tool.description}`,
            paramsText: schemaParamsText(tool.inputSchema),
            execute: (args) => callMcpTool(url, tool.name, args)
          })
        }
      } catch {
        /* 单个 MCP 服务不可用时跳过，不影响其余工具 */
      }
    }
  }

  return tools
}

/* ---------------- 本地模式：智能体循环（提示词驱动工具调用） ---------------- */

/** 智能体单轮最大工具调用次数 */
const AGENT_MAX_ROUNDS = 6

/** 从模型回复中解析 <tool_call> 调用语句 */
function parseToolCalls(content: string): { name: string; args: Record<string, unknown> }[] {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const re = /<tool_call>([\s\S]*?)<\/tool_call>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim()) as { name?: string; args?: Record<string, unknown> }
      if (parsed.name) calls.push({ name: parsed.name, args: parsed.args ?? {} })
    } catch {
      /* 跳过无法解析的调用语句 */
    }
  }
  return calls
}

/** 为智能体循环构建流式请求（按协议格式分发，消息列表含 system/assistant/user 文本消息） */
function buildAgentRequest(
  llm: LlmConfig,
  messages: LlmChatMessage[]
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const base = normalizeLlmBase(llm.baseUrl)
  const format = getLlmApiFormat(llm)
  const system = messages.find((m) => m.role === 'system')?.content ?? ''
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))

  if (format === 'messages') {
    return {
      url: `${base}/v1/messages`,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': llm.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: {
        model: llm.model,
        temperature: 0.7,
        max_tokens: 4096,
        stream: true,
        ...(system ? { system } : {}),
        messages: rest
      }
    }
  }
  if (format === 'responses') {
    return {
      url: `${base}/v1/responses`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
      body: {
        model: llm.model,
        temperature: 0.7,
        stream: true,
        ...(system ? { instructions: system } : {}),
        input: rest
      }
    }
  }
  return {
    url: `${base}/v1/chat/completions`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
    body: { model: llm.model, temperature: 0.7, stream: true, messages: rest }
  }
}

/**
 * 智能体循环：每轮均为 SSE 流式请求。
 * 工具调用轮的输出（<tool_call> 调用语句）被抑制不展示；最终回答轮实时逐字流式渲染。
 */
async function chatViaLocalAgent(
  endpoint: ChatEndpoint,
  llm: LlmConfig,
  message: string,
  options: {
    history: { role: 'user' | 'assistant'; content: string }[]
    tools: LocalAgentTool[]
    onDelta?: (delta: string) => void
    signal?: AbortSignal
  }
): Promise<ChatResult> {
  const { history, tools, onDelta, signal } = options

  const messages: LlmChatMessage[] = [
    { role: 'system', content: buildLocalSystemPrompt(useSettings().settings, tools) },
    ...history.map((h) => ({ role: h.role, content: h.content }) as LlmChatMessage),
    { role: 'user', content: message }
  ]

  const byName = new Map(tools.map((t) => [t.name, t]))

  for (let round = 0; round < AGENT_MAX_ROUNDS; round++) {
    if (signal?.aborted) throw abortError()

    // 流式接收本轮输出：默认抑制展示，确认不是 <tool_call> 调用轮后才实时放行
    let pending = ''
    let live = false
    const roundDelta = (delta: string): void => {
      pending += delta
      if (live) {
        onDelta?.(delta)
        return
      }
      const t = pending.trimStart()
      if (!t) return
      // 仍可能是 "<tool_call" 的不完整前缀时继续等待；确认是其他文本则开始实时展示
      if ('<tool_call'.startsWith(t) || t.startsWith('<tool_call')) return
      live = true
      onDelta?.(pending)
    }

    const full = await localLlmSse(llm, buildAgentRequest(llm, messages), {
      endpointName: endpoint.name,
      onDelta: roundDelta,
      signal
    })
    const calls = parseToolCalls(full)

    if (calls.length === 0) {
      const reply = full.trim()
      if (!reply) throw new Error(`对话接口「${endpoint.name}」未返回有效回复`)
      return { reply, sessionId: '' }
    }

    // 记录 assistant 的调用语句，逐个执行后以 tool_result 回传
    messages.push({ role: 'assistant', content: full })
    const results: string[] = []
    for (const call of calls) {
      const tool = byName.get(call.name)
      let output: string
      if (!tool) {
        output = `未找到工具：${call.name}`
      } else {
        try {
          output = await tool.execute(call.args)
        } catch (error) {
          output = `工具执行失败：${error instanceof Error ? error.message : String(error)}`
        }
      }
      results.push(`<tool_result tool="${call.name}">\n${output}\n</tool_result>`)
    }
    messages.push({
      role: 'user',
      content:
        results.join('\n\n') +
        '\n\n以上是工具执行结果。请继续：仍需调用工具请只输出 <tool_call> 调用语句；' +
        '信息充分则输出最终中文回答。'
    })
  }

  throw new Error(`对话接口「${endpoint.name}」工具调用轮次已达上限（${AGENT_MAX_ROUNDS}）`)
}

/* ---------------- 本地模式：SSE 真实流式（无工具时） ---------------- */

/** 本地模式 SSE 请求自增序列（配合时间戳生成渲染进程侧唯一 requestId） */
let localSseSeq = 0

/**
 * 本地模式 SSE 流式请求（底层管道）：发起 POST 流式请求，逐帧解析文本增量并回调，
 * 返回完整文本。供无工具流式对话与智能体循环复用。
 */
function localLlmSse(
  llm: LlmConfig,
  request: { url: string; headers: Record<string, string>; body: Record<string, unknown> },
  options: { endpointName: string; onDelta?: (delta: string) => void; signal?: AbortSignal }
): Promise<string> {
  const { endpointName, onDelta, signal } = options

  return new Promise<string>((resolve, reject) => {
    let settled = false
    let full = ''
    let buffer = ''
    const requestId = `llm-${Date.now()}-${++localSseSeq}`

    const succeed = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(full.trim())
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    /** 收敛状态：移除 chunk 订阅与中止监听（保证只执行一次） */
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
      unsubscribeChunks()
    }

    /** signal 中止：停止接收并丢弃结果 */
    const onAbort = (): void => fail(abortError())
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      fail(abortError())
      return
    }

    /** 消费一行 SSE 文本：按协议格式提取文本增量并回调 */
    const format = getLlmApiFormat(llm)
    const consumeSseLine = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') return
      try {
        let delta = ''
        if (format === 'messages') {
          // Anthropic 事件流：content_block_delta（text_delta）
          const payload = JSON.parse(data) as {
            type?: string
            delta?: { type?: string; text?: string }
          }
          if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
            delta = payload.delta.text ?? ''
          }
        } else if (format === 'responses') {
          // OpenAI Responses 事件流：output_text.delta
          const payload = JSON.parse(data) as { type?: string; delta?: string }
          if (payload.type === 'response.output_text.delta') delta = payload.delta ?? ''
        } else {
          // OpenAI 兼容事件流：choices[0].delta.content
          const delta2 = (JSON.parse(data) as StreamPayload).choices?.[0]?.delta
          delta = delta2?.content ?? ''
        }
        if (delta) {
          full += delta
          onDelta?.(delta)
        }
      } catch {
        /* 跳过无法解析的行 */
      }
    }

    // 先订阅 chunk 事件再发起请求，保证首帧不丢失
    const unsubscribeChunks = window.dot.toolbox.net.onHttpChunk((payload) => {
      if (payload.requestId !== requestId || settled) return
      buffer += payload.chunk
      // 末行可能不完整（无换行符），留待下一帧拼接
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) consumeSseLine(line)
    })

    window.dot.toolbox.net
      .httpRequest({
        requestId,
        method: 'POST',
        url: request.url,
        headers: request.headers,
        body: JSON.stringify(request.body),
        bodyType: 'json'
      })
      .then((result) => {
        if (settled) return
        if (result.status !== 200) {
          fail(
            new Error(
              `对话接口「${endpointName}」请求失败（HTTP ${result.status}）${summarizeErrorBody(result.body)}`
            )
          )
          return
        }
        if (result.isSse) {
          // 处理缓冲区中末尾未换行的最后一行
          consumeSseLine(buffer)
        } else {
          // 服务端未按 SSE 返回（不支持流式）：body 为聚合 JSON，按协议格式非流式解析
          const content = parseLlmResponse(format, result.body, false).content
          if (content) {
            full = content
            onDelta?.(content)
          }
        }
        if (!full.trim()) {
          fail(new Error(`对话接口「${endpointName}」未返回有效回复`))
          return
        }
        succeed()
      })
      .catch((error) => fail(error instanceof Error ? error : new Error(String(error))))
  })
}

/** 无工具时的本地模式流式对话：携带系统提示词与历史，SSE 真实流式 */
async function chatViaLocalStream(
  endpoint: ChatEndpoint,
  llm: LlmConfig,
  message: string,
  options: {
    system: string
    history: { role: 'user' | 'assistant'; content: string }[]
    think: boolean
    onDelta?: (delta: string) => void
    signal?: AbortSignal
  }
): Promise<ChatResult> {
  const { system, history, think = false, onDelta, signal } = options
  const base = normalizeLlmBase(llm.baseUrl)
  const format = getLlmApiFormat(llm)
  const chatMessages: LlmMessage[] = [
    { role: 'system', content: system },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: message }
  ]

  // 按协议格式分发请求地址、头与请求体（SSE 流式）
  let url: string
  let headers: Record<string, string>
  let body: Record<string, unknown>
  if (format === 'messages') {
    url = `${base}/v1/messages`
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': llm.apiKey,
      'anthropic-version': '2023-06-01'
    }
    body = {
      model: llm.model,
      temperature: 0.7,
      max_tokens: 4096,
      stream: true,
      system,
      messages: chatMessages.filter((m) => m.role !== 'system')
    }
  } else if (format === 'responses') {
    url = `${base}/v1/responses`
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` }
    body = {
      model: llm.model,
      temperature: 0.7,
      stream: true,
      instructions: system,
      input: chatMessages.filter((m) => m.role !== 'system')
    }
  } else {
    url = `${base}/v1/chat/completions`
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` }
    body = {
      model: llm.model,
      temperature: 0.7,
      messages: chatMessages,
      stream: true,
      ...(think ? { chat_template_kwargs: { thinking: true } } : {})
    }
  }

  const reply = await localLlmSse(llm, { url, headers, body }, {
    endpointName: endpoint.name,
    onDelta,
    signal
  })
  return { reply, sessionId: '' }
}

/* ================================ WebSocket（STOMP）流式对话 ================================ */

/** STOMP 对话的默认订阅主题与发送目的地（与服务端约定） */
const STOMP_CHAT_TOPIC = '/topic/chat'
const STOMP_CHAT_DESTINATION = '/app/chat'

/**
 * 等待 STOMP 握手完成（CONNECTED 帧到达后 connected 置 true）
 * 必须等到握手完成再 SUBSCRIBE，否则订阅帧会被服务端忽略
 */
function waitForStompConnected(connected: Ref<boolean>, timeoutMs: number): Promise<void> {
  if (connected.value) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => {
      clearTimeout(timer)
      clearInterval(poll)
      error ? reject(error) : resolve()
    }
    const poll = setInterval(() => {
      if (connected.value) finish()
    }, 30)
    const timer = setTimeout(
      () => finish(new Error('STOMP 握手超时，请检查对话接口地址')),
      timeoutMs
    )
  })
}

/**
 * STOMP 模式流式对话
 *
 * 连接流程：WebSocket 握手 → STOMP CONNECT → CONNECTED → SUBSCRIBE /topic/chat
 * → SEND /app/chat。对话消息协议（与 AiAssistant 组件一致）：
 * - 发送侧：{ message, context }
 * - 订阅侧推送：{ type: 'chunk', content }（增量）/ { type: 'end', content?, session_id? }
 *   （结束，content 为全量缺省时用累计值，session_id 为对话会话 id）/
 *   { type: 'error', message }（服务端错误）
 * @param endpoint 启用中的对话接口（apiUrl 即 STOMP 的 WS 地址，如 ws://host/ws）
 * @returns 回复文本 + 服务端对话会话 id
 */
function chatViaStomp(
  endpoint: ChatEndpoint,
  message: string,
  options: { onDelta?: (delta: string) => void; signal?: AbortSignal }
): Promise<ChatResult> {
  const { onDelta, signal } = options

  return new Promise<ChatResult>((resolve, reject) => {
    // 独立 STOMP 会话：对话结束或中止后立即断开，不自动重连
    const stomp = useStomp({ url: endpoint.apiUrl, reconnectInterval: 0, heartbeat: 25000 })
    let full = ''
    let settled = false

    const succeed = (content: string, sessionId = ''): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ reply: content, sessionId })
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    /** 收敛状态：清理订阅、断开连接、移除中止监听（保证只执行一次） */
    const cleanup = (): void => {
      clearTimeout(connectTimer)
      signal?.removeEventListener('abort', onAbort)
      stomp.unsubscribe(STOMP_CHAT_TOPIC)
      stomp.disconnect()
    }

    /** signal 中止：真实断开 STOMP 连接 */
    const onAbort = (): void => fail(abortError())
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      fail(abortError())
      return
    }

    // 连接总超时：10s 内未完成握手视为失败
    const connectTimer = setTimeout(() => {
      fail(new Error(`对话接口「${endpoint.name}」连接超时`))
    }, 10000)

    // 处理订阅消息（对话消息协议）
    const handleMessage = (msg: StompMessage): void => {
      if (settled) return
      let data: { type?: string; content?: string; message?: string; session_id?: string }
      try {
        data = JSON.parse(msg.body) as typeof data
      } catch {
        return // 跳过无法解析的消息
      }

      if (data.type === 'chunk' && typeof data.content === 'string') {
        full += data.content
        onDelta?.(data.content)
      } else if (data.type === 'end') {
        // end 携带全量 content 时以服务端为准，session_id 为对话会话 id
        succeed(
          typeof data.content === 'string' && data.content ? data.content : full,
          data.session_id ?? ''
        )
      } else if (data.type === 'error') {
        fail(new Error(data.message || '服务端返回错误'))
      }
      // start：服务端宣告开始流式，无需处理
    }

    const start = async (): Promise<void> => {
      try {
        await stomp.connect()
        await waitForStompConnected(stomp.connected, 10000)
        if (settled) return
        stomp.subscribe(STOMP_CHAT_TOPIC, handleMessage)
        // 服务端对话协议：{ message, context }（与 AiAssistant 组件一致）
        stomp.publish(STOMP_CHAT_DESTINATION, JSON.stringify({ message, context: '' }))
      } catch (error) {
        fail(error instanceof Error ? error : new Error('STOMP 连接失败'))
      }
    }
    start()
  })
}
