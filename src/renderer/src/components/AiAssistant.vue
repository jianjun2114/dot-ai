<script setup lang="ts">
/**
 * 通用 AI 助手侧栏组件（可伸缩，多页面复用）
 *
 * - 场景标识：通过 scene 指明接入页面（终端 / 浏览器 / 通用），头部显示场景徽标，
 *   系统提示词按场景从 composables/prompt.ts 获取
 * - 大模型调用：走 utils/aiRequest.ts 的 sendLlmStream（SSE 真实流式），
 *   读取「设置 → 智能配置」中启用的模型
 * - 工具体系：系统内置工具（aiLocalTools）+ 页面独有工具（tools prop），
 *   以 <tool_call> 提示词协议驱动（非 function calling），兼容全部接口协议格式；
 *   模型发起调用时自动执行并把 <tool_result> 回传，循环直至给出最终回复
 * - 气泡渲染：AI 回复支持 Markdown（marked + highlight.js 高亮），
 *   思考内容（reasoning）合并进气泡顶部的可折叠「思考过程」区
 * - 页面交互（双向）：
 *   - 页面 → 助手：sendToInput(text) 把页面内容填入 AI 输入框（不发送）
 *   - 助手 → 页面：模型通过页面工具操作页面；代码块「执行」按钮调用 executeCommand
 */
import { ref, computed, nextTick, reactive } from 'vue'
import {
  MagicStick,
  Promotion,
  Refresh,
  VideoPause,
  Lightning,
  Plus,
  UploadFilled
} from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import {
  AI_SCENE_LABELS,
  getSystemPrompt,
  buildToolPrompt,
  type AiScene,
  type AiTool
} from '../composables/prompt'
import { aiLocalTools } from '../composables/aiLocalTool'
import { useSettings } from '../composables/useSettings'
import { parseMcpEntries, listMcpTools, callMcpTool } from '../utils/mcpClient'
import { sendLlmStream, type LlmChatMessage, type LlmStreamChunk } from '../utils/aiRequest'
import AssistantMessage, { type LongTaskData, type LongTaskStep } from './AssistantMessage.vue'
import AiTaskPanel, { type AiTask } from './AiTaskPanel.vue'

const props = withDefaults(
  defineProps<{
    /** 接入页面场景：终端 / 浏览器 / 通用 */
    scene?: AiScene
    /** 面板标题 */
    title: string
    /** 获取宿主页面上下文（终端内容、网页正文等），支持异步 */
    getContext: () => string | Promise<string>
    /** 页面独有工具：模型可调用以操作宿主页面 */
    tools?: AiTool[]
    /** 执行 AI 生成的代码（写入终端 / 操作浏览器），可选 */
    executeCommand?: (code: string, lang: string) => void
    /** 执行按钮文案，如「执行」「在页面执行」 */
    executeLabel?: string
    /** 场景动态提示内容（shell 场景为白名单路径列表），注入系统提示词 */
    sceneExtra?: string
  }>(),
  { scene: 'generic' }
)

/** 头部场景徽标文案 */
const sceneLabel = computed(() => AI_SCENE_LABELS[props.scene])

// ==================== 面板伸缩 ====================
const MIN_WIDTH = 280
const MAX_WIDTH = 720
const panelWidth = ref(380)
const dragging = ref(false)

// ==================== 深度思考 ====================
/** 深度思考开关：开启后请求透传 chat_template_kwargs.thinking（仅 completions 格式生效） */
const deepThink = ref(false)

/** 拖拽左侧手柄调整面板宽度 */
const startDrag = (e: MouseEvent): void => {
  // 阻止默认行为，避免拖拽时选中文本
  e.preventDefault()
  dragging.value = true
  const startX = e.clientX
  const startWidth = panelWidth.value

  const onMove = (ev: MouseEvent): void => {
    // 面板在右侧，向左拖增宽
    panelWidth.value = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (startX - ev.clientX)))
  }
  const onUp = (): void => {
    dragging.value = false
    document.body.classList.remove('ai-resizing')
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  // 拖拽期间全局禁用文本选中，保持列调整光标
  document.body.classList.add('ai-resizing')
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// ==================== 消息展示 ====================
/**
 * 面板展示的消息（user / assistant 对话）。
 * assistant 的 content 是结构化流，由 AssistantMessage 解析渲染：
 * - `<think>...</think>` 思考块（多轮请求产生多个，各自独立折叠）
 * - `TOOL_CALL: 名称` / `TOOL_RESULT: ... /TOOL_RESULT` 工具调用（可折叠）
 * - 其余为 Markdown 正文
 */
interface AiMessage {
  role: 'user' | 'assistant'
  content: string
}

const messages = ref<AiMessage[]>([
  {
    role: 'assistant',
    content: '你好，我是 AI 助手。点击「读取内容」可分析当前页面上下文，也可以直接向我提问。'
  }
])
const input = ref('')
const loading = ref(false)
const messageListRef = ref<HTMLElement>()
const inputRef = ref<{ focus: () => void }>()

/** 滚动到消息底部 */
const scrollToBottom = async (): Promise<void> => {
  await nextTick()
  if (messageListRef.value) {
    messageListRef.value.scrollTop = messageListRef.value.scrollHeight
  }
}

// ==================== 气泡内确认交互 ====================
/** 待确认状态：传给最后一条 AI 消息，由 AssistantMessage 在气泡内渲染卡片 */
interface ConfirmState {
  question: string
  actions: string[]
  resolve: (action: string) => void
}
const confirmState = ref<ConfirmState | null>(null)

/**
 * 请求用户确认（在最后一条 AI 气泡内部展示卡片，不弹框）：
 * 供宿主页面的工具在执行中调用，等待用户点击按钮。
 * @param question 问题描述（支持换行）
 * @param actions 按钮文案列表（第一个为推荐操作）
 * @returns 用户点击的按钮文案；被新确认替代时返回空字符串
 */
const requestConfirm = (question: string, actions: string[]): Promise<string> => {
  // 已有确认未处理时先按取消关闭，避免堆积
  confirmState.value?.resolve('')
  return new Promise((resolve) => {
    confirmState.value = { question, actions, resolve }
    scrollToBottom()
  })
}

/** 用户点击确认按钮（AssistantMessage 回调）：resolve 并关闭卡片 */
const onConfirmAction = (action: string): void => {
  confirmState.value?.resolve(action)
  confirmState.value = null
}

// ==================== 工具体系（内置 + 页面独有） ====================

/** 内置工具 → AI 工具定义（params 描述转为 JSON Schema） */
const builtinTools: AiTool[] = aiLocalTools.map((t) => ({
  name: t.id,
  description: t.description,
  parameters: {
    type: 'object',
    properties: Object.fromEntries(
      t.params.map((p) => [p.name, { type: 'string', description: p.description }])
    ),
    required: t.params.filter((p) => p.required).map((p) => p.name)
  },
  execute: t.execute
}))

/** 当前可用的全部工具：页面独有工具优先（可按场景定制） */
// 合并工具：页面工具与内置工具同名时页面优先（如 shell 页面覆盖 edit_file 以支持远程路径路由）
const allTools = computed<AiTool[]>(() => {
  const pageTools = props.tools ?? []
  const pageNames = new Set(pageTools.map((t) => t.name))
  return [...pageTools, ...builtinTools.filter((t) => !pageNames.has(t.name))]
})

/** 系统提示词：场景提示词 + 工具调用协议（提示词驱动，兼容全部协议格式） */
const systemPrompt = (): string =>
  [getSystemPrompt(props.scene, props.sceneExtra), buildToolPrompt(allTools.value)]
    .filter(Boolean)
    .join('\n\n')

/** 从模型回复中解析 <tool_call> 调用语句 */
const parseToolCalls = (content: string): { name: string; args: Record<string, unknown> }[] => {
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

/** 工具调用最大轮数，防止模型死循环（任务子任务可传更大的值） */
const MAX_TOOL_ROUNDS = 10

/** 同一「工具 + 参数」允许的最大执行次数，超过后不再执行并回传警告 */
const MAX_IDENTICAL_CALLS = 2

/** 创建中止异常（name 为 AbortError，调用方可据此静默处理） */
const abortError = (): DOMException => new DOMException('已停止生成', 'AbortError')

/** 剥离回复正文中的 <think> 思考块（含未闭合的情况），展示与模型历史均使用净化后的内容 */
const stripThink = (content: string): string =>
  content
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/g, '')
    .trim()

/**
 * 智能体循环（提示词驱动，每轮均为流式请求）：
 * 模型输出 <tool_call> → 执行工具 → <tool_result> 回传 → 直至最终回答。
 * 整个对话回合只创建一个气泡，思考块 / 工具标记 / 正文按序追加进同一个 content 流，
 * 由 AssistantMessage 解析渲染，展示丝滑无气泡合并跳变。
 * @param chat 发给模型的完整消息（会被就地追加 assistant / user 消息）
 * @param signal 取消信号：中止后停止本轮请求 / 工具执行，气泡内追加「已停止生成」
 * @param opts.sink 展示气泡的目标数组（默认对话消息列表；任务模式写入任务日志）
 * @param opts.tools 本次循环可用的工具（默认当前场景全部工具；任务模式用任务选中的工具）
 * @param opts.maxRounds 本循环工具调用轮数上限（默认 MAX_TOOL_ROUNDS；长任务子任务可调大）
 * @returns 最终回答正文（供调用方写入多轮对话历史）；中止时返回空字符串
 */
const runAgentLoop = async (
  chat: LlmChatMessage[],
  signal?: AbortSignal,
  opts?: { sink?: AiMessage[]; tools?: AiTool[]; maxRounds?: number }
): Promise<string> => {
  const sink = opts?.sink ?? messages.value
  const byName = new Map((opts?.tools ?? allTools.value).map((t) => [t.name, t]))
  const maxRounds = opts?.maxRounds ?? MAX_TOOL_ROUNDS
  /** 已执行的「工具+参数」签名计数：识别并阻断重复调用 */
  const callCounts = new Map<string, number>()

  // 本回合唯一的回答气泡：content 为结构化流（think 块 / 工具标记 / Markdown）
  const msg = reactive<AiMessage>({ role: 'assistant', content: '' })
  sink.push(msg)
  /** 段落分隔：避免标记与前文粘连 */
  const append = (text: string): void => {
    if (msg.content && !msg.content.endsWith('\n')) msg.content += '\n'
    msg.content += text
    if (sink === messages.value) scrollToBottom()
  }

  try {
    for (let round = 0; round < maxRounds; round++) {
      if (signal?.aborted) throw abortError()
      // ---- 本轮流处理：think 标签原样保留 + tool_call JSON 抑制 ----
      let raw = '' // 原始累计正文（含 <think> 标签，think 由 AssistantMessage 解析折叠）
      let pending = '' // tool_call 抑制缓冲
      let live = false // 确认非 <tool_call> 前缀后放行实时渲染
      let nativeThinkOpen = false // 原生思考通道是否已开启 <think> 块

      /** 正文写入气泡（经 tool_call 抑制，JSON 不进入展示流） */
      const emitContent = (text: string): void => {
        if (nativeThinkOpen) {
          // 正文开始：闭合原生思考块
          msg.content += '</think>\n'
          nativeThinkOpen = false
        }
        if (live) {
          msg.content += text
          scrollToBottom()
          return
        }
        pending += text
        const t = pending.trimStart()
        if (!t) return
        // 仍可能是 "<tool_call" 的不完整前缀时继续等待；确认是其他文本则开始实时展示
        if ('<tool_call'.startsWith(t) || t.startsWith('<tool_call')) return
        live = true
        msg.content += pending
        scrollToBottom()
      }

      /**
       * 正文增量处理：think 标签跨帧拼接
       * 标签可能被拆分到多个流帧（如 "<thi" + "nk>"），末尾不足一个完整标签
       * 长度的片段保留在缓冲区等待下一帧，避免展示残缺标签。
       */
      const handleContent = (delta: string): void => {
        raw += delta
        let guard = 0
        while (raw && guard++ < 1000) {
          const start = raw.indexOf('<think>')
          if (start === -1) {
            // 末尾 ≤7 字符可能是残缺开始标签，保留待下一帧
            const safeLen = raw.length - 7
            if (safeLen > 0) {
              emitContent(raw.slice(0, safeLen))
              raw = raw.slice(safeLen)
            }
            break
          }
          emitContent(raw.slice(0, start))
          raw = raw.slice(start + '<think>'.length)
          // think 块内容原样进入展示流（闭合标签由后续帧或流结束时补齐）
          const end = raw.indexOf('</think>')
          if (end === -1) {
            msg.content += `<think>${raw}`
            raw = ''
          } else {
            msg.content += `<think>${raw.slice(0, end)}</think>\n`
            raw = raw.slice(end + '</think>'.length)
          }
          scrollToBottom()
        }
      }

      // 统一帧处理（onChunk）：思考帧包成 think 块进入展示流（仅深度思考开启时展示），
      // 正文帧经 tool_call 抑制缓冲写入
      const onChunk = (chunk: LlmStreamChunk): void => {
        if (chunk.reasoning_content && deepThink.value) {
          if (!nativeThinkOpen) {
            append('<think>')
            nativeThinkOpen = true
          }
          msg.content += chunk.reasoning_content
          scrollToBottom()
        }
        if (chunk.content) handleContent(chunk.content)
      }

      // 流式请求：网络抖动 / 空闲超时等非中止异常自动重试一次
      let result
      try {
        result = await sendLlmStream(chat, {
          signal,
          think: deepThink.value,
          onChunk
        })
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err
        append(`\n> ⚠ 请求异常（${err instanceof Error ? err.message : String(err)}），自动重试…\n`)
        result = await sendLlmStream(chat, {
          signal,
          think: deepThink.value,
          onChunk
        })
      }

      // 流结束冲洗：未闭合的 think 块补上闭合标签，残余正文按常规处理
      if (nativeThinkOpen) {
        msg.content += '</think>\n'
        nativeThinkOpen = false
      }
      if (raw) emitContent(raw)

      // 净化正文（供模型历史）：剥离 <think> 块
      const cleanContent = stripThink(result.content)
      const calls = parseToolCalls(cleanContent)
      if (calls.length === 0) {
        // 最终回答：气泡内容已流式就位；模型历史写入净化正文
        if (!msg.content.trim()) msg.content = cleanContent || '（模型未返回内容）'
        chat.push({ role: 'assistant', content: cleanContent })
        return cleanContent
      }

      // 工具调用轮：逐个执行，TOOL_CALL / TOOL_RESULT 标记按序写入展示流
      chat.push({ role: 'assistant', content: cleanContent })
      const results: string[] = []
      for (const call of calls) {
        if (signal?.aborted) throw abortError()
        const tool = byName.get(call.name)
        let output: string
        append(`TOOL_CALL: ${call.name}`)
        // 重复调用防护：同一「工具+参数」超过上限不再执行，回传警告让模型换方法
        const sig = `${call.name}:${JSON.stringify(call.args ?? {})}`
        const count = (callCounts.get(sig) ?? 0) + 1
        callCounts.set(sig, count)
        if (count > MAX_IDENTICAL_CALLS) {
          output =
            `检测到第 ${count} 次执行完全相同的调用（工具与参数均相同）。禁止继续重复：` +
            '请更换参数、换用其他工具，或基于已有结果直接给出结论。'
        } else if (!tool) {
          output = `未找到工具：${call.name}`
        } else {
          try {
            output = await tool.execute(call.args)
          } catch (e) {
            output = `工具执行失败：${e instanceof Error ? e.message : String(e)}`
          }
        }
        // 执行结果回填展示流（折叠区内实时可见）与模型上下文
        append(`TOOL_RESULT:\n${output}\n/TOOL_RESULT`)
        results.push(`<tool_result tool="${call.name}">\n${output}\n</tool_result>`)
      }
      chat.push({
        role: 'user',
        content:
          results.join('\n\n') +
          '\n\n以上是工具执行结果。请继续：仍需调用工具请只输出 <tool_call> 调用语句；' +
          '信息充分则输出最终中文回答。'
      })
    }

    append('工具调用轮次已达上限，请尝试拆解任务后重试。')
    return '工具调用轮次已达上限，请尝试拆解任务后重试。'
  } catch (e) {
    // 用户停止生成：气泡内追加提示，返回空串表示中止（不写入多轮历史）
    if (e instanceof DOMException && e.name === 'AbortError') {
      append('（已停止生成）')
      return ''
    }
    throw e
  }
}

// ==================== 发送与执行 ====================

/** 发送给大模型的对话历史（不含 system，system 每次按场景 + 工具组装） */
const history = ref<LlmChatMessage[]>([])

/** 当前回合的中止控制器：停止生成时 abort 整个智能体循环 */
let abortCtl: AbortController | null = null

/** 停止生成：中止当前流式请求与工具执行，并关闭未处理的确认卡片 */
const stopGeneration = (): void => {
  abortCtl?.abort()
  abortCtl = null
  confirmState.value?.resolve('')
  confirmState.value = null
}

/**
 * 发送消息（页面也可直接调用）
 * @param text 待发送内容；不传时使用输入框内容
 */
const sendMessage = async (text?: string): Promise<void> => {
  const content = (text ?? input.value).trim()
  if (!content || loading.value) return

  messages.value.push({ role: 'user', content })
  if (!text) input.value = ''
  loading.value = true
  await scrollToBottom()

  abortCtl = new AbortController()
  try {
    history.value.push({ role: 'user', content })
    // 最终回答写入多轮历史：保证后续提问时模型看到完整的 user/assistant 交替上下文
    console.log('systemPrompt 系统提示:', systemPrompt())
    const reply = await runAgentLoop(
      [{ role: 'system', content: systemPrompt() }, ...history.value],
      abortCtl.signal
    )
    // 中止时返回空串：部分回答不写入多轮历史，避免污染后续上下文
    if (reply) history.value.push({ role: 'assistant', content: reply })
  } catch (e) {
    messages.value.push({ role: 'assistant', content: `AI 处理出错：${e}` })
  } finally {
    abortCtl = null
    loading.value = false
    await scrollToBottom()
  }
}

/**
 * 页面内容转入 AI 输入框（不发送）
 * 供宿主页面调用，如终端右键「转到 AI」把选中内容 / 最近输出填入输入框；
 * 输入框已有内容时续写（空行分隔），不清空已有内容
 */
const sendToInput = (text: string): void => {
  const content = text.trim()
  if (!content) return
  input.value = input.value.trim() ? `${input.value.trimEnd()}${content}` : content
  inputRef.value?.focus()
}

/** 读取宿主上下文并请求 AI 分析 */
const readContext = async (): Promise<void> => {
  const context = await props.getContext()
  console.log('readContext 上下文', context)
  if (!context.trim()) {
    ElMessage.warning('当前没有可读取的内容')
    return
  }
  await sendMessage(`请分析以下内容，并给出下一步操作建议\n：${context}`)
}

/** 清空对话（生成中的请求先中止，展示消息与模型历史一并重置） */
const clearMessages = (): void => {
  stopGeneration()
  messages.value = [{ role: 'assistant', content: '对话已清空，有什么可以帮你？' }]
  history.value = []
}

/** 执行 AI 生成的代码（由宿主页面实现，经 AssistantMessage 的执行按钮回调） */
const executeCode = (code: string, lang: string): void => {
  if (!props.executeCommand) return
  try {
    props.executeCommand(code, lang)
    ElMessage.success('已执行')
  } catch (e) {
    ElMessage.error(`执行失败: ${e}`)
  }
}

// ==================== 任务模式 ====================
/** 面板模式：对话（原有）/ 任务（任务列表 + 执行日志） */
const mode = ref<'chat' | 'task'>('chat')

const { settings } = useSettings()

/** 任务执行日志（写入 AiTaskPanel 的 logs，由 AssistantMessage 渲染） */
const taskLogs = ref<AiMessage[]>([])

const taskPanelRef = ref<InstanceType<typeof AiTaskPanel>>()

/** 长任务展示状态（传入 AiTaskPanel → AssistantMessage 气泡渲染：步骤状态 + 详情 + 总结） */
const longTask = ref<LongTaskData | null>(null)

/** 步骤 id → longTask.steps 下标映射 */
const longTaskIndex = new Map<string, number>()

/** 更新长任务某步骤的状态 / 详情 */
const setStepState = (id: string, patch: Partial<LongTaskStep>): void => {
  const idx = longTaskIndex.get(id)
  if (idx !== undefined && longTask.value) Object.assign(longTask.value.steps[idx], patch)
}

/** 组装任务可用的工具：选中的页面/内置工具 + 选中 MCP 服务的工具 */
const buildTaskTools = async (task: AiTask): Promise<AiTool[]> => {
  const byName = new Map(allTools.value.map((t) => [t.name, t]))
  const tools: AiTool[] = []
  for (const name of task.tools) {
    const t = byName.get(name)
    if (t) tools.push(t)
  }
  // MCP 工具：仅拉取任务选中的服务（单服务失败不阻断其余）
  for (const id of task.mcps) {
    const mcp = settings.value.mcpConfigs.find((m) => m.id === id)
    if (!mcp) continue
    try {
      for (const e of parseMcpEntries(mcp.configJson).filter((x) => x.url)) {
        const url = e.url as string
        const list = await listMcpTools(url)
        for (const tool of list) {
          if (!tool.name) continue
          tools.push({
            // 同名工具以服务名前缀区分
            name: tools.some((t) => t.name === tool.name) ? `${mcp.name}__${tool.name}` : tool.name,
            description: `[MCP服务：${mcp.name}] ${tool.description}`,
            parameters: (tool.inputSchema ?? {
              type: 'object',
              properties: {}
            }) as AiTool['parameters'],
            execute: (args) => callMcpTool(url, tool.name, args)
          })
        }
      }
    } catch {
      /* 单个 MCP 服务不可用时跳过 */
    }
  }
  return tools
}

// ==================== 任务编排（规划 → 依赖调度 → 校验 → 失败调整 → 总结） ====================

/** 编排后的执行步骤 */
interface TaskStep {
  id: string
  /** 步骤名 */
  name: string
  /** 给子任务 AI 的详细执行指令 */
  instruction: string
  /** 依赖的步骤 id（无依赖为空数组，可并行的步骤不互相依赖） */
  depends: string[]
  /** 阶段性验证标准（空则跳过校验），长任务的防跑偏节点 */
  verify: string
}

/** 规划 JSON 解析重试上限 */
const MAX_PLAN_ROUNDS = 3
/** 单步骤重试上限 */
const MAX_STEP_RETRIES = 2
/** 调度波次上限（防死循环） */
const MAX_WAVES = 30
/** 回传给规划/校验/总结的步骤结果截断长度 */
const STEP_RESULT_LIMIT = 1500

const clip = (text: string, limit = STEP_RESULT_LIMIT): string =>
  text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text

/** 工具型提问（规划 / 校验 / 决策 / 总结等编排交互）：
 * 每次交互作为独立条目写入任务日志（think 块 + 回复正文），label 标识交互类型 */
const askLlm = async (
  system: string,
  user: string,
  signal?: AbortSignal,
  label = 'AI 交互'
): Promise<string> => {
  if (signal?.aborted) throw abortError()
  taskLogs.value.push({ role: 'user', content: `◇ ${label}` })
  let think = ''
  let out = ''
  const msg = reactive<AiMessage>({ role: 'assistant', content: '' })
  taskLogs.value.push(msg)
  await sendLlmStream(
    [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    {
      signal,
      think: deepThink.value,
      onChunk: (chunk) => {
        if (chunk.reasoning_content && deepThink.value) think += chunk.reasoning_content
        if (chunk.content) out += chunk.content
        msg.content = think ? `<think>${think}</think>\n${out}` : out
      }
    }
  )
  return out
}

/** 从模型回复中提取 JSON（容忍 markdown 代码块 / 前后缀文本）；
 * 用 function 声明避免箭头函数泛型 <T> 被 eslint vue parser 误判为 JSX */
function extractJson<T>(text: string): T | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

/** 组装任务系统提示词（场景 + 任务信息 + 技能 + 工具协议） */
const buildTaskSystem = (task: AiTask, tools: AiTool[]): string => {
  const skillText = task.skills
    .map((id) => settings.value.skillConfigs.find((s) => s.id === id))
    .filter(Boolean)
    .map((s) => `## 技能：${s!.name}\n${s!.prompt}`)
    .join('\n\n')
  const taskInfo = [
    `# 当前执行的任务\n- 名称：${task.name}`,
    task.description ? `- 描述：${task.description}` : '',
    task.schedule ? `- 任务计划：\n${task.schedule}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  return [
    getSystemPrompt(props.scene, props.sceneExtra),
    taskInfo,
    skillText,
    buildToolPrompt(tools)
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 提示词约束生成计划 JSON，解析失败自动重试 */
const requestPlan = async (
  task: AiTask,
  signal?: AbortSignal
): Promise<{ goal: string; steps: TaskStep[] } | null> => {
  const system =
    '你是任务规划器。把任务按描述拆解为可执行步骤，只输出严格 JSON，不要输出任何其他内容。' +
    'JSON 格式：{"goal":"任务目标一句话","steps":[{"id":"1","name":"步骤名","instruction":"给子AI的详细执行指令，含具体操作与预期产出","depends":[],"verify":"该步骤的验证标准"}]}' +
    '\n约束：\n' +
    '- 每个步骤都必须是可执行的具体操作：明确调用哪个工具 / 执行什么页面操作及其目标对象；禁止纯思考、纯分析类步骤，分析总结统一放最后一个步骤\n' +
    '- depends 填依赖步骤的 id 数组，无依赖为空数组；无依赖的步骤可并行执行，禁止互相依赖\n' +
    '- 有先后顺序的步骤必须用 depends 声明依赖\n' +
    '- 长任务必须设置 verify 验证标准作为阶段性校验节点，防止执行跑偏\n' +
    '- 每步 instruction 必须自包含（子 AI 看不到其他步骤的完整过程，只有依赖步骤的结果摘要）'
  for (let i = 0; i < MAX_PLAN_ROUNDS; i++) {
    const raw = await askLlm(
      system,
      `任务名称：${task.name}\n任务描述：${task.description || '无'}\n任务计划：${task.schedule || '无'}`,
      signal,
      `任务规划${i > 0 ? `（重试 ${i}）` : ''}`
    )
    const plan = extractJson<{ goal?: string; steps?: TaskStep[] }>(raw)
    if (
      plan?.goal &&
      Array.isArray(plan.steps) &&
      plan.steps.length > 0 &&
      plan.steps.every((s) => s.id && s.name && s.instruction)
    ) {
      return {
        goal: plan.goal,
        steps: plan.steps.map((s) => ({
          id: String(s.id),
          name: s.name,
          instruction: s.instruction,
          depends: Array.isArray(s.depends) ? s.depends.map(String) : [],
          verify: s.verify ?? ''
        }))
      }
    }
    taskLogs.value.push({
      role: 'assistant',
      content: `<think>计划 JSON 解析失败（第 ${i + 1} 次），已要求模型重新生成。</think>计划格式异常，正在重新生成…`
    })
  }
  return null
}

/** 执行单个子任务（独立智能体循环，日志写入 taskLogs）；
 * 依赖步骤的结果摘要一并注入子任务指令，保证子 AI 有足够上下文 */
const runStep = async (
  step: TaskStep,
  system: string,
  tools: AiTool[],
  results: Map<string, string>,
  signal?: AbortSignal
): Promise<string> => {
  taskLogs.value.push({ role: 'user', content: `▶ 子任务 ${step.id}：${step.name}` })
  const depText = step.depends
    .map((id) => {
      const dep = results.get(id)
      return dep ? `### 依赖步骤 ${id} 的结果摘要\n${clip(dep, 800)}` : ''
    })
    .filter(Boolean)
    .join('\n\n')
  const userMsg =
    (tools.length
      ? `【执行要求】本步骤必须通过调用工具实际执行操作完成，禁止只输出文字描述或分析。工具不足时在结果中说明缺失的工具。\n` +
        `【效率要求】不要陷入长时间思考：每个思考块只做简短的下一步规划；禁止重复执行完全相同的调用，` +
        `某命令无产出或失败时，更换方法并在思考中说明原因；信息充分立即给出结论。\n\n`
      : '') +
    step.instruction +
    (depText ? `\n\n---\n${depText}` : '')
  const reply = await runAgentLoop(
    [
      { role: 'system', content: system },
      { role: 'user', content: userMsg }
    ],
    signal,
    { sink: taskLogs.value, tools, maxRounds: 20 }
  )
  return reply
}

/** 步骤结果校验：verify 非空时让模型判定是否达标 */
const verifyStep = async (
  step: TaskStep,
  result: string,
  signal?: AbortSignal
): Promise<{ pass: boolean; reason: string } | null> => {
  if (!step.verify.trim()) return { pass: true, reason: '' }
  for (let i = 0; i < MAX_PLAN_ROUNDS; i++) {
    const raw = await askLlm(
      '你是任务校验器。根据验证标准判断子任务结果是否达标，只输出严格 JSON：{"pass":true|false,"reason":"判断依据（简洁）"}，不要输出其他内容。',
      `## 验证标准\n${step.verify}\n\n## 子任务执行结果\n${clip(result)}`,
      signal,
      `结果校验 · 子任务 ${step.id}`
    )
    const verdict = extractJson<{ pass?: boolean; reason?: string }>(raw)
    if (verdict && typeof verdict.pass === 'boolean') {
      return { pass: verdict.pass, reason: verdict.reason ?? '' }
    }
  }
  return null // 校验器不可用时视为通过，不阻断主流程
}

/** 失败决策：重试 or 调整（只调整最小范围，避免全部计划重做） */
const requestAdjust = async (
  step: TaskStep,
  result: string,
  reason: string,
  signal?: AbortSignal
): Promise<{
  action: 'retry' | 'adjust'
  target: 'current' | 'prev' | 'next'
  instruction: string
  reason: string
} | null> => {
  const system =
    '你是任务调度决策器。子任务未通过校验，请决策最小代价的恢复方案，只输出严格 JSON：' +
    '{"action":"retry|adjust","target":"current|prev|next","instruction":"调整后的执行指令","reason":"决策理由"}\n' +
    '决策规则：\n' +
    '- 结果接近达标、疑似偶发失败 → action=retry 原样重试（instruction 留空）\n' +
    '- 仅当前步骤指令有问题 → target=current，给出修正后的指令\n' +
    '- 是上游依赖步骤产出有问题导致 → target=prev，给出上一步的修正指令（当前步骤会在其后重做）\n' +
    '- 当前步骤结果可用但影响下一步 → target=next，给出下一步的修正指令\n' +
    '- 严禁扩大调整范围：已成功的步骤不得重做，除非它确实是失败根因'
  for (let i = 0; i < MAX_PLAN_ROUNDS; i++) {
    const raw = await askLlm(
      system,
      `## 失败子任务\n${step.id}：${step.name}\n指令：${step.instruction}\n\n## 执行结果\n${clip(result, 800)}\n\n## 校验失败原因\n${reason}`,
      signal,
      `失败决策 · 子任务 ${step.id}`
    )
    const d = extractJson<{
      action?: string
      target?: string
      instruction?: string
      reason?: string
    }>(raw)
    const action = d?.action === 'adjust' ? 'adjust' : d?.action === 'retry' ? 'retry' : null
    const target =
      d?.target === 'prev'
        ? 'prev'
        : d?.target === 'next'
          ? 'next'
          : d?.target === 'current'
            ? 'current'
            : null
    if (action && target) {
      return { action, target, instruction: d?.instruction ?? '', reason: d?.reason ?? '' }
    }
  }
  return null
}

/** 最终总结：目标对照 + 结果评估 + 建议 */
const requestSummary = async (
  task: AiTask,
  goal: string,
  steps: TaskStep[],
  results: Map<string, string>,
  signal?: AbortSignal
): Promise<string> => {
  const detail = steps
    .map((s) => `### ${s.id}：${s.name}\n结果：${clip(results.get(s.id) ?? '', 600)}`)
    .join('\n\n')
  const raw = await askLlm(
    '你是任务总结器。根据任务目标与各步骤结果输出最终中文总结（Markdown）：' +
      '1) 是否符合目标预期（明确「已达成 / 部分达成 / 未达成」）；2) 各步骤结果简述；3) 发现的问题与后续建议。',
    `## 任务目标\n${goal}\n\n## 任务描述\n${task.description || '无'}\n\n## 各步骤结果\n${detail}`,
    signal,
    '任务总结'
  )
  return raw.trim() || '任务已完成，但未生成总结。'
}

/** 执行任务（编排器）：
 * 1. 规划：任务描述 → 依赖有序的步骤计划（JSON，解析失败自动重试）
 * 2. 调度：按依赖波次执行，同波无依赖的子任务并行，统一等待后进入下一波
 * 3. 校验：带 verify 的步骤（长任务校验节点）逐个判定，防跑偏
 * 4. 调整：失败时模型决策重试 / 调整上一步 / 当前步 / 下一步，不做全量重做
 * 5. 总结：完成后输出目标对照、问题与建议
 */
const executeTask = async (task: AiTask): Promise<void> => {
  if (loading.value) return
  loading.value = true
  abortCtl = new AbortController()
  const signal = abortCtl.signal
  taskLogs.value.push({ role: 'user', content: `▶ 执行任务：${task.name}` })
  longTask.value = null
  longTaskIndex.clear()
  try {
    const tools = await buildTaskTools(task)
    const system = buildTaskSystem(task, tools)

    // ---- 1. 规划 ----
    const plan = await requestPlan(task, signal)
    if (!plan) {
      taskLogs.value.push({
        role: 'assistant',
        content: '⚠ 任务规划失败：无法生成有效的步骤计划，任务终止。'
      })
      return
    }
    taskLogs.value.push({
      role: 'assistant',
      content: `**目标**：${plan.goal}\n\n**计划**（共 ${plan.steps.length} 步）：\n${plan.steps
        .map(
          (s) =>
            `- ${s.id}. ${s.name}${s.depends.length ? `（依赖：${s.depends.join('、')}）` : ''}`
        )
        .join('\n')}`
    })

    // 初始化长任务展示：全部步骤进入等待状态（详情默认展示执行指令）
    longTask.value = {
      title: task.name,
      steps: plan.steps.map((s) => ({
        name: `${s.id}. ${s.name}`,
        status: 'wait' as const,
        detail: s.instruction
      }))
    }
    plan.steps.forEach((s, i) => longTaskIndex.set(s.id, i))

    const results = new Map<string, string>()
    const retries = new Map<string, number>()
    let adjustedNext: string | null = null // 调整波次内已改动过的步骤（防止循环调整）

    // ---- 2~4. 调度执行 ----
    for (let wave = 0; wave < MAX_WAVES; wave++) {
      if (signal.aborted) throw abortError()
      // 就绪集合：未完成 + 依赖全部完成；同波并行，波间按序等待
      const ready = plan.steps.filter(
        (s) => !results.has(s.id) && s.depends.every((d) => results.has(d))
      )
      if (ready.length === 0) break

      // 并行执行本波子任务
      const settled = await Promise.all(
        ready.map(async (step) => {
          setStepState(step.id, { status: 'running', detail: '执行中…' })
          const reply = await runStep(step, system, tools, results, signal)
          return { step, reply }
        })
      )
      // 仅用户主动停止（signal 中止）才中断整个任务
      if (signal.aborted) throw abortError()

      // ---- 3. 逐个校验（波次统一等待后进行） ----
      for (const { step, reply } of settled) {
        if (signal.aborted) throw abortError()
        // 空回复不算中止：作为校验失败进入重试/调整流程；校验器不可用（null）视为通过
        const verdict =
          (reply ? await verifyStep(step, reply, signal) : null) ??
          (reply
            ? { pass: true, reason: '' }
            : { pass: false, reason: '子任务未返回任何内容（模型无输出）' })
        if (verdict.pass) {
          results.set(step.id, reply)
          setStepState(step.id, { status: 'done', detail: clip(reply, 400) })
          taskLogs.value.push({
            role: 'assistant',
            content: `✅ 子任务 ${step.id}「${step.name}」校验通过${verdict.reason ? `：${verdict.reason}` : ''}`
          })
          continue
        }
        setStepState(step.id, { status: 'error', detail: `校验未通过：${verdict.reason}` })
        taskLogs.value.push({
          role: 'assistant',
          content: `❌ 子任务 ${step.id}「${step.name}」校验未通过：${verdict.reason}`
        })
        // ---- 4. 失败决策 ----
        const retriesN = (retries.get(step.id) ?? 0) + 1
        retries.set(step.id, retriesN)
        if (retriesN > MAX_STEP_RETRIES) {
          taskLogs.value.push({
            role: 'assistant',
            content: `⚠ 子任务 ${step.id} 重试次数已达上限，任务终止。请检查任务计划或手动处理。`
          })
          return
        }
        const decision = await requestAdjust(step, reply, verdict.reason, signal)
        if (!decision) {
          // 决策不可用时退化为原样重试
          taskLogs.value.push({
            role: 'assistant',
            content: `↻ 子任务 ${step.id} 决策超限，按原样重试。`
          })
          continue
        }
        taskLogs.value.push({
          role: 'assistant',
          content: `**调整决策**：${decision.action === 'retry' ? '重试' : '调整'}「${
            decision.target === 'prev' ? '上一步' : decision.target === 'next' ? '下一步' : '当前步'
          }」 - ${decision.reason}`
        })
        if (decision.action === 'retry' || decision.target === 'current') {
          if (decision.action === 'adjust' && decision.instruction.trim())
            step.instruction = decision.instruction
          // 不标记完成，下一波重新执行本步骤
          setStepState(step.id, {
            status: 'wait',
            detail: `重试中：${decision.reason || '按原样重试'}`
          })
          continue
        }
        if (decision.target === 'prev') {
          // 回退上一步：撤销其结果与依赖它的后续结果，仅重做受影响链
          const order = plan.steps.map((s) => s.id)
          const prevId = order[Math.max(0, order.indexOf(step.id) - 1)]
          const prevStep = plan.steps.find((s) => s.id === prevId)
          if (prevStep && decision.instruction.trim()) prevStep.instruction = decision.instruction
          const affected = new Set([prevId])
          for (const s of plan.steps) {
            if (s.depends.some((d) => affected.has(d))) affected.add(s.id)
          }
          for (const id of affected) {
            results.delete(id)
            setStepState(id, { status: 'wait', detail: '待重做（受上游失败影响）' })
          }
          taskLogs.value.push({
            role: 'assistant',
            content: `↩ 回退重做：${[...affected].join('、')}（仅受影响的步骤，其余保留）`
          })
          continue
        }
        // target === next：调整下一步指令
        const order = plan.steps.map((s) => s.id)
        const nextStep = plan.steps[order.indexOf(step.id) + 1]
        if (nextStep && decision.instruction.trim() && adjustedNext !== nextStep.id) {
          nextStep.instruction = decision.instruction
          adjustedNext = nextStep.id
        }
      }
    }

    // ---- 5. 总结 ----
    const unfinished = plan.steps.filter((s) => !results.has(s.id))
    if (unfinished.length > 0) {
      for (const s of unfinished) setStepState(s.id, { status: 'error', detail: '未执行' })
      taskLogs.value.push({
        role: 'assistant',
        content: `⚠ 以下步骤未完成：${unfinished.map((s) => `${s.id}.${s.name}`).join('、')}`
      })
    }
    if (results.size > 0) {
      const summary = await requestSummary(task, plan.goal, plan.steps, results, signal)
      if (longTask.value) longTask.value.summary = summary
      taskLogs.value.push({ role: 'assistant', content: `## 任务总结\n\n${summary}` })
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      // 停止时把执行中 / 等待中的步骤标记为报错（已停止）
      for (const s of longTask.value?.steps ?? []) {
        if (s.status !== 'done') Object.assign(s, { status: 'error', detail: '已停止' })
      }
      taskLogs.value.push({ role: 'assistant', content: '（任务已停止）' })
    } else {
      taskLogs.value.push({ role: 'assistant', content: `任务执行出错：${e}` })
    }
  } finally {
    abortCtl = null
    loading.value = false
  }
}

// 暴露给宿主页面：页面内容 → AI 输入框 / 直接发送消息 / 气泡内确认
defineExpose({ sendToInput, sendMessage, requestConfirm })
</script>

<template>
  <div class="ai-panel" :style="{ width: `${panelWidth}px` }">
    <!-- 拖拽遮罩：盖住整个窗口，避免鼠标划过 webview/iframe 时事件被吞掉 -->
    <div v-if="dragging" class="ai-drag-mask"></div>

    <!-- 左侧拖拽条：拖动调整面板宽度 -->
    <div
      class="ai-resize-bar"
      :class="{ active: dragging }"
      title="拖动调整宽度"
      @mousedown="startDrag"
    ></div>

    <div class="ai-body">
      <!-- 头部：标题 + 模式切换 + 场景徽标（标识当前接入的功能页面） -->
      <div class="ai-header">
        <div class="ai-header-title">
          <el-icon><MagicStick /></el-icon>
          <span>{{ title }}</span>
          <!-- 模式切换：对话 / 任务 -->
          <div class="ai-mode-switch">
            <span class="ai-mode-item" :class="{ active: mode === 'chat' }" @click="mode = 'chat'">
              对话
            </span>
            <span class="ai-mode-item" :class="{ active: mode === 'task' }" @click="mode = 'task'">
              任务
            </span>
          </div>
          <span class="ai-scene-badge">{{ sceneLabel }}</span>
        </div>
        <div class="ai-header-actions">
          <!-- 任务模式：右上角 + 新增任务 / 导入 JSON -->
          <template v-if="mode === 'task'">
            <el-tooltip content="导入任务 JSON">
              <el-button
                :icon="UploadFilled"
                circle
                size="small"
                @click="taskPanelRef?.importFromFile()"
              />
            </el-tooltip>
            <el-tooltip content="新增任务">
              <el-button
                type="primary"
                :icon="Plus"
                circle
                size="small"
                @click="taskPanelRef?.openDialog()"
              />
            </el-tooltip>
          </template>
          <template v-else>
            <el-tooltip :content="deepThink ? '深度思考已开启' : '深度思考已关闭'">
              <el-button
                :type="deepThink ? 'primary' : 'default'"
                :icon="Lightning"
                circle
                size="small"
                @click="deepThink = !deepThink"
              />
            </el-tooltip>
            <el-tooltip content="清空对话">
              <el-button :icon="Refresh" circle size="small" @click="clearMessages" />
            </el-tooltip>
          </template>
        </div>
      </div>

      <!-- 任务模式：任务列表 + 执行日志 -->
      <AiTaskPanel
        v-show="mode === 'task'"
        ref="taskPanelRef"
        :scene="scene"
        :page-tools="tools ?? []"
        :builtin-tools="builtinTools"
        :logs="taskLogs"
        :long-task="longTask"
        :running="loading"
        :think="deepThink"
        @update:think="deepThink = $event"
        @execute="executeTask"
        @stop="stopGeneration"
      />

      <!-- 对话模式 -->
      <template v-if="mode === 'chat'">
        <!-- 消息列表 -->
        <div ref="messageListRef" class="ai-messages">
          <template v-for="(msg, idx) in messages" :key="idx">
            <!-- 用户消息 -->
            <div v-if="msg.role === 'user'" class="ai-message user">{{ msg.content }}</div>
            <!-- AI 回复：AssistantMessage 气泡（content 结构化流：思考折叠 × N + 工具折叠 × N + Markdown） -->
            <AssistantMessage
              v-else
              :content="msg.content"
              :is-streaming="loading && idx === messages.length - 1"
              :on-execute="executeCommand ? executeCode : undefined"
              :execute-label="executeLabel"
              :confirm="idx === messages.length - 1 ? confirmState : null"
              :on-confirm-action="onConfirmAction"
            />
          </template>
        </div>

        <!-- 输入区 -->
        <div class="ai-input-area">
          <div class="ai-quick-actions">
            <el-button size="small" :icon="MagicStick" @click="readContext">读取内容</el-button>
          </div>
          <div class="ai-input-row">
            <el-input
              ref="inputRef"
              v-model="input"
              type="textarea"
              :rows="2"
              placeholder="输入问题，回车发送..."
              resize="none"
              @keydown.enter.exact.prevent="sendMessage()"
            />
            <!-- 生成中显示「停止」按钮，空闲时显示「发送」 -->
            <el-button
              v-if="loading"
              type="warning"
              :icon="VideoPause"
              title="停止生成"
              class="ai-send-btn"
              @click="stopGeneration"
            />
            <el-button
              v-else
              type="primary"
              :icon="Promotion"
              class="ai-send-btn"
              @click="sendMessage()"
            />
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ai-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--color-card);
  border-left: 1px solid var(--color-border);
  min-height: 0;
  flex-shrink: 0;
}

/* 拖拽全屏遮罩：拦截所有鼠标事件，确保划过 webview/iframe 时拖拽不断 */
.ai-drag-mask {
  position: fixed;
  inset: 0;
  z-index: 99999;
  cursor: col-resize;
}

/* 左侧拖拽调整宽度手柄：视觉细线 + 更宽的命中区域 */
.ai-resize-bar {
  position: absolute;
  left: -5px;
  top: 0;
  bottom: 0;
  width: 10px;
  cursor: col-resize;
  z-index: 10;
}

/* 手柄中间的可见竖线 */
.ai-resize-bar::after {
  content: '';
  position: absolute;
  left: 4px;
  top: 0;
  bottom: 0;
  width: 2px;
  background: transparent;
  transition: background 0.2s ease;
}

.ai-resize-bar:hover::after,
.ai-resize-bar.active::after {
  background: var(--color-primary);
}

.ai-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.ai-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
}

.ai-header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
}

/* 场景徽标：标识当前接入的功能页面 */
.ai-scene-badge {
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  border-radius: 10px;
}

/* 模式切换：对话 / 任务 */
.ai-mode-switch {
  display: flex;
  margin-left: 6px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  overflow: hidden;
}

.ai-mode-item {
  padding: 2px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary, #909399);
  cursor: pointer;
  user-select: none;
  transition: all 0.15s ease;
}

.ai-mode-item.active {
  color: #ffffff;
  background: var(--color-primary);
}

.ai-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ai-message {
  max-width: 92%;
  border-radius: 12px;
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
}

.ai-message.user {
  align-self: flex-end;
  background: var(--color-primary);
  color: #ffffff;
  white-space: pre-wrap;
}

.ai-input-area {
  padding: 12px 16px;
  border-top: 1px solid var(--color-border);
}

.ai-quick-actions {
  margin-bottom: 8px;
}

.ai-input-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}

.ai-send-btn {
  height: 52px;
}
</style>

<!-- 拖拽中的全局状态（非 scoped，作用于 body） -->
<style>
body.ai-resizing {
  user-select: none;
  cursor: col-resize;
}

body.ai-resizing * {
  cursor: col-resize !important;
}
</style>
