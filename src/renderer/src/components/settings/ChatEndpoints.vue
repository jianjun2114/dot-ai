<script setup lang="ts">
/**
 * 智能对话模块
 *
 * 布局：上部分为当前选中接口的详情卡，下部分为接口列表
 * - 点击列表项 → 上部分展示详情
 * - 启用：全局互斥，同时只能启用一个接口
 * - 新增 / 编辑弹窗：名称、key 值、连接模式（HTTP / WS / 本地）、登录配置
 */
import { computed, ref } from 'vue'
import { Plus, Edit, Delete, Connection } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useSettings } from '../../composables/useSettings'
import { generateId } from '../../types/settings'
import type { ChatEndpoint, EndpointMode } from '../../types/settings'

const { settings } = useSettings()

/** 模式标签元信息 */
const MODE_META: Record<EndpointMode, { label: string; type: 'primary' | 'warning' | 'success' }> =
  {
    http: { label: 'HTTP', type: 'primary' },
    ws: { label: 'WS', type: 'warning' },
    local: { label: '本地', type: 'success' }
  }

/** 当前选中（上部分展示详情）的接口 id */
const selectedId = ref<string>('')
/** 弹窗可见性 */
const dialogVisible = ref(false)
/** 弹窗编辑模式：null = 新增，否则为正在编辑的接口 id */
const editingId = ref<string | null>(null)

/** 弹窗表单数据 */
const form = ref<ChatEndpoint>(createEmptyForm())

/** 创建空白表单 */
function createEmptyForm(): ChatEndpoint {
  return {
    id: '',
    name: '',
    key: '',
    mode: 'http',
    apiUrl: '',
    needLogin: false,
    login: { loginUrl: '', loginParams: '', sessionKeep: '' },
    localModelId: '',
    enabled: false
  }
}

/** 当前选中的接口 */
const selectedEndpoint = computed<ChatEndpoint | null>(
  () => settings.value.chatEndpoints.find((e) => e.id === selectedId.value) ?? null
)

/** 本地模式下关联的大模型名称 */
const localModelName = computed<string>(() => {
  const ep = selectedEndpoint.value
  if (!ep || ep.mode !== 'local') return ''
  const llm = settings.value.llmConfigs.find((l) => l.id === ep.localModelId)
  return llm?.name ?? '未关联'
})

/** 点击列表项：上部分展示详情 */
const selectEndpoint = (ep: ChatEndpoint): void => {
  selectedId.value = ep.id
}

/** 启用指定接口（互斥：同时只能启用一个） */
const enableEndpoint = (ep: ChatEndpoint): void => {
  if (ep.enabled) return
  settings.value.chatEndpoints.forEach((e) => {
    e.enabled = e.id === ep.id
  })
  ElMessage.success(`已启用「${ep.name}」`)
}

/** 打开新增弹窗 */
const openCreateDialog = (): void => {
  editingId.value = null
  form.value = createEmptyForm()
  dialogVisible.value = true
}

/** 打开编辑弹窗 */
const openEditDialog = (ep: ChatEndpoint): void => {
  editingId.value = ep.id
  // structuredClone 无法克隆 Vue 响应式代理对象，改用 JSON 深拷贝
  form.value = JSON.parse(JSON.stringify(ep)) as ChatEndpoint
  dialogVisible.value = true
}

/** 弹窗保存：新增或编辑 */
const handleSave = (): void => {
  const f = form.value
  if (!f.name.trim()) {
    ElMessage.warning('请填写名称')
    return
  }
  if (!f.key.trim()) {
    ElMessage.warning('请填写 Key 值')
    return
  }
  // 模式相关校验
  if (f.mode !== 'local' && !f.apiUrl.trim()) {
    ElMessage.warning('请填写对话接口地址')
    return
  }
  if (f.mode === 'local' && !f.localModelId) {
    ElMessage.warning('请选择本地大模型')
    return
  }
  if (f.needLogin && !f.login.loginUrl.trim()) {
    ElMessage.warning('已开启登录校验，请填写登录接口')
    return
  }

  if (editingId.value) {
    // 编辑：保留原启用状态
    const idx = settings.value.chatEndpoints.findIndex((e) => e.id === editingId.value)
    if (idx > -1) {
      const enabled = settings.value.chatEndpoints[idx].enabled
      settings.value.chatEndpoints[idx] = { ...f, id: editingId.value, enabled }
    }
  } else {
    // 新增：首个接口默认启用
    const enabled = settings.value.chatEndpoints.length === 0
    settings.value.chatEndpoints.push({ ...f, id: generateId(), enabled })
  }
  dialogVisible.value = false
  ElMessage.success('保存成功')
}

/** 删除接口（启用中的接口不允许删除） */
const handleDelete = async (ep: ChatEndpoint): Promise<void> => {
  if (ep.enabled) {
    ElMessage.warning('启用中的接口不可删除，请先启用其他接口')
    return
  }
  try {
    await ElMessageBox.confirm(`确定删除接口「${ep.name}」吗？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return // 用户取消
  }
  settings.value.chatEndpoints = settings.value.chatEndpoints.filter((e) => e.id !== ep.id)
  if (selectedId.value === ep.id) selectedId.value = ''
  ElMessage.success('删除成功')
}
</script>

<template>
  <section class="panel-section">
    <h2 class="section-title">智能对话</h2>

    <!-- 上部分：详情卡 -->
    <div class="card detail-card">
      <template v-if="selectedEndpoint">
        <div class="detail-head">
          <span class="detail-name">{{ selectedEndpoint.name }}</span>
          <el-tag :type="MODE_META[selectedEndpoint.mode].type" size="small" effect="light">
            {{ MODE_META[selectedEndpoint.mode].label }}
          </el-tag>
          <el-tag :type="selectedEndpoint.enabled ? 'success' : 'info'" size="small" effect="light">
            {{ selectedEndpoint.enabled ? '启用中' : '未启用' }}
          </el-tag>
        </div>
        <dl class="detail-grid">
          <div class="detail-item">
            <dt>Key 值</dt>
            <dd>{{ selectedEndpoint.key }}</dd>
          </div>
          <div v-if="selectedEndpoint.mode !== 'local'" class="detail-item">
            <dt>对话接口</dt>
            <dd>{{ selectedEndpoint.apiUrl }}</dd>
          </div>
          <div v-if="selectedEndpoint.mode === 'local'" class="detail-item">
            <dt>本地大模型</dt>
            <dd>{{ localModelName }}</dd>
          </div>
          <template v-if="selectedEndpoint.needLogin">
            <div class="detail-item">
              <dt>登录接口</dt>
              <dd>{{ selectedEndpoint.login.loginUrl }}</dd>
            </div>
            <div class="detail-item">
              <dt>登录参数</dt>
              <dd class="pre">{{ selectedEndpoint.login.loginParams || '—' }}</dd>
            </div>
            <div class="detail-item">
              <dt>会话保持</dt>
              <dd>{{ selectedEndpoint.login.sessionKeep || '—' }}</dd>
            </div>
          </template>
          <div v-else class="detail-item">
            <dt>登录</dt>
            <dd>不需要</dd>
          </div>
        </dl>
      </template>
      <div v-else class="detail-empty">
        <el-icon :size="28" class="empty-icon"><Connection /></el-icon>
        <p>点击下方接口卡查看详情</p>
      </div>
    </div>

    <!-- 下部分：接口列表 -->
    <div class="card list-card">
      <div class="list-head">
        <span class="card-title">接口列表</span>
        <el-button type="primary" :icon="Plus" size="small" @click="openCreateDialog">
          新增接口
        </el-button>
      </div>

      <div v-if="settings.chatEndpoints.length === 0" class="list-empty">
        <p>暂无接口配置，点击右上角「新增接口」开始配置</p>
      </div>

      <div
        v-for="ep in settings.chatEndpoints"
        :key="ep.id"
        class="endpoint-item"
        :class="{ selected: ep.id === selectedId }"
        @click="selectEndpoint(ep)"
      >
        <div class="endpoint-info">
          <div class="endpoint-name-row">
            <span class="endpoint-name">{{ ep.name }}</span>
            <el-tag :type="MODE_META[ep.mode].type" size="small" effect="light">
              {{ MODE_META[ep.mode].label }}
            </el-tag>
            <el-tag v-if="ep.enabled" type="success" size="small" effect="light">启用中</el-tag>
          </div>
          <span class="endpoint-url">
            {{ ep.mode === 'local' ? '本地大模型模式' : ep.apiUrl }}
          </span>
        </div>
        <div class="endpoint-actions" @click.stop>
          <el-button
            size="small"
            :type="ep.enabled ? 'success' : 'default'"
            :disabled="ep.enabled"
            plain
            @click="enableEndpoint(ep)"
          >
            {{ ep.enabled ? '已启用' : '启用' }}
          </el-button>
          <el-button size="small" :icon="Edit" plain @click="openEditDialog(ep)">编辑</el-button>
          <el-button size="small" :icon="Delete" plain type="danger" @click="handleDelete(ep)">
            删除
          </el-button>
        </div>
      </div>
    </div>

    <!-- 新增 / 编辑弹窗 -->
    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑接口' : '新增接口'"
      width="520px"
      destroy-on-close
    >
      <el-form label-width="90px" label-position="left">
        <el-form-item label="名称" required>
          <el-input v-model="form.name" placeholder="例如：主对话接口" />
        </el-form-item>
        <el-form-item label="Key 值" required>
          <el-input v-model="form.key" placeholder="接口标识 key" />
        </el-form-item>

        <!-- 连接模式选项卡 -->
        <el-form-item label="连接模式">
          <el-tabs v-model="form.mode" class="mode-tabs">
            <el-tab-pane label="HTTP" name="http" />
            <el-tab-pane label="WS" name="ws" />
            <el-tab-pane label="本地" name="local" />
          </el-tabs>
        </el-form-item>

        <!-- HTTP / WS：对话接口地址 -->
        <el-form-item v-if="form.mode !== 'local'" label="对话接口" required>
          <el-input
            v-model="form.apiUrl"
            :placeholder="form.mode === 'ws' ? 'ws:// 或 wss:// 地址' : 'https:// 地址'"
          />
        </el-form-item>

        <!-- 本地：选择智能配置中的大模型 -->
        <el-form-item v-else label="大模型" required>
          <el-select v-model="form.localModelId" placeholder="选择智能配置中的大模型">
            <el-option
              v-for="llm in settings.llmConfigs"
              :key="llm.id"
              :label="llm.name"
              :value="llm.id"
            />
          </el-select>
          <p v-if="settings.llmConfigs.length === 0" class="form-tip">
            暂无大模型配置，请先在「智能配置」中添加
          </p>
        </el-form-item>

        <!-- 是否需要登录 -->
        <el-form-item v-if="form.mode !== 'local'" label="需要登录">
          <el-switch v-model="form.needLogin" />
        </el-form-item>

        <!-- 登录配置 -->
        <template v-if="form.needLogin && form.mode !== 'local'">
          <el-form-item label="登录接口" required>
            <el-input v-model="form.login.loginUrl" placeholder="登录接口地址" />
          </el-form-item>
          <el-form-item label="参数">
            <el-input
              v-model="form.login.loginParams"
              type="textarea"
              :rows="3"
              placeholder='登录参数（JSON），例如 {"username":"admin","password":"123456"}'
            />
          </el-form-item>
          <el-form-item label="会话保持">
            <el-input
              v-model="form.login.sessionKeep"
              placeholder="例如：从响应 token 字段提取，请求时携带 Authorization"
            />
          </el-form-item>
        </template>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleSave">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
/* ============ 卡片容器 ============ */
.card {
  background: var(--color-card);
  border: 1px solid var(--color-border);
  border-radius: 14px;
  padding: 20px 24px;
  box-shadow: var(--shadow-card);
}

.detail-card {
  margin-bottom: 16px;
  min-height: 120px;
}

/* ============ 详情卡 ============ */
.detail-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}

.detail-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text);
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px 24px;
  margin: 0;
}

.detail-item dt {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin-bottom: 2px;
}

.detail-item dd {
  margin: 0;
  font-size: 14px;
  color: var(--color-text);
  word-break: break-all;
}

.detail-item dd.pre {
  white-space: pre-wrap;
  font-family: monospace;
  font-size: 13px;
}

/* 详情空态 */
.detail-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 20px 0;
  color: var(--color-text-secondary);
}

.detail-empty p {
  font-size: 13px;
  margin: 0;
}

.empty-icon {
  color: var(--color-primary-light);
}

/* ============ 列表卡 ============ */
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
}

.list-empty {
  padding: 24px 0;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: 13px;
}

/* 接口列表项 */
.endpoint-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  cursor: pointer;
  transition:
    border-color 0.2s ease,
    background-color 0.2s ease;
}

.endpoint-item + .endpoint-item {
  margin-top: 10px;
}

.endpoint-item:hover {
  background: var(--color-hover);
}

.endpoint-item.selected {
  border-color: var(--color-primary);
}

.endpoint-info {
  flex: 1;
  min-width: 0;
}

.endpoint-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.endpoint-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}

.endpoint-url {
  font-size: 12px;
  color: var(--color-text-secondary);
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.endpoint-actions {
  display: flex;
  flex-shrink: 0;
}

/* ============ 弹窗 ============ */
.mode-tabs {
  width: 100%;
}

.form-tip {
  font-size: 12px;
  color: var(--color-warning);
  margin: 4px 0 0;
  line-height: 1.4;
}

/* ============ 移动端适配 ============ */
@media (max-width: 768px) {
  .endpoint-item {
    flex-direction: column;
    align-items: stretch;
  }

  .endpoint-actions {
    justify-content: flex-end;
  }
}
</style>
