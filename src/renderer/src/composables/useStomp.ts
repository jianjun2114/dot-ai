import { ref, onUnmounted, getCurrentInstance, type Ref } from 'vue'

export interface StompMessage {
  body: string
  headers: Record<string, string>
}

export interface UseStompOptions {
  url: string
  reconnectInterval?: number
  heartbeat?: number
}

/** useStomp 返回的 API 集合 */
export interface StompApi {
  connected: Ref<boolean>
  error: Ref<Error | null>
  connect: () => Promise<void>
  disconnect: () => void
  subscribe: (destination: string, callback: (message: StompMessage) => void) => string
  unsubscribe: (destination: string) => void
  publish: (destination: string, body: string, headers?: Record<string, string>) => void
}

/** useSSE 返回的 API 集合 */
export interface SseApi {
  processStream: (reader: ReadableStreamDefaultReader<Uint8Array>) => Promise<void>
}

export function useStomp(options: UseStompOptions): StompApi {
  const { url, reconnectInterval = 5000, heartbeat = 25000 } = options

  const connected = ref(false)
  const error = ref<Error | null>(null)
  const subscriptions = ref<Map<string, (message: StompMessage) => void>>(new Map())

  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  // 主动断开标志：disconnect 后不再自动重连
  let manualClosed = false

  // STOMP 帧处理
  const parseFrame = (
    frame: string
  ): { command: string; headers: Record<string, string>; body: string } => {
    const lines = frame.split('\n')
    const command = lines[0].trim()
    const headers: Record<string, string> = {}
    let body = ''
    let inBody = false

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      if (line === '\0' || line === '') {
        inBody = true
        continue
      }
      if (inBody) {
        body += line + '\n'
      } else {
        const colonIndex = line.indexOf(':')
        if (colonIndex > 0) {
          const key = line.substring(0, colonIndex)
          const value = line.substring(colonIndex + 1)
          headers[key] = value
        }
      }
    }

    return { command, headers, body: body.trim() }
  }

  // 发送 STOMP 帧
  const sendFrame = (
    command: string,
    headers: Record<string, string> = {},
    body: string = ''
  ): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error('WebSocket not connected')
      return
    }

    let frame = command + '\n'
    for (const [key, value] of Object.entries(headers)) {
      frame += `${key}:${value}\n`
    }
    frame += '\n'
    if (body) {
      frame += body
    }
    frame += '\0'

    ws.send(frame)
  }

  // 处理接收到的消息
  const handleMessage = (event: MessageEvent): void => {
    const { command, headers, body } = parseFrame(event.data)

    switch (command) {
      case 'MESSAGE': {
        const destination = headers['destination']
        const callback = subscriptions.value.get(destination)
        if (callback) {
          callback({ body, headers })
        }
        break
      }
      case 'CONNECTED':
        connected.value = true
        error.value = null
        console.log('STOMP connected')
        // 发送心跳
        startHeartbeat()
        break
      case 'ERROR':
        error.value = new Error(headers['message'] || 'STOMP error')
        console.error('STOMP error:', headers['message'])
        break
      case 'DISCONNECTED':
        connected.value = false
        break
    }
  }

  // 心跳
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

  const startHeartbeat = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
    }
    heartbeatTimer = setInterval(() => {
      if (connected.value) {
        sendFrame('PING')
      }
    }, heartbeat)
  }

  // 连接
  const connect = (): Promise<void> => {
    manualClosed = false
    return new Promise((resolve, reject) => {
      try {
        ws = new WebSocket(url)

        ws.onopen = () => {
          // 发送 CONNECT 帧
          sendFrame('CONNECT', {
            'accept-version': '1.2',
            'heart-beat': `${heartbeat},${heartbeat}`
          })
          resolve()
        }

        ws.onmessage = handleMessage

        ws.onerror = () => {
          error.value = new Error('WebSocket error')
          reject(error.value)
        }

        ws.onclose = () => {
          connected.value = false
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer)
          }
          // 自动重连
          scheduleReconnect()
        }
      } catch (e) {
        reject(e)
      }
    })
  }

  // 断开连接
  const disconnect = (): void => {
    manualClosed = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    if (ws) {
      sendFrame('DISCONNECT')
      ws.close()
      ws = null
    }
    connected.value = false
  }

  // 订阅主题
  const subscribe = (destination: string, callback: (message: StompMessage) => void): string => {
    const subscriptionId = `sub-${Date.now()}`
    subscriptions.value.set(destination, callback)

    if (connected.value) {
      sendFrame('SUBSCRIBE', {
        id: subscriptionId,
        destination
      })
    }

    return subscriptionId
  }

  // 取消订阅
  const unsubscribe = (destination: string): void => {
    subscriptions.value.delete(destination)
    if (connected.value) {
      sendFrame('UNSUBSCRIBE', { id: destination })
    }
  }

  // 发布消息
  const publish = (
    destination: string,
    body: string,
    headers: Record<string, string> = {}
  ): void => {
    sendFrame(
      'SEND',
      {
        destination,
        'content-type': 'application/json',
        ...headers
      },
      body
    )
  }

  // 重连
  const scheduleReconnect = (): void => {
    if (manualClosed || reconnectTimer) return

    reconnectTimer = setTimeout(() => {
      console.log('Attempting to reconnect...')
      connect().catch(() => {
        // 连接失败，等待下一次重连
      })
      reconnectTimer = null
    }, reconnectInterval)
  }

  // 组件上下文中随组件卸载自动断开；非组件调用（如 utils 中）跳过，由调用方自行 disconnect
  if (getCurrentInstance()) {
    onUnmounted(() => {
      disconnect()
    })
  }

  return {
    connected,
    error,
    connect,
    disconnect,
    subscribe,
    unsubscribe,
    publish
  }
}

// SSE 流式响应处理
export interface UseSSEOptions {
  onChunk?: (content: string, done: boolean) => void
  onError?: (error: Error) => void
}

export function useSSE(options: UseSSEOptions): SseApi {
  const { onChunk, onError } = options

  const parseSSELine = (line: string): { event?: string; data?: string } => {
    if (!line.startsWith('data:')) return {}

    const data = line.slice(5).trim()
    if (data === '[DONE]') {
      return { event: 'done', data: '' }
    }

    try {
      const parsed = JSON.parse(data)
      return { event: 'message', data: parsed.content || parsed.delta?.content || '' }
    } catch {
      return { event: 'message', data }
    }
  }

  const processStream = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          if (buffer) {
            const { data } = parseSSELine(buffer)
            if (data) {
              onChunk?.(data, true)
            }
          }
          onChunk?.('', true)
          break
        }

        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data:')) {
            const { event, data } = parseSSELine(line)
            if (event === 'done') {
              onChunk?.('', true)
              return
            }
            if (data) {
              onChunk?.(data, false)
            }
          }
        }
      }
    } catch (e) {
      onError?.(e as Error)
    }
  }

  return {
    processStream
  }
}
