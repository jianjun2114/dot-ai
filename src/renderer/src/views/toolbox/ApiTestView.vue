<script setup lang="ts">
/**
 * 接口测试页面：HTTP / WebSocket 两种协议测试
 *
 * - 左侧地址列表：持久化到 cache/api.json（与 shell.json 同级），默认收起
 * - 多标签：每个 Tab 一个独立请求，新建时可选 HTTP / WebSocket，默认打开一个 HTTP 请求
 * - 右上角：新建请求（下拉选协议）+ AI 识别（粘贴接口文档/抓包内容自动创建请求 Tab）
 * - HTTP：请求头隐藏，通过「添加请求头」弹框维护；请求体/响应体 4:6 分栏；响应区分正文/响应头 Tab
 */
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Promotion,
  Link,
  SetUp,
  Plus,
  MagicStick,
  Delete,
  Collection,
  Fold,
  Expand,
  ArrowRight
} from '@element-plus/icons-vue'
import apiTestSvg from '../../assets/api_test.svg'
import BackHome from '../../components/BackHome.vue'
import { sendLlm, type LlmChatMessage } from '../../utils/aiRequest'
import { getAppPath } from '../../utils/config'

const net = window.dot.toolbox.net

// ==================== 类型定义 ====================
type ReqType = 'http' | 'ws'

interface KvItem {
  key: string
  value: string
}

interface HttpResultView {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  elapsed: number
  isSse: boolean
  sseText: string
}

interface WsLogEntry {
  direction: 'out' | 'in' | 'system'
  time: string
  data: string
}

/** 请求 Tab：一个 Tab 一个独立请求（含全部状态） */
interface ApiTab {
  id: string
  type: ReqType
  /** 来源地址列表条目 ID（用于点击地址时复用已有 Tab） */
  savedId?: string
  /** HTTP */
  method: string
  url: string
  headers: KvItem[]
  bodyType: 'none' | 'json' | 'form' | 'raw'
  jsonBody: string
  rawBody: string
  formItems: KvItem[]
  sending: boolean
  result: HttpResultView | null
  /** 响应区当前 Tab：正文 / 响应头 */
  respTab: 'body' | 'headers'
  /** 本次请求 ID（匹配 SSE chunk） */
  requestId: string
  /** WebSocket */
  target: string
  /** WebSocket 协议模式：raw 原始帧 / stomp */
  wsMode: 'raw' | 'stomp'
  /** STOMP 发送目的地（@MessageMapping 路径，如 /app/ai/chat） */
  stompDest: string
  /** STOMP 订阅目的地模板，支持 {字段} 变量（如 /topic/ai/chat/{sessionId}） */
  stompSubDest: string
  /** 已订阅的 STOMP 目的地 */
  stompSubs: string[]
  connected: boolean
  connecting: boolean
  input: string
  logs: WsLogEntry[]
}

/** 地址列表条目（cache/api.json） */
interface SavedAddress {
  id: string
  name: string
  url: string
  type: ReqType
  /** 可选分类 */
  category?: string
  /** HTTP 请求完整配置（方法/请求头/参数） */
  request?: SavedRequest
  /** WebSocket 配置（模式/发送目的地/订阅目的地） */
  ws?: SavedWsConfig
}

/** 保存的 HTTP 请求配置 */
interface SavedRequest {
  method: string
  headers: KvItem[]
  bodyType: 'none' | 'json' | 'form' | 'raw'
  jsonBody: string
  rawBody: string
  formItems: KvItem[]
}

/** 保存的 WebSocket 配置（协议模式与目的地） */
interface SavedWsConfig {
  wsMode: 'raw' | 'stomp'
  stompDest: string
  stompSubDest: string
}

/** 深拷贝（避免 Tab 与列表共享引用） */
function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

// ==================== Tab 管理 ====================
const API_METHODS = ['POST', 'GET', 'PUT', 'DELETE', 'PATCH']
/** 有请求体的方法 */
const BODY_METHODS = ['POST', 'PUT', 'PATCH']

let tabSeq = 0
const genId = (prefix: string): string => `${prefix}-${Date.now()}-${++tabSeq}`

const now = (): string => new Date().toLocaleTimeString()

/** 创建一个请求 Tab（默认 HTTP GET） */
const createTab = (type: ReqType = 'http', preset: Partial<ApiTab> = {}): ApiTab => {
  const tab: ApiTab = {
    id: genId('req'),
    type,
    method: 'POST',
    url: '',
    headers: [{ key: '', value: '' }],
    bodyType: 'none',
    jsonBody: '{\n  "key": "value"\n}',
    rawBody: '',
    formItems: [{ key: '', value: '' }],
    sending: false,
    result: null,
    respTab: 'body',
    requestId: '',
    target: '',
    wsMode: 'raw',
    stompDest: '',
    stompSubDest: '',
    stompSubs: [],
    connected: false,
    connecting: false,
    input: '',
    logs: [],
    ...preset
  }
  tabs.value.push(tab)
  activeTabId.value = tab.id
  return tab
}

const tabs = ref<ApiTab[]>([])
const activeTabId = ref('')
const activeTab = computed<ApiTab | undefined>(() =>
  tabs.value.find((t) => t.id === activeTabId.value)
)

/** Tab 标题：HTTP 显示方法 + 域名摘要，WS 显示协议名 + 目标摘要 */
const tabLabel = (tab: ApiTab): string => {
  if (tab.type === 'http') {
    let host = tab.url.trim()
    try {
      host = new URL(tab.url.trim()).host
    } catch {
      // 未输入完整地址时原样截断
    }
    return `${tab.method} ${host || '未命名'}`
  }
  const target = tab.target.replace(/^wss?:\/\//, '')
  return `${tab.type.toUpperCase()} ${target.slice(0, 18)}`
}

/** 关闭 Tab：清理 WS 连接 */
const closeTab = async (tab: ApiTab): Promise<void> => {
  const idx = tabs.value.findIndex((t) => t.id === tab.id)
  if (idx < 0) return
  if (tab.type === 'ws' && tab.connected) await net.wsClose(tab.id)
  tabs.value.splice(idx, 1)
  if (activeTabId.value === tab.id) {
    activeTabId.value = tabs.value[Math.max(0, idx - 1)]?.id ?? ''
  }
}

// ==================== 消息面板自动滚动到底部 ====================
const logRefs = new Map<string, HTMLElement>()

const setLogRef = (id: string, el: unknown): void => {
  if (el) logRefs.set(id, el as HTMLElement)
  else logRefs.delete(id)
}

const scrollLogToBottom = (id: string): void => {
  void nextTick(() => {
    const el = logRefs.get(id)
    if (el) el.scrollTop = el.scrollHeight
  })
}

/** 任一 Tab 日志条数变化时，把当前激活 Tab 的消息面板滚到底部 */
watch(
  () => tabs.value.map((t) => t.logs.length).join(','),
  () => {
    const tab = activeTab.value
    if (tab) scrollLogToBottom(tab.id)
  }
)

// ==================== 地址列表（cache/api.json） ====================
const API_CACHE_FILE = 'cache/api.json'
let appBasePath = ''
const apiCachePath = (): string => `${appBasePath}/${API_CACHE_FILE}`

const savedAddresses = ref<SavedAddress[]>([])

const loadAddresses = async (): Promise<void> => {
  appBasePath = await getAppPath()
  try {
    const content = (await window.dot.localFiles('read', apiCachePath())) as string
    if (!content) return
    const data = JSON.parse(content)
    savedAddresses.value = Array.isArray(data.addresses) ? data.addresses : []
  } catch {
    // 缓存文件损坏时忽略
  }
}

const persistAddresses = async (): Promise<void> => {
  await window.dot.localFiles(
    'write',
    apiCachePath(),
    JSON.stringify({ addresses: savedAddresses.value }, null, 2)
  )
}

/** 新增/更新一条地址记录（置顶，同类型同地址去重），返回记录 ID */
const upsertAddress = async (entry: {
  type: ReqType
  url: string
  name: string
  category?: string
  request?: SavedRequest
  ws?: SavedWsConfig
}): Promise<string> => {
  const url = entry.url.trim()
  if (!url) return ''
  let id = ''
  const existed = savedAddresses.value.find((a) => a.type === entry.type && a.url === url)
  if (existed) {
    // 已存在时更新名称/分类/请求配置并置顶
    existed.name = entry.name || existed.name
    existed.category = entry.category || existed.category
    existed.request = entry.request
    existed.ws = entry.ws
    id = existed.id
    savedAddresses.value = [existed, ...savedAddresses.value.filter((a) => a.id !== existed.id)]
  } else {
    id = genId('addr')
    savedAddresses.value.unshift({
      id,
      name: entry.name,
      url,
      type: entry.type,
      category: entry.category || undefined,
      request: entry.request,
      ws: entry.ws
    })
    if (savedAddresses.value.length > 100) savedAddresses.value.length = 100
  }
  await persistAddresses()
  return id
}

/** 点击地址：已有对应 Tab 则激活，否则用保存的请求配置打开新 Tab */
const openAddress = (addr: SavedAddress): void => {
  // 复用已打开的 Tab
  const existedTab = tabs.value.find((t) => t.savedId === addr.id)
  if (existedTab) {
    activeTabId.value = existedTab.id
    return
  }
  if (addr.type === 'http') {
    const r = addr.request
    createTab('http', {
      savedId: addr.id,
      url: addr.url,
      ...(r
        ? {
            method: r.method,
            headers: deepClone(r.headers),
            bodyType: r.bodyType,
            jsonBody: r.jsonBody,
            rawBody: r.rawBody,
            formItems: deepClone(r.formItems)
          }
        : {})
    })
  } else {
    createTab(addr.type, {
      savedId: addr.id,
      target: addr.url,
      ...(addr.type === 'ws' && addr.ws
        ? {
            wsMode: addr.ws.wsMode,
            stompDest: addr.ws.stompDest,
            stompSubDest: addr.ws.stompSubDest
          }
        : {})
    })
  }
}

// ==================== 保存地址弹框 ====================
const saveDialogVisible = ref(false)
const saveForm = reactive<{ name: string; url: string; category: string }>({
  name: '',
  url: '',
  category: ''
})
/** 保存弹框对应的请求 Tab（确认时写回） */
let saveTargetTab: ApiTab | null = null

/** 已有分类列表（供保存时选择） */
const existingCategories = computed(() => [
  ...new Set(
    savedAddresses.value.map((a) => a.category).filter((c): c is string => !!c && c.trim() !== '')
  )
])

/** 打开保存弹框：保存当前激活的请求 Tab，地址默认带出，名称默认取域名/摘要 */
const openSaveDialog = (): void => {
  const tab = activeTab.value
  if (!tab) {
    ElMessage.warning('请先选择要保存的请求')
    return
  }
  // 保存地址：HTTP 取请求地址，WS 取连接地址
  const url = (tab.type === 'http' ? tab.url : tab.target).trim()
  if (!url) {
    ElMessage.warning('当前请求没有可保存的地址')
    return
  }
  let name = url
  try {
    name = new URL(url).host
  } catch {
    name = url.slice(0, 30)
  }
  saveTargetTab = tab
  saveForm.url = url
  saveForm.name = name
  saveForm.category = ''
  saveDialogVisible.value = true
}

/** 确认保存：写入地址列表 */
const confirmSave = async (): Promise<void> => {
  if (!saveTargetTab) return
  if (!saveForm.name.trim()) {
    ElMessage.warning('请填写名称')
    return
  }
  // HTTP 请求时连同方法/请求头/参数一起保存
  const tab = saveTargetTab
  const request: SavedRequest | undefined =
    tab.type === 'http'
      ? {
          method: tab.method,
          headers: deepClone(tab.headers),
          bodyType: tab.bodyType,
          jsonBody: tab.jsonBody,
          rawBody: tab.rawBody,
          formItems: deepClone(tab.formItems)
        }
      : undefined
  const id = await upsertAddress({
    type: tab.type,
    url: saveForm.url,
    name: saveForm.name.trim(),
    category: saveForm.category.trim() || undefined,
    request,
    // WebSocket 保存协议模式与发送/订阅目的地
    ws:
      tab.type === 'ws'
        ? {
            wsMode: tab.wsMode,
            stompDest: tab.stompDest,
            stompSubDest: tab.stompSubDest
          }
        : undefined
  })
  // Tab 与地址记录关联，后续点击列表项复用该 Tab
  if (id) tab.savedId = id
  saveDialogVisible.value = false
  ElMessage.success('已保存到地址列表')
}

const removeAddress = async (addr: SavedAddress): Promise<void> => {
  savedAddresses.value = savedAddresses.value.filter((a) => a.id !== addr.id)
  await persistAddresses()
}

// ==================== 地址列表分组（相同类别合并为文件夹） ====================
interface AddressFolder {
  name: string
  items: SavedAddress[]
}

const groupedAddresses = computed<{ root: SavedAddress[]; folders: AddressFolder[] }>(() => {
  const root: SavedAddress[] = []
  const map = new Map<string, SavedAddress[]>()
  for (const addr of savedAddresses.value) {
    const category = (addr.category || '').trim()
    if (!category) {
      root.push(addr)
    } else {
      const list = map.get(category)
      if (list) list.push(addr)
      else map.set(category, [addr])
    }
  }
  return {
    root,
    folders: [...map.entries()].map(([name, items]) => ({ name, items }))
  }
})

/** 文件夹展开状态（默认全部收起） */
const expandedFolders = ref<Record<string, boolean>>({})

const toggleFolder = (name: string): void => {
  expandedFolders.value[name] = !expandedFolders.value[name]
}

// ==================== 地址侧栏宽度拖拽 ====================
const addrWidth = ref(240)
/** 侧栏整体展开/合拢（默认合上） */
const addrOpen = ref(false)

const startResize = (e: MouseEvent): void => {
  const startX = e.clientX
  const startWidth = addrWidth.value
  const onMove = (ev: MouseEvent): void => {
    addrWidth.value = Math.min(480, Math.max(160, startWidth + ev.clientX - startX))
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// ==================== HTTP 请求 ====================
/** 是否显示请求头弹框 */
const headerDialogVisible = ref(false)

/** 当前 Tab 的请求头对象（过滤空行） */
const buildHeaders = (tab: ApiTab): Record<string, string> => {
  const headers: Record<string, string> = {}
  for (const { key, value } of tab.headers) {
    if (key.trim()) headers[key.trim()] = value
  }
  return headers
}

/** 构造请求体字符串（POST/PUT/PATCH 使用） */
const buildBody = (tab: ApiTab): string => {
  switch (tab.bodyType) {
    case 'json':
      return tab.jsonBody
    case 'raw':
      return tab.rawBody
    case 'form': {
      const params = new URLSearchParams()
      for (const { key, value } of tab.formItems) {
        if (key.trim()) params.append(key.trim(), value)
      }
      return params.toString()
    }
    default:
      return ''
  }
}

/** GET/DELETE 请求：将请求体内容拼接为查询串（追加在地址后） */
const buildQuery = (tab: ApiTab): string => {
  switch (tab.bodyType) {
    case 'json': {
      try {
        const obj = JSON.parse(tab.jsonBody || 'null')
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          return new URLSearchParams(Object.entries(obj).map(([k, v]) => [k, String(v)])).toString()
        }
      } catch {
        // JSON 不合法时忽略
      }
      return ''
    }
    case 'form': {
      const params = new URLSearchParams()
      for (const { key, value } of tab.formItems) {
        if (key.trim()) params.append(key.trim(), value)
      }
      return params.toString()
    }
    case 'raw':
      return tab.rawBody.trim()
    default:
      return ''
  }
}

/** 当前 Tab 已填写的请求头名称（用于链接括号内展示） */
const headerNames = (tab: ApiTab): string =>
  tab.headers
    .filter((h) => h.key.trim())
    .map((h) => h.key.trim())
    .join('、')

// ==================== 请求体 AI 美化 ====================
const beautifyingBody = ref(false)

/** AI 美化请求体：JSON 类型时将任意形式的参数整理成规范 JSON */
const beautifyBody = async (): Promise<void> => {
  const tab = activeTab.value
  if (!tab || tab.type !== 'http') return
  if (tab.bodyType !== 'json') {
    ElMessage.warning('仅 JSON 类型支持美化')
    return
  }
  const source = tab.jsonBody.trim()
  if (!source) {
    ElMessage.warning('请先填写参数内容再美化')
    return
  }
  beautifyingBody.value = true
  try {
    // 1. 程序美化：已是合法 JSON 则直接格式化
    try {
      const parsed = JSON.parse(source)
      tab.jsonBody = JSON.stringify(parsed, null, 2)
      tab.bodyType = 'json'
      return
    } catch {
      // 非法 JSON，继续走大模型
    }
    // 2. 大模型美化：整理任意形式的参数
    const system: LlmChatMessage = {
      role: 'system',
      content:
        '你是 JSON 参数整理器。将用户提供的任意形式的参数（键值对、表单文本、非标准 JSON 等）' +
        '整理成一个规范、格式化的 JSON 对象：补全必要的引号，数值/布尔保持类型，无法判断类型的值用字符串。' +
        '只输出整理后的 JSON，不要输出任何其他文字。'
    }
    const user: LlmChatMessage = { role: 'user', content: source }
    const result = await sendLlm([system, user], { temperature: 0.2 })
    const parsed = extractJson(result.content)
    tab.jsonBody = JSON.stringify(parsed, null, 2)
    tab.bodyType = 'json'
  } catch (e) {
    ElMessage.error(`美化失败: ${e}`)
  } finally {
    beautifyingBody.value = false
  }
}

/** 发送当前 HTTP Tab 的请求 */
const sendHttp = async (tab: ApiTab): Promise<void> => {
  if (!tab.url.trim()) {
    ElMessage.warning('请输入请求地址')
    return
  }
  if (tab.bodyType === 'json') {
    try {
      JSON.parse(tab.jsonBody || 'null')
    } catch {
      ElMessage.error('JSON 请求体格式不合法')
      return
    }
  }

  // GET/DELETE：将请求体拼接为查询串追加到地址后面
  let finalUrl = tab.url.trim()
  const isQueryMethod = !BODY_METHODS.includes(tab.method)
  if (isQueryMethod && tab.bodyType !== 'none') {
    const query = buildQuery(tab)
    if (query) {
      const sep = finalUrl.includes('?') ? '&' : '?'
      finalUrl += sep + query
    }
  }

  tab.sending = true
  tab.result = null
  try {
    const result = await net.httpRequest({
      method: tab.method,
      url: finalUrl,
      headers: buildHeaders(tab),
      body: isQueryMethod ? '' : buildBody(tab),
      bodyType: isQueryMethod ? 'none' : tab.bodyType
    })
    tab.requestId = result.requestId
    tab.result = {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
      body: result.body,
      elapsed: result.elapsed,
      isSse: result.isSse,
      sseText: ''
    }
    try {
      tab.result.body = JSON.stringify(JSON.parse(result.body), null, 2)
    } catch {
      // 非 JSON 响应，保持原文
    }
  } catch (e) {
    ElMessage.error(`请求失败: ${e}`)
  } finally {
    tab.sending = false
  }
}

/** SSE 流式 chunk 订阅（按 requestId 路由到对应 Tab） */
const unsubscribeChunks = net.onHttpChunk(({ requestId, chunk }) => {
  const tab = tabs.value.find((t) => t.requestId === requestId)
  if (tab?.result) tab.result.sseText += chunk
})

// ==================== WebSocket ====================
/** 构造 STOMP 帧：命令 + 头 + 空行 + 体 + 结束符 \0 */
const stompFrame = (command: string, headers: Record<string, string>, body = ''): string =>
  command +
  '\n' +
  Object.entries(headers)
    .map(([k, v]) => `${k}:${v}`)
    .join('\n') +
  '\n\n' +
  body +
  '\0'

/** 从 WS 地址提取 host（STOMP CONNECT 需要） */
const wsHostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return 'localhost'
  }
}

const connectWs = async (tab: ApiTab): Promise<void> => {
  if (!tab.target.trim()) {
    ElMessage.warning('请输入 WebSocket 地址')
    return
  }
  tab.connecting = true
  try {
    await net.wsConnect(tab.id, tab.target.trim())
    tab.connected = true
    tab.logs.push({ direction: 'system', time: now(), data: '连接已建立' })
    // STOMP 模式：连接后自动发送 CONNECT 帧
    if (tab.wsMode === 'stomp') {
      const frame = stompFrame('CONNECT', {
        'accept-version': '1.2',
        host: wsHostOf(tab.target),
        'heart-beat': '0,0'
      })
      await net.wsSend(tab.id, frame)
      tab.logs.push({ direction: 'out', time: now(), data: 'STOMP CONNECT' })
    }
  } catch (e) {
    ElMessage.error(`连接失败: ${e}`)
  } finally {
    tab.connecting = false
  }
}

/** 解析订阅目的地模板：将 {字段} 替换为消息体 JSON 中的值；缺字段时返回 null */
const resolveSubDestTemplate = (template: string, bodyJson: string): string | null => {
  const placeholders = template.match(/\{(\w+)\}/g)
  if (!placeholders || placeholders.length === 0) return template
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(bodyJson) as Record<string, unknown>
  } catch {
    return null
  }
  let result = template
  for (const ph of placeholders) {
    const key = ph.slice(1, -1)
    const value = body[key]
    if (value === undefined || value === null) return null
    result = result.replaceAll(ph, String(value))
  }
  return result
}

/** STOMP 订阅目的地（去重，同一目的地只订阅一次） */
const stompSubscribe = async (tab: ApiTab, destination: string): Promise<void> => {
  const dest = destination.trim()
  if (!dest) {
    ElMessage.warning('请输入订阅目的地')
    return
  }
  if (tab.stompSubs.includes(dest)) return
  const frame = stompFrame('SUBSCRIBE', {
    id: `sub-${tab.id}-${tab.stompSubs.length}`,
    destination: dest
  })
  await net.wsSend(tab.id, frame)
  tab.stompSubs.push(dest)
  tab.logs.push({
    direction: 'out',
    time: now(),
    data: `STOMP SUBSCRIBE ${dest}\nSEND 目的地：${tab.stompDest.trim() || '（未填写）'}\n订阅目的地：${tab.stompSubDest.trim() || dest}`
  })
  scrollLogToBottom(tab.id)
}

/** 手动订阅：模板含未解析变量时不允许直接订阅 */
const stompManualSubscribe = (tab: ApiTab): void => {
  const t = tab.stompSubDest.trim()
  if (!t) {
    ElMessage.warning('请输入订阅目的地')
    return
  }
  if (/\{\w+\}/.test(t)) {
    ElMessage.warning('订阅目的地含 {变量}，请先发送包含对应字段的消息，由工具自动订阅')
    return
  }
  void stompSubscribe(tab, t)
}

const sendWsMessage = async (tab: ApiTab): Promise<void> => {
  if (!tab.input.trim()) return
  if (tab.wsMode === 'stomp') {
    if (!tab.stompDest.trim()) {
      ElMessage.warning('请输入 SEND 目的地（如 /app/ai/chat）')
      return
    }
    const frame = stompFrame('SEND', { destination: tab.stompDest.trim() }, tab.input)
    await net.wsSend(tab.id, frame)
    tab.logs.push({
      direction: 'out',
      time: now(),
      data: `STOMP SEND → ${tab.stompDest.trim()}\n${tab.input}`
    })
    // 自动订阅：解析订阅目的地模板中的 {字段} 变量（从消息体取值），任意 topic 规则均适用
    if (tab.stompSubDest.trim()) {
      const resolved = resolveSubDestTemplate(tab.stompSubDest.trim(), tab.input)
      if (resolved && !tab.stompSubs.includes(resolved)) {
        await stompSubscribe(tab, resolved)
        tab.logs.push({
          direction: 'system',
          time: now(),
          data: `已自动订阅 ${resolved}`
        })
      } else if (!resolved && /\{\w+\}/.test(tab.stompSubDest)) {
        tab.logs.push({
          direction: 'system',
          time: now(),
          data: `订阅目的地模板 ${tab.stompSubDest} 中的变量无法从消息体解析，未自动订阅`
        })
      }
    }
  } else {
    await net.wsSend(tab.id, tab.input)
    tab.logs.push({ direction: 'out', time: now(), data: tab.input })
  }
  tab.input = ''
}

/** WS 输入框回车发送，Shift+回车换行 */
const onWsInputKeydown = (e: KeyboardEvent, tab: ApiTab): void => {
  if (e.shiftKey) return
  e.preventDefault()
  void sendWsMessage(tab)
}

const disconnectWs = async (tab: ApiTab): Promise<void> => {
  await net.wsClose(tab.id)
}

/** 解析 STOMP MESSAGE 帧：提取目的地与消息体 */
const parseStompMessage = (raw: string): { destination: string; body: string } => {
  const trimmed = raw.replace(/\0$/, '')
  const sep = trimmed.indexOf('\n\n')
  if (sep < 0) return { destination: '', body: trimmed }
  const headerBlock = trimmed.slice(0, sep)
  const body = trimmed.slice(sep + 2)
  const destination =
    headerBlock
      .split('\n')
      .find((line) => line.toLowerCase().startsWith('destination:'))
      ?.slice('destination:'.length)
      .trim() ?? ''
  return { destination, body }
}

const unsubscribeWs = net.onWsEvent(({ connId, type, data }) => {
  const tab = tabs.value.find((t) => t.id === connId && t.type === 'ws')
  if (!tab) return
  if (type === 'open') {
    tab.connected = true
  } else if (type === 'message') {
    const raw = data || ''
    // 过滤 broker 心跳空帧（单个 \n）
    if (!raw.trim()) return
    // STOMP 模式：MESSAGE 帧解析为「目的地 + 消息体」展示
    if (tab.wsMode === 'stomp' && raw.startsWith('MESSAGE')) {
      const parsed = parseStompMessage(raw)
      tab.logs.push({
        direction: 'in',
        time: now(),
        data: `STOMP MESSAGE ← ${parsed.destination}\n${parsed.body}`
      })
    } else {
      tab.logs.push({ direction: 'in', time: now(), data: raw })
    }
  } else if (type === 'close') {
    tab.connected = false
    tab.logs.push({ direction: 'system', time: now(), data: '连接已关闭' })
  } else if (type === 'error') {
    tab.logs.push({ direction: 'system', time: now(), data: `错误: ${data}` })
  }
})

// ==================== AI 识别 ====================
const aiDialogVisible = ref(false)
const aiInput = ref('')
const aiParsing = ref(false)

/** 从模型回复中提取 JSON（剥掉 ``` 围栏与思考标签） */
const extractJson = (text: string): unknown => {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('未找到 JSON 内容')
  return JSON.parse(cleaned.slice(start, end + 1))
}

interface RecognizedRequest {
  type?: string
  method?: string
  url?: string
  headers?: Record<string, string>
  bodyType?: string
  body?: string | Record<string, string>
}

/** 校验并归一化 AI 识别结果 */
const normalizeRecognized = (data: unknown): Partial<ApiTab> & { type: ReqType } => {
  const d = (data ?? {}) as RecognizedRequest
  const type: ReqType = d.type === 'websocket' || d.type === 'ws' ? 'ws' : 'http'
  const url = String(d.url ?? '').trim()
  if (!url) throw new Error('缺少 url 字段')
  const preset: Partial<ApiTab> & { type: ReqType } = { type, url }
  if (type !== 'http') return preset

  preset.method = API_METHODS.includes(String(d.method).toUpperCase())
    ? String(d.method).toUpperCase()
    : 'GET'
  preset.headers = Object.entries(d.headers ?? {}).map(([key, value]) => ({ key, value }))
  if (preset.headers.length === 0) preset.headers = [{ key: '', value: '' }]
  if (BODY_METHODS.includes(preset.method)) {
    const bt = d.bodyType === 'form' ? 'form' : d.bodyType === 'raw' ? 'raw' : 'json'
    preset.bodyType = bt
    if (bt === 'json') {
      preset.jsonBody = typeof d.body === 'string' ? d.body : JSON.stringify(d.body ?? {}, null, 2)
    } else if (bt === 'raw') {
      preset.rawBody = typeof d.body === 'string' ? d.body : ''
    } else {
      preset.formItems =
        typeof d.body === 'object' && d.body !== null
          ? Object.entries(d.body).map(([key, value]) => ({ key, value: String(value) }))
          : [{ key: '', value: '' }]
    }
  } else {
    preset.bodyType = 'none'
  }
  return preset
}

/** AI 识别：将粘贴内容解析为请求并新建 Tab；格式不合法自动重试 */
const AI_MAX_RETRY = 20
const recognizeByAi = async (): Promise<void> => {
  if (!aiInput.value.trim()) {
    ElMessage.warning('请粘贴接口内容（文档、cURL、抓包文本等）')
    return
  }
  aiParsing.value = true
  try {
    const system: LlmChatMessage = {
      role: 'system',
      content:
        '你是接口信息提取器。从用户提供的接口文档 / cURL 命令 / 抓包内容中提取一个 HTTP/WebSocket 请求，' +
        '只返回一个 JSON 对象，不要输出任何其他文字。JSON 格式：' +
        '{"type":"http|ws","method":"GET","url":"完整地址","headers":{"名":"值"},"bodyType":"none|json|form|raw","body":{}}。' +
        '只输出一个 JSON 对象，不要输出任何其他文字。格式：' +
        '{"type":"http|ws","method":"GET","url":"完整地址","headers":{"名":"值"},"bodyType":"none|json|form|raw","body":{}}。' +
        'type 为 http 时 url 必须以 http(s):// 开头，body 仅 POST/PUT/PATCH 需要（json 用对象，form 用对象，raw 用字符串），' +
        'GET/DELETE 时 bodyType 为 none；type 为 ws 时 url 以 ws(s):// 开头；无法判断时 type 取 http。'
    }
    const user: LlmChatMessage = { role: 'user', content: aiInput.value }
    let lastErr: unknown = null
    for (let round = 0; round < AI_MAX_RETRY; round++) {
      const result = await sendLlm([system, user], { temperature: 0.2 })
      try {
        const preset = normalizeRecognized(extractJson(result.content))
        createTab(preset.type, preset)
        aiDialogVisible.value = false
        aiInput.value = ''
        ElMessage.success('已根据识别结果创建请求')
        return
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr ?? new Error('识别失败')
  } catch (e) {
    ElMessage.error(`AI 识别失败: ${e}`)
  } finally {
    aiParsing.value = false
  }
}

// ==================== 生命周期 ====================
onMounted(loadAddresses)

onUnmounted(() => {
  unsubscribeChunks()
  unsubscribeWs()
  for (const tab of tabs.value) {
    if (tab.type === 'ws' && tab.connected) void net.wsClose(tab.id)
  }
})

// 默认打开一个 HTTP 请求 Tab
void nextTick(() => {
  if (tabs.value.length === 0) createTab('http')
})
</script>

<template>
  <div class="api-page">
    <!-- 顶栏 -->
    <header class="api-header">
      <div class="api-header-left">
        <BackHome to="Toolbox" />
        <div class="api-header-brand">
          <div class="api-header-badge">
            <img :src="apiTestSvg" alt="接口测试" class="api-header-icon" />
          </div>
          <span class="api-header-title">接口测试</span>
        </div>
      </div>
      <div class="api-header-actions">
        <el-dropdown trigger="click" @command="(type: ReqType) => createTab(type)">
          <el-button type="primary" :icon="Plus">新建请求</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="http">HTTP 请求</el-dropdown-item>
              <el-dropdown-item command="ws">WebSocket</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button :icon="MagicStick" @click="aiDialogVisible = true">AI 识别</el-button>
        <el-button :icon="Collection" @click="openSaveDialog">保存</el-button>
      </div>
    </header>

    <div class="api-body">
      <!-- 左侧地址列表：整体合拢/展开（默认合上），展开时占满高度，宽度可拖拽 -->
      <aside
        class="addr-side"
        :class="{ closed: !addrOpen }"
        :style="{ width: addrOpen ? `${addrWidth}px` : '36px' }"
      >
        <div class="addr-side-header" @click="addrOpen = !addrOpen">
          <el-icon :size="16">
            <Expand v-if="!addrOpen" />
            <Fold v-else />
          </el-icon>
          <span v-if="addrOpen" class="addr-side-title"
            >地址列表（{{ savedAddresses.length }}）</span
          >
        </div>
        <div v-if="addrOpen" class="addr-list">
          <el-empty
            v-if="savedAddresses.length === 0"
            description="发送或保存请求后自动记录"
            :image-size="50"
          />
          <!-- 未分类地址 -->
          <div
            v-for="addr in groupedAddresses.root"
            :key="addr.id"
            class="addr-item"
            @click="openAddress(addr)"
          >
            <span class="addr-type" :class="addr.type">{{
              addr.type === 'http' ? 'HTTP' : addr.type.toUpperCase()
            }}</span>
            <span class="addr-name" :title="addr.url">{{ addr.name }}</span>
            <span v-if="addr.category" class="addr-category" :title="addr.category">{{
              addr.category
            }}</span>
            <el-icon class="addr-del" @click.stop="removeAddress(addr)"><Delete /></el-icon>
          </div>

          <!-- 分类文件夹 -->
          <div v-for="folder in groupedAddresses.folders" :key="folder.name" class="addr-folder">
            <div class="addr-folder-row" @click="toggleFolder(folder.name)">
              <el-icon
                :size="12"
                class="folder-arrow"
                :class="{ open: expandedFolders[folder.name] }"
              >
                <ArrowRight />
              </el-icon>
              <span class="folder-name" :title="folder.name">{{ folder.name }}</span>
              <span class="folder-count">{{ folder.items.length }}</span>
            </div>
            <template v-if="expandedFolders[folder.name]">
              <div
                v-for="addr in folder.items"
                :key="addr.id"
                class="addr-item"
                @click="openAddress(addr)"
              >
                <span class="addr-type" :class="addr.type">{{
                  addr.type === 'http' ? 'HTTP' : addr.type.toUpperCase()
                }}</span>
                <span class="addr-name" :title="addr.url">{{ addr.name }}</span>
                <el-icon class="addr-del" @click.stop="removeAddress(addr)"><Delete /></el-icon>
              </div>
            </template>
          </div>
        </div>
      </aside>

      <!-- 侧栏拖拽手柄（合拢时隐藏） -->
      <div v-if="addrOpen" class="addr-resizer" @mousedown="startResize"></div>

      <!-- 右侧多标签请求区 -->
      <main class="api-main">
        <el-tabs
          v-if="tabs.length > 0"
          v-model="activeTabId"
          type="card"
          class="api-tabs"
          closable
          @tab-remove="(id) => closeTab(tabs.find((t) => t.id === id)!)"
        >
          <el-tab-pane v-for="tab in tabs" :key="tab.id" :name="tab.id">
            <template #label>
              <span class="tab-label" :title="tabLabel(tab)">{{ tabLabel(tab) }}</span>
            </template>

            <!-- ==================== HTTP ==================== -->
            <div v-if="tab.type === 'http'" class="http-pane">
              <!-- 请求行：方法 + 地址 + 发送 -->
              <div class="request-line">
                <el-select v-model="tab.method" class="method-select">
                  <el-option v-for="m in API_METHODS" :key="m" :label="m" :value="m" />
                </el-select>
                <el-input
                  v-model="tab.url"
                  placeholder="请求地址，如 https://api.example.com/users"
                  clearable
                >
                  <template #prefix
                    ><el-icon><Link /></el-icon
                  ></template>
                </el-input>
                <el-button
                  type="primary"
                  :icon="Promotion"
                  :loading="tab.sending"
                  @click="sendHttp(tab)"
                >
                  发送
                </el-button>
              </div>

              <!-- 请求头入口：弹框维护 -->
              <div class="headers-link-row">
                <el-button link type="primary" @click="headerDialogVisible = true">
                  {{ headerNames(tab) ? `添加请求头（${headerNames(tab)}）` : '添加请求头' }}
                </el-button>
              </div>

              <!-- 请求体 / 响应体 4:6 分栏 -->
              <div class="http-split">
                <!-- 请求体：默认不发送（无）；GET/DELETE 以查询串拼接在地址后 -->
                <section class="split-left">
                  <div class="split-title">
                    请求体
                    <el-button
                      v-if="tab.bodyType === 'json'"
                      link
                      type="primary"
                      class="beautify-link"
                      :loading="beautifyingBody"
                      @click="beautifyBody"
                    >
                      美化
                    </el-button>
                  </div>
                  <el-tabs v-model="tab.bodyType" class="mini-tabs">
                    <el-tab-pane label="JSON" name="json">
                      <el-input
                        v-model="tab.jsonBody"
                        type="textarea"
                        class="fill-editor"
                        placeholder="请求体内容（JSON）"
                      />
                    </el-tab-pane>
                    <el-tab-pane label="表单" name="form">
                      <div class="form-editor">
                        <div v-for="(f, i) in tab.formItems" :key="i" class="kv-row">
                          <el-input v-model="f.key" placeholder="字段名" />
                          <el-input v-model="f.value" placeholder="值" />
                          <el-button
                            v-if="tab.formItems.length > 1"
                            circle
                            size="small"
                            @click="tab.formItems.splice(i, 1)"
                            >×</el-button
                          >
                        </div>
                        <el-button size="small" @click="tab.formItems.push({ key: '', value: '' })"
                          >添加字段</el-button
                        >
                      </div>
                    </el-tab-pane>
                    <el-tab-pane label="文本" name="raw">
                      <el-input
                        v-model="tab.rawBody"
                        type="textarea"
                        class="fill-editor"
                        placeholder="原始文本内容"
                      />
                    </el-tab-pane>
                  </el-tabs>
                  <div v-if="tab.bodyType === 'none'" class="body-tip body-tip-fill">
                    {{
                      BODY_METHODS.includes(tab.method)
                        ? '默认不发送请求体，可切换上方类型填写'
                        : '默认不发送；表单/文本将拼接在地址后'
                    }}
                  </div>
                </section>

                <!-- 响应体 -->
                <section class="split-right">
                  <div class="split-title">
                    响应
                    <template v-if="tab.result">
                      <el-tag size="small" :type="tab.result.status < 400 ? 'success' : 'danger'">
                        {{ tab.result.status }} {{ tab.result.statusText }}
                      </el-tag>
                      <el-tag size="small" type="info">{{ tab.result.elapsed }} ms</el-tag>
                      <el-tag v-if="tab.result.isSse" size="small" type="warning">SSE</el-tag>
                    </template>
                  </div>
                  <el-empty
                    v-if="!tab.result"
                    description="点击「发送」查看响应"
                    :image-size="70"
                  />
                  <el-tabs v-else v-model="tab.respTab" class="mini-tabs">
                    <el-tab-pane label="正文" name="body">
                      <pre v-if="!tab.result.isSse" class="response-body">{{
                        tab.result.body || '（空响应）'
                      }}</pre>
                      <pre v-else class="response-body sse">{{
                        tab.result.sseText || '（等待事件推送...）'
                      }}</pre>
                    </el-tab-pane>
                    <el-tab-pane label="响应头" name="headers">
                      <div class="resp-headers">
                        <div class="resp-headers-group">
                          <div class="resp-headers-title">请求头</div>
                          <pre class="response-headers">{{
                            JSON.stringify(buildHeaders(tab), null, 2)
                          }}</pre>
                        </div>
                        <div class="resp-headers-group">
                          <div class="resp-headers-title">响应头</div>
                          <pre class="response-headers">{{
                            JSON.stringify(tab.result.headers, null, 2)
                          }}</pre>
                        </div>
                      </div>
                    </el-tab-pane>
                  </el-tabs>
                </section>
              </div>
            </div>

            <!-- ==================== WebSocket ==================== -->
            <div v-else-if="tab.type === 'ws'" class="io-pane">
              <div class="request-line">
                <el-select v-model="tab.wsMode" class="ws-mode-select">
                  <el-option label="原始" value="raw" />
                  <el-option label="STOMP" value="stomp" />
                </el-select>
                <el-input v-model="tab.target" placeholder="ws:// 或 wss:// 地址">
                  <template #prefix
                    ><el-icon><SetUp /></el-icon
                  ></template>
                </el-input>
                <el-button
                  v-if="!tab.connected"
                  type="primary"
                  :loading="tab.connecting"
                  @click="connectWs(tab)"
                >
                  连接
                </el-button>
                <el-button v-else type="danger" @click="disconnectWs(tab)">断开</el-button>
                <el-tag :type="tab.connected ? 'success' : 'info'">
                  {{ tab.connected ? '已连接' : '未连接' }}
                </el-tag>
              </div>
              <!-- STOMP 模式：发送目的地 + 订阅目的地模板 -->
              <div v-if="tab.wsMode === 'stomp'" class="stomp-dest-row">
                <el-input v-model="tab.stompDest" placeholder="SEND 目的地，如 /app/ai/chat">
                  <template #prefix><span class="input-prefix-label">SEND</span></template>
                </el-input>
                <el-input
                  v-model="tab.stompSubDest"
                  placeholder="订阅目的地，支持 {字段} 变量，如 /topic/ai/chat/{sessionId}"
                >
                  <template #prefix><span class="input-prefix-label">SUB</span></template>
                </el-input>
                <el-button :disabled="!tab.connected" @click="stompManualSubscribe(tab)"
                  >订阅</el-button
                >
              </div>
              <div class="io-area">
                <div :ref="(el) => setLogRef(tab.id, el)" class="log-area">
                  <el-button
                    link
                    size="small"
                    class="log-clear-btn"
                    :disabled="tab.logs.length === 0"
                    @click="tab.logs = []"
                  >
                    清屏
                  </el-button>
                  <div
                    v-for="(log, i) in tab.logs"
                    :key="i"
                    class="log-item"
                    :class="log.direction"
                  >
                    <span class="log-time">{{ log.time }}</span>
                    <span class="log-dir">{{
                      log.direction === 'out'
                        ? '→ 发送'
                        : log.direction === 'in'
                          ? '← 收到'
                          : '系统'
                    }}</span>
                    <span class="log-data">{{ log.data }}</span>
                  </div>
                  <el-empty v-if="tab.logs.length === 0" description="暂无消息" :image-size="60" />
                </div>
                <div class="send-row">
                  <el-input
                    v-model="tab.input"
                    type="textarea"
                    :rows="6"
                    class="ws-send-input"
                    placeholder="输入要发送的消息（回车发送，Shift+回车换行）"
                    :disabled="!tab.connected"
                    @keydown.enter="onWsInputKeydown($event, tab)"
                  />
                  <el-button type="primary" :disabled="!tab.connected" @click="sendWsMessage(tab)"
                    >发送</el-button
                  >
                </div>
              </div>
            </div>
          </el-tab-pane>
        </el-tabs>
      </main>
    </div>

    <!-- 请求头弹框 -->
    <el-dialog v-model="headerDialogVisible" title="请求头" width="560px" append-to-body>
      <template v-if="activeTab && activeTab.type === 'http'">
        <div v-for="(h, i) in activeTab.headers" :key="i" class="kv-row">
          <el-input v-model="h.key" placeholder="Header 名称" />
          <el-input v-model="h.value" placeholder="值" />
          <el-button
            v-if="activeTab.headers.length > 1"
            circle
            size="small"
            @click="activeTab.headers.splice(i, 1)"
            >×</el-button
          >
        </div>
        <el-button size="small" @click="activeTab.headers.push({ key: '', value: '' })"
          >添加请求头</el-button
        >
      </template>
      <template #footer>
        <el-button @click="headerDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="headerDialogVisible = false">确认</el-button>
      </template>
    </el-dialog>

    <!-- 保存到地址列表弹框 -->
    <el-dialog v-model="saveDialogVisible" title="保存到地址列表" width="480px" append-to-body>
      <el-form label-width="60px">
        <el-form-item label="名称" required>
          <el-input v-model="saveForm.name" placeholder="接口名称" />
        </el-form-item>
        <el-form-item label="地址">
          <el-input v-model="saveForm.url" disabled />
        </el-form-item>
        <el-form-item label="类别">
          <el-select
            v-model="saveForm.category"
            placeholder="选择或输入类别（可留空）"
            clearable
            filterable
            allow-create
            default-first-option
            style="width: 100%"
          >
            <el-option v-for="c in existingCategories" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="saveDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmSave">确认</el-button>
      </template>
    </el-dialog>

    <!-- AI 识别弹框 -->
    <el-dialog v-model="aiDialogVisible" title="AI 识别接口" width="640px" append-to-body>
      <el-input
        v-model="aiInput"
        type="textarea"
        :rows="10"
        placeholder="粘贴接口文档、cURL 命令或抓包内容，AI 将自动识别地址、方法、请求头与参数并创建请求"
      />
      <template #footer>
        <el-button @click="aiDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="aiParsing" @click="recognizeByAi">识别并创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.api-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
}

.api-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: var(--color-card);
  border-bottom: 1px solid var(--color-border);
  /* 语义色底部渐变线 */
  box-shadow: inset 0 -2px 0 0 var(--color-success);
}

.api-header-left {
  display: flex;
  align-items: center;
  gap: 16px;
  color: var(--color-text);
}

.api-header-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.api-header-badge {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.api-header-icon {
  width: 25px;
  height: 25px;
}

.api-header-title {
  font-size: 16px;
  font-weight: 600;
}

.api-header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 主体：左侧地址列表 + 右侧标签区 */
.api-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.addr-side {
  flex-shrink: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-card);
  border-right: 1px solid var(--color-border);
  transition: width 0.2s ease;
  overflow: hidden;
}

.addr-side.closed {
  border-right: 1px solid var(--color-border);
}

/* 侧栏头部：整体展开/合拢开关 */
.addr-side-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 40px;
  padding: 0 10px;
  cursor: pointer;
  color: var(--color-text);
  white-space: nowrap;
  border-bottom: 1px solid var(--color-border);
}

.addr-side-header:hover {
  color: var(--color-primary);
}

.addr-side-title {
  font-size: 13px;
  font-weight: 600;
}

/* 地址列表占满侧栏剩余区域 */
.addr-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

/* 侧栏拖拽手柄 */
.addr-resizer {
  flex-shrink: 0;
  width: 4px;
  cursor: col-resize;
  background: var(--color-border);
  transition: background 0.2s ease;
}

.addr-resizer:hover {
  background: var(--color-primary);
}

.addr-category {
  flex-shrink: 0;
  max-width: 56px;
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 4px;
  color: var(--color-text-secondary);
  background: var(--color-hover);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 分类文件夹 */
.addr-folder-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  cursor: pointer;
  transition: background 0.2s ease;
}

.addr-folder-row:hover {
  background: var(--color-hover);
}

.folder-arrow {
  color: var(--color-text-secondary);
  transition: transform 0.2s ease;
}

.folder-arrow.open {
  transform: rotate(90deg);
}

.folder-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.folder-count {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--color-text-secondary);
  background: var(--color-hover);
  border-radius: 8px;
  padding: 0 6px;
}

/* 文件夹内地址缩进 */
.addr-folder .addr-item {
  padding-left: 26px;
}

.addr-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  cursor: pointer;
  transition: background 0.2s ease;
}

.addr-item:hover {
  background: var(--color-hover);
}

.addr-type {
  flex-shrink: 0;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  color: #fff;
  background: var(--color-primary);
}

.addr-type.ws {
  background: var(--color-success);
}

.addr-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.addr-del {
  flex-shrink: 0;
  color: var(--color-danger);
  opacity: 0;
  transition: opacity 0.2s ease;
}

.addr-item:hover .addr-del {
  opacity: 1;
}

.api-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 8px;
}

.api-tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.api-tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.api-tabs :deep(.el-tab-pane) {
  height: 100%;
}

.tab-label {
  max-width: 180px;
  display: inline-block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
}

/* 请求行：方法 + 地址 + 按钮 */
.request-line {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
}

.method-select {
  width: 110px;
  min-width: 110px;
  flex-shrink: 0;
}

.method-select :deep(.el-input__inner) {
  text-align: center;
}

/* WS 协议模式下拉框（同请求方法样式） */
.ws-mode-select {
  width: 100px;
  min-width: 100px;
  flex-shrink: 0;
}

/* 输入框前缀 label 与输入内容保持距离 */
.input-prefix-label {
  margin-right: 8px;
}

/* STOMP 目的地行：SEND 与 SUB 并排 */
.stomp-dest-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
}

.stomp-dest-row .el-input {
  flex: 1;
}

/* 消息日志区清屏按钮（右上角悬浮） */
.log-area {
  position: relative;
}

/* WS 发送输入框：更高且可拖拽调整高度 */
.ws-send-input :deep(.el-textarea__inner) {
  resize: vertical;
  min-height: 140px;
  font-family: Consolas, monospace;
}

.log-clear-btn {
  position: absolute;
  top: 8px;
  right: 10px;
  z-index: 1;
}

/* 请求头入口链接 */
.headers-link-row {
  margin-bottom: 8px;
}

/* HTTP 4:6 分栏 */
.http-pane {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.http-split {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
}

.split-left {
  flex: 0 0 40%;
  max-width: 40%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-card);
  overflow: hidden;
}

.split-right {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-card);
  overflow: hidden;
}

.split-title {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  border-bottom: 1px solid var(--color-border);
}

.split-left :deep(.el-tabs),
.split-right :deep(.el-tabs) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.split-left :deep(.el-tabs__content),
.split-right :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px 12px;
}

.mini-tabs :deep(.el-tabs__header) {
  margin-bottom: 0;
  padding: 0 12px;
}

.fill-editor {
  height: 100%;
}

.fill-editor :deep(.el-textarea__inner) {
  height: 100%;
  resize: none;
  font-family: Consolas, monospace;
}

.form-editor .kv-row {
  margin-bottom: 8px;
}

.body-tip {
  color: var(--color-text-secondary);
  font-size: 13px;
}

/* 请求体默认（无）提示占满内容区 */
.body-tip-fill {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 12px;
}

/* 响应展示 */
.response-body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  padding: 12px;
  border-radius: 8px;
  font-size: 13px;
  height: 100%;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.response-body.sse {
  color: var(--color-success);
}

.resp-headers {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.resp-headers-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
  margin-bottom: 4px;
}

.response-headers {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 10px;
}

/* 键值对编辑行 */
.kv-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  align-items: center;
}

/* 请求体标题行：美化链接靠右 */
.split-title .beautify-link {
  margin-left: auto;
}

/* WS 收发区 */
.io-pane {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.io-area {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.log-area {
  flex: 1;
  min-height: 0;
  background: var(--color-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 12px;
  overflow-y: auto;
  font-size: 13px;
}

.log-item {
  display: flex;
  gap: 8px;
  margin-bottom: 6px;
  font-family: Consolas, monospace;
}

.log-time {
  color: var(--color-text-secondary);
}

.log-item.out .log-dir {
  color: var(--color-primary);
}

.log-item.in .log-dir {
  color: var(--color-success);
}

.log-item.system .log-dir {
  color: var(--color-warning);
}

.log-data {
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-all;
}

.send-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
</style>
