/**
 * 文档服务请求辅助：统一经主进程 `http-request` IPC 发送（复用现有代理，
 * 主进程无 CORS 限制），支持二进制请求体（multipart 上传）与二进制响应。
 * 注意：渲染进程为浏览器环境，二进制/base64 全部使用 Web API 处理。
 */

/** Uint8Array → base64（浏览器环境，无 Buffer） */
function toBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** base64 → Uint8Array */
function fromBase64(base64: string): Uint8Array {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** 响应封装：提供与 fetch 类似的读取方法 */
export class DocResponse {
  private bytesData: Uint8Array

  readonly status: number

  constructor(resp: { status: number; data: string; dataBase64?: string }) {
    this.status = resp.status
    this.bytesData = resp.dataBase64
      ? fromBase64(resp.dataBase64)
      : new TextEncoder().encode(resp.data)
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300
  }

  text(): string {
    return new TextDecoder().decode(this.bytesData)
  }

  json(): unknown {
    return JSON.parse(this.text())
  }

  bytes(): Uint8Array {
    return this.bytesData
  }
}

export async function docFetch(
  url: string,
  init?: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: Uint8Array; contentType?: string }
): Promise<DocResponse> {
  const headers: Record<string, string> = {}
  if (init?.contentType) headers['Content-Type'] = init.contentType
  try {
    const resp = await window.dot.httpRequest(
      init?.method ?? 'GET',
      url,
      undefined,
      headers,
      init?.body ? toBase64(init.body) : undefined
    )
    return new DocResponse(resp)
  } catch (e) {
    throw new Error(`无法连接服务：${String(e)}`)
  }
}

/** 构造 multipart/form-data 请求体（手工拼装） */
export function buildMultipart(
  fileName: string,
  fileBytes: ArrayBuffer | Uint8Array,
  fieldName = 'file'
): { body: Uint8Array; contentType: string } {
  const boundary = `----dotai${Date.now()}${Math.random().toString(36).slice(2, 8)}`
  const encodedName = encodeURIComponent(fileName)
  const pre = new TextEncoder().encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="file"; filename*=UTF-8''${encodedName}\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
  )
  const post = new TextEncoder().encode(`\r\n--${boundary}--\r\n`)
  const file = fileBytes instanceof Uint8Array ? fileBytes : new Uint8Array(fileBytes)
  const body = new Uint8Array(pre.length + file.length + post.length)
  body.set(pre, 0)
  body.set(file, pre.length)
  body.set(post, pre.length + file.length)
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}
