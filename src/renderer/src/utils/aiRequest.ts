/**
 * aiRequest.ts —— 原生大模型访问封装
 *
 * 唯一入口 sendLlm()：读取「设置 → 智能配置」中启用的大模型，
 * 按配置的接口协议格式（completions / messages / responses）请求，支持：
 * - 普通响应：标准 JSON，返回 message
 * - 流式响应：SSE 聚合文本，返回全部 delta 拼接结果（聚合模式，非实时）
 * - 工具调用：function calling（tools 定义 + tool_calls 解析）
 * - 思考模式：reasoning_content 解析
 *
 * 「智能对话」（ws / local / http 多模式）已迁移至 composables/aichat.ts。
 * 请求经主进程 httpRequest 代理转发，规避渲染进程 CORS 限制；
 * 本文件同时对外导出底层解析工具，供 aichat 等模块复用。
 */
import { useSettings } from '../composables/useSettings'
import type { LlmApiFormat, LlmConfig } from '../types/settings'

/* ================================ 类型定义 ================================ */

/** 对话消息（OpenAI 兼容格式） */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

/** 工具调用回合的扩展消息：assistant 携带 tool_calls / tool 返回结果 */
export interface LlmChatMessage extends LlmMessage {
  /** assistant 发起的工具调用（role=assistant 时可携带） */
  toolCalls?: LlmToolCall[]
  /** 本条 tool 消息对应的调用 id（role=tool 时必填） */
  toolCallId?: string
}

/** 工具定义（OpenAI function calling 格式） */
export interface LlmToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** 模型发起的工具调用 */
export interface LlmToolCall {
  id: string
  /** 工具名 */
  name: string
  /** JSON 字符串形式的参数 */
  arguments: string
}

/** 大模型返回结果 */
export interface LlmResult {
  /** 思考内容（模型返回 reasoning_content 时有值），未开启 think 时为空字符串 */
  reasoning: string
  /** 回复正文 */
  content: string
  /** 模型发起的工具调用列表（未传入 tools 时为空数组） */
  toolCalls: LlmToolCall[]
}

/** sendLlm 可选项 */
export interface SendLlmOptions {
  /** 采样温度，默认 0.7 */
  temperature?: number
  /** 工具定义列表（function calling） */
  tools?: LlmToolDef[]
  /** 是否开启思考模式 */
  think?: boolean
  /** 是否流式请求 */
  stream?: boolean
}

/* ================================ 通用辅助 ================================ */

/** 读取大模型配置的接口协议格式（旧数据缺省按 completions 处理） */
export function getLlmApiFormat(llm: LlmConfig): LlmApiFormat {
  return llm.apiFormat ?? 'completions'
}

/** 读取启用中的大模型配置（无启用项时兜底第一个，避免旧数据全部未启用而不可用） */
function getActiveLlm(): LlmConfig {
  const { settings } = useSettings()
  const llms = settings.value.llmConfigs
  const llm = llms.find((c) => c.enabled) ?? llms[0]
  if (!llm) throw new Error('尚未配置大模型，请先在「设置 → 智能配置」中添加配置')
  return llm
}

/** 从错误响应体中摘要错误信息，便于排查（兼容 FastAPI 的 detail 字段） */
export function summarizeErrorBody(data: string): string {
  try {
    const payload = JSON.parse(data) as {
      error?: { message?: string }
      message?: string
      detail?: string | Array<{ msg?: string; loc?: (string | number)[] }>
    }
    const detail = payload.detail
    let msg: string | undefined
    if (typeof detail === 'string') {
      msg = detail
    } else if (Array.isArray(detail)) {
      // FastAPI 校验错误数组：拼出 "字段: 错误信息" 列表
      msg = detail
        .map((item) => `${(item.loc ?? []).slice(1).join('.')}: ${item.msg ?? ''}`.trim())
        .join('；')
    } else {
      msg = payload.error?.message ?? payload.message
    }
    return msg ? `：${msg}` : ''
  } catch {
    return ''
  }
}

/** 从 SSE 聚合文本中提取所有 data: 行的 JSON 载荷（跳过 [DONE] 等标记） */
function parseSsePayloads(raw: string): Record<string, unknown>[] {
  const payloads: Record<string, unknown>[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      payloads.push(JSON.parse(data) as Record<string, unknown>)
    } catch {
      /* 跳过无法解析的行 */
    }
  }
  return payloads
}

/** 解析非流式响应（标准 JSON，取首个 choice 的 message） */
export function parseMessageResponse(data: string): LlmResult {
  const payload = JSON.parse(data) as {
    choices?: Array<{
      message?: {
        content?: string | null
        reasoning_content?: string
        tool_calls?: Array<{
          id?: string
          function?: { name?: string; arguments?: string }
        }>
      }
    }>
  }
  const message = payload.choices?.[0]?.message
  if (!message) throw new Error('大模型未返回有效内容')
  return {
    reasoning: message.reasoning_content ?? '',
    content: (message.content ?? '').trim(),
    toolCalls: (message.tool_calls ?? []).map((tc) => ({
      id: tc.id ?? '',
      name: tc.function?.name ?? '',
      arguments: tc.function?.arguments ?? ''
    }))
  }
}

/** 流式响应单帧的结构（choices[0].delta） */
export interface StreamPayload {
  choices?: Array<{
    delta?: {
      content?: string
      reasoning_content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
  }>
}

/** 解析流式响应（SSE 聚合文本），将所有 delta 增量拼接为完整结果 */
function mergeStreamResponse(raw: string): LlmResult {
  let reasoning = ''
  let content = ''
  const toolCalls: LlmToolCall[] = []

  for (const payload of parseSsePayloads(raw)) {
    const delta = (payload as StreamPayload).choices?.[0]?.delta
    if (!delta) continue

    if (delta.reasoning_content) reasoning += delta.reasoning_content
    if (delta.content) content += delta.content

    // 工具调用按 index 增量拼接（id/name 首帧给出，arguments 分片到达）
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0
      if (!toolCalls[idx]) toolCalls[idx] = { id: '', name: '', arguments: '' }
      if (tc.id) toolCalls[idx].id = tc.id
      if (tc.function?.name) toolCalls[idx].name += tc.function.name
      if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments
    }
  }

  return { reasoning, content: content.trim(), toolCalls }
}

/* ================================ messages / responses 格式支持 ================================ */

/** 按协议格式组装请求（url / headers / body） */
export interface LlmRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/**
 * 规范化接口基础地址：去除末尾斜杠与误填的 /v1（统一由请求路径补齐），
 * 如 http://10.250.21.37:23333 或 http://10.250.21.37:23333/v1 → http://10.250.21.37:23333
 */
export function normalizeLlmBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
}

/**
 * 组装 Anthropic messages 格式请求：
 * system 消息合并为顶层 system 参数，tool 角色按 user 处理（tool 协议仅在 completions 格式支持）
 */
function buildMessagesRequest(
  base: string,
  llm: LlmConfig,
  messages: LlmMessage[],
  temperature: number,
  stream: boolean
): LlmRequest {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  return {
    url: `${base}/v1/messages`,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': llm.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: {
      model: llm.model,
      max_tokens: 4096,
      temperature,
      stream,
      ...(system ? { system } : {}),
      messages: messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
    }
  }
}

/** 组装 OpenAI Responses 格式请求 */
function buildResponsesRequest(
  base: string,
  llm: LlmConfig,
  messages: LlmMessage[],
  temperature: number,
  stream: boolean
): LlmRequest {
  return {
    url: `${base}/v1/responses`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
    body: {
      model: llm.model,
      temperature,
      stream,
      input: messages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content
      }))
    }
  }
}

/** 解析 Anthropic messages 非流式响应（content blocks：text / thinking / tool_use） */
export function parseMessagesResponse(data: string): LlmResult {
  const payload = JSON.parse(data) as {
    content?: Array<{
      type?: string
      text?: string
      thinking?: string
      id?: string
      name?: string
      input?: unknown
    }>
  }
  let reasoning = ''
  let content = ''
  const toolCalls: LlmToolCall[] = []
  for (const block of payload.content ?? []) {
    if (block.type === 'text') content += block.text ?? ''
    else if (block.type === 'thinking') reasoning += block.thinking ?? ''
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id ?? '',
        name: block.name ?? '',
        arguments: JSON.stringify(block.input ?? {})
      })
    }
  }
  return { reasoning, content: content.trim(), toolCalls }
}

/** 解析 OpenAI Responses 非流式响应（output 数组：message / reasoning / function_call） */
export function parseResponsesResponse(data: string): LlmResult {
  const payload = JSON.parse(data) as {
    output?: Array<{
      type?: string
      content?: Array<{ type?: string; text?: string }>
      summary?: Array<{ type?: string; text?: string }>
      id?: string
      call_id?: string
      name?: string
      arguments?: string
    }>
  }
  let reasoning = ''
  let content = ''
  const toolCalls: LlmToolCall[] = []
  for (const item of payload.output ?? []) {
    if (item.type === 'message') {
      for (const c of item.content ?? []) {
        if (c.type === 'output_text') content += c.text ?? ''
      }
    } else if (item.type === 'reasoning') {
      for (const s of item.summary ?? []) {
        if (s.type === 'summary_text') reasoning += s.text ?? ''
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id ?? item.id ?? '',
        name: item.name ?? '',
        arguments: item.arguments ?? ''
      })
    }
  }
  return { reasoning, content: content.trim(), toolCalls }
}

/** 解析 messages 格式流式响应（SSE 聚合文本），拼接 text_delta / thinking_delta */
function mergeMessagesStream(raw: string): LlmResult {
  let reasoning = ''
  let content = ''
  const toolCalls: LlmToolCall[] = []
  const toolIdx = new Map<number, number>() // block index → toolCalls 下标

  for (const payload of parseSsePayloads(raw)) {
    const type = payload.type as string | undefined
    if (type === 'content_block_start') {
      const block = (payload.content_block ?? {}) as { type?: string; id?: string; name?: string }
      if (block.type === 'tool_use') {
        toolIdx.set(payload.index as number, toolCalls.length)
        toolCalls.push({ id: block.id ?? '', name: block.name ?? '', arguments: '' })
      }
    } else if (type === 'content_block_delta') {
      const delta = (payload.delta ?? {}) as {
        type?: string
        text?: string
        thinking?: string
        partial_json?: string
      }
      if (delta.type === 'text_delta') content += delta.text ?? ''
      else if (delta.type === 'thinking_delta') reasoning += delta.thinking ?? ''
      else if (delta.type === 'input_json_delta') {
        const idx = toolIdx.get(payload.index as number)
        if (idx !== undefined) toolCalls[idx].arguments += delta.partial_json ?? ''
      }
    }
  }
  return { reasoning, content: content.trim(), toolCalls }
}

/** 解析 responses 格式流式响应（SSE 聚合文本），拼接各类 delta 事件 */
function mergeResponsesStream(raw: string): LlmResult {
  let reasoning = ''
  let content = ''
  const toolCalls: LlmToolCall[] = []
  const toolIdx = new Map<string, number>() // item_id → toolCalls 下标

  for (const payload of parseSsePayloads(raw)) {
    const type = payload.type as string | undefined
    if (type === 'response.output_item.added') {
      const item = (payload.item ?? {}) as {
        type?: string
        id?: string
        call_id?: string
        name?: string
      }
      if (item.type === 'function_call') {
        toolIdx.set(item.id ?? '', toolCalls.length)
        toolCalls.push({ id: item.call_id ?? '', name: item.name ?? '', arguments: '' })
      }
    } else if (type === 'response.output_text.delta') {
      content += (payload.delta as string | undefined) ?? ''
    } else if (type === 'response.reasoning_summary_text.delta') {
      reasoning += (payload.delta as string | undefined) ?? ''
    } else if (type === 'response.function_call_arguments.delta') {
      const idx = toolIdx.get(payload.item_id as string)
      if (idx !== undefined) toolCalls[idx].arguments += (payload.delta as string | undefined) ?? ''
    }
  }
  return { reasoning, content: content.trim(), toolCalls }
}

/** 按协议格式解析响应：流式为 SSE 聚合文本，非流式为标准 JSON */
export function parseLlmResponse(format: LlmApiFormat, data: string, stream: boolean): LlmResult {
  if (format === 'messages') return stream ? mergeMessagesStream(data) : parseMessagesResponse(data)
  if (format === 'responses')
    return stream ? mergeResponsesStream(data) : parseResponsesResponse(data)
  return stream ? mergeStreamResponse(data) : parseMessageResponse(data)
}

/* ================================ 入口：sendLlm / sendLlmTo ================================ */

/**
 * 调用指定的大模型配置（按其协议格式：completions / messages / responses）
 * @param llm 大模型配置
 * @param messages 对话消息列表（可含 assistant.toolCalls / tool.toolCallId 工具回合消息）
 * @param options 可选项：temperature / tools / think / stream（tools / think 仅 completions 格式支持）
 * @returns 思考内容 + 回复正文 + 工具调用列表
 * @throws 配置不完整或接口调用失败时抛出异常
 */
export const sendLlmTo = async (
  llm: LlmConfig,
  messages: LlmChatMessage[],
  options: SendLlmOptions = {}
): Promise<LlmResult> => {
  if (!llm.baseUrl.trim() || !llm.model.trim()) {
    throw new Error(`大模型「${llm.name}」配置不完整，请补全接口地址与模型名称`)
  }

  const { temperature = 0.7, tools, think = false, stream = false } = options
  const format = getLlmApiFormat(llm)
  const base = normalizeLlmBase(llm.baseUrl)

  // 组装请求体（按协议格式分发）
  let request: LlmRequest
  if (format === 'messages') {
    if (tools && tools.length > 0) {
      throw new Error(`大模型「${llm.name}」为 messages 格式，暂不支持工具调用`)
    }
    request = buildMessagesRequest(base, llm, messages, temperature, stream)
  } else if (format === 'responses') {
    if (tools && tools.length > 0) {
      throw new Error(`大模型「${llm.name}」为 responses 格式，暂不支持工具调用`)
    }
    request = buildResponsesRequest(base, llm, messages, temperature, stream)
  } else {
    // completions（OpenAI 兼容格式）：展开工具回合消息为 OpenAI 结构
    // - think：思考模式开关（vLLM / Qwen 系约定，通过 chat_template_kwargs 透传）
    // - tools：function calling 定义，模型自主决定是否调用
    request = {
      url: `${base}/v1/chat/completions`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
      body: {
        model: llm.model,
        temperature,
        messages: messages.map((m) => {
          if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
            return {
              role: m.role,
              content: m.content,
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments }
              }))
            }
          }
          if (m.role === 'tool') {
            return { role: m.role, content: m.content, tool_call_id: m.toolCallId ?? '' }
          }
          return { role: m.role, content: m.content }
        }),
        stream,
        ...(think ? { chat_template_kwargs: { thinking: true } } : {}),
        ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {})
      }
    }
  }

  const { status, data } = await window.dot.httpRequest(
    'POST',
    request.url,
    JSON.stringify(request.body),
    request.headers
  )

  if (status !== 200) {
    throw new Error(`大模型「${llm.name}」请求失败（HTTP ${status}）${summarizeErrorBody(data)}`)
  }

  // 按协议格式与请求方式解析
  return parseLlmResponse(format, data, stream)
}

/**
 * 调用「智能配置」中启用的大模型（按配置的协议格式：completions / messages / responses）
 * @param messages 对话消息列表（可含工具回合消息）
 * @param options 可选项：temperature / tools / think / stream（tools / think 仅 completions 格式支持）
 * @returns 思考内容 + 回复正文 + 工具调用列表
 * @throws 未配置大模型、配置不完整或接口调用失败时抛出异常
 */
export const sendLlm = async (
  messages: LlmChatMessage[],
  options: SendLlmOptions = {}
): Promise<LlmResult> => sendLlmTo(getActiveLlm(), messages, options)

/* ================================ 流式入口：sendLlmStream ================================ */

/** sendLlmStream 可选项 */
export interface SendLlmStreamOptions {
  /** 采样温度，默认 0.7 */
  temperature?: number
  /** 是否开启深度思考（仅 completions 格式支持，通过 chat_template_kwargs 透传） */
  think?: boolean
  /** 正文增量回调（真实流式，逐帧触发） */
  onContent?: (delta: string) => void
  /** 思考内容增量回调（模型输出 reasoning_content / thinking 时触发） */
  onReasoning?: (delta: string) => void
  /** 取消信号：中止后停止接收并抛出 AbortError（渲染侧软中断，主进程请求自然结束） */
  signal?: AbortSignal
}

/** 流式请求自增序列（配合时间戳生成渲染进程侧唯一 requestId） */
let llmStreamSeq = 0

/**
 * 组装三种协议格式的流式请求（不含 tools / think：
 * 工具协议由提示词承载，天然兼容 completions / messages / responses 全部格式）
 */
function buildStreamRequest(
  llm: LlmConfig,
  messages: LlmChatMessage[],
  temperature: number,
  think = false
): LlmRequest {
  const base = normalizeLlmBase(llm.baseUrl)
  const format = getLlmApiFormat(llm)
  console.log('think', think)
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
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
        temperature,
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
        temperature,
        stream: true,
        ...(system ? { instructions: system } : {}),
        input: rest
      }
    }
  }
  return {
    url: `${base}/v1/chat/completions`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
    body: {
      model: llm.model,
      temperature,
      stream: true,
      messages: rest,
      // 深度思考开关（vLLM / Qwen 系约定）
      ...(think ? { chat_template_kwargs: { thinking: true } } : {})
    }
  }
}

/**
 * 调用启用中的大模型（SSE 真实流式）：
 * 经主进程流式代理逐帧接收，按协议格式解析正文 / 思考增量并回调，结束后返回聚合结果。
 * 服务端不支持流式（返回普通 JSON）时自动按非流式解析。
 * @param messages 对话消息列表（含 system；工具协议由提示词承载）
 * @param options temperature / onContent / onReasoning
 * @returns 思考内容 + 回复正文的聚合结果（toolCalls 恒为空：工具走提示词协议）
 * @throws 未配置大模型、配置不完整或接口调用失败时抛出异常
 */
export const sendLlmStream = async (
  messages: LlmChatMessage[],
  options: SendLlmStreamOptions = {}
): Promise<LlmResult> => {
  const { temperature = 0.7, think = false, onContent, onReasoning, signal } = options
  const llm = getActiveLlm()
  if (!llm.baseUrl.trim() || !llm.model.trim()) {
    throw new Error(`大模型「${llm.name}」配置不完整，请补全接口地址与模型名称`)
  }

  const format = getLlmApiFormat(llm)
  const request = buildStreamRequest(llm, messages, temperature, think)
  const requestId = `llm-stream-${Date.now()}-${++llmStreamSeq}`

  return new Promise<LlmResult>((resolve, reject) => {
    let content = ''
    let reasoning = ''
    let buffer = ''
    let settled = false

    const succeed = (result: LlmResult): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      unsubscribeChunks()
      resolve(result)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      unsubscribeChunks()
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    /** 中止处理：抛出 AbortError（与 aichat 的停止语义一致） */
    const onAbort = (): void => fail(new DOMException('已停止生成', 'AbortError'))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()

    /** 消费一行 SSE 文本：按协议格式提取正文 / 思考增量并回调 */
    const consumeSseLine = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') return
      // 调试：打印每帧原始数据（定位 reasoning / <think> 来源）
      console.log('[llm] sse frame:', data)
      try {
        const payload = JSON.parse(data) as Record<string, unknown>
        let contentDelta = ''
        let reasoningDelta = ''
        if (format === 'messages') {
          // Anthropic 事件流：content_block_delta（text_delta / thinking_delta）
          if (payload.type === 'content_block_delta') {
            const delta = payload.delta as { type?: string; text?: string; thinking?: string }
            if (delta?.type === 'text_delta') contentDelta = delta.text ?? ''
            else if (delta?.type === 'thinking_delta') reasoningDelta = delta.thinking ?? ''
          }
        } else if (format === 'responses') {
          // OpenAI Responses 事件流：output_text.delta / reasoning_summary_text.delta
          if (payload.type === 'response.output_text.delta') {
            contentDelta = (payload.delta as string) ?? ''
          } else if (payload.type === 'response.reasoning_summary_text.delta') {
            reasoningDelta = (payload.delta as string) ?? ''
          }
        } else {
          // OpenAI 兼容事件流：choices[0].delta.content / reasoning_content
          const delta = (payload as StreamPayload).choices?.[0]?.delta
          contentDelta = delta?.content ?? ''
          reasoningDelta = delta?.reasoning_content ?? ''
        }
        if (contentDelta) {
          content += contentDelta
          onContent?.(contentDelta)
        }
        // 深度思考关闭时不拼接 reasoning_content（服务端默认开启也忽略）
        if (reasoningDelta && think) {
          reasoning += reasoningDelta
          onReasoning?.(reasoningDelta)
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
              `大模型「${llm.name}」请求失败（HTTP ${result.status}）${summarizeErrorBody(result.body)}`
            )
          )
          return
        }
        if (result.isSse) {
          // 冲洗残余缓冲（无换行符的末行）后聚合返回
          if (buffer.trim()) consumeSseLine(buffer)
          // 调试：打印最终聚合的思考与正文
          console.log('[llm] 聚合 reasoning:', reasoning)
          console.log('[llm] 聚合 content:', content)
          succeed({ reasoning, content: content.trim(), toolCalls: [] })
        } else {
          // 服务端忽略 stream 参数返回普通 JSON：按非流式解析
          // 调试：打印非流式响应原文
          console.log('[llm] 非流式响应原文:', result.body)
          try {
            succeed(parseLlmResponse(format, result.body, false))
          } catch (e) {
            fail(e)
          }
        }
      })
      .catch(fail)
  })
}
