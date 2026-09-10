/**
 * dotEditor.ts —— DotEditor 模块的统一工具集
 *
 * 内容分五部分（同一模块不拆分多文件）：
 * 1) Markdown 转换：富文本(HTML) 与 Markdown 双向转换
 *    （数据层统一，展示层分离：存储统一为 HTML，切换视图时转换）
 * 2) Tiptap 扩展：段落样式（首行缩进 / 垂直居中），属性持久化为 data-* 属性
 * 3) 文件导出：html 标签 / word(.docx) / pdf / txt
 * 4) 下载触发：Blob 生成文件并触发浏览器下载
 * 5) AI 文本编辑：调用大模型按指令编辑选中文本
 */
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import { marked } from 'marked'
import type { Tokens, TokenizerAndRendererExtension } from 'marked'
import { Extension } from '@tiptap/core'
import JSZip from 'jszip'
import jsPDF from 'jspdf'
import html2canvas from 'html2canvas'
import { sendLlm } from '../utils/aiRequest'

/* ================================ 一、Markdown 转换 ================================ */

/** turndown 单例（避免重复初始化与重复注册规则） */
let turndownInstance: TurndownService | null = null

/**
 * 初始化并获取 turndown 实例
 * @returns 配置好的 turndown 实例
 */
const getTurndown = (): TurndownService => {
  if (turndownInstance) return turndownInstance

  turndownInstance = new TurndownService({
    headingStyle: 'atx', // 标题使用 # 风格
    codeBlockStyle: 'fenced', // 代码块使用 ``` 围栏
    bulletListMarker: '-', // 无序列表使用 -
    emDelimiter: '*', // 斜体使用 *
    strongDelimiter: '**' // 加粗使用 **
  })

  // 启用 GFM：表格、删除线、任务列表
  gfm(turndownInstance)

  // 自定义规则：<mark> 高亮 -> ==文本==
  turndownInstance.addRule('highlightMark', {
    filter: ['mark'],
    replacement: (content: string): string => `==${content}==`
  })

  return turndownInstance
}

/**
 * marked 的 ==高亮== 行内扩展：将 ==文本== 解析为 <mark> 元素
 */
const highlightExtension: TokenizerAndRendererExtension = {
  name: 'highlightMark',
  level: 'inline',
  /**
   * 找到潜在高亮语法的起始位置，加速 tokenizer 定位
   */
  start(src: string): number | undefined {
    return src.indexOf('==')
  },
  /**
   * 词法分析：匹配 ==非换行内容==
   */
  tokenizer(src: string): Tokens.Generic | undefined {
    const match = /^==(?!=)([\s\S]+?)==/.exec(src)
    if (match) {
      return {
        type: 'highlightMark',
        raw: match[0],
        tokens: this.lexer.inlineTokens(match[1])
      }
    }
    return undefined
  },
  /**
   * 渲染：输出 <mark> 元素
   */
  renderer(token: Tokens.Generic): string {
    return `<mark>${this.parser.parseInline(token.tokens ?? [])}</mark>`
  }
}

// 注册 marked 扩展与选项（幂等，全局仅需一次）
marked.use({
  extensions: [highlightExtension],
  gfm: true,
  breaks: true
})

/**
 * 将富文本 HTML 转换为 Markdown 文本
 * @param html 富文本 HTML 字符串
 * @returns Markdown 文本；转换失败时返回空字符串
 */
export const htmlToMarkdown = (html: string): string => {
  if (!html) return ''
  try {
    return getTurndown().turndown(html)
  } catch (error) {
    console.error('[DotEditor] HTML 转 Markdown 失败:', error)
    return ''
  }
}

/**
 * 将 Markdown 文本转换为富文本 HTML
 * @param markdown Markdown 文本
 * @returns HTML 字符串；转换失败时返回按纯文本段落兜底的 HTML
 */
export const markdownToHtml = (markdown: string): string => {
  if (!markdown) return ''
  try {
    return marked.parse(markdown, { async: false }) as string
  } catch (error) {
    console.error('[DotEditor] Markdown 转 HTML 失败:', error)
    // 兜底：逐行转为段落，避免内容整体丢失
    return markdown
      .split(/\r?\n/)
      .map((line) => `<p>${line}</p>`)
      .join('')
  }
}

/* ================================ 二、Tiptap 扩展 ================================ */

/**
 * 段落样式扩展（首行缩进 / 垂直居中）：
 * - indent  首行缩进（渲染为 data-indent 属性，CSS 实现缩进效果）
 * - vCenter 垂直居中（渲染为 data-v-center 属性，CSS 提升行高使内容在段落内视觉居中）
 * 属性持久化在 HTML 中，保存/加载均可完整还原
 */
export const ParagraphStyle = Extension.create({
  name: 'paragraphStyle',

  /**
   * 为段落节点声明全局属性
   */
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph'],
        attributes: {
          // 首行缩进
          indent: {
            default: false,
            parseHTML: (element) => element.getAttribute('data-indent') === 'true',
            renderHTML: (attributes) => (attributes.indent ? { 'data-indent': 'true' } : {})
          },
          // 垂直居中
          vCenter: {
            default: false,
            parseHTML: (element) => element.getAttribute('data-v-center') === 'true',
            renderHTML: (attributes) => (attributes.vCenter ? { 'data-v-center': 'true' } : {})
          }
        }
      }
    ]
  }
})

/* ================================ 三、文件导出 ================================ */

/**
 * 导出前的 HTML 后处理：为空段落补充 <br> 占位
 * （Tiptap 的 getHTML() 对空段落输出 <p></p>，无内容时高度塌陷为 0，
 *  回车产生的空白行在导出的 html / word / pdf 中不可见；
 *  补充 <br> 后空行恢复完整行高）
 * @param bodyHtml 编辑器正文 HTML
 * @returns 处理后的 HTML
 */
export const ensureEmptyParagraphBreaks = (bodyHtml: string): string =>
  bodyHtml.replace(/<p><\/p>/g, '<p><br></p>')

/**
 * 将正文 HTML 包装为带排版样式的完整 HTML 文档
 * （内联样式会随 altChunk 一并被 Word 渲染）
 * @param bodyHtml 正文 HTML
 * @returns 完整 HTML 文档字符串
 */
const buildFullHtml = (bodyHtml: string): string => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; font-size: 15px; line-height: 1.8; }
  h1 { font-size: 28px; } h2 { font-size: 22px; } h3 { font-size: 18px; }
  table { border-collapse: collapse; }
  td, th { border: 1px solid #999999; padding: 6px 10px; }
  th { background: #f5f7fa; font-weight: 600; }
  img { max-width: 100%; }
  mark { background: #ffe58f; }
  blockquote { border-left: 4px solid #409eff; padding-left: 14px; color: #6b7280; }
  pre { background: #f5f7fa; padding: 12px; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`

/**
 * base64 字符串按 MIME 规范折行（每 76 字符一行）：
 * Word 的 MHT 解析器要求严格遵循 RFC 2045，未折行的超长行会导致图片解析失败
 * @param base64 原始 base64 字符串
 * @returns 折行后的 base64（以 \r\n 分隔）
 */
const wrapBase64 = (base64: string): string => base64.replace(/(.{76})/g, '$1\r\n')

/**
 * 将完整 HTML 文档编码为 MHT 文档：
 * - HTML 正文 base64 编码（避免中文乱码），按 MIME 规范折行
 * - HTML 中的 base64 图片拆分为独立分块，src 改为 cid: 引用
 *   （Word 的 altChunk 不渲染内嵌 data: 图片，必须走 multipart/related 分块）
 * @param fullHtml 完整 HTML 文档
 * @returns MHT 格式字符串
 */
const buildMhtPart = (fullHtml: string): string => {
  const boundary = '----=_NextPart_DotEditor'
  const parts: string[] = []

  // 1) 提取内嵌图片：data:image/png;base64,xxx -> cid:imgN，并登记分块
  const images = new Map<string, { mime: string; base64: string }>()
  const htmlWithCid = fullHtml.replace(
    /src="data:(image\/[a-zA-Z+]+);base64,([^"]+)"/g,
    (_match, mime: string, base64: string) => {
      const cid = `img${images.size + 1}`
      images.set(cid, { mime, base64 })
      return `src="cid:${cid}"`
    }
  )

  // 2) HTML 正文分块（UTF-8 base64，防中文乱码）
  const encodedHtml = window.btoa(unescape(encodeURIComponent(htmlWithCid)))
  parts.push(
    'MIME-Version: 1.0',
    `Content-Type: multipart/related; boundary="${boundary}"`,
    'X-MimeOLE: Produced By DotEditor',
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(encodedHtml)
  )

  // 3) 图片分块：每张图一个 part，Content-ID 与 cid: 引用对应
  images.forEach((image, cid) => {
    parts.push(
      '',
      `--${boundary}`,
      `Content-Type: ${image.mime}`,
      'Content-Transfer-Encoding: base64',
      `Content-ID: <${cid}>`,
      `Content-Location: ${cid}`,
      '',
      wrapBase64(image.base64)
    )
  })

  parts.push('', `--${boundary}--`, '')
  return parts.join('\r\n')
}

/**
 * 将正文 HTML 转换为 .docx 文件的 Blob：
 * 组装最小 OOXML 包（document.xml 通过 altChunk 引用 MHT 分块），
 * Word 打开时原生渲染 HTML 内容——base64 图片、表格、文字样式完整保留
 * @param bodyHtml 正文 HTML
 * @returns .docx 文件的 Blob 对象
 */
export const htmlToDocxBlob = async (bodyHtml: string): Promise<Blob> => {
  const mht = buildMhtPart(buildFullHtml(bodyHtml))

  // [Content_Types].xml：声明包内各部件的类型
  // 注意：altChunk 引用的 MHT 部件必须声明为 message/rfc822，
  // 声明为 text/html 会触发 Word"发现无法读取的内容"恢复提示
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/afchunk.mht" ContentType="message/rfc822"/>
</Types>`

  // 根关系：指向主文档 document.xml
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdDocument" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

  // 主文档：body 中以 altChunk 引用 HTML 分块（Word 打开时自动渲染）
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
<w:altChunk r:id="htmlChunk"/>
<w:sectPr>
<w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/>
</w:sectPr>
</w:body>
</w:document>`

  // 文档关系：altChunk 的 id 指向 MHT 部件
  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="htmlChunk" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="afchunk.mht"/>
</Relationships>`

  // 组装 ZIP 包并输出为 .docx Blob
  const zip = new JSZip()
  zip.file('[Content_Types].xml', contentTypes)
  zip.file('_rels/.rels', rootRels)
  zip.file('word/document.xml', documentXml)
  zip.file('word/_rels/document.xml.rels', documentRels)
  zip.file('word/afchunk.mht', mht)

  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  })
}

/**
 * 将正文 HTML 转换为 PDF 并触发下载：
 * 离屏渲染（内容区宽度 = A4 宽度 - 页边距），html2canvas 截为长图后
 * 按"页高 - 上下边距"切片，逐页写入 jsPDF，四周保留页边距
 * @param bodyHtml 正文 HTML
 * @param fileName 完整文件名（含 .pdf 扩展名）
 */
export const exportPdfFile = async (bodyHtml: string, fileName: string): Promise<void> => {
  // PDF 页面尺寸与边距（pt 单位）：A4 = 595 x 842 pt，边距 40pt ≈ 14mm
  const pdf = new jsPDF('p', 'pt', 'a4')
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const margin = 40
  const contentWidth = pageWidth - margin * 2
  const contentHeight = pageHeight - margin * 2

  // 1) 离屏容器：宽度与 PDF 内容区等比（A4 内容区 715pt 对应 715px），
  //    样式全部作用域限定在容器内——若使用全局 <style>（如 body{...}）
  //    会被浏览器提升为全局样式，导致整个应用页面排版跳动
  const container = document.createElement('div')
  container.className = 'dot-editor-pdf-root'
  container.style.cssText =
    'position:fixed;left:-10000px;top:0;width:715px;background:#ffffff;color:#1f2328;' +
    'font-family:"Microsoft YaHei","PingFang SC",sans-serif;font-size:15px;line-height:1.8;'
  container.innerHTML =
    `<style>
      .dot-editor-pdf-root h1{font-size:28px;margin:0.9em 0 0.5em}
      .dot-editor-pdf-root h2{font-size:22px;margin:0.9em 0 0.5em}
      .dot-editor-pdf-root h3{font-size:18px;margin:0.9em 0 0.5em}
      .dot-editor-pdf-root p{margin:0.4em 0}
      .dot-editor-pdf-root table{border-collapse:collapse;width:100%}
      .dot-editor-pdf-root td,.dot-editor-pdf-root th{border:1px solid #999999;padding:6px 10px}
      .dot-editor-pdf-root th{background:#f5f7fa;font-weight:600}
      .dot-editor-pdf-root img{max-width:100%}
      .dot-editor-pdf-root mark{background:#ffe58f}
      .dot-editor-pdf-root blockquote{border-left:4px solid #409eff;padding:2px 14px;color:#6b7280;margin:10px 0}
      .dot-editor-pdf-root pre{background:#f5f7fa;padding:12px}
      .dot-editor-pdf-root ul,.dot-editor-pdf-root ol{padding-left:1.6em}
      .dot-editor-pdf-root a{color:#409eff}
      .dot-editor-pdf-root hr{border:none;border-top:1px solid #dcdfe6;margin:18px 0}
    </style>` + bodyHtml
  document.body.appendChild(container)

  try {
    // 2) 渲染为 canvas（scale: 2 保证清晰度）
    const canvas = await html2canvas(container, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff'
    })

    // 3) 按内容区尺寸切片：一页可容纳的 canvas 像素高度（按内容宽度等比换算）
    const pageCanvasHeight = Math.floor((canvas.width * contentHeight) / contentWidth)
    const totalPages = Math.max(1, Math.ceil(canvas.height / pageCanvasHeight))

    for (let page = 0; page < totalPages; page++) {
      if (page > 0) pdf.addPage()
      // 切出当前页对应的 canvas 区域
      const sliceHeight = Math.min(pageCanvasHeight, canvas.height - page * pageCanvasHeight)
      const pageCanvas = document.createElement('canvas')
      pageCanvas.width = canvas.width
      pageCanvas.height = sliceHeight
      const context = pageCanvas.getContext('2d')
      if (!context) continue
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, pageCanvas.width, pageCanvas.height)
      context.drawImage(
        canvas,
        0,
        page * pageCanvasHeight,
        canvas.width,
        sliceHeight,
        0,
        0,
        canvas.width,
        sliceHeight
      )
      // 写入 PDF：从边距处开始绘制，宽度为内容区宽度，高度按比例换算为 pt
      pdf.addImage(
        pageCanvas.toDataURL('image/jpeg', 0.92),
        'JPEG',
        margin,
        margin,
        contentWidth,
        (sliceHeight * contentWidth) / canvas.width
      )
    }

    pdf.save(fileName)
  } finally {
    // 4) 无论成功与否都移除离屏容器
    container.remove()
  }
}

/* ================================ 四、下载触发 ================================ */

/**
 * 将内容生成文件并触发浏览器下载
 * @param fileName 完整文件名（含扩展名）
 * @param content 文件内容
 * @param mimeType MIME 类型
 */
export const exportContentFile = (fileName: string, content: string, mimeType: string): void => {
  // 通过 Blob + 隐藏 <a> 标签触发浏览器下载
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

/**
 * 将 Blob 生成文件并触发浏览器下载（用于二进制格式如 .docx）
 * @param fileName 完整文件名（含扩展名）
 * @param blob 文件内容的 Blob 对象
 */
export const exportBlobFile = (fileName: string, blob: Blob): void => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

/* ================================ 五、AI 文本编辑 ================================ */

/**
 * 调用「智能配置」中启用的大模型，根据指令编辑文本
 * @param text 待编辑的原始文本
 * @param instruction 编辑指令（如：润色、翻译成英文、扩写等）
 * @returns AI 编辑后的文本
 * @throws 未配置/未启用大模型或接口调用失败时抛出异常
 */
export const requestAiEdit = async (text: string, instruction: string): Promise<string> => {
  const result = await sendLlm(
    [
      {
        role: 'system',
        content:
          '你是一个专业的文本编辑助手。用户会给出一段文本和一条编辑指令，' +
          '你只需输出按照指令编辑后的文本，不要输出任何解释、前言或多余内容。'
      },
      {
        role: 'user',
        content: `编辑指令：${instruction}\n\n待编辑文本：\n${text}`
      }
    ],
    { temperature: 0.7 }
  )
  if (!result.content) {
    throw new Error('AI 未返回有效内容，请稍后重试')
  }
  return result.content
}
