<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Calendar } from '@element-plus/icons-vue'

import aiChatSvg from '../assets/ai_chat.svg'
import calenNoteSvg from '../assets/calen_note.svg'
import baibaoxiangSvg from '../assets/baibaoxiang.svg'
import settingSvg from '../assets/setting.svg'
import iconPng from '../assets/icon.png'
import { getHuangLi, getAiHuangLiAdvice, type AiAdvice } from '../utils/lunar'
import { useSettings } from '../composables/useSettings'
import { loadAllMemos, markMemosReminded, type Memo } from '../utils/memo'
import { getAppPath } from '../utils/config'

const router = useRouter()

const navItems = [
  { label: '智能对话', icon: aiChatSvg, route: 'Chat' },
  { label: '记事本', icon: calenNoteSvg, route: 'CalenNote' },
  // 日历菜单：使用 Element Plus Calendar 图标（蓝色 #1296db）
  { label: '日历', elIcon: Calendar, iconColor: '#1296db', route: 'Calendar' },
  { label: '百宝箱', icon: baibaoxiangSvg, route: 'Toolbox' }
]

const handleNavClick = (route: string): void => {
  router.push({ name: route })
}

// ==================== 日历备忘录提醒 ====================
/** 已到时间待提示的备忘录（首页横幅展示） */
const dueMemos = ref<Memo[]>([])
let memoCheckCount = 0

/** 检查到时备忘录：date+time <= 当前时间即触发 */
async function checkMemos(): Promise<void> {
  // 每 30 秒重新读取一次文件，获取日历页新增的备忘录
  if (memoCheckCount % 30 === 0) {
    const all = await loadAllMemos()
    for (const m of all) {
      if (m.reminded) continue
      if (!isDue(m)) continue
      m.reminded = true
      dueMemos.value.push(m)
    }
    void markMemosReminded(all)
  }
  memoCheckCount++
}

/** 生成提醒列表用的唯一 id（date+time+content） */
function memoId(m: { date: string; time: string; content: string }): string {
  return `${m.date}|${m.time}|${m.content}`
}

function isDue(m: Memo): boolean {
  if (m.reminded) return false
  const [y, mo, d] = m.date.split('-').map(Number)
  const [h, mi] = m.time.split(':').map(Number)
  if ([y, mo, d, h, mi].some((n) => Number.isNaN(n))) return false
  return new Date(y, mo - 1, d, h, mi).getTime() <= now.value.getTime()
}

/** 关闭一条备忘录提示 */
function dismissMemo(memo: Memo): void {
  dueMemos.value = dueMemos.value.filter((m) => memoId(m) !== memoId(memo))
}

// ==================== 时间与农历 ====================
const now = ref(new Date())
let clockTimer: number | undefined

onMounted(() => {
  clockTimer = window.setInterval(() => {
    now.value = new Date()
    void checkMemos()
  }, 1000)
  void loadAiAdvice()
})

onUnmounted(() => {
  if (clockTimer !== undefined) window.clearInterval(clockTimer)
})

/** 时钟（HH:mm:ss） */
const timeText = computed(() => now.value.toLocaleTimeString('zh-CN', { hour12: false }))

/** 公历日期与星期 */
const dateText = computed(() => {
  const d = now.value
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${'日一二三四五六'[d.getDay()]}`
})

/** 黄历信息（跨天自动更新，时钟每秒触发 computed 重新求值） */
const huangLi = computed(() => getHuangLi(now.value))

/** 今日节日展示文本（无节日时展示下一个节日倒计时，数字单独渲染以便配色） */
const nextFestival = computed(() => huangLi.value.nextFestival)
const hasFestivalToday = computed(() => huangLi.value.festivals.length > 0)

/**
 * 倒计时紧迫度配色：剩余 1 天绿色、2 天黄色、3 天橙色，其余无色
 * （下一个节气与下一个节日均适用，仅数字变色）
 */
function countdownClass(days: number | undefined): string {
  if (days === 1 || days === 2 || days === 3) return `festival-c${days}`
  return ''
}

const termClass = computed(() => countdownClass(huangLi.value.nextTerm?.days))

const festivalDayClass = computed(() => countdownClass(huangLi.value.nextFestival?.days))

// ==================== AI 宜忌建议 ====================
const { settings } = useSettings()

/** AI 分析结果（未配置 AI 或分析失败时为 null，使用原始黄历宜忌） */
const aiAdvice = ref<AiAdvice | null>(null)
/** 已加载建议的日期（yyyy-m-d），避免一天内重复请求 */
const adviceDate = ref('')
/** 卡片显示模式：AI 建议为默认，点击卡片切换为原始黄历宜忌 */
const showRawYi = ref(false)
const showRawJi = ref(false)

/** 宜卡片展示内容 */
const displayYi = computed(() =>
  !showRawYi.value && aiAdvice.value && aiAdvice.value.yi.length > 0
    ? aiAdvice.value.yi
    : huangLi.value.yi
)

/** 忌卡片展示内容 */
const displayJi = computed(() =>
  !showRawJi.value && aiAdvice.value && aiAdvice.value.ji.length > 0
    ? aiAdvice.value.ji
    : huangLi.value.ji
)

/** 今日 AI 建议的缓存文件路径（{appPath}/Cache/advice/{yyyy-MM-dd}.json） */
async function adviceCachePath(): Promise<string> {
  const d = now.value
  const key = `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
  return `${await getAppPath()}/Cache/advice/${key}.json`
}

/**
 * 加载 AI 建议：每天只调用一次 AI，结果持久化到本地文件；
 * 再次进入首页/重启应用直接读缓存，跨天自动重新分析。
 * 未启用对话接口时静默跳过，直接用原始宜忌。
 */
async function loadAiAdvice(): Promise<void> {
  const today = `${now.value.getFullYear()}-${now.value.getMonth()}-${now.value.getDate()}`
  if (adviceDate.value === today) return
  adviceDate.value = today
  // 未开启首页宜忌时不调用 AI
  if (!settings.value.homeYiJiEnabled) return
  if (settings.value.llmConfigs.length === 0) return

  // 先读当日缓存
  try {
    const path = await adviceCachePath()
    const cached = (await window.dot.localFiles('read', path)) as string | null
    if (cached) {
      aiAdvice.value = JSON.parse(cached) as AiAdvice
      return
    }
  } catch {
    // 缓存读取失败则继续调用 AI
  }

  try {
    const advice = await getAiHuangLiAdvice(now.value, huangLi.value)
    aiAdvice.value = advice
    // 成功后写入缓存
    try {
      const path = await adviceCachePath()
      await window.dot.localFiles('write', path, JSON.stringify(advice, null, 2))
    } catch {
      // 缓存写入失败不影响本次展示
    }
  } catch {
    aiAdvice.value = null
  }
}

// 跨天时重置展示模式并重新分析
watch(
  () => now.value.getDate(),
  () => {
    showRawYi.value = false
    showRawJi.value = false
    void loadAiAdvice()
  }
)

// 开关变化：打开时补加载建议，关闭时清空 AI 建议并还原展示模式
watch(
  () => settings.value.homeYiJiEnabled,
  (enabled) => {
    showRawYi.value = false
    showRawJi.value = false
    if (enabled) {
      adviceDate.value = ''
      void loadAiAdvice()
    } else {
      aiAdvice.value = null
    }
  }
)
</script>

<template>
  <el-container class="home-container">
    <!-- 顶部导航 -->
    <el-header class="header">
      <el-row>
        <el-col :span="6">
          <div class="logo">
            <div class="logo-icon">
              <img :src="iconPng" alt="logo" class="logo-img" />
            </div>
            <span class="logo-text">圆点AI</span>
          </div>
        </el-col>
        <el-col :span="15">
          <nav class="nav">
            <div
              v-for="item in navItems"
              :key="item.label"
              class="nav-item"
              @click="handleNavClick(item.route)"
            >
              <el-icon v-if="'elIcon' in item" :size="20" :color="item.iconColor">
                <component :is="item.elIcon" />
              </el-icon>
              <img v-else :src="item.icon" :alt="item.label" class="nav-icon" />
              <span class="nav-label">{{ item.label }}</span>
            </div>
          </nav>
        </el-col>
        <el-col :span="3">
          <nav class="nav" style="justify-content: center">
            <div class="nav-item" @click="handleNavClick('Settings')">
              <img :src="settingSvg" alt="设置" class="nav-icon" />
              <span class="nav-label">设置</span>
            </div>
          </nav>
        </el-col>
      </el-row>
    </el-header>

    <!-- 主内容区：时间居中偏上（无背景），宜忌平分底部 -->
    <el-main class="main-content">
      <!-- 备忘录到时提醒横幅 -->
      <div v-if="dueMemos.length > 0" class="memo-reminder">
        <div v-for="memo in dueMemos" :key="memoId(memo)" class="memo-reminder-item">
          <span class="memo-reminder-text">
            ⏰ 备忘录提醒 [{{ memo.date }} {{ memo.time }}]：{{ memo.content }}
          </span>
          <el-button size="small" text @click="dismissMemo(memo)">知道了</el-button>
        </div>
      </div>

      <!-- 顶部：时间与农历（无背景，正中偏上） -->
      <section class="time-block">
        <div class="clock">{{ timeText }}</div>
        <div class="solar-date">{{ dateText }}</div>
        <div class="lunar-line">
          <span class="lunar-main">{{ huangLi.lunarText }}</span>
          <span class="lunar-sub">{{ huangLi.gzYear }}年 · {{ huangLi.animal }}生肖</span>
        </div>
        <div class="lunar-tags">
          <el-tag v-if="huangLi.solarTerm" type="success" effect="dark" size="small">
            今日{{ huangLi.solarTerm }}
          </el-tag>
          <el-tag v-for="f in huangLi.festivals" :key="f" type="danger" size="small">
            {{ f }}
          </el-tag>
        </div>
        <!-- 倒计时：距下一节气 / 距下一节日，5 天内才提示，各占一行 -->
        <div v-if="huangLi.nextTerm && huangLi.nextTerm.days <= 5" class="countdown-line">
          <span>
            距{{ huangLi.nextTerm.name }}
            <b :class="termClass">{{
              huangLi.nextTerm.days > 0 ? huangLi.nextTerm.days : '今天'
            }}</b>
            <template v-if="huangLi.nextTerm.days > 0"> 天</template>
          </span>
        </div>
        <div
          v-if="!hasFestivalToday && nextFestival && nextFestival.days <= 5"
          class="countdown-line"
        >
          <span>
            {{ nextFestival.name }}（{{ nextFestival.date }}，还有
            <b :class="festivalDayClass">{{ nextFestival.days }}</b> 天）
          </span>
        </div>
      </section>

      <!-- 底部：宜（左） / 忌（右），平分宽度；点击卡片在 AI 建议与原始黄历间切换；开关关闭时整体隐藏 -->
      <div v-if="settings.homeYiJiEnabled" class="yi-ji-row">
        <section
          class="yi-ji-card"
          title="点击切换 AI 建议 / 原始黄历"
          @click="showRawYi = !showRawYi"
        >
          <span class="yi-ji-badge yi">宜</span>
          <span class="yi-ji-source">
            {{ showRawYi || !aiAdvice ? '黄历' : 'AI 建议' }}
          </span>
          <p class="yi-ji-text">{{ displayYi.join(' · ') || '无' }}</p>
        </section>
        <section
          class="yi-ji-card"
          title="点击切换 AI 建议 / 原始黄历"
          @click="showRawJi = !showRawJi"
        >
          <span class="yi-ji-badge ji">忌</span>
          <span class="yi-ji-source">
            {{ showRawJi || !aiAdvice ? '黄历' : 'AI 建议' }}
          </span>
          <p class="yi-ji-text">{{ displayJi.join(' · ') || '无' }}</p>
        </section>
      </div>
    </el-main>

    <!-- 底部 -->
    <el-footer class="footer">
      <p>&copy; 2026 圆点AI - 让AI触手可及</p>
    </el-footer>
  </el-container>
</template>

<style scoped>
.home-container {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background-image: url('../assets/background.jpeg');
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  background-color: var(--color-bg);
  transition: background-color 0.3s;
}

.el-header {
  position: sticky;
  top: 0;
  z-index: 100;
  border-bottom: 1px solid var(--glass-border);
  transition: all 0.3s ease;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur) saturate(180%);
  -webkit-backdrop-filter: var(--glass-blur) saturate(180%);
  border: 1px solid var(--glass-border);
  border-radius: 16px;
  box-shadow: var(--glass-shadow);
  padding: 12px 24px;
}

.logo {
  display: flex;
  align-items: center;
  gap: 12px;
}

.logo-icon {
  width: 38px;
  height: 38px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.logo-img {
  width: 36px;
  height: 36px;
}

.logo-text {
  font-size: 20px;
  font-weight: 600;
  color: white;
}

.nav {
  display: flex;
  gap: 24px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.3s ease;
  color: white;
}

.nav-item:hover {
  background: var(--glass-bg);
}

.nav-icon {
  width: 20px;
  height: 20px;
}

.nav-label {
  font-size: 14px;
  font-weight: 500;
}

.el-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: space-between;
  padding: 24px 32px;
}

/* ===== 备忘录提醒横幅：悬浮展示，不挤压首页布局 ===== */
.memo-reminder {
  position: fixed;
  top: 84px;
  right: 24px;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 420px;
  max-width: calc(100vw - 48px);
}

.memo-reminder-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-radius: 12px;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-border);
  box-shadow: var(--glass-shadow);
}

.memo-reminder-text {
  font-size: 13px;
  color: #ffd04b;
  word-break: break-all;
}

/* ===== 顶部时间区：无背景，正中偏上 ===== */
.time-block {
  text-align: center;
  color: white;
  margin-top: 8vh;
}

.clock {
  font-size: 72px;
  font-weight: 700;
  letter-spacing: 3px;
  line-height: 1.1;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
  font-variant-numeric: tabular-nums;
}

.solar-date {
  margin-top: 6px;
  font-size: 15px;
  color: rgba(255, 255, 255, 0.9);
}

.lunar-line {
  margin-top: 12px;
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
}

.lunar-main {
  font-size: 22px;
  font-weight: 600;
}

.lunar-sub {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.75);
}

.lunar-tags {
  margin-top: 12px;
  display: flex;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
}

.countdown-line {
  margin-top: 10px;
  text-align: center;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.8);
}

/* 倒计时数字紧迫度配色（仅数字变色） */
.festival-c1 {
  color: var(--color-success);
}

.festival-c2 {
  color: var(--color-warning);
}

.festival-c3 {
  color: #ff9f43;
}

/* ===== 底部宜忌：左右平分宽度，带背景 ===== */
.yi-ji-row {
  display: flex;
  gap: 18px;
}

.yi-ji-card {
  flex: 1;
  min-width: 0;
  padding: 16px 20px;
  border-radius: 16px;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-border);
  box-shadow: var(--glass-shadow);
  color: white;
  transition: all 0.3s ease;
  cursor: pointer;
  user-select: none;
}

/* 数据来源标签（AI 建议 / 黄历） */
.yi-ji-source {
  float: right;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.15);
  color: rgba(255, 255, 255, 0.85);
}

.yi-ji-card:hover {
  transform: translateY(-2px);
}

.yi-ji-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  margin-bottom: 6px;
}

.yi-ji-badge.yi {
  background: var(--color-success);
}

.yi-ji-badge.ji {
  background: var(--color-danger);
}

.yi-ji-text {
  font-size: 12.5px;
  line-height: 1.8;
  color: rgba(255, 255, 255, 0.88);
  margin: 0;
  word-break: break-all;
}

.el-footer {
  text-align: center;
  padding: 24px;
  color: rgba(255, 255, 255, 0.6);
  font-size: 13px;
  background: var(--glass-bg);
}

@media (max-width: 900px) {
  .clock {
    font-size: 52px;
  }

  .nav {
    gap: 8px;
  }

  .nav-label {
    display: none;
  }

  .nav-item {
    padding: 8px;
  }
}
</style>
