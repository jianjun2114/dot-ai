<script setup lang="ts">
/**
 * 终端面板组件：一个组件实例对应一个终端会话（SSH / 本地 PowerShell）
 *
 * - 使用 xterm.js 渲染终端，自适应容器尺寸
 * - 键盘输入 → IPC 写入主进程 → 终端程序
 * - 终端输出 → IPC 事件 → xterm 渲染 + 追加到内容缓冲（供 AI 读取）
 * - Ctrl + 鼠标滚轮：调整终端字号（10-24px）
 */
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ElMessage } from 'element-plus'
import { useTheme } from '../../composables/useTheme'
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{
  sessionId: string
  title: string
  /** 连接类型：ssh 显示「复制链接」，local 时该菜单项置灰 */
  connType?: 'ssh' | 'local'
}>()

const emit = defineEmits<{
  /** 右键菜单：重新连接当前会话 */
  reconnect: []
  /** 右键菜单：复制 SSH 连接命令（由宿主按连接参数拼接） */
  'copy-link': []
  /** 右键菜单：把选中内容（或最近输出）发送给 AI */
  'send-to-ai': [text: string]
}>()

/** 本地终端：无连接信息可复制 */
const isLocal = props.connType !== 'ssh'

// 全局主题（与 useTheme 共享同一 ref），终端配色跟随主题实时切换
const { theme } = useTheme()

const containerRef = ref<HTMLElement>()

let terminal: Terminal | null = null
let fitAddon: FitAddon | null = null
let resizeObserver: ResizeObserver | null = null
/** IPC 事件取消订阅函数 */
let unsubscribers: (() => void)[] = []
/** 当前字号（Ctrl+滚轮可调） */
let fontSize = 13
const MIN_FONT_SIZE = 10
const MAX_FONT_SIZE = 24

/** 亮色主题 ANSI 16 色（VS Code 浅色配色，浅色背景下对比度良好） */
const LIGHT_ANSI: ITheme = {
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5'
}

/** 暗色主题 ANSI 16 色（Catppuccin Mocha 风格，深色背景下柔和护眼） */
const DARK_ANSI: ITheme = {
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#f5c2e7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8'
}

/** 读取当前主题 CSS 变量（getPropertyValue 返回值需 trim 掉空白） */
const cssVar = (name: string, fallback: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback

/** #rrggbb → rgba(r, g, b, alpha) */
const withAlpha = (hex: string, alpha: number): string => {
  const value = parseInt(hex.replace('#', ''), 16)
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`
}

/** 根据当前主题变量构建 xterm 配色（暗色主题使用更亮的 ANSI 色板） */
const buildTerminalTheme = (): ITheme => {
  const isDark = theme.value === 'dark' || theme.value === 'deep-blue'
  const bg = cssVar('--color-bg', '#1e1e2e')
  return {
    background: bg,
    foreground: cssVar('--color-text', '#e0e0e0'),
    cursor: cssVar('--color-primary', '#409eff'),
    cursorAccent: bg,
    selectionBackground: withAlpha(cssVar('--color-primary-light', '#4dabff'), 0.4),
    ...(isDark ? DARK_ANSI : LIGHT_ANSI)
  }
}

/** 主题切换时同步更新终端配色（组件卸载时停止监听） */
const stopThemeWatch = watch(theme, () => {
  if (terminal) terminal.options.theme = buildTerminalTheme()
})

/** 匹配常见 Linux shell 提示符行开头，如 [root@host ~]# ls -l 、[user@host dir]$ */
const PROMPT_LINE_RE = /^\[[^\]]+@[^\]]+\s[^\]]*\]\s*[#$]/

/**
 * 获取最近一次命令的完整交互内容（纯文本，供 AI 分析）
 *
 * - 在缓冲区中定位最后两个提示符行，返回它们之间（含两端）的内容：
 *   上一个提示符 + 用户命令、命令输出、当前提示符（含当前路径）
 * - 超过 maxLines（默认 100）行时仅保留最新的 maxLines 行
 * - 找不到提示符时退化为取最新 maxLines 行
 */
const getRecentContent = (maxLines = 100): string => {
  if (!terminal) return ''
  const buf = terminal.buffer.active
  const total = buf.length
  // 扫描最近 500 行，足够覆盖两次提示符之间的输出
  const scanStart = Math.max(0, total - 500)
  const lines: string[] = []
  for (let i = scanStart; i < total; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  }
  // 去掉末尾空行
  while (lines.length && lines[lines.length - 1] === '') lines.pop()

  // 从后往前找最后两个提示符行
  const promptIdx: number[] = []
  for (let i = lines.length - 1; i >= 0 && promptIdx.length < 2; i--) {
    if (PROMPT_LINE_RE.test(lines[i])) promptIdx.push(i)
  }
  if (promptIdx.length === 0) {
    // 无提示符（如本地 PowerShell / 异常状态）：退化为最近 maxLines 行
    return lines.slice(-maxLines).join('\n')
  }

  const end = promptIdx[0] // 最新提示符行（命令执行完毕的位置）
  // 上一个提示符行；若已滚出扫描窗口则从窗口起点开始
  const start = promptIdx.length >= 2 ? promptIdx[1] : 0
  let seg = lines.slice(start, end + 1)
  if (seg.length > maxLines) seg = seg.slice(-maxLines)
  return seg.join('\n')
}

defineExpose({ getRecentContent })

// ==================== 输出批量写入（修复 tail -f 滚动异常） ====================
// 高频输出（tail -f）逐条 write 会拖慢渲染并不断把视口按回底部，
// 这里按 16ms 合并写入；且用户向上滚动查看历史时，写入后恢复原视口位置。
let pendingData = ''
let flushTimer: ReturnType<typeof setTimeout> | null = null

const flushData = (): void => {
  flushTimer = null
  if (!terminal || !pendingData) return
  const data = pendingData
  pendingData = ''
  const buf = terminal.buffer.active
  const scrolledUp = buf.viewportY < buf.baseY
  const viewportY = buf.viewportY
  terminal.write(data, () => {
    // 用户向上滚动时新日志不得拉走视口；在底部时由 xterm 自动跟随
    if (scrolledUp && terminal && terminal.buffer.active.viewportY !== viewportY) {
      terminal.scrollToLine(viewportY)
    }
  })
}

const writeTerminal = (data: string): void => {
  pendingData += data
  if (flushTimer === null) flushTimer = setTimeout(flushData, 16)
}

// ==================== 右键菜单（复制 / 粘贴 / 重新连接 / 转到 AI） ====================
const menuVisible = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const hasSelection = ref(false)

const closeMenu = (): void => {
  menuVisible.value = false
}

const openMenu = (e: MouseEvent): void => {
  e.stopPropagation() // 阻止冒泡到 document 的关闭监听
  menuX.value = Math.min(e.clientX, window.innerWidth - 140)
  menuY.value = Math.min(e.clientY, window.innerHeight - 200)
  hasSelection.value = terminal?.hasSelection() ?? false
  menuVisible.value = true
}

/** 复制选中文本 */
const copySelection = async (): Promise<void> => {
  closeMenu()
  if (!terminal?.hasSelection()) return
  await navigator.clipboard.writeText(terminal.getSelection())
  ElMessage.success('已复制')
}

/** 粘贴剪贴板内容到终端 */
const pasteClipboard = async (): Promise<void> => {
  closeMenu()
  try {
    const text = await navigator.clipboard.readText()
    if (text) window.dot.toolbox.shell.write(props.sessionId, text)
  } catch {
    ElMessage.error('读取剪贴板失败')
  }
}

/** 粘贴终端内选中的文本（直接作为输入写入当前会话） */
const pasteSelection = (): void => {
  closeMenu()
  if (!terminal?.hasSelection()) return
  window.dot.toolbox.shell.write(props.sessionId, terminal.getSelection())
}

/** 右键菜单：重新连接 */
const reconnectSession = (): void => {
  closeMenu()
  emit('reconnect')
}

/** 右键菜单：复制连接命令（SSH 参数由宿主页拼接） */
const copyLink = (): void => {
  closeMenu()
  if (isLocal) return
  emit('copy-link')
}

/** 右键菜单：选中内容（无选中则取最近输出）发给 AI */
const sendToAi = (): void => {
  closeMenu()
  const text = terminal?.hasSelection() ? terminal.getSelection() : getRecentContent()
  emit('send-to-ai', text)
}

onMounted(() => {
  if (!containerRef.value) return

  // 初始化 xterm
  terminal = new Terminal({
    fontSize,
    fontFamily: '"Cascadia Code", Consolas, "Courier New", monospace',
    cursorBlink: true,
    theme: buildTerminalTheme(),
    allowProposedApi: true
  })
  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.loadAddon(new WebLinksAddon())
  terminal.open(containerRef.value)
  fitAddon.fit()

  // 键盘输入 → 主进程
  terminal.onData((data) => {
    window.dot.toolbox.shell.write(props.sessionId, data)
  })

  // Ctrl + 滚轮：调整字号后重新自适应
  containerRef.value.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey || !terminal || !fitAddon) return
      e.preventDefault()
      fontSize = Math.min(
        MAX_FONT_SIZE,
        Math.max(MIN_FONT_SIZE, fontSize + (e.deltaY < 0 ? 1 : -1))
      )
      terminal.options.fontSize = fontSize
      fitAddon.fit()
      window.dot.toolbox.shell.resize(props.sessionId, terminal.cols, terminal.rows)
    },
    { passive: false }
  )

  // 终端输出 → xterm 渲染（AI 读取走 getRecentContent 缓冲区接口）
  unsubscribers.push(
    window.dot.toolbox.shell.onData(({ sessionId, data }) => {
      if (sessionId !== props.sessionId || !terminal) return
      writeTerminal(data)
    })
  )

  // 点击其他区域 / 在终端外右键时关闭右键菜单
  document.addEventListener('click', closeMenu)
  document.addEventListener('contextmenu', closeMenu)

  // 会话退出提示
  unsubscribers.push(
    window.dot.toolbox.shell.onExit(({ sessionId, message }) => {
      if (sessionId !== props.sessionId || !terminal) return
      terminal.write(`\r\n\x1b[31m[连接已断开] ${message}\x1b[0m\r\n`)
    })
  )

  // 容器尺寸变化 → 自适应 + 通知主进程调整 PTY
  // 仅在可见且行列真正变化时处理：标签页切换（隐藏/恢复）不重复 resize，
  // 避免无谓的 SIGWINCH 引发 shell 重绘提示符（闪烁、内容错乱）
  let lastCols = terminal.cols
  let lastRows = terminal.rows
  resizeObserver = new ResizeObserver(() => {
    if (!fitAddon || !terminal || !containerRef.value) return
    // 容器不可见（宽或高为 0）时跳过：fit 会按 0 计算产生错误行列
    if (containerRef.value.clientWidth === 0 || containerRef.value.clientHeight === 0) return
    try {
      fitAddon.fit()
      if (terminal.cols === lastCols && terminal.rows === lastRows) return
      lastCols = terminal.cols
      lastRows = terminal.rows
      window.dot.toolbox.shell.resize(props.sessionId, terminal.cols, terminal.rows)
    } catch {
      // 容器不可见时 fit 可能失败，忽略
    }
  })
  resizeObserver.observe(containerRef.value)
})

onBeforeUnmount(() => {
  stopThemeWatch()
  resizeObserver?.disconnect()
  document.removeEventListener('click', closeMenu)
  document.removeEventListener('contextmenu', closeMenu)
  if (flushTimer !== null) clearTimeout(flushTimer)
  unsubscribers.forEach((fn) => fn())
  terminal?.dispose()
})
</script>

<template>
  <!-- 外层负责视觉留白；内层无 padding 供 FitAddon 精确计算行列，避免底行被截断 -->
  <div class="terminal-wrap">
    <div ref="containerRef" class="terminal-pane" @contextmenu="openMenu"></div>

    <!-- 右键菜单：复制 / 粘贴 / 重新连接 / 转到 AI -->
    <Teleport to="body">
      <div
        v-if="menuVisible"
        class="term-context-menu"
        :style="{ left: `${menuX}px`, top: `${menuY}px` }"
        @contextmenu.prevent
      >
        <div
          class="term-menu-item"
          :class="{ disabled: !hasSelection }"
          @click.stop="copySelection"
        >
          复制
        </div>
        <div class="term-menu-item" @click.stop="pasteClipboard">粘贴</div>
        <div
          class="term-menu-item"
          :class="{ disabled: !hasSelection }"
          @click.stop="pasteSelection"
        >
          粘贴选中内容
        </div>
        <div class="term-menu-divider"></div>
        <div class="term-menu-item" @click.stop="reconnectSession">重新连接</div>
        <div class="term-menu-item" :class="{ disabled: isLocal }" @click.stop="copyLink">
          复制链接
        </div>
        <div class="term-menu-divider"></div>
        <div class="term-menu-item" @click.stop="sendToAi">转到 AI</div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.terminal-wrap {
  width: 100%;
  height: 100%;
  padding: 14px 16px;
  background: var(--color-card);
  border-radius: 10px;
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.terminal-pane {
  width: 100%;
  height: 100%;
  background: transparent;
}

/* ===== 终端右键菜单 ===== */
.term-context-menu {
  position: fixed;
  z-index: 3000;
  min-width: 128px;
  padding: 4px 0;
  background: var(--color-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: var(--shadow-card);
  user-select: none;
}

.term-menu-item {
  padding: 7px 16px;
  font-size: 13px;
  color: var(--color-text);
  cursor: pointer;
  white-space: nowrap;
}

.term-menu-item:hover {
  background: var(--color-hover);
}

.term-menu-item.disabled {
  color: var(--color-text-secondary);
  opacity: 0.5;
  cursor: not-allowed;
}

.term-menu-divider {
  height: 1px;
  margin: 4px 8px;
  background: var(--color-border);
}
</style>
