/**
 * 备忘录存储：按日期分文件 {appPath}/Cache/memo/{yyyy-MM-dd}.json
 * 文件内容：DayMemo[]，每条 { time: 'HH:mm', content, reminded? }
 */
import { getAppPath } from './config'

export interface DayMemo {
  time: string
  content: string
  /** 是否已在首页提示过 */
  reminded?: boolean
}

/** 带日期的备忘录（供首页扫描提醒用） */
export interface Memo extends DayMemo {
  date: string
}

let memoDir = ''
let memoDirReady: Promise<string> | null = null

/** 懒获取备忘录目录（app-path IPC 有模块级缓存，仅首次请求） */
function getMemoDir(): Promise<string> {
  if (!memoDirReady) {
    memoDirReady = getAppPath().then((p) => {
      memoDir = `${p}/Cache/memo`
      return memoDir
    })
  }
  return memoDirReady
}

function dayPath(dir: string, date: string): string {
  return `${dir}/${date}.json`
}

/** 读取某天的备忘录 */
export async function loadDay(date: string): Promise<DayMemo[]> {
  try {
    const dir = await getMemoDir()
    const content = (await window.dot.localFiles('read', dayPath(dir, date))) as string | null
    if (!content) return []
    const arr = JSON.parse(content)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/** 保存某天的备忘录（write 自动创建目录） */
export async function saveDay(date: string, items: DayMemo[]): Promise<void> {
  const dir = await getMemoDir()
  await window.dot.localFiles('write', dayPath(dir, date), JSON.stringify(items, null, 2))
}

/** 读取全部备忘录（首页提醒扫描用） */
export async function loadAllMemos(): Promise<Memo[]> {
  try {
    const dir = await getMemoDir()
    const files = (await window.dot.localFiles('list', dir)) as string[] | null
    if (!files) return []
    const result: Memo[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const date = f.split(/[/\\]/).pop()!.replace(/\.json$/, '')
      const items = await loadDay(date)
      for (const it of items) result.push({ ...it, date })
    }
    return result
  } catch {
    return []
  }
}

/** 批量更新备忘录提醒状态（首页提示后持久化） */
export async function markMemosReminded(memos: Memo[]): Promise<void> {
  // 按日期分组后逐天保存
  const byDate = new Map<string, DayMemo[]>()
  for (const m of memos) {
    const list = byDate.get(m.date) ?? []
    list.push({ time: m.time, content: m.content, reminded: m.reminded })
    byDate.set(m.date, list)
  }
  for (const [date, items] of byDate) {
    // 按时间排序还原原始顺序
    items.sort((a, b) => a.time.localeCompare(b.time))
    await saveDay(date, items)
  }
}
