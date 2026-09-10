<script setup lang="ts">
/**
 * CalenNoteView —— 日历记事本页面
 *
 * 职责：左侧日历 + 文件树管理（新建/重命名/删除），
 * 右侧将正在编辑的文件交给独立的 DotEditor 组件（富文本/Markdown 双视图），
 * 本页面只负责文件读取与自动保存，不再包含任何编辑器实现。
 */
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { ArrowLeft, ArrowRight, Plus, Delete, EditPen, Minus, Check } from '@element-plus/icons-vue'
import type { TabsPaneContext, RenderContentContext, TreeInstance, ElInput } from 'element-plus'
import { ElMessage, ElMessageBox } from 'element-plus'
import BackHome from '../components/BackHome.vue'
import DotEditor from '../components/DotEditor.vue'
import { getConfigWithDefault, getAppPath } from '../utils/config'

const activeName = ref('common')
const editNodeKey = ref('')
const oldFileName = ref('')

// === 文件树 ===
interface FileTreeNode {
  label: string
  node_key: string
  children?: FileTreeNode[]
  parent?: string
}

const fileTreeData = ref<FileTreeNode[]>([])
const commonFiles = ref<FileTreeNode[]>([])
const rootPath = ref('')

// 加载根目录
const loadRootFiles = async (): Promise<void> => {
  // 获取日历根目录
  const appPath = await getAppPath()
  rootPath.value = await getConfigWithDefault('calendarNotesPath', `${appPath}/calendarNotes`)
  try {
    // 兼容旧目录名：将「常用文件」重命名为「常用文档」（仅在新目录不存在时执行）
    const dirList = await window.dot.listFiles(rootPath.value)
    if (dirList.includes('常用文件') && !dirList.includes('常用文档')) {
      await window.dot.localFiles(
        'rename',
        `${rootPath.value}/常用文件`,
        `${rootPath.value}/常用文档`
      )
    }

    const dirs = await window.dot.listFiles(rootPath.value)

    for (const dir of dirs) {
      const fullPath = `${rootPath.value}/${dir}`
      const files = await window.dot.listFiles(fullPath)
      const node_key = dir === '常用文档' ? 'commonFiles' : dir
      const childrens: FileTreeNode[] = []
      let index = 1
      for (const file of files) {
        // 文件统一无扩展名，label 直接使用文件名（旧 .md 文件保留原名以便访问）
        childrens.push({ label: file, node_key: `${node_key}-${index}`, parent: node_key })
        index++
      }
      fileTreeData.value.push({ label: dir, node_key: node_key, children: childrens })
      if (node_key === 'commonFiles') {
        commonFiles.value = childrens
      }
    }
  } catch {
    fileTreeData.value = []
  }
}

// 添加文件
type Data = RenderContentContext['data']
const treeAllRef = ref<TreeInstance>()
const editInputRef = ref<InstanceType<typeof ElInput>>()
const editCommonInputRef = ref<InstanceType<typeof ElInput>>()

// 设置 commonFiles 输入框 ref（只在匹配 editNodeKey 时设置）
const setEditCommonInputRef = (el: InstanceType<typeof ElInput> | null, nodeKey: string): void => {
  if (nodeKey === editNodeKey.value) {
    editCommonInputRef.value = el as InstanceType<typeof ElInput>
  }
}

const addFile = async (data: Data): Promise<void> => {
  if (editNodeKey.value) return

  // 展开节点
  // 1. 先添加节点
  editNodeKey.value = `${data.node_key}-${(data.children?.length || 0) + 1}`
  const newNode = { label: '', node_key: editNodeKey.value, parent: data.node_key }
  if (data.node_key === 'commonFiles') {
    // 数据绑定修改
    commonFiles.value.push(newNode)
    nextTick(() => {
      editCommonInputRef.value?.focus()
    })
  } else {
    // 数据绑定修改
    data.children?.push(newNode)
    // 2. 再展开父节点（此时父节点已有子节点，可以安全展开）
    const node = treeAllRef.value?.getNode(data)
    if (node) {
      node.expanded = true
    }

    // 自动聚焦输入框
    nextTick(() => {
      editInputRef.value?.focus()
      editInputRef.value?.select()
    })
  }
}

// 确认添加文件
const confirmAddFile = async (data: Data): Promise<void> => {
  const fileName = data.label.trim()
  if (!fileName) {
    data.isEditing = false
    return
  }

  const parentDir = data.parent === 'commonFiles' ? '常用文档' : data.parent
  // 文件统一使用无扩展名
  const filePath = `${rootPath.value}/${parentDir}/${fileName}`

  try {
    if (oldFileName.value) {
      const oldPath = `${rootPath.value}/${parentDir}/${oldFileName.value}`
      await window.dot.localFiles('rename', oldPath, filePath)
      oldFileName.value = ''
      ElMessage.success('文件重命名成功')
    } else {
      // 创建文件
      const success = await window.dot.localFiles('create', filePath)
      if (!success) {
        ElMessage.error('文件创建失败')
        return
      }
      ElMessage.success('文件创建成功')
    }
  } catch {
    ElMessage.error('文件创建失败')
  }
  editNodeKey.value = ''
}

// 取消编辑
const handleEditBlur = (data: Data): void => {
  editNodeKey.value = ''
  // 如果是新增的常用文档（node_key 包含 'commonFiles-'），从列表移除
  if (data.node_key?.includes('commonFiles-')) {
    commonFiles.value = commonFiles.value.filter((f) => f.node_key !== data.node_key)
    return
  }
  // 树节点的删除操作
  treeAllRef.value?.remove(data)
}

// 编辑文件
const editFile = async (data: Data): Promise<void> => {
  editNodeKey.value = data.node_key
  oldFileName.value = data.label
  nextTick(() => {
    if (data.node_key === 'commonFiles') {
      editCommonInputRef.value?.focus()
    } else {
      editInputRef.value?.focus()
    }
  })
}

// 删除目录
const deleteDir = async (data: Data): Promise<void> => {
  try {
    await ElMessageBox.confirm(`确定要删除目录 "${data.label}" 吗？`, '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
    const filePath = `${rootPath.value}/${data.label}`
    await window.dot.localFiles('delete', filePath)
    // 从树中移除节点
    fileTreeData.value = fileTreeData.value.filter((item) => item.node_key !== data.node_key)
    ElMessage.success('目录删除成功')
  } catch (error) {
    // 用户取消操作，不显示错误消息
    if (error === 'cancel') {
      return
    }
    console.error(error, '删除目录失败')
    ElMessage.error('目录删除失败')
  }
}

// 删除文件
const deleteFile = async (data: Data): Promise<void> => {
  try {
    // 判断当前是否正在编辑文件，如果是则不允许删除
    if (editNodeKey.value === data.node_key) {
      ElMessage.error('请先保存当前编辑的文件')
      return
    }
    await ElMessageBox.confirm(`确定要删除文件 "${data.label}" 吗？`, '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
    const parentDir = data.parent === 'commonFiles' ? '常用文档' : data.parent
    const filePath = `${rootPath.value}/${parentDir}/${data.label}`
    await window.dot.localFiles('delete', filePath)
    if (data.node_key === 'commonFiles') {
      // 从常用文档中移除
      commonFiles.value = commonFiles.value.filter((f) => f.node_key !== data.node_key)
    }
    // 从树中移除节点
    treeAllRef.value?.remove(data)
    ElMessage.success('文件删除成功')
  } catch (error) {
    // 用户取消操作，不显示错误消息
    if (error === 'cancel') {
      return
    }
    console.error(error, '删除文件失败')
    ElMessage.error('文件删除失败')
  }
}

const currentDate = ref(new Date())
const currentYear = computed(() => currentDate.value.getFullYear())
const currentMonth = computed(() => currentDate.value.getMonth())

// 日历数据
const daysInMonth = computed(() => {
  const year = currentYear.value
  const month = currentMonth.value
  const firstDay = new Date(year, month, 1).getDay()
  const totalDays = new Date(year, month + 1, 0).getDate()
  return { firstDay, totalDays }
})

const weekDays = ['日', '一', '二', '三', '四', '五', '六']

// 记事数据
const selectedDate = ref<string | null>(null)

// 生成日历网格
const calendarDays = computed(() => {
  const { firstDay, totalDays } = daysInMonth.value
  const days: (number | null)[] = []

  // 填充月初的空白
  for (let i = 0; i < firstDay; i++) {
    days.push(null)
  }

  // 填充日期
  for (let i = 1; i <= totalDays; i++) {
    days.push(i)
  }

  return days
})

// 格式化日期为 key
const formatDateKey = (day: number): string => {
  return `${currentYear.value}-${String(currentMonth.value + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// 选择日期
const selectDate = async (day: number | null): Promise<void> => {
  if (!day) return
  selectedDate.value = formatDateKey(day)

  // 打开全部文档标签页
  activeName.value = 'all'
  editNodeKey.value = ''

  // 检查是否已存在当前日期的节点
  const dateKey = formatDateKey(day)
  const existingNode = fileTreeData.value.find((node) => node.node_key === dateKey)

  if (existingNode) {
    // 展开已有节点
    const node = treeAllRef.value?.getNode(dateKey)
    if (node) {
      node.expanded = true
    }
  } else {
    // 检查最后一个节点是否为空（没有子文件）
    const lastNode = fileTreeData.value[fileTreeData.value.length - 1]
    if (lastNode && lastNode.children && lastNode.children.length === 0) {
      // 更新已有空节点
      lastNode.label = dateKey
      lastNode.node_key = dateKey
    } else {
      // 创建新的日期节点（不创建实际文件夹，等添加文件时再创建）
      const newNode: FileTreeNode = {
        label: dateKey,
        node_key: dateKey,
        children: []
      }
      fileTreeData.value.push(newNode)
    }

    // 展开节点
    nextTick(() => {
      const node = treeAllRef.value?.getNode(dateKey)
      if (node) {
        node.expanded = true
      }
    })
  }
}

// 上一个月
const prevMonth = (): void => {
  currentDate.value = new Date(currentYear.value, currentMonth.value - 1, 1)
  selectedDate.value = null
}

// 下一个月
const nextMonth = (): void => {
  currentDate.value = new Date(currentYear.value, currentMonth.value + 1, 1)
  selectedDate.value = null
}

// 判断是否有记事
const hasNote = (day: number): boolean => {
  const dateKey = formatDateKey(day)
  const found = fileTreeData.value.some(
    (item) => item.node_key === dateKey && item.children && item.children.length > 0
  )
  return !!found
}

// 今天是几号
const today = computed(() => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
})

// 点击标签页（占位：保留 tab-click 钩子）
const handleClick = (tab: TabsPaneContext, event: Event): void => {
  void tab
  void event
}

const treeProps = {
  children: 'children',
  label: 'label'
}

// handleCheckChange 处理树节点选中变化
const handleCheckChange = (checkedKeys: string[], node: FileTreeNode): void => {
  void checkedKeys
  void node
}

onMounted(async () => {
  loadRootFiles()
})

// 新增常用文档 - 直接添加到 fileTreeData
const addCommonFile = (): void => {
  if (editNodeKey.value) return
  const commonNode = fileTreeData.value.find((node) => node.node_key === 'commonFiles')
  if (!commonNode) return
  addFile(commonNode)
}

// === 文档编辑（内容由 DotEditor 组件负责，本页面负责读取与保存） ===

// 正在编辑的文件路径（空串表示未打开文件）
const editingFile = ref('')
// 文档内容（HTML，统一数据层格式，由 DotEditor 双向绑定）
const editorContent = ref('')
// 保存状态
const saveStatus = ref<'saved' | 'saving' | 'unsaved'>('saved')
// 自动保存防抖定时器
let saveTimer: ReturnType<typeof setTimeout> | null = null
// 文件加载标记：加载过程中的内容变更不触发自动保存
let loadingFile = false

// 当前编辑文件名（状态栏展示）
const editingFileName = computed(() => {
  if (!editingFile.value) return ''
  return editingFile.value.split(/[\\/]/).pop() || ''
})

// 打开文件编辑器
const openEditor = async (data: Data): Promise<void> => {
  const dir = data.parent === 'commonFiles' ? '常用文档' : data.parent
  // label 即完整文件名（新文件无扩展名，旧 .md 文件名中自带扩展名）
  const filePath = `${rootPath.value}/${dir}/${data.label}`
  loadingFile = true
  editingFile.value = filePath
  const fileContent = await window.dot.localFiles('read', filePath)
  editorContent.value = typeof fileContent === 'string' ? fileContent : ''
  saveStatus.value = 'saved'
  nextTick(() => {
    loadingFile = false
  })
}

// 标记未保存并触发防抖自动保存
const markUnsaved = (): void => {
  saveStatus.value = 'unsaved'
  if (saveTimer) {
    clearTimeout(saveTimer)
  }
  saveTimer = setTimeout(() => {
    saveContent()
  }, 2000)
}

// 保存内容
const saveContent = async (): Promise<void> => {
  if (!editingFile.value) return
  saveStatus.value = 'saving'
  try {
    await window.dot.localFiles('write', editingFile.value, editorContent.value)
    saveStatus.value = 'saved'
  } catch {
    saveStatus.value = 'unsaved'
    ElMessage.error('文件保存失败')
  }
}

// 编辑器内容变化：自动保存
watch(editorContent, () => {
  if (loadingFile) return
  markUnsaved()
})
</script>

<template>
  <div class="calen-note-page">
    <el-container>
      <el-aside>
        <el-header>
          <BackHome />
          <el-text class="panel-title">日历记事本</el-text>
        </el-header>
        <div class="calendar-panel">
          <div class="calendar-header">
            <el-button link @click="prevMonth">
              <el-icon><ArrowLeft /></el-icon>
            </el-button>
            <span class="calendar-title">{{ currentYear }}年{{ currentMonth + 1 }}月</span>
            <el-button link @click="nextMonth">
              <el-icon><ArrowRight /></el-icon>
            </el-button>
          </div>
          <div class="calendar-weekdays">
            <span v-for="day in weekDays" :key="day">{{ day }}</span>
          </div>
          <div class="calendar-grid">
            <div
              v-for="(day, index) in calendarDays"
              :key="index"
              class="calendar-day"
              :class="{
                'is-empty': !day,
                'is-today': day && formatDateKey(day) === today,
                'is-selected': day && formatDateKey(day) === selectedDate,
                'has-note': day && hasNote(day)
              }"
              @click="selectDate(day)"
            >
              <span v-if="day">{{ day }}</span>
              <span v-if="day && hasNote(day)" class="note-dot"></span>
            </div>
          </div>
        </div>
        <div class="files-section">
          <el-tabs v-model="activeName" class="files-tabs" :stretch="true" @tab-click="handleClick">
            <el-tab-pane label="常用文档" name="common">
              <div class="common-header">
                <span class="common-title">常用文档</span>
                <el-icon class="add-common-file" @click="addCommonFile"><Plus /></el-icon>
              </div>
              <div>
                <!-- 整行可点击打开编辑器（操作按钮已阻止冒泡） -->
                <el-row
                  v-for="(data, index) in commonFiles"
                  :key="data.node_key || index"
                  class="file-row"
                  @click="openEditor(data)"
                >
                  <el-col :span="18">
                    <template v-if="editNodeKey === data.node_key">
                      <el-input
                        :ref="(el) => setEditCommonInputRef(el, data.node_key)"
                        v-model="data.label"
                        placeholder="输入文件名"
                        @keyup.enter="confirmAddFile(data)"
                        @blur="handleEditBlur(data)"
                        @click.stop
                      />
                    </template>
                    <template v-else>
                      <span class="node-label">{{ data.label }}</span>
                    </template>
                  </el-col>
                  <el-col :span="3">
                    <el-icon class="action-icon edit-icon" @click.stop="editFile(data)">
                      <EditPen />
                    </el-icon>
                  </el-col>
                  <el-col :span="3">
                    <el-icon class="action-icon delete-icon" @click.stop="deleteFile(data)">
                      <Delete />
                    </el-icon>
                  </el-col>
                </el-row>
              </div>
            </el-tab-pane>
            <el-tab-pane label="全部文档" name="all">
              <el-tree
                ref="treeAllRef"
                :data="fileTreeData"
                node-key="node_key"
                :props="treeProps"
                @check-change="handleCheckChange"
              >
                <template #default="{ node, data }">
                  <!-- 文件节点整行可点击打开编辑器（目录不响应，操作按钮已阻止冒泡） -->
                  <div
                    class="tree-node"
                    :class="{ 'is-clickable': !data.children }"
                    @click="!data.children && openEditor(data)"
                  >
                    <template v-if="data.node_key === editNodeKey">
                      <!-- 编辑状态：显示输入框 -->
                      <el-input
                        ref="editInputRef"
                        v-model="data.label"
                        placeholder="输入文件名"
                        class="edit-input"
                        @blur="handleEditBlur(data)"
                        @keyup.enter="confirmAddFile(data)"
                        @click.stop
                      />
                    </template>
                    <template v-else>
                      <!-- 非编辑状态：显示标签 -->
                      <span class="node-label" :class="{ 'is-file': !data.children }">{{
                        node.label
                      }}</span>
                    </template>
                    <div class="node-actions">
                      <template v-if="data.children && data.node_key !== 'commonFiles'">
                        <el-icon class="action-icon add-icon" @click.stop="addFile(data)">
                          <Plus />
                        </el-icon>
                        <el-icon class="action-icon minus-icon" @click.stop="deleteDir(data)">
                          <Minus />
                        </el-icon>
                      </template>
                      <template v-else>
                        <el-icon class="action-icon edit-icon" @click.stop="editFile(data)">
                          <EditPen />
                        </el-icon>
                        <el-icon class="action-icon delete-icon" @click.stop="deleteFile(data)">
                          <Delete />
                        </el-icon>
                      </template>
                    </div>
                  </div>
                </template>
              </el-tree>
            </el-tab-pane>
          </el-tabs>
        </div>
      </el-aside>
      <el-main>
        <div class="editor-shell">
          <!-- 文件状态栏：文件名 + 保存状态 -->
          <div v-show="editingFile" class="editor-status-bar">
            <span class="status-file" :title="editingFile">{{ editingFileName }}</span>
            <span class="status-text" :class="saveStatus">
              <el-icon v-if="saveStatus === 'saved'"><Check /></el-icon>
              {{
                saveStatus === 'saved' ? '已保存' : saveStatus === 'saving' ? '保存中…' : '未保存'
              }}
            </span>
          </div>
          <!-- 编辑器：独立的富文本/Markdown 双视图组件 -->
          <DotEditor v-model="editorContent" :file-path="editingFile" class="editor-main" />
        </div>
      </el-main>
    </el-container>
  </div>
</template>

<style scoped>
.calen-note-page {
  height: 100vh;
}

.el-container {
  height: 100%;
}

.el-aside {
  width: 20%;
  min-width: 200px;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.el-aside .el-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
  position: relative;
}

.el-aside .panel-title {
  font-size: 16px;
  font-weight: 600;
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
}

.calendar-panel {
  padding: 12px;
  width: 100%;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

.calendar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.calendar-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text);
}

.calendar-weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  text-align: center;
  font-size: 12px;
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
  flex: 1;
  align-content: start;
}

.calendar-day {
  aspect-ratio: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  cursor: pointer;
  border-radius: 4px;
  position: relative;
  transition: background-color 0.2s;
  color: var(--color-text);
}

.calendar-day.is-empty {
  cursor: default;
}

.calendar-day:not(.is-empty):hover {
  background-color: var(--color-primary) !important;
  color: #fff;
}

.calendar-day.is-today {
  color: var(--color-primary);
  font-weight: 600;
}

.calendar-day.is-selected {
  background-color: var(--color-primary);
  color: #fff;
}

.calendar-day.has-note .note-dot {
  position: absolute;
  bottom: 2px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background-color: var(--color-primary);
}

.files-section {
  padding: 12px;
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.files-tabs {
  height: 100%;
  display: flex;
  flex-direction: column;
}

:deep(.el-tabs__content) {
  flex: 1;
  overflow: hidden;
}

:deep(.el-tab-pane) {
  height: 100%;
  overflow-y: auto;
}

/* 常用文档样式 */
.common-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  margin-bottom: 8px;
}

.common-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text);
}

.add-common-file {
  cursor: pointer;
  color: var(--color-success);
  font-size: 18px;
}

.add-common-file:hover {
  color: var(--color-primary);
}

.file-row {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  margin-bottom: 4px;
  border-radius: 4px;
  cursor: pointer;
  background: var(--color-hover);
  transition: background-color 0.2s;
}

.file-row:hover {
  background: var(--color-border);
}

.file-row .action-icon {
  cursor: pointer;
  font-size: 18px;
  opacity: 0;
  transition: opacity 0.2s;
}

.file-row:hover .action-icon {
  opacity: 1;
}

.file-row .edit-icon {
  color: var(--color-primary);
  margin-right: 8px;
}

.file-row .delete-icon {
  color: var(--color-danger);
}

/* Tree 样式自定义 */
:deep(.el-tree) {
  background: transparent;
  color: var(--color-text);
}

:deep(.el-tree-node__content) {
  height: 32px;
  border-radius: 4px;
  margin-bottom: 2px;
  background: transparent;
  transition: background-color 0.2s;
}

:deep(.el-tree-node__content:hover) {
  background: var(--color-hover);
}

:deep(.el-tree-node.is-current > .el-tree-node__content) {
  background: var(--color-border);
}

:deep(.el-tree-node__expand-icon) {
  color: var(--color-text-secondary);
}

:deep(.el-tree-node__expand-icon.is-leaf) {
  color: transparent;
}

.tree-node {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding-right: 8px;
  font-size: 14px;
}

.node-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.node-label.is-file {
  cursor: pointer;
}

.node-label.is-file:hover {
  color: var(--color-primary);
}

/* 文件节点整行可点击：小手光标 + 行内悬停高亮 */
.tree-node.is-clickable {
  cursor: pointer;
}

.tree-node.is-clickable:hover .node-label {
  color: var(--color-primary);
}

.node-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.2s;
}

.tree-node:hover .node-actions {
  opacity: 1;
}

.action-icon {
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
  font-size: 16px;
}

.add-icon {
  color: var(--color-success);
}

.add-icon:hover {
  background-color: transparent;
}

.minus-icon {
  color: var(--color-danger);
}

.minus-icon:hover {
  background-color: transparent;
}

.edit-icon {
  color: var(--color-primary);
}

.edit-icon:hover {
  background-color: transparent;
}

.delete-icon {
  color: var(--color-danger);
}

.delete-icon:hover {
  background-color: transparent;
}

/* 编辑器区域：状态栏 + DotEditor 填满剩余空间 */
.el-main {
  padding: 0;
  height: 100%;
  overflow: hidden;
}

.editor-shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.editor-status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 16px;
  background: var(--el-bg-color);
  border-bottom: 1px solid var(--el-border-color-lighter);
  flex-shrink: 0;
}

.status-file {
  font-size: 13px;
  color: var(--el-text-color-regular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-text {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  flex-shrink: 0;
}

.status-text.saved {
  color: var(--color-success);
}

.status-text.saving,
.status-text.unsaved {
  color: var(--color-text-secondary);
}

.editor-main {
  flex: 1;
  min-height: 0;
}
</style>
