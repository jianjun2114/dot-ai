<script setup lang="ts">
/**
 * 文档编辑（百宝箱）——基于 ONLYOFFICE 的在线文档编辑页
 *
 * 整页只有一个原生文档编辑器（后端文档服务 + Document Server），
 * 顶栏右侧三个操作：
 * - 打开文档：本地选择 word / excel / ppt / pdf 等格式上传后打开
 * - 历史文档：后端已有文档列表，点击直接打开
 * - AI 编辑助手：侧栏对话，告知 AI 当前文档信息并生成内容，
 *   通过 DS Automation API（connector.callCommand）插入到在线文档
 *
 * 流程：POST /doc/upload → GET /doc/config/{id}（含 apiUrl/JWT/回调）
 * → 加载 api.js → new DocEditor；保存由 DS 回调后端写回存储。
 */
import { ref, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  FolderOpened,
  ChatDotRound,
  Document,
  Promotion,
  Loading,
  Setting
} from '@element-plus/icons-vue'
import BackHome from '../../components/BackHome.vue'
import { loadSettings, useSettings } from '../../composables/useSettings'
import { docFetch, buildMultipart } from '../../utils/docApi'
import { chat } from '../../composables/aichat'
import editDocSvg from '../../assets/edit_doc.svg'

const router = useRouter()

/* ============ 服务配置 ============ */

/** 读取设置中的后端文档服务地址 */
const readDocBase = async (): Promise<string> => {
  await loadSettings()
  const { settings } = useSettings()
  return settings.value.docEditServerUrl.trim().replace(/\/+$/, '')
}

const goSettings = (): void => {
  router.push({ name: 'Settings' })
}

/* ============ 文件与格式 ============ */

const busy = ref(false)
const configMissing = ref(false)
const loadError = ref('')

const baseName = (path: string): string => path.split(/[\\/]/).pop() || '文档'

/** 支持打开的扩展名（与后端 /doc/upload 约定一致） */
const OPEN_FILTERS = [
  {
    name: '文档（Word/Excel/PPT/PDF 等）',
    extensions: ['docx', 'xlsx', 'pptx', 'pdf', 'doc', 'xls', 'ppt', 'txt', 'csv']
  }
]

/** 扩展名 → DS documentType */
const EXT_TYPE: Record<string, string> = {
  docx: 'word',
  doc: 'word',
  txt: 'word',
  csv: 'cell',
  xlsx: 'cell',
  xls: 'cell',
  pptx: 'slide',
  ppt: 'slide',
  pdf: 'pdf'
}

/** 扩展名 → 中文类型名（AI 提示用） */
const EXT_LABEL: Record<string, string> = {
  docx: 'Word 文档',
  doc: 'Word 文档',
  txt: '文本文档',
  xlsx: 'Excel 表格',
  xls: 'Excel 表格',
  csv: 'CSV 表格',
  pptx: 'PPT 演示文稿',
  ppt: 'PPT 演示文稿',
  pdf: 'PDF 文档'
}

/* ============ 编辑器会话 ============ */

/** 当前文档信息 */
const currentDoc = ref<{ id: string; name: string; ext: string } | null>(null)
const editorMountRef = ref<HTMLDivElement | null>(null)
const editorReady = ref(false)

interface ConnectorLike {
  callCommand: (func: () => void, onExecute?: () => void, onError?: (e: unknown) => void) => void
}
interface EditorLike {
  createConnector?: () => Promise<ConnectorLike>
  destroyEditor?: () => void
}

const editorRef = ref<EditorLike | null>(null)

/** 动态加载 DS 的 api.js（一次性） */
const loadOnlyofficeApi = (apiUrl: string): Promise<void> =>
  new Promise((resolve, reject) => {
    if ((window as unknown as { DocsAPI?: unknown }).DocsAPI) {
      resolve()
      return
    }
    const script = document.createElement('script')
    script.src = apiUrl
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Document Server api.js 加载失败，请检查服务配置'))
    document.head.appendChild(script)
  })

/** 销毁当前编辑器实例 */
const destroyEditor = (): void => {
  try {
    editorRef.value?.destroyEditor?.()
  } catch {
    /* 忽略销毁异常 */
  }
  editorRef.value = null
  editorReady.value = false
  if (editorMountRef.value) editorMountRef.value.innerHTML = ''
}

/** 拉取编辑器配置并挂载编辑器（documentType 按扩展名修正） */
const mountEditor = async (docId: string, fileName: string, ext: string): Promise<void> => {
  const base = await readDocBase()
  const userName = encodeURIComponent('圆点AI 用户')
  const resp = await docFetch(`${base}/doc/config/${docId}?userName=${userName}`)
  if (!resp.ok) throw new Error(`获取编辑器配置失败（HTTP ${resp.status}）`)
  const config = resp.json() as {
    apiUrl?: string
    documentType?: string
    document?: { fileType?: string }
    [key: string]: unknown
  }
  if (!config.apiUrl) throw new Error('服务返回的配置缺少 apiUrl')
  // 后端可能固定返回 word，这里按真实扩展名修正
  const type = EXT_TYPE[ext]
  if (type) {
    config.documentType = type
    if (config.document && 'fileType' in config.document) config.document.fileType = ext
  }
  // 注意：后端启用了 JWT，config 已被签名，前端任何字段修改都会导致
  // DS 验签失败（"没有权限的操作"）。界面定制（去打印/logo/文件菜单）
  // 必须由后端在签名前合入 config，前端只做透传。
  await loadOnlyofficeApi(config.apiUrl)
  if (!editorMountRef.value) return
  destroyEditor()
  // 每次新建占位元素（DocEditor 按元素 id 挂载）
  const mountId = `onlyoffice-mount-${Date.now().toString(36)}`
  const placeholder = document.createElement('div')
  placeholder.id = mountId
  placeholder.style.cssText = 'width:100%;height:100%;'
  editorMountRef.value.appendChild(placeholder)

  const DocsAPI = (
    window as unknown as {
      DocsAPI: { DocEditor: new (el: string, cfg: object) => EditorLike }
    }
  ).DocsAPI
  editorRef.value = new DocsAPI.DocEditor(mountId, config as object)
  currentDoc.value = { id: docId, name: fileName, ext }
  editorReady.value = true
}

/** 打开本地文档：选择 → 上传 → 挂载 */
const openDocument = async (): Promise<void> => {
  const path = await window.dot.toolbox.file.select(OPEN_FILTERS)
  if (!path) return
  busy.value = true
  loadError.value = ''
  try {
    const base = await readDocBase()
    if (!base) {
      configMissing.value = true
      return
    }
    configMissing.value = false
    const fileName = baseName(path)
    const ext = (fileName.split('.').pop() || '').toLowerCase()
    if (!EXT_TYPE[ext]) throw new Error(`暂不支持打开 .${ext} 格式`)
    const buffer = (await window.dot.localFiles('read-base64', path)) as string
    const bytes = Uint8Array.from(atob(buffer), (c) => c.charCodeAt(0))
    const form = buildMultipart(fileName, bytes)
    const uploadResp = await docFetch(`${base}/doc/upload`, {
      method: 'POST',
      body: form.body,
      contentType: form.contentType
    })
    if (!uploadResp.ok) throw new Error(`上传失败（HTTP ${uploadResp.status}）`)
    const uploaded = uploadResp.json() as {
      id?: number | string
      docId?: number | string
      data?: { id?: number | string }
    }
    const docId = uploaded.id ?? uploaded.docId ?? uploaded.data?.id
    if (!docId) throw new Error('上传接口未返回文档 id')
    await mountEditor(String(docId), fileName.replace(/\.[^.]+$/, ''), ext)
  } catch (e) {
    loadError.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

/* ============ 历史文档 ============ */

interface DocListItem {
  id?: number | string
  docId?: number | string
  file_name?: string
  file_ext?: string
  name?: string
  title?: string
}

const historyDocs = ref<{ id: string; name: string; ext: string }[]>([])
const historyLoading = ref(false)

/** 拉取历史文档列表 */
const loadHistory = async (): Promise<void> => {
  const base = await readDocBase()
  if (!base) {
    configMissing.value = true
    return
  }
  configMissing.value = false
  historyLoading.value = true
  try {
    const resp = await docFetch(`${base}/doc/list`)
    if (!resp.ok) throw new Error(`获取文档列表失败（HTTP ${resp.status}）`)
    const raw = resp.json() as DocListItem[] | { data?: DocListItem[] }
    const list = Array.isArray(raw) ? raw : (raw.data ?? [])
    historyDocs.value = list
      .map((item) => ({
        id: String(item.id ?? item.docId ?? ''),
        name: String(item.file_name ?? item.name ?? item.title ?? '未命名文档'),
        ext: String(item.file_ext ?? '').toLowerCase()
      }))
      .filter((d) => d.id)
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    historyLoading.value = false
  }
}

/** 打开历史文档 */
const openHistoryDoc = async (doc: { id: string; name: string; ext: string }): Promise<void> => {
  busy.value = true
  loadError.value = ''
  try {
    await mountEditor(doc.id, doc.name.replace(/\.[^.]+$/, ''), doc.ext || 'docx')
  } catch (e) {
    loadError.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

/* ============ AI 编辑助手 ============ */

const aiPanelOpen = ref(false)
const aiPrompt = ref('')
const aiText = ref('')
const aiGenerating = ref(false)
const aiInserting = ref(false)

/** 生成内容：告知 AI 当前文档信息 */
const generateAiContent = async (): Promise<void> => {
  const prompt = aiPrompt.value.trim()
  if (!prompt) {
    ElMessage.warning('请先描述你想要生成的内容')
    return
  }
  const docLabel = currentDoc.value
    ? `当前打开的是一份${EXT_LABEL[currentDoc.value.ext] || currentDoc.value.ext.toUpperCase()}《${currentDoc.value.name}》。`
    : '当前没有打开的文档，请生成一份可直接使用的新内容。'
  aiGenerating.value = true
  aiText.value = ''
  try {
    const message =
      `${docLabel}用户需求：${prompt}\n` +
      '请直接输出要写入文档的正文内容（纯文本，用换行分段，不要输出解释、代码块标记或 Markdown 符号）。'
    await chat(message, { onDelta: (delta) => (aiText.value += delta) })
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    aiGenerating.value = false
  }
}

/** 通过 DS Automation API 把内容插入在线文档 */
const insertAiContent = async (): Promise<void> => {
  if (!currentDoc.value || !editorRef.value) {
    ElMessage.warning('请先打开一个文档')
    return
  }
  if (!aiText.value.trim()) {
    ElMessage.warning('请先生成内容')
    return
  }
  aiInserting.value = true
  try {
    const connector = await editorRef.value.createConnector?.()
    if (!connector) throw new Error('当前 Document Server 不支持 Automation API（connector）')
    // callCommand 的函数会被序列化后在 DS 沙箱执行，必须自包含：
    // 文本以 JSON 字面量内联进函数体，逐行创建段落插入文档
    const stmts =
      `var oDoc = Api.GetDocument();\n` +
      `var lines = ${JSON.stringify(aiText.value)}.split(/\\r?\\n/);\n` +
      `var els = [];\n` +
      `for (var i = 0; i < lines.length; i++) {\n` +
      `  var p = Api.CreateParagraph();\n` +
      `  p.AddText(lines[i]);\n` +
      `  els.push(p);\n` +
      `}\n` +
      `if (oDoc.InsertContent) { oDoc.InsertContent(els); }\n` +
      `else { for (var j = 0; j < els.length; j++) { oDoc.Push(els[j]); } }\n`
    connector.callCommand(new Function(stmts) as () => void)
    ElMessage.success('已插入到文档，稍等编辑器刷新后可见')
    aiPanelOpen.value = false
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    aiInserting.value = false
  }
}

onBeforeUnmount(() => {
  destroyEditor()
})
</script>

<template>
  <div class="doc-edit-view">
    <!-- 页头：返回 + 标题 + 右上角操作 -->
    <div class="page-header">
      <div class="header-left">
        <BackHome to="Toolbox" />
        <img :src="editDocSvg" class="header-icon" alt="" />
        <span class="header-title">文档编辑</span>
        <span v-if="currentDoc" class="doc-tag">
          {{ currentDoc.name }} · {{ EXT_LABEL[currentDoc.ext] || currentDoc.ext }}
        </span>
      </div>
      <div class="header-actions">
        <el-button :icon="FolderOpened" :loading="busy" @click="openDocument">打开文档</el-button>
        <el-dropdown
          trigger="click"
          @visible-change="
            (v: boolean) => {
              if (v) void loadHistory()
            }
          "
          @command="openHistoryDoc"
        >
          <el-button :icon="Document" :loading="historyLoading">历史文档</el-button>
          <template #dropdown>
            <el-dropdown-menu class="history-menu">
              <template v-if="historyDocs.length">
                <el-dropdown-item v-for="d in historyDocs" :key="d.id" :command="d">
                  <span class="history-item">{{ d.name }}</span>
                </el-dropdown-item>
              </template>
              <el-dropdown-item v-else disabled>暂无文档</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button
          :type="aiPanelOpen ? 'primary' : ''"
          :icon="ChatDotRound"
          @click="aiPanelOpen = !aiPanelOpen"
        >
          AI 编辑助手
        </el-button>
      </div>
    </div>

    <!-- 主体：编辑器 + AI 侧栏 -->
    <div class="page-body">
      <div class="editor-area">
        <!-- 未配置服务 -->
        <div v-if="configMissing" class="editor-placeholder">
          <el-empty description="尚未配置在线文档编辑服务地址">
            <el-button type="primary" :icon="Setting" @click="goSettings">去设置</el-button>
          </el-empty>
        </div>
        <!-- 打开失败 -->
        <div v-else-if="loadError" class="editor-placeholder">
          <el-empty :description="loadError">
            <el-button type="primary" @click="openDocument">重新打开</el-button>
          </el-empty>
        </div>
        <!-- 空状态 -->
        <div v-else-if="!editorReady && !busy" class="editor-placeholder">
          <el-empty description="选择右上角「打开文档」或「历史文档」开始编辑">
            <el-button type="primary" :icon="FolderOpened" @click="openDocument"
              >打开文档</el-button
            >
          </el-empty>
        </div>
        <!-- 编辑器挂载点 -->
        <div v-show="!configMissing && !loadError" v-loading="busy" class="editor-mount-wrap">
          <div ref="editorMountRef" class="editor-mount"></div>
        </div>
      </div>

      <!-- AI 编辑助手侧栏 -->
      <transition name="ai-slide">
        <div v-show="aiPanelOpen" class="ai-panel">
          <div class="ai-header">
            <span class="ai-title">AI 编辑助手</span>
            <span v-if="currentDoc" class="ai-doc-info">
              {{ EXT_LABEL[currentDoc.ext] || currentDoc.ext }} · {{ currentDoc.name }}
            </span>
          </div>
          <textarea
            v-model="aiPrompt"
            class="ai-input"
            placeholder="描述你的需求，例如：帮我起草一份项目周报，包括本周进展、风险和下周计划"
            rows="4"
          ></textarea>
          <el-button
            type="primary"
            class="ai-generate"
            :icon="aiGenerating ? Loading : Promotion"
            :loading="aiGenerating"
            @click="generateAiContent"
          >
            {{ aiGenerating ? '生成中…' : '生成内容' }}
          </el-button>
          <div v-if="aiText" class="ai-result">
            <pre class="ai-text">{{ aiText }}</pre>
            <el-button
              type="success"
              class="ai-insert"
              :icon="Promotion"
              :loading="aiInserting"
              :disabled="aiGenerating || !currentDoc"
              @click="insertAiContent"
            >
              插入到文档
            </el-button>
          </div>
        </div>
      </transition>
    </div>
  </div>
</template>

<style scoped>
/* ============ 页面骨架 ============ */
.doc-edit-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  overflow: hidden;
}

/* 页头 */
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-card);
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.header-icon {
  width: 22px;
  height: 22px;
}

.header-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
}

.doc-tag {
  font-size: 12px;
  color: var(--color-text-secondary);
  padding: 2px 10px;
  background: var(--color-hover);
  border-radius: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 280px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

/* 主体 */
.page-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.editor-area {
  flex: 1;
  min-width: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--color-hover);
}

.editor-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
}

.editor-mount-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
}

.editor-mount {
  width: 100%;
  height: 100%;
  min-height: 560px;
}

.editor-mount :deep(iframe) {
  width: 100%;
  height: 100%;
  border: none;
}

/* ============ AI 侧栏 ============ */
.ai-panel {
  width: 340px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border-left: 1px solid var(--color-border);
  background: var(--color-card);
  overflow-y: auto;
}

.ai-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ai-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}

.ai-doc-info {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.ai-input {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  min-height: 88px;
  padding: 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 13px;
  line-height: 1.6;
  font-family: inherit;
  outline: none;
}

.ai-input:focus {
  border-color: var(--color-primary);
}

.ai-generate {
  width: 100%;
}

.ai-result {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
  min-height: 0;
}

.ai-text {
  margin: 0;
  padding: 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  overflow-y: auto;
  max-height: 420px;
}

.ai-insert {
  width: 100%;
}

/* 侧栏滑入动画 */
.ai-slide-enter-active,
.ai-slide-leave-active {
  transition: all 0.25s ease;
}

.ai-slide-enter-from,
.ai-slide-leave-to {
  width: 0;
  padding: 0;
  opacity: 0;
}

/* 历史文档下拉 */
.history-item {
  display: inline-block;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
