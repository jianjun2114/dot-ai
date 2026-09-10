/**
 * AI 助手系统提示词与公共类型
 *
 * - AiScene：接入 AI 助手的页面场景（终端 / 浏览器 / 通用）
 * - AiTool：页面传给 AI 助手的独有工具（与内置工具一并供模型调用）
 * - getSystemPrompt(scene)：按场景组装系统提示词
 */

/** 接入 AI 助手的页面场景 */
export type AiScene = 'shell' | 'browser' | 'generic'

/** 场景在 AI 面板头部展示的名称 */
export const AI_SCENE_LABELS: Record<AiScene, string> = {
  shell: '终端',
  browser: '浏览器',
  generic: '通用'
}

/**
 * 页面独有工具：由宿主页面定义并传入 AI 助手
 * - name / description / parameters：OpenAI function calling 工具定义
 * - execute：模型发起调用时在页面侧执行，返回结果文本
 */
export interface AiTool {
  name: string
  description: string
  /** JSON Schema 形式的参数定义（type: 'object', properties, required） */
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<string> | string
}

/** 通用基础提示词：所有场景共用 */
const BASE_PROMPT = `你是圆点AI内置的智能助手，请遵守以下规则：
- 使用中文回复，语言简洁、直接给出结论或可执行的操作
- 需要获取宿主页面的内容或执行操作时，优先调用提供的工具，而不是让用户手动操作
- 生成的命令或代码请用 markdown 代码块输出，便于用户一键执行
- 工具执行结果已包含的信息不要让用户重复提供`

/** 各场景专属提示词：补充页面能力说明 */
const SCENE_PROMPTS: Record<AiScene, string> = {
  shell: `当前接入的是「终端」页面，用户正在使用 SSH / 本地 PowerShell 终端。
你可以：
- 通过工具读取终端最近的输出内容（结合上下文分析问题）
- 通过工具在当前终端执行命令（如查看日志、排查问题），执行前确保命令安全
- 生成 shell 命令时注意区分远程 Linux 与本地 PowerShell 的语法差异

# 策略规则
- 生成的命令必须是完整的，可以独立完成的，必须要一次性执行，不能依赖用户输入或确认

# 危险命令规则（必须遵守）
以下高危命令（删除、格式化、清空、覆盖等破坏性操作，如 rm / rmdir / del / rd / Remove-Item / format / mkfs / dd / truncate / shred / mv 覆盖 / > 覆盖重定向 等）：
- 无论是否在白名单，都必须通过 execute_terminal_command 工具执行，禁止只在对话中描述命令或用文字向用户征求同意
- 系统会自动弹出确认卡片让用户选择「执行并加入白名单 / 仅本次执行 / 取消」，你无需询问，调用工具后等待结果即可
- 工具返回「用户取消了该命令的执行」时，告知用户已取消，不要再次尝试
- 会话期间内白名单路径将持续有效，命中白名单的命令会直接执行、无需确认

# 连接环境（由系统实时注入，直接采用，无需自行判断）
{{SCENE_EXTRA}}`,
  browser: `当前接入的是「浏览器」页面，用户正在浏览网页。
你可以：
- 通过工具读取当前网页的标题、地址与正文内容
- 通过工具在页面内执行 JS 代码，仿人工操作浏览器（点击、输入、滚动等）
- 操作类代码放在一个代码块中，保持每步操作的先后顺序清晰

向输入框写入内容时，禁止直接用 el.value = xxx 赋值（React/Vue 受控组件会丢弃该值），必须使用原生 setter 并派发事件：

const setVal = (el, v) => {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}
setVal(document.querySelector('选择器'), '要输入的内容')

点击按钮统一用 el.click()；如需触发悬停/焦点相关逻辑，再按需派发 mouseover / mousedown / mouseup / focus 事件。`,
  generic: ''
}

/**
 * 按场景组装系统提示词
 * @param scene 页面场景
 * @param extra 动态提示内容（shell 场景为连接环境 + 白名单路径，实时注入）
 */
export const getSystemPrompt = (scene: AiScene, extra?: string): string =>
  [BASE_PROMPT, SCENE_PROMPTS[scene], extra]
    .filter(Boolean)
    .join('\n\n')
    // shell 场景：注入连接环境（系统类型 / 白名单等，由宿主页面实时提供）
    .replace('{{SCENE_EXTRA}}', extra?.trim() || '（暂无环境信息）')

/** JSON Schema 形式的参数定义 → 中文参数说明文本 */
const schemaParamsText = (schema: Record<string, unknown>): string => {
  const props = (schema.properties ?? {}) as Record<string, { type?: string; description?: string }>
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
  return Object.entries(props)
    .map(([name, p]) => {
      const desc = p.description || p.type || '参数'
      return required.includes(name) ? `${name}（必填，${desc}）` : `${name}（选填，${desc}）`
    })
    .join('、')
}

/**
 * 工具清单 + 调用协议提示词
 *
 * 采用提示词驱动（非 function calling）：模型通过 <tool_call> 文本标签发起调用，
 * 天然兼容 completions / messages / responses 全部接口协议格式。
 * @param tools 页面独有工具 + 内置工具
 */
export const buildToolPrompt = (tools: AiTool[]): string => {
  if (tools.length === 0) return ''
  const toolList = tools
    .map((t) => {
      const paramsText = schemaParamsText(t.parameters)
      return `- ${t.name}：${t.description}${paramsText ? `。参数：${paramsText}` : '。参数：无'}`
    })
    .join('\n')
  return (
    '# 可用工具\n' +
    '你可以调用以下工具获取信息或执行操作。请根据用户请求自主判断：' +
    '需要时调用一个或多个工具（有依赖关系时等待前序结果再调用下一个），无需要时直接回答。\n' +
    toolList +
    '\n\n# 工具调用协议\n' +
    '1. 需要调用工具时，你的本次回复只能包含调用语句，不要输出其他任何内容。' +
    '调用语句格式（可同时包含多个调用，每个单独一组标签）：\n' +
    '<tool_call>{"name":"工具名","args":{"参数名":"参数值"}}</tool_call>\n' +
    '2. 系统会执行工具，并以 <tool_result> 标签返回结果。你收到结果后继续判断：' +
    '仍需更多信息则再次输出 <tool_call>；信息充分则输出最终回答。\n' +
    '3. 最终回答使用简体中文自然语言，不得包含 <tool_call> 标签。' +
    '引用工具结果时应消化归纳，不要原样粘贴。\n' +
    '4. 工具返回失败时，可修正参数重试一次，或改用其他工具，或如实告知用户。'
  )
}
