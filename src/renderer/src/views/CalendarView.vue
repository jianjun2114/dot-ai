<script setup lang="ts">
/**
 * CalendarView —— 日历页面
 *
 * 左侧为备忘录面板（默认收起），右侧日历填充全部剩余区域；
 * 双击日期添加备忘录（时间 + 内容为一组，弹窗内右上角加号新增一组）；
 * 有备忘录的日期展示总条数与即将出现的一条备忘录（超长省略，悬浮显示全部）。
 * 数据按日期分文件存于 {appPath}/Cache/memo/{yyyy-MM-dd}.json
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { ArrowLeft, ArrowRight, Bell, Delete, Fold, Plus } from '@element-plus/icons-vue'
import { loadDay, saveDay, type DayMemo } from '../utils/memo'
import BackHome from '../components/BackHome.vue'

/** yyyy-MM-dd 格式化 */
function formatDateKey(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 日历当前选中日期（el-calendar 需要 Date 类型） */
const calendarDate = ref(new Date())
/** 选中日期的 yyyy-MM-dd */
const selectedDate = computed(() => formatDateKey(calendarDate.value))

/** 当前时间（定时刷新，驱动"即将出现"计算） */
const nowTick = ref(new Date())
let tickTimer: number | undefined
onMounted(() => {
  tickTimer = window.setInterval(() => {
    nowTick.value = new Date()
  }, 30_000)
})
onUnmounted(() => {
  if (tickTimer !== undefined) window.clearInterval(tickTimer)
})

/** 当前时间 HH:mm */
const nowTime = computed(() => {
  const d = nowTick.value
  return `${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`
})

// ==================== 备忘录数据 ====================
/** 缓存：日期 -> 备忘录组列表 */
const memoMap = ref<Map<string, DayMemo[]>>(new Map())

async function refreshDay(date: string): Promise<void> {
  // 按时间排序后缓存，保证面板下标与存储数组一致
  const items = (await loadDay(date)).sort((a, b) => a.time.localeCompare(b.time))
  memoMap.value.set(date, items)
}

onMounted(() => {
  void refreshDay(selectedDate.value)
})

/** 某天是否有备忘录 */
function hasMemo(cell: Date): boolean {
  return (memoMap.value.get(formatDateKey(cell))?.length ?? 0) > 0
}

/**
 * 某天"即将出现"的备忘录：取时间 >= 当前时刻的第一条，均已过则取最后一条
 */
function upcomingMemo(date: string): DayMemo | undefined {
  const items = (memoMap.value.get(date) ?? [])
    .slice()
    .sort((a, b) => a.time.localeCompare(b.time))
  if (items.length === 0) return undefined
  return items.find((m) => m.time >= nowTime.value) ?? items[items.length - 1]
}

/** 某天即将出现备忘录的悬浮提示全文 */
function upcomingText(date: string): string {
  const m = upcomingMemo(date)
  return m ? `${m.time} ${m.content}` : ''
}

// ==================== 左侧备忘录面板（默认收起） ====================
const panelCollapsed = ref(true)

/** 左侧面板展示的备忘录（已按时间排序） */
const panelMemos = computed(() => memoMap.value.get(selectedDate.value) ?? [])

/** 删除某天的一条备忘录 */
async function removeMemo(date: string, index: number): Promise<void> {
  const items = memoMap.value.get(date) ?? []
  items.splice(index, 1)
  try {
    await saveDay(date, items)
    await refreshDay(date)
  } catch {
    ElMessage.error('删除失败')
  }
}

/** 再次提醒：清除已提醒标记，首页会重新扫描并提示 */
async function remindAgain(date: string, index: number): Promise<void> {
  const items = memoMap.value.get(date) ?? []
  const item = items[index]
  if (!item) return
  item.reminded = false
  try {
    await saveDay(date, items)
    await refreshDay(date)
    ElMessage.success('已设置再次提醒')
  } catch {
    ElMessage.error('操作失败')
  }
}

// ==================== 头部年月切换 ====================
/** 上个月 */
function prevMonth(): void {
  const d = calendarDate.value
  calendarDate.value = new Date(d.getFullYear(), d.getMonth() - 1, 1)
}

/** 下个月 */
function nextMonth(): void {
  const d = calendarDate.value
  calendarDate.value = new Date(d.getFullYear(), d.getMonth() + 1, 1)
}

// ==================== 头部年月选择器 ====================
/** 年选择器（el-date-picker type=year 双向绑定 Date） */
const headerYear = computed<Date>({
  get: () => calendarDate.value,
  set: (d) => {
    calendarDate.value = new Date(d.getFullYear(), calendarDate.value.getMonth(), 1)
  }
})

/** 月选择器（切换月份时回到 1 号，避免日期溢出跳月） */
const headerMonth = computed<Date>({
  get: () => calendarDate.value,
  set: (d) => {
    calendarDate.value = new Date(d.getFullYear(), d.getMonth(), 1)
  }
})

/** 回到今天 */
function goToday(): void {
  calendarDate.value = new Date()
}

// ==================== 添加备忘录弹窗 ====================
const dialogVisible = ref(false)
interface MemoForm {
  time: string
  content: string
}
/** 弹窗内的多组表单（一组 = 一个时间 + 一条备忘录） */
const memoForms = ref<MemoForm[]>([])

/** 打开弹窗（双击日期或左侧面板添加按钮）：已有备忘录时回显 */
function openAddDialog(date?: Date): void {
  calendarDate.value = date ?? calendarDate.value
  const existing = memoMap.value.get(selectedDate.value) ?? []
  memoForms.value =
    existing.length > 0
      ? existing.map((m) => ({ time: m.time, content: m.content }))
      : [{ time: '09:00', content: '' }]
  dialogVisible.value = true
}

/** 弹窗右上角加号：新增一组 */
function addGroup(): void {
  memoForms.value.push({ time: '09:00', content: '' })
}

/** 删除弹窗中的一组 */
function removeGroup(index: number): void {
  memoForms.value.splice(index, 1)
}

/** 保存弹窗内的全部组（覆盖该天备忘录，过滤掉空内容） */
async function saveMemos(): Promise<void> {
  const date = selectedDate.value
  const existing = memoMap.value.get(date) ?? []
  const kept = memoForms.value
    .filter((f) => f.content.trim())
    .map((f) => ({ time: f.time, content: f.content.trim() }))
  if (memoForms.value.some((f) => !f.content.trim())) {
    ElMessage.warning('存在未填写内容的备忘录，已忽略')
  }
  if (kept.length === 0) {
    ElMessage.warning('请至少填写一条备忘内容')
    return
  }
  // 时间+内容未变的条目保留已提醒状态，避免重复提示
  const oldFlag = new Map(existing.map((m) => [`${m.time}|${m.content}`, m.reminded]))
  const items = kept.map((k) => ({
    ...k,
    reminded: oldFlag.get(`${k.time}|${k.content}`)
  }))
  try {
    await saveDay(date, items)
    await refreshDay(date)
    ElMessage.success('备忘录已保存')
    dialogVisible.value = false
  } catch {
    ElMessage.error('备忘录保存失败')
  }
}
</script>

<template>
  <el-config-provider :locale="zhCn">
    <div class="calendar-page">
      <el-header class="page-header">
        <BackHome />
        <el-text class="panel-title">日历</el-text>
      </el-header>

      <div class="calendar-layout">
        <!-- 左侧：备忘录面板（默认收起，收起/展开按钮位于该区域右上角） -->
        <div class="memo-panel" :class="{ collapsed: panelCollapsed }">
          <!-- 右上角：展开/收起按钮 -->
          <el-button
            class="panel-corner"
            size="small"
            :icon="panelCollapsed ? ArrowRight : Fold"
            :title="panelCollapsed ? '展开备忘录面板' : '收起备忘录面板'"
            @click="panelCollapsed = !panelCollapsed"
          />
          <template v-if="!panelCollapsed">
            <div class="memo-header">
              <span class="memo-title">{{ selectedDate }} 备忘录</span>
              <el-button type="primary" size="small" :icon="Plus" @click="openAddDialog()">
                添加
              </el-button>
            </div>
            <div class="memo-list">
              <el-empty v-if="panelMemos.length === 0" description="当天暂无备忘录" :image-size="60" />
              <div v-for="(memo, index) in panelMemos" :key="index" class="memo-item">
                <span class="memo-time">{{ memo.time }}</span>
                <el-tooltip :content="memo.content" placement="top" :show-after="300">
                  <span class="memo-content">{{ memo.content }}</span>
                </el-tooltip>
                <el-button
                  link
                  type="primary"
                  :icon="Bell"
                  title="再次提醒"
                  @click="remindAgain(selectedDate, index)"
                />
                <el-button link type="danger" :icon="Delete" title="删除" @click="removeMemo(selectedDate, index)" />
              </div>
            </div>
          </template>
          <template v-else>
            <!-- 收起态：窄条，展示当天备忘录条数 -->
            <div class="memo-collapsed">
              <span class="memo-collapsed-count">{{ panelMemos.length }}</span>
              <span class="memo-collapsed-label">备忘</span>
            </div>
          </template>
        </div>

        <!-- 右侧：日历填充全部剩余区域 -->
        <div class="calendar-main">
          <el-calendar v-model="calendarDate">
            <!-- 头部：选择年 / 选择月 + 今天 -->
            <template #header>
              <div class="cal-header">
                <div class="cal-header-pickers">
                  <el-date-picker
                    v-model="headerYear"
                    type="year"
                    placeholder="选择年"
                    :clearable="false"
                    size="small"
                    style="width: 100px"
                  />
                  <el-date-picker
                    v-model="headerMonth"
                    type="month"
                    placeholder="选择月"
                    :clearable="false"
                    size="small"
                    style="width: 110px"
                  />
                  <el-button size="small" @click="goToday">今天</el-button>
                </div>
                <!-- 正中：当前月份 -->
                <span class="cal-header-month">
                  {{ calendarDate.getFullYear() }}年{{ calendarDate.getMonth() + 1 }}月
                </span>
                <!-- 最右：上个月 / 下个月 -->
                <div class="cal-header-actions">
                  <el-button size="small" :icon="ArrowLeft" title="上个月" @click="prevMonth" />
                  <el-button size="small" :icon="ArrowRight" title="下个月" @click="nextMonth" />
                </div>
              </div>
            </template>
            <template #date-cell="{ data }">
              <div class="day-cell" @dblclick="openAddDialog(new Date(data.day))">
                <!-- 总条数：日期右上角 -->
                <span v-if="data.day && hasMemo(new Date(data.day))" class="memo-count">
                  {{ memoMap.get(data.day)?.length }}条
                </span>
                <span class="day-num">{{ data.day.split('-')[2] }}</span>
                <el-tooltip
                  v-if="data.day && hasMemo(new Date(data.day))"
                  :content="upcomingText(data.day)"
                  placement="top"
                  :show-after="300"
                >
                  <span class="memo-upcoming">{{ upcomingText(data.day) }}</span>
                </el-tooltip>
              </div>
            </template>
          </el-calendar>
        </div>
      </div>

      <!-- 备忘录弹窗：已有备忘录时回显，右上角加号新增一组 -->
      <el-dialog v-model="dialogVisible" :title="`备忘录（${selectedDate}）`" width="520px">
        <template #header>
          <div class="dialog-header">
            <span>备忘录（{{ selectedDate }}）</span>
            <el-button type="primary" circle size="small" :icon="Plus" title="新增一组" @click="addGroup" />
          </div>
        </template>
        <div class="memo-forms">
          <div v-for="(form, index) in memoForms" :key="index" class="memo-form-row">
            <el-time-picker
              v-model="form.time"
              value-format="HH:mm"
              format="HH:mm"
              placeholder="时间"
              style="width: 120px; flex-shrink: 0"
            />
            <el-input v-model="form.content" placeholder="备忘内容" maxlength="200" />
            <el-button
              v-if="memoForms.length > 1"
              link
              type="danger"
              :icon="Delete"
              @click="removeGroup(index)"
            />
          </div>
        </div>
        <template #footer>
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" @click="saveMemos">保存</el-button>
        </template>
      </el-dialog>
    </div>
  </el-config-provider>
</template>

<style scoped>
.calendar-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 16px 24px;
  background: var(--color-bg);
  color: var(--color-text);
  transition: background-color 0.3s;
}

.page-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 0 12px;
}

.panel-title {
  font-size: 18px;
  font-weight: 600;
}

.calendar-layout {
  flex: 1;
  display: flex;
  gap: 12px;
  min-height: 0;
}

/* ===== 左侧备忘录面板 ===== */
.memo-panel {
  position: relative;
  width: 300px;
  flex-shrink: 0;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
  padding-top: 8px;
}

.memo-panel.collapsed {
  width: 44px;
}

/* 该区域右上角：收起 / 展开按钮 */
.panel-corner {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 5;
}

.memo-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 36px 12px 12px;
  border-bottom: 1px solid var(--color-border);
}

.memo-title {
  font-size: 14px;
  font-weight: 600;
}

.memo-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  overflow-y: auto;
}

.memo-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--color-hover);
}

.memo-time {
  font-size: 12px;
  color: var(--color-primary);
  font-weight: 700;
  flex-shrink: 0;
}

.memo-content {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 收起态窄条（展开通过右上角按钮） */
.memo-collapsed {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding-top: 36px;
  color: var(--color-text-secondary);
}

.memo-collapsed:hover {
  color: var(--color-primary);
}

.memo-collapsed-count {
  font-size: 14px;
  font-weight: 700;
}

.memo-collapsed-label {
  font-size: 12px;
  writing-mode: vertical-lr;
}

/* ===== 右侧日历填充剩余区域 ===== */
.calendar-main {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-card);
  padding: 8px;
  display: flex;
  transition: background-color 0.3s;
}

.calendar-main > :deep(.el-calendar) {
  flex: 1;
  min-width: 0;
  background: transparent;
  --el-calendar-cell-width: auto;
}

/* 日期格文字跟随主题 */
.calendar-main :deep(.el-calendar-table thead th) {
  color: var(--color-text-secondary);
}

.calendar-main :deep(.el-calendar-table td.is-selected) {
  background: var(--color-hover);
}

.calendar-main :deep(.el-calendar-table .el-calendar-day:hover) {
  background: var(--color-hover);
}

/* ===== 日历头部：年/月选择器 + 今天 ===== */
.cal-header {
  /* el-calendar__header 是 flex 容器，子项默认收缩；撑满整行使月份绝对定位居中 */
  flex: 1;
  width: 100%;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.cal-header-pickers {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 当前月份：绝对定位于整个头部正中 */
.cal-header-month {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text);
}

.cal-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.cal-header-actions .el-button + .el-button {
  margin-left: 0;
}

/* 日历格子：日期 + 备忘条数 + 即将出现的备忘录 */
.day-cell {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 56px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 4px 6px;
  box-sizing: border-box;
  cursor: pointer;
}

.day-num {
  font-size: 14px;
}

/* 总条数：日期右上角 */
.memo-count {
  position: absolute;
  top: 4px;
  right: 6px;
  font-size: 11px;
  color: var(--color-primary);
  font-weight: 600;
}

.memo-upcoming {
  max-width: 100%;
  font-size: 11px;
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 弹窗头部：标题 + 右侧加号 */
.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-right: 8px;
}

/* 弹窗内多组表单 */
.memo-forms {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 50vh;
  overflow-y: auto;
}

.memo-form-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
