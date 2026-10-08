import { ipcMain, app, shell } from 'electron'
import { join } from 'path'
import fs from 'fs'
import { ImapFlow } from 'imapflow'
import { simpleParser, type ParsedMail } from 'mailparser'
import nodemailer, { type Transporter } from 'nodemailer'

/** 邮箱账户类型：IMAP 真实收发，exchange / pop3 暂仅保存配置 */
export type MailAccountType = 'imap' | 'exchange' | 'pop3'

/** 邮箱账户（明文保存在 mail.json 中） */
export interface MailAccount {
  id: string
  type: MailAccountType
  email: string
  password: string
  imapHost: string
  imapPort: number
  imapSsl?: boolean
  smtpHost: string
  smtpPort: number
  smtpSsl?: boolean
}

/** 邮件列表项摘要 */
export interface MailSummary {
  uid: number
  subject: string
  fromName: string
  fromAddr: string
  to: string
  cc: string
  date: string
  size: number
  seen: boolean
  hasAttachment: boolean
}

/** 邮件详情 */
export interface MailDetail {
  uid: number
  subject: string
  fromName: string
  fromAddr: string
  to: string
  cc: string
  date: string
  size: number
  html: string
  text: string
  attachments: { filename: string; contentType: string; size: number }[]
}

/** 支持真实收发的账户类型 */
const IMAP_TYPES: MailAccountType[] = ['imap']

/** 登录名候选：完整邮箱失败后自动回退纯账号名（部分 Exchange 服务器要求） */
function loginUsers(email: string): string[] {
  const localPart = email.split('@')[0]
  return localPart === email ? [email] : [email, localPart]
}

/** 是否为认证类错误（决定是否用下一个登录名重试） */
function isAuthError(err: unknown): boolean {
  return /auth|logon|login|credential|password|user name|用户名|密码/i.test(
    (err as Error)?.message || ''
  )
}

/** 地址对象格式化为 "名字 <a@b.c>" 文本（多个用逗号连接） */
function formatAddresses(
  list:
    | { value?: { name?: string; address?: string }[] }[]
    | { name?: string; address?: string }[]
    | undefined
): string {
  if (!list || list.length === 0) return ''
  const flat = list.flatMap((a) =>
    'value' in a && Array.isArray(a.value) ? a.value : [a as { name?: string; address?: string }]
  )
  return flat
    .filter((a) => a && a.address)
    .map((a) => (a.name ? `${a.name} <${a.address}>` : a.address))
    .join(', ')
}

/** 建立 IMAP 连接执行回调，结束自动断开；登录名自动回退，不支持的账户类型直接抛错 */
async function withImap<T>(account: MailAccount, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  if (!IMAP_TYPES.includes(account.type)) {
    throw new Error('该账户类型暂不支持收发，请添加企业邮箱(IMAP) 账户')
  }
  let lastErr: unknown
  for (const user of loginUsers(account.email)) {
    const client = new ImapFlow({
      host: account.imapHost,
      port: account.imapPort,
      secure: account.imapSsl ?? account.imapPort === 993,
      auth: { user, pass: account.password },
      tls: { rejectUnauthorized: false },
      logger: false
    })
    try {
      await client.connect()
      return await fn(client)
    } catch (err) {
      lastErr = err
      // 仅认证失败才换登录名重试，网络/协议错误直接抛出
      if (!isAuthError(err)) throw err
    } finally {
      client.close()
    }
  }
  throw lastErr
}

/** 判断 BodyStructure 节点是否为附件 */
function isAttachmentNode(node: {
  disposition?: string
  dispositionParameters?: Record<string, string>
  parameters?: Record<string, string>
}): boolean {
  return (
    node.disposition === 'attachment' ||
    !!node.dispositionParameters?.filename ||
    !!node.parameters?.name
  )
}

/** 递归遍历 BodyStructure 判断邮件是否带附件 */
function structureHasAttachment(node: unknown): boolean {
  const n = node as {
    disposition?: string
    dispositionParameters?: Record<string, string>
    parameters?: Record<string, string>
    childNodes?: unknown[]
  }
  if (!n) return false
  if (isAttachmentNode(n)) return true
  return (n.childNodes || []).some(structureHasAttachment)
}

/** mailparser 地址字段（AddressObject 或数组）统一格式化为文本 */
function addrText(f: ParsedMail['from'] | ParsedMail['to'] | ParsedMail['cc']): string {
  if (!f) return ''
  if (Array.isArray(f)) return f.map((a) => a.text || '').filter(Boolean).join(', ')
  return f.text || ''
}

/** 将 ParsedMail 转换为渲染进程使用的邮件详情 */
function toDetail(parsed: ParsedMail, uid: number, rawSize: number): MailDetail {
  const dateVal = parsed.date
  return {
    uid,
    subject: parsed.subject || '(无主题)',
    fromName: parsed.from?.value[0]?.name || '',
    fromAddr: addrText(parsed.from),
    to: addrText(parsed.to),
    cc: addrText(parsed.cc),
    date: (
      typeof dateVal === 'string' ? new Date(dateVal) : dateVal || new Date(0)
    ).toISOString(),
    size: rawSize || 0,
    html: typeof parsed.html === 'string' ? parsed.html : '',
    text: parsed.text || '',
    attachments: (parsed.attachments || []).map((a) => ({
      filename: a.filename || '未命名附件',
      contentType: a.contentType || 'application/octet-stream',
      size: a.size || (a.content ? a.content.length : 0)
    }))
  }
}

/** 解析邮件原文 */
async function parseSource(source: Buffer): Promise<ParsedMail> {
  return simpleParser(source)
}

// ==================== POP3 支持（极简客户端，仅 TLS 连接） ====================

import { connect as tlsConnect, type TLSSocket } from 'tls'
import { connect as netConnect, type Socket } from 'net'

/** POP3 响应等待器 */
interface Pop3Waiter {
  multiline: boolean
  resolve: (value: string) => void
  reject: (err: Error) => void
}

/**
 * 极简 POP3 客户端：顺序执行命令，单行响应以首个 "\r\n" 结束，
 * 多行响应以独立 "\r\n.\r\n" 行结束。
 */
class Pop3Client {
  private socket: TLSSocket | Socket
  private buf = ''
  private waiter: Pop3Waiter | null = null

  private constructor(socket: TLSSocket | Socket) {
    this.socket = socket
    socket.setEncoding('utf-8')
    socket.on('data', (chunk: string) => {
      this.buf += chunk
      this.tryResolve()
    })
    socket.on('error', (err: Error) => {
      this.waiter?.reject(err)
      this.waiter = null
    })
    socket.on('close', () => {
      this.waiter?.reject(new Error('POP3 连接已断开'))
      this.waiter = null
    })
  }

  /** 建立 POP3 连接并完成登录（SSL 取决于 imapSsl / 端口 995） */
  static async connect(account: MailAccount): Promise<Pop3Client> {
    const secure = account.imapSsl ?? account.imapPort === 995
    const socket = secure
      ? tlsConnect({ host: account.imapHost, port: account.imapPort, rejectUnauthorized: false })
      : netConnect({ host: account.imapHost, port: account.imapPort })
    await new Promise<void>((resolve, reject) => {
      socket.once(secure ? 'secureConnect' : 'connect', () => resolve())
      socket.once('error', (err: Error) => reject(new Error(`POP3 连接失败: ${err.message}`)))
    })
    const client = new Pop3Client(socket)
    try {
      await client.waitLine()
      await client.login(account.email, account.password)
      return client
    } catch (err) {
      client.quit()
      // 部分服务器要求"域名\账号"或纯账号名登录，用完整邮箱失败后自动回退重试
      const localPart = account.email.split('@')[0]
      if (localPart === account.email) throw err
      const retry = new Pop3Client(
        secure
          ? tlsConnect({ host: account.imapHost, port: account.imapPort, rejectUnauthorized: false })
          : netConnect({ host: account.imapHost, port: account.imapPort })
      ) as Pop3Client
      await new Promise<void>((resolve, reject) => {
        const sock = retry.rawSocket()
        sock.once(secure ? 'secureConnect' : 'connect', () => resolve())
        sock.once('error', (err2: Error) => reject(new Error(`POP3 连接失败: ${err2.message}`)))
      })
      await retry.waitLine()
      await retry.login(localPart, account.password)
      return retry
    }
  }

  /** 登录：USER + PASS */
  private async login(user: string, pass: string): Promise<void> {
    await this.status(`USER ${user}`)
    await this.status(`PASS ${pass}`)
  }

  /** 访问底层 socket（重连用） */
  rawSocket(): TLSSocket | Socket {
    return this.socket
  }

  /** 等待单行响应 */
  private waitLine(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.waiter = { multiline: false, resolve, reject }
      this.tryResolve()
    })
  }

  /** 尝试用缓冲区中已有的数据完成当前等待 */
  private tryResolve(): void {
    const w = this.waiter
    if (!w) return
    if (w.multiline) {
      const end = this.buf.indexOf('\r\n.\r\n')
      if (end === -1) return
      const raw = this.buf.slice(0, end + 2)
      this.buf = this.buf.slice(end + 5)
      this.waiter = null
      w.resolve(raw)
    } else {
      const idx = this.buf.indexOf('\r\n')
      if (idx === -1) return
      const line = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 2)
      this.waiter = null
      w.resolve(line)
    }
  }

  /** 发送命令，要求 +OK 响应（multiline 等待多行终止符） */
  private async status(command: string, multiline = false): Promise<string> {
    const res = await new Promise<string>((resolve, reject) => {
      if (this.waiter) {
        reject(new Error('POP3 命令未按顺序执行'))
        return
      }
      this.waiter = { multiline, resolve, reject }
      this.socket.write(`${command}\r\n`)
      this.tryResolve()
    })
    if (!res.startsWith('+OK')) throw new Error(`POP3 ${command.split(' ')[0]} 失败: ${res}`)
    return res
  }

  /** 去掉多行响应的状态行，返回正文部分 */
  private body(raw: string): string {
    return raw.slice(raw.indexOf('\r\n') + 2)
  }

  /** UIDL 列表：邮件序号 → 唯一标识 */
  async uidl(): Promise<{ msgNo: number; uidl: string }[]> {
    const res = await this.status('UIDL', true)
    return this.body(res)
      .split('\r\n')
      .filter((line) => line.trim())
      .map((line) => {
        const [no, id] = line.trim().split(' ')
        return { msgNo: Number(no), uidl: id || `${no}` }
      })
  }

  /** LIST：邮件序号 → 字节大小 */
  async listSizes(): Promise<Map<number, number>> {
    const res = await this.status('LIST', true)
    const map = new Map<number, number>()
    for (const line of this.body(res).split('\r\n')) {
      const [no, size] = line.trim().split(' ')
      if (no) map.set(Number(no), Number(size) || 0)
    }
    return map
  }

  /** TOP：仅取头部（含 n 行正文，此处 0 行） */
  async top(msgNo: number): Promise<string> {
    return this.body(await this.status(`TOP ${msgNo} 0`, true))
  }

  /** RETR：取整封邮件 */
  async retr(msgNo: number): Promise<string> {
    return this.body(await this.status(`RETR ${msgNo}`, true))
  }

  /** 标记删除（QUIT 时生效） */
  async dele(msgNo: number): Promise<void> {
    await this.status(`DELE ${msgNo}`)
  }

  /** 保活探测（连接复用时校验会话仍有效） */
  async noop(): Promise<void> {
    await this.status('NOOP')
  }

  /** 结束会话并断开（删除操作此时才真正提交） */
  quit(): void {
    try {
      this.socket.write('QUIT\r\n')
    } catch {
      // 忽略退出失败
    }
    this.socket.destroy()
  }
}

/** POP3 会话复用缓存：accountId → 已登录客户端（登录常驻，只有会话失效或认证失败时才重新登录） */
const pop3Sessions = new Map<string, Pop3Client>()

/** 每账户串行锁：防止同会话并发命令（POP3 命令必须顺序执行） */
const pop3Locks = new Map<string, Promise<unknown>>()

/** 邮件原文缓存：accountId:uid → 原文（详情与附件共用，避免重复 RETR） */
const pop3SourceCache = new Map<string, Buffer>()

/** POP3 会话锁内执行：复用已登录连接；会话失效自动重连；fresh=true 用全新连接并在结束时 QUIT（删除提交需要） */
async function withPop3<T>(
  account: MailAccount,
  fn: (client: Pop3Client) => Promise<T>,
  opts?: { fresh?: boolean }
): Promise<T> {
  const key = account.id || account.email
  const prev = pop3Locks.get(key) || Promise.resolve()
  const task = prev.then(async (): Promise<T> => {
    if (opts?.fresh) {
      const client = await Pop3Client.connect(account)
      try {
        return await fn(client)
      } finally {
        client.quit()
      }
    }
    let client = pop3Sessions.get(key)
    if (client) {
      try {
        await client.noop()
      } catch {
        // 会话已失效（服务器断开等），丢弃后重新登录
        client = undefined
      }
    }
    if (!client) {
      client = await Pop3Client.connect(account)
      pop3Sessions.set(key, client)
    }
    return fn(client)
  })
  pop3Locks.set(
    key,
    task.catch(() => {})
  )
  return task
}

/** UIDL 字符串 → 稳定数值 uid（作为渲染进程邮件标识） */
function uidlHash(uidl: string): number {
  let h = 5381
  for (let i = 0; i < uidl.length; i++) h = ((h << 5) + h + uidl.charCodeAt(i)) | 0
  return Math.abs(h) % 2147483647
}

/** 按类型验证收件连通性（立即断开），返回错误信息或 null */
async function verifyInbox(account: MailAccount): Promise<string | null> {
  if (account.type === 'pop3') {
    try {
      // 测试连接始终用全新连接，确保验证的是真实登录
      await withPop3(account, async () => true, { fresh: true })
      return null
    } catch (err) {
      return `POP3 连接失败: ${(err as Error).message}`
    }
  }
  if (account.type === 'imap') {
    try {
      await withImap(account, async (client) => {
        await client.getMailboxLock('INBOX')
        return true
      })
      return null
    } catch (err) {
      return `IMAP 连接失败: ${(err as Error).message}`
    }
  }
  return null
}

/** POP3：按 uid（uidlHash）定位邮件序号并取回原文（带缓存，详情与附件共用） */
async function pop3Source(account: MailAccount, uid: number): Promise<Buffer> {
  const key = `${account.id}:${uid}`
  const cached = pop3SourceCache.get(key)
  if (cached) return cached
  return withPop3(account, async (client) => {
    const uidls = await client.uidl()
    const hit = uidls.find((u) => uidlHash(u.uidl) === uid)
    if (!hit) throw new Error('邮件不存在或已被删除')
    const source = Buffer.from(await client.retr(hit.msgNo), 'utf-8')
    if (pop3SourceCache.size >= 30) {
      pop3SourceCache.delete(pop3SourceCache.keys().next().value as string)
    }
    pop3SourceCache.set(key, source)
    return source
  })
}

/** 建立 SMTP 连接执行回调；登录名（完整邮箱→纯账号名）与加密方式（SSL→STARTTLS）自动回退 */
async function withSmtp<T>(account: MailAccount, fn: (transporter: Transporter) => Promise<T>): Promise<T> {
  // 组合尝试：登录名 × 加密方式（SSL 失败降级为 STARTTLS/明文）
  const secures = [account.smtpSsl ?? account.smtpPort === 465, false].filter(
    (v, i, arr) => arr.indexOf(v) === i
  )
  const attempts: { user: string; secure: boolean }[] = []
  for (const user of loginUsers(account.email)) {
    for (const secure of secures) attempts.push({ user, secure })
  }
  let lastErr: unknown
  for (const { user, secure } of attempts) {
    const transporter = nodemailer.createTransport({
      host: account.smtpHost,
      port: account.smtpPort,
      secure,
      auth: { user, pass: account.password },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 20000
    })
    try {
      return await fn(transporter)
    } catch (err) {
      lastErr = err
      // 认证失败说明加密方式没问题，换下一个登录名（跳过该用户剩余加密方式）
      if (isAuthError(err)) {
        const idx = attempts.findIndex((a) => a.user === user)
        attempts.splice(0, idx + 1)
      }
    } finally {
      transporter.close()
    }
  }
  throw lastErr
}

export function registerToolboxMailIpc(): void {
  // 测试账户连通性（收件协议 + SMTP verify，均立即断开）
  ipcMain.handle('tb:mail-test', async (_event, account: MailAccount) => {
    const inboxErr = await verifyInbox(account)
    if (inboxErr) return { success: false, message: inboxErr }
    if (!account.smtpHost) return { success: true, message: '收件服务器连接成功（未配置 SMTP）' }
    try {
      await withSmtp(account, async (transporter) => {
        await transporter.verify()
        return true
      })
      return { success: true, message: '收件与发件服务器连接成功' }
    } catch (err) {
      return { success: false, message: `SMTP 连接失败: ${(err as Error).message}` }
    }
  })

  // 拉取收件箱邮件列表（按时间倒序；IMAP 最多 200 封，POP3 最多 100 封）
  // 增量收取：POP3 传 knownUids 跳过已收取邮件的头部下载；IMAP 传 sinceUid 只取更新 UID 的邮件
  ipcMain.handle(
    'tb:mail-list',
    async (
      _event,
      account: MailAccount,
      options?: { knownUids?: number[]; sinceUid?: number }
    ): Promise<MailSummary[]> => {
      const known = new Set(options?.knownUids || [])
      const sinceUid = options?.sinceUid
      if (account.type === 'pop3') {
        return withPop3(account, async (client) => {
          const uidls = await client.uidl()
          const sizes = await client.listSizes()
          const summaries: MailSummary[] = []
          // 倒序遍历，只对新邮件做 TOP 下载头部（增量收取时大幅提速）
          for (const { msgNo, uidl } of uidls.slice(-100).reverse()) {
            const uid = uidlHash(uidl)
            if (known.has(uid)) continue
            const parsed = await parseSource(Buffer.from(await client.top(msgNo), 'utf-8'))
            summaries.push({
              uid,
              subject: parsed.subject || '(无主题)',
              fromName: parsed.from?.value[0]?.name || '',
              fromAddr: addrText(parsed.from),
              to: addrText(parsed.to),
              cc: addrText(parsed.cc),
              date: (
                typeof parsed.date === 'string' ? new Date(parsed.date) : parsed.date || new Date(0)
              ).toISOString(),
              size: sizes.get(msgNo) || 0,
              seen: false,
              hasAttachment: false
            })
          }
          return summaries
        })
      }
      return withImap(account, async (client) => {
      const lock = await client.getMailboxLock('INBOX')
      const list: MailSummary[] = []
      try {
        // 增量收取：只拉取比 sinceUid 更新的 UID（`n:*` 语义保证至少返回一封，需过滤）
        const range = sinceUid ? `${sinceUid + 1}:*` : '1:*'
        for await (const msg of client.fetch(range, {
          uid: true,
          envelope: true,
          flags: true,
          size: true,
          bodyStructure: true
        })) {
          if (sinceUid && msg.uid <= sinceUid) continue
          const env = msg.envelope
          list.push({
            uid: msg.uid,
            subject: env?.subject || '(无主题)',
            fromName: env?.from?.[0]?.name || '',
            fromAddr: env?.from?.[0]?.address || '',
            to: formatAddresses(env?.to),
            cc: formatAddresses(env?.cc),
            date: (
              typeof env?.date === 'string' ? new Date(env.date) : env?.date || new Date(0)
            ).toISOString(),
            size: msg.size || 0,
            seen: (msg.flags || new Set()).has('\\Seen'),
            hasAttachment: structureHasAttachment(msg.bodyStructure)
          })
        }
      } finally {
        lock.release()
      }
      list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      return list.slice(0, 200)
    })
  })

  // 拉取单封邮件详情（含正文与附件元信息）
  ipcMain.handle(
    'tb:mail-fetch',
    async (_event, account: MailAccount, uid: number): Promise<MailDetail> => {
      if (account.type === 'pop3') {
        const source = await pop3Source(account, uid)
        const parsed = await parseSource(source)
        return toDetail(parsed, uid, source.length)
      }
      return withImap(account, async (client) => {
        const lock = await client.getMailboxLock('INBOX')
        try {
          const msg = (await client.fetchOne(
            String(uid),
            { uid: true, size: true, source: true },
            { uid: true }
          )) as { source?: Buffer; size?: number } | false
          if (!msg || !msg.source) throw new Error('邮件不存在或已被删除')
          const parsed = await parseSource(msg.source)
          return toDetail(parsed, uid, msg.size || 0)
        } finally {
          lock.release()
        }
      })
    }
  )

  // 下载附件：按文件名定位并返回 base64 内容
  ipcMain.handle(
    'tb:mail-attachment',
    async (
      _event,
      account: MailAccount,
      uid: number,
      filename: string
    ): Promise<{ contentBase64: string; contentType: string }> => {
      if (account.type === 'pop3') {
        const source = await pop3Source(account, uid)
        const parsed = await simpleParser(source)
        const att = (parsed.attachments || []).find((a) => (a.filename || '') === filename)
        if (!att) throw new Error(`未找到附件: ${filename}`)
        return {
          contentBase64: att.content.toString('base64'),
          contentType: att.contentType || 'application/octet-stream'
        }
      }
      return withImap(account, async (client) => {
        const lock = await client.getMailboxLock('INBOX')
        try {
          const msg = (await client.fetchOne(
            String(uid),
            { uid: true, source: true },
            { uid: true }
          )) as { source?: Buffer } | false
          if (!msg || !msg.source) throw new Error('邮件不存在或已被删除')
          const parsed = await simpleParser(msg.source)
          const att = (parsed.attachments || []).find((a) => (a.filename || '') === filename)
          if (!att) throw new Error(`未找到附件: ${filename}`)
          return {
            contentBase64: att.content.toString('base64'),
            contentType: att.contentType || 'application/octet-stream'
          }
        } finally {
          lock.release()
        }
      })
    }
  )

  // 发送邮件（SMTP）
  ipcMain.handle(
    'tb:mail-send',
    async (
      _event,
      account: MailAccount,
      mail: {
        to: string
        cc?: string
        subject: string
        html: string
        inReplyTo?: string
        /** 附件本地路径列表 */
        attachments?: string[]
      }
    ): Promise<{ success: boolean; message: string }> => {
      if (!account.smtpHost) {
        return { success: false, message: '未配置发件服务器（SMTP）' }
      }
      try {
        await withSmtp(account, async (transporter) => {
          await transporter.sendMail({
            from: account.email,
            to: mail.to,
            cc: mail.cc || undefined,
            subject: mail.subject,
            html: mail.html,
            inReplyTo: mail.inReplyTo,
            attachments: (mail.attachments || []).map((path) => ({
              path,
              filename: path.split(/[\\/]/).pop()
            }))
          })
          return true
        })
        return { success: true, message: '发送成功' }
      } catch (err) {
        return { success: false, message: `发送失败: ${(err as Error).message}` }
      }
    }
  )

  // 批量标记已读 / 未读（POP3 无服务器标志，由渲染进程本地维护，此处直接返回）
  ipcMain.handle(
    'tb:mail-mark-seen',
    async (_event, account: MailAccount, uids: number[], seen: boolean): Promise<void> => {
      if (uids.length === 0 || account.type !== 'imap') return
      await withImap(account, async (client) => {
        const lock = await client.getMailboxLock('INBOX')
        try {
          const range = uids.join(',')
          if (seen) {
            await client.messageFlagsAdd(range, ['\\Seen'], { uid: true })
          } else {
            await client.messageFlagsRemove(range, ['\\Seen'], { uid: true })
          }
        } finally {
          lock.release()
        }
      })
    }
  )

  // 批量删除邮件
  ipcMain.handle(
    'tb:mail-delete',
    async (_event, account: MailAccount, uids: number[]): Promise<void> => {
      if (uids.length === 0) return
      if (account.type === 'pop3') {
        // POP3 删除必须用全新连接并在结束时 QUIT 才会真正提交
        await withPop3(
          account,
          async (client) => {
            const uidls = await client.uidl()
            const map = new Map(uidls.map((u) => [uidlHash(u.uidl), u.msgNo]))
            for (const uid of uids) {
              const msgNo = map.get(uid)
              if (msgNo) await client.dele(msgNo)
            }
            return true
          },
          { fresh: true }
        )
        // 清掉被删邮件的原文缓存
        for (const key of Array.from(pop3SourceCache.keys())) {
          if (key.startsWith(`${account.id}:`)) pop3SourceCache.delete(key)
        }
        return
      }
      await withImap(account, async (client) => {
        const lock = await client.getMailboxLock('INBOX')
        try {
          await client.messageDelete(uids.join(','), { uid: true })
        } finally {
          lock.release()
        }
      })
    }
  )

  // 读取本地文件为 base64（写信插入图片转 data URL）
  ipcMain.handle('tb:mail-read-file-base64', (_event, path: string): string => {
    return fs.readFileSync(path).toString('base64')
  })

  // 用系统默认程序打开本地文件（附件"查看"）
  ipcMain.handle('tb:mail-open-path', async (_event, path: string) => {
    const err = await shell.openPath(path)
    return { success: !err, message: err || '' }
  })

  // 保存 base64 内容到本地文件并返回路径（附件"查看"落到临时目录）
  ipcMain.handle(
    'tb:mail-save-temp',
    async (_event, filename: string, contentBase64: string): Promise<string> => {
      const dir = join(app.getPath('home'), '.dotai', 'Cache', 'mail-attachments')
      fs.mkdirSync(dir, { recursive: true })
      const safe = filename.replace(/[\\/:*?"<>|]/g, '_')
      const path = join(dir, `${Date.now()}_${safe}`)
      fs.writeFileSync(path, Buffer.from(contentBase64, 'base64'))
      return path
    }
  )
}
