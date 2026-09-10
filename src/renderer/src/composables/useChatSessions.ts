import { ref, computed, watch } from 'vue'

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  isStreaming?: boolean
}

export interface ChatSession {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
  /** 服务端对话会话 id（首轮为空，服务端返回后保存，后续每条消息携带） */
  sessionId?: string
}

const STORAGE_KEY = 'dot-ai-chat-sessions'

// 全局会话状态
const sessions = ref<ChatSession[]>([])
const currentSessionId = ref<string | null>(null)

// 从 localStorage 加载
const loadSessions = (): void => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const data = JSON.parse(raw) as ChatSession[]
      // 还原 timestamp 为 Date 对象
      sessions.value = data.map((s) => ({
        ...s,
        messages: s.messages.map((m) => ({
          ...m,
          timestamp: new Date(m.timestamp)
        }))
      }))
    }
  } catch (e) {
    console.error('加载会话失败:', e)
    sessions.value = []
  }
}

// 持久化到 localStorage
const saveSessions = (): void => {
  try {
    // 移除流式标记后保存
    const data = sessions.value.map((s) => ({
      ...s,
      messages: s.messages.map((m) => ({
        ...m,
        timestamp: m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp),
        isStreaming: false
      }))
    }))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch (e) {
    console.error('保存会话失败:', e)
  }
}

// 自动生成会话标题
const generateTitle = (content: string): string => {
  const trimmed = content.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= 20) return trimmed
  return trimmed.slice(0, 20) + '...'
}

// 当前会话
const currentSession = computed(() => {
  return sessions.value.find((s) => s.id === currentSessionId.value) || null
})

// 创建新会话
const createSession = (): string => {
  const now = Date.now()
  const id = `session-${now}`
  const newSession: ChatSession = {
    id,
    title: '新的对话',
    messages: [
      {
        id: 0,
        role: 'assistant',
        content: '你好！我是圆点AI助手，有什么可以帮你的吗？',
        timestamp: new Date()
      }
    ],
    createdAt: now,
    updatedAt: now
  }
  sessions.value.unshift(newSession)
  currentSessionId.value = id
  saveSessions()
  return id
}

// 删除会话
const deleteSession = (id: string): void => {
  const idx = sessions.value.findIndex((s) => s.id === id)
  if (idx === -1) return

  sessions.value.splice(idx, 1)

  // 如果删除的是当前会话，切换到其他会话
  if (currentSessionId.value === id) {
    if (sessions.value.length > 0) {
      currentSessionId.value = sessions.value[0].id
    } else {
      currentSessionId.value = null
    }
  }
  saveSessions()
}

// 切换会话
const switchSession = (id: string): void => {
  const session = sessions.value.find((s) => s.id === id)
  if (session) {
    currentSessionId.value = id
  }
}

// 重命名会话
const renameSession = (id: string, title: string): void => {
  const session = sessions.value.find((s) => s.id === id)
  if (session) {
    session.title = title
    session.updatedAt = Date.now()
    saveSessions()
  }
}

// 添加消息到当前会话
const addMessage = (message: ChatMessage): void => {
  const session = currentSession.value
  if (!session) {
    // 没有当前会话，创建一个
    createSession()
  }

  const targetSession = currentSession.value
  if (targetSession) {
    targetSession.messages.push(message)
    targetSession.updatedAt = Date.now()

    // 如果是第一条用户消息，用作标题
    if (
      message.role === 'user' &&
      targetSession.messages.filter((m) => m.role === 'user').length === 1
    ) {
      targetSession.title = generateTitle(message.content)
    }
    saveSessions()
  }
}

// 更新消息
const updateMessage = (
  sessionId: string,
  messageId: number,
  updates: Partial<ChatMessage>
): void => {
  const session = sessions.value.find((s) => s.id === sessionId)
  if (!session) return
  const msg = session.messages.find((m) => m.id === messageId)
  if (msg) {
    Object.assign(msg, updates)
    session.updatedAt = Date.now()
    saveSessions()
  }
}

// 设置会话的服务端对话会话 id（服务端响应返回后保存，供后续消息携带）
const setSessionChatId = (id: string, chatId: string): void => {
  const session = sessions.value.find((s) => s.id === id)
  if (session) {
    session.sessionId = chatId
    saveSessions()
  }
}

// 清空当前会话
const clearCurrentSession = (): void => {
  const session = currentSession.value
  if (session) {
    session.messages = [
      {
        id: Date.now(),
        role: 'assistant',
        content: '你好！我是圆点AI助手，有什么可以帮你的吗？',
        timestamp: new Date()
      }
    ]
    session.title = '新的对话'
    session.updatedAt = Date.now()
    saveSessions()
  }
}

// 初始化
const initSessions = (): void => {
  loadSessions()
  // 如果没有会话，创建一个
  if (sessions.value.length === 0) {
    createSession()
  } else if (!currentSessionId.value) {
    currentSessionId.value = sessions.value[0].id
  }
}

// 监听变化自动保存
watch(
  sessions,
  () => {
    saveSessions()
  },
  { deep: true }
)

// 格式化时间
const formatSessionTime = (timestamp: number): string => {
  const now = Date.now()
  const diff = now - timestamp
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour

  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)}分钟前`
  if (diff < day) return `${Math.floor(diff / hour)}小时前`
  if (diff < 7 * day) return `${Math.floor(diff / day)}天前`

  const date = new Date(timestamp)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/** useChatSessions 返回的 API 集合 */
interface ChatSessionsApi {
  sessions: typeof sessions
  currentSessionId: typeof currentSessionId
  currentSession: typeof currentSession
  createSession: typeof createSession
  deleteSession: typeof deleteSession
  switchSession: typeof switchSession
  renameSession: typeof renameSession
  addMessage: typeof addMessage
  updateMessage: typeof updateMessage
  setSessionChatId: typeof setSessionChatId
  clearCurrentSession: typeof clearCurrentSession
  initSessions: typeof initSessions
  formatSessionTime: typeof formatSessionTime
  generateTitle: typeof generateTitle
}

export function useChatSessions(): ChatSessionsApi {
  return {
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
    formatSessionTime,
    generateTitle
  }
}
