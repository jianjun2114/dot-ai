<script lang="ts">
/** 任务定义（供父组件执行逻辑使用） */
export interface AiTask {
  id: string
  /** 任务名称 */
  name: string
  /** 描述（此任务是做什么的） */
  description: string
  /** 任务计划（执行时作为任务指令交给 AI） */
  schedule: string
  /** 选中的工具名（页面独有 + 内置） */
  tools: string[]
  /** 选中的 MCP 配置 id 列表 */
  mcps: string[]
  /** 选中的技能 id 列表 */
  skills: string[]
}

/** 结构化日志消息（与父组件 AiMessage 结构一致；导出避免 vue-tsc 私有名错误） */
export interface AiLogMessage {
  role: 'user' | 'assistant'
  content: string
}
</script>

<script setup lang="ts">
/**
 * AI 任务面板（AiAssistant 的「任务」模式内容区）
 *
 * - 上下均分两区：上半为任务列表（执行 / 修改 / 删除），下半为任务执行日志
 * - 任务持久化：{appPath}/Cache/task/{scene}.json（shell.json / browser.json ...）
 * - 新增 / 修改弹窗字段：id、名称、描述、任务计划、工具（页面独有 + 内置）、mcp、技能
 * - 执行由父组件完成（复用智能体循环），日志以 AiMessage 结构化流写入 props.logs，
 *   复用 AssistantMessage 渲染（思考折叠 / 工具调用折叠 / Markdown）
 */
import { ref, computed, onMounted, watch } from 'vue'
import { VideoPause, Delete, Edit, VideoPlay, Lightning } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { getAppPath } from '../utils/config'
import { useSettings } from '../composables/useSettings'
import type { AiTool } from '../composables/prompt'
import AssistantMessage, { type LongTaskData } from './AssistantMessage.vue'
import { generateId } from '../types/settings'

const props = defineProps<{
  /** 场景标识：决定任务存储文件名（shell / browser / generic） */
  scene: string
  /** 页面独有工具（供工具多选） */
  pageTools: AiTool[]
  /** 系统内置工具（供工具多选） */
  builtinTools: AiTool[]
  /** 执行日志（父组件持有并写入） */
  logs: AiLogMessage[]
  /** 长任务展示状态（父组件编排时写入：步骤状态 + 详情 + 总结），空 = 无进行中长任务 */
  longTask: LongTaskData | null
  /** 是否有任务正在执行 */
  running: boolean
  /** 深度思考开关（双向：控制请求是否透传 thinking） */
  think: boolean
}>()

const emit = defineEmits<{
  /** 执行任务（父组件组装工具并运行智能体循环） */
  (e: 'execute', task: AiTask): void
  /** 停止执行 */
  (e: 'stop'): void
  /** 更新思考开关 */
  (e: 'update:think', value: boolean): void
}>()

const { settings } = useSettings()

const tasks = ref<AiTask[]>([])

/** 任务存储文件路径 */
const taskFile = async (): Promise<string> => `${await getAppPath()}/Cache/task/${props.scene}.json`

/** 加载任务列表 */
const loadTasks = async (): Promise<void> => {
  try {
    if (window.dot) {
      const file = await taskFile()
      if (!(await window.dot.localFiles('exists', file))) return
      tasks.value = JSON.parse((await window.dot.localFiles('read', file)) as string)
    } else {
      const saved = localStorage.getItem(`dot-tasks-${props.scene}`)
      if (saved) tasks.value = JSON.parse(saved)
    }
  } catch (e) {
    console.error('加载任务失败:', e)
  }
}

/** 保存任务列表 */
const saveTasks = async (): Promise<void> => {
  try {
    if (window.dot) {
      await window.dot.localFiles('write', await taskFile(), JSON.stringify(tasks.value, null, 2))
    } else {
      localStorage.setItem(`dot-tasks-${props.scene}`, JSON.stringify(tasks.value))
    }
  } catch (e) {
    console.error('保存任务失败:', e)
  }
}

onMounted(loadTasks)

// ==================== 新增 / 修改弹窗 ====================
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const form = ref<AiTask>(emptyTask())

function emptyTask(): AiTask {
  return { id: '', name: '', description: '', schedule: '', tools: [], mcps: [], skills: [] }
}

/** 打开弹窗（task 为空时新增） */
const openDialog = (task?: AiTask): void => {
  editingId.value = task?.id ?? null
  form.value = task ? JSON.parse(JSON.stringify(task)) : emptyTask()
  dialogVisible.value = true
}

/** 保存弹窗（新增或修改） */
const saveForm = async (): Promise<void> => {
  const f = form.value
  if (!f.name.trim()) {
    ElMessage.warning('请填写任务名称')
    return
  }
  if (editingId.value) {
    const idx = tasks.value.findIndex((t) => t.id === editingId.value)
    if (idx >= 0) tasks.value[idx] = { ...f, id: editingId.value }
  } else {
    tasks.value.push({ ...f, id: generateId() })
  }
  await saveTasks()
  dialogVisible.value = false
}

/** 删除任务（带确认） */
const removeTask = async (task: AiTask): Promise<void> => {
  try {
    await ElMessageBox.confirm(`确定删除任务「${task.name}」？`, '删除任务', { type: 'warning' })
  } catch {
    return
  }
  tasks.value = tasks.value.filter((t) => t.id !== task.id)
  await saveTasks()
}

// ==================== JSON 导入 ====================
const fileInputRef = ref<HTMLInputElement>()

/** 导入任务 JSON（兼容数组与单对象；按 id 去重，缺失字段自动补全） */
const importFromFile = (): void => fileInputRef.value?.click()

const onFileChange = async (e: Event): Promise<void> => {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const parsed = JSON.parse(await file.text())
    const list: Partial<AiTask>[] = Array.isArray(parsed) ? parsed : [parsed]
    const existing = new Set(tasks.value.map((t) => t.id))
    let added = 0
    for (const item of list) {
      if (!item?.name || !item?.schedule) continue
      const id = item.id && !existing.has(item.id) ? item.id : generateId()
      if (existing.has(id)) continue
      existing.add(id)
      tasks.value.push({
        id,
        name: item.name,
        description: item.description ?? '',
        schedule: item.schedule ?? '',
        tools: item.tools ?? [],
        mcps: item.mcps ?? [],
        skills: item.skills ?? []
      })
      added++
    }
    await saveTasks()
    ElMessage.success(
      added > 0 ? `已导入 ${added} 个任务` : '未发现可导入的任务（需包含 name 与 schedule 字段）'
    )
  } catch {
    ElMessage.error('导入失败：JSON 解析错误')
  }
}

/** 工具名 → 描述映射（复选框悬浮提示） */
const toolDesc = (list: AiTool[]): Record<string, string> =>
  Object.fromEntries(list.map((t) => [t.name, t.description]))
const pageToolDesc = computed(() => toolDesc(props.pageTools))
const builtinToolDesc = computed(() => toolDesc(props.builtinTools))

// ==================== 执行日志 ====================
const logListRef = ref<HTMLElement>()

/** 滚动到日志底部（logs 由父组件写入，此处跟随滚动） */
const scrollLog = (): void => {
  if (logListRef.value) logListRef.value.scrollTop = logListRef.value.scrollHeight
}

/** 任务执行中内容流式增长时自动跟随滚动 */
watch(
  () => props.logs[props.logs.length - 1]?.content.length ?? 0,
  () => {
    if (props.running) scrollLog()
  }
)

/** 执行任务（父组件组装工具并运行智能体循环） */
const executeTask = (task: AiTask): void => {
  if (props.running) return
  emit('execute', task)
}

defineExpose({ openDialog, importFromFile })
</script>

<template>
  <div class="task-panel">
    <!-- 导入任务 JSON 的隐藏文件选择器 -->
    <input
      ref="fileInputRef"
      type="file"
      accept=".json,application/json"
      style="display: none"
      @change="onFileChange"
    />
    <!-- 上半：任务列表 -->
    <div class="task-top">
      <div class="task-list">
        <div v-if="tasks.length === 0" class="task-empty">暂无任务，点击右上角 + 新增</div>
        <div v-for="task in tasks" :key="task.id" class="task-item">
          <div class="task-info">
            <div class="task-name" :title="task.description">{{ task.name }}</div>
            <div class="task-desc">{{ task.description || '—' }}</div>
          </div>
          <div class="task-actions">
            <el-button
              type="primary"
              size="small"
              :icon="VideoPlay"
              :disabled="running"
              @click="executeTask(task)"
            >
              执行
            </el-button>
            <el-button size="small" :icon="Edit" @click="openDialog(task)" />
            <el-button size="small" type="danger" :icon="Delete" @click="removeTask(task)" />
          </div>
        </div>
      </div>
    </div>

    <!-- 下半：任务执行日志 -->
    <div class="task-bottom">
      <div class="task-log-header">
        <span>任务执行日志</span>
        <div class="task-log-actions">
          <el-tooltip :content="think ? '深度思考已开启' : '深度思考已关闭'">
            <span
              class="task-think-toggle"
              :class="{ active: think }"
              @click="emit('update:think', !think)"
            >
              <el-icon><Lightning /></el-icon>
              思考
            </span>
          </el-tooltip>
          <el-button
            v-if="running"
            type="warning"
            size="small"
            :icon="VideoPause"
            @click="emit('stop')"
          >
            停止
          </el-button>
        </div>
      </div>
      <div ref="logListRef" class="task-log-list">
        <div v-if="logs.length === 0 && !longTask" class="task-empty">暂无执行日志</div>
        <!-- 长任务卡片：步骤状态 + 详情 + 总结（独立于日志流，始终置顶） -->
        <div v-if="longTask" class="task-log-item task-long-card">
          <AssistantMessage :long-task="longTask" :is-streaming="running" content="" />
        </div>
        <div v-for="(log, idx) in logs" :key="idx" class="task-log-item">
          <AssistantMessage :content="log.content" />
        </div>
      </div>
    </div>

    <!-- 新增 / 修改任务弹窗 -->
    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '修改任务' : '新增任务'"
      width="480px"
      append-to-body
    >
      <el-form label-width="72px" label-position="left">
        <el-form-item label="ID">
          <el-input v-model="form.id" placeholder="留空自动生成" :disabled="!!editingId" />
        </el-form-item>
        <el-form-item label="名称" required>
          <el-input v-model="form.name" placeholder="任务名称" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input
            v-model="form.description"
            type="textarea"
            :rows="2"
            placeholder="此任务是做什么的"
          />
        </el-form-item>
        <el-form-item label="任务计划">
          <el-input
            v-model="form.schedule"
            type="textarea"
            :rows="4"
            placeholder="任务执行的计划 / 步骤说明"
          />
        </el-form-item>
        <el-form-item label="工具">
          <el-checkbox-group v-model="form.tools" class="task-check-group">
            <template v-if="pageTools.length">
              <div class="task-check-title">页面独有</div>
              <el-checkbox
                v-for="t in pageTools"
                :key="t.name"
                :value="t.name"
                :title="pageToolDesc[t.name]"
                class="task-check"
              >
                {{ t.name }}
              </el-checkbox>
            </template>
            <div class="task-check-title">内置工具</div>
            <el-checkbox
              v-for="t in builtinTools"
              :key="t.name"
              :value="t.name"
              :title="builtinToolDesc[t.name]"
              class="task-check"
            >
              {{ t.name }}
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="MCP">
          <el-select v-model="form.mcps" multiple placeholder="选择 MCP 服务" clearable>
            <el-option v-for="m in settings.mcpConfigs" :key="m.id" :label="m.name" :value="m.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="技能">
          <el-select v-model="form.skills" multiple placeholder="选择技能" clearable>
            <el-option
              v-for="s in settings.skillConfigs"
              :key="s.id"
              :label="s.name"
              :value="s.id"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveForm">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.task-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* 上下均分 */
.task-top,
.task-bottom {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.task-top {
  border-bottom: 1px solid var(--color-border);
}

.task-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.task-empty {
  color: var(--color-text-secondary, #909399);
  font-size: 13px;
  text-align: center;
  padding: 24px 0;
}

.task-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg, transparent);
}

.task-info {
  min-width: 0;
  flex: 1;
}

.task-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-desc {
  font-size: 12px;
  color: var(--color-text-secondary, #909399);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

.task-actions {
  flex-shrink: 0;
  display: flex;
  gap: 4px;
}

.task-log-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
}

.task-log-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 思考开关（开启时高亮） */
.task-think-toggle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary, #909399);
  cursor: pointer;
  user-select: none;
  transition: color 0.15s ease;
}

.task-think-toggle:hover {
  color: var(--color-primary);
}

.task-think-toggle.active {
  color: var(--color-primary);
}

.task-log-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.task-log-item {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 8px;
}

/* 长任务卡片：无内边距，由 AssistantMessage 气泡自带样式 */
.task-long-card {
  padding: 0;
  border: none;
  background: transparent;
}

/* 弹窗内复选组 */
.task-check-group {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  max-height: 160px;
  overflow-y: auto;
  width: 100%;
}

.task-check-title {
  width: 100%;
  font-size: 12px;
  color: var(--color-text-secondary, #909399);
}

.task-check {
  margin-right: 0;
}

.task-check :deep(.el-checkbox__label) {
  font-size: 12px;
}
</style>
