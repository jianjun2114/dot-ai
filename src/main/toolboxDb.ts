/**
 * 百宝箱 - 数据库管理模块
 *
 * 支持的数据库类型：
 * - MySQL / OceanBase（MySQL 租户）：mysql2 驱动
 * - PostgreSQL：pg 驱动
 * - Oracle / OceanBase（Oracle 租户）：oracledb thin 模式（纯 JS，无需 Instant Client）
 *
 * 主进程维护 connId -> 连接实例 的会话表，渲染进程通过 IPC 完成：
 * 连接测试 / 建立连接 / 目录浏览（库、Schema、表、字段）/ SQL 查询 / 分页取数 / 行增删改
 */
import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { createConnection, type Connection as MysqlConnection } from 'mysql2/promise'
import { Client as PgClient } from 'pg'
import oracledb from 'oracledb'

// Oracle CLOB 以字符串返回，避免 Lob 对象无法跨 IPC 传输
// 注意：oracledb 7 的 fetchAsString 不支持 BLOB（仅 CLOB/NCLOB/RAW/JSON/日期等），
// BLOB 在 thin 模式下默认以 Buffer 返回，可直接跨 IPC 传输
oracledb.fetchAsString = [oracledb.CLOB]

/** 数据库类型 */
export type DbKind = 'mysql' | 'oceanbase-mysql' | 'pgsql' | 'oracle' | 'oceanbase-oracle'

/** 连接配置（由渲染进程保存与下发） */
export interface DbConfig {
  kind: DbKind
  host: string
  port: number
  user: string
  password: string
  /** MySQL / PostgreSQL 默认数据库 */
  database?: string
  /** Oracle 服务名 */
  serviceName?: string
  /** Oracle SID（与 serviceName 二选一） */
  sid?: string
  /** 是否启用 SSL（pg / mysql） */
  ssl?: boolean
}

/** 字段元信息 */
export interface DbColumnInfo {
  name: string
  dataType: string
  /** 长度/精度：varchar(50) → 50，number(10,2) → 10,2 */
  length?: string
  nullable: boolean
  pk: boolean
  comment?: string
}

/** 统一查询结果 */
export interface DbQueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
  /** 非查询语句影响行数 */
  affectedRows: number
  insertId?: string
  /** 结果是否被截断（超过 MAX_ROWS） */
  truncated: boolean
}

/** 分页取数结果 */
export interface DbPageResult extends DbQueryResult {
  total: number
}

/** 行编辑动作 */
export type RowAction = 'insert' | 'update' | 'delete'

interface NameValue {
  name: string
  value: unknown
}

/** 单次查询最多返回行数 */
const MAX_ROWS = 1000

/** 数据库会话 */
interface DbSession {
  kind: DbKind
  config: DbConfig
  mysql?: MysqlConnection
  pg?: PgClient
  oracle?: oracledb.Connection
  currentDatabase?: string
  currentSchema?: string
  /** MySQL 线程 ID（用于 KILL QUERY） */
  mysqlThreadId?: number
  /** PG 后端进程 PID（用于 pg_cancel_backend） */
  pgBackendPid?: number
}

const sessions = new Map<string, DbSession>()

/** 正在执行的查询：queryId -> connId，用于取消 */
const runningQueries = new Map<string, string>()

/** 标识符白名单校验（允许中英文、数字、下划线、$、#），防注入 */
const sanitizeIdent = (id: string): string => {
  const s = String(id ?? '').trim()
  if (!s || !/^[A-Za-z0-9_$#\u4e00-\u9fa5.]+$/.test(s)) {
    throw new Error(`非法标识符: ${id}`)
  }
  return s
}

/** 按方言引用标识符 */
const quoteIdent = (kind: DbKind, id: string): string => {
  const s = sanitizeIdent(id)
  if (kind === 'mysql' || kind === 'oceanbase-mysql') {
    return s
      .split('.')
      .map((p) => `\`${p}\``)
      .join('.')
  }
  return s
    .split('.')
    .map((p) => `"${p}"`)
    .join('.')
}

/** 去掉结尾分号（Oracle 驱动不允许尾随分号），仅执行单条语句 */
const normalizeSql = (sql: string): string =>
  sql
    .trim()
    .replace(/;+\s*$/, '')
    .trim()

/** 建立具体驱动连接 */
const openConnection = async (
  config: DbConfig
): Promise<
  Pick<
    DbSession,
    | 'mysql'
    | 'pg'
    | 'oracle'
    | 'currentDatabase'
    | 'currentSchema'
    | 'mysqlThreadId'
    | 'pgBackendPid'
  >
> => {
  switch (config.kind) {
    case 'mysql':
    case 'oceanbase-mysql': {
      const conn = await createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database || undefined,
        charset: 'utf8mb4',
        connectTimeout: 8000,
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined
      })
      const [rows] = await conn.query('SELECT DATABASE() AS db')
      const threadId = (conn as unknown as { connection?: { threadId?: number } }).connection
        ?.threadId
      return {
        mysql: conn,
        currentDatabase: (rows as Array<{ db: string | null }>)[0]?.db || undefined,
        mysqlThreadId: threadId
      }
    }
    case 'pgsql': {
      const client = new PgClient({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database || undefined,
        connectionTimeoutMillis: 8000,
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined
      })
      await client.connect()
      const pidR = await client.query('SELECT pg_backend_pid() AS pid')
      return {
        pg: client,
        currentDatabase: client.database || config.database,
        pgBackendPid: Number((pidR.rows[0] as { pid: number })?.pid)
      }
    }
    case 'oracle':
    case 'oceanbase-oracle': {
      let connectString = `${config.host}:${config.port}`
      if (config.serviceName) connectString += `/${config.serviceName}`
      else if (config.sid) {
        connectString = `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${config.host})(PORT=${config.port}))(CONNECT_DATA=(SID=${config.sid})))`
      }
      const conn = await oracledb.getConnection({
        user: config.user,
        password: config.password,
        connectString
      })
      const r = await conn.execute('SELECT USER AS current_user FROM DUAL')
      const currentSchema = String(
        (r.rows as Array<{ current_user: string }>)[0]?.current_user || ''
      )
      return { oracle: conn, currentSchema }
    }
  }
}

const closeSession = async (session: DbSession): Promise<void> => {
  try {
    if (session.mysql) await session.mysql.end()
  } catch {
    /* ignore */
  }
  try {
    if (session.pg) await session.pg.end()
  } catch {
    /* ignore */
  }
  try {
    if (session.oracle) await session.oracle.close()
  } catch {
    /* ignore */
  }
}

// ==================== 统一查询 ====================

/** 执行任意 SQL（查询返回行集，DML/DDL 返回影响行数） */
const runQuery = async (session: DbSession, rawSql: string): Promise<DbQueryResult> => {
  const sql = normalizeSql(rawSql)
  if (!sql) throw new Error('SQL 不能为空')

  if (session.mysql) {
    const [res, fields] = await session.mysql.query(sql)
    if (Array.isArray(res)) {
      const rows = (res as Record<string, unknown>[]).slice(0, MAX_ROWS)
      const columns =
        fields && fields.length
          ? fields.map((f) => f.name)
          : rows.length
            ? Object.keys(rows[0])
            : []
      return {
        columns,
        rows,
        affectedRows: 0,
        truncated: (res as unknown[]).length > MAX_ROWS
      }
    }
    const ok = res as { affectedRows?: number; insertId?: number | bigint }
    return {
      columns: [],
      rows: [],
      affectedRows: ok.affectedRows ?? 0,
      insertId: ok.insertId !== undefined ? String(ok.insertId) : undefined,
      truncated: false
    }
  }

  if (session.pg) {
    const r = await session.pg.query(sql)
    if (r.fields && r.fields.length > 0) {
      return {
        columns: r.fields.map((f) => f.name),
        rows: (r.rows as Record<string, unknown>[]).slice(0, MAX_ROWS),
        affectedRows: 0,
        truncated: r.rows.length > MAX_ROWS
      }
    }
    return { columns: [], rows: [], affectedRows: r.rowCount ?? 0, truncated: false }
  }

  if (session.oracle) {
    const r = await session.oracle.execute(
      sql,
      {},
      {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        maxRows: MAX_ROWS,
        autoCommit: true
      }
    )
    if (r.metaData && r.metaData.length > 0) {
      // 保持驱动返回的原生列名：Oracle 未加引号的标识符统一为大写，
      // 全链路（查询结果 -> 前端编辑 -> modifyRow/alterColumn）使用同一大小写，不做转换
      return {
        columns: r.metaData.map((m) => m.name),
        rows: r.rows as Record<string, unknown>[],
        affectedRows: 0,
        truncated: (r.rows?.length ?? 0) >= MAX_ROWS
      }
    }
    return { columns: [], rows: [], affectedRows: r.rowsAffected ?? 0, truncated: false }
  }

  throw new Error('连接已失效')
}

// ==================== 目录浏览 ====================

/** 数据库 / Schema / 表 列表项 */
interface CatalogItem {
  name: string
  type?: string
}

/** 列目录：databases / schemas / tables / columns */
const readCatalog = async (
  session: DbSession,
  scope: string,
  parent?: { database?: string; schema?: string; table?: string }
): Promise<CatalogItem[] | DbColumnInfo[]> => {
  const kind = session.kind

  if (scope === 'databases') {
    if (kind === 'mysql' || kind === 'oceanbase-mysql') {
      const r = await runQuery(session, 'SHOW DATABASES')
      return r.rows
        .map((row) => String(Object.values(row)[0]))
        .filter((n) => !['information_schema', 'performance_schema', 'sys', 'mysql'].includes(n))
        .map((name) => ({ name }))
    }
    if (kind === 'pgsql') {
      const r = await runQuery(
        session,
        'SELECT datname AS name FROM pg_database WHERE datistemplate = false AND datallowconn ORDER BY 1'
      )
      return r.rows.map((row) => ({ name: String(row.name) }))
    }
    return []
  }

  if (scope === 'schemas') {
    if (kind === 'mysql' || kind === 'oceanbase-mysql') {
      // MySQL 的 Schema 即数据库
      const r = await runQuery(session, 'SHOW DATABASES')
      return r.rows.map((row) => ({ name: String(Object.values(row)[0]) }))
    }
    if (kind === 'pgsql') {
      const r = await runQuery(
        session,
        `SELECT schema_name AS name FROM information_schema.schemata
         WHERE schema_name NOT IN ('pg_catalog','information_schema') AND schema_name NOT LIKE 'pg_toast%'
         ORDER BY 1`
      )
      return r.rows.map((row) => ({ name: String(row.name) }))
    }
    // Oracle：用户即 Schema
    const r = await runQuery(session, 'SELECT username AS "name" FROM all_users ORDER BY 1')
    return r.rows.map((row) => ({ name: String(row.name) }))
  }

  if (scope === 'tables') {
    if (kind === 'mysql' || kind === 'oceanbase-mysql') {
      const r = await runQuery(
        session,
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = '${sanitizeIdent(parent?.schema || parent?.database || '')}' ORDER BY 1`
      )
      return r.rows.map((row) => ({
        name: String(row.name),
        type: row.type === 'VIEW' ? 'VIEW' : 'TABLE'
      }))
    }
    if (kind === 'pgsql') {
      const r = await runQuery(
        session,
        `SELECT table_name AS name, table_type AS type FROM information_schema.tables
         WHERE table_schema = '${sanitizeIdent(parent?.schema || 'public')}' ORDER BY 1`
      )
      return r.rows.map((row) => ({
        name: String(row.name),
        type: row.type === 'VIEW' ? 'VIEW' : 'TABLE'
      }))
    }
    const r = await runQuery(
      session,
      `SELECT object_name AS "name", object_type AS "type" FROM all_objects
       WHERE owner = '${sanitizeIdent(parent?.schema || session.currentSchema || '')}'
         AND object_type IN ('TABLE','VIEW') ORDER BY 1`
    )
    return r.rows.map((row) => ({ name: String(row.name), type: String(row.type) }))
  }

  if (scope === 'columns') {
    const table = sanitizeIdent(parent?.table || '')
    /** 由字符长度/数值精度/小数位组合出长度字符串 */
    const colLength = (row: Record<string, unknown>): string | undefined => {
      if (row.charLen !== undefined && row.charLen !== null) return String(row.charLen)
      if (row.numPrec !== undefined && row.numPrec !== null) {
        const scale = row.numScale === undefined || row.numScale === null ? 0 : Number(row.numScale)
        return scale > 0 ? `${row.numPrec},${row.numScale}` : String(row.numPrec)
      }
      return undefined
    }
    if (kind === 'mysql' || kind === 'oceanbase-mysql') {
      const schema = sanitizeIdent(parent?.schema || parent?.database || '')
      const r = await runQuery(
        session,
        `SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, IS_NULLABLE AS nullable,
                COLUMN_KEY AS colKey, COLUMN_COMMENT AS comment,
                CHARACTER_MAXIMUM_LENGTH AS charLen, NUMERIC_PRECISION AS numPrec, NUMERIC_SCALE AS numScale
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = '${schema}' AND TABLE_NAME = '${table}'
         ORDER BY ORDINAL_POSITION`
      )
      return r.rows.map((row) => ({
        name: String(row.name),
        dataType: String(row.dataType),
        length: colLength(row),
        nullable: row.nullable === 'YES',
        pk: row.colKey === 'PRI',
        comment: row.comment ? String(row.comment) : undefined
      }))
    }
    if (kind === 'pgsql') {
      const schema = sanitizeIdent(parent?.schema || 'public')
      const r = await runQuery(
        session,
        `SELECT c.column_name AS name, c.data_type AS dataType, c.is_nullable AS nullable,
                tc.constraint_type AS constraintType,
                c.character_maximum_length AS charLen, c.numeric_precision AS numPrec, c.numeric_scale AS numScale
         FROM information_schema.columns c
         LEFT JOIN information_schema.key_column_usage k
           ON k.table_schema = c.table_schema AND k.table_name = c.table_name
          AND k.column_name = c.column_name
         LEFT JOIN information_schema.table_constraints tc
           ON tc.table_schema = k.table_schema AND tc.table_name = k.table_name
          AND tc.constraint_name = k.constraint_name AND tc.constraint_type = 'PRIMARY KEY'
         WHERE c.table_schema = '${schema}' AND c.table_name = '${table}'
         ORDER BY c.ordinal_position`
      )
      return r.rows.map((row) => ({
        name: String(row.name),
        dataType: String(row.dataType),
        length: colLength(row),
        nullable: row.nullable === 'YES',
        pk: row.constraintType === 'PRIMARY KEY'
      }))
    }
    // Oracle / OceanBase Oracle
    // 内部别名统一加双引号固定为小写（Oracle 未加引号的别名原生返回大写）；
    // 表名/Schema 用 UPPER() 匹配：SQL 里写小写表名时也能定位（Oracle 字典统一大写存储）
    const owner = sanitizeIdent(parent?.schema || session.currentSchema || '')
    const r = await runQuery(
      session,
      `SELECT c.column_name AS "name", c.data_type AS "data_type", c.nullable AS "nullable",
              c.char_length AS "charLen", c.data_precision AS "numPrec", c.data_scale AS "numScale",
              cc.comments AS "comments"
       FROM all_tab_columns c
       LEFT JOIN all_col_comments cc
         ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
       WHERE UPPER(c.owner) = UPPER('${owner}') AND UPPER(c.table_name) = UPPER('${table}') ORDER BY c.column_id`
    )
    const pkR = await runQuery(
      session,
      `SELECT cols.column_name AS "name" FROM all_constraints cons
       JOIN all_cons_columns cols
         ON cons.owner = cols.owner AND cons.constraint_name = cols.constraint_name
       WHERE UPPER(cons.owner) = UPPER('${owner}') AND UPPER(cons.table_name) = UPPER('${table}') AND cons.constraint_type = 'P'`
    )
    const pkNames = new Set(pkR.rows.map((row) => String(row.name)))
    return r.rows.map((row) => ({
      name: String(row.name),
      dataType: String(row.data_type),
      length: colLength(row),
      nullable: row.nullable === 'Y',
      pk: pkNames.has(String(row.name)),
      comment: row.comments ? String(row.comments) : undefined
    }))
  }

  if (scope === 'sequences') {
    // MySQL 系没有独立序列对象
    if (kind === 'mysql' || kind === 'oceanbase-mysql') return []
    if (kind === 'pgsql') {
      const r = await runQuery(
        session,
        `SELECT sequence_name AS name FROM information_schema.sequences
         WHERE sequence_schema = '${sanitizeIdent(parent?.schema || 'public')}' ORDER BY 1`
      )
      return r.rows.map((row) => ({ name: String(row.name) }))
    }
    const r = await runQuery(
      session,
      `SELECT sequence_name AS "name" FROM all_sequences
       WHERE sequence_owner = '${sanitizeIdent(parent?.schema || session.currentSchema || '')}' ORDER BY 1`
    )
    return r.rows.map((row) => ({ name: String(row.name) }))
  }

  if (scope === 'procedures') {
    if (kind === 'mysql' || kind === 'oceanbase-mysql') {
      const r = await runQuery(
        session,
        `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES
         WHERE ROUTINE_SCHEMA = '${sanitizeIdent(parent?.schema || parent?.database || '')}' ORDER BY 1`
      )
      return r.rows.map((row) => ({
        name: String(row.name),
        type: String(row.type || 'PROCEDURE')
      }))
    }
    if (kind === 'pgsql') {
      const r = await runQuery(
        session,
        `SELECT routine_name AS name, routine_type AS type FROM information_schema.routines
         WHERE routine_schema = '${sanitizeIdent(parent?.schema || 'public')}' ORDER BY 1`
      )
      return r.rows.map((row) => ({
        name: String(row.name),
        type: String(row.type || 'FUNCTION')
      }))
    }
    const r = await runQuery(
      session,
      `SELECT object_name AS "name", object_type AS "type" FROM all_objects
       WHERE owner = '${sanitizeIdent(parent?.schema || session.currentSchema || '')}'
         AND object_type IN ('PROCEDURE','FUNCTION') ORDER BY 1`
    )
    return r.rows.map((row) => ({ name: String(row.name), type: String(row.type) }))
  }

  throw new Error(`未知目录范围: ${scope}`)
}

// ==================== 分页取数 ====================

const buildTableRef = (
  kind: DbKind,
  database: string | undefined,
  schema: string | undefined,
  table: string
): string => {
  const t = quoteIdent(kind, table)
  if (kind === 'mysql' || kind === 'oceanbase-mysql') {
    const db = database || schema
    return db ? `${quoteIdent(kind, db)}.${t}` : t
  }
  const sch = schema || (kind === 'pgsql' ? 'public' : undefined)
  return sch ? `${quoteIdent(kind, sch)}.${t}` : t
}

const pageTable = async (
  session: DbSession,
  params: { database?: string; schema?: string; table: string; page: number; pageSize: number }
): Promise<DbPageResult> => {
  const pageSize = Math.min(Math.max(Number(params.pageSize) || 50, 1), 500)
  const page = Math.max(Number(params.page) || 1, 1)
  const offset = (page - 1) * pageSize
  const tableRef = buildTableRef(session.kind, params.database, params.schema, params.table)

  const countR = await runQuery(session, `SELECT COUNT(*) AS cnt FROM ${tableRef}`)
  // Oracle 未加引号的别名原生返回大写（CNT），MySQL/PG 为小写（cnt）
  const countRow = (countR.rows[0] ?? {}) as Record<string, unknown>
  const total = Number(countRow.cnt ?? countRow.CNT ?? 0)

  let dataR: DbQueryResult
  if (session.kind === 'mysql' || session.kind === 'oceanbase-mysql') {
    const r = await runQuery(
      session,
      `SELECT * FROM ${tableRef} LIMIT ${pageSize} OFFSET ${offset}`
    )
    dataR = r
  } else if (session.kind === 'pgsql') {
    const r = await runQuery(
      session,
      `SELECT * FROM ${tableRef} LIMIT ${pageSize} OFFSET ${offset}`
    )
    dataR = r
  } else {
    // Oracle / OB Oracle：ROWNUM 双层包裹（数值已做整数校验，直接内联）
    const r = await runQuery(
      session,
      `SELECT * FROM (
         SELECT t.*, ROWNUM AS rn FROM ${tableRef} t WHERE ROWNUM <= ${offset + pageSize}
       ) WHERE rn > ${offset}`
    )
    // 去掉辅助列 rn
    dataR = {
      ...r,
      columns: r.columns.filter((c) => c !== 'RN' && c !== 'rn'),
      rows: r.rows.map((row) => {
        const clone = { ...row }
        delete clone.RN
        delete clone.rn
        return clone
      })
    }
  }

  return { ...dataR, total }
}

// ==================== 行增删改 ====================

const modifyRow = async (
  session: DbSession,
  params: {
    database?: string
    schema?: string
    table: string
    action: RowAction
    primaryKey: NameValue[]
    changes: NameValue[]
  }
): Promise<{ affectedRows: number }> => {
  const tableRef = buildTableRef(
    session.kind,
    params.database,
    params.schema,
    sanitizeIdent(params.table)
  )
  const kind = session.kind
  const isMysql = kind === 'mysql' || kind === 'oceanbase-mysql'

  let sql = ''
  let binds: unknown[] = []

  if (params.action === 'insert') {
    if (!params.changes.length) throw new Error('没有要插入的数据')
    const cols = params.changes.map((c) => quoteIdent(kind, sanitizeIdent(c.name)))
    if (isMysql) {
      sql = `INSERT INTO ${tableRef} (${cols.join(',')}) VALUES (${params.changes.map(() => '?').join(',')})`
      binds = params.changes.map((c) => c.value)
    } else if (kind === 'pgsql') {
      sql = `INSERT INTO ${tableRef} (${cols.join(',')}) VALUES (${params.changes
        .map((_, i) => `$${i + 1}`)
        .join(',')})`
      binds = params.changes.map((c) => c.value)
    } else {
      sql = `INSERT INTO ${tableRef} (${cols.join(',')}) VALUES (${params.changes
        .map((_, i) => `:b${i + 1}`)
        .join(',')})`
    }
  } else {
    if (!params.primaryKey.length) throw new Error('该表没有主键，无法按行更新/删除')
    if (params.action === 'update') {
      const setParts: string[] = []
      const changeVals: unknown[] = []
      params.changes.forEach((c, i) => {
        const col = quoteIdent(kind, sanitizeIdent(c.name))
        changeVals.push(c.value)
        if (isMysql) setParts.push(`${col} = ?`)
        else if (kind === 'pgsql') setParts.push(`${col} = $${i + 1}`)
        else setParts.push(`${col} = :b${i + 1}`)
      })
      const whereParts: string[] = []
      params.primaryKey.forEach((pk, i) => {
        const col = quoteIdent(kind, sanitizeIdent(pk.name))
        const idx = changeVals.length + i + 1
        if (isMysql) whereParts.push(`${col} = ?`)
        else if (kind === 'pgsql') whereParts.push(`${col} = $${idx}`)
        else whereParts.push(`${col} = :b${idx}`)
      })
      sql = `UPDATE ${tableRef} SET ${setParts.join(',')} WHERE ${whereParts.join(' AND ')}`
      binds = [...changeVals, ...params.primaryKey.map((pk) => pk.value)]
    } else {
      const whereParts: string[] = []
      params.primaryKey.forEach((pk, i) => {
        const col = quoteIdent(kind, sanitizeIdent(pk.name))
        if (isMysql) whereParts.push(`${col} = ?`)
        else if (kind === 'pgsql') whereParts.push(`${col} = $${i + 1}`)
        else whereParts.push(`${col} = :b${i + 1}`)
      })
      sql = `DELETE FROM ${tableRef} WHERE ${whereParts.join(' AND ')}`
      binds = params.primaryKey.map((pk) => pk.value)
    }
  }

  if (session.mysql) {
    const [res] = await session.mysql.query(sql, binds)
    return { affectedRows: (res as { affectedRows?: number }).affectedRows ?? 0 }
  }
  if (session.pg) {
    const r = await session.pg.query(sql, binds)
    return { affectedRows: r.rowCount ?? 0 }
  }
  if (session.oracle) {
    // Oracle 绑定变量名必须字母开头，按 :b1 顺序组装对象
    const bindObj: Record<string, unknown> = {}
    binds.forEach((v, i) => {
      bindObj[`b${i + 1}`] = v
    })
    const r = await session.oracle.execute(sql, bindObj, { autoCommit: true })
    return { affectedRows: r.rowsAffected ?? 0 }
  }
  throw new Error('连接已失效')
}

// ==================== 字段结构修改 ====================

/** 转义 SQL 字符串字面量中的单引号（注释等） */
const escapeLiteral = (s: string): string => s.replace(/'/g, "''")

/** 列定义修改参数：字段名、类型、是否为空、注释均可改，改名时提供 newName */
export interface DbAlterColumnParams {
  connId: string
  database?: string
  schema?: string
  table: string
  oldName: string
  newName?: string
  dataType: string
  nullable: boolean
  /** 修改前的可空状态（Oracle 仅在实际变更可空性时才附加 NULL/NOT NULL，避免 ORA-01451） */
  wasNullable?: boolean
  comment?: string
}

/**
 * 修改表字段（名称/类型/可空/注释），按方言拆分语句顺序执行：
 * - MySQL：单条 CHANGE/MODIFY 覆盖全部变更
 * - PG / Oracle：RENAME → ALTER (TYPE/NOT NULL) → COMMENT 分条执行
 */
const alterColumn = async (
  session: DbSession,
  params: Omit<DbAlterColumnParams, 'connId'>
): Promise<{ executed: string[] }> => {
  const kind = session.kind
  const isMysql = kind === 'mysql' || kind === 'oceanbase-mysql'
  const tableRef = buildTableRef(kind, params.database, params.schema, sanitizeIdent(params.table))
  const oldName = sanitizeIdent(params.oldName)
  const newName = params.newName ? sanitizeIdent(params.newName) : oldName
  if (!params.dataType.trim()) throw new Error('类型不能为空')
  // 类型允许括号/数字/精度等字符（如 varchar(50)、number(10,2)）
  const dataType = params.dataType.trim()
  if (!/^[A-Za-z0-9_ ()$,]+$/.test(dataType)) throw new Error(`非法类型: ${dataType}`)
  // 变长/定长字符类型必须带长度，否则 Oracle 报 ORA-00906（如 VARCHAR2 缺少括号）
  const base = dataType.replace(/\([^()]*\)\s*$/, '').trim().toUpperCase()
  if (
    !dataType.includes('(') &&
    ['VARCHAR', 'VARCHAR2', 'NVARCHAR', 'NVARCHAR2', 'CHAR', 'NCHAR', 'CHARACTER'].includes(base)
  ) {
    throw new Error(`${base} 类型必须指定长度，如 ${base}(100)`)
  }

  const colRef = (name: string): string => `${tableRef}.${quoteIdent(kind, name)}`

  const stmts: string[] = []
  if (isMysql) {
    // CHANGE 同时覆盖改名与定义修改
    const kw = newName !== oldName ? 'CHANGE COLUMN' : 'MODIFY COLUMN'
    stmts.push(
      `ALTER TABLE ${tableRef} ${kw} ${quoteIdent(kind, oldName)}${
        newName !== oldName ? ` ${quoteIdent(kind, newName)}` : ''
      } ${dataType} ${params.nullable ? 'NULL' : 'NOT NULL'}${
        params.comment ? ` COMMENT '${escapeLiteral(params.comment)}'` : ''
      }`
    )
  } else {
    if (newName !== oldName) {
      stmts.push(
        `ALTER TABLE ${tableRef} RENAME COLUMN ${quoteIdent(kind, oldName)} TO ${quoteIdent(kind, newName)}`
      )
    }
    if (kind === 'pgsql') {
      stmts.push(
        `ALTER TABLE ${tableRef} ALTER COLUMN ${quoteIdent(kind, newName)} TYPE ${dataType}`
      )
      stmts.push(
        `ALTER TABLE ${tableRef} ALTER COLUMN ${quoteIdent(kind, newName)} ${
          params.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'
        }`
      )
    } else {
      // Oracle：列已允许 NULL 时再 MODIFY NULL 会报 ORA-01451，仅在确实要变更可空性时附加子句；
      // 目标为 NOT NULL 时无条件附加（重复设置不会报错）
      const nullablePart =
        params.nullable ? (params.wasNullable === false ? ' NULL' : '') : ' NOT NULL'
      stmts.push(
        `ALTER TABLE ${tableRef} MODIFY (${quoteIdent(kind, newName)} ${dataType}${nullablePart})`
      )
    }
    if (params.comment !== undefined) {
      stmts.push(`COMMENT ON COLUMN ${colRef(newName)} IS '${escapeLiteral(params.comment ?? '')}'`)
    }
  }

  const executed: string[] = []
  for (const sql of stmts) {
    await runQuery(session, sql)
    executed.push(normalizeSql(sql))
  }
  return { executed }
}

const getSession = (connId: string): DbSession => {
  const session = sessions.get(connId)
  if (!session) throw new Error('数据库连接不存在或已断开，请重新连接')
  return session
}

// ==================== IPC 注册 ====================

export function registerToolboxDbIpc(): void {
  /** 测试连接（连通后立即关闭） */
  ipcMain.handle('tb:db-test', async (_event, config: DbConfig) => {
    const session: DbSession = { kind: config.kind, config }
    Object.assign(session, await openConnection(config))
    await closeSession(session)
    return { success: true, message: '连接成功' }
  })

  /** 建立连接，返回会话上下文 */
  ipcMain.handle('tb:db-connect', async (_event, config: DbConfig) => {
    const session: DbSession = { kind: config.kind, config }
    Object.assign(session, await openConnection(config))
    const connId = randomUUID()
    sessions.set(connId, session)
    return {
      connId,
      kind: config.kind,
      currentDatabase: session.currentDatabase,
      currentSchema: session.currentSchema
    }
  })

  /** 关闭连接 */
  ipcMain.handle('tb:db-disconnect', async (_event, connId: string) => {
    const session = sessions.get(connId)
    if (session) {
      await closeSession(session)
      sessions.delete(connId)
    }
    return { success: true }
  })

  /** 目录浏览 */
  ipcMain.handle(
    'tb:db-catalog',
    async (
      _event,
      payload: {
        connId: string
        scope: 'databases' | 'schemas' | 'tables' | 'columns' | 'sequences' | 'procedures'
        parent?: { database?: string; schema?: string; table?: string }
      }
    ) => readCatalog(getSession(payload.connId), payload.scope, payload.parent)
  )

  /** 执行任意 SQL（queryId 可用于取消；database 可切换当前会话的库/Schema） */
  ipcMain.handle(
    'tb:db-query',
    async (
      _event,
      payload: { connId: string; sql: string; queryId?: string; database?: string }
    ) => {
      const session = getSession(payload.connId)
      const queryId = payload.queryId
      if (queryId) runningQueries.set(queryId, payload.connId)
      try {
        // 切换会话当前数据库 / Schema（与 UI 选择保持一致）
        const db = payload.database?.trim()
        if (db) {
          if (session.mysql) {
            await session.mysql.query(`USE \`${db.replace(/`/g, '')}\``)
          } else if (session.pg) {
            await session.pg.query(`SET search_path TO "${db.replace(/"/g, '')}"`)
          } else if (session.oracle) {
            await session.oracle.execute(
              `ALTER SESSION SET CURRENT_SCHEMA = "${db.replace(/"/g, '')}"`
            )
          }
        }
        return await runQuery(session, payload.sql)
      } finally {
        if (queryId) runningQueries.delete(queryId)
      }
    }
  )

  /** 取消正在执行的查询 */
  ipcMain.handle('tb:db-cancel', async (_event, queryId: string) => {
    const connId = runningQueries.get(queryId)
    if (!connId) return { success: false, message: '查询已结束' }
    const session = sessions.get(connId)
    if (!session) return { success: false, message: '连接不存在' }
    try {
      if (session.mysql && session.mysqlThreadId !== undefined) {
        // 通过独立管理连接 KILL QUERY，不破坏原连接
        const admin = await createConnection({
          host: session.config.host,
          port: session.config.port,
          user: session.config.user,
          password: session.config.password,
          ssl: session.config.ssl ? { rejectUnauthorized: false } : undefined,
          connectTimeout: 5000
        })
        try {
          await admin.query(`KILL QUERY ${Number(session.mysqlThreadId)}`)
        } finally {
          await admin.end()
        }
      } else if (session.pg && session.pgBackendPid) {
        // 必须用独立连接，否则会取消自身
        const admin = new PgClient({
          host: session.config.host,
          port: session.config.port,
          user: session.config.user,
          password: session.config.password,
          database: session.config.database || undefined,
          ssl: session.config.ssl ? { rejectUnauthorized: false } : undefined,
          connectionTimeoutMillis: 5000
        })
        await admin.connect()
        try {
          await admin.query(`SELECT pg_cancel_backend(${Number(session.pgBackendPid)})`)
        } finally {
          await admin.end().catch(() => undefined)
        }
      } else if (session.oracle) {
        await session.oracle.break()
      }
      return { success: true }
    } catch (e) {
      return { success: false, message: (e as Error).message }
    }
  })

  /** 分页查询表数据 */
  ipcMain.handle(
    'tb:db-page',
    async (
      _event,
      payload: {
        connId: string
        database?: string
        schema?: string
        table: string
        page: number
        pageSize: number
      }
    ) => pageTable(getSession(payload.connId), payload)
  )

  /** 行增删改 */
  ipcMain.handle(
    'tb:db-modify',
    async (
      _event,
      payload: {
        connId: string
        database?: string
        schema?: string
        table: string
        action: RowAction
        primaryKey: NameValue[]
        changes: NameValue[]
      }
    ) => modifyRow(getSession(payload.connId), payload)
  )

  /** 修改表字段（名称/类型/可空/注释） */
  ipcMain.handle('tb:db-alter-column', async (_event, payload: DbAlterColumnParams) => {
    const { connId, ...rest } = payload
    return alterColumn(getSession(connId), rest)
  })
}
