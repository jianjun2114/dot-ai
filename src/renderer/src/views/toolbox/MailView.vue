<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft, CaretBottom, Message, Plus, Refresh } from '@element-plus/icons-vue'
import { sendLlm } from '../../utils/aiRequest'
import { getAppPath } from '../../utils/config'

const router = useRouter()

// ==================== 账户存储（mail.json） ====================

/** mail.json 数据结构：账户 + 当前账户 + 草稿箱 + 已发送 + 联系人 + POP3 本地已读记录 */
interface MailStore {
  accounts: MailAccount[]
  currentId: string
  drafts: MailDraft[]
  sents?: MailSent[]
  contacts?: MailContact[]
  /** POP3 无服务器已读标志：按账户记录已读 uid */
  seenIds?: Record<string, number[]>
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

/** 账户类型预设：label 展示名，收发服务器默认端口 */
const ACCOUNT_PRESETS: Record<MailAccountType, { label: string }> = {
  imap: { label: 'IMAP' },
  pop3: { label: 'POP3' },
  exchange: { label: 'Exchange' }
}

/** 当前账户是否支持真实收发（IMAP / POP3；Exchange 仅保存配置） */
function isSupported(account: MailAccount | undefined): boolean {
  return !!account && ['imap', 'pop3'].includes(account.type)
}

const mailJsonPath = ref('')
const store = reactive<MailStore>({ accounts: [], currentId: '', drafts: [] })

/** 读取 mail.json（不存在时返回空结构） */
async function loadStore(): Promise<void> {
  mailJsonPath.value = `${await getAppPath()}/mail.json`
  try {
    const raw = (await window.dot.localFiles('read', mailJsonPath.value)) as string
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<MailStore>
      store.accounts = parsed.accounts || []
      store.currentId = parsed.currentId || ''
      store.drafts = parsed.drafts || []
      store.sents = parsed.sents || []
      store.contacts = parsed.contacts || []
      store.seenIds = parsed.seenIds || {}
    }
  } catch {
    // 文件损坏时按空数据处理
  }
}

/** 持久化 mail.json */
async function saveStore(): Promise<void> {
  await window.dot.localFiles('write', mailJsonPath.value, JSON.stringify(store, null, 2))
}

/** 当前账户：必须返回纯对象（去 reactivity Proxy），否则 IPC 经 contextBridge 传参时报 "An object could not be cloned" */
const currentAccount = computed<MailAccount | undefined>(() => {
  const account = store.accounts.find((a) => a.id === store.currentId)
  return account ? JSON.parse(JSON.stringify(account)) : undefined
})

// ==================== 账户下拉与新增账户 ====================

/** 下拉指令：switch:<id> 切换账户，add 新增账户 */
function onAccountCommand(cmd: string | number | object): void {
  const s = String(cmd)
  if (s === 'add') {
    resetAccountForm()
    addDialogVisible.value = true
    return
  }
  if (s.startsWith('switch:')) {
    if (store.currentId === s.slice(7)) return
    store.currentId = s.slice(7)
    void saveStore()
    clearMailState()
    void refreshInbox()
  }
}

/** 删除账户（同步清掉当前指针与相关草稿） */
async function deleteAccount(account: MailAccount): Promise<void> {
  store.accounts = store.accounts.filter((a) => a.id !== account.id)
  store.drafts = store.drafts.filter((d) => d.accountId !== account.id)
  if (store.currentId === account.id) store.currentId = store.accounts[0]?.id || ''
  await saveStore()
  clearMailState()
  if (currentAccount.value) void refreshInbox()
  ElMessage.success(`已删除账户 ${account.email}`)
}

// 新增账户表单
const addDialogVisible = ref(false)
const accountForm = reactive({
  type: 'imap' as MailAccountType,
  email: '',
  password: '',
  imapHost: '',
  imapPort: 993,
  imapSsl: true,
  smtpHost: '',
  smtpPort: 465,
  smtpSsl: true
})
const testing = ref(false)

// 端口跟随 SSL 勾选联动：收件 POP3 995/110、IMAP/Exchange 993/143；发件 465/25
watch(
  () => accountForm.imapSsl,
  (ssl) => {
    accountForm.imapPort =
      accountForm.type === 'pop3' ? (ssl ? 995 : 110) : ssl ? 993 : 143
  }
)
watch(
  () => accountForm.smtpSsl,
  (ssl) => {
    accountForm.smtpPort = ssl ? 465 : 25
  }
)

/** 切换类型时按默认端口重置服务器信息（主机清空待填） */
function resetAccountForm(type: MailAccountType = 'imap'): void {
  accountForm.type = type
  accountForm.email = ''
  accountForm.password = ''
  applyTypeDefaults(type)
}

/** 按类型填充默认端口与 SSL（IMAP: 993/465 全 SSL；POP3: 110 不加密、465 SSL；Exchange: 443/587 STARTTLS） */
function applyTypeDefaults(type: MailAccountType): void {
  if (type === 'pop3') {
    accountForm.imapHost = ''
    accountForm.imapPort = 110
    accountForm.imapSsl = false
    accountForm.smtpHost = ''
    accountForm.smtpPort = 465
    accountForm.smtpSsl = true
  } else if (type === 'exchange') {
    accountForm.imapHost = ''
    accountForm.imapPort = 443
    accountForm.imapSsl = true
    accountForm.smtpHost = ''
    accountForm.smtpPort = 587
    accountForm.smtpSsl = false
  } else {
    accountForm.imapHost = ''
    accountForm.imapPort = 993
    accountForm.imapSsl = true
    accountForm.smtpHost = ''
    accountForm.smtpPort = 465
    accountForm.smtpSsl = true
  }
}

/** 测试账户连通性（不保存） */
async function testAccount(): Promise<void> {
  if (!accountForm.email || !accountForm.password) {
    ElMessage.warning('请先填写邮箱和密码/授权码')
    return
  }
  testing.value = true
  try {
    const res = await window.dot.toolbox.mail.test({ ...accountForm, id: '' })
    if (res.success) ElMessage.success(res.message)
    else ElMessage.error(res.message)
  } finally {
    testing.value = false
  }
}

/** 保存新账户 */
async function saveAccount(): Promise<void> {
  if (!accountForm.email || !accountForm.password) {
    ElMessage.warning('请填写邮箱和密码/授权码')
    return
  }
  const account: MailAccount = { ...accountForm, id: `acc_${Date.now()}` }
  store.accounts.push(account)
  store.currentId = account.id
  await saveStore()
  addDialogVisible.value = false
  clearMailState()
  void refreshInbox()
  ElMessage.success('账户已保存到 mail.json')
}

// ==================== 收件箱 ====================

type Tab = 'inbox' | 'sent' | 'drafts' | 'contacts'
const tab = ref<Tab>('inbox')
const mails = ref<MailSummary[]>([])
const loading = ref(false)
const selectedUids = ref<number[]>([])
const current = ref<MailDetail | null>(null)
const currentLoading = ref(false)

/** 邮件详情缓存：uid → 详情（二次打开秒开；切换账户时清空） */
const detailCache = new Map<number, MailDetail>()

/** 清空邮件相关状态（切换账户时） */
function clearMailState(): void {
  mails.value = []
  selectedUids.value = []
  current.value = null
  detailCache.clear()
  lastCheckIndex = -1
}

/** 点击"收取"：首次全量收取；已有列表时增量收取（POP3 跳过已知邮件，IMAP 只取更新 UID），新邮件插入最上层 */
async function refreshInbox(): Promise<void> {
  const account = currentAccount.value
  if (!account) {
    ElMessage.info('请先在右上角添加邮箱账户')
    return
  }
  if (!isSupported(account)) {
    ElMessage.warning(`${ACCOUNT_PRESETS[account.type].label}暂不支持收取，请使用 IMAP / POP3 账户`)
    return
  }
  loading.value = true
  try {
    // 增量选项：已有列表时只收取新邮件
    const knownUids = mails.value.map((m) => m.uid)
    const sinceUid = knownUids.length ? Math.max(...knownUids) : undefined
    const incremental = account.type === 'pop3' ? knownUids.length > 0 : !!sinceUid
    const options = account.type === 'pop3' ? { knownUids } : { sinceUid }

    const fetched = await window.dot.toolbox.mail.list(
      account,
      incremental ? options : undefined
    )
    if (incremental) {
      // 新邮件按时间倒序插入最上层，已有邮件保持原样（含本地已读标志）
      const existing = new Set(knownUids)
      const fresh = fetched
        .filter((m) => !existing.has(m.uid))
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      mails.value = [...fresh, ...mails.value]
    } else {
      mails.value = fetched
      selectedUids.value = []
      current.value = null
    }
    // POP3：把本地维护的已读记录套回列表
    if (account.type === 'pop3') {
      const seen = store.seenIds?.[account.id] || []
      mails.value.forEach((m) => (m.seen = seen.includes(m.uid)))
    }
  } catch (err) {
    ElMessage.error(`收取邮件失败: ${(err as Error).message}`)
  } finally {
    loading.value = false
  }
}

// ---------- 收取时间范围 ----------

/** 近多少天：0 表示全部 */
const rangeDays = ref(0)
const rangeOptions = [
  { value: 1, label: '近 1 天' },
  { value: 3, label: '近 3 天' },
  { value: 7, label: '近 7 天' },
  { value: 30, label: '近 30 天' },
  { value: 0, label: '全部' }
]

/** 按时间范围过滤后的列表（只展示近 N 天的邮件） */
const visibleMails = computed<MailSummary[]>(() => {
  if (!rangeDays.value) return mails.value
  const cutoff = Date.now() - rangeDays.value * 86400000
  return mails.value.filter((m) => new Date(m.date).getTime() >= cutoff)
})

// ---------- 选择：全选 / 单击选中 / Shift 范围选择 ----------

/** 全选 / 取消全选（仅针对当前时间范围内可见邮件） */
function toggleSelectAll(checked: boolean | string | number): void {
  selectedUids.value = checked ? visibleMails.value.map((m) => m.uid) : []
}

const allChecked = computed(
  () =>
    visibleMails.value.length > 0 && selectedUids.value.length === visibleMails.value.length
)
const someChecked = computed(
  () =>
    selectedUids.value.length > 0 && selectedUids.value.length < visibleMails.value.length
)

/** Shift 范围选择的锚点（上一次点击的邮件下标） */
let lastCheckIndex = -1

/** 点击邮件行：Shift 范围选择；普通点击仅选中该封（全选状态下点击即取消全选），并打开详情 */
function onRowClick(mail: MailSummary, event: MouseEvent): void {
  const list = visibleMails.value
  const index = list.findIndex((m) => m.uid === mail.uid)
  if (event.shiftKey && lastCheckIndex >= 0) {
    // Shift：以上次点击为锚点，范围内全部选中（并集）
    const [start, end] = [Math.min(lastCheckIndex, index), Math.max(lastCheckIndex, index)]
    const range = list.slice(start, end + 1).map((m) => m.uid)
    selectedUids.value = Array.from(new Set([...selectedUids.value, ...range]))
  } else {
    // 全选状态下点击单封 → 取消全选，只选这一封
    selectedUids.value = [mail.uid]
  }
  lastCheckIndex = index
  void openMail(mail)
}

// ---------- 右键菜单 ----------

const contextMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  mail: null as MailSummary | null
})

/** 列表右键：多选时针对所选（已读/未读/删除）；单封时追加分割线 + 回复/全部回复/转发 */
function onListContext(event: MouseEvent, mail: MailSummary): void {
  event.preventDefault()
  contextMenu.mail = mail
  // 右键的邮件不在多选范围内时，改为只选中该封
  if (!(selectedUids.value.length > 1 && selectedUids.value.includes(mail.uid))) {
    selectedUids.value = [mail.uid]
  }
  contextMenu.x = event.clientX
  contextMenu.y = event.clientY
  contextMenu.visible = true
  document.addEventListener('click', closeContextMenu, { once: true })
}

function closeContextMenu(): void {
  contextMenu.visible = false
  contactCtx.visible = false
}

/** 右键是否为多选操作（选中多封且右键的邮件在所选范围内） */
const contextMulti = computed(
  () =>
    selectedUids.value.length > 1 &&
    !!contextMenu.mail &&
    selectedUids.value.includes(contextMenu.mail.uid)
)

/** 统一标记已读/未读：IMAP 同步到服务器，POP3 记到 mail.json 本地 */
async function applySeen(uids: number[], seen: boolean): Promise<void> {
  const account = currentAccount.value
  if (!account || uids.length === 0) return
  if (account.type === 'imap') {
    try {
      await window.dot.toolbox.mail.markSeen(account, uids, seen)
    } catch (err) {
      ElMessage.error(`操作失败: ${(err as Error).message}`)
      return
    }
  } else {
    const list = new Set(store.seenIds?.[account.id] || [])
    uids.forEach((uid) => (seen ? list.add(uid) : list.delete(uid)))
    store.seenIds = { ...(store.seenIds || {}), [account.id]: Array.from(list) }
    await saveStore()
  }
  mails.value.forEach((m) => {
    if (uids.includes(m.uid)) m.seen = seen
  })
}

/** 菜单项：标记已读/未读——多选时针对所选邮件，否则针对右键的单封邮件 */
async function ctxMark(seen: boolean): Promise<void> {
  const uids = contextMulti.value
    ? selectedUids.value
    : contextMenu.mail
      ? [contextMenu.mail.uid]
      : []
  if (uids.length === 0) return
  await applySeen(uids, seen)
}

/** 对指定邮件回复 / 全部回复 / 转发（未打开时先取详情），弹出写信窗口 */
async function replyToMail(
  mail: MailSummary,
  mode: 'reply' | 'replyAll' | 'forward'
): Promise<void> {
  await composeFromMail(mode, mail)
}

async function ctxDelete(): Promise<void> {
  const mail = contextMenu.mail
  const uids =
    selectedUids.value.length > 0 && mail && selectedUids.value.includes(mail.uid)
      ? selectedUids.value
      : mail
        ? [mail.uid]
        : []
  if (uids.length === 0) return
  const account = currentAccount.value
  if (!account) return
  try {
    await window.dot.toolbox.mail.remove(account, uids)
    mails.value = mails.value.filter((m) => !uids.includes(m.uid))
    selectedUids.value = selectedUids.value.filter((u) => !uids.includes(u))
    uids.forEach((u) => detailCache.delete(u))
    if (current.value && uids.includes(current.value.uid)) current.value = null
    ElMessage.success(`已删除 ${uids.length} 封邮件`)
  } catch (err) {
    ElMessage.error(`删除失败: ${(err as Error).message}`)
  }
}

// ---------- 邮件详情 ----------

/** 点击邮件行：优先用缓存详情秒开，否则加载并缓存 */
async function openMail(mail: MailSummary): Promise<void> {
  const account = currentAccount.value
  if (!account) return
  contactExpanded.value = false
  const cached = detailCache.get(mail.uid)
  if (cached) {
    current.value = cached
    if (!mail.seen) void applySeen([mail.uid], true)
    return
  }
  currentLoading.value = true
  try {
    current.value = await window.dot.toolbox.mail.fetch(account, mail.uid)
    detailCache.set(mail.uid, current.value)
    if (!mail.seen) {
      void applySeen([mail.uid], true)
    }
  } catch (err) {
    ElMessage.error(`加载邮件失败: ${(err as Error).message}`)
  } finally {
    currentLoading.value = false
  }
}

/** 注入点击拦截后的正文 HTML：点击链接/图片不导航，改由系统浏览器打开 */
function frameHtmlOf(html: string): string {
  if (!html) return ''
  const interceptor =
    '<script>(function(){' +
    "document.addEventListener('click',function(e){" +
    'var t=e.target;while(t&&t.tagName!==\'A\'){t=t.parentElement}' +
    "if(t&&t.getAttribute('href')){e.preventDefault();e.stopPropagation();" +
    "parent.postMessage({type:'mail-open-link',href:t.href},'*')}}" +
    ",true);" +
    "document.addEventListener('auxclick',function(e){if(e.button===1){var t=e.target;while(t&&t.tagName!=='A'){t=t.parentElement}if(t&&t.getAttribute('href')){e.preventDefault();e.stopPropagation();parent.postMessage({type:'mail-open-link',href:t.href},'*')}}},true);" +
    '})();<\/script>'
  return interceptor + html
}

/** 收件详情正文 */
const frameHtml = computed<string>(() => frameHtmlOf(current.value?.html || ''))

/** 接收 iframe 内点击消息，用系统默认浏览器打开链接 */
function onFrameMessage(event: MessageEvent): void {
  const data = event.data as { type?: string; href?: string } | null
  if (data?.type === 'mail-open-link' && data.href && /^https?:\/\//i.test(data.href)) {
    void window.dot.toolbox.openExternal(data.href)
  }
}

/** 详情右上角三角下拉指令 */
function onDetailCommand(cmd: string | number | object): void {
  const mail = mails.value.find((m) => m.uid === current.value?.uid)
  if (!current.value || !mail) return
  const action = String(cmd)
  if (action === 'delete') {
    void ctxDeleteForMail(mail)
    return
  }
  composeFromMail(action as 'reply' | 'replyAll' | 'forward', mail)
}

/** 对指定邮件删除（详情面板/右键单个邮件共用） */
async function ctxDeleteForMail(mail: MailSummary): Promise<void> {
  const account = currentAccount.value
  if (!account) return
  try {
    await window.dot.toolbox.mail.remove(account, [mail.uid])
    mails.value = mails.value.filter((m) => m.uid !== mail.uid)
    selectedUids.value = selectedUids.value.filter((u) => u !== mail.uid)
    detailCache.delete(mail.uid)
    current.value = null
    ElMessage.success('已删除')
  } catch (err) {
    ElMessage.error(`删除失败: ${(err as Error).message}`)
  }
}

// ---------- 联系人区域 ----------

const contactExpanded = ref(false)

// ==================== 写邮件（独立窗口） ====================

/** 打开写信独立窗口（payload：draftId / to / cc / subject / body / attachments） */
async function openCompose(payload: Record<string, unknown> = {}): Promise<void> {
  await window.dot.toolbox.mail.openCompose({ accountId: store.currentId, ...payload })
}

/** 回复 / 全部回复 / 转发：先取详情再弹写信窗口并预填引用 */
async function composeFromMail(
  mode: 'reply' | 'replyAll' | 'forward',
  mail: MailSummary
): Promise<void> {
  const account = currentAccount.value
  if (!account || !isSupported(account)) return
  try {
    const cached = detailCache.get(mail.uid)
    const detail = cached || (await window.dot.toolbox.mail.fetch(account, mail.uid))
    if (!cached) detailCache.set(mail.uid, detail)
    const subjectPrefix = mode === 'forward' ? 'Fw:' : 'Re:'
    const subject = detail.subject.startsWith(subjectPrefix)
      ? detail.subject
      : `${subjectPrefix} ${detail.subject}`
    let to = ''
    let cc = ''
    if (mode !== 'forward') {
      to = detail.fromAddr
      if (mode === 'replyAll') {
        const self = account.email.toLowerCase()
        const others = [detail.to, detail.cc]
          .join(',')
          .split(/[;；,，]/)
          .map((s) => s.trim())
          .filter((s) => s && !s.toLowerCase().includes(self) && !detail.fromAddr.includes(s))
        cc = Array.from(new Set(others)).join('; ')
      }
    }
    await openCompose({ to, cc, subject, body: buildQuote(detail, mode === 'forward') })
  } catch (err) {
    ElMessage.error(`获取邮件详情失败: ${(err as Error).message}`)
  }
}

// ---------- tiptap 富文本编辑器 ----------

/** 构造引用原文（回复 / 转发） */
function buildQuote(mail: MailDetail, forward: boolean): string {
  const label = forward ? '---------- 转发邮件 ----------' : '---------- 原始邮件 ----------'
  const content =
    mail.html ||
    `<pre style="font-family:inherit;white-space:pre-wrap">${mail.text || ''}</pre>`
  return [
    '<br><br>',
    `<div style="border-left:3px solid #ddd;padding-left:12px;color:#666;font-size:13px">`,
    `<div style="margin-bottom:6px"><b>${label}</b></div>`,
    `<div>发件人：${mail.fromAddr}</div>`,
    `<div>时间：${formatFullDate(mail.date)}</div>`,
    `<div>主题：${mail.subject}</div>`,
    `<div style="margin-top:8px">${content}</div>`,
    `</div>`
  ].join('')
}

/** 当前账户的草稿（新到旧） */
const accountDrafts = computed(() =>
  store.drafts
    .filter((d) => d.accountId === store.currentId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
)

/** 编辑草稿：弹写信窗口预填 */
async function editDraft(draft: MailDraft): Promise<void> {
  await openCompose({
    draftId: draft.id,
    to: draft.to,
    cc: draft.cc,
    subject: draft.subject,
    body: draft.body
  })
}

/** 删除草稿 */
async function deleteDraft(draft: MailDraft): Promise<void> {
  store.drafts = store.drafts.filter((d) => d.id !== draft.id)
  await saveStore()
  ElMessage.success('草稿已删除')
}

/** 发送草稿：弹写信窗口预填（窗口内点发送） */
async function sendDraft(draft: MailDraft): Promise<void> {
  await editDraft(draft)
}

// ==================== 发件箱（本地已发送存档） ====================

/** 当前账户的已发送邮件（新到旧） */
const accountSents = computed(() =>
  (store.sents || [])
    .filter((s) => s.accountId === store.currentId)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
)

/** 当前查看的已发送邮件 */
const sentDetail = ref<MailSent | null>(null)

/** 已发送正文 iframe HTML（与收件详情一致的沙箱处理） */
const sentFrameHtml = computed(() => {
  if (!sentDetail.value) return ''
  return frameHtmlOf(sentDetail.value.body)
})

function openSent(sent: MailSent): void {
  sentDetail.value = sent
}

function deleteSent(sent: MailSent): void {
  store.sents = (store.sents || []).filter((s) => s.id !== sent.id)
  if (sentDetail.value?.id === sent.id) sentDetail.value = null
  void saveStore()
  ElMessage.success('已发送记录已删除')
}

// ==================== 联系人 ====================

const contactsForm = reactive({ name: '', email: '' })

/** 当前联系人列表 */
const contacts = computed<MailContact[]>(() => store.contacts || [])

/** 新增联系人（邮箱重复时提示） */
async function addContact(): Promise<void> {
  const name = contactsForm.name.trim()
  const email = contactsForm.email.trim()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    ElMessage.warning('请填写正确的邮箱地址')
    return
  }
  if (contacts.value.some((c) => c.email.toLowerCase() === email.toLowerCase())) {
    ElMessage.warning('该邮箱已存在')
    return
  }
  store.contacts = [
    ...contacts.value,
    { id: `ct_${Date.now()}`, name: name || email.split('@')[0], email }
  ]
  await saveStore()
  contactsForm.name = ''
  contactsForm.email = ''
  ElMessage.success('联系人已保存')
}

/** 删除联系人 */
async function deleteContact(contact: MailContact): Promise<void> {
  store.contacts = contacts.value.filter((c) => c.id !== contact.id)
  await saveStore()
  ElMessage.success('联系人已删除')
}

// ---------- 详情联系人右键菜单（添加联系人 / 发送） ----------

const contactCtx = reactive({ visible: false, x: 0, y: 0, email: '', name: '' })

/** 解析 "名字 <a@b.c>" 或纯邮箱文本 */
function parseAddress(text: string): { email: string; name: string } {
  const m = /^(.*?)<([^<>]+)>/.exec(text.trim())
  if (m) return { name: m[1].trim(), email: m[2].trim() }
  return { name: '', email: text.trim() }
}

/** 详情联系人区域右键 */
function onContactContext(e: MouseEvent, text: string): void {
  const parsed = parseAddress(text)
  if (!parsed.email) return
  e.preventDefault()
  contactCtx.email = parsed.email
  contactCtx.name = parsed.name
  contactCtx.visible = true
  contactCtx.x = e.clientX
  contactCtx.y = e.clientY
}

/** 右键菜单：添加联系人 */
async function ctxAddContact(): Promise<void> {
  contactCtx.visible = false
  const email = contactCtx.email
  if (contacts.value.some((c) => c.email.toLowerCase() === email.toLowerCase())) {
    ElMessage.info('该邮箱已在联系人中')
    return
  }
  store.contacts = [
    ...contacts.value,
    { id: `ct_${Date.now()}`, name: contactCtx.name || email.split('@')[0], email }
  ]
  await saveStore()
  ElMessage.success(`已添加联系人 ${contactCtx.name || email}`)
}

/** 右键菜单：给该地址发邮件 */
function ctxSendTo(): Promise<void> {
  contactCtx.visible = false
  return openCompose({ to: contactCtx.email })
}

// ==================== AI 助手（弹框） ====================

const ai = reactive({
  visible: false,
  input: '',
  busy: false,
  result: ''
})

const aiScroll = ref<HTMLElement | null>(null)

/** 组装 AI 上下文：联系人 + 收件列表摘要 + 当前邮件全文 */
function buildAiContext(): string {
  const lines: string[] = []
  lines.push(
    `联系人列表：${
      contacts.value.length
        ? contacts.value.map((c) => `${c.name}(${c.email})`).join('、')
        : '（空）'
    }`
  )
  lines.push(
    `当前账户：${currentAccount.value?.email || '无'}；收件箱共 ${mails.value.length} 封（当前时间范围内 ${visibleMails.value.length} 封）`
  )
  lines.push(
    `收件箱摘要（发件人 | 主题 | 时间）：${
      visibleMails.value
        .slice(0, 50)
        .map((m) => `${m.fromAddr || m.fromName} | ${m.subject} | ${formatListDate(m.date)}`)
        .join('；') || '（空）'
    }`
  )
  if (current.value) {
    lines.push(
      `当前打开邮件：\n主题：${current.value.subject}\n发件人：${current.value.fromAddr}\n时间：${formatFullDate(current.value.date)}\n内容：${(current.value.text || current.value.html || '').slice(0, 4000)}`
    )
  }
  return lines.join('\n')
}

/** AI 助手执行指令：写信 → 弹写信窗口；其他 → 展示回答 */
async function aiRun(prefill?: string): Promise<void> {
  const question = (prefill ?? ai.input).trim()
  if (!question || ai.busy) return
  if (prefill) ai.input = prefill
  ai.busy = true
  ai.result = ''
  try {
    const res = await sendLlm([
      {
        role: 'system',
        content: [
          '你是邮箱 AI 助手，可以帮助分析邮件、统计邮件，或根据指令起草邮件。',
          '仅当用户明确要求写信/发送邮件时，你需要输出一个 JSON（不要输出其他文字，不要用代码块包裹）：',
          '{"action":"compose","to":"","cc":"","subject":"","body":""}',
          '- to/cc：收件人邮箱，多个用分号分隔。用户给的是联系人名称时，从下方联系人列表中匹配出邮箱；用户直接给邮箱则原样使用；找不到时 to 填用户原文中的称呼。',
          '- subject：合适的邮件主题；body：完整的 HTML 邮件正文（<p> 段落，得体格式）。',
          '其他情况（分析、统计、问答）输出 JSON：{"action":"answer","text":"回答内容"}。',
          '统计邮件条数时基于提供的收件箱摘要如实回答。',
          '',
          '以下是邮箱当前信息：',
          buildAiContext()
        ].join('\n')
      },
      { role: 'user', content: question }
    ])
    const text = res.content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
    try {
      const parsed = JSON.parse(text) as {
        action?: string
        to?: string
        cc?: string
        subject?: string
        body?: string
        text?: string
      }
      if (parsed.action === 'compose') {
        await openCompose({
          to: parsed.to || '',
          cc: parsed.cc || '',
          subject: parsed.subject || '',
          body: parsed.body || ''
        })
        ai.result = `已为你起草邮件：收件人 ${parsed.to || '-'}，主题「${parsed.subject || '-'}」，请在写信窗口中确认后发送。`
      } else {
        ai.result = parsed.text || '（无回答）'
      }
    } catch {
      // 模型未按 JSON 输出：直接展示原文
      ai.result = text || '（无回答）'
    }
  } catch (err) {
    ai.result = `出错了：${(err as Error).message}`
  } finally {
    ai.busy = false
    void nextTick(() => aiScroll.value?.scrollTo({ top: 0 }))
  }
}

/** 快捷：分析当前打开的邮件 */
function aiAnalyzeCurrent(): void {
  if (!current.value) {
    ElMessage.info('请先在收件箱中打开一封邮件')
    return
  }
  ai.visible = true
  void aiRun('请分析当前打开的这封邮件：概括主要内容、指出关键信息和需要注意的事项。')
}

/** 快捷：统计邮件 */
function aiStatMails(): void {
  ai.visible = true
  void aiRun('请统计当前收件箱的邮件情况（总数、按发件人分布等），简要汇报。')
}

// ==================== 附件下载 / 查看 ====================

const viewer = reactive({ visible: false, src: '', title: '' })

/** 下载附件：弹保存对话框 */
async function downloadAttachment(filename: string): Promise<void> {
  if (!current.value || !currentAccount.value) return
  const savePath = await window.dot.toolbox.file.selectSavePath(filename)
  if (!savePath) return
  try {
    const { contentBase64 } = await window.dot.toolbox.mail.attachment(
      currentAccount.value,
      current.value.uid,
      filename
    )
    await window.dot.toolbox.file.save(savePath, contentBase64)
    ElMessage.success(`附件已保存到 ${savePath}`)
  } catch (err) {
    ElMessage.error(`附件下载失败: ${(err as Error).message}`)
  }
}

/** 查看附件：图片内嵌预览，其他类型用系统默认程序打开 */
async function viewAttachment(filename: string): Promise<void> {
  if (!current.value || !currentAccount.value) return
  try {
    const { contentBase64, contentType } = await window.dot.toolbox.mail.attachment(
      currentAccount.value,
      current.value.uid,
      filename
    )
    if (contentType.startsWith('image/')) {
      viewer.src = `data:${contentType};base64,${contentBase64}`
      viewer.title = filename
      viewer.visible = true
      return
    }
    const path = await window.dot.toolbox.mail.saveTemp(filename, contentBase64)
    const res = await window.dot.toolbox.mail.openPath(path)
    if (!res.success) ElMessage.error(res.message)
  } catch (err) {
    ElMessage.error(`附件查看失败: ${(err as Error).message}`)
  }
}

// ==================== 格式化工具 ====================

/** 列表时间：当年显示 MM-DD HH:mm，跨年显示 yyyy-MM-dd */
function formatListDate(dateStr: string): string {
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const pad = (n: number): string => `${n}`.padStart(2, '0')
  if (d.getFullYear() === now.getFullYear()) {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 详情完整时间 */
function formatFullDate(dateStr: string): string {
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => `${n}`.padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 文件大小格式化 */
function formatSize(size: number): string {
  if (!size) return '-'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

// ==================== 生命周期 ====================

onMounted(async () => {
  await loadStore()
  if (currentAccount.value && isSupported(currentAccount.value)) void refreshInbox()
})

function onEsc(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeContextMenu()
}

/** 主窗口重新获得焦点（如写信窗口保存草稿/发送后关闭）时，重读 mail.json 实时刷新草稿箱/发件箱/联系人 */
async function onWindowFocus(): Promise<void> {
  await loadStore()
}

onMounted(() => {
  document.addEventListener('keydown', onEsc)
  window.addEventListener('message', onFrameMessage)
  window.addEventListener('focus', onWindowFocus)
})
onUnmounted(() => {
  document.removeEventListener('keydown', onEsc)
  window.removeEventListener('message', onFrameMessage)
  window.removeEventListener('focus', onWindowFocus)
})

/** 返回百宝箱 */
function goBack(): void {
  router.push({ name: 'Toolbox' })
}

/** 切换顶部页签 */
function switchTab(t: Tab): void {
  tab.value = t
  if (t === 'sent') sentDetail.value = null
  if (t === 'drafts') void nextTick()
}
</script>

<template>
  <div class="mail-page" @click="contextMenu.visible = false; contactCtx.visible = false">
    <!-- 顶部：返回 / 分割线 / 页签 / 账户 -->
    <header class="mail-topbar">
      <div class="topbar-left">
        <button class="back-btn" @click="goBack">
          <el-icon :size="14"><ArrowLeft /></el-icon>
          <span>返回</span>
        </button>
        <span class="divider" />
        <nav class="tabs">
          <div class="tab-item" :class="{ active: tab === 'inbox' }" @click="switchTab('inbox')">
            收件箱
          </div>
          <div class="tab-item" @click="openCompose()">写邮件</div>
          <div class="tab-item" :class="{ active: tab === 'sent' }" @click="switchTab('sent')">
            发件箱
          </div>
          <div class="tab-item" :class="{ active: tab === 'drafts' }" @click="switchTab('drafts')">
            草稿箱
          </div>
          <div
            class="tab-item"
            :class="{ active: tab === 'contacts' }"
            @click="switchTab('contacts')"
          >
            联系人
          </div>
          <div class="tab-item" @click="ai.visible = true">AI助手</div>
        </nav>
      </div>

      <el-dropdown class="account-dropdown" trigger="click" @command="onAccountCommand">
        <div class="account-trigger">
          <el-icon :size="16"><Message /></el-icon>
          <span class="account-email">{{
            currentAccount ? currentAccount.email : '未连接账户'
          }}</span>
          <el-icon :size="12"><CaretBottom /></el-icon>
        </div>
        <template #dropdown>
          <el-dropdown-menu class="account-menu">
            <el-dropdown-item
              v-for="account in store.accounts"
              :key="account.id"
              :command="`switch:${account.id}`"
              :class="{ 'is-current': account.id === store.currentId }"
            >
              <div class="account-row">
                <span class="account-row-email">
                  {{ account.email }}
                  <el-tag size="small" type="info" effect="plain">
                    {{ ACCOUNT_PRESETS[account.type].label }}
                  </el-tag>
                </span>
                <el-popconfirm
                  title="确定删除该账户？"
                  confirm-button-text="删除"
                  cancel-button-text="取消"
                  @confirm="deleteAccount(account)"
                >
                  <template #reference>
                    <span class="account-delete" @click.stop>删除</span>
                  </template>
                </el-popconfirm>
              </div>
            </el-dropdown-item>
            <el-dropdown-item divided command="add">
              <div class="account-add-row">
                <el-icon><Plus /></el-icon>
                新增账户
              </div>
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </header>

    <!-- ==================== 收件箱 ==================== -->
    <main v-if="tab === 'inbox'" class="mail-main">
      <!-- 左侧邮件列表 -->
      <section class="mail-list">
        <div class="list-toolbar">
          <el-checkbox
            :model-value="allChecked"
            :indeterminate="someChecked"
            @change="toggleSelectAll"
          />
          <el-button
            size="small"
            type="primary"
            plain
            :icon="Refresh"
            :loading="loading"
            @click="refreshInbox"
          >
            收取
          </el-button>
          <el-select v-model="rangeDays" size="small" class="range-select">
            <el-option v-for="d in rangeOptions" :key="d.value" :value="d.value" :label="d.label" />
          </el-select>
          <span class="list-count">
            共 {{ visibleMails.length }} 封<template v-if="selectedUids.length">
              ，已选 {{ selectedUids.length }} 封</template
            >
          </span>
        </div>
        <div v-if="loading" class="list-loading" v-loading="loading" element-loading-text="正在收取邮件..." />
        <div v-else-if="mails.length === 0" class="list-empty">
          <template v-if="!currentAccount">右上角添加账户后开始收邮件</template>
          <template v-else>暂无邮件，点击上方"收取"</template>
        </div>
        <ul v-else class="mail-items">
          <li
            v-for="mail in visibleMails"
            :key="mail.uid"
            class="mail-item"
            :class="{
              selected: current?.uid === mail.uid,
              checked: selectedUids.includes(mail.uid)
            }"
            @click="onRowClick(mail, $event)"
            @contextmenu="onListContext($event, mail)"
          >
            <div class="item-body">
              <div class="item-line1">
                <span class="unread-dot" v-if="!mail.seen" />
                <span class="item-from" :class="{ bold: !mail.seen }">
                  {{ mail.fromName || mail.fromAddr || '(未知发件人)' }}
                </span>
                <span class="item-date">{{ formatListDate(mail.date) }}</span>
              </div>
              <div class="item-line2">
                <span class="item-subject" :class="{ bold: !mail.seen }">{{ mail.subject }}</span>
                <span v-if="mail.hasAttachment" class="attach-flag" title="含附件">📎</span>
              </div>
            </div>
          </li>
        </ul>
      </section>

      <!-- 右侧邮件详情 -->
      <section v-loading="currentLoading" class="mail-detail">
        <div v-if="!current" class="detail-empty" v-loading="currentLoading">
          选择左侧邮件查看内容
        </div>
        <template v-else>
          <!-- 顶部：主题 + 功能下拉 -->
          <div class="detail-header">
            <h2 class="detail-subject">{{ current.subject }}</h2>
            <el-dropdown trigger="click" @command="onDetailCommand">
              <span class="detail-more" title="更多操作">
                <svg viewBox="0 0 12 8" width="12" height="8">
                  <path d="M1 1l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" />
                </svg>
              </span>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="reply">回复</el-dropdown-item>
                  <el-dropdown-item command="replyAll">全部回复</el-dropdown-item>
                  <el-dropdown-item command="forward">转发</el-dropdown-item>
                  <el-dropdown-item command="delete" divided>删除</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>

          <!-- 联系人区域：默认只展示发件人，点击展开；右键邮箱/名称可添加联系人或发送 -->
          <div class="contact-area" @click="contactExpanded = !contactExpanded">
            <div class="contact-main">
              <span class="contact-label">发件人</span>
              <span
                class="contact-value"
                @contextmenu.stop="onContactContext($event, current.fromName ? `${current.fromName} <${current.fromAddr}>` : current.fromAddr)"
                >{{
                  current.fromName ? `${current.fromName} <${current.fromAddr}>` : current.fromAddr
                }}</span
              >
              <span class="contact-toggle">{{ contactExpanded ? '收起 ▲' : '展开 ▼' }}</span>
            </div>
            <template v-if="contactExpanded">
              <div class="contact-sub">
                <span class="contact-label">收件人</span>
                <span class="contact-value" @contextmenu.stop="onContactContext($event, current.to)">
                  {{ current.to || '-' }}
                </span>
              </div>
              <div class="contact-sub">
                <span class="contact-label">抄送</span>
                <span class="contact-value" @contextmenu.stop="onContactContext($event, current.cc)">
                  {{ current.cc || '-' }}
                </span>
              </div>
              <div class="contact-sub">
                <span class="contact-label">时间</span>
                <span class="contact-value">{{ formatFullDate(current.date) }}</span>
              </div>
              <div class="contact-sub">
                <span class="contact-label">大小</span>
                <span class="contact-value">{{ formatSize(current.size) }}</span>
              </div>
            </template>
          </div>

          <!-- 附件区 -->
          <div v-if="current.attachments.length" class="attachment-area">
            <div v-for="att in current.attachments" :key="att.filename" class="attachment-item">
              <span class="attachment-name" :title="att.filename">{{ att.filename }}</span>
              <span class="attachment-size">{{ formatSize(att.size) }}</span>
              <span class="attachment-action" @click="viewAttachment(att.filename)">查看</span>
              <span class="attachment-action primary" @click="downloadAttachment(att.filename)">
                下载
              </span>
            </div>
          </div>

          <!-- 正文：HTML 用沙箱 iframe 隔离 -->
          <div class="detail-body">
            <!-- iframe 沙箱渲染（allow-scripts 用于注入点击拦截，防止点击图片/链接导致 iframe 跳转白屏） -->
            <iframe
              v-if="current.html"
              class="html-frame"
              sandbox="allow-scripts"
              :srcdoc="frameHtml"
            />
            <pre v-else class="text-body">{{ current.text || '(空邮件)' }}</pre>
          </div>
        </template>
      </section>

      <!-- 右键菜单：多选针对所选，单封带回复操作 -->
      <div
        v-if="contextMenu.visible"
        class="context-menu"
        :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
        @click.stop
      >
        <div class="ctx-item" @click="ctxMark(true); closeContextMenu()">
          {{ contextMulti ? `标记已读（${selectedUids.length} 封）` : '标记已读' }}
        </div>
        <div class="ctx-item" @click="ctxMark(false); closeContextMenu()">
          {{ contextMulti ? `标记未读（${selectedUids.length} 封）` : '标记未读' }}
        </div>
        <div class="ctx-item danger" @click="ctxDelete(); closeContextMenu()">
          删除{{ contextMulti ? `（${selectedUids.length} 封）` : '' }}
        </div>
        <template v-if="!contextMulti && contextMenu.mail">
          <div class="ctx-divider" />
          <div class="ctx-item" @click="replyToMail(contextMenu.mail!, 'reply'); closeContextMenu()">
            回复
          </div>
          <div
            class="ctx-item"
            @click="replyToMail(contextMenu.mail!, 'replyAll'); closeContextMenu()"
          >
            全部回复
          </div>
          <div class="ctx-item" @click="replyToMail(contextMenu.mail!, 'forward'); closeContextMenu()">
            转发
          </div>
        </template>
      </div>
    </main>

    <!-- ==================== 发件箱（本地已发送存档） ==================== -->
    <main v-else-if="tab === 'sent'" class="mail-main">
      <section class="mail-list">
        <div class="list-toolbar">
          <span class="list-count">已发送 {{ accountSents.length }} 封（本地存档）</span>
        </div>
        <div v-if="accountSents.length === 0" class="list-empty">暂无已发送邮件</div>
        <ul v-else class="mail-items">
          <li
            v-for="sent in accountSents"
            :key="sent.id"
            class="mail-item"
            :class="{ selected: sentDetail?.id === sent.id }"
            @click="openSent(sent)"
          >
            <div class="item-body">
              <div class="item-line1">
                <span class="item-from">收件人：{{ sent.to || '-' }}</span>
                <span class="item-date">{{ formatListDate(sent.date) }}</span>
              </div>
              <div class="item-line2">
                <span class="item-subject">{{ sent.subject }}</span>
              </div>
            </div>
          </li>
        </ul>
      </section>
      <section class="mail-detail">
        <div v-if="!sentDetail" class="detail-empty">选择左侧已发送邮件查看内容</div>
        <template v-else>
          <div class="detail-header">
            <h2 class="detail-subject">{{ sentDetail.subject }}</h2>
            <el-button size="small" type="danger" plain @click="deleteSent(sentDetail)">
              删除记录
            </el-button>
          </div>
          <div class="contact-area">
            <div class="contact-main">
              <span class="contact-label">收件人</span>
              <span class="contact-value">{{ sentDetail.to || '-' }}</span>
            </div>
            <div class="contact-sub">
              <span class="contact-label">抄送</span>
              <span class="contact-value">{{ sentDetail.cc || '-' }}</span>
            </div>
            <div class="contact-sub">
              <span class="contact-label">时间</span>
              <span class="contact-value">{{ formatFullDate(sentDetail.date) }}</span>
            </div>
          </div>
          <div class="detail-body">
            <iframe v-if="sentDetail.body" class="html-frame" sandbox="allow-scripts" :srcdoc="sentFrameHtml" />
            <pre v-else class="text-body">(空邮件)</pre>
          </div>
        </template>
      </section>
    </main>

    <!-- ==================== 草稿箱 ==================== -->
    <main v-else-if="tab === 'drafts'" class="drafts-main">
      <div v-if="accountDrafts.length === 0" class="list-empty">当前账户暂无草稿</div>
      <ul v-else class="draft-items">
        <li v-for="draft in accountDrafts" :key="draft.id" class="draft-item">
          <div class="draft-info">
            <div class="draft-subject">{{ draft.subject || '(无主题)' }}</div>
            <div class="draft-meta">
              收件人：{{ draft.to || '-' }} · {{ formatFullDate(draft.updatedAt) }}
            </div>
          </div>
          <div class="draft-actions">
            <el-button size="small" type="primary" plain @click="sendDraft(draft)">发送</el-button>
            <el-button size="small" @click="editDraft(draft)">编辑</el-button>
            <el-button size="small" type="danger" plain @click="deleteDraft(draft)">删除</el-button>
          </div>
        </li>
      </ul>
    </main>

    <!-- ==================== 联系人 ==================== -->
    <main v-else-if="tab === 'contacts'" class="contacts-main">
      <div class="contacts-add">
        <el-input v-model="contactsForm.name" placeholder="联系人名称（可空）" class="contact-name-input" />
        <el-input v-model="contactsForm.email" placeholder="邮箱地址" @keyup.enter="addContact" />
        <el-button type="primary" @click="addContact">添加</el-button>
      </div>
      <div v-if="contacts.length === 0" class="list-empty">暂无联系人，可在上方添加或右键邮件中的邮箱地址</div>
      <ul v-else class="contact-items">
        <li v-for="contact in contacts" :key="contact.id" class="contact-item">
          <div class="contact-info">
            <span class="contact-name">{{ contact.name }}</span>
            <span class="contact-email">{{ contact.email }}</span>
          </div>
          <div class="contact-actions">
            <el-button size="small" @click="openCompose({ to: contact.email })">发邮件</el-button>
            <el-button size="small" type="danger" plain @click="deleteContact(contact)">删除</el-button>
          </div>
        </li>
      </ul>
    </main>

    <!-- 图片附件预览 -->
    <el-dialog v-model="viewer.visible" :title="viewer.title" width="720px" append-to-body>
      <img :src="viewer.src" class="viewer-img" :alt="viewer.title" />
    </el-dialog>

    <!-- AI 助手弹框：上指令输入，下结果 -->
    <el-dialog
      v-model="ai.visible"
      title="AI 助手"
      width="640px"
      append-to-body
      :close-on-click-modal="false"
    >
      <div class="ai-dialog-body">
        <div class="ai-input-block">
          <el-input
            v-model="ai.input"
            type="textarea"
            :rows="3"
            placeholder="输入指令，如：分析当前邮件 / 统计邮件 / 给XXX发送邮件，主要内容是明天下午三点来201会议室开会"
          />
          <div class="ai-input-actions">
            <el-button size="small" @click="aiStatMails">统计邮件</el-button>
            <el-button size="small" @click="aiAnalyzeCurrent">分析当前邮件</el-button>
            <el-button type="primary" :loading="ai.busy" @click="aiRun()">执行</el-button>
          </div>
        </div>
        <div ref="aiScroll" class="ai-result">
          <span v-if="!ai.result && !ai.busy" class="ai-result-empty">
            执行结果将显示在这里
          </span>
          <span v-else-if="ai.busy" class="ai-result-empty">正在分析...</span>
          <pre v-else class="ai-result-text">{{ ai.result }}</pre>
        </div>
      </div>
    </el-dialog>

    <!-- 联系人右键菜单：添加联系人 / 发送 -->
    <div
      v-if="contactCtx.visible"
      class="context-menu"
      :style="{ left: `${contactCtx.x}px`, top: `${contactCtx.y}px` }"
      @click.stop
    >
      <div class="ctx-item" @click="ctxAddContact">添加联系人</div>
      <div class="ctx-item" @click="ctxSendTo">发送邮件</div>
    </div>

    <!-- 新增账户 -->
    <el-dialog v-model="addDialogVisible" title="新增邮箱账户" width="520px" append-to-body>
      <div class="account-form">
        <div class="compose-row">
          <span class="compose-label">类型</span>
          <el-radio-group v-model="accountForm.type" @change="applyTypeDefaults">
            <el-radio-button value="imap">IMAP</el-radio-button>
            <el-radio-button value="pop3">POP3</el-radio-button>
            <el-radio-button value="exchange">Exchange</el-radio-button>
          </el-radio-group>
        </div>
        <div class="compose-row">
          <span class="compose-label">邮箱</span>
          <el-input v-model="accountForm.email" placeholder="name@example.com" />
        </div>
        <div class="compose-row">
          <span class="compose-label">密码</span>
          <el-input
            v-model="accountForm.password"
            type="password"
            show-password
            placeholder="登录密码或授权码"
          />
        </div>
        <div class="compose-row">
          <span class="compose-label">收件服务器</span>
          <div class="host-pair">
            <el-input v-model="accountForm.imapHost" placeholder="收件服务器地址" />
            <el-input-number
              v-model="accountForm.imapPort"
              class="port-input"
              :controls="false"
              :min="1"
              :max="65535"
              placeholder="端口"
            />
            <el-checkbox v-model="accountForm.imapSsl">SSL</el-checkbox>
          </div>
        </div>
        <div class="compose-row">
          <span class="compose-label">发件服务器</span>
          <div class="host-pair">
            <el-input v-model="accountForm.smtpHost" placeholder="发件服务器地址" />
            <el-input-number
              v-model="accountForm.smtpPort"
              class="port-input"
              :controls="false"
              :min="1"
              :max="65535"
              placeholder="端口"
            />
            <el-checkbox v-model="accountForm.smtpSsl">SSL</el-checkbox>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button :loading="testing" @click="testAccount">测试连接</el-button>
        <el-button type="primary" @click="saveAccount">保存</el-button>
        <el-button @click="addDialogVisible = false">取消</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.mail-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* ===== 顶栏 ===== */
.mail-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-card);
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: 14px;
}

.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-hover);
  color: var(--color-text);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.back-btn:hover {
  background: var(--color-primary-light);
  transform: translateX(-2px);
}

.divider {
  width: 1px;
  height: 20px;
  background: var(--color-border);
}

.tabs {
  display: flex;
  gap: 4px;
}

.tab-item {
  padding: 6px 16px;
  border-radius: 8px;
  font-size: 14px;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  user-select: none;
}

.tab-item:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

.tab-item.active {
  background: var(--color-primary);
  color: #fff;
}

/* 账户下拉 */
.account-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-hover);
  color: var(--color-text);
  font-size: 13px;
  cursor: pointer;
  max-width: 320px;
  outline: none;
}

.account-email {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-menu {
  min-width: 260px;
}

.account-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}

.account-row-email {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
}

.account-delete {
  color: var(--color-danger);
  font-size: 12px;
  cursor: pointer;
}

.account-add-row {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--color-primary);
}

/* ===== 主区域 ===== */
.mail-main {
  flex: 1;
  min-height: 0;
  display: flex;
  position: relative;
}

/* 左侧列表 */
.mail-list {
  width: 380px;
  min-width: 300px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--color-border);
  background: var(--color-card);
}

.list-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--color-border);
}

.list-count {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin-left: auto;
}

.list-loading {
  min-height: 120px;
}

.list-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  font-size: 13px;
  padding: 40px 20px;
  text-align: center;
}

.mail-items {
  flex: 1;
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;
}

.mail-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  cursor: pointer;
  border-bottom: 1px solid var(--color-border);
  transition: background 0.15s ease;
}

.mail-item:hover {
  background: var(--color-hover);
}

.mail-item.checked {
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
}

.mail-item.selected {
  background: color-mix(in srgb, var(--color-primary) 14%, transparent);
}

.item-check {
  flex-shrink: 0;
}

.item-body {
  flex: 1;
  min-width: 0;
}

.item-line1,
.item-line2 {
  display: flex;
  align-items: center;
  gap: 6px;
}

.item-line2 {
  margin-top: 3px;
}

.unread-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-primary);
  flex-shrink: 0;
}

.item-from {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--color-text);
}

.item-from.bold,
.item-subject.bold {
  font-weight: 700;
}

.item-date {
  flex-shrink: 0;
  font-size: 11.5px;
  color: var(--color-text-secondary);
}

.item-subject {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--color-text-secondary);
}

.attach-flag {
  font-size: 11px;
  flex-shrink: 0;
}

/* 时间范围选择 */
.range-select {
  width: 104px;
}

/* 右侧详情 */
.mail-detail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
}

.detail-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.detail-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 20px 10px;
}

.detail-subject {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 三角形功能图标 */
.detail-more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: var(--color-text-secondary);
  cursor: pointer;
  background: var(--color-hover);
  transition: all 0.2s ease;
}

.detail-more:hover {
  color: var(--color-primary);
  background: var(--color-primary-light);
}

/* 联系人区域 */
.contact-area {
  margin: 0 20px;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--color-card);
  border: 1px solid var(--color-border);
  cursor: pointer;
  user-select: none;
}

.contact-main,
.contact-sub {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
}

.contact-sub {
  margin-top: 6px;
}

.contact-label {
  flex-shrink: 0;
  width: 52px;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.contact-value {
  flex: 1;
  min-width: 0;
  word-break: break-all;
  color: var(--color-text);
}

.contact-toggle {
  flex-shrink: 0;
  font-size: 11.5px;
  color: var(--color-primary);
}

/* 附件区 */
.attachment-area {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 20px 0;
}

.attachment-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-card);
  font-size: 12.5px;
  max-width: 100%;
}

.attachment-name {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
}

.attachment-size {
  color: var(--color-text-secondary);
  font-size: 11.5px;
}

.attachment-action {
  color: var(--color-primary);
  cursor: pointer;
  user-select: none;
}

.attachment-action:hover {
  text-decoration: underline;
}

/* 正文 */
.detail-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin: 12px 20px 20px;
  border-radius: 10px;
  background: var(--color-card);
  border: 1px solid var(--color-border);
  overflow: hidden;
}

.html-frame {
  flex: 1;
  width: 100%;
  border: none;
  background: #fff;
}

.text-body {
  flex: 1;
  margin: 0;
  padding: 16px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 13.5px;
  line-height: 1.8;
  color: var(--color-text);
}

/* 右键菜单 */
.context-menu {
  position: fixed;
  z-index: 3000;
  min-width: 140px;
  padding: 6px;
  border-radius: 10px;
  background: var(--color-card);
  border: 1px solid var(--color-border);
  box-shadow: var(--shadow-card);
}

.ctx-item {
  padding: 8px 14px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--color-text);
  cursor: pointer;
  user-select: none;
}

.ctx-item:hover {
  background: var(--color-hover);
  color: var(--color-primary);
}

.ctx-item.danger:hover {
  background: color-mix(in srgb, var(--color-danger) 10%, transparent);
  color: var(--color-danger);
}

.ctx-divider {
  height: 1px;
  margin: 4px 8px;
  background: var(--color-border);
}

/* ===== 写邮件相关通用样式（新增账户弹窗等复用） ===== */
.compose-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.compose-row > .el-input,
.compose-row > .host-pair {
  flex: 1;
}

.compose-label {
  flex-shrink: 0;
  width: 56px;
  text-align: right;
  font-size: 13px;
  color: var(--color-text-secondary);
}

.compose-actions {
  display: flex;
  gap: 10px;
}

.host-pair {
  display: flex;
  gap: 8px;
  align-items: center;
}

/* ===== 联系人 ===== */
.contacts-main {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.contacts-add {
  display: flex;
  gap: 10px;
  align-items: center;
}

.contact-name-input {
  width: 220px;
  flex-shrink: 0;
}

.contact-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.contact-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
}

.contact-info {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.contact-name {
  font-size: 13px;
  font-weight: 600;
}

.contact-email {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.contact-actions {
  flex-shrink: 0;
  display: flex;
  gap: 8px;
}

/* ===== AI 助手弹框 ===== */
.ai-dialog-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ai-input-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

.ai-result {
  min-height: 180px;
  max-height: 340px;
  overflow-y: auto;
  border: 1px solid var(--color-border, #dcdfe6);
  border-radius: 6px;
  padding: 12px;
  background: var(--color-fill-1, #fafafa);
}

.ai-result-empty {
  color: var(--color-text-secondary, #909399);
  font-size: 13px;
}

.ai-result-text {
  margin: 0;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 端口输入框：无加减按钮，固定宽度 */
.port-input {
  width: 110px;
}

.port-input :deep(.el-input__inner) {
  text-align: left;
}

.form-tip.warning {
  padding: 8px 14px;
  margin-left: 68px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-warning) 12%, transparent);
  color: var(--color-warning);
  font-size: 12.5px;
}

/* ===== 草稿箱 ===== */
.drafts-main {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 24px;
}

.draft-items {
  margin: 0;
  padding: 0;
  list-style: none;
}

.draft-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 18px;
  border-radius: 12px;
  background: var(--color-card);
  border: 1px solid var(--color-border);
  margin-bottom: 10px;
}

.draft-subject {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}

.draft-meta {
  margin-top: 4px;
  font-size: 12px;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.draft-actions {
  flex-shrink: 0;
  display: flex;
  gap: 6px;
}

.viewer-img {
  width: 100%;
  max-height: 70vh;
  object-fit: contain;
}
</style>
