/**
 * 内置（本地）AI 工具封装
 *
 * 工具列表展示于「智能配置 → 内置工具」，执行逻辑可供 AI 调用链复用：
 * - aiLocalTools：工具描述列表（含参数说明与执行函数）
 * - useAiLocalTools()：组合式获取工具列表
 * - executeLocalTool(id, args)：按 id 执行工具并返回结果文本
 */
import { fetchWeather } from '../utils/weather'

/** 工具参数说明 */
export interface AiLocalToolParam {
  name: string
  description: string
  required?: boolean
}

/** 内置工具描述 */
export interface AiLocalTool {
  id: string
  name: string
  description: string
  params: AiLocalToolParam[]
  /** 执行工具并返回结果文本 */
  execute: (args: Record<string, unknown>) => Promise<string>
}

/** 读取字符串参数，必填缺失时抛错 */
function argString(args: Record<string, unknown>, name: string, required = true): string {
  const v = args[name]
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (required) throw new Error(`缺少参数：${name}`)
  return ''
}

/** 读取数字参数，缺失或非法时使用默认值 */
function argNumber(args: Record<string, unknown>, name: string, fallback: number): number {
  const v = args[name]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** 去除 HTML 标签并还原常见实体 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 文本结果超长截断 */
function truncate(text: string, max = 5000): string {
  return text.length > max ? `${text.slice(0, max)}\n…（内容过长，已截断）` : text
}

/** 当前日期时间的中文格式化 */
function formatNow(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()]
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${week} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

/** 解析 DuckDuckGo HTML 搜索结果 */
function parseSearchResults(
  html: string,
  limit: number
): { title: string; url: string; snippet: string }[] {
  const results: { title: string; url: string; snippet: string }[] = []
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g
  const snippets: string[] = []
  let m: RegExpExecArray | null
  while ((m = snippetRe.exec(html)) !== null) snippets.push(stripHtml(m[1]))
  while ((m = linkRe.exec(html)) !== null) {
    let url = m[1]
    // DuckDuckGo 跳转链接形如 /l/?uddg=<encodeURIComponent 后的真实地址>
    const uddg = /[?&]uddg=([^&]+)/.exec(url)
    if (uddg) url = decodeURIComponent(uddg[1])
    if (url.startsWith('//')) url = `https:${url}`
    results.push({ title: stripHtml(m[2]), url, snippet: snippets[results.length] ?? '' })
    if (results.length >= limit) break
  }
  return results
}

/** 内置工具列表 */
export const aiLocalTools: AiLocalTool[] = [
  {
    id: 'get_current_date',
    name: '获取当前日期',
    description: '获取当前的日期、星期与时间',
    params: [],
    execute: async () => `当前时间：${formatNow()}`
  },
  {
    id: 'get_current_weather',
    name: '获取当前天气',
    description: '查询指定城市（不传则按 IP 定位）的实时天气',
    params: [{ name: 'city', description: '城市名称，如：北京', required: false }],
    execute: async (args) => {
      const city = argString(args, 'city', false)
      const w = await fetchWeather(city || undefined)
      if (w.weatherDesc === '暂无数据') return `未获取到「${w.city}」的天气数据`
      return `${w.city}：${w.weatherDesc}，气温 ${w.temperature}℃，体感 ${w.feelsLike}℃，湿度 ${w.humidity}%，风向风力 ${w.wind}（更新于 ${w.updatedAt}）`
    }
  },
  {
    id: 'read_file',
    name: '读本地电脑上文件内容',
    description: '读取本地文件的内容',
    params: [{ name: 'path', description: '文件绝对路径', required: true }],
    execute: async (args) => {
      const path = argString(args, 'path')
      const content = await window.dot.localFiles('read', path)
      if (typeof content !== 'string') throw new Error(`无法读取文件：${path}`)
      return truncate(content)
    }
  },
  {
    id: 'edit_file',
    name: '编辑本地电脑上文件内容',
    description: '将指定内容写入本地文件（覆盖原有内容）',
    params: [
      { name: 'path', description: '文件绝对路径', required: true },
      { name: 'content', description: '写入的完整内容', required: true }
    ],
    execute: async (args) => {
      const path = argString(args, 'path')
      const content = argString(args, 'content')
      await window.dot.localFiles('write', path, content)
      return `已写入文件：${path}`
    }
  },
  {
    id: 'run_command',
    name: '在本地终端执行终端命令',
    description: '在本地终端执行命令并返回输出',
    params: [
      { name: 'command', description: '要执行的命令', required: true },
      { name: 'cwd', description: '工作目录，不传则使用默认目录', required: false },
      { name: 'timeout', description: '超时毫秒数，默认 30000', required: false }
    ],
    execute: async (args) => {
      const command = argString(args, 'command')
      const cwd = argString(args, 'cwd', false) || undefined
      const timeout = argNumber(args, 'timeout', 30_000)
      const { stdout, stderr, exitCode } = await window.dot.executeCommand(command, timeout, cwd)
      return `退出码：${exitCode}\n标准输出：\n${truncate(stdout, 3000)}\n标准错误：\n${truncate(stderr, 1500)}`
    }
  },
  {
    id: 'web_search',
    name: '联网搜索',
    description: '通过 DuckDuckGo 搜索网络并返回结果摘要',
    params: [{ name: 'query', description: '搜索关键词', required: true }],
    execute: async (args) => {
      const query = argString(args, 'query')
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
      const { status, data } = await window.dot.httpRequest('GET', url, undefined, {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
      })
      if (status < 200 || status >= 300) throw new Error(`搜索请求失败（HTTP ${status}）`)
      const results = parseSearchResults(data, 8)
      if (results.length === 0) return '未搜索到相关结果'
      return results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
        .join('\n')
    }
  },
  {
    id: 'timer',
    name: '定时器',
    description: '等待指定的秒数后返回（可用于延时提醒等）',
    params: [{ name: 'seconds', description: '等待秒数（1-3600）', required: true }],
    execute: async (args) => {
      const seconds = Math.min(Math.max(argNumber(args, 'seconds', 0), 1), 3600)
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
      return `定时完成：已等待 ${seconds} 秒`
    }
  },
  {
    id: 'web_preview',
    name: '网页预览',
    description: '获取网页或本地 HTML 文件的文本预览',
    params: [
      { name: 'url', description: '网页地址（http/https）或本地 HTML 文件路径', required: true }
    ],
    execute: async (args) => {
      const url = argString(args, 'url')
      let html: string
      let source = url
      if (/^https?:\/\//i.test(url)) {
        const { status, data } = await window.dot.httpRequest('GET', url)
        if (status < 200 || status >= 300) throw new Error(`网页请求失败（HTTP ${status}）`)
        html = data
      } else {
        const content = await window.dot.localFiles('read', url)
        if (typeof content !== 'string') throw new Error(`无法读取文件：${url}`)
        html = content
        source = `本地文件 ${url}`
      }
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '（无标题）'
      return `来源：${source}\n标题：${title}\n\n${truncate(stripHtml(html))}`
    }
  }
]

/** 按 id 执行内置工具，返回结果文本 */
export async function executeLocalTool(
  id: string,
  args: Record<string, unknown> = {}
): Promise<string> {
  const tool = aiLocalTools.find((t) => t.id === id)
  if (!tool) throw new Error(`未找到内置工具：${id}`)
  return tool.execute(args)
}

/** 组合式获取内置工具列表 */
export function useAiLocalTools(): { tools: AiLocalTool[] } {
  return { tools: aiLocalTools }
}
