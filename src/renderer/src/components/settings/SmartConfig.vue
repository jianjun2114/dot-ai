<script setup lang="ts">
/**
 * 智能配置模块
 *
 * 三个子分类（大模型 / MCP / SKILL），均以列表卡展示，支持新增、编辑、删除：
 * - 大模型：列表内「启用」（互斥，同时只能启用一个）；弹窗左下角「测试连接」
 *   （调用 /chat/completions 验证连通性）
 * - MCP：JSON 格式配置文本；弹窗内「获取服务信息」（JSON-RPC initialize）、
 *   「获取工具列表」（JSON-RPC tools/list）；支持 Streamable HTTP 与 HTTP+SSE
 *   两种传输方式（直连失败自动降级 SSE）
 * - SKILL：名称、描述、提示词内容
 */
import { computed, ref } from 'vue'
import { Plus, Edit, Delete } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useSettings } from '../../composables/useSettings'
import { useAiLocalTools } from '../../composables/aiLocalTool'
import { generateId } from '../../types/settings'
import { normalizeLlmBase } from '../../utils/aiRequest'
import {
  parseMcpEntries,
  rpcCall,
  listMcpTools,
  INITIALIZE_PARAMS,
  type McpEntry
} from '../../utils/mcpClient'
import type {
  LlmApiFormat,
  LlmConfig,
  McpConfig,
  SkillConfig,
  SmartConfigType
} from '../../types/settings'

const { settings } = useSettings()

/** 内置工具列表（只读展示） */
const { tools: localTools } = useAiLocalTools()

/** 当前子分类 */
const activeType = ref<SmartConfigType>('llm')

/** 子分类元信息 */
const TYPE_TABS: { value: SmartConfigType; label: string; desc: string }[] = [
  { value: 'llm', label: '大模型', desc: '配置模型接口地址与密钥' },
  { value: 'mcp', label: 'MCP', desc: '以 JSON 格式配置 MCP 服务，支持 Streamable HTTP / SSE 传输' },
  { value: 'skill', label: 'SKILL', desc: '定义技能提示词' },
  { value: 'builtin', label: '内置工具', desc: '应用内置的本地工具，无需配置，AI 可直接调用' }
]

/** 各分类的空态提示 */
const EMPTY_TIPS: Record<SmartConfigType, string> = {
  llm: '暂无大模型配置，点击右上角「新增配置」开始添加',
  mcp: '暂无 MCP 配置，点击右上角「新增配置」开始添加',
  skill: '暂无 SKILL 配置，点击右上角「新增配置」开始添加',
  builtin: '内置工具由应用提供'
}

/** MCP 配置 JSON 的占位示例 */
const MCP_JSON_PLACEHOLDER = `{
  "mcpServers": {
    "example": { "url": "https://mcp.example.com/endpoint" },
    "local": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-xxx"] }
  }
}`

/** 弹窗加载态 */
const testingLlm = ref(false)
const fetchingInfo = ref(false)
const fetchingTools = ref(false)

/** 弹窗可见性与编辑目标（null = 新增） */
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)

/** 弹窗表单（三类共用一个 dialog，按 activeType 区分） */
const llmForm = ref<LlmConfig>(createLlmForm())
const mcpForm = ref<McpConfig>(createMcpForm())
const skillForm = ref<SkillConfig>(createSkillForm())

/** 大模型接口协议格式选项 */
const API_FORMAT_OPTIONS: { value: LlmApiFormat; label: string; desc: string }[] = [
  { value: 'completions', label: 'Chat Completions', desc: 'OpenAI 兼容（/chat/completions）' },
  { value: 'messages', label: 'Messages', desc: 'Anthropic（/messages）' },
  { value: 'responses', label: 'Responses', desc: 'OpenAI Responses（/responses）' }
]

function createLlmForm(): LlmConfig {
  return { id: '', name: '', baseUrl: '', apiKey: '', model: '', apiFormat: 'completions', enabled: false }
}

function createMcpForm(): McpConfig {
  return { id: '', name: '', configJson: '', tools: [], serverInfo: '' }
}

function createSkillForm(): SkillConfig {
  return { id: '', name: '', description: '', prompt: '' }
}

/** 弹窗标题 */
const dialogTitle = computed<string>(() => {
  const label = TYPE_TABS.find((t) => t.value === activeType.value)?.label ?? ''
  return `${editingId.value ? '编辑' : '新增'}${label}配置`
})

/* ---------------- 新增 / 编辑 / 删除 ---------------- */

/** 深拷贝（structuredClone 无法克隆 Vue 响应式代理对象） */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

/** 打开新增弹窗 */
const openCreateDialog = (): void => {
  editingId.value = null
  if (activeType.value === 'llm') llmForm.value = createLlmForm()
  else if (activeType.value === 'mcp') mcpForm.value = createMcpForm()
  else skillForm.value = createSkillForm()
  dialogVisible.value = true
}

/** 打开编辑弹窗 */
const openEditDialog = (id: string): void => {
  if (activeType.value === 'llm') {
    const target = settings.value.llmConfigs.find((c) => c.id === id)
    if (target) llmForm.value = deepClone(target)
  } else if (activeType.value === 'mcp') {
    const target = settings.value.mcpConfigs.find((c) => c.id === id)
    if (target) mcpForm.value = deepClone(target)
  } else {
    const target = settings.value.skillConfigs.find((c) => c.id === id)
    if (target) skillForm.value = deepClone(target)
  }
  editingId.value = id
  dialogVisible.value = true
}

/** 弹窗保存：按分类分发，校验失败时不关闭弹窗 */
const handleSave = (): void => {
  let ok = false
  if (activeType.value === 'llm') ok = saveLlm()
  else if (activeType.value === 'mcp') ok = saveMcp()
  else ok = saveSkill()
  if (!ok) return
  dialogVisible.value = false
  ElMessage.success('保存成功')
}

const saveLlm = (): boolean => {
  const f = llmForm.value
  if (!f.name.trim() || !f.baseUrl.trim() || !f.model.trim()) {
    ElMessage.warning('请完整填写名称、接口地址和模型名称')
    return false
  }
  upsertInList(settings.value.llmConfigs, f)
  return true
}

const saveMcp = (): boolean => {
  const f = mcpForm.value
  if (!f.name.trim()) {
    ElMessage.warning('请填写名称')
    return false
  }
  try {
    if (parseMcpEntries(f.configJson).length === 0) throw new Error('没有服务条目')
  } catch {
    ElMessage.warning('请填写有效的 MCP 配置 JSON')
    return false
  }
  upsertInList(settings.value.mcpConfigs, f)
  return true
}

const saveSkill = (): boolean => {
  const f = skillForm.value
  if (!f.name.trim()) {
    ElMessage.warning('请填写技能名称')
    return false
  }
  upsertInList(settings.value.skillConfigs, f)
  return true
}

/** 通用新增或更新 */
function upsertInList<T extends { id: string }>(list: T[], item: T): void {
  if (editingId.value) {
    const idx = list.findIndex((c) => c.id === editingId.value)
    if (idx > -1) list[idx] = { ...item, id: editingId.value }
  } else {
    list.push({ ...item, id: generateId() })
  }
}

/** 删除指定分类的配置项 */
const handleDelete = async (id: string): Promise<void> => {
  const label = TYPE_TABS.find((t) => t.value === activeType.value)?.label ?? ''
  try {
    await ElMessageBox.confirm(`确定删除该${label}配置吗？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return // 用户取消
  }
  if (activeType.value === 'llm') {
    settings.value.llmConfigs = settings.value.llmConfigs.filter((c) => c.id !== id)
  } else if (activeType.value === 'mcp') {
    settings.value.mcpConfigs = settings.value.mcpConfigs.filter((c) => c.id !== id)
  } else {
    settings.value.skillConfigs = settings.value.skillConfigs.filter((c) => c.id !== id)
  }
  ElMessage.success('删除成功')
}

/* ---------------- 大模型：启用（互斥） ---------------- */

/** 启用指定大模型（互斥：同时只能启用一个） */
const handleEnable = (llm: LlmConfig): void => {
  if (llm.enabled) return
  settings.value.llmConfigs = settings.value.llmConfigs.map((c) => ({
    ...c,
    enabled: c.id === llm.id
  }))
  ElMessage.success(`已启用「${llm.name}」`)
}

/* ---------------- 大模型：测试连接（弹窗内） ---------------- */

/** 按接口协议格式发送最小请求，验证连通性 */
const testLlmConnection = async (): Promise<void> => {
  const f = llmForm.value
  if (!f.baseUrl.trim() || !f.model.trim()) {
    ElMessage.warning('请先填写接口地址和模型名称')
    return
  }
  const label = f.name.trim() || '当前配置'
  testingLlm.value = true
  try {
    const base = normalizeLlmBase(f.baseUrl)
    const format = f.apiFormat ?? 'completions'
    let url: string
    let body: string
    let headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (format === 'messages') {
      url = `${base}/v1/messages`
      body = JSON.stringify({
        model: f.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }]
      })
      headers['x-api-key'] = f.apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else if (format === 'responses') {
      url = `${base}/v1/responses`
      body = JSON.stringify({ model: f.model, input: 'ping', max_output_tokens: 1 })
      headers.Authorization = `Bearer ${f.apiKey}`
    } else {
      url = `${base}/v1/chat/completions`
      body = JSON.stringify({
        model: f.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1
      })
      headers.Authorization = `Bearer ${f.apiKey}`
    }
    const res = await window.dot.httpRequest('POST', url, body, headers)
    if (res.status >= 200 && res.status < 300) {
      ElMessage.success(`「${label}」连接成功`)
    } else {
      ElMessage.error(`「${label}」连接失败（HTTP ${res.status}）`)
    }
  } catch (error) {
    ElMessage.error(`「${label}」连接失败：${String(error)}`)
  } finally {
    testingLlm.value = false
  }
}

/* ---------------- MCP：配置 JSON 解析与远程获取 ---------------- */
/* 传输层与 JSON-RPC 细节封装在 utils/mcpClient，此处仅保留交互逻辑 */

/** 列表展示用：摘要描述配置中的服务 */
function describeMcp(json: string): string {
  try {
    return parseMcpEntries(json)
      .map((e) => `${e.name}（${e.url ?? e.command ?? 'stdio'}）`)
      .join('；')
  } catch {
    return '配置 JSON 无效'
  }
}

/** 解析当前表单中可远程访问的 url 类型服务条目，失败时给出提示 */
function resolveHttpEntries(): McpEntry[] | null {
  let entries: McpEntry[]
  try {
    entries = parseMcpEntries(mcpForm.value.configJson)
  } catch {
    ElMessage.warning('配置 JSON 格式无效')
    return null
  }
  const httpEntries = entries.filter((e) => e.url)
  if (httpEntries.length === 0) {
    ElMessage.warning('配置中没有 url 类型的服务，command 类型需在本地启动后才能远程获取')
    return null
  }
  return httpEntries
}

/** 获取服务信息：JSON-RPC initialize */
const fetchMcpInfo = async (): Promise<void> => {
  const entries = resolveHttpEntries()
  if (!entries) return
  fetchingInfo.value = true
  try {
    const infos: string[] = []
    for (const e of entries) {
      const result = await rpcCall(e.url as string, 'initialize', INITIALIZE_PARAMS)
      const si = result.serverInfo as { name?: string; version?: string } | undefined
      infos.push(`${e.name}：${si?.name ?? '未知服务'}${si?.version ? ` v${si.version}` : ''}`)
    }
    mcpForm.value.serverInfo = infos.join('；')
    ElMessage.success('获取服务信息成功')
  } catch (error) {
    ElMessage.error(`获取服务信息失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    fetchingInfo.value = false
  }
}

/** 获取工具列表：initialize 后 JSON-RPC tools/list */
const fetchMcpTools = async (): Promise<void> => {
  const entries = resolveHttpEntries()
  if (!entries) return
  fetchingTools.value = true
  try {
    const tools: string[] = []
    for (const e of entries) {
      const list = await listMcpTools(e.url as string)
      for (const t of list) tools.push(entries.length > 1 ? `${e.name}:${t.name}` : t.name)
    }
    mcpForm.value.tools = tools
    ElMessage.success(tools.length > 0 ? `获取到 ${tools.length} 个工具` : '服务未返回任何工具')
  } catch (error) {
    ElMessage.error(`获取工具列表失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    fetchingTools.value = false
  }
}
</script>

<template>
  <section class="panel-section">
    <h2 class="section-title">智能配置</h2>

    <!-- 分类切换 -->
    <div class="sub-tabs">
      <button
        v-for="tab in TYPE_TABS"
        :key="tab.value"
        type="button"
        class="sub-tab"
        :class="{ active: activeType === tab.value }"
        @click="activeType = tab.value"
      >
        {{ tab.label }}
      </button>
    </div>
    <p class="sub-desc">{{ TYPE_TABS.find((t) => t.value === activeType)?.desc }}</p>

    <!-- 大模型列表 -->
    <template v-if="activeType === 'llm'">
      <div class="list-head">
        <span class="list-count">共 {{ settings.llmConfigs.length }} 项</span>
        <el-button type="primary" :icon="Plus" size="small" @click="openCreateDialog">
          新增配置
        </el-button>
      </div>
      <div v-if="settings.llmConfigs.length === 0" class="list-empty">{{ EMPTY_TIPS.llm }}</div>
      <div v-for="llm in settings.llmConfigs" :key="llm.id" class="config-item">
        <div class="config-info">
          <span class="config-name">
            {{ llm.name }}
            <el-tag v-if="llm.enabled" type="success" size="small" effect="light" class="enabled-tag">
              启用中
            </el-tag>
          </span>
          <span class="config-meta">
            模型：{{ llm.model }}
            （{{ API_FORMAT_OPTIONS.find((o) => o.value === (llm.apiFormat ?? 'completions'))?.label }}）
          </span>
          <span class="config-meta">{{ llm.baseUrl }}</span>
        </div>
        <div class="config-actions">
          <el-button
            size="small"
            :type="llm.enabled ? 'success' : 'default'"
            :disabled="llm.enabled"
            @click="handleEnable(llm)"
          >
            {{ llm.enabled ? '已启用' : '启用' }}
          </el-button>
          <el-button size="small" :icon="Edit" plain @click="openEditDialog(llm.id)"
            >编辑</el-button
          >
          <el-button size="small" :icon="Delete" plain type="danger" @click="handleDelete(llm.id)">
            删除
          </el-button>
        </div>
      </div>
    </template>

    <!-- MCP 列表 -->
    <template v-else-if="activeType === 'mcp'">
      <div class="list-head">
        <span class="list-count">共 {{ settings.mcpConfigs.length }} 项</span>
        <el-button type="primary" :icon="Plus" size="small" @click="openCreateDialog">
          新增配置
        </el-button>
      </div>
      <div v-if="settings.mcpConfigs.length === 0" class="list-empty">{{ EMPTY_TIPS.mcp }}</div>
      <div v-for="mcp in settings.mcpConfigs" :key="mcp.id" class="config-item">
        <div class="config-info">
          <span class="config-name">{{ mcp.name }}</span>
          <span class="config-meta">{{ describeMcp(mcp.configJson) }}</span>
          <span class="config-meta">
            工具：{{ mcp.tools.length > 0 ? mcp.tools.join('、') : '尚未获取' }}
          </span>
        </div>
        <div class="config-actions">
          <el-button size="small" :icon="Edit" plain @click="openEditDialog(mcp.id)"
            >编辑</el-button
          >
          <el-button size="small" :icon="Delete" plain type="danger" @click="handleDelete(mcp.id)">
            删除
          </el-button>
        </div>
      </div>
    </template>

    <!-- SKILL 列表 -->
    <template v-else-if="activeType === 'skill'">
      <div class="list-head">
        <span class="list-count">共 {{ settings.skillConfigs.length }} 项</span>
        <el-button type="primary" :icon="Plus" size="small" @click="openCreateDialog">
          新增配置
        </el-button>
      </div>
      <div v-if="settings.skillConfigs.length === 0" class="list-empty">
        {{ EMPTY_TIPS.skill }}
      </div>
      <div v-for="skill in settings.skillConfigs" :key="skill.id" class="config-item">
        <div class="config-info">
          <span class="config-name">{{ skill.name }}</span>
          <span class="config-meta">{{ skill.description || '暂无描述' }}</span>
        </div>
        <div class="config-actions">
          <el-button size="small" :icon="Edit" plain @click="openEditDialog(skill.id)">
            编辑
          </el-button>
          <el-button
            size="small"
            :icon="Delete"
            plain
            type="danger"
            @click="handleDelete(skill.id)"
          >
            删除
          </el-button>
        </div>
      </div>
    </template>

    <!-- 内置工具列表（只读） -->
    <template v-else>
      <div class="list-head">
        <span class="list-count">共 {{ localTools.length }} 项</span>
      </div>
      <div v-for="tool in localTools" :key="tool.id" class="config-item">
        <div class="config-info">
          <span class="config-name">{{ tool.name }}</span>
          <span class="config-meta">{{ tool.description }}</span>
          <span class="config-meta">
            参数：{{
              tool.params.length > 0
                ? tool.params
                    .map((p) => `${p.name}${p.required ? '*' : ''}（${p.description}）`)
                    .join('、')
                : '无'
            }}
          </span>
        </div>
        <span class="builtin-badge">内置</span>
      </div>
    </template>

    <!-- 新增 / 编辑弹窗 -->
    <el-dialog
      v-model="dialogVisible"
      :title="dialogTitle"
      width="560px"
      destroy-on-close
      @closed="editingId = null"
    >
      <!-- 大模型表单 -->
      <el-form v-if="activeType === 'llm'" label-width="90px" label-position="left">
        <el-form-item label="名称" required>
          <el-input v-model="llmForm.name" placeholder="例如：GPT-4o 生产环境" />
        </el-form-item>
        <el-form-item label="接口地址" required>
          <el-input v-model="llmForm.baseUrl" placeholder="http://api.example.com（不含 /v1）" />
        </el-form-item>
        <el-form-item label="API 格式">
          <el-select v-model="llmForm.apiFormat" placeholder="选择接口协议格式">
            <el-option
              v-for="opt in API_FORMAT_OPTIONS"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            >
              <span>{{ opt.label }}</span>
              <span class="format-option-desc">{{ opt.desc }}</span>
            </el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="API Key">
          <el-input v-model="llmForm.apiKey" type="password" show-password placeholder="sk-..." />
        </el-form-item>
        <el-form-item label="模型名称" required>
          <el-input v-model="llmForm.model" placeholder="例如：gpt-4o" />
        </el-form-item>
      </el-form>

      <!-- MCP 表单 -->
      <el-form v-else-if="activeType === 'mcp'" label-width="90px" label-position="left">
        <el-form-item label="名称" required>
          <el-input v-model="mcpForm.name" placeholder="例如：文件系统 MCP" />
        </el-form-item>
        <el-form-item label="配置 JSON" required>
          <el-input
            v-model="mcpForm.configJson"
            type="textarea"
            :rows="10"
            :placeholder="MCP_JSON_PLACEHOLDER"
          />
        </el-form-item>
        <el-form-item>
          <el-button :loading="fetchingInfo" @click="fetchMcpInfo">获取服务信息</el-button>
          <el-button :loading="fetchingTools" @click="fetchMcpTools">获取工具列表</el-button>
        </el-form-item>
        <el-form-item v-if="mcpForm.serverInfo" label="服务信息">
          <span class="mcp-result">{{ mcpForm.serverInfo }}</span>
        </el-form-item>
        <el-form-item v-if="mcpForm.tools.length > 0" label="工具列表">
          <div class="mcp-tools">
            <el-tag v-for="tool in mcpForm.tools" :key="tool" size="small">{{ tool }}</el-tag>
          </div>
        </el-form-item>
      </el-form>

      <!-- SKILL 表单 -->
      <el-form v-else label-width="90px" label-position="left">
        <el-form-item label="名称" required>
          <el-input v-model="skillForm.name" placeholder="例如：周报生成" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="skillForm.description" placeholder="技能的简要说明" />
        </el-form-item>
        <el-form-item label="提示词">
          <el-input
            v-model="skillForm.prompt"
            type="textarea"
            :rows="6"
            placeholder="技能的提示词内容"
          />
        </el-form-item>
      </el-form>

      <template #footer>
        <div class="dialog-footer">
          <!-- 大模型：测试连接固定在左下角 -->
          <el-button
            v-if="activeType === 'llm'"
            type="primary"
            plain
            :loading="testingLlm"
            @click="testLlmConnection"
          >
            测试连接
          </el-button>
          <span v-else></span>
          <div class="footer-main">
            <el-button @click="dialogVisible = false">取消</el-button>
            <el-button type="primary" @click="handleSave">保存</el-button>
          </div>
        </div>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
/* ============ 分类切换 ============ */
.sub-tabs {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 10px;
}

.sub-tab {
  padding: 7px 22px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 14px;
  cursor: pointer;
  transition:
    background-color 0.2s ease,
    color 0.2s ease;
}

.sub-tab:hover {
  color: var(--color-text);
}

.sub-tab.active {
  background: var(--color-primary);
  color: #ffffff;
  font-weight: 500;
}

.sub-desc {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin: 10px 0 16px;
}

/* ============ 列表 ============ */
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.list-count {
  font-size: 13px;
  color: var(--color-text-secondary);
}

.list-empty {
  padding: 32px 0;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: 13px;
}

/* 配置列表项 */
.config-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px;
  background: var(--color-card);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}

.config-item + .config-item {
  margin-top: 10px;
}

.config-item:hover {
  border-color: var(--color-primary-light);
  box-shadow: var(--shadow-card-hover);
}

.config-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.config-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}

.config-meta {
  font-size: 12px;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.config-actions {
  display: flex;
  flex-shrink: 0;
}

/* ============ 弹窗 ============ */
.dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.footer-main {
  display: flex;
}

.enabled-tag {
  margin-left: 6px;
}

.builtin-badge {
  flex-shrink: 0;
  padding: 2px 10px;
  font-size: 12px;
  color: var(--color-primary);
  border: 1px solid var(--color-primary-light);
  border-radius: 4px;
}

.mcp-result {
  font-size: 12px;
  color: var(--color-text-secondary);
  word-break: break-all;
}

.mcp-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* API 格式下拉选项的说明文字 */
.format-option-desc {
  float: right;
  margin-left: 12px;
  font-size: 12px;
  color: var(--color-text-secondary);
}

/* ============ 移动端适配 ============ */
@media (max-width: 768px) {
  .config-item {
    flex-direction: column;
    align-items: stretch;
  }

  .config-actions {
    justify-content: flex-end;
  }
}
</style>
