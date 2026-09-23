import { Solar, HolidayUtil } from 'lunar-typescript'
import { sendLlm } from './aiRequest'

/** 农历日期信息 */
export interface LunarDate {
  /** 农历年（如 2026） */
  year: number
  /** 农历月（闰月为负数） */
  month: number
  /** 农历日 */
  day: number
  /** 是否闰月 */
  isLeap: boolean
  /** 干支年（如 丙午） */
  gzYear: string
  /** 生肖（如 马） */
  animal: string
  /** 农历月名（如 六月 / 闰六月） */
  monthName: string
  /** 农历日名（如 初五） */
  dayName: string
}

/** 下一个节气/节日信息 */
export interface NextEventInfo {
  /** 名称 */
  name: string
  /** 距今天数（0 表示今天） */
  days: number
  /** 公历日期（YYYY-MM-DD） */
  date: string
}

/** 黄历数据 */
export interface HuangLiData {
  // 农历文本（如 丙午年六月初五）
  lunarText: string
  // 干支年（如 丙午）
  gzYear: string
  // 生肖（如 马）
  animal: string
  // 当天节气（无则 null）
  solarTerm: string | null
  // 当天节日（公历 + 农历 + 法定节假日）
  festivals: string[]
  // 下一个节气
  nextTerm: NextEventInfo | null
  // 下一个节日
  nextFestival: NextEventInfo | null
  // 方位
  wealthGod: string
  xiGod: string
  fuShen: string
  yangGui: string
  yinGui: string
  // 空亡
  xunKong: string
  // 四柱
  yearPillar: string
  monthPillar: string
  dayPillar: string
  hourPillar: string
  // 宜忌
  yi: string[]
  ji: string[]
  // 吉神凶煞
  jiShen: string[]
  xiongSha: string[]
  // 彭祖百忌
  pengZuBaiJi: string[]
  // 冲煞
  chong: string
  sha: string
  // 胎神
  dayPositionTai: string
  monthPositionTai: string
  // 日干支与生肖
  dayGanZhi: string
  dayAnimal: string
  // 星座与纳音
  constellation: string
  nayin: string
  // 建除十二值星
  zhiXing: string
  // 禄
  lu: string
}

/** 补零（YYYY-MM-DD 格式化用） */
const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))

/** Solar 转 YYYY-MM-DD 字符串 */
const solarToYmd = (s: Solar): string => `${s.getYear()}-${pad(s.getMonth())}-${pad(s.getDay())}`

/** 计算两个日期相差天数（忽略时分秒，date2 - date1） */
export function daysBetween(date1: Date, date2: Date): number {
  const d1 = new Date(date1.getFullYear(), date1.getMonth(), date1.getDate())
  const d2 = new Date(date2.getFullYear(), date2.getMonth(), date2.getDate())
  return Math.round((d2.getTime() - d1.getTime()) / 86400000)
}

/**
 * 获取指定日期的农历信息
 */
export function getLunarDate(date: Date): LunarDate {
  const lunar = Solar.fromDate(date).getLunar()
  // lunar-typescript 中闰月的 getMonth() 返回负数
  const isLeap = lunar.getMonth() < 0
  return {
    year: lunar.getYear(),
    month: lunar.getMonth(),
    day: lunar.getDay(),
    isLeap,
    gzYear: lunar.getYearInGanZhi(),
    animal: lunar.getYearShengXiao(),
    monthName: `${isLeap ? '闰' : ''}${lunar.getMonthInChinese()}月`,
    dayName: lunar.getDayInChinese()
  }
}

/**
 * 获取指定日期的节日列表（公历节日 + 农历节日 + 法定节假日）
 */
export function getFestivals(date: Date): string[] {
  const solar = Solar.fromDate(date)
  const festivals: string[] = [...solar.getFestivals(), ...solar.getLunar().getFestivals()]
  const holiday = HolidayUtil.getHoliday(solar.getYear(), solar.getMonth(), solar.getDay())
  if (holiday) festivals.push(holiday.getName())
  return festivals
}

/**
 * 获取下一个节气（单独计算，与节日互不影响）
 * @param date 基准日期
 * @returns 下一个节气名称、公历日期与距今天数；当天为节气时 days 为 0
 */
export function getNextSolarTerm(date: Date): NextEventInfo | null {
  try {
    const jq = Solar.fromDate(date).getLunar().getNextJieQi(true)
    if (!jq) return null
    const s = jq.getSolar()
    return {
      name: jq.getName(),
      days: daysBetween(date, new Date(s.getYear(), s.getMonth() - 1, s.getDay())),
      date: solarToYmd(s)
    }
  } catch (e) {
    console.error('计算下一个节气失败:', e)
    return null
  }
}

/**
 * 获取下一个节日（单独计算，与节气互不影响）
 * 从基准日期次日起逐日向后扫描（最多 370 天），
 * 命中公历节日 / 农历节日 / 法定节假日任一即返回。
 * @param date 基准日期
 */
export function getNextFestival(date: Date): NextEventInfo | null {
  try {
    const start = Solar.fromDate(date)
    for (let i = 1; i <= 370; i++) {
      const solar = start.next(i)
      const names = [...solar.getFestivals(), ...solar.getLunar().getFestivals()]
      const holiday = HolidayUtil.getHoliday(solar.getYear(), solar.getMonth(), solar.getDay())
      if (holiday) names.push(holiday.getName())
      if (names.length > 0) {
        // 同一天可能被公历/农历/法定节假日重复命中（如中秋节），去重后再返回
        return { name: [...new Set(names)].join('、'), days: i, date: solarToYmd(solar) }
      }
    }
    return null
  } catch (e) {
    console.error('计算下一个节日失败:', e)
    return null
  }
}

/**
 * 获取指定日期的完整黄历信息
 */
export function getHuangLi(date: Date): HuangLiData {
  const solar = Solar.fromDate(date)
  const lunar = solar.getLunar()

  // 农历文本（闰月以 lunar.getMonth() < 0 判定）
  const lunarText = `${lunar.getYearInGanZhi()}年${lunar.getMonth() < 0 ? '闰' : ''}${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`

  // 干支年与生肖
  const gzYear = lunar.getYearInGanZhi()
  const animal = lunar.getYearShengXiao()

  // 当天节气（getJieQi 返回空串表示当天非节气日）
  const solarTerm = lunar.getJieQi() || null

  // 节日
  const festivals = getFestivals(date)

  // 下一个节气 / 节日（各自独立计算，互不干扰）
  const nextTerm = getNextSolarTerm(date)
  const nextFestival = getNextFestival(date)

  // 宜忌
  const yi = lunar.getDayYi() ?? []
  const ji = lunar.getDayJi() ?? []

  // 彭祖百忌
  const pengZuGan = lunar.getPengZuGan()
  const pengZuZhi = lunar.getPengZuZhi()
  const pengZuBaiJi: string[] = []
  if (pengZuGan) pengZuBaiJi.push(pengZuGan)
  if (pengZuZhi) pengZuBaiJi.push(pengZuZhi)

  // 冲煞
  const chong = lunar.getDayChongDesc()
  const sha = lunar.getDaySha()

  // 方位
  const wealthGod = lunar.getDayPositionCai()
  const xiGod = lunar.getDayPositionXi()
  const fuShen = lunar.getDayPositionFu()
  const yangGui = lunar.getDayPositionYangGui()
  const yinGui = lunar.getDayPositionYinGui()

  // 空亡所值
  const xunKong = lunar.getDayXunKong()

  // 四柱
  const yearPillar = lunar.getYearInGanZhi()
  const monthPillar = lunar.getMonthInGanZhi()
  const dayPillar = lunar.getDayInGanZhi()
  const hourPillar = lunar.getTimeInGanZhi()

  // 吉神凶煞
  const jiShen = lunar.getDayJiShen() ?? []
  const xiongSha = lunar.getDayXiongSha() ?? []

  // 胎神
  const dayPositionTai = lunar.getDayPositionTai()
  const monthPositionTai = lunar.getMonthPositionTai()

  // 干支
  const dayGanZhi = lunar.getDayInGanZhi()
  const dayAnimal = lunar.getDayShengXiao()

  // 星座
  const constellation = solar.getXingZuo()

  // 纳音
  const nayin = `${lunar.getYearNaYin()} ${lunar.getMonthNaYin()} ${lunar.getDayNaYin()}`

  // 建除十二值星
  const zhiXing = lunar.getZhiXing()

  // 禄
  const lu = lunar.getDayLu()

  return {
    lunarText,
    gzYear,
    animal,
    solarTerm,
    festivals,
    nextTerm,
    nextFestival,
    wealthGod,
    xiGod,
    fuShen,
    yangGui,
    yinGui,
    xunKong,
    yearPillar,
    monthPillar,
    dayPillar,
    hourPillar,
    yi,
    ji,
    jiShen,
    xiongSha,
    pengZuBaiJi,
    chong,
    sha,
    dayPositionTai,
    monthPositionTai,
    dayGanZhi,
    dayAnimal,
    constellation,
    nayin,
    zhiXing,
    lu
  }
}

/* ==================== AI 黄历建议 ==================== */

/** AI 分析的今日建议（面向计算机从业者 / 开发工程师 / 运维工程师 / 上班族） */
export interface AiAdvice {
  /** 今天适合做的事（来自生活 / 工作 / 娱乐 / 金融等方面） */
  yi: string[]
  /** 今天不适合做的事 */
  ji: string[]
}

/** 从模型回复中提取 JSON 对象文本（容忍 markdown 代码块包裹） */
function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const target = fenced ? fenced[1] : text
  const start = target.indexOf('{')
  const end = target.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return target.slice(start, end + 1)
}

/**
 * 根据黄历数据调用 AI，分析今天适合 / 不适合做什么。
 * 直接访问「智能配置」中启用的大模型接口（aiRequest.sendLlm）。
 * 分析视角：生活、工作、娱乐、金融等方面；身份：计算机从业者（开发 / 运维 / 上班族）。
 * 未配置大模型时直接抛错，由调用方回退到原始黄历宜忌。
 * @param date 公历日期
 * @param data 当日黄历数据（getHuangLi 的返回值）
 */
export async function getAiHuangLiAdvice(date: Date, data: HuangLiData): Promise<AiAdvice> {
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const prompt = `你是精通中国传统命理与黄历的智能助手，服务对象是计算机从业者（开发工程师、运维工程师、上班族）。
今天是公历 ${ymd}，农历 ${data.lunarText}，${data.gzYear}年（${data.animal}生肖）。
完整黄历/卦象数据如下：
- 传统宜：${data.yi.join('、') || '无'}
- 传统忌：${data.ji.join('、') || '无'}
- 四柱：年柱 ${data.yearPillar}，月柱 ${data.monthPillar}，日柱 ${data.dayPillar}，时柱 ${data.hourPillar}
- 干支：日干支 ${data.dayGanZhi}（${data.dayAnimal}）；纳音：${data.nayin}；空亡：${data.xunKong}；禄：${data.lu}
- 值星（建除十二神）：${data.zhiXing}
- 冲煞：${data.chong} ${data.sha}
- 吉神宜趋：${data.jiShen.join('、') || '无'}
- 凶煞宜忌：${data.xiongSha.join('、') || '无'}
- 彭祖百忌：${data.pengZuBaiJi.join('；') || '无'}
- 方位：财神 ${data.wealthGod}，喜神 ${data.xiGod}，福神 ${data.fuShen}，阳贵 ${data.yangGui}，阴贵 ${data.yinGui}
- 胎神占方：日 ${data.dayPositionTai}；月 ${data.monthPositionTai}
- 今日节气：${data.solarTerm ?? '无'}；节日：${data.festivals.join('、') || '无'}
- 星座：${data.constellation}

请综合以上全部命理信息（四柱干支、纳音空亡、值星、吉神凶煞、彭祖百忌、各方神煞方位、冲煞胎神等）进行推演，
从生活、工作、娱乐、金融、健康、社交、出行等多个方面分析今天适合做什么、不适合做什么（不限于这几点，覆盖日常生活的方方面面）。
要求：
1. 只输出 JSON，格式：{"yi":["..."],"ji":["..."]}
2. yi / ji 各 4~6 条，每条不超过 16 个字，不要序号和解释
3. 必须用通俗易懂的日常用语，直接说事情本身，不要出现"财神方位""吉神""凶煞"等命理术语（例如宜：洗澡、打扫房间、开发新系统、买菜做饭；忌：熬夜加班、冲动消费、和人吵架）`

  const result = await sendLlm([{ role: 'user', content: prompt }], { temperature: 0.5 })
  const reply = result.content
  const json = extractJson(reply)
  if (!json) throw new Error('AI 建议响应中未找到 JSON')
  const parsed = JSON.parse(json) as Partial<AiAdvice>
  const yi = Array.isArray(parsed.yi) ? parsed.yi.filter((s) => typeof s === 'string') : []
  const ji = Array.isArray(parsed.ji) ? parsed.ji.filter((s) => typeof s === 'string') : []
  if (yi.length === 0 && ji.length === 0) throw new Error('AI 建议内容为空')
  return { yi, ji }
}
