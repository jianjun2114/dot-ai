<script setup lang="ts">
/**
 * 文档转换页面
 *
 * 支持的转换：
 * - Word / 图片 / TXT / HTML  →  PDF（长内容自动分页，中文正常渲染）
 * - PDF  →  Word（提取文本生成 Word 可打开的 .doc 文档）
 * - PDF  →  图片（逐页渲染 PNG，多页自动打包 zip）
 * - Base64  →  文档 / 图片（解码保存为文件）
 */
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { Tickets, Refresh } from '@element-plus/icons-vue'
import jsPDF from 'jspdf'
import html2canvas from 'html2canvas'
import JSZip from 'jszip'
import * as pdfjsLib from 'pdfjs-dist'
import mammoth from 'mammoth'
// pdfjs 渲染 worker（Vite 静态资源引入）
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import BackHome from '../../components/BackHome.vue'
import docConvSvg from '../../assets/doc_conv.svg'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const toolboxFile = window.dot.toolbox.file
const localFiles = window.dot.localFiles

// ==================== 转换类型 ====================
type ConvertKind =
  'word2pdf' | 'image2pdf' | 'txt2pdf' | 'html2pdf' | 'pdf2word' | 'pdf2image' | 'base64ToFile'

interface ConvertType {
  key: ConvertKind
  title: string
  desc: string
  /** 源文件选择器的扩展名过滤 */
  extensions: string[]
  /** 是否基于文件选择（base64 模式为文本输入） */
  fileBased: boolean
}

const convertTypes: ConvertType[] = [
  {
    key: 'word2pdf',
    title: 'Word → PDF',
    desc: 'docx 文档转换为 PDF',
    extensions: ['docx'],
    fileBased: true
  },
  {
    key: 'image2pdf',
    title: '图片 → PDF',
    desc: 'png / jpg 图片转换为 PDF',
    extensions: ['png', 'jpg', 'jpeg'],
    fileBased: true
  },
  {
    key: 'txt2pdf',
    title: 'TXT → PDF',
    desc: '文本文件转换为 PDF',
    extensions: ['txt'],
    fileBased: true
  },
  {
    key: 'html2pdf',
    title: 'HTML → PDF',
    desc: 'HTML 文件转换为 PDF',
    extensions: ['html', 'htm'],
    fileBased: true
  },
  {
    key: 'pdf2word',
    title: 'PDF → Word',
    desc: 'PDF 提取文本生成 Word 文档',
    extensions: ['pdf'],
    fileBased: true
  },
  {
    key: 'pdf2image',
    title: 'PDF → 图片',
    desc: 'PDF 逐页渲染为 PNG 图片',
    extensions: ['pdf'],
    fileBased: true
  },
  {
    key: 'base64ToFile',
    title: 'Base64 → 文件',
    desc: 'Base64 编码解码保存为文档 / 图片',
    extensions: [],
    fileBased: false
  }
]

const selectedKind = ref<ConvertKind>('word2pdf')
const selectedType = computed(() => convertTypes.find((t) => t.key === selectedKind.value)!)

/** 源文件路径与内容 */
const sourcePath = ref('')
/** Base64 输入内容 */
const base64Input = ref('')
const converting = ref(false)
const resultMessage = ref('')

// ==================== 通用工具 ====================

/** 读取本地文件为 ArrayBuffer */
const readFileBuffer = async (path: string): Promise<ArrayBuffer> => {
  const base64 = (await localFiles('read-base64', path)) as string
  if (!base64) throw new Error('文件读取失败')
  return base64ToArrayBuffer(base64)
}

/** base64 → ArrayBuffer */
const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
  const pure = base64.includes(',') ? base64.split(',')[1] : base64
  const binary = atob(pure)
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return buffer
}

/** Blob → base64 */
const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

/** 选择保存位置并写入 base64 内容 */
const saveBase64File = async (
  defaultName: string,
  filters: { name: string; extensions: string[] }[],
  dataBase64: string
): Promise<void> => {
  const savePath = await toolboxFile.selectSavePath(defaultName, filters)
  if (!savePath) return
  await toolboxFile.save(savePath, dataBase64.includes(',') ? dataBase64.split(',')[1] : dataBase64)
  resultMessage.value = `已保存到：${savePath}`
  ElMessage.success('转换完成')
}

/**
 * 将 HTML 渲染为分页 PDF（html2canvas + jsPDF）
 * 采用「整图渲染 + 按页高切片」策略，天然支持中文
 */
const htmlToPdfBlob = async (html: string): Promise<Blob> => {
  // 离屏容器按 A4 宽度（794px ≈ 210mm）渲染
  const container = document.createElement('div')
  container.style.cssText =
    'position:fixed;left:-9999px;top:0;width:794px;background:#fff;padding:48px;' +
    'font-family:"Microsoft YaHei",sans-serif;font-size:14px;line-height:1.8;color:#1f2329;'
  container.innerHTML = html
  document.body.appendChild(container)
  try {
    const canvas = await html2canvas(container, { scale: 2 })
    const pdf = new jsPDF('p', 'mm', 'a4')
    const pageWidth = 210
    const pageHeight = 297
    // 单页对应的画布像素高度
    const sliceHeight = Math.floor((canvas.width * pageHeight) / pageWidth)
    let rendered = false

    // 逐页切片写入 PDF
    for (let y = 0; y < canvas.height; y += sliceHeight) {
      const sliceCanvas = document.createElement('canvas')
      sliceCanvas.width = canvas.width
      sliceCanvas.height = Math.min(sliceHeight, canvas.height - y)
      const ctx = sliceCanvas.getContext('2d')!
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height)
      ctx.drawImage(
        canvas,
        0,
        y,
        canvas.width,
        sliceCanvas.height,
        0,
        0,
        canvas.width,
        sliceCanvas.height
      )
      if (rendered) pdf.addPage()
      pdf.addImage(sliceCanvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pageWidth, pageHeight)
      rendered = true
    }
    return pdf.output('blob')
  } finally {
    document.body.removeChild(container)
  }
}

/** 文本转义（防 HTML 注入） */
const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ==================== 各类型转换实现 ====================

/** Word(docx) → PDF：mammoth 提取 HTML 后转 PDF */
const wordToPdf = async (): Promise<void> => {
  const buffer = await readFileBuffer(sourcePath.value)
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer: buffer })
  const blob = await htmlToPdfBlob(html)
  const name = sourcePath.value
    .split(/[\\/]/)
    .pop()!
    .replace(/\.docx$/i, '')
  await saveBase64File(
    `${name}.pdf`,
    [{ name: 'PDF 文档', extensions: ['pdf'] }],
    await blobToBase64(blob)
  )
}

/** 图片 → PDF：按图片原始比例铺满 A4 宽度 */
const imageToPdf = async (): Promise<void> => {
  const base64 = (await localFiles('read-base64', sourcePath.value)) as string
  const ext = sourcePath.value.toLowerCase().endsWith('.png') ? 'PNG' : 'JPEG'
  const dataUrl = `data:image/${ext.toLowerCase()};base64,${base64}`

  // 加载图片获取宽高
  const img = new Image()
  await new Promise((resolve, reject) => {
    img.onload = resolve
    img.onerror = reject
    img.src = dataUrl
  })

  const pdf = new jsPDF('p', 'mm', 'a4')
  const pageWidth = 210
  const pageHeight = 297
  const margin = 10
  // 等比缩放适配页面
  const scale = Math.min(
    (pageWidth - margin * 2) / img.width,
    (pageHeight - margin * 2) / img.height
  )
  const w = img.width * scale
  const h = img.height * scale
  pdf.addImage(dataUrl, ext, (pageWidth - w) / 2, (pageHeight - h) / 2, w, h)

  const name = sourcePath.value
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(png|jpe?g)$/i, '')
  await saveBase64File(
    `${name}.pdf`,
    [{ name: 'PDF 文档', extensions: ['pdf'] }],
    await blobToBase64(pdf.output('blob'))
  )
}

/** TXT → PDF：文本逐行渲染后截图转 PDF（支持中文） */
const txtToPdf = async (): Promise<void> => {
  const text = (await localFiles('read', sourcePath.value)) as string
  const html = text
    .split('\n')
    .map((line) => `<p>${escapeHtml(line) || '&nbsp;'}</p>`)
    .join('')
  const blob = await htmlToPdfBlob(html)
  const name = sourcePath.value
    .split(/[\\/]/)
    .pop()!
    .replace(/\.txt$/i, '')
  await saveBase64File(
    `${name}.pdf`,
    [{ name: 'PDF 文档', extensions: ['pdf'] }],
    await blobToBase64(blob)
  )
}

/** HTML 文件 → PDF */
const htmlFileToPdf = async (): Promise<void> => {
  const html = (await localFiles('read', sourcePath.value)) as string
  const blob = await htmlToPdfBlob(html)
  const name = sourcePath.value
    .split(/[\\/]/)
    .pop()!
    .replace(/\.html?$/i, '')
  await saveBase64File(
    `${name}.pdf`,
    [{ name: 'PDF 文档', extensions: ['pdf'] }],
    await blobToBase64(blob)
  )
}

/** 加载 PDF 文档对象 */
const loadPdf = async (): Promise<pdfjsLib.PDFDocumentProxy> => {
  const buffer = await readFileBuffer(sourcePath.value)
  return pdfjsLib.getDocument({ data: buffer }).promise
}

/** PDF → Word：提取文本生成 Word 兼容的 .doc（HTML 格式，Word 可直接打开） */
const pdfToWord = async (): Promise<void> => {
  const pdf = await loadPdf()
  const paragraphs: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    // 按 Y 坐标聚类还原行结构
    let lastY: number | null = null
    let line = ''
    for (const item of content.items as { str: string; transform: number[] }[]) {
      const y = Math.round(item.transform[5])
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        paragraphs.push(line.trim())
        line = ''
      }
      line += item.str + ' '
      lastY = y
    }
    if (line.trim()) paragraphs.push(line.trim())
    if (i < pdf.numPages) paragraphs.push('') // 页间空行
  }

  // Word 可识别的 HTML 格式 .doc
  const html =
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
    'xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"></head><body>' +
    paragraphs.map((p) => `<p>${escapeHtml(p) || '&nbsp;'}</p>`).join('') +
    '</body></html>'

  const name = sourcePath.value
    .split(/[\\/]/)
    .pop()!
    .replace(/\.pdf$/i, '')
  await saveBase64File(
    `${name}.doc`,
    [{ name: 'Word 文档', extensions: ['doc'] }],
    btoa(unescape(encodeURIComponent(html)))
  )
}

/** PDF → 图片：逐页渲染 PNG，多页打包 zip */
const pdfToImage = async (): Promise<void> => {
  const pdf = await loadPdf()
  const name = sourcePath.value
    .split(/[\\/]/)
    .pop()!
    .replace(/\.pdf$/i, '')

  if (pdf.numPages === 1) {
    // 单页：直接保存 PNG
    const dataUrl = await renderPdfPage(pdf, 1)
    await saveBase64File(`${name}.png`, [{ name: 'PNG 图片', extensions: ['png'] }], dataUrl)
    return
  }

  // 多页：打包 zip
  const zip = new JSZip()
  for (let i = 1; i <= pdf.numPages; i++) {
    const dataUrl = await renderPdfPage(pdf, i)
    zip.file(`${name}_第${i}页.png`, dataUrl.split(',')[1], { base64: true })
  }
  const blob = await zip.generateAsync({ type: 'blob' })
  await saveBase64File(
    `${name}.zip`,
    [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
    await blobToBase64(blob)
  )
}

/** 渲染 PDF 指定页为 PNG dataURL */
const renderPdfPage = async (
  pdf: pdfjsLib.PDFDocumentProxy,
  pageNumber: number
): Promise<string> => {
  const page = await pdf.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 2 })
  const canvas = document.createElement('canvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  const ctx = canvas.getContext('2d')!
  await page.render({ canvasContext: ctx, viewport }).promise
  return canvas.toDataURL('image/png')
}

/** Base64 → 文件：解码保存（自动识别 data URI 前缀） */
const base64ToFile = async (): Promise<void> => {
  const input = base64Input.value.trim()
  if (!input) {
    ElMessage.warning('请输入 Base64 内容')
    return
  }
  // 校验 base64 合法性
  const pure = input.includes(',') ? input.split(',')[1] : input
  try {
    atob(pure)
  } catch {
    ElMessage.error('Base64 内容不合法')
    return
  }
  await saveBase64File('decoded', [], pure)
}

// ==================== 转换调度 ====================
const convertHandlers: Record<ConvertKind, () => Promise<void>> = {
  word2pdf: wordToPdf,
  image2pdf: imageToPdf,
  txt2pdf: txtToPdf,
  html2pdf: htmlFileToPdf,
  pdf2word: pdfToWord,
  pdf2image: pdfToImage,
  base64ToFile: base64ToFile
}

/** 选择源文件 */
const selectSourceFile = async (): Promise<void> => {
  const path = await toolboxFile.select([
    { name: selectedType.value.title, extensions: selectedType.value.extensions }
  ])
  if (path) sourcePath.value = path
}

/** 执行转换 */
const startConvert = async (): Promise<void> => {
  if (selectedType.value.fileBased && !sourcePath.value) {
    ElMessage.warning('请先选择源文件')
    return
  }
  converting.value = true
  resultMessage.value = ''
  try {
    await convertHandlers[selectedKind.value]()
  } catch (e) {
    ElMessage.error(`转换失败: ${e}`)
  } finally {
    converting.value = false
  }
}
</script>

<template>
  <div class="doc-page">
    <!-- 顶栏 -->
    <header class="doc-header">
      <div class="doc-header-left">
        <BackHome />
        <div class="doc-header-brand">
          <div class="doc-header-badge">
            <img :src="docConvSvg" alt="文档转换" class="doc-header-icon" />
          </div>
          <span class="doc-header-title">文档转换</span>
        </div>
      </div>
    </header>

    <main class="doc-main">
      <!-- 转换类型选择 -->
      <div class="type-grid">
        <div
          v-for="t in convertTypes"
          :key="t.key"
          class="type-card"
          :class="{ active: selectedKind === t.key }"
          @click="selectedKind = t.key"
        >
          <div class="type-card-title">{{ t.title }}</div>
          <div class="type-card-desc">{{ t.desc }}</div>
        </div>
      </div>

      <!-- 转换操作面板 -->
      <div class="convert-panel">
        <template v-if="selectedType.fileBased">
          <el-button type="primary" :icon="Tickets" @click="selectSourceFile">
            选择{{ selectedType.extensions.join(' / ') }}文件
          </el-button>
          <span v-if="sourcePath" class="source-file">{{ sourcePath }}</span>
          <el-button
            type="success"
            :icon="Refresh"
            :loading="converting"
            :disabled="!sourcePath"
            @click="startConvert"
          >
            开始转换
          </el-button>
        </template>

        <!-- Base64 模式 -->
        <template v-else>
          <el-input
            v-model="base64Input"
            type="textarea"
            :rows="6"
            placeholder="粘贴 Base64 内容（支持带 data URI 前缀），将解码保存为文件"
          />
          <el-button type="success" :icon="Refresh" :loading="converting" @click="startConvert">
            解码并保存
          </el-button>
        </template>

        <el-alert
          v-if="resultMessage"
          :title="resultMessage"
          type="success"
          :closable="false"
          class="result-alert"
        />
      </div>

      <!-- 功能说明 -->
      <div class="doc-tips">
        <el-alert type="info" :closable="false">
          <p>· Word / 图片 / TXT / HTML 转 PDF：自动分页，支持中文字符渲染</p>
          <p>· PDF 转 Word：提取文本内容生成 Word 兼容文档（扫描件无文字层时不适用）</p>
          <p>· PDF 转图片：逐页渲染为 PNG，多页时自动打包为 ZIP 压缩包</p>
        </el-alert>
      </div>
    </main>
  </div>
</template>

<style scoped>
.doc-page {
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
}

.doc-header {
  display: flex;
  align-items: center;
  padding: 10px 16px;
  background: var(--color-card);
  border-bottom: 1px solid var(--color-border);
  /* 语义色底部渐变线 */
  box-shadow: inset 0 -2px 0 0 var(--color-warning);
}

.doc-header-left {
  display: flex;
  align-items: center;
  gap: 16px;
  color: var(--color-text);
}

.doc-header-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.doc-header-badge {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--color-warning);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px color-mix(in srgb, var(--color-warning) 35%, transparent);
}

.doc-header-icon {
  width: 20px;
  height: 20px;
}

.doc-header-title {
  font-size: 16px;
  font-weight: 600;
}

.doc-main {
  flex: 1;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* 转换类型卡片 */
.type-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}

.type-card {
  background: var(--color-card);
  border: 2px solid transparent;
  border-radius: 12px;
  padding: 16px;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: var(--shadow-card);
}

.type-card:hover {
  transform: translateY(-2px);
}

.type-card.active {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-card-hover);
}

.type-card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
  margin-bottom: 6px;
}

.type-card-desc {
  font-size: 13px;
  color: var(--color-text-secondary);
}

/* 转换操作面板 */
.convert-panel {
  background: var(--color-card);
  border-radius: 12px;
  padding: 20px;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}

.source-file {
  color: var(--color-primary);
  font-size: 13px;
  word-break: break-all;
}

.result-alert {
  width: 100%;
}

.doc-tips p {
  margin: 4px 0;
  font-size: 13px;
}
</style>
