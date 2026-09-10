<script setup lang="ts">
import { computed, ref, onMounted, watch, nextTick } from 'vue'
import { Marked, type Tokens } from 'marked'
import hljs from 'highlight.js'
import { ElMessage } from 'element-plus'
import { CopyDocument, Check } from '@element-plus/icons-vue'

interface Props {
  /** 回复流内容：含 <think> 思考块、TOOL_CALL/TOOL_RESULT 工具标记、Markdown 正文，组件内部解析渲染 */
  content: string
  timestamp?: Date
  isStreaming?: boolean
  /** 代码块执行回调：传入时代码块显示「执行」按钮，由宿主页面执行相关操作 */
  onExecute?: (code: string, lang: string) => void
  /** 执行按钮文案 */
  executeLabel?: string
  /** 待确认状态：非空时在气泡底部渲染确认卡片（问题 + 按钮组） */
  confirm?: { question: string; actions: string[] } | null
  /** 确认按钮点击回调：返回用户选择的按钮文案 */
  onConfirmAction?: (action: string) => void
}

const props = withDefaults(defineProps<Props>(), {
  timestamp: () => new Date(),
  isStreaming: false,
  executeLabel: '执行',
  confirm: null
})

const copied = ref(false)
const contentRef = ref<HTMLElement>()

/** 代码块：渲染时收集，供「复制 / 执行」按钮按索引取回 */
interface CodeBlock {
  lang: string
  code: string
}

/** HTML 转义（代码块内容放入 <code> 时使用） */
const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** content 解析后的展示片段，按出现顺序渲染 */
type Segment =
  | { type: 'think'; text: string; closed: boolean } // 思考块（未闭合 = 正在思考）
  | { type: 'tool'; name: string; result?: string; done: boolean } // 工具调用（done=false = 执行中）
  | { type: 'toolcall'; name: string } // 模型输出的 <tool_call> 调用语句（隐藏原文，仅提示工具名）
  | { type: 'rawcall'; summary: string; body: string } // 正文中的裸 JSON 工具调用（格式化后展示）
  | { type: 'text'; text: string } // Markdown 正文

/**
 * 从起始 { 开始做括号配对（考虑字符串与转义），返回闭合下标，未闭合返回 -1
 */
const matchBraces = (text: string, start: number): number => {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (!depth) return i
    }
  }
  return -1
}

/** 裸 JSON 调用的参数字段兜底取值（多候选键名） */
const pickArg = (args: Record<string, unknown>, keys: string[]): string | null => {
  for (const k of keys) {
    const v = args?.[k]
    if (typeof v === 'string' && v) return v
  }
  return null
}

/** 把裸 JSON 工具调用格式化为「摘要 + 正文」：content 还原真实换行，避免转义串满屏 */
const buildRawCall = (raw: string): Segment => {
  let name = 'tool'
  let args: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(raw) as { name?: string; args?: unknown; parameters?: unknown }
    if (parsed.name) name = parsed.name
    let a: unknown = parsed.args ?? parsed.parameters ?? {}
    if (typeof a === 'string') {
      const s = a
      try {
        a = JSON.parse(s)
      } catch {
        /* 双重编码未到齐，按原文展示 */
        return { type: 'rawcall', summary: name, body: s.replace(/\\n/g, '\n').replace(/\\"/g, '"') }
      }
    }
    args = (a ?? {}) as Record<string, unknown>
  } catch {
    /* JSON 解析失败时退回原文 */
    return { type: 'rawcall', summary: name, body: raw }
  }
  const path = pickArg(args, ['path', 'file_path', 'filePath', 'file', 'target'])
  const command = pickArg(args, ['command', 'cmd', 'action'])
  const content = pickArg(args, ['content', 'new_content', 'code', 'value', 'data'])
  let summary = name
  if (path) summary += `：${path}`
  else if (command) summary += `：${command.slice(0, 100)}`
  // 正文优先展示 content（还原换行），无 content 时展示其余参数的格式化 JSON
  let body: string
  if (content !== null) {
    const rest = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== content))
    body = content
    if (Object.keys(rest).length) body = `${JSON.stringify(rest)}\n\n${content}`
  } else {
    const { name: _n, ...restArgs } = args as { name?: unknown }
    body = JSON.stringify(restArgs, null, 2)
  }
  return { type: 'rawcall', summary, body }
}

/**
 * 解析 content 为片段序列：
 * - <think>...</think> → 思考折叠块（一次对话多轮请求产生多个，各自独立折叠）
 * - TOOL_CALL: 名称 / TOOL_RESULT: ... /TOOL_RESULT → 工具调用折叠块
 * - <tool_call>{"name":...}</tool_call> → 模型调用语句，原文不展示，解析出工具名做轻量提示
 * - 其余 → Markdown 正文
 * 未闭合的块（流式中）也识别：think 未闭合仍展开显示，工具未回填结果显示「执行中...」
 */
const parseSegments = (content: string): Segment[] => {
  const segments: Segment[] = []
  // 工具标记块：TOOL_CALL: name 起始，TOOL_RESULT: 结果体，/TOOL_RESULT 结束
  const toolRe = /TOOL_CALL:\s*(\S+)[^\n]*\n(?:TOOL_RESULT:\n([\s\S]*?)(\n\/TOOL_RESULT|$))?/g
  // 模型调用语句：<tool_call>{"name":"xxx",...}</tool_call>（未闭合也匹配，流式中即时隐藏）
  const callRe = /<tool_call>\s*(\{[\s\S]*?\})?\s*(<\/tool_call>|$)/g
  const skipRanges: { start: number; end: number; seg: Segment }[] = []
  let m: RegExpExecArray | null
  while ((m = toolRe.exec(content)) !== null) {
    const hasResult = m[2] !== undefined
    skipRanges.push({
      start: m.index,
      end: m.index + m[0].length,
      seg: { type: 'tool', name: m[1], result: m[2], done: hasResult && m[3] !== '' }
    })
  }
  while ((m = callRe.exec(content)) !== null) {
    // 尝试解析 JSON 拿工具名；解析失败（流式中 JSON 未到齐）显示占位
    let name = '...'
    try {
      const parsed = m[1] ? (JSON.parse(m[1]) as { name?: string }) : null
      if (parsed?.name) name = parsed.name
    } catch {
      /* JSON 未完整，保留占位 */
    }
    skipRanges.push({ start: m.index, end: m.index + m[0].length, seg: { type: 'toolcall', name } })
  }
  skipRanges.sort((a, b) => a.start - b.start)

  // 非标记区域再解析 <think> 块
  let pos = 0
  const rawRe = /\{\s*"name"\s*:/g
  const pushText = (text: string): void => {
    const t = text.replace(/^\n+/, '')
    if (!t.trim()) return
    // 抽取正文中的裸 JSON 工具调用（模型未包 <tool_call> 标签时兜底），格式化展示
    let last = 0
    let rm: RegExpExecArray | null
    rawRe.lastIndex = 0
    while ((rm = rawRe.exec(t)) !== null) {
      const end = matchBraces(t, rm.index)
      if (end === -1) continue
      rawRe.lastIndex = end + 1
      const before = t.slice(last, rm.index)
      if (before.trim()) segments.push({ type: 'text', text: before })
      segments.push(buildRawCall(t.slice(rm.index, end + 1)))
      last = end + 1
    }
    const rest = t.slice(last)
    if (rest.trim()) segments.push({ type: 'text', text: rest })
  }
  const pushNonMarked = (chunk: string): void => {
    let p = 0
    const thinkRe = /<think>([\s\S]*?)(<\/think>|$)/g
    let tm: RegExpExecArray | null
    while ((tm = thinkRe.exec(chunk)) !== null) {
      pushText(chunk.slice(p, tm.index))
      segments.push({ type: 'think', text: tm[1], closed: tm[2] === '</think>' })
      p = tm.index + tm[0].length
    }
    pushText(chunk.slice(p))
  }

  for (const range of skipRanges) {
    if (range.start < pos) continue // 重叠区域跳过（TOOL 标记与调用语句不会同时出现，防御处理）
    pushNonMarked(content.slice(pos, range.start))
    segments.push(range.seg)
    pos = range.end
  }
  pushNonMarked(content.slice(pos))
  return segments
}

const segments = computed<Segment[]>(() => parseSegments(props.content))

/** 可执行代码语言白名单：命令类与脚本类语言才显示「执行」按钮 */
const EXECUTABLE_LANGS = new Set([
  'bash',
  'sh',
  'shell',
  'zsh',
  'bat',
  'cmd',
  'batch',
  'powershell',
  'ps1',
  'pwsh',
  'python',
  'py',
  'python3',
  'java',
  'javascript',
  'js',
  'typescript',
  'ts',
  'node',
  'perl',
  'ruby',
  'lua'
])

const isExecutableLang = (lang: string): boolean => EXECUTABLE_LANGS.has(lang.toLowerCase())

/** 文本片段的 Markdown 渲染结果（key 为片段索引） */
const renderedTexts = computed<Map<number, { html: string; blocks: CodeBlock[] }>>(() => {
  const map = new Map<number, { html: string; blocks: CodeBlock[] }>()
  segments.value.forEach((seg, i) => {
    if (seg.type !== 'text') return
    const blocks: CodeBlock[] = []
    const md = new Marked({ breaks: true, gfm: true })
    md.use({
      renderer: {
        // 代码块：语言标签 + 复制/执行按钮（按钮通过 data-block 索引 + 事件委托响应点击）
        code(token: Tokens.Code): string {
          const lang = (token.lang || '').trim() || 'text'
          const idx = blocks.push({ lang, code: token.text }) - 1
          const execBtn =
            props.onExecute && isExecutableLang(lang)
              ? `<button class="ai-code-btn primary" data-block="${idx}" data-action="exec">${escapeHtml(props.executeLabel)}</button>`
              : ''
          return (
            `<div class="ai-code-block">` +
            `<div class="ai-code-header"><span class="ai-code-lang">${escapeHtml(lang)}</span>` +
            `<div class="ai-code-actions">` +
            `<button class="ai-code-btn" data-block="${idx}" data-action="copy">复制</button>` +
            execBtn +
            `</div></div>` +
            `<pre><code class="hljs">${escapeHtml(token.text)}</code></pre>` +
            `</div>`
          )
        }
      }
    })
    let html: string
    try {
      html = md.parse(seg.text) as string
    } catch {
      html = `<p>${escapeHtml(seg.text)}</p>`
    }
    map.set(i, { html, blocks })
  })
  return map
})

// 对 DOM 中的代码块应用高亮
const highlightCode = (): void => {
  if (!contentRef.value) return
  const codeBlocks = contentRef.value.querySelectorAll('pre code')
  codeBlocks.forEach((block) => {
    const el = block as HTMLElement
    // 避免重复高亮
    if (!el.dataset.highlighted) {
      hljs.highlightElement(el)
      el.dataset.highlighted = 'true'
    }
  })
}

onMounted(() => {
  highlightCode()
})

/** 流式思考时，展开中的思考块自动滚动到底部（不跟随则一直停在顶部） */
watch(
  () => props.content,
  () => {
    nextTick(() => {
      if (!contentRef.value) return
      const blocks = contentRef.value.querySelectorAll<HTMLDetailsElement>('.ai-reasoning')
      const last = blocks[blocks.length - 1]
      // 只有展开中（流式未闭合）的思考块跟随滚动
      if (last?.open) {
        const body = last.querySelector<HTMLElement>('.ai-reasoning-body')
        if (body) body.scrollTop = body.scrollHeight
      }
    })
  }
)

watch(
  () => renderedTexts.value,
  () => {
    nextTick(highlightCode)
  }
)

/** 复制代码到剪贴板 */
const copyCode = async (code: string): Promise<void> => {
  await navigator.clipboard.writeText(code)
  ElMessage.success('已复制到剪贴板')
}

/** 气泡内代码块按钮点击（事件委托：data-seg 片段索引 + data-block 代码块索引 + data-action 动作） */
const onCodeAction = (e: MouseEvent, segIdx: number): void => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]')
  if (!btn) return
  const block = renderedTexts.value.get(segIdx)?.blocks[Number(btn.dataset.block)]
  if (!block) return
  if (btn.dataset.action === 'copy') {
    copyCode(block.code)
  } else if (btn.dataset.action === 'exec' && props.onExecute) {
    props.onExecute(block.code, block.lang)
  }
}

// 复制功能（整条消息：剥离 think 块与工具标记，只复制可读文本）
const plainText = computed(() =>
  parseSegments(props.content)
    .filter((s) => s.type === 'text')
    .map((s) => (s as { type: 'text'; text: string }).text)
    .join('\n\n')
)
const copyContent = async (): Promise<void> => {
  try {
    await navigator.clipboard.writeText(plainText.value)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    // 复制失败
  }
}

// 格式化时间
const formattedTime = computed(() => {
  return props.timestamp.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  })
})
</script>

<template>
  <div class="assistant-message">
    <div class="message-avatar">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        width="18"
        height="18"
      >
        <path
          d="M12 2L2 7L12 12L22 7L12 2Z"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M2 17L12 22L22 17"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M2 12L12 17L22 12"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </div>
    <div class="message-body">
      <!-- 气泡容器：按片段顺序渲染（思考折叠 × N + 工具折叠 × N + Markdown 正文） -->
      <div ref="contentRef" class="message-content markdown-body">
        <template v-for="(seg, i) in segments" :key="i">
          <!-- 思考块：流式中未闭合时展开，闭合后折叠，点击可展开 -->
          <details
            v-if="seg.type === 'think'"
            class="ai-reasoning"
            :open="isStreaming && !seg.closed"
          >
            <summary>思考过程</summary>
            <div class="ai-reasoning-body">{{ seg.text }}</div>
          </details>
          <!-- 工具调用：名称「调用工具 XXX」，执行结果折叠在内点击展开 -->
          <details v-else-if="seg.type === 'tool'" class="ai-tool-call">
            <summary>执行: {{ seg.name }}</summary>
            <pre class="ai-tool-result">{{ seg.done ? seg.result : '执行中...' }}</pre>
          </details>
          <!-- 模型输出的调用语句：原文隐藏，仅轻量提示正在调用 -->
          <div v-else-if="seg.type === 'toolcall'" class="ai-toolcall-hint">
            🔧 调用工具【{{ seg.name }}】
          </div>
          <!-- 正文中的裸 JSON 调用：格式化为「工具名：参数摘要」，内容还原真实换行 -->
          <details v-else-if="seg.type === 'rawcall'" class="ai-tool-call">
            <summary>🔧 {{ seg.summary }}</summary>
            <pre class="ai-tool-result">{{ seg.body }}</pre>
          </details>
          <!-- 正文：Markdown 渲染（代码已转义），按钮经事件委托响应 -->
          <!-- eslint-disable-next-line vue/no-v-html -->
          <span v-else @click="onCodeAction($event, i)" v-html="renderedTexts.get(i)?.html"></span>
        </template>
        <span v-if="isStreaming && !segments.length" class="thinking-dots">
          <i></i><i></i><i></i>
        </span>
        <!-- 确认卡片：气泡内部渲染，按钮点击经 onConfirmAction 回调给宿主 -->
        <div v-if="confirm" class="ai-confirm-card">
          <div class="ai-confirm-question">{{ confirm.question }}</div>
          <div class="ai-confirm-actions">
            <el-button
              v-for="action in confirm.actions"
              :key="action"
              size="small"
              :type="action === confirm.actions[0] ? 'primary' : 'default'"
              @click="onConfirmAction?.(action)"
            >
              {{ action }}
            </el-button>
          </div>
        </div>
      </div>
      <div class="message-toolbar">
        <button class="tool-btn" :class="{ copied }" title="复制内容" @click="copyContent">
          <el-icon v-if="!copied" :size="13"><CopyDocument /></el-icon>
          <el-icon v-else :size="13"><Check /></el-icon>
          <span>{{ copied ? '已复制' : '复制' }}</span>
        </button>
        <span class="message-time">{{ formattedTime }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.assistant-message {
  display: flex;
  gap: 12px;
  max-width: 85%;
  align-self: flex-start;
}

.message-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: var(--color-primary);
  color: #ffffff;
  box-shadow: var(--shadow-card);
}

.message-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.message-content {
  /* 气泡背景：全部使用主题变量，四种主题自动适配 */
  background: var(--color-card);
  border: 1px solid var(--color-border);
  border-radius: 4px 16px 16px 16px;
  padding: 12px 16px;
  box-shadow: var(--shadow-card);
  font-size: 14.5px;
  line-height: 1.7;
  color: var(--color-text);
}

.message-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  opacity: 0;
  transition: opacity 0.2s;
}

.assistant-message:hover .message-toolbar {
  opacity: 1;
}

.tool-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.15s;
}

.tool-btn:hover {
  background: var(--color-hover);
  color: var(--color-text-secondary);
}

.tool-btn.copied {
  color: var(--color-success);
}

.message-time {
  font-size: 11px;
  color: var(--color-text-secondary);
}

/* 等待期「思考中」三点动画（首帧内容到达前显示） */
.thinking-dots {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 0;
}

.thinking-dots i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-primary);
  animation: dot-bounce 1.2s ease-in-out infinite;
}

.thinking-dots i:nth-child(2) {
  animation-delay: 0.15s;
}

.thinking-dots i:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes dot-bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.35;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}

/* Markdown 样式 */
.markdown-body {
  font-size: 14.5px;
  line-height: 1.7;
  color: var(--color-text);
  word-break: break-word;
}

.markdown-body :deep(p) {
  margin: 0 0 12px;
}

.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4),
.markdown-body :deep(h5),
.markdown-body :deep(h6) {
  margin: 16px 0 8px;
  font-weight: 600;
  color: var(--color-text);
}

.markdown-body :deep(h1) {
  font-size: 1.5em;
}
.markdown-body :deep(h2) {
  font-size: 1.3em;
}
.markdown-body :deep(h3) {
  font-size: 1.1em;
}

.markdown-body :deep(code) {
  background: var(--color-hover);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 0.9em;
  color: var(--color-danger);
}

.markdown-body :deep(pre) {
  background: var(--color-bg);
  border-radius: 8px;
  padding: 12px;
  overflow-x: auto;
  margin: 12px 0;
}

.markdown-body :deep(pre code) {
  background: transparent;
  padding: 0;
  color: var(--color-text);
  font-size: 13px;
  line-height: 1.5;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  padding-left: 20px;
  margin: 8px 0;
}

.markdown-body :deep(li) {
  margin: 4px 0;
}

.markdown-body :deep(blockquote) {
  border-left: 3px solid var(--color-primary);
  margin: 12px 0;
  padding: 8px 16px;
  background: var(--color-hover);
  color: var(--color-text-secondary);
}

.markdown-body :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 12px 0;
  font-size: 14px;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--color-border);
  padding: 8px 12px;
  text-align: left;
}

.markdown-body :deep(th) {
  background: var(--color-hover);
  font-weight: 600;
}

.markdown-body :deep(a) {
  color: var(--color-primary);
  text-decoration: none;
}

.markdown-body :deep(a:hover) {
  text-decoration: underline;
}

.markdown-body :deep(img) {
  max-width: 100%;
  border-radius: 8px;
}

.markdown-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--color-border);
  margin: 16px 0;
}

/* 代码高亮主题 */
.markdown-body :deep(.hljs-keyword) {
  color: #c678dd;
}
.markdown-body :deep(.hljs-string) {
  color: #98c379;
}
.markdown-body :deep(.hljs-number) {
  color: #d19a66;
}
.markdown-body :deep(.hljs-comment) {
  color: #5c6370;
}
.markdown-body :deep(.hljs-function) {
  color: #61afef;
}
.markdown-body :deep(.hljs-class) {
  color: #e5c07b;
}
.markdown-body :deep(.hljs-variable) {
  color: #e06c75;
}
.markdown-body :deep(.hljs-built_in) {
  color: #e6c07b;
}

/* ===== 思考过程（气泡顶部可折叠区） ===== */
.ai-reasoning {
  margin-bottom: 8px;
  padding: 6px 10px;
  border-left: 2px solid var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 5%, transparent);
  border-radius: 6px;
}

.ai-reasoning summary {
  font-size: 12px;
  color: var(--color-text-secondary);
  cursor: pointer;
  user-select: none;
}

.ai-reasoning-body {
  margin-top: 6px;
  font-size: 12px;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  max-height: 200px;
  overflow-y: auto;
}

/* ===== 工具调用列表（每条可折叠，结果点击展开） ===== */
.ai-tool-call {
  margin-bottom: 6px;
  padding: 5px 10px;
  border-left: 2px solid var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 6%, transparent);
  border-radius: 6px;
}

.ai-tool-call summary {
  font-size: 12px;
  color: var(--color-text);
  cursor: pointer;
  user-select: none;
  font-weight: 500;
}

.ai-tool-result {
  margin: 6px 0 0;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow-y: auto;
  background: var(--color-bg);
  border-radius: 4px;
  font-family: Consolas, Monaco, monospace;
}

/* 模型调用语句提示：原文隐藏后的轻量占位 */
.ai-toolcall-hint {
  font-size: 12px;
  color: var(--color-text-secondary);
  padding: 2px 0;
}

/* ===== 确认卡片（气泡内部渲染：问题 + 按钮组，回调响应） ===== */
.ai-confirm-card {
  margin-top: 8px;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--el-color-danger);
  border-radius: 8px;
  background: color-mix(in srgb, var(--el-color-danger) 4%, transparent);
}

.ai-confirm-question {
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  color: var(--color-text);
}

.ai-confirm-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
}

/* ===== 代码块（含语言标签 + 复制/执行按钮） ===== */
.markdown-body :deep(.ai-code-block) {
  margin: 8px 0;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  background: var(--color-bg);
}

.markdown-body :deep(.ai-code-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px 4px 12px;
  border-bottom: 1px solid var(--color-border);
}

.markdown-body :deep(.ai-code-lang) {
  font-size: 12px;
  color: var(--color-primary);
}

.markdown-body :deep(.ai-code-actions) {
  display: flex;
  gap: 4px;
}

.markdown-body :deep(.ai-code-btn) {
  padding: 2px 8px;
  font-size: 12px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.markdown-body :deep(.ai-code-btn:hover) {
  background: var(--color-hover);
  color: var(--color-text);
}

.markdown-body :deep(.ai-code-btn.primary) {
  color: var(--color-primary);
}

.markdown-body :deep(.ai-code-block pre) {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
}

.markdown-body :deep(.ai-code-block pre code) {
  background: transparent;
  padding: 0;
  font-size: 12px;
  line-height: 1.5;
}
</style>
