<script setup lang="ts">
import { ref, onMounted, nextTick, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Plus, Delete, Edit, Fold, Expand, Promotion, HomeFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useSettings } from '../composables/useSettings'
import { useChatSessions } from '../composables/useChatSessions'
import { chat, ensureEndpointLogin } from '../composables/aichat'
import AssistantMessage from '../components/AssistantMessage.vue'

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

/* ================================ 工具函数 ================================ */

/** 等待 DOM 更新后滚动到消息底部 */
const scrollToBottom = async (): Promise<void> => {
  await nextTick()
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
  }
}

/** 聚焦输入框：需等待 textarea 解除禁用（isLoading 复位）后 */
const focusInput = (): void => {
  nextTick(() => inputTextarea.value?.focus())
}

/* ================================ 发送与停止 ================================ */

/** 发送消息：调用「智能对话」中启用的接口，流式渲染回复 */
const sendMessage = async (): Promise<void> => {
  const userInput = inputMessage.value.trim()
  if (!userInput || isLoading.value) return

  // 确保有会话
  if (!currentSession.value) createSession()

  // 本地模式历史对话：取本次用户消息之前的会话消息（按时间正序）
  const history = (currentSession.value?.messages ?? [])
    .filter((m) => m.content.trim() && !m.isStreaming)
    .map((m) => ({ role: m.role, content: m.content }))

  // 追加用户消息与助手占位消息，占位消息随流式返回逐步填充
  addMessage({
    id: Date.now(),
    role: 'user',
    content: userInput,
    timestamp: new Date()
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
  isLoading.value = true
  const controller = new AbortController()
  currentController = controller
  scrollToBottom()

  // 流式累积：每次增量追加到占位消息，实现实时渲染
  let acc = ''
  try {
    const result = await chat(userInput, {
      history,
      signal: controller.signal,
      onDelta: (delta) => {
        acc += delta
        updateMessage(currentSession.value!.id, placeholderId, { content: acc })
      }
    })
    updateMessage(currentSession.value!.id, placeholderId, {
      content: result.reply,
      isStreaming: false
    })
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
    updateMessage(currentSession.value.id, currentStreamingId.value, {
      isStreaming: false,
      content: '（已停止生成）'
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
          <span class="brand-logo">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
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
          </span>
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
                <div class="message-bubble">
                  <div class="message-text">{{ msg.content }}</div>
                </div>
                <div class="message-avatar user-avatar">U</div>
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
              />
            </template>
          </div>
        </div>
      </div>

      <!-- 输入区域 -->
      <div class="input-area">
        <div class="input-container">
          <textarea
            ref="inputTextarea"
            v-model="inputMessage"
            class="input-textarea"
            placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
            :disabled="isLoading"
            rows="1"
            @keydown.enter.exact.prevent="sendMessage"
            @input="handleInput"
          ></textarea>
          <!-- 发送按钮：空闲时为发送图标，生成中变为停止按钮 -->
          <button
            class="send-btn"
            :class="{ stop: isLoading }"
            :disabled="!isLoading && !inputMessage.trim()"
            :title="isLoading ? '停止生成' : '发送'"
            @click="isLoading ? stopGenerating() : sendMessage()"
          >
            <span v-if="isLoading" class="stop-square"></span>
            <el-icon v-else><Promotion /></el-icon>
          </button>
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
  max-width: 800px;
  margin: 0 auto;
  padding: 0 32px;
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
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 13px;
  font-weight: 600;
}

.user-avatar {
  background: var(--color-primary);
  color: white;
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

.input-container {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  max-width: 800px;
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
