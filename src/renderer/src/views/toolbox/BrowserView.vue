<script setup lang="ts">
/**
 * 浏览器页面：多标签网页浏览（一个 Tab 一个地址）
 *
 * - 基于 Electron <webview> 标签，可同时打开多个网页
 * - 支持「在本地浏览器中打开」当前页面
 * - 右侧可伸缩 AI 面板：读取页面内容分析，AI 生成 JS 指令仿人工操作浏览器
 *   （点击、输入、滚动等操作由 AI 生成的 JS 代码在页面内执行）
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { ElMessageBox } from 'element-plus'
import { Plus, Refresh, Position, MagicStick, Back, Right } from '@element-plus/icons-vue'
import liulanqiSvg from '../../assets/liulanqi.svg'
import AiAssistant from '../../components/AiAssistant.vue'
import type { AiTool } from '../../composables/prompt'

const toolbox = window.dot.toolbox

/** webview 元素类型（渲染进程无 Electron 类型，此处声明用到的方法） */
interface WebviewElement extends HTMLElement {
  getURL(): string
  getTitle(): string
  getWebContentsId(): number
  reload(): void
  goBack(): void
  goForward(): void
  executeJavaScript(code: string): Promise<unknown>
}

// ==================== 标签管理 ====================
interface BrowserTab {
  id: number
  /** 驱动 webview 加载的地址（仅在新建标签 / 地址栏回车时更新，避免响应式变化导致重复加载） */
  src: string
  /** 当前实际加载的 URL（随页面导航更新，仅用于展示） */
  url: string
  /** 地址栏输入内容（可能与 url 短暂不同步） */
  address: string
  /** 页面标题（随页面更新） */
  title: string
  /** 网站图标 URL（随页面更新） */
  favicon: string
}

let tabSeq = 0
const tabs = ref<BrowserTab[]>([])
const activeTabId = ref(0)
/** 各标签的 webview 元素实例 */
const webviewRefs = new Map<number, WebviewElement>()

const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value) || null)

/** 收集 webview 元素引用，并用原生 addEventListener 绑定事件（Vue @事件 对 webview 自定义元素不可靠） */
const setWebviewRef =
  (tabId: number) =>
  (el: unknown): void => {
    if (el) {
      const webview = el as WebviewElement
      // 避免重复绑定
      if (!webviewRefs.has(tabId)) {
        bindWebviewEvents(tabId, webview)
      }
      webviewRefs.set(tabId, webview)
    } else {
      webviewRefs.delete(tabId)
    }
  }

/** 用原生事件监听同步标签的地址与标题 */
const bindWebviewEvents = (tabId: number, webview: WebviewElement): void => {
  const findTab = (): BrowserTab | undefined => tabs.value.find((t) => t.id === tabId)

  // 导航完成：同步地址与标题
  webview.addEventListener('did-navigate', () => {
    const tab = findTab()
    if (!tab) return
    tab.url = webview.getURL()
    tab.address = tab.url
    const title = webview.getTitle()
    if (title) tab.title = title
  })

  // 页内跳转（SPA）：兜底同步地址与标题
  webview.addEventListener('did-navigate-in-page', () => {
    const tab = findTab()
    if (!tab) return
    tab.url = webview.getURL()
    tab.address = tab.url
    const title = webview.getTitle()
    if (title) tab.title = title
  })

  // 页面标题更新
  webview.addEventListener('page-title-updated', (e: Event) => {
    const tab = findTab()
    if (!tab) return
    const title = (e as unknown as { title: string }).title
    if (title) tab.title = title
  })

  // 网站图标更新
  webview.addEventListener('page-favicon-updated', (e: Event) => {
    const tab = findTab()
    if (!tab) return
    const icons = (e as unknown as { favicons: string[] }).favicons || []
    tab.favicon = icons[icons.length - 1] || ''
  })

  webview.addEventListener('did-fail-load', (e: Event) => {
    const d = e as unknown as { errorCode: number; errorDescription: string }
    // statusCode -3 是被取消的请求（如跳转中断），无需提示
    if (d.errorCode === -3) return
    console.warn('[browser] did-fail-load', tabId, d.errorCode, d.errorDescription)
    const tab = findTab()
    if (tab) tab.title = `加载失败 (${d.errorCode})`
  })
}

/** 规范化地址：无协议时补全 https:// */
const normalizeUrl = (input: string): string => {
  const trimmed = input.trim()
  if (!trimmed) return ''
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** 新建标签：弹窗输入网址 */
const createTab = async (initUrl?: string): Promise<void> => {
  let url = initUrl
  if (!url) {
    try {
      const { value } = await ElMessageBox.prompt('请输入网址', '新建标签', {
        inputValue: 'https://www.baidu.com'
      })
      url = value
    } catch {
      return // 用户取消
    }
  }
  url = normalizeUrl(url)
  if (!url) return

  const tab: BrowserTab = {
    id: ++tabSeq,
    src: url,
    url,
    address: url,
    title: '加载中...',
    favicon: ''
  }
  tabs.value.push(tab)
  activeTabId.value = tab.id
}

/** 关闭标签 */
const closeTab = (tabId: number): void => {
  const idx = tabs.value.findIndex((t) => t.id === tabId)
  if (idx === -1) return
  tabs.value.splice(idx, 1)
  webviewRefs.delete(tabId)
  if (activeTabId.value === tabId) {
    activeTabId.value = tabs.value[Math.min(idx, tabs.value.length - 1)]?.id ?? 0
  }
}

/** 地址栏回车：跳转当前标签 */
const navigate = (): void => {
  const tab = activeTab.value
  if (!tab) return
  const url = normalizeUrl(tab.address)
  if (!url) return
  tab.url = url
  tab.src = url
}

/** 刷新当前标签（重新加载 webview） */
const refreshTab = (): void => {
  const webview = webviewRefs.get(activeTabId.value)
  if (!webview) return
  webview.reload()
}

/** 前进 / 后退 */
const goBack = (): void => webviewRefs.get(activeTabId.value)?.goBack()
const goForward = (): void => webviewRefs.get(activeTabId.value)?.goForward()

/** 在系统默认浏览器中打开当前页面 */
const openInLocalBrowser = async (): Promise<void> => {
  const tab = activeTab.value
  if (!tab) return
  await toolbox.openExternal(tab.url)
}

// ==================== 新窗口拦截：以新标签页打开（类似 Chrome） ====================
let offNewWindow: (() => void) | null = null

onMounted((): void => {
  // 主进程拦截 webview 的 window.open / target=_blank，转发到此处
  offNewWindow = toolbox.onWebviewNewWindow(({ openerId, url }) => {
    // 找到发起新窗口的标签（webContentsId 匹配），在该标签之后插入新标签
    const idx = tabs.value.findIndex((t) => webviewRefs.get(t.id)?.getWebContentsId() === openerId)
    const tab: BrowserTab = {
      id: ++tabSeq,
      src: url,
      url,
      address: url,
      title: '加载中...',
      favicon: ''
    }
    tabs.value.splice(idx >= 0 ? idx + 1 : tabs.value.length, 0, tab)
    activeTabId.value = tab.id
  })
})

onUnmounted((): void => {
  offNewWindow?.()
  offNewWindow = null
})

// ==================== AI 面板 ====================
const aiVisible = ref(false)

/** 读取当前页面上下文：标题 + URL + 正文摘要 */
const getBrowserContext = async (): Promise<string> => {
  const webview = webviewRefs.get(activeTabId.value)
  if (!webview) return ''
  try {
    // 提取页面正文文本（截断，避免超长）
    const text = await webview.executeJavaScript(
      'document.body ? document.body.innerText.slice(0, 3000) : ""'
    )
    return `页面标题: ${webview.getTitle()}\nURL: ${webview.getURL()}\n\n正文内容:\n${text}`
  } catch (e) {
    return `页面标题: ${webview.getTitle()}\nURL: ${webview.getURL()}\n（正文读取失败: ${e}）`
  }
}

/**
 * 在当前页面执行 AI 生成的 JS 代码（仿人工操作浏览器）
 * AI 输出形如：
 *   ```js
 *   document.querySelector('#kw').value = '搜索词'
 *   document.querySelector('#su').click()
 *   ```
 */
const executeBrowserCommand = (code: string, lang: string): void => {
  const webview = webviewRefs.get(activeTabId.value)
  if (!webview) {
    throw new Error('没有激活的网页标签')
  }
  if (lang && lang !== 'js' && lang !== 'javascript') {
    throw new Error('仅支持执行 JS 代码')
  }
  webview.executeJavaScript(code)
}

/** 浏览器页面独有的 AI 工具：读取页面内容 / 在页面内执行 JS 操作 */
const browserAiTools: AiTool[] = [
  {
    name: 'get_page_content',
    description: '获取当前网页的标题、地址与正文文本',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => getBrowserContext()
  },
  {
    name: 'run_page_js',
    description: '在当前网页内执行 JS 代码（仿人工操作浏览器：点击、输入、滚动等）',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: '要执行的 JS 代码' } },
      required: ['code']
    },
    execute: async (args) => {
      const code = String(args.code ?? '').trim()
      if (!code) throw new Error('缺少参数：code')
      const webview = webviewRefs.get(activeTabId.value)
      if (!webview) throw new Error('没有激活的网页标签')
      const result = await webview.executeJavaScript(code)
      return `执行完成${result !== undefined ? `，返回：${String(result).slice(0, 2000)}` : ''}`
    }
  }
]

/** 打开默认页面 */
createTab('https://www.baidu.com')
</script>

<template>
  <div class="browser-page">
    <!-- 顶栏 -->
    <header class="browser-header">
      <div class="browser-header-left">
        <div class="browser-header-brand">
          <div class="browser-header-badge">
            <img :src="liulanqiSvg" alt="浏览器" class="browser-header-icon" />
          </div>
          <span class="browser-header-title">浏览器</span>
        </div>
      </div>
      <div class="browser-header-actions">
        <el-button type="primary" :icon="Plus" @click="createTab()">新标签</el-button>
        <el-button
          :type="aiVisible ? 'primary' : 'default'"
          :icon="MagicStick"
          plain
          @click="aiVisible = !aiVisible"
        >
          AI 助手
        </el-button>
      </div>
    </header>

    <!-- 主区域：网页标签 + AI 侧栏 -->
    <div class="browser-content">
      <div class="browser-area">
        <el-tabs
          v-if="tabs.length > 0"
          v-model="activeTabId"
          type="card"
          class="browser-tabs"
          @tab-remove="(name: any) => closeTab(Number(name))"
        >
          <el-tab-pane v-for="tab in tabs" :key="tab.id" :name="tab.id" closable>
            <template #label>
              <span class="browser-tab-label" :title="tab.title">
                <img
                  v-if="tab.favicon"
                  :src="tab.favicon"
                  alt=""
                  class="browser-tab-favicon"
                  @error="tab.favicon = ''"
                />
                <span class="browser-tab-title">{{ tab.title }}</span>
              </span>
            </template>

            <!-- 标签工具栏：地址栏 + 导航操作 -->
            <div class="webview-toolbar">
              <el-button-group>
                <el-button :icon="Back" @click="goBack" />
                <el-button :icon="Right" @click="goForward" />
                <el-button :icon="Refresh" @click="refreshTab" />
              </el-button-group>
              <el-input
                v-model="tab.address"
                class="webview-address"
                placeholder="输入网址，回车访问"
                clearable
                @keyup.enter="navigate"
              />
              <el-button :icon="Position" @click="openInLocalBrowser">在本地浏览器打开</el-button>
            </div>

            <!-- webview：一个标签一个独立网页，随标签销毁；allowpopups 用于拦截新窗口转标签页 -->
            <webview
              :ref="setWebviewRef(tab.id)"
              :key="tab.id"
              :src="tab.src"
              class="webview"
              allowpopups
            />
          </el-tab-pane>
        </el-tabs>

        <!-- 空状态 -->
        <div v-else class="browser-empty">
          <el-empty description="暂无网页标签">
            <el-button type="primary" @click="createTab()">新建标签</el-button>
          </el-empty>
        </div>
      </div>

      <!-- 可伸缩 AI 侧栏 -->
      <AiAssistant
        v-show="aiVisible"
        scene="browser"
        title="浏览器 AI 助手"
        :get-context="getBrowserContext"
        :tools="browserAiTools"
        :execute-command="executeBrowserCommand"
        execute-label="在页面执行"
      />
    </div>
  </div>
</template>

<style scoped>
.browser-page {
  /* 独立窗口运行，无父级高度链，需占满视口 */
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
}

.browser-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: var(--color-card);
  border-bottom: 1px solid var(--color-border);
  /* 品牌色底部渐变线 */
  box-shadow: inset 0 -2px 0 0 var(--color-primary);
}

.browser-header-left {
  display: flex;
  align-items: center;
  gap: 16px;
  color: var(--color-text);
}

.browser-header-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.browser-header-badge {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.browser-header-icon {
  width: 25px;
  height: 25px;
}

.browser-header-title {
  font-size: 16px;
  font-weight: 600;
}

.browser-content {
  flex: 1;
  display: flex;
  min-height: 0;
}

.browser-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 8px;
}

.browser-tabs {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.browser-tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
}

.browser-tabs :deep(.el-tab-pane) {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.browser-tab-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 180px;
  vertical-align: middle;
}

/* 标签页网站图标 */
.browser-tab-favicon {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border-radius: 3px;
}

.browser-tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.webview-toolbar {
  display: flex;
  gap: 8px;
}

.webview-address {
  flex: 1;
}

.webview {
  flex: 1;
  min-height: 0;
  background: var(--color-card);
  border-radius: 8px;
  border: 1px solid var(--color-border);
}

.browser-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
