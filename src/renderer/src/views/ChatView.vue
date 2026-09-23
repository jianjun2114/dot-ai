<script setup lang="ts">
import { ref, onMounted, nextTick, computed, reactive, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Plus, Delete, Edit, Fold, Expand, Promotion, HomeFilled, Avatar } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useSettings } from '../composables/useSettings'
import { useChatSessions } from '../composables/useChatSessions'
import { chat, ensureEndpointLogin } from '../composables/aichat'
import { getAppPath } from '../utils/config'
import AssistantMessage from '../components/AssistantMessage.vue'
import fujianSvg from '../assets/fujian.svg'
import sikaoSvg from '../assets/sikao.svg'
import sikaoHuiSvg from '../assets/sikao_hui.svg'

const route = useRoute()
const router = useRouter()
const { settings } = useSettings()

/* ================================ 会话管理 ================================ */

const {
  sessions,
  currentSessionId,
  currentSession,
  createSession,
  deleteSession,
  switchSession,
  renameSession,
  addMessage,
  updateMessage,
  setSessionChatId,
  clearCurrentSession,
  initSessions,
  formatSessionTime
} = useChatSessions()

/** 当前会话的消息列表 */
const messages = computed(() => currentSession.value?.messages || [])

/** 当前启用的对话接口名称（侧边栏底部状态展示） */
const activeEndpointName = computed(() => {
  const endpoint = settings.value.chatEndpoints.find((e) => e.enabled)
  return endpoint ? endpoint.name : ''
})

/* ================================ 输入与 UI 状态 ================================ */

const inputMessage = ref('')
const isLoading = ref(false)
const messagesContainer = ref<HTMLElement>()
const inputTextarea = ref<HTMLTextAreaElement>()
const sidebarCollapsed = ref(false)

// 会话重命名编辑状态
const editingSessionId = ref<string | null>(null)
const editingTitle = ref('')
const editInputRef = ref<HTMLInputElement>()

// 当前生成中的回复消息 id
const currentStreamingId = ref<number | null>(null)

// 当前请求的中止控制器：停止生成时真实断开（ws 模式）/ 丢弃结果（http/local 模式）
let currentController: AbortController | null = null

/* ================================ 智能体选择 / 深度思考 ================================ */

/** 深度思考开关（随请求透传，仅部分模型支持） */
const deepThink = ref(false)

/** 当前选择的智能体：'chat' = 默认对话（使用启用中的对话接口），否则为接口 id */
const selectedAgentId = ref('chat')

/** 智能体展示名：默认「对话」，选中接口时显示接口名 */
const agentName = computed(() => {
  if (selectedAgentId.value === 'chat') return '对话'
  return settings.value.chatEndpoints.find((e) => e.id === selectedAgentId.value)?.name ?? '对话'
})

/** 切换智能体：切换启用中的对话接口（chat() 使用启用中的接口） */
const selectAgent = (id: string | number): void => {
  const target = String(id)
  if (target !== 'chat' && !settings.value.chatEndpoints.some((e) => e.id === target)) return
  selectedAgentId.value = target
  settings.value.chatEndpoints = settings.value.chatEndpoints.map((e) => ({
    ...e,
    enabled: target === 'chat' ? e.enabled : e.id === target
  }))
}

/* ================================ 附件（图片 / 文件） ================================ */

/** 待发送图片：name 原文件名 / path 持久化路径（Cache/chat/pic/会话id/）/ dataUrl 内嵌数据 */
interface PendingImage {
  name: string
  path: string
  dataUrl: string
}

/** 待发送文件 */
interface PendingFile {
  name: string
  path: string
  /** 是否为文本文件（发送时读取内容拼进消息） */
  isText: boolean
}

const pendingImages = ref<PendingImage[]>([])
const pendingFiles = ref<PendingFile[]>([])
const attachmentInputRef = ref<HTMLInputElement>()
/** 图片路径 → dataURL 缓存（消息气泡渲染用，异步加载后填充） */
const imageDataUrls = reactive<Record<string, string>>({})

/** 文本类扩展名（发送时读取文件内容供模型参考） */
const TEXT_EXTS = new Set([
  'txt',
  'md',
  'json',
  'js',
  'ts',
  'jsx',
  'tsx',
  'py',
  'java',
  'html',
  'css',
  'csv',
  'log',
  'xml',
  'yaml',
  'yml',
  'sh',
  'bat',
  'sql',
  'ini',
  'conf',
  'vue'
])

const isTextFile = (name: string): boolean =>
  TEXT_EXTS.has(name.split('.').pop()?.toLowerCase() ?? '')

/** 保存并加入待发送附件列表（图片存 Cache/chat/pic/，文件存 Cache/chat/file/，按会话 id 分目录） */
const addAttachmentFiles = async (files: File[]): Promise<void> => {
  if (pendingImages.value.length + pendingFiles.value.length + files.length > 4) {
    ElMessage.warning('每次最多发送 4 个附件')
    return
  }
  if (!currentSession.value) createSession()
  const sessionId = currentSession.value!.id
  for (const file of files) {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () =>
        resolve((reader.result as string).slice(String(reader.result).indexOf(',') + 1))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
    if (file.type.startsWith('image/')) {
      const path = `${await getAppPath()}/Cache/chat/pic/${sessionId}/${Date.now()}-${file.name || '截图.png'}`
      const ok = await window.dot.localFiles('write-base64', path, base64)
      if (!ok) {
        ElMessage.error(`图片保存失败：${file.name || '截图'}`)
        continue
      }
      pendingImages.value.push({
        name: file.name || '截图.png',
        path,
        dataUrl: `data:${file.type || 'image/png'};base64,${base64}`
      })
    } else {
      const path = `${await getAppPath()}/Cache/chat/file/${sessionId}/${Date.now()}-${file.name}`
      const ok = await window.dot.localFiles('write-base64', path, base64)
      if (!ok) {
        ElMessage.error(`文件保存失败：${file.name}`)
        continue
      }
      pendingFiles.value.push({ name: file.name, path, isText: isTextFile(file.name) })
    }
  }
}

/** 选择附件（图片或文件） */
const handleAttachmentSelect = async (e: Event): Promise<void> => {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (files.length === 0) return
  await addAttachmentFiles(files)
}

/** 粘贴截图：拦截剪贴板中的图片加入待发送附件（不影响纯文本粘贴） */
const handlePaste = async (e: ClipboardEvent): Promise<void> => {
  const files = Array.from(e.clipboardData?.files ?? [])
  const images = files.filter((f) => f.type.startsWith('image/'))
  if (images.length === 0) return
  e.preventDefault()
  await addAttachmentFiles(images)
}

/** 移除待发送附件（仅从待发送列表移除，文件保留在磁盘） */
const removePendingImage = (img: PendingImage): void => {
  pendingImages.value = pendingImages.value.filter((p) => p !== img)
}
const removePendingFile = (f: PendingFile): void => {
  pendingFiles.value = pendingFiles.value.filter((p) => p !== f)
}

/** 按扩展名推断图片 MIME（磁盘读取时 dataURL 前缀用） */
const mimeFromPath = (path: string): string => {
  const p = path.toLowerCase()
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg'
  if (p.endsWith('.gif')) return 'image/gif'
  if (p.endsWith('.webp')) return 'image/webp'
  if (p.endsWith('.bmp')) return 'image/bmp'
  if (p.endsWith('.svg')) return 'image/svg+xml'
  return 'image/png'
}

/** 消息气泡图片展示：优先取缓存 dataURL，否则异步读取（read-base64） */
const imageSrc = (path: string): string => {
  const cached = imageDataUrls[path]
  if (cached) return cached
  void window.dot.localFiles('read-base64', path).then((b64) => {
    if (typeof b64 === 'string' && b64) {
      imageDataUrls[path] = `data:${mimeFromPath(path)};base64,${b64}`
    }
  })
  return ''
}

/* ================================ 工具函数 ================================ */

/** 等待 DOM 更新后滚动到消息底部 */
const scrollToBottom = async (): Promise<void> => {
  await nextTick()
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
  }
}

/** 用户是否处于消息底部附近（80px 阈值内）：流式期间仅贴底时自动跟随 */
const isNearBottom = (): boolean => {
  const el = messagesContainer.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

// 流式过程中内容实时增长时自动贴底滚动（用户向上滚动阅读时暂停跟随）
watch(
  () => currentSession.value?.messages.find((m) => m.id === currentStreamingId.value)?.content,
  async () => {
    if (!isLoading.value || !isNearBottom()) return
    await nextTick()
    // markdown 渲染为异步，再等一帧确保高度增长完成后滚动
    await nextTick()
    if (messagesContainer.value && isNearBottom()) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  }
)

/** 聚焦输入框：需等待 textarea 解除禁用（isLoading 复位）后 */
const focusInput = (): void => {
  nextTick(() => inputTextarea.value?.focus())
}

/* ================================ 发送与停止 ================================ */

/** 发送消息：调用「智能对话」中启用的接口，流式渲染回复（支持图片识别，仅 local 模式） */
const sendMessage = async (): Promise<void> => {
  const userInput = inputMessage.value.trim()
  const pendingImg = [...pendingImages.value]
  const pendingFile = [...pendingFiles.value]
  if ((!userInput && pendingImg.length === 0 && pendingFile.length === 0) || isLoading.value) return

  // 确保有会话
  if (!currentSession.value) createSession()

  // 图片仅 local 模式支持多模态识别，其他模式提示后忽略
  const endpointMode = settings.value.chatEndpoints.find((e) => e.enabled)?.mode
  const sendImages = endpointMode === 'local' ? pendingImg.map((p) => p.dataUrl) : undefined
  if (pendingImg.length > 0 && endpointMode !== 'local') {
    ElMessage.warning('当前对话接口模式不支持图片识别，已忽略图片')
  }

  // 文本类文件读取内容拼进消息；二进制文件仅提示文件名
  let fileNote = ''
  for (const f of pendingFile) {
    if (f.isText) {
      const content = (await window.dot.localFiles('read', f.path)) as string | null
      fileNote += `\n\n[附件文件：${f.name}]\n\`\`\`\n${(content ?? '').slice(0, 20000)}\n\`\`\``
    } else {
      fileNote += `\n\n[附件文件：${f.name}（二进制文件，已保存至 ${f.path}）]`
    }
  }

  // 本地模式历史对话：取本次用户消息之前的会话消息（按时间正序）
  const history = (currentSession.value?.messages ?? [])
    .filter((m) => m.content.trim() && !m.isStreaming)
    .map((m) => ({ role: m.role, content: m.content }))

  // 追加用户消息与助手占位消息，占位消息随流式返回逐步填充
  addMessage({
    id: Date.now(),
    role: 'user',
    content: userInput || (pendingImg.length > 0 ? '[图片]' : '[文件]'),
    timestamp: new Date(),
    images: sendImages ? pendingImg.map((p) => p.path) : undefined,
    files: pendingFile.length > 0 ? pendingFile.map((f) => f.path) : undefined
  })
  const placeholderId = Date.now() + 1
  currentStreamingId.value = placeholderId
  addMessage({
    id: placeholderId,
    role: 'assistant',
    content: '',
    timestamp: new Date(),
    isStreaming: true
  })

  inputMessage.value = ''
  pendingImages.value = []
  pendingFiles.value = []
  isLoading.value = true
  const controller = new AbortController()
  currentController = controller
  scrollToBottom()

  // 流式累积：思考帧包成 <think> 块（AssistantMessage 解析渲染），正文帧直接追加
  let acc = ''
  let thinkOpen = false
  /** 是否收到过统一格式帧（local 模式）：决定最终回填使用 acc 还是 result.reply */
  let usedChunk = false
  try {
    const result = await chat(userInput + fileNote, {
      history,
      images: sendImages,
      think: deepThink.value,
      signal: controller.signal,
      onDelta: (delta) => {
        // 正文帧到达时闭合思考块（思考帧在前、正文帧在后）
        if (thinkOpen) {
          acc += '</think>\n'
          thinkOpen = false
        }
        acc += delta
        updateMessage(currentSession.value!.id, placeholderId, { content: acc })
      },
      onChunk: (chunk) => {
        // 思考帧：包成 think 块；正文帧已由 onDelta 处理，这里跳过避免重复
        if (!chunk.reasoning_content) return
        usedChunk = true
        if (!thinkOpen) {
          acc += '<think>'
          thinkOpen = true
        }
        acc += chunk.reasoning_content
        updateMessage(currentSession.value!.id, placeholderId, { content: acc })
      }
    })
    if (usedChunk) {
      // local 模式：acc 已含思考块 + 正文（onDelta 追加），流结束闭合思考块
      if (thinkOpen) acc += '</think>\n'
      updateMessage(currentSession.value!.id, placeholderId, {
        content: acc,
        isStreaming: false
      })
    } else {
      updateMessage(currentSession.value!.id, placeholderId, {
        content: result.reply,
        isStreaming: false
      })
    }
    // 保存服务端返回的对话会话 id，供当前对话历史的后续消息使用
    if (result.sessionId && currentSession.value?.sessionId !== result.sessionId) {
      setSessionChatId(currentSession.value!.id, result.sessionId)
    }
  } catch (error) {
    // 停止生成（AbortError）：占位消息已由 stopGenerating 处理，此处静默
    const aborted = error instanceof DOMException && error.name === 'AbortError'
    if (!aborted) {
      const message = error instanceof Error ? error.message : '请求失败，请稍后重试。'
      updateMessage(currentSession.value!.id, placeholderId, {
        content: message,
        isStreaming: false
      })
      ElMessage.error(message)
    }
  } finally {
    if (currentController === controller) {
      isLoading.value = false
      currentStreamingId.value = null
      currentController = null
      focusInput()
    }
  }
  scrollToBottom()
}

/** 停止生成：中止请求（ws 模式真实断开连接）并复位状态 */
const stopGenerating = (): void => {
  currentController?.abort()
  currentController = null
  isLoading.value = false
  if (currentSession.value && currentStreamingId.value) {
    const msg = currentSession.value.messages.find((m) => m.id === currentStreamingId.value)
    updateMessage(currentSession.value.id, currentStreamingId.value, {
      isStreaming: false,
      content: (msg?.content || '') + '\n（已停止生成）'
    })
  }
  currentStreamingId.value = null
  focusInput()
}

/* ================================ 会话操作 ================================ */

/** 返回首页 */
const goHome = (): void => {
  router.push({ name: 'Home' })
}

/** 展开/收起侧边栏 */
const toggleSidebar = (): void => {
  sidebarCollapsed.value = !sidebarCollapsed.value
}

/** 新建对话 */
const handleNewChat = (): void => {
  createSession()
  inputMessage.value = ''
  scrollToBottom()
}

/** 切换会话 */
const handleSwitchSession = (id: string): void => {
  switchSession(id)
  scrollToBottom()
}

/** 删除会话（阻止冒泡，避免触发展开该会话） */
const handleDeleteSession = (id: string, event: Event): void => {
  event.stopPropagation()
  deleteSession(id)
}

/** 进入会话重命名编辑态 */
const startEditSession = (session: { id: string; title: string }, event: Event): void => {
  event.stopPropagation()
  editingSessionId.value = session.id
  editingTitle.value = session.title
  nextTick(() => {
    editInputRef.value?.focus()
    editInputRef.value?.select()
  })
}

/** 退出重命名编辑态（不保存） */
const cancelEditSession = (): void => {
  editingSessionId.value = null
  editingTitle.value = ''
}

/** 完成重命名：标题非空时提交，随后退出编辑态 */
const finishEditSession = (): void => {
  if (editingSessionId.value && editingTitle.value.trim()) {
    renameSession(editingSessionId.value, editingTitle.value.trim())
  }
  cancelEditSession()
}

/** 输入框自适应高度（上限 200px） */
const handleInput = (event: Event): void => {
  const target = event.target as HTMLTextAreaElement
  target.style.height = 'auto'
  target.style.height = `${Math.min(target.scrollHeight, 200)}px`
}

/* ================================ 初始化 ================================ */

onMounted(() => {
  initSessions()
  scrollToBottom()

  // 支持从首页带 prompt 参数跳转，直接填入输入框
  const prompt = route.query.prompt as string
  if (prompt) {
    inputMessage.value = prompt
  }

  // 预登录：需要登录的接口在进入页面时建立会话并缓存，避免首次对话时登录等待
  ensureEndpointLogin().catch(() => {
    /* 预登录失败不打断页面，发送消息时会再次登录并提示具体错误 */
  })
})
</script>

<template>
  <div class="chat-app">
    <!-- 侧边栏 -->
    <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="sidebar-header">
        <!-- 点击品牌区（圆点 AI 与图标）返回首页 -->
        <button v-show="!sidebarCollapsed" class="brand" title="返回首页" @click="goHome">
          <span class="brand-name">圆点 AI</span>
        </button>
        <button
          class="collapse-btn"
          :title="sidebarCollapsed ? '展开' : '收起'"
          @click="toggleSidebar"
        >
          <el-icon><Fold v-if="!sidebarCollapsed" /><Expand v-else /></el-icon>
        </button>
      </div>

      <button class="new-chat-btn" @click="handleNewChat">
        <el-icon><Plus /></el-icon>
        <span v-show="!sidebarCollapsed">新建对话</span>
      </button>

      <div v-show="!sidebarCollapsed" class="sessions-list">
        <div class="sessions-list-header">
          <span>会话列表</span>
          <span class="sessions-count">{{ sessions.length }}</span>
        </div>
        <div class="sessions-items">
          <div
            v-for="session in sessions"
            :key="session.id"
            class="session-item"
            :class="{ active: session.id === currentSessionId }"
            @click="handleSwitchSession(session.id)"
          >
            <div class="session-item-content">
              <div v-if="editingSessionId === session.id" class="session-edit" @click.stop>
                <input
                  ref="editInputRef"
                  v-model="editingTitle"
                  class="session-edit-input"
                  @keydown.enter="finishEditSession"
                  @keydown.esc="cancelEditSession"
                  @blur="finishEditSession"
                />
              </div>
              <template v-else>
                <div class="session-title">{{ session.title }}</div>
                <div class="session-meta">
                  <span class="session-time">{{ formatSessionTime(session.updatedAt) }}</span>
                  <span class="session-msg-count">{{ session.messages.length }} 条</span>
                </div>
              </template>
            </div>
            <div v-if="editingSessionId !== session.id" class="session-actions">
              <button
                class="session-action-btn"
                title="重命名"
                @click="startEditSession(session, $event)"
              >
                <el-icon><Edit /></el-icon>
              </button>
              <button
                class="session-action-btn danger"
                title="删除"
                @click="handleDeleteSession(session.id, $event)"
              >
                <el-icon><Delete /></el-icon>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div v-show="!sidebarCollapsed" class="sidebar-footer">
        <div class="connection-status" :class="{ connected: activeEndpointName !== '' }">
          <span class="status-dot"></span>
          <span>{{ activeEndpointName || '未启用对话接口' }}</span>
        </div>
      </div>
    </aside>

    <!-- 主聊天区 -->
    <main class="chat-main">
      <!-- 顶部栏 -->
      <header class="chat-header">
        <div class="header-info">
          <button class="home-btn" title="返回首页" @click="goHome">
            <el-icon><HomeFilled /></el-icon>
          </button>
          <div class="header-title-group">
            <h1 class="header-title">{{ currentSession?.title || '圆点 AI' }}</h1>
            <span class="header-subtitle">智能助手 · 多会话模式</span>
          </div>
        </div>
        <div class="header-actions">
          <el-button text :disabled="isLoading" @click="clearCurrentSession">
            <el-icon><Delete /></el-icon>
            <span>清空</span>
          </el-button>
        </div>
      </header>

      <!-- 消息区域 -->
      <div ref="messagesContainer" class="messages-area">
        <div class="messages-list">
          <div v-for="msg in messages" :key="msg.id" class="message-wrapper" :class="msg.role">
            <!-- 用户消息 -->
            <template v-if="msg.role === 'user'">
              <div class="user-message">
                <!-- 我的头像：Element Avatar 图标（蓝色）；row-reverse 下首个子元素渲染在最右侧 -->
                <div class="message-avatar user-avatar">
                  <el-icon :size="32" color="#1296db"><Avatar /></el-icon>
                </div>
                <div class="message-bubble">
                  <!-- 随消息发送的图片（Cache/chat/pic/会话id/） -->
                  <div v-if="msg.images && msg.images.length > 0" class="msg-images">
                    <img
                      v-for="p in msg.images"
                      :key="p"
                      class="msg-image"
                      :src="imageSrc(p)"
                      alt="图片"
                    />
                  </div>
                  <div class="message-text">{{ msg.content }}</div>
                  <!-- 随消息发送的文件（Cache/chat/file/会话id/） -->
                  <div v-if="msg.files && msg.files.length > 0" class="msg-files">
                    <span v-for="p in msg.files" :key="p" class="msg-file" :title="p">
                      📄 {{ p.split('/').pop()?.replace(/^\d+-/, '') }}
                    </span>
                  </div>
                </div>
              </div>
              <div class="message-time user-time">
                {{
                  msg.timestamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
                }}
              </div>
            </template>

            <!-- 机器人消息 -->
            <template v-else>
              <AssistantMessage
                :content="msg.content"
                :timestamp="msg.timestamp"
                :is-streaming="msg.isStreaming"
                :show-thinking="deepThink"
              />
            </template>
          </div>
        </div>
      </div>

      <!-- 输入区域 -->
      <div class="input-area">
        <!-- 待发送附件预览（图片缩略图 + 文件名标签） -->
        <div v-if="pendingImages.length > 0 || pendingFiles.length > 0" class="pending-attachments">
          <div v-for="img in pendingImages" :key="img.path" class="pending-image-item">
            <img class="pending-image" :src="img.dataUrl" :alt="img.name" />
            <button class="pending-image-remove" title="移除" @click="removePendingImage(img)">
              <el-icon><Delete /></el-icon>
            </button>
          </div>
          <div v-for="f in pendingFiles" :key="f.path" class="pending-file-item">
            <span class="pending-file-name" :title="f.path">{{ f.name }}</span>
            <button class="pending-image-remove" title="移除" @click="removePendingFile(f)">
              <el-icon><Delete /></el-icon>
            </button>
          </div>
        </div>
        <div class="input-container">
          <textarea
            ref="inputTextarea"
            v-model="inputMessage"
            class="input-textarea"
            placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
            :disabled="isLoading"
            rows="2"
            @keydown.enter.exact.prevent="sendMessage"
            @input="handleInput"
            @paste="handlePaste"
          ></textarea>
        </div>
        <!-- 输入框下方功能区：左侧智能体选择，右侧附件 / 深度思考 / 发送 -->
        <div class="input-toolbar">
          <el-dropdown class="agent-select" trigger="click" @command="selectAgent">
            <button class="agent-btn" :disabled="isLoading" title="选择智能体">
              <span class="agent-dot"></span>
              <span class="agent-name">{{ agentName }}</span>
              <span class="agent-caret">▾</span>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="chat" :class="{ active: selectedAgentId === 'chat' }">
                  对话
                </el-dropdown-item>
                <el-dropdown-item
                  v-for="ep in settings.chatEndpoints"
                  :key="ep.id"
                  :command="ep.id"
                  :class="{ active: selectedAgentId === ep.id }"
                >
                  {{ ep.name }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>

          <div class="toolbar-right">
            <!-- 隐藏的附件选择输入：不限制类型，图片与文件均支持 -->
            <input
              ref="attachmentInputRef"
              type="file"
              multiple
              style="display: none"
              @change="handleAttachmentSelect"
            />
            <button
              class="tool-btn"
              :disabled="isLoading"
              title="附件（图片 / 文件）"
              @click="attachmentInputRef?.click()"
            >
              <img class="tool-icon" :src="fujianSvg" alt="附件" />
            </button>
            <button
              class="tool-btn"
              :class="{ active: deepThink }"
              :disabled="isLoading"
              :title="deepThink ? '深度思考：已开启' : '深度思考：已关闭'"
              @click="deepThink = !deepThink"
            >
              <img class="tool-icon" :src="deepThink ? sikaoSvg : sikaoHuiSvg" alt="深度思考" />
            </button>
            <span class="toolbar-divider"></span>
            <!-- 发送按钮：空闲时为发送图标，生成中变为停止按钮 -->
            <button
              class="send-btn"
              :class="{ stop: isLoading }"
              :disabled="isLoading"
              :title="isLoading ? '停止生成' : '发送'"
              @click="isLoading ? stopGenerating() : sendMessage()"
            >
              <span v-if="isLoading" class="stop-square"></span>
              <el-icon v-else><Promotion /></el-icon>
            </button>
          </div>
        </div>
        <p class="input-hint">AI 助手可能产生错误信息，请核实重要内容</p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.chat-app {
  height: 100vh;
  display: flex;
  background: var(--color-bg);
  transition: background-color 0.3s;
  overflow: hidden;
}

/* 侧边栏 */
.sidebar {
  width: 280px;
  display: flex;
  flex-direction: column;
  background: var(--color-card);
  border-right: 1px solid var(--color-border);
  transition:
    width 0.25s ease,
    background-color 0.3s,
    border-color 0.3s;
  flex-shrink: 0;
}

.sidebar.collapsed {
  width: 68px;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--color-border);
}

/* 品牌区（可点击返回首页） */
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: 8px;
  transition: background-color 0.2s;
}

.brand:hover {
  background: var(--color-hover);
}

.brand-logo {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-primary);
  border-radius: 8px;
  color: white;
  flex-shrink: 0;
}

.brand-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text);
  letter-spacing: 0.5px;
}

.collapse-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.collapse-btn:hover {
  background: var(--color-hover);
  color: var(--color-primary);
}

.new-chat-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 12px;
  padding: 12px;
  border: 1px dashed var(--color-border);
  background: transparent;
  color: var(--color-text);
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transition: all 0.2s;
}

.new-chat-btn:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
  background: var(--color-hover);
}

.sessions-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 0 8px;
  overflow: hidden;
}

.sessions-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 8px;
  font-size: 12px;
  color: var(--color-text-secondary);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.sessions-count {
  background: var(--color-hover);
  color: var(--color-text-secondary);
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
}

.sessions-items {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sessions-items::-webkit-scrollbar {
  width: 6px;
}

.sessions-items::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: 3px;
}

.session-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
  position: relative;
}

.session-item:hover {
  background: var(--color-hover);
}

.session-item.active {
  background: color-mix(in srgb, var(--color-primary) 10%, var(--color-card));
}

.session-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 60%;
  background: var(--color-primary);
  border-radius: 0 3px 3px 0;
}

.session-item-content {
  flex: 1;
  min-width: 0;
}

.session-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-meta {
  display: flex;
  gap: 8px;
  margin-top: 3px;
  font-size: 11px;
  color: var(--color-text-secondary);
}

.session-edit {
  width: 100%;
}

.session-edit-input {
  width: 100%;
  padding: 4px 8px;
  border: 1px solid var(--color-primary);
  border-radius: 4px;
  font-size: 13px;
  background: var(--color-card);
  color: var(--color-text);
  outline: none;
}

.session-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}

.session-item:hover .session-actions {
  opacity: 1;
}

.session-action-btn {
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.session-action-btn:hover {
  background: var(--color-hover);
  color: var(--color-text-secondary);
}

.session-action-btn.danger:hover {
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
  color: var(--color-danger);
}

.sidebar-footer {
  padding: 12px 16px;
  border-top: 1px solid var(--color-border);
}

.connection-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-danger);
  transition: background 0.3s;
}

.connection-status.connected .status-dot {
  background: var(--color-success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-success) 20%, transparent);
}

/* 主聊天区 */
.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--color-bg);
}

.chat-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 24px;
  background: color-mix(in srgb, var(--color-card) 70%, transparent);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--color-border);
  transition:
    background-color 0.3s,
    border-color 0.3s;
}

.header-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.home-btn {
  width: 36px;
  height: 36px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  transition: all 0.2s;
}

.home-btn:hover {
  background: var(--color-hover);
  color: var(--color-primary);
}

.header-title-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.header-title {
  font-size: 17px;
  font-weight: 600;
  color: var(--color-text);
  letter-spacing: 0.3px;
}

.header-subtitle {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.messages-area {
  flex: 1;
  overflow-y: auto;
  padding: 24px 0;
}

.messages-area::-webkit-scrollbar {
  width: 8px;
}

.messages-area::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: 4px;
}

.messages-list {
  /* 宽屏自适应：上限 1080px，窄屏时左右留 24px 边距，避免大屏留白过多 */
  max-width: min(1280px, calc(100% - 48px));
  margin: 0 auto;
  padding: 0 8px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.message-wrapper {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.message-wrapper.user {
  align-items: flex-end;
}

.user-message {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  flex-direction: row-reverse;
  max-width: 75%;
}

.message-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 13px;
  font-weight: 600;
  align-self: flex-start;
  background: transparent;
}

.user-avatar {
  background: transparent;
  border: none;
  color: #1296db;
}

.message-bubble {
  background: var(--color-card);
  border-radius: 4px 16px 16px 16px;
  padding: 12px 16px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

.user-message .message-bubble {
  background: var(--color-primary);
  color: white;
  border-radius: 16px 4px 16px 16px;
}

.message-text {
  font-size: 14.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.message-time {
  font-size: 11px;
  color: var(--color-text-secondary);
  padding: 0 44px 0 0;
}

.user-time {
  padding: 0 44px 0 0;
}

/* 输入区域 */
.input-area {
  padding: 16px 32px 20px;
  background: transparent;
}

/* 待发送附件预览条（图片缩略图 + 文件标签） */
.pending-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  max-width: min(1280px, calc(100% - 48px));
  margin: 0 auto 8px;
}

.pending-image-item {
  position: relative;
  width: 72px;
  height: 72px;
  border-radius: 8px;
  /* 不裁剪溢出：右上角删除按钮悬浮在容器外 */
  border: 1px solid var(--color-border);
}

.pending-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  border-radius: 8px;
}

/* 待发送文件标签 */
.pending-file-item {
  position: relative;
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 26px 0 10px;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--color-card);
  max-width: 220px;
}

.pending-file-name {
  font-size: 12px;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pending-image-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  font-size: 11px;
}

.pending-image-remove:hover {
  background: rgba(0, 0, 0, 0.75);
}

/* 图片选择按钮 */
.image-btn {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 18px;
  transition: all 0.15s;
}

.image-btn:hover:not(:disabled) {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}

.image-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 用户消息气泡内图片 */
.msg-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.msg-image {
  max-width: 220px;
  max-height: 160px;
  border-radius: 8px;
  object-fit: cover;
  display: block;
  cursor: zoom-in;
}

/* 用户消息气泡内文件标签 */
.msg-files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.msg-file {
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.25);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.input-container {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  max-width: min(1280px, calc(100% - 48px));
  margin: 0 auto;
  background: var(--color-card);
  border: 1px solid var(--color-border);
  border-radius: 16px;
  padding: 8px 8px 8px 16px;
  box-shadow: var(--shadow-card);
  transition: all 0.2s;
}

.input-container:focus-within {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 12%, transparent);
}

.input-textarea {
  flex: 1;
  border: none;
  background: transparent;
  outline: none;
  resize: none;
  /* 默认展示 2 行（rows=2，随内容自动增高，上限 200px） */
  min-height: 44px;
  padding: 8px 0;
  font-size: 14.5px;
  line-height: 1.5;
  color: var(--color-text);
  font-family: inherit;
  max-height: 200px;
}

.input-textarea::placeholder {
  color: var(--color-text-secondary);
}

/* ===== 输入框下方功能区 ===== */
.input-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  max-width: min(1280px, calc(100% - 48px));
  margin: 8px auto 0;
  padding: 0 4px;
}

/* 左侧：智能体选择 */
.agent-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--color-card);
  padding: 4px 10px;
  cursor: pointer;
  font-size: 12px;
  color: var(--color-text);
  transition: all 0.15s;
}

.agent-btn:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.agent-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.agent-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-primary);
}

.agent-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-caret {
  font-size: 10px;
  color: var(--color-text-secondary);
}

/* 右侧：附件 / 深度思考 / 分割线 / 发送 */
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 附件与思考：尺寸为发送按钮（36px）的一半 */
.tool-btn {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 8px;
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s;
}

.tool-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}

.tool-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 深度思考开启态：淡色底突出 */
.tool-btn.active {
  background: color-mix(in srgb, var(--color-primary) 14%, transparent);
}

.tool-icon {
  width: 18px;
  height: 18px;
  display: block;
}

/* 附件/思考组与发送按钮之间的分割线 */
.toolbar-divider {
  width: 1px;
  height: 18px;
  background: var(--color-border);
  margin: 0 4px;
}

.send-btn {
  width: 36px;
  height: 36px;
  border: none;
  background: var(--color-primary);
  color: white;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  transition: all 0.2s;
  flex-shrink: 0;
}

.send-btn:hover:not(:disabled) {
  transform: scale(1.05);
  box-shadow: var(--shadow-card-hover);
}

.send-btn:disabled {
  background: var(--color-border);
  cursor: not-allowed;
}

/* 生成中：按钮变为红色停止样式 */
.send-btn.stop {
  background: var(--color-danger);
}

.stop-square {
  width: 12px;
  height: 12px;
  background: #ffffff;
  border-radius: 2px;
}

.input-hint {
  text-align: center;
  font-size: 11px;
  color: var(--color-text-secondary);
  margin: 10px 0 0;
}
</style>
