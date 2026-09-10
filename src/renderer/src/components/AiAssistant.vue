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
import { MagicStick, Promotion, Refresh, VideoPause, Lightning } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import {
  AI_SCENE_LABELS,
  getSystemPrompt,
  buildToolPrompt,
  type AiScene,
  type AiTool
} from '../composables/prompt'
import { aiLocalTools } from '../composables/aiLocalTool'
import { sendLlmStream, type LlmChatMessage } from '../utils/aiRequest'
import AssistantMessage from './AssistantMessage.vue'

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

/** 工具调用最大轮数，防止模型死循环 */
const MAX_TOOL_ROUNDS = 10

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
 * @returns 最终回答正文（供调用方写入多轮对话历史）；中止时返回空字符串
 */
const runAgentLoop = async (chat: LlmChatMessage[], signal?: AbortSignal): Promise<string> => {
  const byName = new Map(allTools.value.map((t) => [t.name, t]))

  // 本回合唯一的回答气泡：content 为结构化流（think 块 / 工具标记 / Markdown）
  const msg = reactive<AiMessage>({ role: 'assistant', content: '' })
  messages.value.push(msg)
  /** 段落分隔：避免标记与前文粘连 */
  const append = (text: string): void => {
    if (msg.content && !msg.content.endsWith('\n')) msg.content += '\n'
    msg.content += text
    scrollToBottom()
  }

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
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

      const result = await sendLlmStream(chat, {
        signal,
        think: deepThink.value,
        onReasoning: (delta) => {
          // 原生思考通道（reasoning_content / thinking）：包成 think 块进入展示流
          if (!nativeThinkOpen) {
            append('<think>')
            nativeThinkOpen = true
          }
          msg.content += delta
          scrollToBottom()
        },
        onContent: handleContent
      })

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
        if (!tool) {
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
      <!-- 头部：标题 + 场景徽标（标识当前接入的功能页面） -->
      <div class="ai-header">
        <div class="ai-header-title">
          <el-icon><MagicStick /></el-icon>
          <span>{{ title }}</span>
          <span class="ai-scene-badge">{{ sceneLabel }}</span>
        </div>
        <div class="ai-header-actions">
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
        </div>
      </div>

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
