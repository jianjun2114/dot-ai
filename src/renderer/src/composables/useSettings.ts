/**
 * 设置数据读写 composable
 *
 * - 配置持久化到应用根目录的 dot.json（Electron 环境），浏览器环境降级到 localStorage
 * - 模块级单例：所有组件共享同一份响应式状态
 * - 数据变化时自动保存（深度监听）
 * - 兼容旧配置键：写入 apiKey / model / apiUrl（供旧版本功能读取）
 */
import { ref, watch } from 'vue'
import type { AppSettings, McpConfig } from '../types/settings'
import { getAppPath } from '../utils/config'

/** 默认配置 */
const DEFAULT_SETTINGS: AppSettings = {
  calendarNotesPath: '',
  chatEndpoints: [],
  llmConfigs: [],
  mcpConfigs: [],
  skillConfigs: []
}

const STORAGE_KEY = 'dot-settings'

/** 模块级共享状态 */
const settings = ref<AppSettings>(structuredClone(DEFAULT_SETTINGS))

/** 是否已完成首次加载（避免加载过程触发自动保存覆盖配置） */
let loaded = false

/** 深合并：以默认值兜底，防止旧版本配置缺字段 */
function mergeWithDefaults(raw: Partial<AppSettings>): AppSettings {
  return {
    calendarNotesPath: raw.calendarNotesPath ?? '',
    chatEndpoints: raw.chatEndpoints ?? [],
    llmConfigs: (raw.llmConfigs ?? []).map((c) => ({ ...c, enabled: c.enabled ?? false })),
    mcpConfigs: (raw.mcpConfigs ?? []).map((m) => {
      // 旧版本为 url 字段，迁移为 JSON 格式配置文本
      const legacy = m as McpConfig & { url?: string }
      return {
        ...m,
        configJson:
          m.configJson ??
          (legacy.url
            ? JSON.stringify({ mcpServers: { [m.name]: { url: legacy.url } } }, null, 2)
            : ''),
        serverInfo: m.serverInfo ?? ''
      }
    }),
    skillConfigs: raw.skillConfigs ?? []
  }
}

/** 从 dot.json 读取原始配置对象 */
async function readRawSettings(): Promise<Record<string, unknown>> {
  if (window.dot) {
    const appPath = await getAppPath()
    const filePath = `${appPath}/dot.json`
    const exists = (await window.dot.localFiles('exists', filePath)) as boolean
    if (!exists) return {}
    const content = (await window.dot.localFiles('read', filePath)) as string
    return JSON.parse(content)
  }
  const saved = localStorage.getItem(STORAGE_KEY)
  return saved ? JSON.parse(saved) : {}
}

/** 加载配置（设置页挂载时调用） */
export async function loadSettings(): Promise<void> {
  try {
    const raw = await readRawSettings()
    settings.value = mergeWithDefaults(raw as Partial<AppSettings>)
  } catch (error) {
    console.error('加载设置失败:', error)
    settings.value = structuredClone(DEFAULT_SETTINGS)
  } finally {
    loaded = true
  }
}

/** 保存配置 */
async function saveSettings(): Promise<void> {
  if (!loaded) return
  try {
    // 派生旧配置键，保持对旧版本功能的兼容（优先使用启用中的大模型）
    const activeLlm =
      settings.value.llmConfigs.find((c) => c.enabled) ?? settings.value.llmConfigs[0]
    const compat: Record<string, unknown> = {
      calendarNotesPath: settings.value.calendarNotesPath,
      chatEndpoints: settings.value.chatEndpoints,
      llmConfigs: settings.value.llmConfigs,
      mcpConfigs: settings.value.mcpConfigs,
      skillConfigs: settings.value.skillConfigs
    }
    if (activeLlm) {
      compat.apiKey = activeLlm.apiKey
      compat.model = activeLlm.model
      compat.apiUrl = activeLlm.baseUrl
    }

    if (window.dot) {
      const appPath = await getAppPath()
      const filePath = `${appPath}/dot.json`
      await window.dot.localFiles('write', filePath, JSON.stringify(compat, null, 2))
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(compat))
    }
  } catch (error) {
    console.error('保存设置失败:', error)
  }
}

// 任何配置变化自动保存
watch(settings, saveSettings, { deep: true })

/** 设置共享状态（供各设置子模块使用） */
export function useSettings(): { settings: typeof settings } {
  return { settings }
}
