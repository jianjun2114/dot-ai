<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, shallowRef } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Paperclip, Picture, Plus, Promotion } from '@element-plus/icons-vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import {
  TextStyle,
  Color,
  FontSize,
  FontFamily,
  BackgroundColor
} from '@tiptap/extension-text-style'
import TextAlign from '@tiptap/extension-text-align'
import Image from '@tiptap/extension-image'
import Underline from '@tiptap/extension-underline'
import { sendLlm } from '../../utils/aiRequest'
import { getAppPath } from '../../utils/config'

/** 账户（与 MailView 保持一致的结构子集） */
interface MailAccount {
  id: string
  type: 'imap' | 'exchange' | 'pop3'
  email: string
  password: string
  imapHost: string
  imapPort: number
  imapSsl?: boolean
  smtpHost: string
  smtpPort: number
  smtpSsl?: boolean
}

/** 草稿 */
interface MailDraft {
  id: string
  accountId: string
  to: string
  cc: string
  subject: string
  body: string
  updatedAt: string
}

/** 已发送邮件（本地存档） */
interface MailSent {
  id: string
  accountId: string
  to: string
  cc: string
  subject: string
  body: string
  date: string
}

/** 联系人 */
interface MailContact {
  id: string
  name: string
  email: string
}

interface MailJson {
  accounts: MailAccount[]
  drafts: MailDraft[]
  sents?: MailSent[]
  contacts?: MailContact[]
}

const mailJsonPath = ref('')
const account = ref<MailAccount | null>(null)
const draftId = ref('')
const sending = ref(false)

/** 当前账户的联系人列表 */
const contacts = ref<MailContact[]>([])

const compose = reactive({
  to: '',
  cc: '',
  subject: ''
})

const composeAttachments = ref<string[]>([])

// ==================== 联系人选择 ====================

const contactPicker = reactive({ visible: false, field: 'to' as 'to' | 'cc', selected: [] as string[] })

/** 当前编辑框内已有的地址集合 */
function parseField(field: 'to' | 'cc'): string[] {
  return compose[field]
    .split(/[;；]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 打开联系人选择弹框（预选已添加的联系人） */
function openContactPicker(field: 'to' | 'cc'): void {
  contactPicker.field = field
  const existing = parseField(field).map((s) => s.toLowerCase())
  contactPicker.selected = contacts.value
    .filter((c) => existing.includes(c.email.toLowerCase()))
    .map((c) => c.id)
  contactPicker.visible = true
}

/** 确认选择：用分号拼接替换该字段中的联系人邮箱（保留手填的非联系人地址） */
async function confirmContactPicker(): Promise<void> {
  const picked = contacts.value.filter((c) => contactPicker.selected.includes(c.id))
  // 保留手动填写的不在联系人列表中的地址
  const pickedEmails = new Set(picked.map((c) => c.email.toLowerCase()))
  const manual = parseField(contactPicker.field).filter(
    (s) => !contacts.value.some((c) => c.email.toLowerCase() === s.toLowerCase()) && !pickedEmails.has(s.toLowerCase())
  )
  const all = [...manual, ...picked.map((c) => (c.name ? `${c.name} <${c.email}>` : c.email))]
  compose[contactPicker.field] = all.join('; ')
  contactPicker.visible = false
}

// ==================== tiptap 富文本编辑器 ====================

const FONT_FAMILIES = [
  { label: '默认字体', value: '' },
  { label: '宋体', value: '宋体, SimSun, serif' },
  { label: '黑体', value: '黑体, SimHei, sans-serif' },
  { label: '微软雅黑', value: '微软雅黑, Microsoft YaHei, sans-serif' },
  { label: '楷体', value: '楷体, KaiTi, serif' },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Times New Roman', value: 'Times New Roman, serif' },
  { label: 'Courier New', value: 'Courier New, monospace' }
]
const FONT_SIZES = ['12px', '14px', '16px', '18px', '20px', '24px', '32px']

const PRESET_COLORS = [
  '#303133',
  '#409eff',
  '#67c23a',
  '#e6a23c',
  '#f56c6c',
  '#909399',
  '#b37feb',
  '#000000',
  '#ffffff'
]

const editor = shallowRef<Editor | null>(null)

/** 正文是否被修改过（关闭窗口时据此决定是否询问保存草稿） */
const dirty = ref(false)

function initEditor(initialHtml: string): void {
  editor.value?.destroy()
  dirty.value = false
  editor.value = new Editor({
    content: initialHtml,
    extensions: [
      StarterKit,
      Underline,
      Image.configure({ inline: true, allowBase64: true }),
      TextStyle,
      FontFamily,
      FontSize,
      Color,
      BackgroundColor,
      TextAlign.configure({ types: ['heading', 'paragraph'] })
    ]
  })
  editor.value.on('update', () => {
    dirty.value = true
  })
}

onUnmounted(() => editor.value?.destroy())

function chain(): ReturnType<Editor['chain']> {
  return editor.value!.chain().focus()
}

/** 字体：空值恢复默认 */
function applyFontFamily(value: string): void {
  const c = chain()
  if (value) c.setFontFamily(value).run()
  else c.unsetFontFamily().run()
}

/** 字号：空值恢复默认 */
function applyFontSize(size: string): void {
  const c = chain()
  if (size) c.setFontSize(size).run()
  else c.unsetFontSize().run()
}

/** 字体颜色：清空恢复默认 */
function applyFontColor(color: string | null): void {
  const c = chain()
  if (color) c.setColor(color).run()
  else c.unsetColor().run()
}

/** 背景颜色：清空移除背景 */
function applyBgColor(color: string | null): void {
  const c = chain()
  if (color) c.setBackgroundColor(color).run()
  else c.unsetBackgroundColor().run()
}

/** 选择本地图片并插入正文 */
async function insertImage(): Promise<void> {
  const path = await window.dot.toolbox.file.select([
    { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }
  ])
  if (!path) return
  try {
    const base64 = await window.dot.toolbox.mail.readFileBase64(path)
    const ext = path.split('.').pop()?.toLowerCase() || 'png'
    chain().setImage({ src: `data:image/${ext};base64,${base64}` }).run()
  } catch (err) {
    ElMessage.error(`插入图片失败: ${(err as Error).message}`)
  }
}

/** 添加附件（本地路径，发送时按路径读取） */
async function addAttachment(): Promise<void> {
  const path = await window.dot.toolbox.file.select([{ name: '所有文件', extensions: ['*'] }])
  if (!path) return
  if (composeAttachments.value.includes(path)) {
    ElMessage.warning('该附件已添加')
    return
  }
  composeAttachments.value.push(path)
}

function removeAttachment(path: string): void {
  composeAttachments.value = composeAttachments.value.filter((p) => p !== path)
}

// ==================== AI 辅助写邮件 ====================

const aiBox = reactive({ input: '', busy: false })

/** AI 生成 / 改写正文：已有正文则按指令改写，否则按指令撰写，替换整个正文 */
async function aiGenerate(): Promise<void> {
  const instruction = aiBox.input.trim()
  if (!instruction || aiBox.busy) return
  const currentHtml = editor.value?.getHTML() || ''
  aiBox.busy = true
  try {
    const res = await sendLlm([
      {
        role: 'system',
        content: [
          '你是邮件写作助手。根据用户指令撰写或修改邮件正文。',
          currentHtml && currentHtml !== '<p></p>'
            ? '当前已有正文（HTML），按指令在其基础上改写，返回完整的新正文。'
            : '当前没有正文，按指令撰写新正文。',
          '输出要求：只输出 HTML 正文片段（使用 <p>、<ul>/<ol>/<li>、<strong> 等标签），不要输出任何解释文字，不要用代码块包裹。语言与用户指令一致。'
        ].join(' ')
      },
      {
        role: 'user',
        content: currentHtml && currentHtml !== '<p></p>' ? `现有正文：\n${currentHtml}\n\n指令：${instruction}` : instruction
      }
    ])
    const html = res.content
      .trim()
      .replace(/^```(?:html)?\s*|\s*```$/g, '')
      .trim()
    if (!html) {
      ElMessage.warning('AI 未返回内容')
      return
    }
    editor.value?.commands.setContent(html)
    ElMessage.success('正文已生成，可继续编辑')
  } catch (err) {
    ElMessage.error(`AI 生成失败: ${(err as Error).message}`)
  } finally {
    aiBox.busy = false
  }
}

// ==================== mail.json 读写 ====================

async function loadMailJson(): Promise<MailJson> {
  const raw = (await window.dot.localFiles('read', mailJsonPath.value)) as string
  if (!raw) return { accounts: [], drafts: [] }
  try {
    return JSON.parse(raw) as MailJson
  } catch {
    return { accounts: [], drafts: [] }
  }
}

async function saveMailJson(data: MailJson): Promise<void> {
  await window.dot.localFiles('write', mailJsonPath.value, JSON.stringify(data, null, 2))
}

// ==================== 初始化：拉取 payload 与账户 ====================

async function initFromPayload(): Promise<void> {
  mailJsonPath.value = `${await getAppPath()}/mail.json`
  const payload = (await window.dot.toolbox.mail.takeComposePayload()) as {
    accountId?: string
    draftId?: string
    to?: string
    cc?: string
    subject?: string
    body?: string
    attachments?: string[]
  } | null
  const data = await loadMailJson()
  contacts.value = data.contacts || []
  if (payload?.accountId) {
    account.value = data.accounts.find((a) => a.id === payload.accountId) || data.accounts[0] || null
  } else {
    account.value = data.accounts[0] || null
  }
  draftId.value = payload?.draftId || ''
  compose.to = payload?.to || ''
  compose.cc = payload?.cc || ''
  compose.subject = payload?.subject || ''
  composeAttachments.value = payload?.attachments ? [...payload.attachments] : []
  initEditor(payload?.body || '')
}

onMounted(() => {
  void initFromPayload()
  // 复用窗口：重新拉取初始数据
  window.dot.toolbox.mail.onComposePayloadUpdated(() => void initFromPayload())
  // 点 X 关闭：确认是否保存草稿
  window.dot.toolbox.mail.onComposeCloseRequest(() => void confirmClose())
})

/** 关闭确认：正文有修改时询问是否保存草稿；未修改直接关闭 */
async function confirmClose(): Promise<void> {
  if (!dirty.value) {
    await window.dot.toolbox.mail.composeClose()
    return
  }
  try {
    await ElMessageBox.confirm('是否将当前内容保存到草稿箱？', '关闭写邮件', {
      confirmButtonText: '保存到草稿箱',
      cancelButtonText: '不保存',
      distinguishCancelAndClose: true,
      type: 'warning'
    })
    // 确认：保存草稿
    await saveDraft()
    await window.dot.toolbox.mail.composeClose()
  } catch (action: unknown) {
    if (action === 'cancel') {
      // "不保存"：直接关闭
      await window.dot.toolbox.mail.composeClose()
    }
    // close（点 X / Esc）：留在窗口
  }
}

// ==================== 存草稿 / 发送 ====================

/** 分号分隔字段 → 逗号分隔（SMTP RCPT TO 要求） */
function toSmtpList(field: string): string {
  return field
    .split(/[;；,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ')
}

async function saveDraft(): Promise<void> {
  const data = await loadMailJson()
  const record: MailDraft = {
    id: draftId.value || `draft_${Date.now()}`,
    accountId: account.value?.id || '',
    to: compose.to,
    cc: compose.cc,
    subject: compose.subject,
    body: editor.value?.getHTML() || '',
    updatedAt: new Date().toISOString()
  }
  if (draftId.value) {
    const idx = data.drafts.findIndex((d) => d.id === draftId.value)
    if (idx >= 0) data.drafts[idx] = record
    else data.drafts.push(record)
  } else {
    draftId.value = record.id
    data.drafts.push(record)
  }
  await saveMailJson(data)
  ElMessage.success('已保存草稿')
}

/** 发送：SMTP 发信 → 本地存档到发件箱 → 移除草稿 → 关闭窗口 */
async function sendMail(): Promise<void> {
  if (!account.value) {
    ElMessage.error('未找到邮箱账户，请先在邮箱页添加账户')
    return
  }
  if (!compose.to.trim()) {
    ElMessage.warning('请填写收件人')
    return
  }
  sending.value = true
  try {
    const res = await window.dot.toolbox.mail.send(account.value, {
      to: toSmtpList(compose.to),
      cc: compose.cc ? toSmtpList(compose.cc) : undefined,
      subject: compose.subject || '(无主题)',
      html: editor.value?.getHTML() || '',
      attachments: composeAttachments.value.length ? [...composeAttachments.value] : undefined
    })
    if (!res.success) {
      ElMessage.error(res.message)
      return
    }
    // 本地存档已发送邮件（最多保留 500 封）
    const data = await loadMailJson()
    data.sents = data.sents || []
    data.sents.unshift({
      id: `sent_${Date.now()}`,
      accountId: account.value.id,
      to: compose.to,
      cc: compose.cc,
      subject: compose.subject || '(无主题)',
      body: editor.value?.getHTML() || '',
      date: new Date().toISOString()
    })
    if (data.sents.length > 500) data.sents = data.sents.slice(0, 500)
    if (draftId.value) data.drafts = data.drafts.filter((d) => d.id !== draftId.value)
    await saveMailJson(data)
    ElMessage.success(res.message)
    await window.dot.toolbox.mail.composeClose()
  } finally {
    sending.value = false
  }
}

// ==================== 模板辅助 ====================

const contactPickerTitle = computed(() =>
  contactPicker.field === 'to' ? '选择收件人' : '选择抄送人'
)
</script>

<template>
  <div class="compose-page">
    <div class="compose-header">
      <span class="compose-title">写邮件</span>
      <span v-if="account" class="compose-account">{{ account.email }}</span>
    </div>
    <div class="compose-form">
      <div class="compose-row">
        <span class="compose-label">收件人</span>
        <el-input v-model="compose.to" placeholder="多个收件人用分号分隔" />
        <el-button class="row-plus" :icon="Plus" title="从联系人选择" @click="openContactPicker('to')" />
      </div>
      <div class="compose-row">
        <span class="compose-label">抄送</span>
        <el-input v-model="compose.cc" placeholder="可空，多个用分号分隔" />
        <el-button class="row-plus" :icon="Plus" title="从联系人选择" @click="openContactPicker('cc')" />
      </div>
      <div class="compose-row">
        <span class="compose-label">主题</span>
        <el-input v-model="compose.subject" placeholder="邮件主题" />
      </div>
      <!-- 富文本工具栏 -->
      <div class="editor-toolbar">
        <el-select
          size="small"
          class="tb-select font-select"
          :model-value="''"
          placeholder="字体"
          @change="(v: string) => applyFontFamily(v)"
        >
          <el-option v-for="f in FONT_FAMILIES" :key="f.label" :label="f.label" :value="f.value" />
        </el-select>
        <el-select
          size="small"
          class="tb-select size-select"
          :model-value="''"
          placeholder="字号"
          @change="(v: string) => applyFontSize(v)"
        >
          <el-option label="默认字号" value="" />
          <el-option v-for="s in FONT_SIZES" :key="s" :label="s" :value="s" />
        </el-select>
        <button
          type="button"
          class="tb-btn"
          @mousedown.prevent
          title="加粗"
          :class="{ active: editor?.isActive('bold') }"
          @click="chain().toggleBold().run()"
        >
          <b>B</b>
        </button>
        <button
          type="button"
          class="tb-btn"
          @mousedown.prevent
          title="倾斜"
          :class="{ active: editor?.isActive('italic') }"
          @click="chain().toggleItalic().run()"
        >
          <i>I</i>
        </button>
        <button
          type="button"
          class="tb-btn"
          @mousedown.prevent
          title="下划线"
          :class="{ active: editor?.isActive('underline') }"
          @click="chain().toggleUnderline().run()"
        >
          <u>U</u>
        </button>
        <button
          type="button"
          class="tb-btn"
          @mousedown.prevent
          title="有序列表"
          :class="{ active: editor?.isActive('orderedList') }"
          @click="chain().toggleOrderedList().run()"
        >
          1.
        </button>
        <button
          type="button"
          class="tb-btn"
          @mousedown.prevent
          title="左对齐"
          :class="{ active: editor?.isActive({ textAlign: 'left' }) }"
          @click="chain().setTextAlign('left').run()"
        >
          ☰
        </button>
        <button
          type="button"
          class="tb-btn"
          @mousedown.prevent
          title="居中"
          :class="{ active: editor?.isActive({ textAlign: 'center' }) }"
          @click="chain().setTextAlign('center').run()"
        >
          ☰
        </button>
        <button
          type="button"
          class="tb-btn"
          @mousedown.prevent
          title="右对齐"
          :class="{ active: editor?.isActive({ textAlign: 'right' }) }"
          @click="chain().setTextAlign('right').run()"
        >
          ☰
        </button>
        <span class="tb-color-label">字体颜色</span>
        <el-color-picker
          class="tb-color"
          :model-value="null"
          :predefine="PRESET_COLORS"
          size="small"
          title="字体颜色"
          @change="applyFontColor"
        />
        <span class="tb-color-label">背景颜色</span>
        <el-color-picker
          class="tb-color"
          :model-value="null"
          :predefine="PRESET_COLORS"
          size="small"
          title="背景颜色"
          @change="applyBgColor"
        />
        <button class="tb-btn" title="插入图片" @click="insertImage">
          <el-icon><Picture /></el-icon>
        </button>
        <button class="tb-btn" title="添加附件" @click="addAttachment">
          <el-icon><Paperclip /></el-icon>
        </button>
      </div>
      <!-- AI 辅助写邮件 -->
      <div class="ai-box">
        <el-input
          v-model="aiBox.input"
          size="small"
          placeholder="AI 辅助：输入要求，如“写一封会议通知，明天下午三点 201 会议室”；已有正文时可输入“更正式一点”改写"
          @keydown.enter.prevent="aiGenerate"
        />
        <el-button size="small" type="primary" :loading="aiBox.busy" @click="aiGenerate">
          AI 生成
        </el-button>
      </div>
      <!-- 正文编辑区 -->
      <editor-content v-if="editor" :editor="editor" class="compose-editor" />
      <!-- 附件列表 -->
      <div v-if="composeAttachments.length" class="attachment-list">
        <span v-for="path in composeAttachments" :key="path" class="attachment-chip" :title="path">
          {{ path.split(/[\\/]/).pop() }}
          <i class="chip-close" @click="removeAttachment(path)">×</i>
        </span>
      </div>
      <div class="compose-actions">
        <el-button type="primary" :icon="Promotion" :loading="sending" @click="sendMail">
          发送
        </el-button>
        <el-button @click="saveDraft">存草稿</el-button>
      </div>
    </div>

    <!-- 联系人选择弹框 -->
    <el-dialog v-model="contactPicker.visible" :title="contactPickerTitle" width="420px" append-to-body>
      <div v-if="contacts.length === 0" class="picker-empty">
        暂无联系人，可在邮箱页「联系人」中添加
      </div>
      <el-checkbox-group v-else v-model="contactPicker.selected" class="picker-list">
        <el-checkbox v-for="c in contacts" :key="c.id" :value="c.id" class="picker-item">
          <span class="picker-name">{{ c.name }}</span>
          <span class="picker-email">{{ c.email }}</span>
        </el-checkbox>
      </el-checkbox-group>
      <template #footer>
        <el-button @click="contactPicker.visible = false">取消</el-button>
        <el-button type="primary" :disabled="contacts.length === 0" @click="confirmContactPicker">
          添加
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.compose-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 16px 24px;
  box-sizing: border-box;
}

.compose-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.compose-title {
  font-size: 16px;
  font-weight: 600;
}

.compose-account {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.compose-form {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.compose-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.compose-row > .el-input {
  flex: 1;
}

.row-plus {
  flex-shrink: 0;
  padding: 0;
  width: 32px;
}

.compose-label {
  flex-shrink: 0;
  width: 56px;
  text-align: right;
  font-size: 13px;
  color: var(--color-text-secondary);
}

.editor-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--color-border, #dcdfe6);
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  background: var(--color-fill-1, #f5f7fa);
  flex-wrap: wrap;
}

.tb-select {
  width: 120px;
}

.tb-select.font-select {
  width: 130px;
}

.tb-select.size-select {
  width: 100px;
}

.tb-btn {
  height: 24px;
  min-width: 28px;
  padding: 0 6px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-primary, #303133);
  font-size: 13px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.tb-btn:hover {
  background: var(--color-fill-2, #e8eaed);
}

.tb-btn.active {
  background: var(--el-color-primary-light-8, #ecf5ff);
  color: var(--el-color-primary, #409eff);
}

.tb-color {
  width: 24px;
  height: 24px;
}

.tb-color-label {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin-right: 4px;
}

/* AI 辅助行 */
.ai-box {
  display: flex;
  gap: 8px;
}

.ai-box > .el-input {
  flex: 1;
}

.compose-editor {
  flex: 1;
  min-height: 200px;
  border: 1px solid var(--color-border, #dcdfe6);
  border-radius: 0 0 6px 6px;
  display: flex;
  flex-direction: column;
  background: var(--color-card, #fff);
}

.compose-editor :deep(.tiptap) {
  flex: 1;
  min-height: 200px;
  padding: 12px 14px;
  outline: none;
  font-size: 14px;
  line-height: 1.7;
  overflow-y: auto;
}

.compose-editor :deep(.tiptap img) {
  max-width: 100%;
}

/* 修复全局样式重置（base.css 的 * { font-weight: normal }）导致加粗丢失 */
.compose-editor :deep(.tiptap strong),
.compose-editor :deep(.tiptap b) {
  font-weight: 700;
}

.compose-editor :deep(.tiptap h1),
.compose-editor :deep(.tiptap h2),
.compose-editor :deep(.tiptap h3) {
  margin: 0.6em 0 0.4em;
  line-height: 1.4;
  font-weight: 600;
}

.attachment-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.attachment-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 280px;
  padding: 4px 10px;
  border-radius: 12px;
  background: var(--color-fill-1, #f5f7fa);
  border: 1px solid var(--color-border, #e4e7ed);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chip-close {
  cursor: pointer;
  font-style: normal;
  color: var(--color-text-secondary, #909399);
  font-size: 14px;
  line-height: 1;
}

.chip-close:hover {
  color: var(--el-color-danger, #f56c6c);
}

.compose-actions {
  display: flex;
  gap: 10px;
}

/* 联系人选择弹框 */
.picker-list {
  display: flex;
  flex-direction: column;
  max-height: 320px;
  overflow-y: auto;
}

.picker-item {
  display: flex;
  align-items: center;
  margin-right: 0;
}

.picker-name {
  font-weight: 600;
  margin-right: 10px;
}

.picker-email {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.picker-empty {
  color: var(--color-text-secondary);
  font-size: 13px;
  text-align: center;
  padding: 24px 0;
}
</style>
