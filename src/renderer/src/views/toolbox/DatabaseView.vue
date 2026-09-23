<script setup lang="ts">
/**
 * 数据库管理页面（独立最大化窗口）
 *
 * 支持 MySQL / OceanBase(MySQL 租户) / PostgreSQL / Oracle / OceanBase(Oracle 租户)
 * - 连接配置本地持久化（dot-db.json）
 * - 左侧：选中连接后的数据库对象树（表 / 视图 / 序列 / 存储过程）
 * - 右侧三段：功能区头部 → SQL 窗口 / 表结构 → 可拖拽的查询结果区
 * - 结果区：每次执行生成一组 tab（新执行清掉旧 tab），数据/信息子页，
 *   导出 / 数据分析 / 分页条数，单元格双击编辑 + 页脚提交/撤销/增删行
 */
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Connection,
  Plus,
  Refresh,
  VideoPlay,
  VideoPause,
  Grid,
  Edit,
  Delete,
  MagicStick,
  DataLine,
  Download,
  TrendCharts,
  Check,
  CloseBold,
  Minus,
  CaretBottom,
  Close,
  EditPen
} from '@element-plus/icons-vue'
import dbSvg from '../../assets/db.svg'
import lianjieSvg from '../../assets/lianjie.svg'
import sqlAddSvg from '../../assets/sql_add.svg'
import sqlExeSvg from '../../assets/sql_exe.svg'
import kuaijieSvg from '../../assets/kuaijie.svg'
import saveWhiteSvg from '../../assets/save_white.svg'
import aiChatSvg from '../../assets/ai_chat.svg'
import { sendLlm } from '../../utils/aiRequest'

const dbApi = window.dot.toolbox.db
const localFiles = window.dot.localFiles

// ==================== 类型 ====================

type DbKind = 'mysql' | 'oceanbase-mysql' | 'pgsql' | 'oracle' | 'oceanbase-oracle'

interface SavedConn {
  id: string
  name: string
  kind: DbKind
  host: string
  port: number
  user: string
  password: string
  database?: string
  serviceName?: string
  sid?: string
  ssl?: boolean
}

interface ActiveConn {
  connId: string
  kind: DbKind
  config: SavedConn
  currentDatabase?: string
  currentSchema?: string
}

interface CatalogItem {
  name: string
  type?: string
}

interface ColumnInfo {
  name: string
  dataType: string
  /** 长度/精度（来自数据库字典），无则为空 */
  length?: string
  nullable: boolean
  pk: boolean
  comment?: string
}

/** 索引/约束元信息（表结构 tab 的索引/外键/唯一键展示） */
interface IndexInfo {
  name: string
  kind: 'INDEX' | 'UNIQUE' | 'FOREIGN'
  /** 逗号分隔的字段列表（按列序） */
  columns: string
  refTable?: string
  refColumns?: string
}

type GroupKind = 'tables' | 'views' | 'sequences' | 'procedures'

interface TreeNode {
  id: string
  label: string
  name: string
  nodeType: 'group' | 'table' | 'view' | 'sequence' | 'procedure'
  group?: GroupKind
  database?: string
  schema?: string
  objType?: string
  leaf?: boolean
  children?: TreeNode[]
}

interface TableCtx {
  database?: string
  schema?: string
  table: string
}

interface ResultTab {
  id: string
  title: string
  sql: string
  columns: string[]
  rows: Record<string, unknown>[]
  affectedRows: number
  insertId?: string
  truncated: boolean
  elapsed: number
  error?: string
  /** SELECT 结果是否为服务端分页（rows 仅含当前页数据） */
  serverPaged: boolean
  /** 服务端分页时的总行数 */
  total: number
  view: 'data' | 'info'
  page: number
  pageSize: number
  /** 可编辑目标表（双击表打开或解析出 SELECT * FROM 单表） */
  tableCtx?: TableCtx
  columnsInfo: ColumnInfo[]
  /** 表结构加载失败的具体原因（成功或未加载时为空） */
  ctxError?: string
  /** 是否已启用编辑（点「启用编辑」后为 true，新增/删除/修改才可用） */
  editEnabled: boolean
  /** 解释计划文本（有值时数据视图渲染为格式化计划） */
  planText?: string
  /** 行唯一 id -> 列 -> 新值 */
  edited: Record<string, Record<string, string>>
  /** 待删除的行 id */
  deleted: string[]
  /** 新增行的行 id */
  newRowRid: string | null
  selectedRid: string | null
  selectedCol: string | null
  editingCell: { rid: string; col: string } | null
  editingValue: string
  showAnalysis: boolean
}

// ==================== 连接配置持久化 ====================

let configPath = ''

const KIND_OPTIONS: Array<{ value: DbKind; label: string; defaultPort: number; dbLabel: string }> =
  [
    { value: 'mysql', label: 'MySQL', defaultPort: 3306, dbLabel: '数据库（可选）' },
    {
      value: 'oceanbase-mysql',
      label: 'OceanBase (MySQL)',
      defaultPort: 2883,
      dbLabel: '数据库（可选）'
    },
    {
      value: 'pgsql',
      label: 'PostgreSQL',
      defaultPort: 5432,
      dbLabel: '数据库（可选，默认 postgres）'
    },
    { value: 'oracle', label: 'Oracle', defaultPort: 1521, dbLabel: '服务名（必填）' },
    {
      value: 'oceanbase-oracle',
      label: 'OceanBase (Oracle)',
      defaultPort: 2883,
      dbLabel: '服务名（必填）'
    }
  ]

const isOracleKind = (kind: DbKind): boolean => kind === 'oracle' || kind === 'oceanbase-oracle'
const isMysqlKind = (kind: DbKind): boolean => kind === 'mysql' || kind === 'oceanbase-mysql'

const conns = ref<SavedConn[]>([])
const active = ref<ActiveConn | null>(null)
const connecting = ref(false)

// ==================== 已保存查询（Cache/db/*.sql） ====================

const cacheDir = ref('')
const savedQueries = ref<string[]>([])

/** 已保存查询的目录：按连接隔离（Cache/db/<连接名>/），当前连接只能看到自己的查询 */
const savedDir = computed(() =>
  cacheDir.value && active.value ? `${cacheDir.value}/${active.value.config.name}` : ''
)

const refreshSavedQueries = async (): Promise<void> => {
  if (!savedDir.value) {
    savedQueries.value = []
    return
  }
  try {
    await localFiles('mkdir', savedDir.value)
    const files = (await localFiles('list', savedDir.value)) as string[]
    savedQueries.value = files
      .filter((f) => f.endsWith('.sql'))
      .map((f) =>
        f
          .replace(/[\\/]/g, '/')
          .split('/')
          .pop()!
          .replace(/\.sql$/i, '')
      )
  } catch {
    savedQueries.value = []
  }
}

const saveQuery = async (): Promise<void> => {
  const tab = activeQueryTab.value
  if (!tab) return
  if (!tab.sql.trim()) {
    ElMessage.warning('当前查询窗口为空')
    return
  }
  try {
    const { value } = await ElMessageBox.prompt('请为当前查询窗口命名', '保存查询', {
      inputValue: tab.title.replace(/^查询\s*/, '') || '',
      confirmButtonText: '保存',
      cancelButtonText: '取消',
      inputValidator: (v: string) =>
        v && !/[\\/:*?"<>|]/.test(v) ? true : '文件名不能包含 \\ / : * ? " < > |'
    })
    await localFiles('mkdir', savedDir.value)
    await localFiles('write', `${savedDir.value}/${value}.sql`, tab.sql)
    await refreshSavedQueries()
    rebuildTree()
    // 保存成功后，当前查询窗口标题改为保存的名称
    const t = activeQueryTab.value
    if (t && t.sql.trim()) t.title = value
    ElMessage.success(`已保存为 ${value}.sql`)
  } catch {
    /* 取消保存 */
  }
}

const openSavedQuery = async (name: string): Promise<void> => {
  // 已打开同名查询文件时直接切换，不重复新建
  const existing = queryTabs.value.find((t) => t.title === name)
  if (existing) {
    activeQueryId.value = existing.id
    editorMode.value = 'sql'
    return
  }
  try {
    const content = (await localFiles('read', `${savedDir.value}/${name}.sql`)) as string
    querySeq.value++
    const tab: QueryTab = {
      id: `qt_${Date.now()}_${querySeq.value}`,
      title: name,
      sql: content ?? '',
      database: selectedDb.value
    }
    queryTabs.value.push(tab)
    activeQueryId.value = tab.id
    editorMode.value = 'sql'
  } catch (e) {
    ElMessage.error(`读取查询失败：${(e as Error).message}`)
  }
}

const loadConns = async (): Promise<void> => {
  try {
    const dir = await window.dot.getAppPath()
    cacheDir.value = `${dir.replace(/[\\/]+$/, '')}\\Cache\\db`
    await refreshSavedQueries()
    configPath = `${dir.replace(/[\\/]+$/, '')}\\dot-db.json`
    const raw = (await localFiles('read', configPath)) as string
    if (raw) conns.value = JSON.parse(raw) as SavedConn[]
  } catch {
    conns.value = []
  }
}

const persistConns = async (): Promise<void> => {
  if (!configPath) return
  await localFiles('write', configPath, JSON.stringify(conns.value, null, 2))
}

// ==================== 连接对话框 ====================

const dialogVisible = ref(false)
const dialogMode = ref<'create' | 'edit'>('create')
const form = reactive<SavedConn>({
  id: '',
  name: '',
  kind: 'mysql',
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: '',
  database: '',
  serviceName: '',
  sid: '',
  ssl: false
})

const resetForm = (kind: DbKind = 'mysql'): void => {
  const opt = KIND_OPTIONS.find((o) => o.value === kind)!
  form.id = ''
  form.name = ''
  form.kind = kind
  form.host = '127.0.0.1'
  form.port = opt.defaultPort
  form.user =
    kind === 'oracle' || kind === 'oceanbase-oracle'
      ? 'system'
      : kind === 'pgsql'
        ? 'postgres'
        : 'root'
  form.password = ''
  form.database = ''
  form.serviceName = kind === 'oracle' || kind === 'oceanbase-oracle' ? 'ORCL' : ''
  form.sid = ''
  form.ssl = false
}

const openCreate = (): void => {
  dialogMode.value = 'create'
  resetForm()
  dialogVisible.value = true
}

const openEdit = (conn: SavedConn): void => {
  dialogMode.value = 'edit'
  Object.assign(form, conn)
  dialogVisible.value = true
}

const onKindChange = (kind: DbKind): void => {
  form.port = KIND_OPTIONS.find((o) => o.value === kind)!.defaultPort
}

const formToConfig = (): SavedConn => ({
  id: form.id || `c_${Date.now()}`,
  name: form.name || `${form.kind}@${form.host}`,
  kind: form.kind,
  host: form.host.trim(),
  port: Number(form.port),
  user: form.user.trim(),
  password: form.password,
  database: form.database?.trim() || undefined,
  serviceName: form.serviceName?.trim() || undefined,
  sid: form.sid?.trim() || undefined,
  ssl: form.ssl || undefined
})

const validateForm = (c: SavedConn): string => {
  if (!c.host) return '请填写主机地址'
  if (!c.port) return '请填写端口'
  if (!c.user) return '请填写用户名'
  if (isOracleKind(c.kind) && !c.serviceName && !c.sid) return 'Oracle 请填写服务名或 SID'
  return ''
}

const testing = ref(false)
const testConnection = async (): Promise<void> => {
  const cfg = formToConfig()
  const err = validateForm(cfg)
  if (err) {
    ElMessage.warning(err)
    return
  }
  testing.value = true
  try {
    // 深克隆，避免 reactive Proxy 无法 structured clone
    const r = await dbApi.test(JSON.parse(JSON.stringify(cfg)))
    ElMessage.success(r.message || '连接成功')
  } catch (e) {
    ElMessage.error(`连接失败：${(e as Error).message}`)
  } finally {
    testing.value = false
  }
}

/** AI 识别：从粘贴文本中解析连接信息并自动填写 */
const aiPasteText = ref('')
const aiRecognizing = ref(false)

const aiRecognize = async (): Promise<void> => {
  const text = aiPasteText.value.trim()
  if (!text) {
    ElMessage.warning('请先粘贴连接信息（URL、JDBC 串或文本描述均可）')
    return
  }
  aiRecognizing.value = true
  try {
    const r = await sendLlm(
      [
        {
          role: 'system',
          content:
            '你是数据库连接信息解析器。从用户提供的文本（可能是连接 URL、JDBC 串、配置片段或自然语言）中提取数据库连接信息。只输出一个 JSON 对象，不要输出任何其他内容。字段：name(连接名,字符串,可为空串)、kind(只能是 "mysql"/"oceanbase-mysql"/"pgsql"/"oracle"/"oceanbase-oracle" 之一，无法判断时用 "mysql")、host(字符串)、port(数字)、user(字符串)、password(字符串,可为空串)、database(数据库名,无则空串)、serviceName(Oracle 服务名,无则空串)、sid(Oracle SID,无则空串)、ssl(布尔)。'
        },
        { role: 'user', content: text }
      ],
      { temperature: 0 }
    )
    let raw = r.content.trim()
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
    if (fence) raw = fence[1].trim()
    const brace = /\{[\s\S]*\}/.exec(raw)
    if (brace) raw = brace[0]
    const obj = JSON.parse(raw) as Partial<SavedConn>
    if (obj.name) form.name = String(obj.name)
    if (obj.kind && KIND_OPTIONS.some((o) => o.value === obj.kind)) {
      form.kind = obj.kind
      onKindChange(obj.kind)
    }
    if (obj.host) form.host = String(obj.host)
    if (obj.port) form.port = Number(obj.port)
    if (obj.user) form.user = String(obj.user)
    if (obj.password) form.password = String(obj.password)
    form.database = obj.database ? String(obj.database) : ''
    form.serviceName = obj.serviceName ? String(obj.serviceName) : ''
    form.sid = obj.sid ? String(obj.sid) : ''
    form.ssl = !!obj.ssl
    ElMessage.success('AI 识别完成，请核对各项内容')
  } catch (e) {
    ElMessage.error(`AI 识别失败：${(e as Error).message}`)
  } finally {
    aiRecognizing.value = false
  }
}

const saveAndConnect = async (): Promise<void> => {
  const cfg = formToConfig()
  const err = validateForm(cfg)
  if (err) {
    ElMessage.warning(err)
    return
  }
  if (dialogMode.value === 'create') {
    conns.value.push(cfg)
  } else {
    const idx = conns.value.findIndex((c) => c.id === cfg.id)
    if (idx >= 0) conns.value[idx] = cfg
  }
  await persistConns()
  dialogVisible.value = false
  await doConnect(cfg)
}

const removeConn = async (conn: SavedConn): Promise<void> => {
  try {
    await ElMessageBox.confirm(`确定删除连接「${conn.name}」？`, '提示', { type: 'warning' })
  } catch {
    return
  }
  conns.value = conns.value.filter((c) => c.id !== conn.id)
  await persistConns()
}

// ==================== 连接 / 数据库选择 ====================

const dbOptions = ref<string[]>([])
const selectedDb = ref('')

const doConnect = async (cfg: SavedConn): Promise<void> => {
  connecting.value = true
  try {
    if (active.value) {
      await dbApi.disconnect(active.value.connId).catch(() => undefined)
    }
    // 深克隆，避免 reactive Proxy 无法 structured clone
    const r = await dbApi.connect(JSON.parse(JSON.stringify(cfg)))
    active.value = {
      connId: r.connId,
      kind: cfg.kind,
      config: cfg,
      currentDatabase: r.currentDatabase,
      currentSchema: r.currentSchema
    }
    // 加载可选数据库 / Schema 列表
    try {
      const scope = isMysqlKind(cfg.kind) ? 'databases' : 'schemas'
      const items = (await dbApi.catalog(r.connId, scope)) as CatalogItem[]
      dbOptions.value = items.map((it) => it.name).filter((n) => n && n !== 'undefined')
      // Oracle 过滤掉系统用户，避免候选过长
      if (!isMysqlKind(cfg.kind)) {
        const sys = new Set([
          'SYS',
          'SYSTEM',
          'XDB',
          'OUTLN',
          'GSMADMIN_INTERNAL',
          'GSMUSER',
          'DBSNMP',
          'APPQOSSYS',
          'DBSFWUSER',
          'AUDSYS',
          'OJVMSYS',
          'LBACSYS',
          'DVSYS',
          'DVF',
          'WMSYS',
          'MDSYS',
          'OLAPSYS',
          'ORDDATA',
          'ORDSYS',
          'ORDPLUGINS',
          'SI_INFORMTN_SCHEMA',
          'CTXSYS',
          'EXFSYS',
          'XS$NULL',
          'FLOWS_FILES',
          'APEX_PUBLIC_USER',
          'ANONYMOUS',
          'REMOTE_SCHEDULER_AGENT',
          'SYSBACKUP',
          'SYSDG',
          'SYSKM',
          'SYSRAC',
          'GSMCATUSER'
        ])
        const current = (r.currentSchema || '').toUpperCase()
        dbOptions.value = dbOptions.value.filter(
          (n) => !sys.has(n.toUpperCase()) || n.toUpperCase() === current
        )
      }
    } catch {
      dbOptions.value = []
    }
    // 优先连接配置里的默认 Schema，其次登录用户对应的 Schema / 当前数据库
    const prefer = cfg.database || r.currentDatabase || r.currentSchema || ''
    selectedDb.value =
      prefer && dbOptions.value.some((n) => n.toUpperCase() === prefer.toUpperCase())
        ? dbOptions.value.find((n) => n.toUpperCase() === prefer.toUpperCase())!
        : dbOptions.value[0] || ''
    resultTabs.value = []
    activeResultId.value = ''
    // 切换连接：清空查询窗口与脚本状态
    queryTabs.value = []
    activeQueryId.value = ''
    editorMode.value = 'sql'
    structure.value = null
    structureOpen.value = false
    await refreshSavedQueries()
    rebuildTree()
  } catch (e) {
    ElMessage.error(`连接失败：${(e as Error).message}`)
  } finally {
    connecting.value = false
  }
}

const disconnect = async (): Promise<void> => {
  if (active.value) await dbApi.disconnect(active.value.connId).catch(() => undefined)
  active.value = null
  dbOptions.value = []
  selectedDb.value = ''
  resultTabs.value = []
  activeResultId.value = ''
  queryTabs.value = []
  activeQueryId.value = ''
  structure.value = null
  structureOpen.value = false
  sequenceInfo.value = null
  sequenceOpen.value = false
  editorMode.value = 'sql'
  await refreshSavedQueries()
  rebuildTree()
}

window.addEventListener('beforeunload', () => {
  if (active.value) void dbApi.disconnect(active.value.connId)
})

// ==================== 左侧对象树 ====================

const GROUP_DEFS: Array<{ kind: GroupKind; label: string }> = [
  { kind: 'tables', label: '表' },
  { kind: 'views', label: '视图' },
  { kind: 'sequences', label: '序列' },
  { kind: 'procedures', label: '存储过程' }
]

const treeProps = { label: 'label', isLeaf: (data: TreeNode) => data.leaf === true }

/** 非懒加载：根分组立即渲染，子项后台填充，避免懒加载 spinner 引起的闪烁 */
const treeData = ref<TreeNode[]>([])

const fetchGroupItems = async (
  group: GroupKind,
  database?: string,
  schema?: string
): Promise<CatalogItem[]> => {
  const conn = active.value
  if (!conn) return []
  if (group === 'tables') {
    return (
      (await dbApi.catalog(conn.connId, 'tables', { database, schema })) as CatalogItem[]
    ).filter((it) => it.type !== 'VIEW')
  }
  if (group === 'views') {
    return (
      (await dbApi.catalog(conn.connId, 'tables', { database, schema })) as CatalogItem[]
    ).filter((it) => it.type === 'VIEW')
  }
  if (group === 'sequences') {
    return (await dbApi.catalog(conn.connId, 'sequences', { database, schema })) as CatalogItem[]
  }
  return (await dbApi.catalog(conn.connId, 'procedures', { database, schema })) as CatalogItem[]
}

const GROUP_NODE_TYPE: Record<GroupKind, TreeNode['nodeType']> = {
  tables: 'table',
  views: 'view',
  sequences: 'sequence',
  procedures: 'procedure'
}

const rebuildTree = (): void => {
  const conn = active.value
  if (!conn) {
    treeData.value = []
    return
  }
  const database = isMysqlKind(conn.kind) ? selectedDb.value : undefined
  const schema = isMysqlKind(conn.kind) ? undefined : selectedDb.value
  // 根：4 个对象分组 + 查询（已保存，置于最下），对象分组先挂"加载中…"占位，子项加载后原位替换
  treeData.value = [
    ...GROUP_DEFS.map((g) => ({
      id: `group::${g.kind}`,
      label: g.label,
      name: g.label,
      nodeType: 'group' as const,
      group: g.kind,
      database,
      schema,
      children: [
        {
          id: `${g.kind}::__loading`,
          label: '加载中…',
          name: '__loading',
          nodeType: 'group' as const,
          group: g.kind,
          database,
          schema,
          leaf: true
        }
      ]
    })),
    {
      id: 'group::saved',
      label: '查询',
      name: '查询',
      nodeType: 'group' as const,
      database,
      schema,
      children: savedQueries.value.map((name) => ({
        id: `saved::${name}`,
        label: name,
        name,
        nodeType: 'group' as const,
        database,
        schema,
        leaf: true
      }))
    }
  ]
  for (const g of GROUP_DEFS) {
    void fetchGroupItems(g.kind, database, schema)
      .then((items) => {
        const node = treeData.value.find((n) => n.id === `group::${g.kind}`)
        if (!node) return
        if (!items.length) {
          node.children = [
            {
              id: `${g.kind}::__empty`,
              label: '（暂无对象）',
              name: '__empty',
              nodeType: 'group',
              group: g.kind,
              database,
              schema,
              leaf: true
            }
          ]
          return
        }
        node.children = items.map((it) => ({
          id: `${g.kind}::${it.name}`,
          label: it.name,
          name: it.name,
          nodeType: GROUP_NODE_TYPE[g.kind],
          group: g.kind,
          database,
          schema,
          objType: it.type,
          leaf: true
        }))
      })
      .catch((e) => {
        ElMessage.error(`目录加载失败：${(e as Error).message}`)
        const node = treeData.value.find((n) => n.id === `group::${g.kind}`)
        if (node)
          node.children = [
            {
              id: `${g.kind}::__error`,
              label: '（加载失败）',
              name: '__error',
              nodeType: 'group',
              group: g.kind,
              database,
              schema,
              leaf: true
            }
          ]
      })
  }
}

// ==================== 表结构（单击展示） ====================

interface StructureState {
  table: string
  isView: boolean
  database?: string
  schema?: string
  columns: ColumnInfo[]
  indexes: IndexInfo[]
  loading: boolean
}

const structure = ref<StructureState | null>(null)
const structureOpen = ref(false)

/** 表结构 tab 内部子页：字段 / 索引 / 外键 / 唯一键 */
type StructSubTab = 'fields' | 'indexes' | 'fks' | 'uks'
const structSubTab = ref<StructSubTab>('fields')
const structSubTabs: { key: StructSubTab; label: string }[] = [
  { key: 'fields', label: '字段' },
  { key: 'indexes', label: '索引' },
  { key: 'fks', label: '外键' },
  { key: 'uks', label: '唯一键' }
]
const structIndexRows = computed(
  (): IndexInfo[] => structure.value?.indexes.filter((i) => i.kind === 'INDEX') ?? []
)
const structFkRows = computed(
  (): IndexInfo[] => structure.value?.indexes.filter((i) => i.kind === 'FOREIGN') ?? []
)
const structUkRows = computed(
  (): IndexInfo[] => structure.value?.indexes.filter((i) => i.kind === 'UNIQUE') ?? []
)

/** 序列信息 tab（类似表结构 tab，仅展示序列属性，无 SQL 编辑器） */
interface SequenceState {
  name: string
  database?: string
  schema?: string
  columns: string[]
  rows: Record<string, unknown>[]
  loading: boolean
}

const sequenceInfo = ref<SequenceState | null>(null)
const sequenceOpen = ref(false)
const editorMode = ref<'sql' | 'structure' | 'script' | 'sequence'>('sql')

const onNodeClick = async (data: TreeNode): Promise<void> => {
  // 已保存查询：打开为查询窗口
  if (data.id.startsWith('saved::')) {
    await openSavedQuery(data.name)
    return
  }
  // 视图/序列/存储过程：在查询窗口创建 tab 查看
  if (data.nodeType === 'view' || data.nodeType === 'sequence' || data.nodeType === 'procedure') {
    await openObjectQueryTab(data)
    return
  }
  if (data.nodeType !== 'table') return
  await showStructure(data)
}

/** 单击视图/序列/存储过程：
 * 视图 -> 查询窗口 tab 执行 SELECT；序列 -> 类似表结构的独立 tab 展示序列属性（大数值转文本，避免科学计数法）；
 * 存储过程 -> 查出源码展示到右侧新的 SQL 编辑器 tab。 */
const openObjectQueryTab = async (node: TreeNode): Promise<void> => {
  const conn = active.value
  if (!conn) return
  const name = node.name
  const db = selectedDb.value
  if (node.nodeType === 'view') {
    const title = `查看 ${name}`
    let tab = queryTabs.value.find((t) => t.title === title)
    if (!tab) {
      querySeq.value++
      tab = { id: `qt_${Date.now()}_${querySeq.value}`, title, sql: '', database: db }
      queryTabs.value.push(tab)
    }
    tab.sql = `SELECT * FROM ${name}`
    activeQueryId.value = tab.id
    editorMode.value = 'sql'
    await executeStatements([
      {
        sql: tab.sql,
        tableCtx: { database: node.database, schema: node.schema, table: name }
      }
    ])
    return
  }
  if (node.nodeType === 'sequence') {
    let sql: string
    if (isOracleKind(conn.kind)) {
      sql = `SELECT SEQUENCE_NAME, TO_CHAR(MIN_VALUE) AS MIN_VALUE, TO_CHAR(MAX_VALUE) AS MAX_VALUE, TO_CHAR(INCREMENT_BY) AS INCREMENT_BY, CACHE_SIZE, CYCLE_FLAG, ORDER_FLAG, TO_CHAR(LAST_NUMBER) AS LAST_NUMBER FROM USER_SEQUENCES WHERE SEQUENCE_NAME = '${name.toUpperCase()}'`
    } else if (conn.kind === 'pgsql') {
      sql = `SELECT sequencename, start_value::text AS start_value, min_value::text AS min_value, max_value::text AS max_value, increment_by::text AS increment_by, cycle, cache_size::text AS cache_size, last_value::text AS last_value FROM pg_sequences WHERE sequencename = '${name.toLowerCase()}'`
    } else {
      ElMessage.warning('当前连接类型暂不支持查看序列')
      return
    }
    sequenceInfo.value = {
      name,
      database: node.database,
      schema: node.schema,
      columns: [],
      rows: [],
      loading: true
    }
    sequenceOpen.value = true
    editorMode.value = 'sequence'
    try {
      const r = await dbApi.query(conn.connId, sql, `obj_${Date.now()}`, db)
      if (sequenceInfo.value && sequenceInfo.value.name === name) {
        sequenceInfo.value.columns = r.columns
        sequenceInfo.value.rows = r.rows
      }
    } catch (e) {
      ElMessage.error(`加载序列失败：${(e as Error).message}`)
    } finally {
      if (sequenceInfo.value) sequenceInfo.value.loading = false
    }
    return
  }
  // 存储过程：拉取源码展示到新的 SQL 编辑器 tab
  try {
    let src = ''
    if (isOracleKind(conn.kind)) {
      const r = await dbApi.query(
        conn.connId,
        `SELECT TEXT FROM USER_SOURCE WHERE NAME = '${name.toUpperCase()}' ORDER BY LINE`,
        `obj_${Date.now()}`,
        db
      )
      // 后端统一将 Oracle 列名转为小写，兼容取 text/TEXT
      src = r.rows
        .map((row) => {
          const t = String(row['text'] ?? row['TEXT'] ?? '')
          return t.endsWith('\n') ? t : `${t}\n`
        })
        .join('')
    } else if (conn.kind === 'pgsql') {
      const r = await dbApi.query(
        conn.connId,
        `SELECT prosrc FROM pg_proc WHERE proname = '${name.toLowerCase()}'`,
        `obj_${Date.now()}`,
        db
      )
      src = r.rows.map((row) => String(row['prosrc'] ?? '')).join('\n')
    } else {
      const r = await dbApi.query(
        conn.connId,
        `SHOW CREATE PROCEDURE ${name}`,
        `obj_${Date.now()}`,
        db
      )
      const row = r.rows[0] ?? {}
      // SHOW CREATE PROCEDURE/FUNCTION 的源码列以 "Create " 开头（Create Procedure 等）
      const srcKey = Object.keys(row).find((k) => /^create /i.test(k))
      src = String((srcKey && row[srcKey]) ?? '')
    }
    querySeq.value++
    const tab: QueryTab = {
      id: `qt_${Date.now()}_${querySeq.value}`,
      title: name,
      sql: src,
      database: db
    }
    queryTabs.value.push(tab)
    activeQueryId.value = tab.id
    editorMode.value = 'sql'
  } catch (e) {
    ElMessage.error(`加载存储过程失败：${(e as Error).message}`)
  }
}

const openSequenceTab = (): void => {
  editorMode.value = 'sequence'
}

const closeSequenceTab = (): void => {
  sequenceOpen.value = false
  editorMode.value = 'sql'
}

const showStructure = async (node: TreeNode): Promise<void> => {
  const conn = active.value
  if (!conn) return
  editorMode.value = 'structure'
  structureOpen.value = true
  cancelStructEdit()
  structSubTab.value = 'fields'
  structure.value = {
    table: node.name,
    isView: node.nodeType === 'view',
    database: node.database,
    schema: node.schema,
    columns: [],
    indexes: [],
    loading: true
  }
  try {
    const cols = (await dbApi.catalog(conn.connId, 'columns', {
      database: node.database,
      schema: node.schema,
      table: node.name
    })) as ColumnInfo[]
    if (structure.value && structure.value.table === node.name) structure.value.columns = cols
  } catch (e) {
    ElMessage.error(`加载表结构失败：${(e as Error).message}`)
  } finally {
    if (structure.value) structure.value.loading = false
  }
  // 索引/外键/唯一键异步加载，失败不影响字段展示
  try {
    const idx = (await dbApi.catalog(conn.connId, 'indexes', {
      database: node.database,
      schema: node.schema,
      table: node.name
    })) as IndexInfo[]
    if (structure.value && structure.value.table === node.name) structure.value.indexes = idx
  } catch (e) {
    ElMessage.error(`加载索引信息失败：${(e as Error).message}`)
  }
}

// ==================== 表结构编辑（字段名/类型/可空/注释） ====================

/** 单个字段的编辑草稿（length 为类型括号内的长度/精度，编辑时与 dataType 双向联动） */
interface StructDraft {
  name: string
  dataType: string
  length: string
  nullable: boolean
  comment: string
}

/** 常用字段类型（按数据库方言区分，类型下拉可搜索、可自定义输入） */
const dialectTypes = computed((): string[] => {
  const kind = active.value?.kind
  if (kind && isOracleKind(kind)) {
    return [
      'VARCHAR2',
      'NVARCHAR2',
      'CHAR',
      'CLOB',
      'NCLOB',
      'NUMBER',
      'DATE',
      'TIMESTAMP',
      'BLOB',
      'RAW',
      'LONG',
      'FLOAT'
    ]
  }
  if (kind === 'pgsql') {
    return [
      'VARCHAR',
      'CHAR',
      'TEXT',
      'SMALLINT',
      'INTEGER',
      'BIGINT',
      'NUMERIC',
      'REAL',
      'DOUBLE PRECISION',
      'BOOLEAN',
      'DATE',
      'TIME',
      'TIMESTAMP',
      'JSON',
      'JSONB',
      'BYTEA'
    ]
  }
  // MySQL / OceanBase MySQL
  return [
    'VARCHAR',
    'CHAR',
    'TEXT',
    'TINYINT',
    'SMALLINT',
    'INT',
    'BIGINT',
    'DECIMAL',
    'DOUBLE',
    'FLOAT',
    'BOOLEAN',
    'DATE',
    'DATETIME',
    'TIME',
    'TIMESTAMP',
    'JSON',
    'BLOB'
  ]
})

/** 提取类型括号内的长度/精度：varchar(50) → 50，number(10,2) → 10,2 */
const typeLength = (dataType: string): string => dataType.match(/\(([^()]*)\)\s*$/)?.[1] ?? ''
/** 去掉类型末尾的括号部分：varchar(50) → varchar */
const typeBase = (dataType: string): string => dataType.replace(/\([^()]*\)\s*$/, '').trim()

/** 目录查询返回的 dataType 不带长度/精度（如 VARCHAR2、varchar），length 单独存放；
 * 编辑时组合出完整类型（VARCHAR2(100)、NUMBER(10,2)），否则 Oracle 报 ORA-00906 */
const fullDataType = (c: { dataType: string; length?: string }): string => {
  const t = c.dataType.toUpperCase()
  if (typeLength(t) || !c.length) return t
  return `${typeBase(t)}(${c.length})`
}

/** 长度输入 → 回写 dataType（base + (length)） */
const onStructLengthInput = (row: ColumnInfo, val: string): void => {
  const d = structDrafts.value[row.name]
  if (!d) return
  d.length = val
  d.dataType = val.trim() ? `${typeBase(d.dataType)}(${val})` : typeBase(d.dataType)
}

/** 类型选择/输入 → 同步长度 */
const onStructTypeChange = (row: ColumnInfo, val: string): void => {
  const d = structDrafts.value[row.name]
  if (!d) return
  d.length = typeLength(val)
}

const structEditing = ref(false)
const structDrafts = ref<Record<string, StructDraft>>({})
const structSaving = ref(false)

// ==================== Ctrl+A 全选（仅选中当前表格内容） ====================

/**
 * 用 event.currentTarget 而非 ref：结果区多个 tab 各有一份 data-pane，
 * 同名 ref 只指向最后渲染的容器，切到其他 tab 时会聚焦/全选到隐藏容器
 */

/** mousedown 时聚焦容器，保证后续 Ctrl+A 能被容器 keydown 捕获 */
const onPaneMousedown = (e: MouseEvent): void => {
  ;(e.currentTarget as HTMLElement).focus()
}

/** 将 Ctrl+A 限定为全选当前容器内容，避免整页选中 */
const selectAllIn = (e: KeyboardEvent, el: HTMLElement | null): void => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'a' || !el) return
  e.preventDefault()
  e.stopPropagation()
  const sel = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(el)
  sel?.removeAllRanges()
  sel?.addRange(range)
}

const onStructPaneKeydown = (e: KeyboardEvent): void =>
  selectAllIn(e, e.currentTarget as HTMLElement)

/** 复制当前选中的行（Tab 分隔）或列（每行一个值） */
const copyTabSelection = async (tab: ResultTab): Promise<void> => {
  let text = ''
  if (tab.selectedCol) {
    const col = tab.selectedCol
    text = tab.rows.map((r) => String(r[col] ?? '')).join('\n')
  } else if (tab.selectedRid !== null) {
    // rid 为 r{索引} 格式，按索引回找原始行
    const idx = tab.rows.findIndex((_, i) => `r${i}` === tab.selectedRid)
    if (idx >= 0) {
      const row = tab.rows[idx]
      text = tab.columns.map((c) => String(row[c] ?? '')).join('\t')
    }
  }
  if (!text) return
  await navigator.clipboard.writeText(text)
}

/** 数据视图快捷键：Ctrl+A 全选表格内容，Ctrl+C 复制选中的行/列 */
const onDataPaneKeydown = (e: KeyboardEvent, tab: ResultTab): void => {
  if (!(e.ctrlKey || e.metaKey)) return
  const key = e.key.toLowerCase()
  if (key === 'a') {
    selectAllIn(e, e.currentTarget as HTMLElement)
  } else if (key === 'c') {
    // 有真实文本选区（如框选单元格文字）时走浏览器默认复制
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) return
    e.preventDefault()
    e.stopPropagation()
    void copyTabSelection(tab)
  }
}

/** 是否为可编辑表（视图不可改结构） */
const structEditable = computed(() => !!structure.value && !structure.value.isView)
/** 结构编辑禁用原因（用于悬浮提示） */
const structEditTip = computed(() => (structure.value?.isView ? '视图不支持修改结构' : ''))

/** 进入编辑模式：为每个字段生成草稿 */
const startStructEdit = (): void => {
  if (!structure.value) return
  const drafts: Record<string, StructDraft> = {}
  for (const c of structure.value.columns) {
    // 组合出带长度/精度的完整类型（数据库类型统一大写展示）
    const dataType = fullDataType(c)
    drafts[c.name] = {
      name: c.name,
      dataType,
      length: typeLength(dataType),
      nullable: c.nullable,
      comment: c.comment ?? ''
    }
  }
  structDrafts.value = drafts
  structEditing.value = true
}

const cancelStructEdit = (): void => {
  structEditing.value = false
  structDrafts.value = {}
}

/** 是否有草稿与原结构不同 */
const hasStructChange = computed(() => {
  if (!structEditing.value || !structure.value) return false
  return structure.value.columns.some((c) => {
    const d = structDrafts.value[c.name]
    if (!d) return false
    return (
      d.name !== c.name ||
      d.dataType !== fullDataType(c) ||
      d.nullable !== c.nullable ||
      d.comment !== (c.comment ?? '')
    )
  })
})

/** 保存：逐字段调用 alterColumn（改名/类型/可空/注释由主进程拆分语句执行），完成后刷新结构 */
const saveStructEdit = async (): Promise<void> => {
  const conn = active.value
  const st = structure.value
  if (!conn || !st) return
  const changed = st.columns.filter((c) => {
    const d = structDrafts.value[c.name]
    if (!d) return false
    return (
      d.name !== c.name ||
      d.dataType !== fullDataType(c) ||
      d.nullable !== c.nullable ||
      d.comment !== (c.comment ?? '')
    )
  })
  if (!changed.length) return
  structSaving.value = true
  try {
    for (const c of changed) {
      const d = structDrafts.value[c.name]
      await dbApi.alterColumn({
        connId: conn.connId,
        database: st.database,
        schema: st.schema,
        table: st.table,
        oldName: c.name,
        newName: d.name !== c.name ? d.name : undefined,
        dataType: d.dataType,
        nullable: d.nullable,
        wasNullable: c.nullable,
        comment: d.comment
      })
    }
    ElMessage.success(`已保存 ${changed.length} 个字段的修改`)
    cancelStructEdit()
    // 重新加载结构（从当前状态取值，避免闭包旧数据）
    const node: TreeNode = {
      id: '',
      label: st.table,
      name: st.table,
      nodeType: 'table',
      database: st.database,
      schema: st.schema,
      leaf: true
    }
    await showStructure(node)
  } catch (e) {
    ElMessage.error(`保存失败：${(e as Error).message}`)
    // 保存失败后刷新结构，展示数据库中的真实状态
    const node: TreeNode = {
      id: '',
      label: st.table,
      name: st.table,
      nodeType: 'table',
      database: st.database,
      schema: st.schema,
      leaf: true
    }
    await showStructure(node)
    cancelStructEdit()
  } finally {
    structSaving.value = false
  }
}

// 双击表：查询表数据（结果展示在下方结果区）
const onNodeDblclick = async (data: TreeNode): Promise<void> => {
  if (data.nodeType !== 'table' && data.nodeType !== 'view') return
  if (!active.value) return
  const sql = `SELECT * FROM ${data.name}`
  if (activeQueryTab.value) activeQueryTab.value.sql = sql
  else {
    querySeq.value++
    queryTabs.value.push({
      id: `qt_${Date.now()}_${querySeq.value}`,
      title: `查询 ${querySeq.value}`,
      sql,
      database: selectedDb.value
    })
    activeQueryId.value = queryTabs.value[queryTabs.value.length - 1].id
  }
  await executeStatements([
    { sql, tableCtx: { database: data.database, schema: data.schema, table: data.name } }
  ])
}

// ==================== SQL 执行 ====================

const sqlInputRef = ref<HTMLTextAreaElement | null>(null)
const running = ref(false)
const runningQueryId = ref('')

/** 查询窗口 tab：新建查询每次打开一个，各自可使用不同数据库 */
interface QueryTab {
  id: string
  title: string
  sql: string
  database: string
}

const queryTabs = ref<QueryTab[]>([])
const activeQueryId = ref('')
const querySeq = ref(0)

const activeQueryTab = computed(() => queryTabs.value.find((t) => t.id === activeQueryId.value))

const newQuery = (): void => {
  if (!active.value) {
    ElMessage.warning('请先连接数据库')
    return
  }
  querySeq.value++
  const tab: QueryTab = {
    id: `qt_${Date.now()}_${querySeq.value}`,
    title: `查询 ${querySeq.value}`,
    sql: '',
    database: selectedDb.value
  }
  queryTabs.value.push(tab)
  activeQueryId.value = tab.id
  editorMode.value = 'sql'
  // 保留表结构 tab 状态，仅切换编辑模式
  void nextTick(() => sqlInputRef.value?.focus())
}

const closeQueryTab = (id: string): void => {
  const idx = queryTabs.value.findIndex((t) => t.id === id)
  if (idx < 0) return
  queryTabs.value.splice(idx, 1)
  if (activeQueryId.value === id) {
    activeQueryId.value = queryTabs.value[Math.max(0, idx - 1)]?.id ?? ''
  }
}

const activateQueryTab = (): void => {
  editorMode.value = 'sql'
  // 切换 tab 恢复该 tab 的数据库上下文（表结构 tab 状态保留，仅切换编辑模式）
  const db = activeQueryTab.value?.database
  if (db && db !== selectedDb.value && dbOptions.value.includes(db)) {
    selectedDb.value = db
    rebuildTree()
  }
}

/** 切换当前查询 tab 的数据库 */
const onTabDbChange = (db: string): void => {
  if (activeQueryTab.value) activeQueryTab.value.database = db
  selectedDb.value = db
  rebuildTree()
}

const openStructureTab = (): void => {
  editorMode.value = 'structure'
}

const closeStructureTab = (): void => {
  cancelStructEdit()
  structureOpen.value = false
  editorMode.value = 'sql'
}

/** 当前查询窗口的 SQL（含选中文本优先） */
const targetSqlText = (): string => {
  const el = sqlInputRef.value as HTMLTextAreaElement | null
  if (el && el.selectionStart !== undefined && el.selectionEnd !== el.selectionStart) {
    return el.value.slice(el.selectionStart, el.selectionEnd)
  }
  return activeQueryTab.value?.sql ?? ''
}

/** 拆分多条 SQL（感知引号/注释，不感知存储过程体内分号的完整语义） */
const splitStatements = (sql: string): string[] => {
  const out: string[] = []
  let cur = ''
  let inS = false
  let inD = false
  let inBT = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    const n = sql[i + 1] ?? ''
    if (inLine) {
      cur += c
      if (c === '\n') inLine = false
      continue
    }
    if (inBlock) {
      cur += c
      if (c === '*' && n === '/') {
        cur += n
        i++
        inBlock = false
      }
      continue
    }
    if (!inS && !inD && !inBT) {
      if (c === '-' && n === '-') {
        inLine = true
        cur += c
        continue
      }
      if (c === '/' && n === '*') {
        inBlock = true
        cur += c
        continue
      }
    }
    if (c === "'" && !inD && !inBT) {
      inS = !inS
      cur += c
      continue
    }
    if (c === '"' && !inS && !inBT) {
      inD = !inD
      cur += c
      continue
    }
    if (c === '`' && !inS && !inD) {
      inBT = !inBT
      cur += c
      continue
    }
    if (c === ';' && !inS && !inD && !inBT) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/**
 * 解析 SELECT * FROM 单表（用于结果编辑定位目标表；裸表名自动补当前库上下文）
 * 支持 SELECT * / SELECT t.* 与表别名，但必须是单表（无 JOIN / WHERE 等子句）
 */
const parseSingleTable = (sql: string, kind: DbKind): TableCtx | undefined => {
  const m =
    /^\s*SELECT\s+(?:[`"\w]+\.)?\*\s+FROM\s+([`"\w.$#]+)(?:\s+(?:AS\s+)?[`"\w]+)?\s*(?:;|$)/i.exec(
      sql
    )
  if (!m) return undefined
  const parts = m[1].replace(/[`"]/g, '').split('.')
  if (kind === 'mysql' || kind === 'oceanbase-mysql') {
    if (parts.length === 2) return { database: parts[0], table: parts[1] }
    return { database: selectedDb.value || undefined, table: parts[0] }
  }
  if (parts.length === 2) return { schema: parts[0], table: parts[1] }
  return { schema: selectedDb.value || undefined, table: parts[0] }
}

const loadTableCtxColumns = async (tab: ResultTab): Promise<void> => {
  const conn = active.value
  if (!conn || !tab.tableCtx) return
  try {
    const r = (await dbApi.catalog(conn.connId, 'columns', {
      database: tab.tableCtx.database,
      schema: tab.tableCtx.schema,
      table: tab.tableCtx.table
    })) as ColumnInfo[]
    tab.columnsInfo = r
    // 查询成功但没有行：表不存在 / 权限不足 / 大小写不匹配
    if (!r.length) tab.ctxError = `未查到 ${tab.tableCtx.table} 的列信息`
  } catch (e) {
    tab.columnsInfo = []
    tab.ctxError = (e as Error).message
    console.error('[DatabaseView] 加载表结构失败:', e)
  }
}

const addResultTab = (partial: Partial<ResultTab> & { sql: string }): ResultTab => {
  const tab: ResultTab = {
    id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: partial.title ?? `结果 ${resultTabs.value.length + 1}`,
    sql: partial.sql,
    columns: partial.columns ?? [],
    rows: partial.rows ?? [],
    affectedRows: partial.affectedRows ?? 0,
    insertId: partial.insertId,
    truncated: partial.truncated ?? false,
    serverPaged: partial.serverPaged ?? false,
    total: partial.total ?? 0,
    elapsed: partial.elapsed ?? 0,
    error: partial.error,
    view: 'data',
    page: 1,
    pageSize: 20,
    tableCtx: partial.tableCtx,
    columnsInfo: [],
    edited: {},
    deleted: [],
    newRowRid: null,
    selectedRid: null,
    selectedCol: null,
    editingCell: null,
    editingValue: '',
    showAnalysis: false,
    editEnabled: false,
    planText: partial.planText
  }
  resultTabs.value.push(tab)
  activeResultId.value = tab.id
  // 从响应式数组中取代理对象，后续异步修改 columnsInfo 才能触发界面刷新
  const reactiveTab = resultTabs.value[resultTabs.value.length - 1]
  if (reactiveTab.tableCtx) void loadTableCtxColumns(reactiveTab)
  return reactiveTab
}

/** 判断是否为 SELECT / WITH 查询（可安全包裹为分页子查询） */
const isSelectSql = (sql: string): boolean => /^\s*(select|with)\b/i.test(sql)

/** 将 SQL 包裹为按页取数的子查询 */
const wrapPageSql = (kind: DbKind, sql: string, page: number, pageSize: number): string => {
  const offset = (page - 1) * pageSize
  if (kind === 'oracle' || kind === 'oceanbase-oracle') {
    return `SELECT * FROM (SELECT s__.*, ROWNUM rn__ FROM (${sql}) s__ WHERE ROWNUM <= ${
      offset + pageSize
    }) WHERE rn__ > ${offset}`
  }
  return `SELECT * FROM (${sql}) sub__ LIMIT ${pageSize} OFFSET ${offset}`
}

/** 去掉 Oracle 分页包裹产生的 rn__ 辅助列（不区分大小写），只保留用户查询的字段 */
const stripRnColumn = <T extends { columns: string[]; rows: Record<string, unknown>[] }>(
  r: T
): T => {
  const isRn = (k: string): boolean => /^rn__$/i.test(k)
  if (!r.columns.some(isRn)) return r
  return {
    ...r,
    columns: r.columns.filter((c) => !isRn(c)),
    rows: r.rows.map((row) => {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row)) {
        if (!isRn(k)) out[k] = v
      }
      return out
    })
  } as T
}

const runOneStatement = async (
  sql: string,
  queryId: string,
  tableCtx?: TableCtx
): Promise<void> => {
  const conn = active.value
  if (!conn) return
  const started = Date.now()
  const db = activeQueryTab.value?.database || selectedDb.value || undefined
  try {
    // SELECT 查询：服务端分页，仅取当前页（默认 20 条）+ COUNT 总行数
    if (isSelectSql(sql)) {
      try {
        const cr = await dbApi.query(
          conn.connId,
          `SELECT COUNT(*) AS cnt FROM (${sql}) sub__`,
          queryId,
          db
        )
        const total = Number(Object.values(cr.rows[0] ?? {})[0] ?? 0)
        const pr = stripRnColumn(
          await dbApi.query(conn.connId, wrapPageSql(conn.kind, sql, 1, 20), queryId, db)
        )
        addResultTab({
          sql,
          columns: pr.columns,
          rows: pr.rows,
          affectedRows: pr.affectedRows,
          insertId: pr.insertId,
          truncated: false,
          serverPaged: true,
          total,
          elapsed: Date.now() - started,
          tableCtx: tableCtx ?? parseSingleTable(sql, conn.kind)
        })
        return
      } catch {
        // 无法包裹（如 FOR UPDATE 等特殊语句）时退回普通执行
      }
    }
    const r = await dbApi.query(conn.connId, sql, queryId, db)
    addResultTab({
      sql,
      columns: r.columns,
      rows: r.rows,
      affectedRows: r.affectedRows,
      insertId: r.insertId,
      truncated: r.truncated,
      elapsed: Date.now() - started,
      tableCtx: tableCtx ?? parseSingleTable(sql, conn.kind)
    })
  } catch (e) {
    addResultTab({ sql, elapsed: Date.now() - started, error: (e as Error).message })
  }
}

/** 服务端分页：按页重新取数（翻页 / 调整分页条数时调用） */
const fetchPage = async (tab: ResultTab, page: number): Promise<void> => {
  const conn = active.value
  if (!conn || !tab.serverPaged) return
  const db = activeQueryTab.value?.database || selectedDb.value || undefined
  const queryId = `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  try {
    const pr = stripRnColumn(
      await dbApi.query(
        conn.connId,
        wrapPageSql(conn.kind, tab.sql, page, tab.pageSize),
        queryId,
        db
      )
    )
    tab.columns = pr.columns
    tab.rows = pr.rows
    tab.page = page
    // 翻页后清掉未提交的编辑状态
    tab.edited = {}
    tab.deleted = []
    tab.newRowRid = null
    tab.selectedRid = null
    tab.selectedCol = null
    tab.editingCell = null
  } catch (e) {
    ElMessage.error(`加载第 ${page} 页失败：${(e as Error).message}`)
  }
}

const changePage = (tab: ResultTab, p: number): void => {
  void fetchPage(tab, p)
}

const changePageSize = (tab: ResultTab, v: number): void => {
  tab.pageSize = v
  void fetchPage(tab, 1)
}

const executeStatements = async (
  list: Array<{ sql: string; tableCtx?: TableCtx }>
): Promise<void> => {
  const conn = active.value
  if (!conn || !list.length) return
  running.value = true
  // 新一次执行清掉旧的 tab
  resultTabs.value = []
  activeResultId.value = ''
  upperPct.value = 50
  const queryId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  runningQueryId.value = queryId
  try {
    for (const item of list) {
      await runOneStatement(item.sql, queryId, item.tableCtx)
    }
  } finally {
    running.value = false
    runningQueryId.value = ''
  }
}

const runSql = async (): Promise<void> => {
  const text = targetSqlText()
  if (!text.trim()) {
    ElMessage.warning('请输入 SQL')
    return
  }
  const stmts = splitStatements(text)
  if (!stmts.length) {
    ElMessage.warning('未解析到可执行的 SQL')
    return
  }
  await executeStatements(stmts.map((sql) => ({ sql })))
}

const stopSql = async (): Promise<void> => {
  const qid = runningQueryId.value
  if (!qid) return
  try {
    const r = await dbApi.cancel(qid)
    if (r.success) ElMessage.success('已发送停止请求')
    else ElMessage.warning(r.message || '停止失败')
  } catch (e) {
    ElMessage.error(`停止失败：${(e as Error).message}`)
  }
}

const onSqlKeydown = (e: KeyboardEvent): void => {
  if (completionVisible.value && completionItems.value.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      completionActive.value = (completionActive.value + 1) % completionItems.value.length
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      completionActive.value =
        (completionActive.value - 1 + completionItems.value.length) % completionItems.value.length
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      acceptCompletion()
      return
    }
    if (e.key === 'Escape') {
      completionVisible.value = false
      return
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault()
    void runSql()
  }
}

// ==================== SQL 美化 ====================

const MAJOR_KEYWORDS = [
  'FROM',
  'WHERE',
  'LEFT OUTER JOIN',
  'RIGHT OUTER JOIN',
  'FULL OUTER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'FULL JOIN',
  'INNER JOIN',
  'CROSS JOIN',
  'JOIN',
  'GROUP BY',
  'ORDER BY',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'UNION ALL',
  'UNION',
  'VALUES',
  'SET'
]

const beautifySql = (): void => {
  const tab = activeQueryTab.value
  if (!tab?.sql.trim()) return
  let s = tab.sql.replace(/\s+/g, ' ').trim()
  for (const k of [...MAJOR_KEYWORDS].sort((a, b) => b.length - a.length)) {
    s = s.replace(new RegExp(`\\s+${k}\\b`, 'gi'), `\n${k}`)
  }
  // 逗号字段换行（仅 SELECT 列表区域简单处理：行内逗号后换行）
  s = s
    .split('\n')
    .map((line) => (line.length > 80 ? line.replace(/,\s*/g, ',\n  ') : line))
    .join('\n')
  tab.sql = s
}

// ==================== SQL 补全提示 ====================

const SQL_KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'AND',
  'OR',
  'INSERT INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE FROM',
  'JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'INNER JOIN',
  'ON',
  'GROUP BY',
  'ORDER BY',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'DISTINCT',
  'AS',
  'IN',
  'IS NULL',
  'IS NOT NULL',
  'LIKE',
  'BETWEEN',
  'COUNT(*)',
  'COUNT',
  'SUM',
  'AVG',
  'MAX',
  'MIN',
  'UNION ALL',
  'UNION',
  'EXISTS',
  'CASE WHEN',
  'THEN',
  'ELSE',
  'END',
  'SHOW TABLES',
  'DESC'
]

const completionVisible = ref(false)
const completionItems = ref<Array<{ label: string; insert: string }>>([])
const completionActive = ref(0)
const completionPos = reactive({ start: 0, end: 0, top: 0, left: 0 })

/** 字段名缓存：key = connId|db|table */
const columnCache = ref<Record<string, string[]>>({})

/** 树中所有对象名及所属分组（表/视图/序列/存储过程），供补全区分上下文优先级 */
const objectNames = computed(() => {
  const names: Array<{ name: string; group: string }> = []
  for (const g of treeData.value) {
    for (const child of g.children ?? []) {
      if (!child.leaf || child.name.startsWith('__')) continue
      names.push({ name: child.name, group: g.group ?? '' })
    }
  }
  return names
})

/** 上下文关键词 -> 优先提示的池：FROM/JOIN 后优先表名，WHERE/ON 等后优先字段名 */
const priorityAfter = (before: string): 'table' | 'column' | null => {
  let last = ''
  for (const m of before.matchAll(
    /\b(from|join|into|update|where|and|or|on|having|select|by)\b/gi
  )) {
    last = m[1].toUpperCase()
  }
  if (['FROM', 'JOIN', 'INTO', 'UPDATE'].includes(last)) return 'table'
  if (['WHERE', 'AND', 'OR', 'ON', 'HAVING', 'SELECT', 'BY'].includes(last)) return 'column'
  return null
}

const ensureColumns = async (table: string): Promise<void> => {
  const conn = active.value
  if (!conn) return
  const db = activeQueryTab.value?.database || selectedDb.value
  const key = `${conn.connId}|${db}|${table}`
  if (columnCache.value[key]) return
  try {
    const cols = (await dbApi.catalog(conn.connId, 'columns', {
      database: isMysqlKind(conn.kind) ? db : undefined,
      schema: isMysqlKind(conn.kind) ? undefined : db,
      table
    })) as ColumnInfo[]
    columnCache.value = { ...columnCache.value, [key]: cols.map((c) => c.name) }
  } catch {
    /* 字段拉取失败不阻塞补全 */
  }
}

/** 从 SQL 中提取 FROM/JOIN 后的表名，预拉字段缓存 */
const preloadColumnsForSql = async (sql: string): Promise<void> => {
  const re = /(?:FROM|JOIN)\s+[`"[]?([\w$#]+)[`"\]]?/gi
  let m: RegExpExecArray | null
  const tables = new Set<string>()
  while ((m = re.exec(sql))) tables.add(m[1])
  for (const t of tables) await ensureColumns(t)
}

const allColumnNames = computed(() => {
  const set = new Set<string>()
  for (const cols of Object.values(columnCache.value)) cols.forEach((c) => set.add(c))
  return [...set]
})

/** FROM/JOIN 后的子句关键字，别名解析时需排除 */
const CLAUSE_WORDS_RE =
  /^(where|on|left|right|inner|outer|full|cross|natural|group|order|having|union|limit|offset|set|as|using|join)$/i

/** 解析 SQL 中 FROM/JOIN 后的表与别名映射：别名/表名(小写) -> 真实表名 */
const parseAliasMap = (sql: string): Record<string, string> => {
  const map: Record<string, string> = {}
  const re = /(?:from|join)\s+[`"[]?([\w$#]+)[`"\]]?(?:\s+(?:as\s+)?([`"[]?[\w$#]+[`"\]]?))?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql))) {
    const t = m[1]
    map[t.toLowerCase()] = t
    if (m[2]) {
      const alias = m[2].replace(/[`"[\]]/g, '')
      if (!CLAUSE_WORDS_RE.test(alias)) map[alias.toLowerCase()] = t
    }
  }
  return map
}

/** 点号上下文补全：别名/表名.字段、序列.nextval/currval（ident 为点号前的标识符） */
const buildDotCompletions = (
  ident: string,
  prefix: string
): Array<{ label: string; insert: string }> => {
  const conn = active.value
  if (!conn) return []
  const lower = ident.toLowerCase()
  const names = objectNames.value
  const items: Array<{ label: string; insert: string }> = []
  // 序列：提示 nextval / currval
  if (names.some((o) => o.group === 'sequences' && o.name.toLowerCase() === lower)) {
    for (const fn of ['nextval', 'currval']) {
      if (fn.startsWith(prefix.toLowerCase())) items.push({ label: `${ident}.${fn}`, insert: fn })
    }
    return items.slice(0, 12)
  }
  // 表别名/表名 -> 提示该表字段
  const aliasMap = parseAliasMap(sqlInputRef.value?.value ?? '')
  const table =
    aliasMap[lower] ??
    names.find(
      (o) => (o.group === 'tables' || o.group === 'views') && o.name.toLowerCase() === lower
    )?.name
  if (!table) return []
  void ensureColumns(table)
  const db = activeQueryTab.value?.database || selectedDb.value
  const cols = columnCache.value[`${conn.connId}|${db}|${table}`] ?? []
  for (const c of cols) {
    if (c.toLowerCase().startsWith(prefix.toLowerCase())) items.push({ label: c, insert: c })
  }
  return items.slice(0, 12)
}

// ==================== SQL 快捷方式（缩写模板） ====================

const SHORTCUTS_KEY = 'db_sql_shortcuts'

/** 快捷方式表：缩写 -> 展开文本，如 sf -> select * from  */
const shortcuts = ref<Record<string, string>>({})

const loadShortcuts = (): void => {
  try {
    shortcuts.value = JSON.parse(localStorage.getItem(SHORTCUTS_KEY) || '{}') as Record<
      string,
      string
    >
  } catch {
    shortcuts.value = {}
  }
}

const persistShortcuts = (): void => {
  localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(shortcuts.value))
}

const shortcutsVisible = ref(false)
const shortcutAbbr = ref('')
const shortcutText = ref('')

const openShortcuts = (): void => {
  shortcutAbbr.value = ''
  shortcutText.value = ''
  shortcutsVisible.value = true
}

const addShortcut = (): void => {
  const abbr = shortcutAbbr.value.trim()
  const text = shortcutText.value
  if (!abbr || !text) {
    ElMessage.warning('请填写缩写和展开内容')
    return
  }
  shortcuts.value[abbr] = text
  persistShortcuts()
  shortcutAbbr.value = ''
  shortcutText.value = ''
}

const removeShortcut = (abbr: string): void => {
  delete shortcuts.value[abbr]
  persistShortcuts()
}

const buildCompletions = (
  word: string,
  before: string
): Array<{ label: string; insert: string }> => {
  const w = word.toLowerCase()
  const items: Array<{ label: string; insert: string }> = []
  // 快捷方式优先展示：输入的词是某缩写的前缀
  for (const [abbr, text] of Object.entries(shortcuts.value)) {
    if (w && abbr.toLowerCase().startsWith(w)) {
      items.push({ label: `${abbr}  →  ${text}`, insert: text })
    }
  }
  // 上下文优先池：FROM/JOIN 后表名优先，WHERE/ON 等后字段名优先（关键词不区分大小写）
  const prio = priorityAfter(before)
  const tables = objectNames.value
  const cols = allColumnNames.value
  const pick = (names: string[]): void => {
    for (const n of names) {
      if (
        n.toLowerCase().startsWith(w) &&
        n.toLowerCase() !== w &&
        !items.some((it) => it.insert === n)
      ) {
        items.push({ label: n, insert: n })
      }
    }
  }
  if (prio === 'table') {
    pick(tables.filter((t) => t.group === 'tables' || t.group === 'views').map((t) => t.name))
    pick(tables.filter((t) => t.group !== 'tables' && t.group !== 'views').map((t) => t.name))
    pick(cols)
    pick(SQL_KEYWORDS)
  } else if (prio === 'column') {
    pick(cols)
    pick(tables.map((t) => t.name))
    pick(SQL_KEYWORDS)
  } else {
    pick(tables.map((t) => t.name))
    pick(cols)
    pick(SQL_KEYWORDS)
  }
  return items.slice(0, 12)
}

/** 计算光标在 textarea 中的像素位置（镜像 div 方案） */
const caretPos = (el: HTMLTextAreaElement, pos: number): { top: number; left: number } => {
  const div = document.createElement('div')
  const style = getComputedStyle(el)
  div.style.fontFamily = style.fontFamily
  div.style.fontSize = style.fontSize
  div.style.fontWeight = style.fontWeight
  div.style.lineHeight = style.lineHeight
  div.style.letterSpacing = style.letterSpacing
  div.style.padding = style.padding
  div.style.border = style.border
  div.style.boxSizing = style.boxSizing
  div.style.whiteSpace = 'pre-wrap'
  div.style.wordWrap = 'break-word'
  div.style.width = `${el.clientWidth}px`
  div.style.position = 'absolute'
  div.style.visibility = 'hidden'
  div.textContent = el.value.slice(0, pos)
  const span = document.createElement('span')
  span.textContent = el.value.slice(pos) || '.'
  div.appendChild(span)
  document.body.appendChild(div)
  const top = span.offsetTop
  const left = span.offsetLeft
  document.body.removeChild(div)
  return { top, left }
}

const updateCompletion = (): void => {
  const el = sqlInputRef.value
  if (!el || editorMode.value !== 'sql') {
    completionVisible.value = false
    return
  }
  void preloadColumnsForSql(el.value)
  const pos = el.selectionStart
  const before = el.value.slice(0, pos)
  const m = /([\w$#]+)(?:\.([\w$#]*))?$/.exec(before)
  if (!m) {
    completionVisible.value = false
    return
  }
  // 点号上下文：别名/表名.字段、序列.nextval/currval
  const inDot = m[2] !== undefined
  const items = inDot ? buildDotCompletions(m[1], m[2]) : buildCompletions(m[1], before)
  if (!items.length) {
    completionVisible.value = false
    return
  }
  completionItems.value = items
  completionPos.start = pos - (inDot ? m[2].length : m[1].length)
  completionPos.end = pos
  const { top, left } = caretPos(el, completionPos.start)
  completionPos.top = top
  completionPos.left = left
  completionActive.value = 0
  completionVisible.value = true
}

const acceptCompletion = (item?: { label: string; insert: string }): void => {
  const el = sqlInputRef.value
  const tab = activeQueryTab.value
  if (!el || !tab) return
  const text = (item ?? completionItems.value[completionActive.value])?.insert
  if (!text) return
  const val = el.value
  el.value = val.slice(0, completionPos.start) + text + val.slice(completionPos.end)
  tab.sql = el.value
  const newPos = completionPos.start + text.length
  el.focus()
  el.setSelectionRange(newPos, newPos)
  completionVisible.value = false
  void nextTick(() => {
    void preloadColumnsForSql(el.value)
  })
}

const onSqlInput = (): void => {
  updateCompletion()
}

// ==================== 解释计划 ====================

/** 计划文本单元格安全转字符串 */
const planCell = (v: unknown): string => (v === null || v === undefined ? 'NULL' : String(v))

/** MySQL EXPLAIN 行 -> 摘要 + 原始计划的格式化文本 */
const buildMysqlPlanText = (r: { columns: string[]; rows: Record<string, unknown>[] }): string => {
  const lines: string[] = []
  let fullScans = 0
  for (const row of r.rows) {
    const type = String(row['type'] ?? '')
    const table = String(row['table'] ?? '')
    const key = String(row['key'] ?? '')
    const rowsN = String(row['rows'] ?? '')
    const extra = String(row['Extra'] ?? '')
    const suffix = extra ? `（${extra}）` : ''
    if (type === 'ALL') {
      fullScans++
      lines.push(`⚠ 全表扫描  ${table}：未使用任何索引，预计扫描 ${rowsN} 行${suffix}`)
    } else {
      lines.push(
        `✔ 索引访问  ${table}：${key ? `使用索引 ${key}` : `访问类型 ${type}`}，预计 ${rowsN} 行${suffix}`
      )
    }
  }
  const head = r.rows.length
    ? fullScans
      ? `⚠ 存在 ${fullScans} 处全表扫描，建议为对应表增加索引或改写 SQL`
      : '✔ 所有表均通过索引访问，无全表扫描'
    : '无执行计划输出'
  const cols = r.columns
  const widths = cols.map((c) =>
    Math.max(c.length, ...r.rows.map((row) => planCell(row[c]).length))
  )
  const raw = [
    cols.map((c, i) => c.padEnd(widths[i])).join('  '),
    ...r.rows.map((row) => cols.map((c, i) => planCell(row[c]).padEnd(widths[i])).join('  '))
  ].join('\n')
  return `【执行计划摘要】\n${head}\n\n${lines.join('\n')}\n\n────── 原始计划 ──────\n${raw}`
}

/** Oracle DBMS_XPLAN 输出 -> 摘要 + 原始计划的格式化文本 */
const buildOraclePlanText = (r: { rows: Record<string, unknown>[] }): string => {
  const text = r.rows.map((row) => planCell(Object.values(row)[0])).join('\n')
  let head = '△ 未识别到索引访问，请查看下方计划'
  if (/TABLE ACCESS FULL|FULL TABLE SCAN/.test(text)) {
    head = '⚠ 存在全表扫描（TABLE ACCESS FULL），建议检查索引或统计信息'
  } else if (/INDEX (RANGE|UNIQUE|SKIP) SCAN|BY INDEX ROWID/.test(text)) {
    head = '✔ 走索引访问，无全表扫描'
  } else if (/INDEX FULL SCAN/.test(text)) {
    head = '△ 索引全扫描（INDEX FULL SCAN），扫描整个索引'
  }
  return `【执行计划摘要】\n${head}\n\n────── 原始计划 ──────\n${text}`
}

const explainSql = async (): Promise<void> => {
  const conn = active.value
  if (!conn) return
  const text = targetSqlText()
    .trim()
    .replace(/;+\s*$/, '')
  if (!text) {
    ElMessage.warning('请输入 SQL')
    return
  }
  const stmts = splitStatements(text)
  const sql = stmts[0]
  running.value = true
  resultTabs.value = []
  activeResultId.value = ''
  upperPct.value = 50
  const queryId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  runningQueryId.value = queryId
  const started = Date.now()
  try {
    let planText: string
    if (isOracleKind(conn.kind)) {
      await dbApi.query(conn.connId, `EXPLAIN PLAN FOR ${sql}`, queryId, selectedDb.value)
      const r = await dbApi.query(
        conn.connId,
        'SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY)',
        queryId,
        selectedDb.value
      )
      planText = buildOraclePlanText(r)
    } else {
      const r = await dbApi.query(conn.connId, `EXPLAIN ${sql}`, queryId, selectedDb.value)
      planText = buildMysqlPlanText(r)
    }
    addResultTab({ sql, title: '解释计划', planText, elapsed: Date.now() - started })
  } catch (e) {
    addResultTab({ sql, elapsed: Date.now() - started, error: (e as Error).message })
  } finally {
    running.value = false
    runningQueryId.value = ''
  }
}

// ==================== SQL AI 助手 ====================

const aiAssistVisible = ref(false)
const aiAssistRunning = ref(false)
const aiAssistInstruction = ref('优化这条 SQL，指出性能问题并给出优化后的 SQL')
const aiAssistResult = ref('')
/** 助手作用的 SQL（选中内容或整个查询窗口） */
const aiAssistSql = ref('')
/** 选区范围（若来自选中内容，应用结果时替换该选区） */
const aiAssistSel = ref<{ start: number; end: number } | null>(null)

const openAiAssist = (): void => {
  const tab = activeQueryTab.value
  const el = sqlInputRef.value
  if (!tab || !tab.sql.trim()) {
    ElMessage.warning('请输入 SQL')
    return
  }
  const selStart = el?.selectionStart ?? 0
  const selEnd = el?.selectionEnd ?? 0
  if (el && selEnd > selStart) {
    aiAssistSql.value = tab.sql.slice(selStart, selEnd)
    aiAssistSel.value = { start: selStart, end: selEnd }
  } else {
    aiAssistSql.value = tab.sql
    aiAssistSel.value = null
  }
  aiAssistResult.value = ''
  aiAssistVisible.value = true
}

/** 获取 SQL 的执行计划文本（失败返回错误说明，不抛出） */
const fetchExplainPlan = async (sql: string): Promise<string> => {
  const conn = active.value
  if (!conn) return '（无可用连接）'
  const queryId = `plan_${Date.now()}`
  try {
    if (isOracleKind(conn.kind)) {
      await dbApi.query(conn.connId, `EXPLAIN PLAN FOR ${sql}`, queryId, selectedDb.value)
      const r = await dbApi.query(
        conn.connId,
        'SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY)',
        queryId,
        selectedDb.value
      )
      return buildOraclePlanText(r)
    }
    const r = await dbApi.query(conn.connId, `EXPLAIN ${sql}`, queryId, selectedDb.value)
    return buildMysqlPlanText(r)
  } catch (e) {
    return `（执行计划获取失败：${(e as Error).message}）`
  }
}

/** 从 JSON 文本中提取首个 JSON 对象（容忍 markdown 代码块包裹） */
const parseAiJson = (text: string): Record<string, unknown> | null => {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    return JSON.parse(m[0]) as Record<string, unknown>
  } catch {
    return null
  }
}

const sendAiAssist = async (): Promise<void> => {
  const conn = active.value
  const instruction = aiAssistInstruction.value.trim()
  if (!instruction) {
    ElMessage.warning('请输入指令')
    return
  }
  if (!conn) return
  const kindLabel = KIND_OPTIONS.find((o) => o.value === conn.kind)?.label ?? conn.kind ?? 'SQL'
  aiAssistRunning.value = true
  try {
    // 第一步：让 AI 判断处理该 SQL 是否需要表结构 / 索引 / 执行计划，并列出涉及的表（JSON 输出，校验失败自动重试）
    const planPrompt =
      `你是数据库专家。当前数据库类型：${kindLabel}` +
      (selectedDb.value ? `，当前数据库/Schema：${selectedDb.value}` : '') +
      `。用户指令：${instruction}\n` +
      `SQL：\n${aiAssistSql.value}\n\n` +
      `判断完成该指令是否需要以下信息，并从 SQL 中提取涉及的表名（不含别名、不含 Schema 前缀）。` +
      `只输出一个 JSON 对象，不要输出任何其他内容，格式：\n` +
      `{"needStructure": true|false, "needIndexes": true|false, "needExplain": true|false, "tables": ["表名1","表名2"]}`
    let needStructure = false
    let needIndexes = false
    let needExplain = false
    let tables: string[] = []
    for (let round = 0; round < 3; round++) {
      const r = await sendLlm(
        [
          {
            role: 'system',
            content: '你是数据库专家，必须只返回严格的 JSON 对象，不能包含任何解释文字。'
          },
          { role: 'user', content: planPrompt }
        ],
        { temperature: 0 }
      )
      const obj = parseAiJson(r.content)
      if (obj && Array.isArray(obj.tables)) {
        needStructure = obj.needStructure === true
        needIndexes = obj.needIndexes === true
        needExplain = obj.needExplain === true
        tables = (obj.tables as unknown[]).map(String).filter(Boolean)
        break
      }
    }
    if (tables.length === 0) {
      // AI 未给出表名时的兜底：正则提取 FROM/JOIN/INTO/UPDATE 后的表名
      const re = /\b(?:FROM|JOIN|INTO|UPDATE)\s+[`"[]?([A-Za-z_][\w$]*)[`"\]]?/gi
      const found = new Set<string>()
      let m: RegExpExecArray | null
      while ((m = re.exec(aiAssistSql.value))) found.add(m[1])
      tables = [...found]
    }

    // 第二步：按需获取表结构 / 索引 / 执行计划（失败不影响后续优化）
    let ctx = ''
    if ((needStructure || needIndexes) && tables.length > 0) {
      const parts: string[] = []
      for (const t of tables.slice(0, 10)) {
        let colText = ''
        let idxText = ''
        try {
          if (needStructure) {
            const cols = (await dbApi.catalog(conn.connId, 'columns', {
              database: selectedDb.value,
              schema: selectedDb.value,
              table: t
            })) as {
              name: string
              dataType: string
              length?: string
              nullable: boolean
              pk: boolean
              comment?: string
            }[]
            colText = cols.length
              ? cols
                  .map(
                    (c) =>
                      `- ${c.name} ${c.dataType.toUpperCase()}${c.length ? `(${c.length})` : ''} ${
                        c.nullable ? 'NULL' : 'NOT NULL'
                      }${c.pk ? ' 主键' : ''}${c.comment ? ` -- ${c.comment}` : ''}`
                  )
                  .join('\n')
              : '（未找到该表字段）'
          }
          if (needIndexes) {
            const idxs = (await dbApi.catalog(conn.connId, 'indexes', {
              database: selectedDb.value,
              schema: selectedDb.value,
              table: t
            })) as {
              name: string
              kind: string
              columns: string
              refTable?: string
              refColumns?: string
            }[]
            idxText = idxs.length
              ? idxs
                  .map(
                    (i) =>
                      `- [${i.kind}] ${i.name}(${i.columns})${
                        i.kind === 'FOREIGN' && i.refTable
                          ? ` 引用 ${i.refTable}(${i.refColumns ?? ''})`
                          : ''
                      }`
                  )
                  .join('\n')
              : '（无索引/约束）'
          }
        } catch (e) {
          idxText = `（元数据获取失败：${(e as Error).message}）`
        }
        parts.push(`■ 表 ${t}\n${colText}\n${idxText}`)
      }
      ctx += `\n\n【相关表元数据】\n${parts.join('\n\n')}`
    }
    if (needExplain) {
      ctx += `\n\n【执行计划】\n${await fetchExplainPlan(aiAssistSql.value)}`
    }

    // 第三步：携带上下文执行主任务
    const r = await sendLlm(
      [
        {
          role: 'system',
          content:
            `你是资深数据库专家（DBA）。当前数据库类型：${kindLabel}` +
            (selectedDb.value ? `，当前数据库/Schema：${selectedDb.value}` : '') +
            `。请根据用户指令对给出的 SQL 进行处理（如优化、分析、改写、解释等）。` +
            (ctx ? `回答时可参考给出的表结构/索引/执行计划等元数据。` : ``) +
            `用中文回答，思路简洁分点。` +
            `如给出修改后的 SQL，必须用 \`\`\`sql 代码块包裹，并遵守：\n` +
            `1. 在 SQL 中对应位置用注释（--）标注优化点，说明此处做了什么优化；\n` +
            `2. 无法在该 SQL 上优化的问题（如缺少索引、需要改表结构、需要业务侧配合等），` +
            `必须在 SQL 最上方用块注释（/* ... */）说明原因和建议。`
        },
        {
          role: 'user',
          content: `指令：${instruction}\n\nSQL：\n${aiAssistSql.value}${ctx}`
        }
      ],
      { temperature: 0.3 }
    )
    aiAssistResult.value = r.content
  } catch (e) {
    ElMessage.error(`AI 助手失败：${(e as Error).message}`)
  } finally {
    aiAssistRunning.value = false
  }
}

/** 提取结果中的 sql 代码块（无代码块时返回 null） */
const extractAiSql = (): string | null => {
  const fence = /```sql\s*([\s\S]*?)```/i.exec(aiAssistResult.value)
  return fence ? fence[1].trim() : null
}

/** 将 AI 返回的 SQL 应用回查询窗口（替换原选区或整个内容） */
const applyAiResult = (): void => {
  const sql = extractAiSql()
  if (!sql) {
    ElMessage.warning('AI 结果中没有 SQL 代码块')
    return
  }
  const tab = activeQueryTab.value
  const el = sqlInputRef.value
  if (!tab || !el) return
  if (aiAssistSel.value) {
    const { start, end } = aiAssistSel.value
    tab.sql = tab.sql.slice(0, start) + sql + tab.sql.slice(end)
    aiAssistSel.value = null
  } else {
    tab.sql = sql
  }
  aiAssistVisible.value = false
  ElMessage.success('已应用到查询窗口')
}

// ==================== 结果区：通用 ====================

const resultTabs = ref<ResultTab[]>([])
const activeResultId = ref('')
const resultsVisible = computed(() => resultTabs.value.length > 0)

const activeTab = computed(() => resultTabs.value.find((t) => t.id === activeResultId.value))

const formatCell = (v: unknown): string => {
  if (v === null || v === undefined) return 'NULL'
  if (v instanceof Date) return formatDateTime(v)
  if (typeof v === 'object') {
    if (v instanceof Uint8Array || (v as { type?: string }).type === 'Buffer') return '[二进制]'
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return String(v)
}

const formatDateTime = (d: Date): string => {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`
}

/** 显示用行（打上 __rid） */
interface DisplayRow {
  rid: string
  isNew: boolean
  isDeleted: boolean
  values: Record<string, unknown>
}

const buildDisplayRows = (tab: ResultTab): DisplayRow[] => {
  const out: DisplayRow[] = []
  tab.rows.forEach((row, i) => {
    const rid = `r${i}`
    out.push({ rid, isNew: false, isDeleted: tab.deleted.includes(rid), values: row })
  })
  if (tab.newRowRid) {
    out.unshift({ rid: tab.newRowRid, isNew: true, isDeleted: false, values: {} })
  }
  return out
}

const pagedRows = computed(() => {
  const tab = activeTab.value
  if (!tab) return []
  const all = buildDisplayRows(tab)
  if (tab.serverPaged) return all
  const start = (tab.page - 1) * tab.pageSize
  return all.slice(start, start + tab.pageSize)
})

const displayTotal = computed(() => {
  const tab = activeTab.value
  if (!tab) return 0
  if (tab.serverPaged) return tab.total
  return buildDisplayRows(tab).length
})

const cellDisplay = (tab: ResultTab, row: DisplayRow, col: string): string => {
  const editedVal = tab.edited[row.rid]?.[col]
  if (editedVal !== undefined) return editedVal
  return formatCell(row.values[col])
}

// ==================== 结果区：单元格编辑 ====================

const parseInputValue = (text: string, col: ColumnInfo): unknown => {
  if (text === '') return null
  if (/int|float|double|decimal|number|numeric|real|serial/i.test(col.dataType)) {
    const n = Number(text)
    if (!Number.isNaN(n)) return n
  }
  return text
}

const tabEditable = (tab: ResultTab): boolean =>
  !!tab.tableCtx && tab.columnsInfo.some((c) => c.pk) && !tab.error

/** 编辑/增删按钮不可用时的原因提示（可用时返回空串） */
const editDisabledTip = (tab: ResultTab): string => {
  if (tab.error) return '执行出错的结果不可编辑'
  if (!tab.tableCtx)
    return '未定位到目标表（仅支持无 JOIN / WHERE 的 SELECT * 单表查询，可双击左侧表名打开）'
  if (!tab.columnsInfo.length)
    return tab.ctxError ? `表结构加载失败：${tab.ctxError}` : '表结构加载中…'
  if (!tab.columnsInfo.some((c) => c.pk)) return '目标表没有主键，无法定位行进行编辑'
  return ''
}

/** 切换结果 tab 的编辑状态（启用后：新增/删除/双击修改/提交/撤销） */
const toggleEdit = (tab: ResultTab): void => {
  tab.editEnabled = !tab.editEnabled
  if (!tab.editEnabled) {
    // 关闭编辑时丢弃未提交的修改
    tab.edited = {}
    tab.deleted = []
    tab.newRowRid = null
    tab.editingCell = null
  }
}

const onCellDblclick = (tab: ResultTab, row: DisplayRow, col: string): void => {
  if (!tab.editEnabled || !tabEditable(tab)) return
  if (row.isDeleted) return
  tab.selectedRid = row.rid
  tab.editingCell = { rid: row.rid, col }
  tab.editingValue = cellDisplay(tab, row, col) === 'NULL' ? '' : cellDisplay(tab, row, col)
  void nextTick(() => {
    const el = document.querySelector('.cell-editor input') as HTMLInputElement | null
    el?.focus()
  })
}

const commitCellEdit = (tab: ResultTab): void => {
  if (!tab.editingCell) return
  const { rid, col } = tab.editingCell
  if (!tab.edited[rid]) tab.edited[rid] = {}
  if (tab.editingValue === '' && !tab.edited[rid][col]) {
    // 空值：记录为空字符串（提交时按 NULL 处理）
  }
  tab.edited[rid][col] = tab.editingValue
  tab.editingCell = null
}

const cancelCellEdit = (tab: ResultTab): void => {
  tab.editingCell = null
}

const onEditorKeydown = (tab: ResultTab, e: KeyboardEvent): void => {
  if (e.key === 'Enter') {
    e.preventDefault()
    commitCellEdit(tab)
  } else if (e.key === 'Escape') {
    cancelCellEdit(tab)
  }
}

// ==================== 结果区：页脚操作 ====================

const addRow = (tab: ResultTab): void => {
  if (!tabEditable(tab)) {
    ElMessage.warning('当前结果无法编辑（未定位到带主键的单表）')
    return
  }
  if (tab.newRowRid) {
    ElMessage.info('已有未提交的新增行')
    return
  }
  tab.newRowRid = `new_${Date.now()}`
  tab.edited[tab.newRowRid] = {}
  tab.selectedRid = tab.newRowRid
  tab.page = 1
}

const removeRow = (tab: ResultTab): void => {
  if (!tabEditable(tab)) {
    ElMessage.warning('当前结果无法编辑（未定位到带主键的单表）')
    return
  }
  if (!tab.selectedRid) {
    ElMessage.warning('请先点击选中一行')
    return
  }
  if (tab.selectedRid === tab.newRowRid) {
    tab.newRowRid = null
    delete tab.edited[tab.selectedRid]
    tab.selectedRid = null
    return
  }
  if (!tab.deleted.includes(tab.selectedRid)) tab.deleted.push(tab.selectedRid)
}

const applyChanges = async (tab: ResultTab): Promise<void> => {
  const conn = active.value
  if (!conn || !tab.tableCtx || !tabEditable(tab)) return
  const ctx = tab.tableCtx
  const pkCols = tab.columnsInfo.filter((c) => c.pk)
  const colInfo = (name: string): ColumnInfo =>
    tab.columnsInfo.find((c) => c.name === name) ?? {
      name,
      dataType: '',
      nullable: true,
      pk: false
    }
  try {
    // 1. 新增行
    if (tab.newRowRid) {
      const vals = tab.edited[tab.newRowRid] ?? {}
      const changes = Object.entries(vals)
        .filter(([, v]) => v !== '')
        .map(([name, v]) => ({ name, value: parseInputValue(v, colInfo(name)) }))
      await dbApi.modify({
        connId: conn.connId,
        database: ctx.database,
        schema: ctx.schema,
        table: ctx.table,
        action: 'insert',
        primaryKey: [],
        changes
      })
    }
    // 2. 更新行
    for (const [rid, changes0] of Object.entries(tab.edited)) {
      if (rid === tab.newRowRid) continue
      const row = tab.rows[Number(rid.slice(1))]
      if (!row) continue
      const changes = Object.entries(changes0)
        .filter(([name, v]) => formatCell(row[name]) !== v)
        .map(([name, v]) => ({ name, value: parseInputValue(v, colInfo(name)) }))
      if (!changes.length) continue
      await dbApi.modify({
        connId: conn.connId,
        database: ctx.database,
        schema: ctx.schema,
        table: ctx.table,
        action: 'update',
        primaryKey: pkCols.map((c) => ({ name: c.name, value: row[c.name] })),
        changes
      })
    }
    // 3. 删除行
    for (const rid of tab.deleted) {
      const row = tab.rows[Number(rid.slice(1))]
      if (!row) continue
      await dbApi.modify({
        connId: conn.connId,
        database: ctx.database,
        schema: ctx.schema,
        table: ctx.table,
        action: 'delete',
        primaryKey: pkCols.map((c) => ({ name: c.name, value: row[c.name] })),
        changes: []
      })
    }
    ElMessage.success('修改已保存')
    // 重新执行原 SQL 刷新
    await executeStatements([{ sql: tab.sql, tableCtx: ctx }])
  } catch (e) {
    ElMessage.error(`保存失败：${(e as Error).message}`)
  }
}

const discardChanges = (tab: ResultTab): void => {
  tab.edited = {}
  tab.deleted = []
  tab.newRowRid = null
  tab.editingCell = null
  ElMessage.info('已撤销未保存的修改')
}

/** 关闭单个查询结果 tab */
const closeResultTab = (tab: ResultTab): void => {
  const idx = resultTabs.value.findIndex((t) => t.id === tab.id)
  if (idx < 0) return
  resultTabs.value.splice(idx, 1)
  if (activeResultId.value === tab.id) {
    activeResultId.value = resultTabs.value[Math.min(idx, resultTabs.value.length - 1)]?.id ?? ''
  }
}

// ==================== 结果区：导出 / 数据分析 ====================

const exportCsv = (tab: ResultTab): void => {
  if (!tab.columns.length) {
    ElMessage.warning('当前结果无可导出数据')
    return
  }
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [tab.columns.join(',')]
  for (const row of tab.rows) {
    lines.push(tab.columns.map((c) => esc(row[c])).join(','))
  }
  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `query_${Date.now()}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

interface StatRow {
  col: string
  nonNull: number
  nullCount: number
  distinct: number
  min: string
  max: string
}

const analysisRows = (tab: ResultTab): StatRow[] => {
  return tab.columns.map((col) => {
    let nonNull = 0
    let nullCount = 0
    const set = new Set<string>()
    let min = ''
    let max = ''
    for (const row of tab.rows) {
      const v = row[col]
      if (v === null || v === undefined) {
        nullCount++
        continue
      }
      nonNull++
      const s = formatCell(v)
      set.add(s)
      if (!min || s < min) min = s
      if (!max || s > max) max = s
    }
    return { col, nonNull, nullCount, distinct: set.size, min, max }
  })
}

// ==================== 顶栏动作 ====================

const kindLabel = (kind: DbKind): string =>
  KIND_OPTIONS.find((o) => o.value === kind)?.label ?? kind

const onConnCommand = (cmd: string): void => {
  if (cmd === 'create') {
    openCreate()
    return
  }
  const id = cmd.slice('conn:'.length)
  const c = conns.value.find((x) => x.id === id)
  if (c) void doConnect(c)
}

const onActiveConnCommand = (cmd: string): void => {
  if (cmd === 'off') void disconnect()
  else if (cmd === 're' && active.value) void doConnect(active.value.config)
}

// ==================== 导入 SQL 脚本 ====================

interface ScriptLogEntry {
  index: number
  sql: string
  ok: boolean
  elapsed: number
  message: string
  time: string
}

const scriptOpen = ref(false)
const scriptRunning = ref(false)
const scriptName = ref('')
const scriptLogs = ref<ScriptLogEntry[]>([])
const fileInputRef = ref<HTMLInputElement | null>(null)

const importScript = (): void => {
  if (!active.value) {
    ElMessage.warning('请先连接数据库')
    return
  }
  fileInputRef.value?.click()
}

const openScriptTab = (): void => {
  editorMode.value = 'script'
}

const onFileChosen = async (e: Event): Promise<void> => {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const conn = active.value
  if (!conn) return
  const text = await file.text()
  const stmts = splitStatements(text)
  if (!stmts.length) {
    ElMessage.warning('脚本中未解析到可执行的 SQL')
    return
  }
  scriptName.value = file.name
  scriptLogs.value = []
  scriptOpen.value = true
  editorMode.value = 'script'
  scriptRunning.value = true
  running.value = true
  const queryId = `q_${Date.now()}_script`
  runningQueryId.value = queryId
  let ok = 0
  let fail = 0
  try {
    for (let i = 0; i < stmts.length; i++) {
      const sql = stmts[i]
      const started = Date.now()
      try {
        const r = await dbApi.query(conn.connId, sql, queryId)
        ok++
        scriptLogs.value.push({
          index: i + 1,
          sql,
          ok: true,
          elapsed: Date.now() - started,
          message: r.columns.length ? `查询返回 ${r.rows.length} 行` : `影响 ${r.affectedRows} 行`,
          time: formatDateTime(new Date())
        })
      } catch (err) {
        fail++
        scriptLogs.value.push({
          index: i + 1,
          sql,
          ok: false,
          elapsed: Date.now() - started,
          message: (err as Error).message,
          time: formatDateTime(new Date())
        })
      }
    }
  } finally {
    scriptRunning.value = false
    running.value = false
    runningQueryId.value = ''
  }
  ElMessage.success(`脚本执行完成：成功 ${ok} 条，失败 ${fail} 条`)
}

// ==================== 拖拽分隔条 ====================

const upperPct = ref(100)
const mainRef = ref<HTMLElement | null>(null)

let dragging = false
const onSplitMousedown = (e: MouseEvent): void => {
  e.preventDefault()
  dragging = true
  window.addEventListener('mousemove', onSplitMousemove)
  window.addEventListener('mouseup', onSplitMouseup)
}
const onSplitMousemove = (e: MouseEvent): void => {
  if (!dragging || !mainRef.value) return
  const rect = mainRef.value.getBoundingClientRect()
  const pct = ((e.clientY - rect.top) / rect.height) * 100
  upperPct.value = Math.min(Math.max(pct, 15), 85)
}
const onSplitMouseup = (): void => {
  dragging = false
  window.removeEventListener('mousemove', onSplitMousemove)
  window.removeEventListener('mouseup', onSplitMouseup)
}

// ==================== 生命周期 ====================

onMounted(() => {
  loadShortcuts()
  void loadConns()
})

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onSplitMousemove)
  window.removeEventListener('mouseup', onSplitMouseup)
})
</script>

<template>
  <div class="db-page">
    <!-- 顶栏 -->
    <header class="db-header">
      <div class="db-header-left">
        <div class="db-header-badge">
          <img :src="dbSvg" alt="数据库" class="db-header-icon" />
        </div>
        <span class="db-header-title">数据库</span>
        <el-divider direction="vertical" />
        <!-- 当前连接操作：断开 / 重连 -->
        <template v-if="active">
          <el-dropdown trigger="click" @command="onActiveConnCommand">
            <el-tag type="success" effect="plain" size="small" class="conn-tag clickable">
              {{ active.config.name }}
              <span v-if="active.currentDatabase"> · {{ active.currentDatabase }}</span>
              <span v-if="active.currentSchema"> · {{ active.currentSchema }}</span>
            </el-tag>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="re">重新连接</el-dropdown-item>
                <el-dropdown-item command="off">断开连接</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>
        <!-- 连接下拉：点击连接数据库，底部新建连接 -->
        <el-dropdown trigger="click" @command="onConnCommand">
          <span class="header-tool" :class="{ linked: !!active }">
            <img :src="lianjieSvg" alt="连接" class="tool-icon" />
            <span>{{ active ? active.config.name : '连接' }}</span>
            <el-icon class="tool-caret"><CaretBottom /></el-icon>
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="c in conns"
                :key="c.id"
                :command="`conn:${c.id}`"
                :class="{ current: active?.config.id === c.id }"
              >
                <div class="conn-row">
                  <span class="conn-line">
                    <span class="conn-name">{{ c.name }}</span>
                    <small class="conn-kind">{{ kindLabel(c.kind) }}</small>
                    <em v-if="active?.config.id === c.id" class="conn-now">当前</em>
                  </span>
                  <span class="conn-ops">
                    <el-icon class="op edit" title="编辑" @click.stop="openEdit(c)"
                      ><Edit
                    /></el-icon>
                    <el-icon class="op del" title="删除" @click.stop="removeConn(c)"
                      ><Delete
                    /></el-icon>
                  </span>
                </div>
              </el-dropdown-item>
              <el-dropdown-item v-if="!conns.length" disabled>暂无已保存的连接</el-dropdown-item>
              <el-dropdown-item divided command="create">
                <span class="conn-create">＋ 新建连接</span>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <!-- 新建查询 -->
        <span class="header-tool" @click="newQuery">
          <img :src="sqlAddSvg" alt="新建查询" class="tool-icon" />
          <span>新建查询</span>
        </span>
        <!-- 导入 SQL 脚本 -->
        <el-divider direction="vertical" />
        <span class="header-tool" :class="{ running: scriptRunning }" @click="importScript">
          <img :src="sqlExeSvg" alt="导入 SQL 脚本" class="tool-icon" />
          <span>导入 SQL 脚本</span>
        </span>
        <!-- 快捷方式配置 -->
        <el-divider direction="vertical" />
        <span class="header-tool" @click="openShortcuts">
          <img :src="kuaijieSvg" alt="快捷方式" class="tool-icon" />
          <span>快捷方式</span>
        </span>
        <input
          ref="fileInputRef"
          type="file"
          accept=".sql,.txt"
          style="display: none"
          @change="onFileChosen"
        />
      </div>
    </header>

    <div class="db-container">
      <!-- 左侧：数据库对象树 -->
      <aside class="db-sidebar">
        <template v-if="active">
          <div class="side-title">
            <el-icon><Grid /></el-icon>
            <span>{{ selectedDb || '数据库对象' }}</span>
            <el-button link class="tree-refresh" title="刷新" @click="rebuildTree">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
          <el-tree
            :data="treeData"
            :props="treeProps"
            node-key="id"
            highlight-current
            :expand-on-click-node="true"
            class="db-tree"
            @node-click="onNodeClick"
            @node-dblclick="onNodeDblclick"
          />
        </template>
        <el-empty
          v-else
          description="请先新建或选择一个数据库连接"
          :image-size="60"
          class="side-empty"
        />
      </aside>

      <!-- 主区域 -->
      <main ref="mainRef" class="db-main">
        <template v-if="!active">
          <el-empty description="请先新建或选择一个数据库连接" class="main-empty">
            <el-button type="primary" :icon="Connection" @click="openCreate">新建连接</el-button>
          </el-empty>
        </template>

        <template v-else>
          <div class="main-body" :class="{ split: resultsVisible }">
            <!-- 上半：SQL 窗口 / 表结构 / 脚本日志（共享 tab 条） -->
            <div class="upper-zone" :style="{ height: resultsVisible ? `${upperPct}%` : '100%' }">
              <!-- 查询 / 结构 / 脚本 tab 条 -->
              <div
                v-if="queryTabs.length || scriptOpen || structureOpen"
                class="query-tab-bar top-strip"
              >
                <span
                  v-for="qt in queryTabs"
                  :key="qt.id"
                  class="query-tab"
                  :class="{ active: editorMode === 'sql' && qt.id === activeQueryId }"
                  @click="
                    () => {
                      activeQueryId = qt.id
                      activateQueryTab()
                    }
                  "
                >
                  {{ qt.title }}
                  <el-icon class="qt-close" @click.stop="closeQueryTab(qt.id)"><Close /></el-icon>
                </span>
                <span
                  v-if="scriptOpen"
                  class="query-tab script-tab"
                  :class="{ active: editorMode === 'script' }"
                  @click="openScriptTab"
                >
                  📜 {{ scriptName || '脚本日志' }}
                  <el-icon class="qt-close" @click.stop="scriptOpen = false"><Close /></el-icon>
                </span>
                <span
                  v-if="structureOpen && structure"
                  class="query-tab structure-tab"
                  :class="{ active: editorMode === 'structure' }"
                  @click="openStructureTab"
                >
                  📊 {{ structure.table }}
                  <el-icon class="qt-close" @click.stop="closeStructureTab"><Close /></el-icon>
                </span>
                <span
                  v-if="sequenceOpen && sequenceInfo"
                  class="query-tab structure-tab"
                  :class="{ active: editorMode === 'sequence' }"
                  @click="openSequenceTab"
                >
                  📈 {{ sequenceInfo.name }}
                  <el-icon class="qt-close" @click.stop="closeSequenceTab"><Close /></el-icon>
                </span>
              </div>

              <!-- 表结构视图 -->
              <div
                v-if="editorMode === 'structure' && structure"
                class="structure-pane"
                tabindex="-1"
                @mousedown="onPaneMousedown"
                @keydown="onStructPaneKeydown"
              >
                <div class="structure-head">
                  <el-tag size="small" type="info">{{ structure.isView ? '视图' : '表' }}</el-tag>
                  <strong>{{
                    [structure.database, structure.schema, structure.table]
                      .filter(Boolean)
                      .join('.')
                  }}</strong>
                  <span class="col-count">{{ structure.columns.length }} 字段</span>
                  <span class="struct-head-actions">
                    <template v-if="!structEditing">
                      <el-tooltip
                        :content="structEditTip"
                        :disabled="!structEditTip"
                        placement="top"
                      >
                        <span>
                          <el-button
                            size="small"
                            type="primary"
                            plain
                            :icon="EditPen"
                            :disabled="!structEditable || structure.loading"
                            @click="startStructEdit"
                          >
                            编辑结构
                          </el-button>
                        </span>
                      </el-tooltip>
                    </template>
                    <template v-else>
                      <el-button
                        size="small"
                        type="success"
                        :icon="Check"
                        :loading="structSaving"
                        :disabled="!hasStructChange"
                        @click="saveStructEdit"
                      >
                        保存
                      </el-button>
                      <el-button
                        size="small"
                        :icon="Close"
                        :disabled="structSaving"
                        @click="cancelStructEdit"
                      >
                        取消
                      </el-button>
                    </template>
                  </span>
                </div>
                <!-- 子页切换：字段 / 索引 / 外键 / 唯一键 -->
                <div class="struct-subtabs">
                  <span
                    v-for="st in structSubTabs"
                    :key="st.key"
                    class="struct-subtab"
                    :class="{ active: structSubTab === st.key }"
                    @click="structSubTab = st.key"
                  >
                    {{
                      st.key === 'fields'
                        ? `字段 ${structure.columns.length}`
                        : st.key === 'indexes'
                          ? `索引 ${structIndexRows.length}`
                          : st.key === 'fks'
                            ? `外键 ${structFkRows.length}`
                            : `唯一键 ${structUkRows.length}`
                    }}
                  </span>
                </div>
                <el-table
                  v-if="structSubTab === 'fields'"
                  v-loading="structure.loading"
                  :data="structure.columns"
                  border
                  stripe
                  height="100%"
                  size="small"
                  class="data-table"
                >
                  <el-table-column type="index" label="#" width="56" fixed="left" />
                  <el-table-column prop="name" label="字段名" min-width="160" show-overflow-tooltip>
                    <template #default="{ row }">
                      <span v-if="!structEditing" class="col-head">
                        <em v-if="row.pk" class="pk-flag" title="主键">🔑</em>
                        {{ row.name }}
                      </span>
                      <el-input
                        v-else
                        v-model="structDrafts[row.name].name"
                        size="small"
                        :disabled="row.pk"
                        placeholder="字段名"
                      />
                    </template>
                  </el-table-column>
                  <el-table-column prop="dataType" label="类型" width="180">
                    <template #default="{ row }">
                      <span v-if="!structEditing">{{ row.dataType.toUpperCase() }}</span>
                      <el-select
                        v-else
                        v-model="structDrafts[row.name].dataType"
                        size="small"
                        filterable
                        allow-create
                        default-first-option
                        placeholder="类型（可输入）"
                        @change="(v: string) => onStructTypeChange(row, v)"
                      >
                        <el-option v-for="t in dialectTypes" :key="t" :label="t" :value="t" />
                      </el-select>
                    </template>
                  </el-table-column>
                  <el-table-column prop="length" label="长度" width="100">
                    <template #default="{ row }">
                      <span v-if="!structEditing">{{
                        row.length || typeLength(row.dataType) || '-'
                      }}</span>
                      <el-input
                        v-else
                        v-model="structDrafts[row.name].length"
                        size="small"
                        placeholder="如 50 或 10,2"
                        @input="(v: string) => onStructLengthInput(row, v)"
                      />
                    </template>
                  </el-table-column>
                  <el-table-column prop="nullable" label="可空" width="80">
                    <template #default="{ row }">
                      <span v-if="!structEditing">{{ row.nullable ? '是' : '否' }}</span>
                      <el-switch
                        v-else
                        v-model="structDrafts[row.name].nullable"
                        active-text="是"
                        inactive-text="否"
                      />
                    </template>
                  </el-table-column>
                  <el-table-column
                    prop="comment"
                    label="注释"
                    min-width="180"
                    show-overflow-tooltip
                  >
                    <template #default="{ row }">
                      <span v-if="!structEditing">{{ row.comment || '-' }}</span>
                      <el-input
                        v-else
                        v-model="structDrafts[row.name].comment"
                        size="small"
                        placeholder="注释"
                      />
                    </template>
                  </el-table-column>
                  <template #empty>暂无字段</template>
                </el-table>
                <!-- 索引列表 -->
                <el-table
                  v-else-if="structSubTab === 'indexes'"
                  v-loading="structure.loading"
                  :data="structIndexRows"
                  border
                  stripe
                  height="100%"
                  size="small"
                  class="data-table"
                >
                  <el-table-column type="index" label="#" width="56" />
                  <el-table-column
                    prop="name"
                    label="索引名"
                    min-width="200"
                    show-overflow-tooltip
                  />
                  <el-table-column
                    prop="columns"
                    label="字段"
                    min-width="240"
                    show-overflow-tooltip
                  >
                    <template #default="{ row }">
                      <span class="idx-cols">{{ row.columns }}</span>
                    </template>
                  </el-table-column>
                  <template #empty>暂无索引</template>
                </el-table>
                <!-- 外键列表 -->
                <el-table
                  v-else-if="structSubTab === 'fks'"
                  v-loading="structure.loading"
                  :data="structFkRows"
                  border
                  stripe
                  height="100%"
                  size="small"
                  class="data-table"
                >
                  <el-table-column type="index" label="#" width="56" />
                  <el-table-column
                    prop="name"
                    label="外键名"
                    min-width="200"
                    show-overflow-tooltip
                  />
                  <el-table-column
                    prop="columns"
                    label="本表字段"
                    min-width="180"
                    show-overflow-tooltip
                  >
                    <template #default="{ row }">
                      <span class="idx-cols">{{ row.columns }}</span>
                    </template>
                  </el-table-column>
                  <el-table-column
                    prop="refTable"
                    label="引用表"
                    min-width="160"
                    show-overflow-tooltip
                  />
                  <el-table-column
                    prop="refColumns"
                    label="引用字段"
                    min-width="180"
                    show-overflow-tooltip
                  >
                    <template #default="{ row }">
                      <span class="idx-cols">{{ row.refColumns || '-' }}</span>
                    </template>
                  </el-table-column>
                  <template #empty>暂无外键</template>
                </el-table>
                <!-- 唯一键列表 -->
                <el-table
                  v-else
                  v-loading="structure.loading"
                  :data="structUkRows"
                  border
                  stripe
                  height="100%"
                  size="small"
                  class="data-table"
                >
                  <el-table-column type="index" label="#" width="56" />
                  <el-table-column
                    prop="name"
                    label="唯一键名"
                    min-width="200"
                    show-overflow-tooltip
                  />
                  <el-table-column
                    prop="columns"
                    label="字段"
                    min-width="240"
                    show-overflow-tooltip
                  >
                    <template #default="{ row }">
                      <span class="idx-cols">{{ row.columns }}</span>
                    </template>
                  </el-table-column>
                  <template #empty>暂无唯一键</template>
                </el-table>
              </div>

              <!-- 序列信息视图（类似表结构 tab，仅展示序列属性） -->
              <div v-if="editorMode === 'sequence' && sequenceInfo" class="structure-pane">
                <div class="structure-head">
                  <el-tag size="small" type="info">序列</el-tag>
                  <strong>{{
                    [sequenceInfo.database, sequenceInfo.schema, sequenceInfo.name]
                      .filter(Boolean)
                      .join('.')
                  }}</strong>
                </div>
                <el-table
                  v-loading="sequenceInfo.loading"
                  :data="sequenceInfo.rows"
                  border
                  stripe
                  height="100%"
                  size="small"
                  class="data-table"
                >
                  <el-table-column
                    v-for="c in sequenceInfo.columns"
                    :key="c"
                    :prop="c"
                    :label="c"
                    min-width="140"
                    show-overflow-tooltip
                  />
                  <template #empty>暂无序列信息</template>
                </el-table>
              </div>

              <!-- SQL 编辑器（多查询窗口 tab，每个 tab 内含功能头） -->
              <div v-show="editorMode === 'sql' && queryTabs.length" class="sql-pane">
                <div class="sql-toolbar">
                  <el-select
                    :model-value="activeQueryTab?.database || selectedDb"
                    size="small"
                    class="db-select"
                    filterable
                    placeholder="选择数据库"
                    @update:model-value="onTabDbChange"
                  >
                    <el-option v-for="d in dbOptions" :key="d" :label="d" :value="d" />
                  </el-select>
                  <el-button size="small" :icon="MagicStick" @click="beautifySql"
                    >SQL 美化</el-button
                  >
                  <el-button size="small" :icon="DataLine" :disabled="running" @click="explainSql">
                    解释计划
                  </el-button>
                  <el-button size="small" class="ai-assist-btn" @click="openAiAssist">
                    <img :src="aiChatSvg" alt="AI" class="tool-icon" style="margin-right: 4px" />
                    AI 助手
                  </el-button>
                  <el-button
                    size="small"
                    :type="running ? 'warning' : 'primary'"
                    :icon="running ? VideoPause : VideoPlay"
                    @click="running ? stopSql() : runSql()"
                  >
                    {{ running ? '停止' : '执行' }}
                  </el-button>
                  <el-button size="small" type="success" class="save-btn" @click="saveQuery">
                    <img
                      :src="saveWhiteSvg"
                      alt="保存"
                      class="tool-icon"
                      style="margin-right: 4px"
                    />
                    保存
                  </el-button>
                </div>
                <div class="sql-input-wrap">
                  <textarea
                    v-if="activeQueryTab"
                    ref="sqlInputRef"
                    v-model="activeQueryTab.sql"
                    spellcheck="false"
                    placeholder="输入 SQL，Ctrl + Enter 执行；选中部分语句则只执行选中内容"
                    class="sql-input"
                    @input="onSqlInput"
                    @scroll="completionVisible = false"
                    @blur="completionVisible = false"
                    @keydown="onSqlKeydown"
                  ></textarea>
                  <!-- 补全提示弹层 -->
                  <div
                    v-if="completionVisible && completionItems.length"
                    class="sql-completion"
                    :style="{ top: `${completionPos.top + 22}px`, left: `${completionPos.left}px` }"
                  >
                    <div
                      v-for="(item, i) in completionItems"
                      :key="item.label"
                      class="completion-item"
                      :class="{ active: i === completionActive }"
                      :title="item.label"
                      @mousedown.prevent="acceptCompletion(item)"
                    >
                      {{ item.label }}
                    </div>
                  </div>
                </div>
              </div>

              <!-- 无查询窗口时的空状态提示 -->
              <div v-if="editorMode === 'sql' && !queryTabs.length" class="sql-empty">
                点击顶部「新建查询」打开 SQL 窗口
              </div>

              <!-- SQL 脚本执行日志 -->
              <div v-if="editorMode === 'script'" class="script-pane">
                <div class="script-head">
                  <span class="script-title">📜 {{ scriptName }}</span>
                  <el-tag v-if="scriptRunning" type="warning" size="small" effect="plain"
                    >执行中…</el-tag
                  >
                  <template v-else>
                    <el-tag type="success" size="small" effect="plain"
                      >成功 {{ scriptLogs.filter((l) => l.ok).length }}</el-tag
                    >
                    <el-tag
                      v-if="scriptLogs.some((l) => !l.ok)"
                      type="danger"
                      size="small"
                      effect="plain"
                      >失败 {{ scriptLogs.filter((l) => !l.ok).length }}</el-tag
                    >
                  </template>
                  <span class="script-total">共 {{ scriptLogs.length }} 条</span>
                </div>
                <el-table
                  :data="scriptLogs"
                  border
                  stripe
                  height="100%"
                  size="small"
                  class="log-table"
                >
                  <el-table-column prop="index" label="#" width="56" />
                  <el-table-column label="状态" width="76">
                    <template #default="{ row }">
                      <el-tag :type="row.ok ? 'success' : 'danger'" size="small" effect="plain">
                        {{ row.ok ? '成功' : '失败' }}
                      </el-tag>
                    </template>
                  </el-table-column>
                  <el-table-column prop="sql" label="SQL" min-width="280" show-overflow-tooltip />
                  <el-table-column prop="elapsed" label="耗时" width="90">
                    <template #default="{ row }">{{ row.elapsed }} ms</template>
                  </el-table-column>
                  <el-table-column
                    prop="message"
                    label="结果"
                    min-width="160"
                    show-overflow-tooltip
                  />
                  <el-table-column prop="time" label="时间" width="170" />
                  <template #empty>暂无执行记录</template>
                </el-table>
              </div>
            </div>

            <!-- 拖拽分隔条 -->
            <div
              v-if="resultsVisible"
              class="split-bar"
              title="拖动调整高度"
              @mousedown="onSplitMousedown"
            >
              <div class="split-line"></div>
            </div>

            <!-- 下半：查询结果区 -->
            <div v-if="resultsVisible" class="lower-zone" :style="{ height: `${100 - upperPct}%` }">
              <el-tabs v-model="activeResultId" class="result-tabs" type="card">
                <el-tab-pane v-for="tab in resultTabs" :key="tab.id" :name="tab.id">
                  <template #label>
                    <span class="result-tab-label">
                      <span>{{ tab.error ? '❌ ' : '' }}{{ tab.title }}</span>
                      <el-icon class="rt-close" @click.stop="closeResultTab(tab)"
                        ><Close
                      /></el-icon>
                    </span>
                  </template>
                  <div class="result-body">
                    <!-- 头部：数据/信息（左） + 导出/分析/分页（右） -->
                    <div class="result-head">
                      <div class="result-view-tabs">
                        <span
                          class="view-tab"
                          :class="{ active: tab.view === 'data' }"
                          @click="tab.view = 'data'"
                          >数据</span
                        >
                        <span
                          class="view-tab"
                          :class="{ active: tab.view === 'info' }"
                          @click="tab.view = 'info'"
                          >信息</span
                        >
                      </div>
                      <div class="result-tools">
                        <el-button
                          link
                          size="small"
                          :icon="EditPen"
                          :type="tab.editEnabled ? 'success' : ''"
                          :title="
                            tab.editEnabled
                              ? '编辑中，点击关闭并丢弃未提交修改'
                              : editDisabledTip(tab) || '启用后可新增、删除、双击修改'
                          "
                          :disabled="!tab.editEnabled && !!editDisabledTip(tab)"
                          @click="toggleEdit(tab)"
                          >{{ tab.editEnabled ? '编辑中' : '启用编辑' }}</el-button
                        >
                        <el-button
                          link
                          size="small"
                          :icon="Download"
                          :disabled="!tab.rows.length || !!tab.error || !!tab.planText"
                          title="仅查询结果可导出"
                          @click="exportCsv(tab)"
                          >导出</el-button
                        >
                        <el-button
                          link
                          size="small"
                          :icon="TrendCharts"
                          :type="tab.showAnalysis ? 'primary' : ''"
                          :disabled="!tab.rows.length || !!tab.error || !!tab.planText"
                          title="仅查询结果可分析"
                          @click="tab.showAnalysis = !tab.showAnalysis"
                          >数据分析</el-button
                        >
                        <span class="page-size-label">分页</span>
                        <el-select
                          :model-value="tab.pageSize"
                          size="small"
                          style="width: 76px"
                          @update:model-value="(v: number) => changePageSize(tab, v)"
                        >
                          <el-option
                            v-for="n in [10, 20, 50, 100, 200]"
                            :key="n"
                            :label="String(n)"
                            :value="n"
                          />
                        </el-select>
                      </div>
                    </div>

                    <!-- 信息视图 -->
                    <div v-if="tab.view === 'info'" class="info-pane">
                      <template v-if="tab.error">
                        <div class="info-error">执行出错：{{ tab.error }}</div>
                      </template>
                      <template v-else>
                        <div class="info-grid">
                          <div class="info-item">
                            <span class="info-k">执行耗时</span>
                            <span class="info-v">{{ tab.elapsed }} ms</span>
                          </div>
                          <div class="info-item">
                            <span class="info-k">结果行数</span>
                            <span class="info-v">{{
                              tab.serverPaged
                                ? `${tab.total} 行（当前页 ${tab.rows.length} 行）`
                                : tab.columns.length
                                  ? `${tab.rows.length} 行`
                                  : '—'
                            }}</span>
                          </div>
                          <div class="info-item">
                            <span class="info-k">影响行数</span>
                            <span class="info-v">{{ tab.affectedRows }}</span>
                          </div>
                          <div v-if="tab.insertId" class="info-item">
                            <span class="info-k">自增 ID</span>
                            <span class="info-v">{{ tab.insertId }}</span>
                          </div>
                          <div v-if="tab.truncated" class="info-item">
                            <span class="info-k">截断</span>
                            <span class="info-v warn">结果超过 1000 行，已截断</span>
                          </div>
                        </div>
                        <div class="info-sql">
                          <span class="info-k">SQL</span>
                          <pre>{{ tab.sql }}</pre>
                        </div>
                      </template>
                    </div>

                    <!-- 数据分析视图 -->
                    <div v-else-if="tab.showAnalysis" class="analysis-pane">
                      <el-table :data="analysisRows(tab)" border stripe height="100%" size="small">
                        <el-table-column prop="col" label="字段" min-width="140" />
                        <el-table-column prop="nonNull" label="非空" width="90" />
                        <el-table-column prop="nullCount" label="空值" width="90" />
                        <el-table-column prop="distinct" label="去重数" width="90" />
                        <el-table-column
                          prop="min"
                          label="最小值"
                          min-width="120"
                          show-overflow-tooltip
                        />
                        <el-table-column
                          prop="max"
                          label="最大值"
                          min-width="120"
                          show-overflow-tooltip
                        />
                      </el-table>
                    </div>

                    <!-- 解释计划视图 -->
                    <div v-else-if="tab.planText" class="plan-pane">
                      <pre class="plan-text">{{ tab.planText }}</pre>
                    </div>

                    <!-- 数据视图 -->
                    <div
                      v-else
                      class="data-pane"
                      tabindex="-1"
                      @mousedown="onPaneMousedown"
                      @keydown="(e: KeyboardEvent) => onDataPaneKeydown(e, tab)"
                    >
                      <el-table
                        :data="pagedRows"
                        border
                        stripe
                        height="100%"
                        size="small"
                        class="data-table"
                        highlight-current-row
                        :row-key="(r: DisplayRow) => r.rid"
                        :row-class-name="
                          ({ row }: { row: DisplayRow }) =>
                            row.isNew
                              ? 'row-new'
                              : row.isDeleted
                                ? 'row-deleted'
                                : row.rid === tab.selectedRid
                                  ? 'row-selected'
                                  : ''
                        "
                        :cell-class-name="
                          ({ column }: { column: { property: string } }) =>
                            column.property && column.property === tab.selectedCol
                              ? 'col-selected'
                              : ''
                        "
                        @row-click="
                          ({ row }: { row: DisplayRow }) => {
                            tab.selectedRid = row.rid
                            tab.selectedCol = null
                          }
                        "
                        @current-change="
                          (row: DisplayRow | null) => {
                            tab.selectedRid = row ? row.rid : null
                            tab.selectedCol = null
                          }
                        "
                        @header-click="
                          (column: { property: string }) => {
                            tab.selectedCol = column.property || null
                          }
                        "
                      >
                        <el-table-column
                          v-for="col in tab.columns"
                          :key="col"
                          :prop="col"
                          :label="col"
                          :min-width="Math.max(120, col.length * 14 + 40)"
                          show-overflow-tooltip
                        >
                          <template #header>
                            <span class="col-head">
                              <em
                                v-if="tab.columnsInfo.find((c) => c.name === col)?.pk"
                                class="pk-flag"
                                title="主键"
                                >🔑</em
                              >
                              {{ col }}
                            </span>
                          </template>
                          <template #default="{ row }">
                            <span
                              class="cell-value"
                              :class="{
                                null: row.values[col] == null && !tab.edited[row.rid]?.[col],
                                edited: tab.edited[row.rid]?.[col] !== undefined
                              }"
                              @dblclick="onCellDblclick(tab, row, col)"
                            >
                              {{
                                tab.editingCell &&
                                tab.editingCell.rid === row.rid &&
                                tab.editingCell.col === col
                                  ? ''
                                  : cellDisplay(tab, row, col)
                              }}
                            </span>
                            <template
                              v-if="
                                tab.editingCell &&
                                tab.editingCell.rid === row.rid &&
                                tab.editingCell.col === col
                              "
                            >
                              <span class="cell-editor" @keydown="onEditorKeydown(tab, $event)">
                                <el-input
                                  v-model="tab.editingValue"
                                  size="small"
                                  @blur="commitCellEdit(tab)"
                                />
                              </span>
                            </template>
                          </template>
                        </el-table-column>
                        <template #empty>暂无数据</template>
                      </el-table>

                      <!-- 页脚 -->
                      <div class="grid-footer">
                        <el-pagination
                          small
                          background
                          layout="prev, pager, next"
                          :total="displayTotal"
                          :page-size="tab.pageSize"
                          :current-page="tab.page"
                          @current-change="(p: number) => changePage(tab, p)"
                        />
                        <div class="footer-actions">
                          <template v-if="tab.editEnabled && tabEditable(tab)">
                            <el-button
                              link
                              type="success"
                              :icon="Check"
                              title="保存修改"
                              @click="applyChanges(tab)"
                            ></el-button>
                            <el-button
                              link
                              type="danger"
                              :icon="CloseBold"
                              title="撤销修改"
                              @click="discardChanges(tab)"
                            ></el-button>
                            <el-button
                              link
                              type="primary"
                              :icon="Plus"
                              title="新增一行"
                              @click="addRow(tab)"
                            ></el-button>
                            <el-button
                              link
                              type="danger"
                              :icon="Minus"
                              title="删除选中行"
                              @click="removeRow(tab)"
                            ></el-button>
                          </template>
                        </div>
                      </div>
                    </div>
                  </div>
                </el-tab-pane>
              </el-tabs>
            </div>
          </div>
        </template>
      </main>
    </div>

    <!-- 新建/编辑连接对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="dialogMode === 'create' ? '新建数据库连接' : '编辑连接'"
      width="520px"
      :close-on-click-modal="false"
    >
      <el-form label-width="92px" label-position="right" class="conn-form">
        <el-form-item label="AI 识别">
          <div class="ai-paste">
            <el-input
              v-model="aiPasteText"
              type="textarea"
              :rows="2"
              placeholder="粘贴连接 URL / JDBC 串 / 配置文本，AI 自动识别填写"
            />
            <el-button
              type="primary"
              size="small"
              :loading="aiRecognizing"
              class="ai-btn"
              @click="aiRecognize"
              >AI 识别</el-button
            >
          </div>
        </el-form-item>
        <el-form-item label="连接名称">
          <el-input v-model="form.name" placeholder="留空自动生成" />
        </el-form-item>
        <el-form-item label="数据库类型">
          <el-select v-model="form.kind" style="width: 100%" @change="onKindChange">
            <el-option v-for="o in KIND_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="主机">
          <el-input v-model="form.host" placeholder="127.0.0.1" />
        </el-form-item>
        <el-form-item label="端口">
          <el-input-number
            v-model="form.port"
            :min="1"
            :max="65535"
            :controls="false"
            style="width: 140px"
          />
        </el-form-item>
        <el-form-item label="用户名">
          <el-input v-model="form.user" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" type="password" show-password />
        </el-form-item>
        <el-form-item v-if="isOracleKind(form.kind)" label="服务名">
          <el-input v-model="form.serviceName" placeholder="如 ORCL / 租户服务名" />
        </el-form-item>
        <el-form-item v-if="isOracleKind(form.kind)" label="SID">
          <el-input v-model="form.sid" placeholder="服务名与 SID 二选一" />
        </el-form-item>
        <el-form-item v-if="isOracleKind(form.kind)" label="默认 Schema">
          <el-input v-model="form.database" placeholder="可选，连接后默认选中的用户/Schema" />
        </el-form-item>
        <el-form-item v-else :label="KIND_OPTIONS.find((o) => o.value === form.kind)?.dbLabel">
          <el-input v-model="form.database" />
        </el-form-item>
        <el-form-item
          v-if="form.kind === 'mysql' || form.kind === 'pgsql' || form.kind === 'oceanbase-mysql'"
          label="SSL"
        >
          <el-switch v-model="form.ssl" />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button :loading="testing" @click="testConnection">测试连接</el-button>
          <span class="footer-spacer"></span>
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="connecting" @click="saveAndConnect"
            >保存并连接</el-button
          >
        </div>
      </template>
    </el-dialog>

    <!-- SQL AI 助手 -->
    <el-dialog v-model="aiAssistVisible" title="SQL AI 助手" width="640px" append-to-body>
      <div class="ai-assist-body">
        <div class="ai-assist-scope">
          <el-tag size="small" :type="aiAssistSel ? 'warning' : 'info'">
            {{ aiAssistSel ? '选中内容' : '整个查询窗口' }}
          </el-tag>
          <pre class="ai-assist-sql">{{ aiAssistSql }}</pre>
        </div>
        <el-input
          v-model="aiAssistInstruction"
          placeholder="输入指令，如：优化 / 分析执行计划 / 解释这条 SQL / 改写为 JOIN"
        />
        <div v-if="aiAssistResult" class="ai-assist-result">
          <pre class="ai-assist-text">{{ aiAssistResult }}</pre>
        </div>
        <div v-else-if="!aiAssistRunning" class="ai-assist-empty">点击「发送指令」开始</div>
      </div>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="aiAssistVisible = false">关闭</el-button>
          <el-button
            v-if="extractAiSql()"
            type="success"
            title="将结果中的 SQL 替换回查询窗口"
            @click="applyAiResult"
            >应用到查询窗口</el-button
          >
          <el-button type="primary" :loading="aiAssistRunning" @click="sendAiAssist">
            {{ aiAssistRunning ? '思考中…' : '发送指令' }}
          </el-button>
        </div>
      </template>
    </el-dialog>
    <!-- SQL 快捷方式配置 -->
    <el-dialog v-model="shortcutsVisible" title="SQL 快捷方式" width="560px" append-to-body>
      <div class="shortcut-add">
        <el-input
          v-model="shortcutAbbr"
          placeholder="缩写，如 sf"
          style="width: 140px"
          @keyup.enter="addShortcut"
        />
        <el-input
          v-model="shortcutText"
          placeholder="展开内容，如 select * from "
          @keyup.enter="addShortcut"
        />
        <el-button type="primary" @click="addShortcut">添加</el-button>
      </div>
      <div class="shortcut-list">
        <div v-if="!Object.keys(shortcuts).length" class="shortcut-empty">
          暂无快捷方式。添加后，在 SQL 窗口输入缩写时会在提示列表中出现展开内容
        </div>
        <div v-for="(text, abbr) in shortcuts" :key="abbr" class="shortcut-row">
          <code class="shortcut-abbr">{{ abbr }}</code>
          <span class="shortcut-arrow">→</span>
          <span class="shortcut-text">{{ text }}</span>
          <el-button link type="danger" size="small" @click="removeShortcut(String(abbr))"
            >删除</el-button
          >
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.db-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  color: var(--color-text);
}

.db-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 18px;
  background: var(--color-card);
  border-bottom: 1px solid var(--color-border);
  box-shadow: inset 0 -2px 0 0 var(--color-primary);
}

.db-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.db-header-badge {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.db-header-icon {
  width: 24px;
  height: 24px;
}

.db-header-title {
  font-size: 17px;
  font-weight: 700;
}

.conn-tag {
  margin-left: 4px;
  cursor: pointer;
}

.conn-tag.clickable:hover {
  opacity: 0.8;
}

/* 顶栏工具（连接 / 新建查询 / 连接管理） */
.header-tool {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13.5px;
  color: var(--color-text);
  user-select: none;
  transition: background 0.15s;
}

.header-tool:hover {
  background: var(--color-hover);
}

.header-tool.linked {
  color: var(--color-primary);
}

.tool-icon {
  width: 16px;
  height: 16px;
}

.tool-caret {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.conn-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 220px;
}

.conn-kind {
  color: var(--color-text-secondary);
}

.conn-now {
  margin-left: auto;
  font-style: normal;
  font-size: 11px;
  color: var(--el-color-success, #67c23a);
}

.conn-create {
  font-weight: 600;
}

/* 连接管理行：名称 + 编辑/删除小图标 */
.conn-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-width: 220px;
}

.conn-ops {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.conn-ops .op {
  cursor: pointer;
  color: var(--color-text-secondary);
}

.conn-ops .op:hover {
  color: var(--color-primary);
}

.conn-ops .op.del:hover {
  color: var(--el-color-danger, #f56c6c);
}

.db-container {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* 侧边栏 */
.db-sidebar {
  width: 260px;
  min-width: 260px;
  border-right: 1px solid var(--color-border);
  background: var(--color-card);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 10px;
}

.side-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
  padding: 4px 4px 8px;
}

.tree-refresh {
  margin-left: auto;
}

.side-empty {
  margin: auto;
}

.db-tree {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: transparent;
}

.db-tree :deep(.el-tree-node__content) {
  height: 30px;
}

/* 主区域 */
.db-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.main-empty {
  margin: auto;
}

.main-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.upper-zone {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* 表结构 */
.structure-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 8px 14px 4px;
}

.structure-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
  font-size: 13px;
}

/* 表结构子页切换：字段 / 索引 / 外键 / 唯一键 */
.struct-subtabs {
  display: flex;
  gap: 4px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--color-border, #ddd);
}

.struct-subtab {
  padding: 3px 12px;
  font-size: 12px;
  color: var(--color-text-secondary, #666);
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
}

.struct-subtab:hover {
  background: var(--color-bg-hover, rgba(0, 0, 0, 0.04));
  color: var(--color-text, #333);
}

.struct-subtab.active {
  background: var(--el-color-primary-light-9, #ecf5ff);
  color: var(--el-color-primary, #409eff);
  font-weight: 600;
}

.idx-cols {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}

.col-count {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.struct-head-actions {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.back-sql {
  margin-left: auto;
}

/* SQL 编辑器 */
.sql-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 8px 14px;
  gap: 6px;
}

.query-tab-bar {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

/* 独立于 sql-pane 的公共 tab 条 */
.top-strip {
  padding: 8px 14px 0;
}

.top-strip .query-tab {
  border-bottom: 1px solid var(--color-border);
}

/* 查询 tab 内功能头 */
.sql-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.sql-toolbar .save-btn {
  margin-left: auto;
}

/* SQL AI 助手 */
.ai-assist-btn {
  color: var(--color-primary);
}

.ai-assist-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ai-assist-scope {
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 8px;
  max-height: 160px;
  overflow: auto;
  background: var(--color-fill-quiescent, rgba(127, 127, 127, 0.06));
}

.ai-assist-scope .el-tag {
  margin-bottom: 6px;
}

.ai-assist-sql {
  margin: 0;
  font-family: var(--font-mono, Consolas, monospace);
  font-size: 12.5px;
  white-space: pre-wrap;
  word-break: break-all;
}

.ai-assist-result {
  max-height: 320px;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 10px;
}

.ai-assist-text {
  margin: 0;
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
}

.ai-assist-empty {
  text-align: center;
  color: var(--color-text-secondary, #999);
  font-size: 12.5px;
  padding: 12px 0;
}

/* SQL 快捷方式配置 */
.shortcut-add {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.shortcut-list {
  max-height: 300px;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: 6px;
}

.shortcut-empty {
  padding: 16px;
  text-align: center;
  color: var(--color-text-secondary, #999);
  font-size: 12.5px;
}

.shortcut-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--color-border);
  font-size: 13px;
}

.shortcut-row:last-child {
  border-bottom: none;
}

.shortcut-abbr {
  background: rgba(127, 127, 127, 0.12);
  border-radius: 4px;
  padding: 1px 6px;
  font-family: var(--font-mono, Consolas, monospace);
}

.shortcut-arrow {
  color: var(--color-text-secondary, #999);
}

.shortcut-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, Consolas, monospace);
  font-size: 12.5px;
}

/* 结果表格选中行 / 选中列 */
:deep(.row-selected td) {
  background: color-mix(in srgb, var(--color-primary) 12%, transparent) !important;
}

:deep(.col-selected) {
  background: color-mix(in srgb, var(--color-primary) 12%, transparent) !important;
}

.query-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: 12.5px;
  border: 1px solid var(--color-border);
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  cursor: pointer;
  color: var(--color-text-secondary);
  background: var(--color-hover);
}

.query-tab.active {
  background: var(--color-card);
  color: var(--color-text);
  font-weight: 600;
}

.qt-close {
  font-size: 11px;
  border-radius: 50%;
}

.qt-close:hover {
  background: var(--color-border);
  color: var(--el-color-danger, #f56c6c);
}

.sql-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  font-size: 13px;
  border: 1px dashed var(--color-border);
  border-radius: 8px;
}

/* SQL 补全弹层 */
.sql-input-wrap {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
}

.sql-completion {
  position: absolute;
  z-index: 30;
  min-width: 180px;
  max-height: 220px;
  overflow: auto;
  background: var(--color-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
}

.completion-item {
  padding: 4px 12px;
  font-size: 12.5px;
  font-family: Consolas, 'Courier New', monospace;
  cursor: pointer;
  white-space: nowrap;
}

.completion-item.active,
.completion-item:hover {
  background: var(--color-primary);
  color: #fff;
}

/* SQL 脚本执行日志 */
.script-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.script-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  flex-shrink: 0;
}

.script-title {
  font-weight: 600;
}

.script-total {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.log-table {
  flex: 1;
  min-height: 0;
}

.sql-input {
  flex: 1;
  resize: none;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-card);
  color: var(--color-text);
  font-family: Consolas, 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.7;
  padding: 10px 12px;
  outline: none;
}

.sql-input:focus {
  border-color: var(--color-primary);
}

/* 分隔条 */
.split-bar {
  height: 6px;
  cursor: row-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.split-bar:hover .split-line,
.split-line {
  width: 100%;
  height: 1px;
  background: var(--color-border);
}

.split-bar:hover .split-line {
  height: 3px;
  background: var(--color-primary);
}

/* 结果区 */
.lower-zone {
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 4px 14px 10px;
}

.result-tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.result-tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
}

.result-tabs :deep(.el-tab-pane) {
  height: 100%;
}

.result-tab-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}

.result-tab-label .rt-close {
  flex-shrink: 0;
  border-radius: 3px;
  font-size: 12px;
  padding: 1px;
}

.result-tab-label .rt-close:hover {
  background: rgba(127, 127, 127, 0.2);
}

.result-body {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 6px;
}

.result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.result-view-tabs {
  display: flex;
  gap: 2px;
  background: var(--color-hover);
  border-radius: 8px;
  padding: 2px;
}

.view-tab {
  padding: 3px 14px;
  font-size: 12.5px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--color-text-secondary);
}

.view-tab.active {
  background: var(--color-card);
  color: var(--color-text);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}

.result-tools {
  display: flex;
  align-items: center;
  gap: 4px;
}

.page-size-label {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin-left: 8px;
}

/* 信息 */
.info-pane {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px 4px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.info-error {
  color: var(--el-color-danger, #f56c6c);
  font-size: 13px;
  white-space: pre-wrap;
}

.info-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--color-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 8px 14px;
  min-width: 120px;
}

.info-k {
  font-size: 11px;
  color: var(--color-text-secondary);
}

.info-v {
  font-size: 13px;
  font-weight: 600;
}

.info-v.warn {
  color: var(--el-color-warning, #e6a23c);
  font-weight: 400;
}

.info-sql pre {
  margin: 4px 0 0;
  background: var(--color-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 10px 12px;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12.5px;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 表格通用 */
.data-pane,
.analysis-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 解释计划视图 */
.plan-pane {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 12px;
  background: var(--color-fill-quiescent, rgba(127, 127, 127, 0.06));
}

.plan-text {
  margin: 0;
  font-family: var(--font-mono, Consolas, monospace);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre;
}

.data-table {
  flex: 1;
  min-height: 0;
}

/* 结果表表头：加大加粗 */
.data-table :deep(thead th .cell) {
  font-size: 14px;
  font-weight: 700;
}

/* 数据/结构视图可聚焦（Ctrl+A 全选表格内容），去掉焦点轮廓 */
.data-pane,
.structure-pane {
  outline: none;
}

.col-head {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.col-head small {
  color: var(--color-text-secondary);
  font-weight: 400;
}

.pk-flag {
  font-style: normal;
  font-size: 11px;
}

.cell-value {
  /* 占满整个单元格，双击单元格任意位置都能进入编辑（双击文本才触发太难命中） */
  display: block;
  min-height: 100%;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  cursor: default;
}

.cell-value.null {
  color: var(--color-text-secondary);
  font-style: italic;
  opacity: 0.6;
}

.cell-value.edited {
  color: var(--el-color-warning, #e6a23c);
  font-weight: 600;
}

.cell-editor {
  display: inline-block;
  min-width: 120px;
}

:deep(.row-new td) {
  background: color-mix(in srgb, var(--el-color-success, #67c23a) 8%, transparent) !important;
}

:deep(.row-deleted td) {
  text-decoration: line-through;
  opacity: 0.5;
}

/* 页脚 */
.grid-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 6px;
  flex-shrink: 0;
}

.footer-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 功能区头部（SQL 窗口下方） */
.action-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 14px 10px;
  background: var(--color-card);
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
}

.action-left,
.action-right {
  display: flex;
  align-items: center;
  gap: 4px;
}

.db-select {
  width: 200px;
  margin-right: 8px;
}

/* 对话框表单 */
.conn-form :deep(.el-form-item) {
  margin-bottom: 14px;
}

/* AI 识别粘贴区 */
.ai-paste {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-end;
}

.dialog-footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.footer-spacer {
  flex: 1;
}
</style>
