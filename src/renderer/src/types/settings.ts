/**
 * 设置模块类型定义
 *
 * 覆盖设置页四大模块中需要持久化的数据结构：
 * - 通用设置（记事本目录）
 * - 智能配置（大模型 / MCP / SKILL）
 * - 智能对话（对话接口列表）
 */

/** 对话接口的连接模式 */
export type EndpointMode = 'http' | 'ws' | 'local'

/** 大模型接口协议格式：completions（OpenAI Chat）/ messages（Anthropic）/ responses（OpenAI Responses） */
export type LlmApiFormat = 'completions' | 'messages' | 'responses'

/** 智能配置的分类 */
export type SmartConfigType = 'llm' | 'mcp' | 'skill' | 'builtin'

/** 对话接口的登录配置（needLogin 为 true 时生效） */
export interface EndpointLogin {
  /** 登录接口地址 */
  loginUrl: string
  /** 登录参数（JSON 字符串） */
  loginParams: string
  /** 会话保持方式说明（如 token 提取字段 / Cookie 名） */
  sessionKeep: string
}

/** 智能对话 - 对话接口配置 */
export interface ChatEndpoint {
  id: string
  /** 接口名称 */
  name: string
  /** key 值（用于标识） */
  key: string
  /** 连接模式：HTTP / WebSocket / 本地大模型 */
  mode: EndpointMode
  /** 对话接口地址（HTTP / WS 模式使用） */
  apiUrl: string
  /** 是否需要登录 */
  needLogin: boolean
  /** 登录配置 */
  login: EndpointLogin
  /** 本地模式下关联的大模型配置 id */
  localModelId: string
  /** 是否启用（全局互斥，同时只能启用一个） */
  enabled: boolean
}

/** 智能配置 - 大模型配置 */
export interface LlmConfig {
  id: string
  /** 配置名称 */
  name: string
  /** 接口基础地址（如 http://api.example.com，不含 /v1，统一由请求层补齐） */
  baseUrl: string
  /** API 密钥 */
  apiKey: string
  /** 模型名称 */
  model: string
  /** 接口协议格式（旧数据缺省时按 completions 处理） */
  apiFormat?: LlmApiFormat
  /** 是否启用（列表内互斥，同时只能启用一个） */
  enabled: boolean
}

/** 智能配置 - MCP 服务配置 */
export interface McpConfig {
  id: string
  /** 服务名称 */
  name: string
  /** JSON 格式的 MCP 配置文本（mcpServers 标准格式） */
  configJson: string
  /** 通过"获取工具列表"拉取到的工具名列表 */
  tools: string[]
  /** 通过"获取服务信息"获取到的服务描述 */
  serverInfo: string
}

/** 智能配置 - SKILL 配置 */
export interface SkillConfig {
  id: string
  /** 技能名称 */
  name: string
  /** 技能描述 */
  description: string
  /** 提示词内容 */
  prompt: string
}

/** 设置持久化结构（对应 dot.json 中的字段） */
export interface AppSettings {
  /** 记事本根目录 */
  calendarNotesPath: string
  /** 智能对话接口列表 */
  chatEndpoints: ChatEndpoint[]
  /** 大模型配置列表 */
  llmConfigs: LlmConfig[]
  /** MCP 配置列表 */
  mcpConfigs: McpConfig[]
  /** SKILL 配置列表 */
  skillConfigs: SkillConfig[]
}

/** 生成短随机 id（用于新增配置项） */
export function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
