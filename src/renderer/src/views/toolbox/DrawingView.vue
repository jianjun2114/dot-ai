<script setup lang="ts">
/**
 * DrawingView.vue —— 百宝箱 · 画图模块（PS 风格顶部工具栏）
 *
 * 顶部工具栏分四区：
 * - 工具区：画笔 / 橡皮 / 油漆桶填充 / 直线 / 文字 / 选区
 * - 功能区：旋转（左/右）、选区拖拽（配合工具区选区）、放大 / 缩小 / 适应、撤销 / 重做 / 清空
 * - 形状区：矩形、圆角矩形、圆、三~六角多边形、箭头、星、心、气泡
 * - 颜色区：5 个默认色板 + 描边 / 填充调色板 + 吸色器（画布取色）
 * 其他：背景切换、画布大小、导出分辨率、图片导入导出、AI 识别 / 生成
 */
import { ref, reactive, computed, onMounted, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import {
  EditPen,
  Delete,
  Remove,
  Download,
  Upload,
  RefreshLeft,
  RefreshRight,
  View,
  MagicStick,
  Refresh,
  Crop,
  CircleCheck,
  ZoomIn,
  ZoomOut,
  FullScreen
} from '@element-plus/icons-vue'
import BackHome from '../../components/BackHome.vue'
import drawingSvg from '../../assets/ps_canvs.svg'
import { sendLlm, type LlmChatMessage, type LlmContentPart } from '../../utils/aiRequest'

/* ================================ 工具定义 ================================ */

type ToolKey =
  | 'brush'
  | 'eraser'
  | 'fill'
  | 'line'
  | 'text'
  | 'select'
  | 'picker'
  | 'rect'
  | 'roundRect'
  | 'circle'
  | 'poly3'
  | 'poly4'
  | 'poly5'
  | 'poly6'
  | 'arrow'
  | 'star'
  | 'heart'
  | 'bubble'

const SHAPE_KEYS: ToolKey[] = [
  'rect',
  'roundRect',
  'circle',
  'poly3',
  'poly4',
  'poly5',
  'poly6',
  'arrow',
  'star',
  'heart',
  'bubble'
]

const isShape = (t: ToolKey): boolean => SHAPE_KEYS.includes(t)

/** 工具区（画笔类） */
const toolGroup: { key: ToolKey; label: string; icon?: typeof EditPen; text?: string }[] = [
  { key: 'brush', label: '画笔', icon: EditPen },
  { key: 'eraser', label: '橡皮', icon: Delete },
  { key: 'fill', label: '油漆桶填充', text: '桶' },
  { key: 'line', label: '直线', icon: Remove },
  { key: 'text', label: '文字', text: '文' },
  { key: 'select', label: '选区（拖拽移动）', icon: Crop }
]

/** 形状区 */
const shapeGroup: { key: ToolKey; label: string; text: string }[] = [
  { key: 'rect', label: '矩形', text: '矩形' },
  { key: 'roundRect', label: '圆角矩形', text: '圆角' },
  { key: 'circle', label: '圆 / 椭圆', text: '圆' },
  { key: 'poly3', label: '三角形', text: '3角' },
  { key: 'poly4', label: '四边形', text: '4角' },
  { key: 'poly5', label: '五边形', text: '5角' },
  { key: 'poly6', label: '六边形', text: '6角' },
  { key: 'arrow', label: '箭头', text: '箭头' },
  { key: 'star', label: '五角星', text: '星' },
  { key: 'heart', label: '心形', text: '心' },
  { key: 'bubble', label: '对话气泡', text: '气泡' }
]

const currentTool = ref<ToolKey>('brush')
/** 线宽（画笔 / 橡皮 / 形状描边通用，文字字号按其推导） */
const brushWidth = ref(4)

/* ================================ 颜色 ================================ */

/** 默认 5 色板 */
const defaultSwatches = ['#000000', '#ffffff', '#e74c3c', '#3498db', '#2ecc71']
const strokeColor = ref('#409eff')
const fillColor = ref('#f5da55')
/** 形状是否填充 */
const fillEnabled = ref(false)

const applySwatch = (color: string): void => {
  strokeColor.value = color
}

/* ================================ 画布设置 ================================ */

const canvasWidth = ref(800)
const canvasHeight = ref(600)
/** 画布视图缩放（仅显示，不改像素） */
const zoom = ref(1)
/** 导出分辨率倍数 */
const exportScale = ref(1)
const exportFormat = ref<'png' | 'jpeg'>('png')

const backgrounds: { key: string; label: string; color: string | null }[] = [
  { key: 'white', label: '白', color: '#ffffff' },
  { key: 'transparent', label: '透', color: null },
  { key: 'gray', label: '灰', color: '#f5f5f5' },
  { key: 'dark', label: '深', color: '#1e1e1e' },
  { key: 'custom', label: '自定义', color: '#fdf6ec' }
]
const bgKey = ref('white')
const customBgColor = ref('#fdf6ec')

const bgColor = computed<string | null>(() => {
  const bg = backgrounds.find((b) => b.key === bgKey.value)
  if (!bg) return '#ffffff'
  return bg.key === 'custom' ? customBgColor.value : bg.color
})

/* ================================ 画布核心 ================================ */

const canvasRef = ref<HTMLCanvasElement | null>(null)
const stageRef = ref<HTMLDivElement | null>(null)
let ctx: CanvasRenderingContext2D | null = null

/** 撤销 / 重做栈（ImageData 快照，限制 30 步防内存膨胀） */
const undoStack: ImageData[] = []
const redoStack: ImageData[] = []
const canUndo = ref(false)
const canRedo = ref(false)

const refreshStackState = (): void => {
  canUndo.value = undoStack.length > 0
  canRedo.value = redoStack.length > 0
}

const clearStacks = (): void => {
  undoStack.length = 0
  redoStack.length = 0
  refreshStackState()
}

const snapshot = (): ImageData | null => {
  const canvas = canvasRef.value
  if (!ctx || !canvas) return null
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

const pushUndo = (): void => {
  const snap = snapshot()
  if (!snap) return
  undoStack.push(snap)
  if (undoStack.length > 30) undoStack.shift()
  redoStack.length = 0
  refreshStackState()
}

const restore = (snap: ImageData): void => {
  ctx?.putImageData(snap, 0, 0)
}

const undo = (): void => {
  if (!ctx || undoStack.length === 0) return
  commitSelection()
  const cur = snapshot()
  if (cur) redoStack.push(cur)
  restore(undoStack.pop()!)
  refreshStackState()
}

const redo = (): void => {
  if (!ctx || redoStack.length === 0) return
  commitSelection()
  const cur = snapshot()
  if (cur) undoStack.push(cur)
  restore(redoStack.pop()!)
  refreshStackState()
}

/** 用背景色填充整个画布（透明背景则清空），并同步记录当前底色 */
const fillBackground = (): void => {
  const canvas = canvasRef.value
  if (!ctx || !canvas) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (bgColor.value) {
    ctx.fillStyle = bgColor.value
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  appliedBg = bgColor.value
}

const initCanvas = (): void => {
  const canvas = canvasRef.value
  if (!canvas) return
  ctx = canvas.getContext('2d', { willReadFrequently: true })
  canvas.width = canvasWidth.value
  canvas.height = canvasHeight.value
  ctx!.imageSmoothingEnabled = true
  fillBackground()
}

/** 应用尺寸修改：新建尺寸并把旧内容贴回左上角（历史清空） */
const applySize = (): void => {
  const w = Math.max(16, Math.min(8192, Math.floor(canvasWidth.value) || 800))
  const h = Math.max(16, Math.min(8192, Math.floor(canvasHeight.value) || 600))
  canvasWidth.value = w
  canvasHeight.value = h
  const canvas = canvasRef.value
  if (!canvas) return
  commitSelection()
  const tmp = document.createElement('canvas')
  tmp.width = canvas.width
  tmp.height = canvas.height
  tmp.getContext('2d')?.drawImage(canvas, 0, 0)
  canvas.width = w
  canvas.height = h
  ctx = canvas.getContext('2d', { willReadFrequently: true })
  fillBackground()
  ctx!.drawImage(tmp, 0, 0)
  clearStacks()
  ElMessage.success(`画布已调整为 ${w} × ${h}`)
}

/** 当前已铺在画布上的背景色（null 表示透明），用于换背景时抠掉旧底色 */
let appliedBg: string | null = '#ffffff'

/** 切换背景：把旧背景像素抠透明后铺新底色，笔迹实时保留 */
const setBackground = (key: string): void => {
  const newColor = backgrounds.find((b) => b.key === key)?.color ?? '#ffffff'
  const resolved = key === 'custom' ? customBgColor.value : newColor
  bgKey.value = key
  repaintBackground(resolved)
}

/** 自定义背景色调整后重铺 */
const applyCustomBackground = (): void => {
  repaintBackground(customBgColor.value)
}

const repaintBackground = (newColor: string | null): void => {
  const canvas = canvasRef.value
  if (!ctx || !canvas) return
  commitSelection()
  pushUndo()
  const old = appliedBg
  const tmp = document.createElement('canvas')
  tmp.width = canvas.width
  tmp.height = canvas.height
  const tctx = tmp.getContext('2d')!
  if (old) {
    // 旧底色像素容差抠透明，只留笔迹
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const px = img.data
    const or = parseInt(old.slice(1, 3), 16)
    const og = parseInt(old.slice(3, 5), 16)
    const ob = parseInt(old.slice(5, 7), 16)
    const oa = old ? 255 : 0
    const tol = 12
    for (let i = 0; i < px.length; i += 4) {
      const dr = px[i] - or
      const dg = px[i + 1] - og
      const db = px[i + 2] - ob
      const da = px[i + 3] - oa
      if (dr * dr + dg * dg + db * db + da * da <= tol * tol * 4) px[i + 3] = 0
    }
    tctx.putImageData(img, 0, 0)
  } else {
    tctx.drawImage(canvas, 0, 0)
  }
  fillBackground()
  ctx.drawImage(tmp, 0, 0)
  appliedBg = newColor
}

/* ================================ 缩放 / 旋转 ================================ */

const setZoom = (z: number): void => {
  zoom.value = Math.min(5, Math.max(0.1, Math.round(z * 100) / 100))
}

const zoomIn = (): void => setZoom(zoom.value * 1.25)
const zoomOut = (): void => setZoom(zoom.value / 1.25)

/** 适应窗口：按容器与画布尺寸计算缩放 */
const zoomFit = (): void => {
  const stage = stageRef.value
  if (!stage) return
  const z = Math.min(
    (stage.clientWidth - 48) / canvasWidth.value,
    (stage.clientHeight - 48) / canvasHeight.value,
    1
  )
  setZoom(z)
}

/** 旋转画布内容 90°（dir=1 顺时针 / -1 逆时针），画布宽高互换（历史清空） */
const rotateCanvas = (dir: 1 | -1): void => {
  const canvas = canvasRef.value
  if (!canvas) return
  commitSelection()
  const oldW = canvas.width
  const oldH = canvas.height
  const tmp = document.createElement('canvas')
  tmp.width = oldW
  tmp.height = oldH
  tmp.getContext('2d')?.drawImage(canvas, 0, 0)
  const newW = oldH
  const newH = oldW
  canvas.width = newW
  canvas.height = newH
  ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx!.save()
  ctx!.translate(newW / 2, newH / 2)
  ctx!.rotate((dir * Math.PI) / 2)
  ctx!.drawImage(tmp, -oldW / 2, -oldH / 2)
  ctx!.restore()
  canvasWidth.value = newW
  canvasHeight.value = newH
  clearStacks()
  ElMessage.success(dir === 1 ? '已顺时针旋转 90°' : '已逆时针旋转 90°')
}

/* ================================ 选区（拖拽移动元素） ================================ */

interface SelectionState {
  active: boolean
  marquee: boolean
  mx: number
  my: number
  mex: number
  mey: number
  mw: number
  mh: number
  data: ImageData | null
  x: number
  y: number
  w: number
  h: number
  originX: number
  originY: number
  dragging: boolean
  offsetX: number
  offsetY: number
}

const sel = reactive<SelectionState>({
  active: false,
  marquee: false,
  mx: 0,
  my: 0,
  mex: 0,
  mey: 0,
  mw: 0,
  mh: 0,
  data: null,
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  originX: 0,
  originY: 0,
  dragging: false,
  offsetX: 0,
  offsetY: 0
})

const selCanvasRef = ref<HTMLCanvasElement | null>(null)

/** 把选区内容提交回画布（应用 / 取消 均为贴回指定位置） */
const commitSelection = (): void => {
  if (!sel.active || !sel.data || !ctx) return
  ctx.putImageData(sel.data, Math.round(sel.x), Math.round(sel.y))
  sel.active = false
  sel.data = null
}

const cancelSelection = (): void => {
  if (!sel.active || !sel.data) return
  sel.x = sel.originX
  sel.y = sel.originY
  commitSelection()
}

/** 从画布裁剪出选区（透明背景挖空，有色背景填底色） */
const cutSelection = (x: number, y: number, w: number, h: number): void => {
  if (!ctx) return
  const data = ctx.getImageData(x, y, w, h)
  if (bgColor.value) {
    ctx.fillStyle = bgColor.value
    ctx.fillRect(x, y, w, h)
  } else {
    ctx.clearRect(x, y, w, h)
  }
  sel.data = data
  sel.x = x
  sel.y = y
  sel.w = w
  sel.h = h
  sel.originX = x
  sel.originY = y
  sel.active = true
  nextTick(renderSelCanvas)
}

/** 选区浮动层渲染 */
const renderSelCanvas = (): void => {
  const sc = selCanvasRef.value
  if (!sc || !sel.data) return
  sc.width = sel.w
  sc.height = sel.h
  sc.getContext('2d')?.putImageData(sel.data, 0, 0)
}

const onSelPointerDown = (e: PointerEvent): void => {
  if (!sel.active) return
  e.stopPropagation()
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  const canvas = canvasRef.value!
  const rect = canvas.getBoundingClientRect()
  const px = ((e.clientX - rect.left) * canvas.width) / rect.width
  const py = ((e.clientY - rect.top) * canvas.height) / rect.height
  sel.dragging = true
  sel.offsetX = px - sel.x
  sel.offsetY = py - sel.y
}

const onSelPointerMove = (e: PointerEvent): void => {
  if (!sel.dragging) return
  const canvas = canvasRef.value!
  const rect = canvas.getBoundingClientRect()
  const px = ((e.clientX - rect.left) * canvas.width) / rect.width
  const py = ((e.clientY - rect.top) * canvas.height) / rect.height
  sel.x = Math.round(px - sel.offsetX)
  sel.y = Math.round(py - sel.offsetY)
}

const onSelPointerUp = (): void => {
  sel.dragging = false
}

/* ================================ 文字（画布内联输入） ================================ */

const textEditing = reactive({ visible: false, x: 0, y: 0, canvasX: 0, canvasY: 0, value: '' })
const textInputRef = ref<HTMLTextAreaElement | null>(null)

const openTextEditor = (e: PointerEvent): void => {
  const canvas = canvasRef.value!
  const wrapRect = (canvas.parentElement as HTMLElement).getBoundingClientRect()
  const rect = canvas.getBoundingClientRect()
  const cx = ((e.clientX - rect.left) * canvas.width) / rect.width
  const cy = ((e.clientY - rect.top) * canvas.height) / rect.height
  textEditing.visible = true
  textEditing.canvasX = cx
  textEditing.canvasY = cy
  // 父容器被 scale(zoom) 缩放，CSS 坐标需除回 zoom
  textEditing.x = (e.clientX - wrapRect.left) / zoom.value
  textEditing.y = (e.clientY - wrapRect.top) / zoom.value
  textEditing.value = ''
  nextTick(() => textInputRef.value?.focus())
}

/** 提交文字：按当前线宽推导字号绘制到画布 */
const commitText = (): void => {
  const value = textEditing.value.trim()
  textEditing.visible = false
  if (!value || !ctx) return
  pushUndo()
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = strokeColor.value
  ctx.font = `${Math.max(12, brushWidth.value * 6)}px sans-serif`
  ctx.textBaseline = 'top'
  ctx.fillText(value, textEditing.canvasX, textEditing.canvasY)
}

/* ================================ 绘制交互 ================================ */

interface DrawState {
  drawing: boolean
  startX: number
  startY: number
  previewSnap: ImageData | null
}

const drawState = reactive<DrawState>({ drawing: false, startX: 0, startY: 0, previewSnap: null })

/** CSS 显示坐标 → 画布像素坐标（画布可能被 CSS 缩放） */
const toCanvasPos = (e: PointerEvent): { x: number; y: number } => {
  const canvas = canvasRef.value!
  const rect = canvas.getBoundingClientRect()
  return {
    x: ((e.clientX - rect.left) * canvas.width) / rect.width,
    y: ((e.clientY - rect.top) * canvas.height) / rect.height
  }
}

const beginStroke = (): void => {
  if (!ctx) return
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = brushWidth.value
  if (currentTool.value === 'eraser') {
    const color = bgColor.value
    if (color) {
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = color
    } else {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.strokeStyle = 'rgba(0,0,0,1)'
    }
  } else {
    ctx.globalCompositeOperation = 'source-over'
    ctx.strokeStyle = strokeColor.value
  }
}

/* ---------- 形状绘制 ---------- */

/** 正多边形顶点路径（cx/cy 中心，rx/ry 半径，n 角数） */
const polyPath = (cx: number, cy: number, rx: number, ry: number, n: number): void => {
  ctx!.beginPath()
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n
    const px = cx + rx * Math.cos(a)
    const py = cy + ry * Math.sin(a)
    if (i === 0) ctx!.moveTo(px, py)
    else ctx!.lineTo(px, py)
  }
  ctx!.closePath()
}

/** 五角星路径（外/内半径交替） */
const starPath = (cx: number, cy: number, rx: number, ry: number): void => {
  ctx!.beginPath()
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 1 : 0.42
    const a = -Math.PI / 2 + (i * Math.PI) / 5
    const px = cx + rx * r * Math.cos(a)
    const py = cy + ry * r * Math.sin(a)
    if (i === 0) ctx!.moveTo(px, py)
    else ctx!.lineTo(px, py)
  }
  ctx!.closePath()
}

/** 心形路径（贝塞尔） */
const heartPath = (cx: number, cy: number, rx: number, ry: number): void => {
  ctx!.beginPath()
  const topY = cy - ry * 0.35
  ctx!.moveTo(cx, cy + ry * 0.9)
  ctx!.bezierCurveTo(cx - rx * 1.25, cy + ry * 0.05, cx - rx * 0.55, topY - ry * 0.35, cx, topY + ry * 0.25)
  ctx!.bezierCurveTo(cx + rx * 0.55, topY - ry * 0.35, cx + rx * 1.25, cy + ry * 0.05, cx, cy + ry * 0.9)
  ctx!.closePath()
}

/** 箭头路径（线杆 + 三角头） */
const arrowPath = (sx: number, sy: number, ex: number, ey: number): void => {
  const angle = Math.atan2(ey - sy, ex - sx)
  const headLen = Math.max(12, brushWidth.value * 4)
  const wing = Math.PI / 7
  ctx!.beginPath()
  ctx!.moveTo(sx, sy)
  ctx!.lineTo(ex, ey)
  ctx!.moveTo(ex, ey)
  ctx!.lineTo(ex - headLen * Math.cos(angle - wing), ey - headLen * Math.sin(angle - wing))
  ctx!.moveTo(ex, ey)
  ctx!.lineTo(ex - headLen * Math.cos(angle + wing), ey - headLen * Math.sin(angle + wing))
}

/** 气泡路径（圆角矩形 + 尾巴） */
const bubblePath = (x: number, y: number, w: number, h: number): void => {
  const r = Math.min(16, w / 4, h / 4)
  ctx!.beginPath()
  ctx!.roundRect(x, y, w, h * 0.78, r)
  // 尾巴（左下）
  const tailY = y + h * 0.78
  ctx!.moveTo(x + w * 0.22, tailY - 1)
  ctx!.lineTo(x + w * 0.14, y + h)
  ctx!.lineTo(x + w * 0.36, tailY - 1)
  ctx!.closePath()
}

/** 绘制形状（拖拽预览 / 最终绘制共用）：sx/sy 起点，x/y 当前点 */
const drawShape = (shape: ToolKey, sx: number, sy: number, x: number, y: number): void => {
  if (!ctx) return
  ctx.globalCompositeOperation = 'source-over'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = brushWidth.value
  ctx.strokeStyle = strokeColor.value
  ctx.fillStyle = fillColor.value

  // 线条类仅描边；封闭形状按“形状填充”开关决定是否填充，始终描边
  const fillIt = fillEnabled.value && shape !== 'line' && shape !== 'arrow'

  const paint = (): void => {
    if (fillIt) ctx!.fill()
    ctx!.stroke()
  }

  switch (shape) {
    case 'rect':
      ctx.beginPath()
      ctx.rect(Math.min(sx, x), Math.min(sy, y), Math.abs(x - sx), Math.abs(y - sy))
      paint()
      break
    case 'roundRect':
      ctx.beginPath()
      ctx.roundRect(Math.min(sx, x), Math.min(sy, y), Math.abs(x - sx), Math.abs(y - sy), Math.min(20, Math.abs(x - sx) / 3, Math.abs(y - sy) / 3))
      paint()
      break
    case 'circle':
      ctx.beginPath()
      ctx.ellipse((sx + x) / 2, (sy + y) / 2, Math.abs(x - sx) / 2, Math.abs(y - sy) / 2, 0, 0, Math.PI * 2)
      paint()
      break
    case 'poly3':
      polyPath((sx + x) / 2, (sy + y) / 2, Math.abs(x - sx) / 2, Math.abs(y - sy) / 2, 3)
      paint()
      break
    case 'poly4':
      polyPath((sx + x) / 2, (sy + y) / 2, Math.abs(x - sx) / 2, Math.abs(y - sy) / 2, 4)
      paint()
      break
    case 'poly5':
      polyPath((sx + x) / 2, (sy + y) / 2, Math.abs(x - sx) / 2, Math.abs(y - sy) / 2, 5)
      paint()
      break
    case 'poly6':
      polyPath((sx + x) / 2, (sy + y) / 2, Math.abs(x - sx) / 2, Math.abs(y - sy) / 2, 6)
      paint()
      break
    case 'arrow':
      arrowPath(sx, sy, x, y)
      ctx.stroke()
      break
    case 'star':
      starPath((sx + x) / 2, (sy + y) / 2, Math.abs(x - sx) / 2, Math.abs(y - sy) / 2)
      paint()
      break
    case 'heart':
      heartPath((sx + x) / 2, (sy + y) / 2, Math.abs(x - sx) / 2, Math.abs(y - sy) / 2)
      paint()
      break
    case 'bubble':
      bubblePath(Math.min(sx, x), Math.min(sy, y), Math.abs(x - sx), Math.abs(y - sy))
      paint()
      break
  }
}

/* ---------- 油漆桶填充（BFS 泛洪） ---------- */

const floodFill = (sx: number, sy: number): void => {
  const canvas = canvasRef.value
  if (!ctx || !canvas) return
  const w = canvas.width
  const h = canvas.height
  const x0 = Math.floor(sx)
  const y0 = Math.floor(sy)
  if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return
  const img = ctx.getImageData(0, 0, w, h)
  const px = img.data
  const idx = (y0 * w + x0) * 4
  const tr = px[idx]
  const tg = px[idx + 1]
  const tb = px[idx + 2]
  const ta = px[idx + 3]

  // 解析填充色（hex）
  const hex = /^#([0-9a-f]{6})$/i.exec(strokeColor.value)?.[1] ?? '000000'
  const fr = parseInt(hex.slice(0, 2), 16)
  const fg = parseInt(hex.slice(2, 4), 16)
  const fb = parseInt(hex.slice(4, 6), 16)
  const fa = 255

  const tol = 48
  const near = (i: number): boolean => {
    const dr = px[i] - tr
    const dg = px[i + 1] - tg
    const db = px[i + 2] - tb
    const da = px[i + 3] - ta
    return dr * dr + dg * dg + db * db + da * da <= tol * tol * 4
  }
  // 同色时无需填充
  if (Math.abs(fr - tr) < 4 && Math.abs(fg - tg) < 4 && Math.abs(fb - tb) < 4 && Math.abs(fa - ta) < 4) return

  pushUndo()
  const stack: number[] = [y0 * w + x0]
  const visited = new Uint8Array(w * h)
  while (stack.length > 0) {
    const p = stack.pop()!
    if (visited[p]) continue
    visited[p] = 1
    const i = p * 4
    if (!near(i)) continue
    px[i] = fr
    px[i + 1] = fg
    px[i + 2] = fb
    px[i + 3] = fa
    const x = p % w
    const y = (p - x) / w
    if (x > 0) stack.push(p - 1)
    if (x < w - 1) stack.push(p + 1)
    if (y > 0) stack.push(p - w)
    if (y < h - 1) stack.push(p + w)
  }
  ctx.putImageData(img, 0, 0)
}

/* ---------- 吸色器 ---------- */

const pickColor = (e: PointerEvent): void => {
  const { x, y } = toCanvasPos(e)
  if (!ctx) return
  const d = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data
  const hex = `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`
  strokeColor.value = hex
  ElMessage.success(`已取色：${hex}`)
}

/* ---------- 画布指针事件 ---------- */

const onPointerDown = (e: PointerEvent): void => {
  const tool = currentTool.value
  if (!ctx) return

  // 选区工具：点击选区内交给选区层处理；否则先提交旧选区再拉新框
  if (tool === 'select') {
    commitSelection()
    const { x, y } = toCanvasPos(e)
    sel.marquee = true
    sel.mx = x
    sel.my = y
    sel.mex = x
    sel.mey = y
    canvasRef.value?.setPointerCapture(e.pointerId)
    return
  }
  if (sel.active) commitSelection()

  if (tool === 'picker') {
    pickColor(e)
    return
  }
  if (tool === 'text') {
    openTextEditor(e)
    return
  }
  if (tool === 'fill') {
    const { x, y } = toCanvasPos(e)
    floodFill(x, y)
    return
  }

  const { x, y } = toCanvasPos(e)
  canvasRef.value?.setPointerCapture(e.pointerId)
  drawState.drawing = true
  drawState.startX = x
  drawState.startY = y
  drawState.previewSnap = isShape(tool) ? snapshot() : null

  if (tool === 'brush' || tool === 'eraser') {
    beginStroke()
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + 0.01, y + 0.01)
    ctx.stroke()
  }
}

const onPointerMove = (e: PointerEvent): void => {
  if (!ctx) return

  // 选区框选：mx/my 为起点，mex/mey 为当前点
  if (sel.marquee) {
    const p = toCanvasPos(e)
    sel.mex = p.x
    sel.mey = p.y
    return
  }

  if (!drawState.drawing) return
  const tool = currentTool.value
  const { x, y } = toCanvasPos(e)

  if (tool === 'brush' || tool === 'eraser') {
    ctx.lineTo(x, y)
    ctx.stroke()
    return
  }

  if (isShape(tool)) {
    if (drawState.previewSnap) ctx.putImageData(drawState.previewSnap, 0, 0)
    drawShape(tool, drawState.startX, drawState.startY, x, y)
  }
}

const onPointerUp = (_e: PointerEvent): void => {
  // 框选结束：足够大则裁出选区
  if (sel.marquee) {
    sel.marquee = false
    const x0 = Math.round(Math.min(sel.mx, sel.mex))
    const y0 = Math.round(Math.min(sel.my, sel.mey))
    const w = Math.round(Math.abs(sel.mex - sel.mx))
    const h = Math.round(Math.abs(sel.mey - sel.my))
    if (w >= 8 && h >= 8 && canvasRef.value) {
      cutSelection(
        Math.max(0, x0),
        Math.max(0, y0),
        Math.min(w, canvasRef.value.width - Math.max(0, x0)),
        Math.min(h, canvasRef.value.height - Math.max(0, y0))
      )
    }
    return
  }

  if (!drawState.drawing) return
  drawState.drawing = false
  drawState.previewSnap = null
  if (ctx) ctx.globalCompositeOperation = 'source-over'
}

/* ================================ 导入 / 导出 ================================ */

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('load image failed'))
    img.src = src
  })

/** 选择并导入图片：按画布大小等比铺放（居中） */
const importImage = async (): Promise<void> => {
  const path = await window.dot.toolbox.file.select([
    { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }
  ])
  if (!path || !ctx) return
  try {
    const base64 = (await window.dot.localFiles('read-base64', path)) as string
    const ext = path.split('.').pop()?.toLowerCase() ?? 'png'
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
    await loadImage(`data:${mime};base64,${base64}`)
      .then((img) => {
        pushUndo()
        const canvas = canvasRef.value!
        const ratio = Math.min(canvas.width / img.width, canvas.height / img.height, 1)
        const w = img.width * ratio
        const h = img.height * ratio
        ctx!.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h)
        ElMessage.success('图片已导入画布')
      })
      .catch(() => ElMessage.error('图片解码失败'))
  } catch {
    ElMessage.error('读取图片文件失败')
  }
}

/** 按倍数缩放渲染导出（JPEG 自动铺白底避免透明变黑） */
const renderScaled = (source: HTMLCanvasElement, scale: number, format: 'png' | 'jpeg'): string => {
  if (scale === 1 && format === 'png') return source.toDataURL('image/png')
  const out = document.createElement('canvas')
  out.width = Math.round(source.width * scale)
  out.height = Math.round(source.height * scale)
  const outCtx = out.getContext('2d')!
  if (format === 'jpeg') {
    outCtx.fillStyle = '#ffffff'
    outCtx.fillRect(0, 0, out.width, out.height)
  }
  outCtx.imageSmoothingEnabled = true
  outCtx.drawImage(source, 0, 0, out.width, out.height)
  return out.toDataURL(format === 'png' ? 'image/png' : 'image/jpeg', 0.95)
}

/** 导出当前画布为 PNG / JPEG 文件 */
const exportImage = async (): Promise<void> => {
  const canvas = canvasRef.value
  if (!canvas) return
  commitSelection()
  const suffix = exportFormat.value === 'png' ? 'png' : 'jpg'
  const path = await window.dot.toolbox.file.selectSavePath(`drawing-${Date.now()}.${suffix}`, [
    { name: exportFormat.value.toUpperCase() + ' 图片', extensions: [suffix] }
  ])
  if (!path) return
  try {
    const dataUrl = renderScaled(canvas, exportScale.value, exportFormat.value)
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    const result = await window.dot.toolbox.file.save(path, base64)
    if (result.success) ElMessage.success(`已导出：${path}`)
    else ElMessage.error('导出失败')
  } catch (err) {
    ElMessage.error(`导出失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

const clearCanvas = (): void => {
  commitSelection()
  pushUndo()
  fillBackground()
}

/* ================================ AI 能力 ================================ */

const aiPanelVisible = ref(false)
const aiBusy = ref(false)
const aiInput = ref('')
const aiResult = ref('')

/** 画布内容压缩为不超过 maxSize 的 PNG data URL（控制 vision 请求体积） */
const canvasDataUrl = (maxSize = 1024): string | null => {
  const canvas = canvasRef.value
  if (!canvas) return null
  const ratio = Math.min(maxSize / canvas.width, maxSize / canvas.height, 1)
  return renderScaled(canvas, ratio, 'png')
}

/** AI 识别画布内容（多模态 vision） */
const aiRecognize = async (): Promise<void> => {
  const dataUrl = canvasDataUrl()
  if (!dataUrl) return
  aiBusy.value = true
  aiResult.value = ''
  aiPanelVisible.value = true
  try {
    const parts: LlmContentPart[] = [
      { type: 'text', text: '请识别这张图片的内容：描述整体画面、其中的文字与关键元素，用中文简洁回答。' },
      { type: 'image_url', image_url: { url: dataUrl } }
    ]
    const result = await sendLlm([{ role: 'user', content: parts }])
    aiResult.value = result.content || '（模型未返回内容）'
  } catch (err) {
    aiResult.value = `识别失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    aiBusy.value = false
  }
}

/** 从模型回复中提取 SVG 文本 */
const extractSvg = (text: string): string | null => {
  const m = /<svg[\s\S]*?<\/svg>/i.exec(text)
  return m ? m[0] : null
}

/** AI 生成图片：提示词约束输出 SVG，渲染到画布；解析失败自动重试（最多 3 轮） */
const aiGenerate = async (): Promise<void> => {
  const prompt = aiInput.value.trim()
  if (!prompt) {
    ElMessage.warning('请先输入图片描述')
    return
  }
  aiBusy.value = true
  aiResult.value = ''
  aiPanelVisible.value = true
  const system =
    '你是一个绘图助手。根据用户描述生成一幅 SVG 矢量图。' +
    '要求：只输出一段以 <svg 开头、以 </svg> 结尾的完整 SVG 代码，不要输出任何解释文字或代码块标记；' +
    '必须包含 viewBox="0 0 800 600"，元素填充饱满、构图美观，可使用渐变与图形组合。'
  const messages: LlmChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: `请绘制：${prompt}` }
  ]

  try {
    let svg: string | null = null
    let lastContent = ''
    // 校验失败自动重试（最多 3 轮），复用会话历史让模型自我修正
    for (let round = 0; round < 3 && !svg; round++) {
      const result = await sendLlm(messages)
      lastContent = result.content
      svg = extractSvg(result.content)
      if (!svg) {
        messages.push(
          { role: 'assistant', content: result.content },
          {
            role: 'user',
            content: '你上次的回复不符合要求：必须只输出一段完整 SVG 代码（<svg ...>...</svg>），不要有其他文字。请重新输出。'
          }
        )
      }
    }
    if (!svg) throw new Error('模型未能返回有效的 SVG 图形，请重试或更换描述')
    aiResult.value = lastContent

    const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
    pushUndo()
    const canvas = canvasRef.value!
    const ratio = Math.min(canvas.width / img.width || 1, canvas.height / img.height || 1, 1)
    const w = img.width * ratio
    const h = img.height * ratio
    ctx!.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h)
    ElMessage.success('AI 图片已生成到画布')
  } catch (err) {
    aiResult.value = `生成失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    aiBusy.value = false
  }
}

/* ================================ 生命周期 ================================ */

onMounted(async () => {
  await nextTick()
  initCanvas()
})
</script>

<template>
  <div class="drawing-page">
    <!-- 顶栏 -->
    <header class="drawing-header">
      <div class="drawing-header-left">
        <BackHome to="Toolbox" />
        <div class="drawing-header-brand">
          <div class="drawing-header-badge">
            <img :src="drawingSvg" alt="画图" class="drawing-header-icon" />
          </div>
          <span class="drawing-header-title">画图</span>
        </div>
      </div>
    </header>

    <!-- 顶部工具栏（PS 风格四区） -->
    <div class="toolbar">
      <!-- 工具区 -->
      <div class="tb-group">
        <span class="tb-group-label">工具</span>
        <div class="tb-buttons">
          <el-tooltip v-for="t in toolGroup" :key="t.key" :content="t.label" placement="bottom">
            <div
              class="tb-btn"
              :class="{ active: currentTool === t.key }"
              @click="currentTool = t.key"
            >
              <el-icon v-if="t.icon" :size="16"><component :is="t.icon" /></el-icon>
              <span v-else class="tb-btn-text">{{ t.text }}</span>
            </div>
          </el-tooltip>
        </div>
      </div>

      <div class="tb-divider"></div>

      <!-- 功能区 -->
      <div class="tb-group">
        <span class="tb-group-label">功能</span>
        <div class="tb-buttons">
          <el-tooltip content="逆时针旋转 90°" placement="bottom">
            <div class="tb-btn" @click="rotateCanvas(-1)">
              <el-icon :size="16"><Refresh /></el-icon>
            </div>
          </el-tooltip>
          <el-tooltip content="顺时针旋转 90°" placement="bottom">
            <div class="tb-btn" @click="rotateCanvas(1)">
              <el-icon :size="16" style="transform: scaleX(-1)"><Refresh /></el-icon>
            </div>
          </el-tooltip>
          <el-tooltip content="放大视图" placement="bottom">
            <div class="tb-btn" @click="zoomIn">
              <el-icon :size="16"><ZoomIn /></el-icon>
            </div>
          </el-tooltip>
          <el-tooltip content="缩小视图" placement="bottom">
            <div class="tb-btn" @click="zoomOut">
              <el-icon :size="16"><ZoomOut /></el-icon>
            </div>
          </el-tooltip>
          <el-tooltip content="适应窗口" placement="bottom">
            <div class="tb-btn" @click="zoomFit">
              <el-icon :size="16"><FullScreen /></el-icon>
            </div>
          </el-tooltip>
          <span class="zoom-label">{{ Math.round(zoom * 100) }}%</span>
          <el-tooltip content="撤销" placement="bottom">
            <div class="tb-btn" :class="{ disabled: !canUndo }" @click="undo">
              <el-icon :size="16"><RefreshLeft /></el-icon>
            </div>
          </el-tooltip>
          <el-tooltip content="重做" placement="bottom">
            <div class="tb-btn" :class="{ disabled: !canRedo }" @click="redo">
              <el-icon :size="16"><RefreshRight /></el-icon>
            </div>
          </el-tooltip>
          <el-button size="small" type="danger" plain @click="clearCanvas">清空</el-button>
        </div>
      </div>

      <div class="tb-divider"></div>

      <!-- 形状区 -->
      <div class="tb-group">
        <span class="tb-group-label">形状</span>
        <div class="tb-buttons">
          <el-tooltip v-for="s in shapeGroup" :key="s.key" :content="s.label" placement="bottom">
            <div
              class="tb-btn shape-btn"
              :class="{ active: currentTool === s.key }"
              @click="currentTool = s.key"
            >
              <span class="tb-btn-text">{{ s.text }}</span>
            </div>
          </el-tooltip>
        </div>
      </div>

      <div class="tb-divider"></div>

      <!-- 颜色区 -->
      <div class="tb-group">
        <span class="tb-group-label">颜色</span>
        <div class="tb-buttons color-buttons">
          <div
            v-for="c in defaultSwatches"
            :key="c"
            class="swatch"
            :class="{ active: strokeColor === c }"
            :style="{ background: c }"
            :title="c"
            @click="applySwatch(c)"
          ></div>
          <el-tooltip content="描边 / 画笔颜色" placement="bottom">
            <el-color-picker v-model="strokeColor" size="small" />
          </el-tooltip>
          <el-tooltip content="形状填充颜色" placement="bottom">
            <el-color-picker v-model="fillColor" size="small" />
          </el-tooltip>
          <el-tooltip content="吸色器：点击后在画布上取色" placement="bottom">
            <div
              class="tb-btn"
              :class="{ active: currentTool === 'picker' }"
              @click="currentTool = currentTool === 'picker' ? 'brush' : 'picker'"
            >
              <el-icon :size="16"><CircleCheck /></el-icon>
            </div>
          </el-tooltip>
        </div>
      </div>
    </div>

    <!-- 属性栏（随当前状态显示） -->
    <div class="props-bar">
      <span class="prop-item">
        线宽 {{ brushWidth }}
        <el-slider v-model="brushWidth" :min="1" :max="40" style="width: 110px" class="prop-slider" />
      </span>
      <el-checkbox v-model="fillEnabled" size="small" class="prop-item">形状填充</el-checkbox>
      <el-divider direction="vertical" />
      <span class="prop-item">
        背景
        <div class="bg-dots">
          <div
            v-for="bg in backgrounds"
            :key="bg.key"
            class="bg-dot"
            :class="{ active: bgKey === bg.key, checker: bg.color === null }"
            :style="bg.key === 'custom' && bgColor ? { background: customBgColor } : { background: bg.color ?? '' }"
            :title="bg.label"
            @click="setBackground(bg.key)"
          ></div>
        </div>
        <el-color-picker
          v-if="bgKey === 'custom'"
          v-model="customBgColor"
          size="small"
          @change="applyCustomBackground"
        />
      </span>
      <el-divider direction="vertical" />
      <span class="prop-item">
        画布
        <el-input-number v-model="canvasWidth" :min="16" :max="8192" :step="10" size="small" controls-position="right" style="width: 90px" />
        ×
        <el-input-number v-model="canvasHeight" :min="16" :max="8192" :step="10" size="small" controls-position="right" style="width: 90px" />
        <el-button size="small" plain @click="applySize">应用</el-button>
      </span>
      <el-divider direction="vertical" />
      <span class="prop-item">
        分辨率
        <el-select v-model="exportScale" size="small" style="width: 90px">
          <el-option label="1× 标准" :value="1" />
          <el-option label="2× 高清" :value="2" />
          <el-option label="3× 超清" :value="3" />
          <el-option label="4× 印刷" :value="4" />
        </el-select>
        <el-radio-group v-model="exportFormat" size="small">
          <el-radio-button value="png">PNG</el-radio-button>
          <el-radio-button value="jpeg">JPEG</el-radio-button>
        </el-radio-group>
      </span>
      <el-divider direction="vertical" />
      <el-button size="small" :icon="Upload" @click="importImage">导入</el-button>
      <el-button size="small" type="success" :icon="Download" @click="exportImage">导出</el-button>
      <el-button size="small" type="primary" :icon="View" @click="aiPanelVisible = !aiPanelVisible">
        AI 助手
      </el-button>
      <el-button
        v-if="sel.active"
        size="small"
        type="primary"
        @click="commitSelection"
      >
        应用选区
      </el-button>
      <el-button v-if="sel.active" size="small" plain @click="cancelSelection">取消选区</el-button>
    </div>

    <main class="drawing-main">
      <!-- 画布区 -->
      <section ref="stageRef" class="canvas-stage">
        <div class="canvas-outer"
          :style="{ width: `${canvasWidth * zoom}px`, height: `${canvasHeight * zoom}px` }"
        >
          <div
            class="canvas-inner"
            :style="{
              transform: `scale(${zoom})`,
              width: `${canvasWidth}px`,
              height: `${canvasHeight}px`
            }"
          >
            <div class="canvas-wrap" :class="{ checker: !bgColor }">
              <canvas
                ref="canvasRef"
                class="draw-canvas"
                :style="{ cursor: currentTool === 'picker' ? 'crosshair' : 'crosshair' }"
                @pointerdown="onPointerDown"
                @pointermove="onPointerMove"
                @pointerup="onPointerUp"
                @pointercancel="onPointerUp"
              ></canvas>

              <!-- 选区浮动层（跟随拖拽） -->
              <canvas
                v-if="sel.active && sel.data"
                ref="selCanvasRef"
                class="sel-canvas"
                :style="{
                  left: `${sel.x}px`,
                  top: `${sel.y}px`,
                  width: `${sel.w}px`,
                  height: `${sel.h}px`
                }"
                @pointerdown="onSelPointerDown"
                @pointermove="onSelPointerMove"
                @pointerup="onSelPointerUp"
              ></canvas>

              <!-- 框选虚线框 -->
              <div
                v-if="sel.marquee"
                class="marquee"
                :style="{
                  left: `${Math.min(sel.mx, sel.mex)}px`,
                  top: `${Math.min(sel.my, sel.mey)}px`,
                  width: `${Math.abs(sel.mex - sel.mx)}px`,
                  height: `${Math.abs(sel.mey - sel.my)}px`
                }"
              ></div>

              <!-- 画布内联文字输入 -->
              <textarea
                v-if="textEditing.visible"
                ref="textInputRef"
                v-model="textEditing.value"
                class="text-editor"
                :style="{
                  left: `${textEditing.x}px`,
                  top: `${textEditing.y}px`,
                  fontSize: `${Math.max(12, brushWidth * 6)}px`,
                  color: strokeColor
                }"
                rows="1"
                placeholder="输入文字，Enter 确认，Esc 取消"
                @keydown.enter.prevent="commitText"
                @keydown.esc="textEditing.visible = false"
              ></textarea>
            </div>
          </div>
        </div>
      </section>

      <!-- AI 面板 -->
      <aside v-show="aiPanelVisible" class="ai-panel">
        <div class="ai-panel-header">
          <span>AI 助手</span>
          <el-icon class="ai-close" @click="aiPanelVisible = false"><Delete /></el-icon>
        </div>

        <div class="ai-section">
          <div class="ai-section-title">AI 识别画布</div>
          <p class="ai-section-desc">将当前画布内容发送给多模态模型，识别画面与文字内容</p>
          <el-button type="primary" size="small" :loading="aiBusy" @click="aiRecognize">识别画布内容</el-button>
        </div>

        <div class="ai-section">
          <div class="ai-section-title">AI 生成图片</div>
          <el-input
            v-model="aiInput"
            type="textarea"
            :rows="3"
            placeholder="描述你想生成的图片，例如：画一座雪山下的木屋，黄昏色调"
          />
          <el-button
            type="success"
            size="small"
            class="ai-gen-btn"
            :loading="aiBusy"
            :disabled="!aiInput.trim()"
            @click="aiGenerate"
          >
            <el-icon v-if="!aiBusy" style="margin-right: 4px"><MagicStick /></el-icon>
            生成到画布
          </el-button>
        </div>

        <div v-if="aiResult" class="ai-result">
          <div class="ai-section-title">结果</div>
          <div class="ai-result-text">{{ aiResult }}</div>
        </div>
      </aside>
    </main>
  </div>
</template>

<style scoped>
.drawing-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  color: var(--color-text);
  overflow: hidden;
}

/* ===== 顶栏 ===== */
.drawing-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 20px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-card);
}

.drawing-header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.drawing-header-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.drawing-header-badge {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.drawing-header-icon {
  width: 28px;
  height: 28px;
}

.drawing-header-title {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 1px;
}

/* ===== 顶部工具栏 ===== */
.toolbar {
  display: flex;
  align-items: stretch;
  gap: 10px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-card);
  overflow-x: auto;
}

.tb-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-shrink: 0;
}

.tb-group-label {
  font-size: 11px;
  color: var(--color-text-secondary);
}

.tb-buttons {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tb-btn {
  min-width: 30px;
  height: 30px;
  padding: 0 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  cursor: pointer;
  color: var(--color-text-secondary);
  transition: all 0.15s ease;
  user-select: none;
}

.tb-btn:hover {
  border-color: var(--color-primary-light);
  color: var(--color-primary);
}

.tb-btn.active {
  border-color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 14%, transparent);
  color: var(--color-primary);
}

.tb-btn.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.tb-btn-text {
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
}

.shape-btn {
  min-width: 36px;
}

.zoom-label {
  font-size: 12px;
  color: var(--color-text-secondary);
  min-width: 42px;
  text-align: center;
}

.tb-divider {
  width: 1px;
  background: var(--color-border);
  margin: 2px 2px;
  flex-shrink: 0;
}

/* 颜色区 */
.color-buttons {
  gap: 5px;
}

.swatch {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  border: 1px solid var(--color-border);
  cursor: pointer;
  transition: all 0.15s ease;
}

.swatch:hover {
  transform: scale(1.12);
}

.swatch.active {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}

/* ===== 属性栏 ===== */
.props-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-card);
  overflow-x: auto;
  flex-wrap: nowrap;
}

.prop-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--color-text-secondary);
  white-space: nowrap;
  flex-shrink: 0;
}

.prop-slider {
  height: 18px;
}

.bg-dots {
  display: flex;
  align-items: center;
  gap: 5px;
}

.bg-dot {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  border: 1px solid var(--color-border);
  cursor: pointer;
}

.bg-dot.active {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}

.bg-dot.checker {
  background-image:
    linear-gradient(45deg, #ccc 25%, transparent 25%),
    linear-gradient(-45deg, #ccc 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #ccc 75%),
    linear-gradient(-45deg, transparent 75%, #ccc 75%);
  background-size: 8px 8px;
  background-position: 0 0, 0 4px, 4px -4px, -4px 0px;
}

/* ===== 主区 ===== */
.drawing-main {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* ===== 画布区 ===== */
.canvas-stage {
  flex: 1;
  min-width: 0;
  overflow: auto;
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  padding: 24px;
}

.canvas-outer {
  margin: auto;
}

.canvas-inner {
  transform-origin: top left;
  box-shadow: var(--shadow-card);
  border-radius: 4px;
}

.canvas-wrap {
  position: relative;
  width: 100%;
  height: 100%;
}

/* 透明背景棋盘格 */
.canvas-wrap.checker {
  background-image:
    linear-gradient(45deg, #ccc 25%, transparent 25%),
    linear-gradient(-45deg, #ccc 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #ccc 75%),
    linear-gradient(-45deg, transparent 75%, #ccc 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0px;
}

.draw-canvas {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
  cursor: crosshair;
}

/* 选区浮动层 */
.sel-canvas {
  position: absolute;
  border: 1px dashed var(--color-primary);
  cursor: move;
  touch-action: none;
  background: transparent;
}

/* 框选虚线框 */
.marquee {
  position: absolute;
  border: 1px dashed var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  pointer-events: none;
}

/* 画布内联文字输入 */
.text-editor {
  position: absolute;
  min-width: 160px;
  max-width: 400px;
  border: 1px dashed var(--color-primary);
  background: rgba(255, 255, 255, 0.92);
  outline: none;
  resize: none;
  padding: 2px 6px;
  font-family: sans-serif;
  line-height: 1.2;
  z-index: 10;
}

/* ===== AI 面板 ===== */
.ai-panel {
  width: 260px;
  flex-shrink: 0;
  border-left: 1px solid var(--color-border);
  background: var(--color-card);
  padding: 14px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.ai-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  font-weight: 700;
}

.ai-close {
  cursor: pointer;
  color: var(--color-text-secondary);
}

.ai-close:hover {
  color: var(--color-danger);
}

.ai-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ai-section-title {
  font-size: 13px;
  font-weight: 600;
}

.ai-section-desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.ai-gen-btn {
  align-self: flex-start;
}

.ai-result {
  border-top: 1px dashed var(--color-border);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ai-result-text {
  font-size: 12px;
  line-height: 1.8;
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--color-hover);
  border-radius: 8px;
  padding: 10px;
  max-height: 300px;
  overflow-y: auto;
}
</style>
