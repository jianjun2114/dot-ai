<script setup lang="ts">
/**
 * 接口测试页面：HTTP / WebSocket / TCP 三种协议测试
 *
 * - HTTP：支持 GET/POST/PUT/DELETE/PATCH，JSON/表单/原始文本请求体，SSE 流式响应实时显示
 * - WebSocket：建立连接、收发消息、实时日志
 * - TCP：原始套接字连接、收发数据、实时日志
 */
import { ref, reactive, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Promotion, Link, SetUp } from '@element-plus/icons-vue'
import apiTestSvg from '../../assets/api_test.svg'
import BackHome from '../../components/BackHome.vue'

const net = window.dot.toolbox.net

// ==================== HTTP 测试 ====================
const httpMethod = ref('GET')
const httpUrl = ref('https://httpbin.org/get')
const httpSending = ref(false)
/** 请求头键值对（最后留一行空行方便追加） */
const httpHeaders = reactive<{ key: string; value: string }[]>([{ key: '', value: '' }])
/** 请求体类型：none / json / form / raw */
const httpBodyType = ref<'none' | 'json' | 'form' | 'raw'>('none')
const httpJsonBody = ref('{\n  "key": "value"\n}')
const httpRawBody = ref('')
/** 表单键值对 */
const httpFormItems = reactive<{ key: string; value: string }[]>([{ key: '', value: '' }])

interface HttpResultView {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  elapsed: number
  isSse: boolean
  sseText: string
}
const httpResult = ref<HttpResultView | null>(null)
/** 当前请求的 requestId（用于匹配 SSE 流式 chunk） */
let currentRequestId = ''

/** 构造请求头对象（过滤空行） */
const buildHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {}
  for (const { key, value } of httpHeaders) {
    if (key.trim()) headers[key.trim()] = value
  }
  return headers
}

/** 构造请求体字符串 */
const buildBody = (): string => {
  switch (httpBodyType.value) {
    case 'json':
      return httpJsonBody.value
    case 'raw':
      return httpRawBody.value
    case 'form': {
      // 表单键值对 → urlencoded 格式
      const params = new URLSearchParams()
      for (const { key, value } of httpFormItems) {
        if (key.trim()) params.append(key.trim(), value)
      }
      return params.toString()
    }
    default:
      return ''
  }
}

/** 发送 HTTP 请求 */
const sendHttp = async (): Promise<void> => {
  if (!httpUrl.value.trim()) {
    ElMessage.warning('请输入请求地址')
    return
  }
  if (httpBodyType.value === 'json') {
    try {
      JSON.parse(httpJsonBody.value || 'null')
    } catch {
      ElMessage.error('JSON 请求体格式不合法')
      return
    }
  }

  httpSending.value = true
  httpResult.value = null
  try {
    const result = await net.httpRequest({
      method: httpMethod.value,
      url: httpUrl.value.trim(),
      headers: buildHeaders(),
      body: buildBody(),
      bodyType: httpBodyType.value
    })
    currentRequestId = result.requestId
    httpResult.value = {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
      body: result.body,
      elapsed: result.elapsed,
      isSse: result.isSse,
      sseText: ''
    }
    // 尝试格式化 JSON 响应
    try {
      httpResult.value.body = JSON.stringify(JSON.parse(result.body), null, 2)
    } catch {
      // 非 JSON 响应，保持原文
    }
  } catch (e) {
    ElMessage.error(`请求失败: ${e}`)
  } finally {
    httpSending.value = false
  }
}

/** SSE 流式 chunk 订阅 */
const unsubscribeChunks = net.onHttpChunk(({ requestId, chunk }) => {
  if (requestId !== currentRequestId || !httpResult.value) return
  httpResult.value.sseText += chunk
})

// ==================== WebSocket 测试 ====================
const wsUrl = ref('wss://echo.websocket.org')
const wsConnected = ref(false)
const wsConnecting = ref(false)
const wsInput = ref('')
/** WS 连接 ID（页面内唯一即可） */
const wsConnId = 'ws-test'

interface WsLogEntry {
  direction: 'out' | 'in' | 'system'
  time: string
  data: string
}
const wsLogs = ref<WsLogEntry[]>([])

const now = (): string => new Date().toLocaleTimeString()

const pushWsLog = (entry: Omit<WsLogEntry, 'time'>): void => {
  wsLogs.value.push({ ...entry, time: now() })
}

/** 建立 WebSocket 连接 */
const connectWs = async (): Promise<void> => {
  if (!wsUrl.value.trim()) {
    ElMessage.warning('请输入 WebSocket 地址')
    return
  }
  wsConnecting.value = true
  try {
    await net.wsConnect(wsConnId, wsUrl.value.trim())
    wsConnected.value = true
    pushWsLog({ direction: 'system', data: '连接已建立' })
  } catch (e) {
    ElMessage.error(`连接失败: ${e}`)
  } finally {
    wsConnecting.value = false
  }
}

/** 发送 WebSocket 消息 */
const sendWsMessage = async (): Promise<void> => {
  if (!wsInput.value.trim()) return
  try {
    await net.wsSend(wsConnId, wsInput.value)
    pushWsLog({ direction: 'out', data: wsInput.value })
    wsInput.value = ''
  } catch (e) {
    ElMessage.error(`发送失败: ${e}`)
  }
}

/** 断开 WebSocket 连接 */
const disconnectWs = async (): Promise<void> => {
  await net.wsClose(wsConnId)
}

const unsubscribeWs = net.onWsEvent(({ connId, type, data }) => {
  if (connId !== wsConnId) return
  if (type === 'open') {
    wsConnected.value = true
  } else if (type === 'message') {
    pushWsLog({ direction: 'in', data: data || '' })
  } else if (type === 'close') {
    wsConnected.value = false
    pushWsLog({ direction: 'system', data: '连接已关闭' })
  } else if (type === 'error') {
    pushWsLog({ direction: 'system', data: `错误: ${data}` })
  }
})

// ==================== TCP 测试 ====================
const tcpHost = ref('127.0.0.1')
const tcpPort = ref(8080)
const tcpConnected = ref(false)
const tcpConnecting = ref(false)
const tcpInput = ref('')
const tcpConnId = 'tcp-test'
const tcpLogs = ref<WsLogEntry[]>([])

const pushTcpLog = (entry: Omit<WsLogEntry, 'time'>): void => {
  tcpLogs.value.push({ ...entry, time: now() })
}

/** 建立 TCP 连接 */
const connectTcp = async (): Promise<void> => {
  if (!tcpHost.value.trim() || !tcpPort.value) {
    ElMessage.warning('请输入主机地址和端口')
    return
  }
  tcpConnecting.value = true
  try {
    await net.tcpConnect(tcpConnId, tcpHost.value.trim(), tcpPort.value)
    tcpConnected.value = true
    pushTcpLog({ direction: 'system', data: `已连接 ${tcpHost.value}:${tcpPort.value}` })
  } catch (e) {
    ElMessage.error(`连接失败: ${e}`)
  } finally {
    tcpConnecting.value = false
  }
}

/** 发送 TCP 数据 */
const sendTcpData = async (): Promise<void> => {
  if (!tcpInput.value) return
  try {
    await net.tcpSend(tcpConnId, tcpInput.value)
    pushTcpLog({ direction: 'out', data: tcpInput.value })
    tcpInput.value = ''
  } catch (e) {
    ElMessage.error(`发送失败: ${e}`)
  }
}

/** 断开 TCP 连接 */
const disconnectTcp = async (): Promise<void> => {
  await net.tcpClose(tcpConnId)
}

const unsubscribeTcp = net.onTcpEvent(({ connId, type, data }) => {
  if (connId !== tcpConnId) return
  if (type === 'data') {
    pushTcpLog({ direction: 'in', data: data || '' })
  } else if (type === 'close') {
    tcpConnected.value = false
    pushTcpLog({ direction: 'system', data: '连接已断开' })
  } else if (type === 'error') {
    pushTcpLog({ direction: 'system', data: `错误: ${data}` })
  }
})

// 页面卸载时清理所有订阅与连接
onUnmounted(() => {
  unsubscribeChunks()
  unsubscribeWs()
  unsubscribeTcp()
  if (wsConnected.value) disconnectWs()
  if (tcpConnected.value) disconnectTcp()
})
</script>

<template>
  <div class="api-page">
    <!-- 顶栏 -->
    <header class="api-header">
      <div class="api-header-left">
        <BackHome />
        <div class="api-header-brand">
          <div class="api-header-badge">
            <img :src="apiTestSvg" alt="接口测试" class="api-header-icon" />
          </div>
          <span class="api-header-title">接口测试</span>
        </div>
      </div>
    </header>

    <main class="api-main">
      <el-tabs type="border-card" class="api-tabs">
        <!-- ==================== HTTP ==================== -->
        <el-tab-pane label="HTTP 请求">
          <!-- 请求行：方法 + 地址 + 发送 -->
          <div class="request-line">
            <el-select v-model="httpMethod" class="method-select">
              <el-option
                v-for="m in ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']"
                :key="m"
                :label="m"
                :value="m"
              />
            </el-select>
            <el-input
              v-model="httpUrl"
              placeholder="请求地址，如 https://api.example.com/users"
              clearable
            >
              <template #prefix
                ><el-icon><Link /></el-icon
              ></template>
            </el-input>
            <el-button type="primary" :icon="Promotion" :loading="httpSending" @click="sendHttp"
              >发送</el-button
            >
          </div>

          <!-- 请求配置 -->
          <div class="request-config">
            <el-collapse>
              <el-collapse-item title="请求头 Headers" name="headers">
                <div v-for="(h, i) in httpHeaders" :key="i" class="kv-row">
                  <el-input v-model="h.key" placeholder="Header 名称" />
                  <el-input v-model="h.value" placeholder="值" />
                  <el-button
                    v-if="httpHeaders.length > 1"
                    circle
                    size="small"
                    @click="httpHeaders.splice(i, 1)"
                  >
                    ×
                  </el-button>
                </div>
                <el-button size="small" @click="httpHeaders.push({ key: '', value: '' })"
                  >添加请求头</el-button
                >
              </el-collapse-item>

              <el-collapse-item title="请求体 Body" name="body">
                <el-radio-group v-model="httpBodyType">
                  <el-radio-button value="none">无</el-radio-button>
                  <el-radio-button value="json">JSON</el-radio-button>
                  <el-radio-button value="form">表单</el-radio-button>
                  <el-radio-button value="raw">原始文本</el-radio-button>
                </el-radio-group>

                <div class="body-editor">
                  <!-- JSON / 原始文本：文本域 -->
                  <el-input
                    v-if="httpBodyType === 'json'"
                    v-model="httpJsonBody"
                    type="textarea"
                    :rows="6"
                    placeholder="请求体内容（JSON）"
                  />
                  <el-input
                    v-else-if="httpBodyType === 'raw'"
                    v-model="httpRawBody"
                    type="textarea"
                    :rows="6"
                    placeholder="原始文本内容"
                  />
                  <!-- 表单：键值对 -->
                  <template v-else-if="httpBodyType === 'form'">
                    <div v-for="(f, i) in httpFormItems" :key="i" class="kv-row">
                      <el-input v-model="f.key" placeholder="字段名" />
                      <el-input v-model="f.value" placeholder="值" />
                      <el-button
                        v-if="httpFormItems.length > 1"
                        circle
                        size="small"
                        @click="httpFormItems.splice(i, 1)"
                      >
                        ×
                      </el-button>
                    </div>
                    <el-button size="small" @click="httpFormItems.push({ key: '', value: '' })"
                      >添加字段</el-button
                    >
                  </template>
                  <span v-else class="body-tip">GET 等请求通常无需请求体</span>
                </div>
              </el-collapse-item>
            </el-collapse>
          </div>

          <!-- 响应结果 -->
          <div v-if="httpResult" class="response-area">
            <div class="response-meta">
              <el-tag :type="httpResult.status < 400 ? 'success' : 'danger'">
                {{ httpResult.status }} {{ httpResult.statusText }}
              </el-tag>
              <el-tag type="info">{{ httpResult.elapsed }} ms</el-tag>
              <el-tag v-if="httpResult.isSse" type="warning">SSE 流式响应</el-tag>
            </div>

            <!-- 普通响应体 -->
            <pre v-if="!httpResult.isSse" class="response-body">{{
              httpResult.body || '（空响应）'
            }}</pre>
            <!-- SSE 流式内容实时追加 -->
            <pre v-else class="response-body sse">{{
              httpResult.sseText || '（等待事件推送...）'
            }}</pre>

            <el-collapse>
              <el-collapse-item title="响应头 Headers" name="res-headers">
                <pre class="response-headers">{{
                  JSON.stringify(httpResult.headers, null, 2)
                }}</pre>
              </el-collapse-item>
            </el-collapse>
          </div>
        </el-tab-pane>

        <!-- ==================== WebSocket ==================== -->
        <el-tab-pane label="WebSocket">
          <div class="request-line">
            <el-input v-model="wsUrl" placeholder="ws:// 或 wss:// 地址">
              <template #prefix
                ><el-icon><SetUp /></el-icon
              ></template>
            </el-input>
            <el-button
              v-if="!wsConnected"
              type="primary"
              :loading="wsConnecting"
              @click="connectWs"
            >
              连接
            </el-button>
            <el-button v-else type="danger" @click="disconnectWs">断开</el-button>
            <el-tag :type="wsConnected ? 'success' : 'info'">
              {{ wsConnected ? '已连接' : '未连接' }}
            </el-tag>
          </div>

          <div class="io-area">
            <div class="log-area">
              <div v-for="(log, i) in wsLogs" :key="i" class="log-item" :class="log.direction">
                <span class="log-time">{{ log.time }}</span>
                <span class="log-dir">{{
                  log.direction === 'out' ? '→ 发送' : log.direction === 'in' ? '← 收到' : '系统'
                }}</span>
                <span class="log-data">{{ log.data }}</span>
              </div>
              <el-empty v-if="wsLogs.length === 0" description="暂无消息" :image-size="60" />
            </div>
            <div class="send-row">
              <el-input
                v-model="wsInput"
                type="textarea"
                :rows="3"
                placeholder="输入要发送的消息"
                :disabled="!wsConnected"
              />
              <el-button type="primary" :disabled="!wsConnected" @click="sendWsMessage"
                >发送</el-button
              >
            </div>
          </div>
        </el-tab-pane>

        <!-- ==================== TCP ==================== -->
        <el-tab-pane label="TCP">
          <div class="request-line">
            <el-input v-model="tcpHost" placeholder="主机地址" style="width: 240px" />
            <el-input-number v-model="tcpPort" :min="1" :max="65535" />
            <el-button
              v-if="!tcpConnected"
              type="primary"
              :loading="tcpConnecting"
              @click="connectTcp"
            >
              连接
            </el-button>
            <el-button v-else type="danger" @click="disconnectTcp">断开</el-button>
            <el-tag :type="tcpConnected ? 'success' : 'info'">
              {{ tcpConnected ? '已连接' : '未连接' }}
            </el-tag>
          </div>

          <div class="io-area">
            <div class="log-area">
              <div v-for="(log, i) in tcpLogs" :key="i" class="log-item" :class="log.direction">
                <span class="log-time">{{ log.time }}</span>
                <span class="log-dir">{{
                  log.direction === 'out' ? '→ 发送' : log.direction === 'in' ? '← 收到' : '系统'
                }}</span>
                <span class="log-data">{{ log.data }}</span>
              </div>
              <el-empty v-if="tcpLogs.length === 0" description="暂无数据" :image-size="60" />
            </div>
            <div class="send-row">
              <el-input
                v-model="tcpInput"
                type="textarea"
                :rows="3"
                placeholder="输入要发送的文本数据"
                :disabled="!tcpConnected"
              />
              <el-button type="primary" :disabled="!tcpConnected" @click="sendTcpData"
                >发送</el-button
              >
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </main>
  </div>
</template>

<style scoped>
.api-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
}

.api-header {
  display: flex;
  align-items: center;
  padding: 10px 16px;
  background: var(--color-card);
  border-bottom: 1px solid var(--color-border);
  /* 语义色底部渐变线 */
  box-shadow: inset 0 -2px 0 0 var(--color-success);
}

.api-header-left {
  display: flex;
  align-items: center;
  gap: 16px;
  color: var(--color-text);
}

.api-header-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.api-header-badge {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--color-success);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px color-mix(in srgb, var(--color-success) 35%, transparent);
}

.api-header-icon {
  width: 20px;
  height: 20px;
}

.api-header-title {
  font-size: 16px;
  font-weight: 600;
}

.api-main {
  flex: 1;
  min-height: 0;
  padding: 12px;
}

.api-tabs {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.api-tabs :deep(.el-tabs__content) {
  flex: 1;
  overflow-y: auto;
}

/* 请求行：方法 + 地址 + 按钮 */
.request-line {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
}

.method-select {
  width: 110px;
}

/* 键值对编辑行 */
.kv-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  align-items: center;
}

.body-editor {
  margin-top: 12px;
}

.body-tip {
  color: var(--color-text-secondary);
  font-size: 13px;
}

/* 响应区 */
.response-area {
  margin-top: 16px;
  border-top: 1px solid var(--color-border);
  padding-top: 12px;
}

.response-meta {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.response-body {
  background: var(--color-card);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  padding: 12px;
  border-radius: 8px;
  font-size: 13px;
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.response-body.sse {
  color: var(--color-success);
}

.response-headers {
  font-size: 12px;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
}

/* WS / TCP 收发区 */
.io-area {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.log-area {
  background: var(--color-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 12px;
  height: 300px;
  overflow-y: auto;
  font-size: 13px;
}

.log-item {
  display: flex;
  gap: 8px;
  margin-bottom: 6px;
  font-family: Consolas, monospace;
}

.log-time {
  color: var(--color-text-secondary);
}

.log-item.out .log-dir {
  color: var(--color-primary);
}

.log-item.in .log-dir {
  color: var(--color-success);
}

.log-item.system .log-dir {
  color: var(--color-warning);
}

.log-data {
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-all;
}

.send-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
</style>
