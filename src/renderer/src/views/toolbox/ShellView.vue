<script setup lang="ts">
/**
 * Shell 窗口页面（独立 BrowserWindow 加载）
 *
 * 布局：左侧可收起的连接管理侧栏 + 中间多标签终端 + 右侧可伸缩 AI 面板
 *
 * 功能：
 * - 连接管理：新建/编辑/删除远程连接（服务名称、测试连接），持久化到应用数据目录 cache/shell.json
 * - 多标签终端：远程 SSH / 本地 PowerShell，每个 Tab 一个连接
 * - SFTP 文件传输：上方本地目录、下方远程目录双栏浏览，直观上传/下载
 * - AI 面板：读取终端内容分析、AI 生成命令一键执行
 */
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Monitor,
  Connection,
  Folder,
  FolderOpened,
  MagicStick,
  Plus,
  ArrowLeft,
  ArrowRight,
  Edit,
  Delete,
  Refresh,
  Upload,
  Download,
  FolderAdd,
  Star
} from '@element-plus/icons-vue'
import TerminalPane from '../../components/toolbox/TerminalPane.vue'
import AiAssistant from '../../components/AiAssistant.vue'
import type { AiTool } from '../../composables/prompt'
import { getAppPath } from '../../utils/config'

const toolbox = window.dot.toolbox

// ==================== 连接持久化（cache/shell.json） ====================

/** 已保存的远程连接配置 */
interface SavedConnection {
  id: string
  /** 服务名称 */
  name: string
  host: string
  port: number
  username: string
  password: string
  /** 分类名称：空/缺省时不分组直接展示 */
  category?: string
  /** SFTP 上次浏览的目录（连接 + 目录地址记忆） */
  lastRemoteDir?: string
  lastLocalDir?: string
}

/** 连接缓存文件相对路径（基于应用数据目录） */
const SHELL_CACHE_FILE = 'cache/shell.json'

/** 应用数据目录（ getAppPath 缓存） */
let appBasePath = ''
/** 已保存连接列表 */
const savedConnections = ref<SavedConnection[]>([])

/** 获取缓存文件完整路径 */
const shellCachePath = (): string => `${appBasePath}/${SHELL_CACHE_FILE}`

/** 从 cache/shell.json 加载连接列表 */
const loadConnections = async (): Promise<void> => {
  const t0 = performance.now()
  appBasePath = await getAppPath()
  console.log('加载时shell地址', shellCachePath())
  const content = (await window.dot.localFiles('read', shellCachePath())) as string
  if (!content) return
  try {
    const data = JSON.parse(content)
    savedConnections.value = Array.isArray(data.connections) ? data.connections : []
    dirBookmarks.value = Array.isArray(data.bookmarks) ? data.bookmarks : []
  } catch {
    // 缓存文件损坏时忽略，保持空列表
  }
  console.log(`[ShellView] loadConnections 总耗时: ${(performance.now() - t0).toFixed(2)}ms`)
}

/** 将连接列表与常用目录标签写回 cache/shell.json */
const persistConnections = async (): Promise<void> => {
  await window.dot.localFiles(
    'write',
    shellCachePath(),
    JSON.stringify({ connections: savedConnections.value, bookmarks: dirBookmarks.value }, null, 2)
  )
}

// ==================== 终端会话管理 ====================
interface ShellTab {
  sessionId: string
  title: string
  type: 'ssh' | 'local'
  /** 关联的已保存连接 ID（远程会话） */
  connectionId?: string
  /** SSH 连接参数快照（用于右键重新连接，不依赖已保存连接是否被删除） */
  ssh?: { host: string; port: number; username: string; password: string }
}

const tabs = ref<ShellTab[]>([])
const activeSessionId = ref('')
/** 各终端面板实例（key 为会话 ID），用于 AI 读取终端内容、写入命令 */
const paneRefs = new Map<string, InstanceType<typeof TerminalPane>>()

/** 收集终端面板实例引用 */
const setPaneRef =
  (sessionId: string) =>
  (el: unknown): void => {
    if (el) {
      paneRefs.set(sessionId, el as InstanceType<typeof TerminalPane>)
    } else {
      paneRefs.delete(sessionId)
    }
  }

/** 当前激活的终端面板 */
const activePane = computed(() => paneRefs.get(activeSessionId.value) || null)

/** 关闭终端 Tab：断开会话并移除 */
const removeTab = async (sessionId: string): Promise<void> => {
  await toolbox.shell.close(sessionId)
  const idx = tabs.value.findIndex((t) => t.sessionId === sessionId)
  if (idx === -1) return
  tabs.value.splice(idx, 1)
  paneRefs.delete(sessionId)
  // 若关闭的是当前 Tab，切换到相邻 Tab
  activeSessionId.value = tabs.value[Math.min(idx, tabs.value.length - 1)]?.sessionId ?? ''
}

/** 建立 SSH 会话并打开 Tab */
const openSshTab = async (
  ssh: { host: string; port: number; username: string; password: string },
  connectionId?: string,
  title?: string
): Promise<void> => {
  const { sessionId, title: defaultTitle } = await toolbox.shell.create({ type: 'ssh', ssh })
  tabs.value.push({ sessionId, title: title || defaultTitle, type: 'ssh', connectionId, ssh })
  activeSessionId.value = sessionId
}

/** 建立本地 PowerShell 会话并打开 Tab */
const openLocalTab = async (): Promise<void> => {
  const { sessionId, title } = await toolbox.shell.create({ type: 'local' })
  tabs.value.push({ sessionId, title, type: 'local' })
  activeSessionId.value = sessionId
}

// ==================== 新建 / 编辑连接 ====================
const connectDialogVisible = ref(false)
/** 弹窗模式：新建 / 编辑 */
const dialogMode = ref<'create' | 'edit'>('create')
/** 正在编辑的连接 ID */
const editingId = ref('')
const connectForm = ref({
  name: '',
  host: '',
  /** 端口为字符串输入，提交时转换 */
  port: '22',
  username: 'root',
  password: '',
  category: ''
})
const connecting = ref(false)
/** 测试连接状态 */
const testing = ref(false)
const testResult = ref<{ success: boolean; message: string } | null>(null)

/** 打开新建连接弹窗 */
const openConnectDialog = (): void => {
  dialogMode.value = 'create'
  editingId.value = ''
  connectForm.value = {
    name: '',
    host: '',
    port: '22',
    username: 'root',
    password: '',
    category: ''
  }
  testResult.value = null
  connectDialogVisible.value = true
}

/** 打开编辑连接弹窗 */
const openEditDialog = (conn: SavedConnection): void => {
  dialogMode.value = 'edit'
  editingId.value = conn.id
  connectForm.value = {
    name: conn.name,
    host: conn.host,
    port: String(conn.port),
    username: conn.username,
    password: conn.password,
    category: conn.category ?? ''
  }
  testResult.value = null
  connectDialogVisible.value = true
}

/** 解析端口输入（非法或超范围返回 null） */
const parsePort = (): number | null => {
  const port = Number(connectForm.value.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return port
}

/** 表单校验，返回错误提示 */
const validateForm = (): string | null => {
  const f = connectForm.value
  if (!f.name.trim()) return '请填写服务名称'
  if (!f.host.trim()) return '请填写主机地址'
  if (!f.username.trim()) return '请填写用户名'
  if (!parsePort()) return '端口必须是 1-65535 的整数'
  return null
}

/** 测试连接：只验证连通性，不建立会话 */
const testConnection = async (): Promise<void> => {
  const error = validateForm()
  if (error) {
    ElMessage.warning(error)
    return
  }
  testing.value = true
  testResult.value = null
  try {
    const f = connectForm.value
    testResult.value = await toolbox.sshTest({
      host: f.host.trim(),
      port: parsePort()!,
      username: f.username.trim(),
      password: f.password
    })
  } catch (e) {
    testResult.value = { success: false, message: String(e) }
  } finally {
    testing.value = false
  }
}

/** 保存连接（新建或更新），可选立即连接 */
const saveConnection = async (connect: boolean): Promise<void> => {
  const error = validateForm()
  if (error) {
    ElMessage.warning(error)
    return
  }

  const f = connectForm.value
  const port = parsePort()!
  // 分类为空时不存该字段（连接直接平铺展示）
  const category = f.category.trim() || undefined
  if (dialogMode.value === 'create') {
    // 新建：名称不能与已有连接重复
    if (savedConnections.value.some((c) => c.name === f.name.trim())) {
      ElMessage.warning('已存在同名服务，请更换名称')
      return
    }
    const conn: SavedConnection = {
      id: `conn-${Date.now()}`,
      name: f.name.trim(),
      host: f.host.trim(),
      port,
      username: f.username.trim(),
      password: f.password,
      category
    }
    savedConnections.value.push(conn)
    await persistConnections()
    connectDialogVisible.value = false
    if (connect) await connectSaved(conn)
  } else {
    // 编辑：更新已有配置
    const conn = savedConnections.value.find((c) => c.id === editingId.value)
    if (conn) {
      Object.assign(conn, {
        name: f.name.trim(),
        host: f.host.trim(),
        port,
        username: f.username.trim(),
        password: f.password,
        category
      })
      await persistConnections()
    }
    connectDialogVisible.value = false
  }
}

/** 点击已保存连接：建立 SSH 会话 */
const connectSaved = async (conn: SavedConnection): Promise<void> => {
  connecting.value = true
  try {
    await openSshTab(
      { host: conn.host, port: conn.port, username: conn.username, password: conn.password },
      conn.id,
      conn.name
    )
  } catch (e) {
    ElMessage.error(`连接 ${conn.name} 失败: ${e}`)
  } finally {
    connecting.value = false
  }
}

/** 删除已保存连接 */
const deleteConnection = async (conn: SavedConnection): Promise<void> => {
  try {
    await ElMessageBox.confirm(`确定删除连接「${conn.name}」吗？`, '删除确认', { type: 'warning' })
    savedConnections.value = savedConnections.value.filter((c) => c.id !== conn.id)
    await persistConnections()
  } catch {
    // 用户取消
  }
}

// ==================== 侧栏收起 ====================
const sidebarCollapsed = ref(false)

// ==================== 连接分类分组 ====================
/** 连接按分类分组：无分类的直接平铺，有分类的归入对应组（组内按名称排序） */
const groupedConnections = computed(() => {
  const plain: SavedConnection[] = []
  const groups = new Map<string, SavedConnection[]>()
  for (const c of savedConnections.value) {
    const cat = c.category?.trim()
    if (!cat) plain.push(c)
    else {
      if (!groups.has(cat)) groups.set(cat, [])
      groups.get(cat)!.push(c)
    }
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name))
  }
  return { plain, groups: [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])) }
})

/** 分类展开状态（对象而非 Set：Vue ref 对 Set 变更不触发响应） */
const groupExpanded = ref<Record<string, boolean>>({})

/** 已有分类列表（供新建/编辑弹窗自动补全） */
const categorySuggestions = computed(() =>
  [...new Set(savedConnections.value.map((c) => c.category?.trim()).filter(Boolean))].map(
    (name) => ({ value: name as string })
  )
)

const toggleGroup = (cat: string): void => {
  // 未记录过的分类默认视为展开（与模板 !== false 一致），首次点击应收起而不是保持展开
  groupExpanded.value = { ...groupExpanded.value, [cat]: !(groupExpanded.value[cat] !== false) }
}

/** 分类输入自动补全：按输入过滤已有分类，也允许输入新分类 */
const queryCategory = (queryString: string, cb: (list: { value: string }[]) => void): void => {
  const q = queryString.trim().toLowerCase()
  const all = categorySuggestions.value
  cb(q ? all.filter((s) => s.value.toLowerCase().includes(q)) : all)
}

/** 右键菜单：复制连接命令（ssh -p 端口 用户名@主机，剪贴板） */
const copyTabLink = async (sessionId: string): Promise<void> => {
  const tab = tabs.value.find((t) => t.sessionId === sessionId)
  if (!tab || tab.type !== 'ssh' || !tab.ssh) return
  const cmd = `ssh -p ${tab.ssh.port} ${tab.ssh.username}@${tab.ssh.host}`
  await navigator.clipboard.writeText(cmd)
  ElMessage.success('已复制连接命令')
}

/** 右键菜单：重新连接（新建同参数会话并替换当前 Tab 的会话） */
const reconnectTab = async (sessionId: string): Promise<void> => {
  const tab = tabs.value.find((t) => t.sessionId === sessionId)
  if (!tab) return
  try {
    // tab.ssh 是 reactive 代理，直接传 IPC 会报「An object could not be cloned」，
    // 深拷贝为纯对象后再传递
    const opts =
      tab.type === 'ssh' && tab.ssh
        ? ({ type: 'ssh', ssh: JSON.parse(JSON.stringify(tab.ssh)) } as const)
        : ({ type: 'local' } as const)
    const { sessionId: newId } = await toolbox.shell.create(opts)
    try {
      await toolbox.shell.close(sessionId)
    } catch {
      // 旧会话可能已退出，忽略
    }
    tab.sessionId = newId
    activeSessionId.value = newId
  } catch (e) {
    ElMessage.error(`重新连接失败: ${e}`)
  }
}

// ==================== AI 危险命令白名单（会话级） ====================
/** 当前会话的白名单路径：命中白名单的高危命令可直接执行，无需每次确认 */
const whitelist = ref<string[]>([])

/**
 * 高危命令关键字（删除 / 格式化 / 清空 / 覆盖等破坏性操作，Linux + PowerShell）。
 * 锚定命令位置：仅匹配命令起始或 ; && || | 换行等分隔符之后的首个词，
 * 避免参数 / 文件名 / echo 文本中的关键字误伤（如 ls、echo rm）。
 */
const DANGEROUS_RE =
  /(?:^|[;&|]\s*|\n\s*)(?:"(?:rm|del)"|(?:rm|rmdir|del|rd|erase|format|mkfs(?:\.\w+)?|dd|truncate|shred|remove-item|ri|clear-recyclebin|fdisk|diskpart|cipher\s+\/w))\b/i

/** 覆盖重定向（> 覆盖已有文件属于破坏性操作；>> 追加不算） */
const OVERWRITE_RE = /(^|[\s;])>(?!>)\s*\S/

/** 交互式确认提示（rm -i / cp -i / overwrite? 等，等待用户输入 y） */
const INTERACTIVE_PROMPT_RE = /(?:\?|？|\[y\/n\]|\(y\/n\)|y\/n\?|overwrite)\s*$/i

/** 提取命令中的绝对 / 相对路径片段（用于白名单匹配与登记） */
const extractPaths = (command: string): string[] => {
  const paths =
    command.match(/(?:[A-Za-z]:)?[\\/][^\s'"<>|; &()]+|\.{0,2}\/[^\s'"<>|; &()]+/g) ?? []
  return paths.map((p) => p.replace(/["']$/, '').replace(/[\\/]+$/, ''))
}

/** 取路径所在目录（白名单按目录粒度登记：删除某文件后，同目录其他文件操作也免确认） */
const parentDirOf = (path: string): string | null => {
  const p = path.replace(/[\\/]+$/, '')
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (idx <= 0) {
    // 无分隔符（相对路径文件名）或已是根目录：无法/无需再取上级
    return idx === 0 ? p.slice(0, 1) : null
  }
  return p.slice(0, idx)
}

/** 命令是否命中白名单（命令引用的任一路径在白名单内，或与白名单路径同前缀） */
const hitWhitelist = (command: string): boolean => {
  if (whitelist.value.length === 0) return false
  const paths = extractPaths(command)
  if (paths.length === 0) return false
  return paths.some((p) =>
    whitelist.value.some((w) => p === w || p.startsWith(w + '/') || p.startsWith(w + '\\'))
  )
}

/**
 * 高危命令执行前确认（双保险：提示词约束模型，此处运行时兜底拦截）。
 * 确认卡片展示在 AI 助手气泡内（不弹框），由用户点击按钮选择：
 * 「执行并加入白名单」/「仅本次执行」/「取消」。
 * @returns true 放行执行；false 用户取消
 */
const confirmDangerousCommand = async (command: string): Promise<boolean> => {
  const dangerous = DANGEROUS_RE.test(command) || OVERWRITE_RE.test(command)
  if (!dangerous || hitWhitelist(command)) return true
  const action = await aiRef.value?.requestConfirm(
    `AI 请求执行高危命令，请确认是否允许：\n${command}`,
    ['执行并加入白名单', '仅本次执行', '取消']
  )
  if (action === '执行并加入白名单') {
    // 把命令中路径的「所在目录」加入会话白名单（目录粒度：同目录后续操作免确认）
    const dirs = [
      ...new Set(
        extractPaths(command)
          .map(parentDirOf)
          .filter((d): d is string => !!d)
      )
    ]
    if (dirs.length > 0) {
      whitelist.value = [...new Set([...whitelist.value, ...dirs])]
      ElMessage.success(`已将目录加入本会话白名单：${dirs.join('、')}`)
    } else {
      ElMessage.warning('未能从命令中识别路径，本次执行后将不再提示该命令')
    }
    return true
  }
  return action === '仅本次执行'
}

/**
 * 提供给 AI 系统提示词的动态内容：
 * - 当前终端系统类型（本地 Windows PowerShell / SSH 远程），模型无需再自行判断
 * - 高危命令白名单路径（会话级）
 */
const sceneExtra = computed(() => {
  const tab = tabs.value.find((t) => t.sessionId === activeSessionId.value)
  const osText = !tab
    ? ''
    : tab.type === 'local'
      ? '当前连接：本地 Windows PowerShell（命令使用 Windows / PowerShell 语法）'
      : `当前连接：SSH 远程（通常为 Linux，命令使用 bash 语法）`
  return [osText, whitelist.value.length ? `白名单路径：${whitelist.value.join('、')}` : '']
    .filter(Boolean)
    .join('；')
})

// ==================== AI 面板 ====================
const aiVisible = ref(false)
const aiRef = ref<InstanceType<typeof AiAssistant>>()

/** AI 读取当前终端最近输出 */
const getTerminalContext = (): string => {
  return activePane.value?.getRecentContent() ?? ''
}

/**
 * 命令文本转 PTY 输入：换行统一为 \r（回车）。
 * PSReadLine 把 \n 当 Shift+Enter（续行，显示 >> 不执行），\r 才是回车执行；
 * 多行命令逐行转为回车，避免 PowerShell 停在续行提示符。
 */
const toPtyInput = (text: string): string => text.replace(/\r?\n/g, '\r')

/** AI 命令写入当前终端并执行（附加回车符触发执行） */
const executeTerminalCommand = (code: string): void => {
  if (!activeSessionId.value) {
    throw new Error('没有激活的终端')
  }
  toolbox.shell.write(activeSessionId.value, toPtyInput(code) + '\r')
}

/**
 * 在终端执行命令并等待输出完成，供 AI 工具获取真实执行结果。
 * 原理：记录执行前缓冲区行数，轮询缓冲区——
 * - 行数不再增长且出现新的提示符（PS> / $ / # 等）→ 命令执行完毕，返回新增内容
 * - 出现交互式确认提示（rm -i 的 y/N 等）→ 自动应答 y（AI 命令已经过确认卡片把关）
 * - 超时（长命令）或离开页面 → 降级返回提示语
 * @param command 要执行的命令（可含换行，如 heredoc 多行文本）
 * @param sessionId 目标会话，缺省为当前激活终端；非激活会话仅发送不等待
 * @returns 命令输出；无法确认完成时返回「命令已发送到终端执行，请查看结果」
 */
const executeCommandWithResult = async (
  command: string,
  sessionId: string = activeSessionId.value
): Promise<string> => {
  const isActive = sessionId === activeSessionId.value
  const pane = isActive ? activePane.value : undefined
  const before = pane?.getRecentContent(1) ?? ''
  toolbox.shell.write(sessionId, toPtyInput(command) + '\r')

  // 非激活会话无法读取缓冲区：仅发送，不等待结果
  if (!isActive) return '命令已发送到终端执行，请查看结果'

  // 轮询等待输出稳定：最多 30s，每 300ms 检查一次
  const POLL_MS = 300
  const TIMEOUT_MS = 30_000
  let lastContent = before
  let stableCount = 0
  for (let waited = 0; waited < TIMEOUT_MS; waited += POLL_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    // 会话或面板已切换：无法继续追踪，降级返回
    if (activePane.value !== pane || activeSessionId.value !== sessionId) {
      return '命令已发送到终端执行，请查看结果'
    }
    const content = pane?.getRecentContent(500) ?? ''
    const lastLine = content.trimEnd().split('\n').pop()?.trim() ?? ''
    // 交互式确认提示（rm -i / overwrite? 等）：自动应答 y，跳过人工输入
    if (INTERACTIVE_PROMPT_RE.test(lastLine)) {
      toolbox.shell.write(sessionId, 'y\r')
      stableCount = 0
      continue
    }
    // 内容停止增长后再多等一轮确认稳定
    if (content === lastContent) {
      stableCount++
      // 内容稳定且出现新提示符（提示符行说明命令已执行完）
      if (stableCount >= 2 && content !== before) return content
    } else {
      stableCount = 0
      lastContent = content
    }
  }
  // 超时（长耗时命令如 tail -f / watch）：不等待了，降级返回
  return '命令已发送到终端执行（命令可能耗时较长），请查看结果'
}

/** 当前可用于 SFTP 的 SSH 会话：激活 Tab 为 SSH 时优先，否则取第一个 SSH Tab；无连接返回空串 */
const activeSshSessionId = (): string => {
  const active = tabs.value.find((t) => t.sessionId === activeSessionId.value)
  if (active && active.type === 'ssh') return active.sessionId
  return sshTabs.value[0]?.sessionId ?? ''
}

/** 终端页面独有的 AI 工具：读取终端内容 / 在终端执行命令 / 远程文件操作（SFTP） */
const shellAiTools: AiTool[] = [
  {
    name: 'get_terminal_content',
    description: '获取当前终端最近一次命令的输出内容（含命令与提示符）',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: () => getTerminalContext()
  },
  {
    name: 'execute_terminal_command',
    description:
      '在当前激活的终端中执行命令并返回执行结果（远程 SSH 为 Linux shell，本地为 PowerShell）；命令耗时过长时只返回已发送提示',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: '要执行的命令' } },
      required: ['command']
    },
    execute: async (args) => {
      const command = String(args.command ?? '').trim()
      if (!command) throw new Error('缺少参数：command')
      // 高危命令需用户确认（白名单命中自动放行）
      if (!(await confirmDangerousCommand(command))) {
        return '用户取消了该命令的执行'
      }
      return executeCommandWithResult(command)
    }
  },
  {
    name: 'sftp_mkdir',
    description: '在远程服务器上创建目录（需已建立 SSH 连接）',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '远程目录路径' } },
      required: ['path']
    },
    execute: async (args) => {
      const path = String(args.path ?? '').trim()
      if (!path) throw new Error('缺少参数：path')
      const sessionId = activeSshSessionId()
      if (!sessionId) throw new Error('没有可用的 SSH 连接')
      const { success, message } = await toolbox.sftp.mkdir(sessionId, path)
      if (!success) throw new Error(message || `创建目录失败：${path}`)
      return `已创建远程目录：${path}`
    }
  },
  {
    name: 'sftp_upload',
    description: '把本地电脑文件上传到远程服务器（需已建立 SSH 连接）',
    parameters: {
      type: 'object',
      properties: {
        localPath: { type: 'string', description: '本地文件绝对路径' },
        remotePath: { type: 'string', description: '远程目标文件路径' }
      },
      required: ['localPath', 'remotePath']
    },
    execute: async (args) => {
      const localPath = String(args.localPath ?? '').trim()
      const remotePath = String(args.remotePath ?? '').trim()
      if (!localPath || !remotePath) throw new Error('缺少参数：localPath / remotePath')
      const sessionId = activeSshSessionId()
      if (!sessionId) throw new Error('没有可用的 SSH 连接')
      const { success } = await toolbox.sftp.upload(sessionId, localPath, remotePath)
      if (!success) throw new Error(`上传失败：${localPath} -> ${remotePath}`)
      return `已上传：${localPath} -> ${remotePath}`
    }
  },
  {
    name: 'sftp_download',
    description: '从远程服务器下载文件到本地电脑（需已建立 SSH 连接）',
    parameters: {
      type: 'object',
      properties: {
        remotePath: { type: 'string', description: '远程文件路径' },
        localPath: { type: 'string', description: '本地目标文件路径' }
      },
      required: ['remotePath', 'localPath']
    },
    execute: async (args) => {
      const remotePath = String(args.remotePath ?? '').trim()
      const localPath = String(args.localPath ?? '').trim()
      if (!remotePath || !localPath) throw new Error('缺少参数：remotePath / localPath')
      const sessionId = activeSshSessionId()
      if (!sessionId) throw new Error('没有可用的 SSH 连接')
      const { success } = await toolbox.sftp.download(sessionId, remotePath, localPath)
      if (!success) throw new Error(`下载失败：${remotePath} -> ${localPath}`)
      return `已下载：${remotePath} -> ${localPath}`
    }
  }
]

/** 右键「转到 AI」：把选中内容 / 最近输出填入 AI 输入框 */
const sendTerminalToAi = (text: string): void => {
  const content = text.trim()
  if (!content) {
    ElMessage.warning('没有可发送的终端内容')
    return
  }
  aiVisible.value = true
  aiRef.value?.sendToInput(content)
}

// ==================== SFTP 文件传输（上本地 / 下远程双栏） ====================
const sftpVisible = ref(false)

/** 文件条目（本地/远程通用） */
interface FileEntry {
  name: string
  type: string
  size: number
  modifyTime: number
}

// ---------- 常用目录标签（本地/远程共用，持久化到 shell.json） ----------
interface DirBookmark {
  id: string
  /** 'local' | 'remote' */
  side: 'local' | 'remote'
  /** 显示名称 */
  name: string
  /** 目录绝对路径 */
  path: string
}

const dirBookmarks = ref<DirBookmark[]>([])
/** 添加标签弹窗 */
const bookmarkDialogVisible = ref(false)
const bookmarkForm = ref<{ side: 'local' | 'remote'; name: string; path: string }>({
  side: 'local',
  name: '',
  path: ''
})

/** 当前侧要添加标签的预填路径（打开弹窗时设置） */
const openBookmarkDialog = (side: 'local' | 'remote'): void => {
  bookmarkForm.value = {
    side,
    name: '',
    path: side === 'local' ? localPath.value : sftpPath.value
  }
  bookmarkDialogVisible.value = true
}

/** 保存常用目录标签 */
const saveBookmark = async (): Promise<void> => {
  const f = bookmarkForm.value
  if (!f.name.trim() || !f.path.trim()) {
    ElMessage.warning('请填写名称和目录路径')
    return
  }
  dirBookmarks.value.push({
    id: `bm-${Date.now()}`,
    side: f.side,
    name: f.name.trim(),
    path: f.path.trim()
  })
  await persistConnections()
  bookmarkDialogVisible.value = false
}

/** 删除常用目录标签 */
const removeBookmark = async (bookmark: DirBookmark): Promise<void> => {
  dirBookmarks.value = dirBookmarks.value.filter((b) => b.id !== bookmark.id)
  await persistConnections()
}

/** 点击标签跳转对应目录 */
const gotoBookmark = (bookmark: DirBookmark): void => {
  if (bookmark.side === 'local') {
    loadLocalList(bookmark.path)
  } else if (sftpSessionId.value) {
    loadRemoteList(bookmark.path)
  }
}

/** 某一侧的标签列表 */
const bookmarksOf = (side: 'local' | 'remote'): DirBookmark[] =>
  dirBookmarks.value.filter((b) => b.side === side)

// ---------- 本地栏 ----------
const localPath = ref('')
const localEntries = ref<FileEntry[]>([])
const localLoading = ref(false)
/** 本地栏选中的文件（用于上传） */
const selectedLocal = ref<FileEntry | null>(null)

// ---------- 远程栏 ----------
const sftpSessionId = ref('')
const sftpPath = ref('')
const sftpEntries = ref<FileEntry[]>([])
const sftpLoading = ref(false)
/** 远程栏选中的文件（用于下载） */
const selectedRemote = ref<FileEntry | null>(null)

/** 可用于 SFTP 的 SSH 会话列表 */
const sshTabs = computed(() => tabs.value.filter((t) => t.type === 'ssh'))

/** 获取会话对应的已保存连接（用于目录记忆） */
const findConnectionBySession = (sessionId: string): SavedConnection | undefined => {
  const tab = tabs.value.find((t) => t.sessionId === sessionId)
  return tab?.connectionId
    ? savedConnections.value.find((c) => c.id === tab.connectionId)
    : undefined
}

/** 拼接本地路径（Windows 分隔符） */
const joinLocalPath = (base: string, name: string): string =>
  base.endsWith('\\') ? `${base}${name}` : `${base}\\${name}`

/** 本地路径上一级 */
const localParent = (path: string): string => {
  const idx = path.lastIndexOf('\\')
  return idx <= 2 ? path.slice(0, idx + 1) : path.slice(0, idx)
}

/** 拼接远程路径 */
const joinRemotePath = (base: string, name: string): string =>
  base === '/' ? `/${name}` : `${base}/${name}`

/** 远程路径上一级 */
const remoteParent = (path: string): string => {
  if (path === '/' || path === '') return '/'
  const idx = path.lastIndexOf('/')
  return idx <= 0 ? '/' : path.slice(0, idx)
}

/** 点击本地目录项进入该目录（.. 返回上级） */
const openLocalDir = (row: FileEntry): void => {
  if (row.type !== 'directory') return
  loadLocalList(
    row.name === '..' ? localParent(localPath.value) : joinLocalPath(localPath.value, row.name)
  )
}

/** 点击远程目录项进入该目录（.. 返回上级） */
const openRemoteDir = (row: FileEntry): void => {
  if (row.type !== 'directory') return
  loadRemoteList(
    row.name === '..' ? remoteParent(sftpPath.value) : joinRemotePath(sftpPath.value, row.name)
  )
}

/** 加载本地目录列表（首行为 .. 返回上级） */
const loadLocalList = async (dirPath?: string): Promise<void> => {
  localLoading.value = true
  selectedLocal.value = null
  try {
    const list = await toolbox.fsList(dirPath || localPath.value)
    if (dirPath) localPath.value = dirPath
    // 首行插入 .. 条目：点击返回上级目录
    localEntries.value = [{ name: '..', type: 'directory', size: 0, modifyTime: 0 }, ...list]
  } catch (e) {
    ElMessage.error(`读取本地目录失败: ${e}`)
  } finally {
    localLoading.value = false
  }
}

/** 通过系统文件选择器选择本地目录 */
const pickLocalDir = async (): Promise<void> => {
  const dir = await window.dot.selectDirectory()
  if (dir) await loadLocalList(dir)
}

/** 加载远程目录列表（首行为 .. 返回上级） */
const loadRemoteList = async (dirPath?: string): Promise<void> => {
  if (!sftpSessionId.value) return
  sftpLoading.value = true
  selectedRemote.value = null
  try {
    const list = await toolbox.sftp.list(sftpSessionId.value, dirPath || sftpPath.value)
    // 目录在前，其余按名称排序
    const sorted = [...list].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    if (dirPath) sftpPath.value = dirPath
    // 首行插入 .. 条目：点击返回上级目录（根目录下不显示）
    sftpEntries.value =
      sftpPath.value === '/'
        ? sorted
        : [{ name: '..', type: 'directory', size: 0, modifyTime: 0 }, ...sorted]
    // 记忆目录地址：更新连接的 lastRemoteDir 并持久化
    const conn = findConnectionBySession(sftpSessionId.value)
    if (conn) {
      conn.lastRemoteDir = sftpPath.value
      conn.lastLocalDir = localPath.value
      await persistConnections()
    }
  } catch (e) {
    ElMessage.error(`读取远程目录失败: ${e}`)
  } finally {
    sftpLoading.value = false
  }
}

/**
 * 打开 SFTP 抽屉：
 * 自动绑定当前激活的 SSH 会话与该连接记忆的目录（首次打开定位到远程 home）
 */
const openSftp = async (): Promise<void> => {
  if (sshTabs.value.length === 0) {
    ElMessage.warning('请先建立一个 SSH 连接')
    return
  }

  // 优先使用当前激活的 SSH 会话，其次取第一个
  const current =
    sshTabs.value.find((t) => t.sessionId === activeSessionId.value) ?? sshTabs.value[0]
  sftpSessionId.value = current.sessionId
  sftpVisible.value = true

  // 本地目录：优先该连接记忆的目录
  const conn = findConnectionBySession(current.sessionId)
  if (conn?.lastLocalDir) {
    await loadLocalList(conn.lastLocalDir)
  } else {
    await loadLocalList(await toolbox.homeDir())
  }

  // 远程目录：优先记忆目录，否则解析 home 目录
  if (conn?.lastRemoteDir) {
    await loadRemoteList(conn.lastRemoteDir)
  } else {
    try {
      const home = await toolbox.sftp.realpath(current.sessionId, '.')
      await loadRemoteList(home)
    } catch {
      await loadRemoteList('/')
    }
  }
}

/** 切换 SFTP 会话后重新加载远程目录 */
const onSftpSessionChange = async (): Promise<void> => {
  const conn = findConnectionBySession(sftpSessionId.value)
  try {
    sftpPath.value = conn?.lastRemoteDir || (await toolbox.sftp.realpath(sftpSessionId.value, '.'))
  } catch {
    sftpPath.value = '/'
  }
  await loadRemoteList(sftpPath.value)
}

/** 进行中的 SFTP 传输：transferId -> { name, dir, percent } */
const sftpTransfers = reactive<Record<string, { name: string; dir: 'up' | 'down'; percent: number }>>({})
/** 监听主进程传输进度，更新对应条目百分比 */
toolbox.sftp.onSftpProgress(({ transferId, percent }) => {
  if (sftpTransfers[transferId]) sftpTransfers[transferId].percent = percent
})
/** 判断某文件是否正在传输（dir: up=上传 down=下载） */
const isTransferring = (dir: 'up' | 'down', name: string): boolean =>
  Object.values(sftpTransfers).some((t) => t.dir === dir && t.name === name)
/** 行内样式工厂：dir='up' 只在本地表显示进度条，dir='down' 只在远程表显示（避免同文件名两栏同时染色） */
const makeTransferRowStyle =
  (dir: 'up' | 'down') =>
  ({ row }: { row: FileEntry }): Record<string, string> => {
    const t = Object.values(sftpTransfers).find((item) => item.dir === dir && item.name === row.name)
    if (!t) return {}
    const p = Math.max(0, Math.min(100, t.percent))
    return {
      backgroundImage: `linear-gradient(to right, rgba(103, 194, 58, 0.45) ${p}%, transparent ${p}%)`,
      transition: 'background-image 0.2s'
    }
  }
const localRowStyle = makeTransferRowStyle('up')
const remoteRowStyle = makeTransferRowStyle('down')

/** 上传指定本地文件到远程当前目录 */
const uploadSelected = async (row?: FileEntry): Promise<void> => {
  const file = row || selectedLocal.value
  if (!file) {
    ElMessage.warning('请先在本地目录选择要上传的文件')
    return
  }
  if (file.type === 'directory') {
    ElMessage.warning('暂不支持上传目录，请选择文件')
    return
  }
  if (isTransferring('up', file.name)) return
  const localFile = joinLocalPath(localPath.value, file.name)
  const remoteFile = joinRemotePath(sftpPath.value, file.name)
  const transferId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  sftpTransfers[transferId] = { name: file.name, dir: 'up', percent: 0 }
  try {
    await toolbox.sftp.upload(sftpSessionId.value, localFile, remoteFile, transferId)
    ElMessage.success(`已上传 ${file.name}`)
    await loadRemoteList()
  } catch (e) {
    ElMessage.error(`上传失败: ${e}`)
  } finally {
    delete sftpTransfers[transferId]
  }
}

/** 下载指定远程文件到本地当前目录 */
const downloadSelected = async (row?: FileEntry): Promise<void> => {
  const file = row || selectedRemote.value
  if (!file) {
    ElMessage.warning('请先在远程目录选择要下载的文件')
    return
  }
  if (file.type === 'directory') {
    ElMessage.warning('暂不支持下载目录，请选择文件')
    return
  }
  if (isTransferring('down', file.name)) return
  const remoteFile = joinRemotePath(sftpPath.value, file.name)
  const localFile = joinLocalPath(localPath.value, file.name)
  const transferId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  sftpTransfers[transferId] = { name: file.name, dir: 'down', percent: 0 }
  try {
    await toolbox.sftp.download(sftpSessionId.value, remoteFile, localFile, transferId)
    ElMessage.success(`已下载 ${file.name}`)
    await loadLocalList()
  } catch (e) {
    ElMessage.error(`下载失败: ${e}`)
  } finally {
    delete sftpTransfers[transferId]
  }
}

/** 新建远程目录（基于当前会话 + 当前目录） */
const createRemoteDir = async (): Promise<void> => {
  try {
    const { value } = await ElMessageBox.prompt(
      `将在远程目录 ${sftpPath.value} 下创建`,
      '新建远程目录'
    )
    if (!value?.trim()) return
    await toolbox.sftp.mkdir(sftpSessionId.value, joinRemotePath(sftpPath.value, value.trim()))
    ElMessage.success('目录已创建')
    await loadRemoteList()
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(`创建失败: ${e}`)
  }
}

/** 删除远程文件/目录（二次确认） */
const deleteRemoteEntry = async (entry: FileEntry): Promise<void> => {
  try {
    await ElMessageBox.confirm(`确定删除远程 ${entry.name} 吗？`, '删除确认', { type: 'warning' })
    await toolbox.sftp.remove(
      sftpSessionId.value,
      joinRemotePath(sftpPath.value, entry.name),
      entry.type === 'directory'
    )
    await loadRemoteList()
  } catch {
    // 用户取消或删除失败
  }
}

/** 文件大小格式化 */
const formatSize = (size: number): string => {
  if (!size) return '-'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

// 页面初始化：加载已保存的连接列表
onMounted(loadConnections)
</script>

<template>
  <div class="shell-page">
    <!-- 顶栏 -->
    <header class="shell-header">
      <div class="shell-header-left">
        <!-- 侧栏收起/展开切换 -->
        <el-button
          circle
          :icon="sidebarCollapsed ? ArrowRight : ArrowLeft"
          @click="sidebarCollapsed = !sidebarCollapsed"
        />
        <div class="shell-header-brand">
          <el-icon :size="20"><Monitor /></el-icon>
          <span class="shell-header-title">终端</span>
        </div>
      </div>
      <div class="shell-header-actions">
        <el-button :icon="FolderOpened" @click="openSftp">SFTP</el-button>
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

    <!-- 主区域：连接侧栏 + 终端 Tabs + AI 侧栏 -->
    <div class="shell-content">
      <!-- 左侧可收起的连接管理侧栏 -->
      <aside v-show="!sidebarCollapsed" class="conn-sidebar">
        <div class="conn-sidebar-header">
          <span class="conn-sidebar-title">连接列表</span>
          <el-button type="primary" size="small" :icon="Plus" @click="openConnectDialog">
            新建连接
          </el-button>
        </div>

        <div class="conn-list">
          <!-- 已保存的远程连接：无分类的直接平铺，有分类的归入可折叠分组 -->
          <div v-for="conn in groupedConnections.plain" :key="conn.id" class="conn-item">
            <div class="conn-item-main" title="点击连接" @click="connectSaved(conn)">
              <el-icon class="conn-item-icon" :size="18"><Connection /></el-icon>
              <div class="conn-item-info">
                <span class="conn-item-name">{{ conn.name }}</span>
                <span class="conn-item-sub"
                  >{{ conn.username }}@{{ conn.host }}:{{ conn.port }}</span
                >
              </div>
            </div>
            <div class="conn-item-actions">
              <el-button size="small" text :icon="Edit" @click.stop="openEditDialog(conn)" />
              <el-button
                size="small"
                text
                type="danger"
                :icon="Delete"
                @click.stop="deleteConnection(conn)"
              />
            </div>
          </div>

          <!-- 分类分组：点击头部展开/收起，默认展开 -->
          <div v-for="[cat, conns] in groupedConnections.groups" :key="cat" class="conn-group">
            <div class="conn-group-header" @click="toggleGroup(cat)">
              <el-icon
                class="conn-group-arrow"
                :class="{ open: groupExpanded[cat] !== false }"
                :size="12"
                ><CaretRight
              /></el-icon>
              <el-icon class="conn-group-folder" :size="13">
                <FolderOpened v-if="groupExpanded[cat] !== false" />
                <Folder v-else />
              </el-icon>
              <span class="conn-group-name">{{ cat }}</span>
              <span class="conn-group-count">{{ conns.length }}</span>
            </div>
            <template v-if="groupExpanded[cat] !== false">
              <div v-for="conn in conns" :key="conn.id" class="conn-item grouped">
                <div class="conn-item-main" title="点击连接" @click="connectSaved(conn)">
                  <el-icon class="conn-item-icon" :size="18"><Connection /></el-icon>
                  <div class="conn-item-info">
                    <span class="conn-item-name">{{ conn.name }}</span>
                    <span class="conn-item-sub"
                      >{{ conn.username }}@{{ conn.host }}:{{ conn.port }}</span
                    >
                  </div>
                </div>
                <div class="conn-item-actions">
                  <el-button size="small" text :icon="Edit" @click.stop="openEditDialog(conn)" />
                  <el-button
                    size="small"
                    text
                    type="danger"
                    :icon="Delete"
                    @click.stop="deleteConnection(conn)"
                  />
                </div>
              </div>
            </template>
          </div>

          <!-- 无连接提示 -->
          <div v-if="savedConnections.length === 0" class="conn-empty">
            暂无保存的连接，点击「新建连接」添加
          </div>
        </div>

        <!-- 底部固定：本地 PowerShell 快捷入口 -->
        <div class="conn-footer">
          <div class="conn-item local" @click="openLocalTab">
            <el-icon class="conn-item-icon" :size="18"><Monitor /></el-icon>
            <div class="conn-item-info">
              <span class="conn-item-name">本地 PowerShell</span>
              <span class="conn-item-sub">点击打开本地终端</span>
            </div>
          </div>
        </div>
      </aside>

      <!-- 中间终端区 -->
      <div class="terminal-area">
        <el-tabs
          v-if="tabs.length > 0"
          v-model="activeSessionId"
          type="card"
          class="terminal-tabs"
          @tab-remove="(name: any) => removeTab(String(name))"
        >
          <el-tab-pane v-for="tab in tabs" :key="tab.sessionId" :name="tab.sessionId" closable>
            <template #label>
              <span class="terminal-tab-label">
                <el-icon :size="12">
                  <Connection v-if="tab.type === 'ssh'" />
                  <Monitor v-else />
                </el-icon>
                {{ tab.title }}
              </span>
            </template>
            <!-- v-show 由 el-tabs 内部控制，切换 Tab 时终端实例保留；
                 key 随会话 ID 变化，重新连接后自动重建终端面板 -->
            <TerminalPane
              :key="tab.sessionId"
              :ref="setPaneRef(tab.sessionId)"
              :session-id="tab.sessionId"
              :title="tab.title"
              :conn-type="tab.type"
              @reconnect="reconnectTab(tab.sessionId)"
              @copy-link="copyTabLink(tab.sessionId)"
              @send-to-ai="sendTerminalToAi"
            />
          </el-tab-pane>
        </el-tabs>

        <!-- 空状态 -->
        <div v-else class="terminal-empty">
          <el-empty description="暂无终端连接">
            <div class="terminal-empty-actions">
              <el-button type="primary" @click="openConnectDialog">新建 SSH 连接</el-button>
              <el-button @click="openLocalTab">本地 PowerShell</el-button>
            </div>
          </el-empty>
        </div>
      </div>

      <!-- 可伸缩 AI 侧栏 -->
      <AiAssistant
        v-show="aiVisible"
        ref="aiRef"
        scene="shell"
        title="终端 AI 助手"
        :get-context="getTerminalContext"
        :tools="shellAiTools"
        :execute-command="executeTerminalCommand"
        execute-label="执行"
        :scene-extra="sceneExtra"
      />
    </div>

    <!-- 新建 / 编辑连接弹窗 -->
    <el-dialog
      v-model="connectDialogVisible"
      :title="dialogMode === 'create' ? '新建连接' : '编辑连接'"
      width="440px"
    >
      <el-form label-width="80px">
        <el-form-item label="服务名称" required>
          <el-input v-model="connectForm.name" placeholder="例如：测试服务器" />
        </el-form-item>
        <el-form-item label="主机地址" required>
          <el-input v-model="connectForm.host" placeholder="例如 192.168.1.100" />
        </el-form-item>
        <el-form-item label="端口">
          <el-input v-model="connectForm.port" placeholder="22" />
        </el-form-item>
        <el-form-item label="用户名" required>
          <el-input v-model="connectForm.username" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="connectForm.password" type="password" show-password />
        </el-form-item>
        <el-form-item label="分类">
          <el-autocomplete
            v-model="connectForm.category"
            :fetch-suggestions="queryCategory"
            clearable
            placeholder="可选，留空则直接展示（可输入新分类）"
            style="width: 100%"
          />
        </el-form-item>
      </el-form>

      <!-- 测试连接结果反馈 -->
      <el-alert
        v-if="testResult"
        :title="testResult.message"
        :type="testResult.success ? 'success' : 'error'"
        :closable="false"
        class="test-result"
      />

      <template #footer>
        <!-- 左下角测试连接，右侧其余操作 -->
        <div class="conn-dialog-footer">
          <el-button :loading="testing" @click="testConnection">测试连接</el-button>
          <div class="conn-dialog-footer-right">
            <el-button @click="connectDialogVisible = false">取消</el-button>
            <el-button v-if="dialogMode === 'create'" type="primary" @click="saveConnection(true)">
              保存并连接
            </el-button>
            <el-button type="primary" @click="saveConnection(false)">
              {{ dialogMode === 'create' ? '仅保存' : '保存' }}
            </el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <!-- 常用目录标签添加弹窗 -->
    <el-dialog v-model="bookmarkDialogVisible" title="添加常用目录" width="420px">
      <el-form label-width="80px">
        <el-form-item label="位置">
          <el-radio-group v-model="bookmarkForm.side">
            <el-radio value="local">本地目录</el-radio>
            <el-radio value="remote">远程目录</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="名称" required>
          <el-input v-model="bookmarkForm.name" placeholder="例如：日志目录" />
        </el-form-item>
        <el-form-item label="目录路径" required>
          <el-input v-model="bookmarkForm.path" placeholder="目录绝对路径" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="bookmarkDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveBookmark">保存</el-button>
      </template>
    </el-dialog>

    <!-- SFTP 抽屉：上本地目录 / 下远程目录，各占一半填满窗口 -->
    <el-drawer v-model="sftpVisible" title="SFTP 文件传输" size="760px" class="sftp-drawer">
      <div class="sftp-container">
        <!-- ==================== 上：本地目录 ==================== -->
        <div class="sftp-section">
          <div class="sftp-section-header">
            <span class="sftp-section-title local-title">本地目录</span>
            <div class="sftp-section-toolbar">
              <!-- 刷新 -->
              <el-button size="small" :icon="Refresh" title="刷新" @click="loadLocalList()" />
              <!-- 添加当前目录为常用标签 -->
              <el-button
                size="small"
                :icon="Star"
                title="添加常用目录"
                @click="openBookmarkDialog('local')"
              />
              <!-- 常用目录：可输入路径，也可从下拉选常用目录 -->
              <el-select
                v-model="localPath"
                size="small"
                filterable
                allow-create
                default-first-option
                placeholder="输入或选择目录"
                class="sftp-path"
                @change="(v: any) => loadLocalList(String(v))"
              >
                <el-option
                  v-for="bm in bookmarksOf('local')"
                  :key="bm.id"
                  :label="`${bm.name} (${bm.path})`"
                  :value="bm.path"
                />
              </el-select>
              <!-- 通过系统文件选择器选择目录 -->
              <el-button size="small" :icon="FolderOpened" title="选择目录" @click="pickLocalDir" />
              <!-- 已保存的常用标签（点击跳转，右键无，悬停删除） -->
              <el-tag
                v-for="bm in bookmarksOf('local')"
                :key="bm.id"
                size="small"
                closable
                class="sftp-tag"
                @click="gotoBookmark(bm)"
                @close="removeBookmark(bm)"
              >
                {{ bm.name }}
              </el-tag>
            </div>
          </div>
          <!-- 表格容器定高，仅表格内部滚动 -->
          <div class="sftp-table-wrap">
            <el-table
              v-loading="localLoading"
              :data="localEntries"
              height="100%"
              size="small"
              highlight-current-row
              :row-style="localRowStyle"
              @current-change="(row: any) => (selectedLocal = row)"
            >
              <el-table-column label="名称">
                <template #default="{ row }">
                  <!-- 目录（含 ..）可点击进入 -->
                  <span
                    :class="{ 'entry-dir': row.type === 'directory' }"
                    @click="openLocalDir(row)"
                  >
                    {{ row.name === '..' ? '⬆' : row.type === 'directory' ? '📁' : '📄' }}
                    {{ row.name }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column label="大小" width="90">
                <template #default="{ row }">{{ formatSize(row.size) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="90">
                <template #default="{ row }">
                  <el-button
                    v-if="row.type === 'file'"
                    size="small"
                    text
                    type="primary"
                    :icon="Upload"
                    :disabled="isTransferring('up', row.name)"
                    :title="isTransferring('up', row.name) ? '上传中...' : '上传到远程当前目录'"
                    @click="uploadSelected(row)"
                  >
                    上传
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </div>

        <!-- 传输方向提示 -->
        <div class="sftp-transfer-hint">
          <el-icon><Upload /></el-icon>
          <span>本地 ↑ 上传 | 远程 ↓ 下载</span>
          <el-icon><Download /></el-icon>
        </div>

        <!-- ==================== 下：远程目录 ==================== -->
        <div class="sftp-section">
          <div class="sftp-section-header">
            <span class="sftp-section-title remote-title">远程目录</span>
            <div class="sftp-section-toolbar">
              <!-- 会话选择：切换当前 Shell 窗口内的 SSH 连接 -->
              <el-select
                v-model="sftpSessionId"
                size="small"
                style="width: 150px"
                placeholder="选择会话"
                @change="onSftpSessionChange"
              >
                <el-option
                  v-for="tab in sshTabs"
                  :key="tab.sessionId"
                  :label="tab.title"
                  :value="tab.sessionId"
                />
              </el-select>
              <el-button size="small" :icon="Refresh" title="刷新" @click="loadRemoteList()" />
              <el-button size="small" :icon="FolderAdd" title="新建目录" @click="createRemoteDir" />
              <el-button
                size="small"
                :icon="Star"
                title="添加常用目录"
                @click="openBookmarkDialog('remote')"
              />
              <!-- 常用目录：可输入路径，也可从下拉选常用目录 -->
              <el-select
                v-model="sftpPath"
                size="small"
                filterable
                allow-create
                default-first-option
                placeholder="输入或选择目录"
                class="sftp-path"
                @change="(v: any) => loadRemoteList(String(v))"
              >
                <el-option
                  v-for="bm in bookmarksOf('remote')"
                  :key="bm.id"
                  :label="`${bm.name} (${bm.path})`"
                  :value="bm.path"
                />
              </el-select>
              <el-tag
                v-for="bm in bookmarksOf('remote')"
                :key="bm.id"
                size="small"
                closable
                class="sftp-tag"
                @click="gotoBookmark(bm)"
                @close="removeBookmark(bm)"
              >
                {{ bm.name }}
              </el-tag>
            </div>
          </div>
          <!-- 表格容器定高，仅表格内部滚动 -->
          <div class="sftp-table-wrap">
            <el-table
              v-loading="sftpLoading"
              :data="sftpEntries"
              height="100%"
              size="small"
              highlight-current-row
              :row-style="remoteRowStyle"
              @current-change="(row: any) => (selectedRemote = row)"
            >
              <el-table-column label="名称">
                <template #default="{ row }">
                  <!-- 目录（含 ..）可点击进入 -->
                  <span
                    :class="{ 'entry-dir': row.type === 'directory' }"
                    @click="openRemoteDir(row)"
                  >
                    {{ row.name === '..' ? '⬆' : row.type === 'directory' ? '📁' : '📄' }}
                    {{ row.name }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column label="大小" width="90">
                <template #default="{ row }">{{ formatSize(row.size) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="140">
                <template #default="{ row }">
                  <el-button
                    v-if="row.type === 'file'"
                    size="small"
                    text
                    type="primary"
                    :icon="Download"
                    :disabled="isTransferring('down', row.name)"
                    :title="isTransferring('down', row.name) ? '下载中...' : '下载到本地当前目录'"
                    @click="downloadSelected(row)"
                  >
                    下载
                  </el-button>
                  <el-button
                    size="small"
                    text
                    type="danger"
                    :icon="Delete"
                    @click="deleteRemoteEntry(row)"
                  >
                    删除
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.shell-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
}

.shell-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: linear-gradient(135deg, var(--color-primary-dark) 0%, var(--color-primary) 100%);
  color: #fff;
}

.shell-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.shell-header-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #fff;
}

.shell-header-title {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 1px;
}

.shell-content {
  flex: 1;
  display: flex;
  min-height: 0;
}

/* ===== 左侧连接侧栏 ===== */
.conn-sidebar {
  width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-card);
  border-right: 1px solid var(--color-border);
}

.conn-sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  border-bottom: 1px solid var(--color-border);
}

.conn-sidebar-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.conn-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

/* 分类分组头部与缩进 */
.conn-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 4px;
  cursor: pointer;
  user-select: none;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 500;
}

.conn-group-header:hover {
  color: var(--color-text);
}

.conn-group-arrow {
  transition: transform 0.15s;
}

.conn-group-arrow.open {
  transform: rotate(90deg);
}

/* 分类名前的文件夹小图标 */
.conn-group-folder {
  flex-shrink: 0;
  color: var(--color-warning, #e6a23c);
}

.conn-group-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conn-group-count {
  font-size: 11px;
  opacity: 0.7;
}

.conn-item.grouped {
  padding-left: 16px;
}

.conn-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-radius: 8px;
  padding: 8px 10px;
  cursor: pointer;
  transition: background 0.2s ease;
}

.conn-item:hover {
  background: var(--color-hover);
}

.conn-item-main {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.conn-item-icon {
  color: var(--color-primary);
  flex-shrink: 0;
}

.conn-item-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.conn-item-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conn-item-sub {
  font-size: 11px;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 悬停时显示操作按钮 */
.conn-item-actions {
  display: none;
  gap: 0;
}

.conn-item:hover .conn-item-actions {
  display: flex;
}

.conn-empty {
  padding: 24px 12px;
  font-size: 12px;
  color: var(--color-text-secondary);
  text-align: center;
  line-height: 1.8;
}

.conn-footer {
  border-top: 1px solid var(--color-border);
  padding: 8px;
}

/* ===== 中间终端区 ===== */
.terminal-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 8px;
}

.terminal-tabs {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* el-tabs 内容区占满剩余高度 */
.terminal-tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
}

.terminal-tabs :deep(.el-tab-pane) {
  height: 100%;
}

.terminal-tab-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.terminal-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.terminal-empty-actions {
  display: flex;
  gap: 12px;
}

/* 测试连接结果 */
.test-result {
  margin-top: 4px;
}

/* 连接弹窗 footer：测试连接居左，其余按钮居右 */
.conn-dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.conn-dialog-footer-right {
  display: flex;
  align-items: center;
}

/* ===== SFTP 双栏（上下各半填满抽屉） ===== */

/* 以下抽屉级样式放在非 scoped 块中（见文件末尾），
   因为 Element Plus drawer 将内容 teleport 到 body，scoped :deep() 可能不生效。
   此处仅保留组件内部内容的布局样式。 */

.sftp-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 0;
}

/* 每栏占一半 */
.sftp-section {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.sftp-section-header {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 8px;
  flex-shrink: 0;
}

.sftp-section-title {
  font-size: 14px;
  font-weight: 600;
  flex-shrink: 0;
}

.local-title {
  color: var(--color-primary);
}

.remote-title {
  color: var(--color-success);
}

/* 工具栏允许换行，容纳目录标签 */
.sftp-section-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.sftp-path {
  width: 240px;
}

/* 目录表格容器：占满剩余高度，仅表格内部滚动
   height:0 + flex:1 强制浏览器按 flex 分配计算实际高度，使内部 height:100% 的 el-table 能正确继承 */
.sftp-table-wrap {
  flex: 1;
  height: 0;
  overflow: hidden;
}

/* 传输进度条画在 tr 背景上；选中行/悬停行的 td 背景会盖住它，置为透明让绿色进度可见 */
.sftp-table-wrap :deep(tr.current-row > td.el-table__cell) {
  background-color: transparent !important;
}
.sftp-table-wrap :deep(tr:hover > td.el-table__cell) {
  background-color: transparent;
}

/* 常用目录标签 */
.sftp-tag {
  cursor: pointer;
}

/* 上传/下载方向提示 */
.sftp-transfer-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 6px 0;
  font-size: 12px;
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

/* 目录名高亮 */
.entry-dir {
  color: var(--color-primary);
  cursor: pointer;
}
</style>

<!-- 非 scoped：Element Plus drawer teleport 到 body，必须全局覆盖才能生效 -->
<style>
/* SFTP 抽屉：禁止抽屉面板自身滚动，让内部表格独立滚动 */
.sftp-drawer.el-drawer {
  overflow: hidden !important;
  height: 100% !important;
  max-height: 100% !important;
}

.sftp-drawer.el-drawer .el-drawer__container {
  display: flex !important;
  flex-direction: column !important;
  height: 100% !important;
  overflow: hidden !important;
}

.sftp-drawer.el-drawer .el-drawer__header {
  flex-shrink: 0;
}

.sftp-drawer.el-drawer .el-drawer__body {
  flex: 1 !important;
  min-height: 0 !important;
  padding: 12px 16px;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;
}
</style>
