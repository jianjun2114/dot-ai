<script setup lang="ts">
/**
 * DotEditor —— 独立的富文本/Markdown 双视图编辑器组件
 *
 * 以 Tiptap 为内核，自研 UI 层与扩展，不依赖项目中其他页面；
 * Markdown 视图基于 md-editor-v3（左编辑 / 右预览），与 Tiptap 通过
 * "数据层统一（HTML），展示层分离" 的方式共存。
 *
 * 组件三种形态：
 *   1. 未传入文件路径（filePath 为空）：居中提示"请先创建文件"；
 *   2. 传入文件路径：富文本视图（工具区 + 文本编辑区）；
 *   3. 切换为 Markdown 视图：仅保留"返回富文本"按钮 + 左编辑器右预览。
 *
 * 对外接口：
 *   props : filePath   当前编辑文件的绝对路径（空串表示未打开文件）
 *           modelValue 文档内容（HTML，统一数据层格式）
 *   emit  : update:modelValue 内容变化时上报 HTML
 */
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import { StarterKit } from '@tiptap/starter-kit'
import { TextStyle, Color, FontSize, BackgroundColor } from '@tiptap/extension-text-style'
import { Highlight } from '@tiptap/extension-highlight'
import { TextAlign } from '@tiptap/extension-text-align'
import { Image } from '@tiptap/extension-image'
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table'
import { MdEditor } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'
import { ElMessage } from 'element-plus'
import type { PopoverInstance } from 'element-plus'
import {
  Picture,
  Link,
  Grid,
  Download,
  MagicStick,
  Document,
  Tickets,
  Memo,
  Back,
  Printer
} from '@element-plus/icons-vue'
import { useTheme } from '../composables/useTheme'
import {
  ParagraphStyle,
  htmlToMarkdown,
  markdownToHtml,
  exportContentFile,
  exportBlobFile,
  htmlToDocxBlob,
  exportPdfFile,
  ensureEmptyParagraphBreaks,
  requestAiEdit
} from '../composables/dotEditor'
// 工具栏静态图标（高亮 / 字体颜色）
import fontBgSvg from '../assets/font-bg.svg'
import fontColorSvg from '../assets/font-color.svg'

// ============================== 组件接口 ==============================

interface Props {
  /** 当前编辑文件的绝对路径；空串表示未打开任何文件 */
  filePath: string
  /** 文档内容（HTML 格式，统一数据层） */
  modelValue: string
}

const props = defineProps<Props>()

/** 内容变化时向父组件上报最新 HTML */
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

const { theme } = useTheme()

// ============================== 常量定义 ==============================

/** 字号选项（value 为空表示恢复默认字号） */
const FONT_SIZE_OPTIONS = [
  { label: '默认', value: '' },
  { label: '12px', value: '12px' },
  { label: '14px', value: '14px' },
  { label: '16px', value: '16px' },
  { label: '18px', value: '18px' },
  { label: '20px', value: '20px' },
  { label: '24px', value: '24px' },
  { label: '28px', value: '28px' },
  { label: '32px', value: '32px' }
]

/** 颜色选择器预设色板 */
const PRESET_COLORS = [
  '#409eff',
  '#67c23a',
  '#e6a23c',
  '#f56c6c',
  '#909399',
  '#ffe58f',
  '#b37feb',
  '#ff85c0',
  '#ffffff',
  '#000000'
]

/** AI 编辑快捷指令 */
const AI_QUICK_ACTIONS = ['润色', '扩写', '补全', '精简', '总结', '翻译成英文', '修正错别字']

/** 表格悬浮选择网格的规格（5 行 5 列） */
const TABLE_GRID_SIZE = 5

/**
 * 工具区自绘 SVG 图标（element-plus 无对应图标，统一线条风格）
 * key 与模板中的使用一一对应
 */
const ICONS: Record<string, string> = {
  alignLeft:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="18" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="15" y2="18"/></svg>',
  alignCenter:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="18" y2="18"/></svg>',
  alignRight:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/></svg>',
  vCenter:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="3"/><line x1="7" y1="12" x2="17" y2="12"/></svg>',
  indent:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="9" y1="5" x2="21" y2="5"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="19" x2="21" y2="19"/></svg>',
  orderedList:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><text x="2" y="8.5" font-size="8" font-weight="600" fill="currentColor" stroke="none">1.</text><text x="2" y="15.5" font-size="8" font-weight="600" fill="currentColor" stroke="none">2.</text><line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="13" x2="21" y2="13"/><line x1="9" y1="20" x2="21" y2="20"/></svg>',
  bulletList:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="4" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="4" cy="13" r="1.5" fill="currentColor" stroke="none"/><circle cx="4" cy="20" r="1.5" fill="currentColor" stroke="none"/><line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="13" x2="21" y2="13"/><line x1="9" y1="20" x2="21" y2="20"/></svg>',
  horizontalRule:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="5" x2="10" y2="5"/><line x1="14" y1="5" x2="21" y2="5"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="19" x2="10" y2="19"/><line x1="14" y1="19" x2="21" y2="19"/></svg>',
  markdownView:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 15v-5l2.5 2.5L11 10v5"/><line x1="15" y1="10" x2="18" y2="14"/><line x1="18" y1="10" x2="15" y2="14"/></svg>'
}

// ============================== 粘贴内容处理 ==============================

/** 可内嵌的位图图片扩展名与 MIME 映射（wmf/emf 等矢量格式 Chromium 无法渲染，不处理） */
const RASTER_IMAGE_MIME: Record<string, string> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  bmp: 'bmp',
  webp: 'webp'
}

/**
 * 清理 Word/Excel 粘贴的 HTML 杂质：
 * 去除条件注释、mso 命名空间标签、class 属性及 mso 内联样式
 * @param html 原始粘贴 HTML
 * @returns 清理后的 HTML
 */
const sanitizeWordHtml = (html: string): string =>
  html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[a-zA-Z]+:[^>\s/][^>]*>/g, '')
    .replace(/\s+class="[^"]*"/gi, '')
    .replace(/\s+style="[^"]*mso[^"]*"/gi, '')

/**
 * 将 file:/// 协议的本地图片 URI 转换为 base64 数据地址
 * @param uri file 协议图片地址（如 file:///C:/Temp/clip_image001.png）
 * @returns 转换成功返回数据地址；文件不存在或格式不支持返回 null
 */
const localImageToDataUrl = async (uri: string): Promise<string | null> => {
  // file:///C:/x.png 或 file:///C:\x.png -> C:/x.png
  const filePath = decodeURIComponent(uri.replace(/^file:\/+/, '')).replace(/\\/g, '/')
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  const mime = RASTER_IMAGE_MIME[ext]
  if (!mime) return null

  // 通过主进程读取本地图片文件为 base64（渲染进程无法直接访问本地文件）
  const base64 = await window.dot.localFiles('read-base64', filePath)
  if (typeof base64 === 'string' && base64) {
    return `data:image/${mime};base64,${base64}`
  }
  return null
}

/**
 * 处理 Word/Excel 富文本粘贴（含本地图片）：
 * Word 剪贴板 HTML 中的图片以 file:/// 本地临时文件引用（渲染进程无法直接访问），
 * 且截图类图片常包裹在 VML 结构（v:shape / v:imagedata）或条件注释中。
 * 此处基于 DOMParser 做结构化处理：
 *   1) 移除全部注释节点（含条件注释中的 VML 图形，避免与 <img> 回退内容重复）；
 *   2) 将引用本地文件的图片元素（img / v:imagedata）读取为 base64 并替换为标准 <img>；
 *   3) 展开 mso 命名空间标签（o: / v: / w: 等），保留其内部内容；
 *   4) 仅取 body 序列化，清理杂质后插入编辑器。
 * 任一环节异常时降级为纯文本粘贴，保证粘贴永不整体失效。
 * @param html 剪贴板中的原始 HTML
 * @param plainText 剪贴板纯文本（降级兜底用）
 */
const pasteWordHtml = async (html: string, plainText: string): Promise<void> => {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')

    // 1) 移除全部注释节点（Word 条件注释、<![if !vml]> 伪注释等）
    const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_COMMENT)
    const comments: Comment[] = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      comments.push(node as Comment)
    }
    comments.forEach((comment) => comment.remove())

    // 2) 处理引用本地文件的图片元素（标准 <img> 或 VML <v:imagedata>）
    const elements = [...doc.body.querySelectorAll('*')]
    for (const el of elements) {
      const src = el.getAttribute('src')
      if (!src || !/^file:/i.test(src)) continue

      const dataUrl = await localImageToDataUrl(src)
      if (dataUrl) {
        const img = doc.createElement('img')
        img.setAttribute('src', dataUrl)
        el.replaceWith(img)
      } else {
        // 文件不存在或不支持的格式（wmf/emf 等）：直接剔除
        el.remove()
      }
    }

    // 3) 展开 mso 命名空间标签（o:p / v:shape 等），保留内部内容
    for (const el of [...doc.body.querySelectorAll('*')]) {
      if (el.tagName.includes(':')) {
        el.replaceWith(...el.childNodes)
      }
    }

    // 4) 仅取 body 内容，清理 class / mso 样式后插入
    editor.value?.chain().focus().insertContent(sanitizeWordHtml(doc.body.innerHTML)).run()
  } catch (error) {
    // 降级：插入纯文本，避免粘贴整体失效
    console.error('[DotEditor] Word 内容粘贴处理失败:', error)
    if (plainText) {
      editor.value?.chain().focus().insertContent(plainText).run()
    }
  }
}

// ============================== 编辑器实例 ==============================

/**
 * 工具栏状态刷新计数器：
 * Tiptap v3 的 useEditor 默认不在事务（transaction）后重渲染，
 * 通过计数器触发依赖它的 computed 重新计算，保证按钮激活态实时更新。
 */
const toolbarTick = ref(0)

/** Tiptap 编辑器实例（ShallowRef） */
const editor = useEditor({
  // 初始内容为父组件传入的 HTML
  content: props.modelValue,
  extensions: [
    // 基础套件：段落/标题/加粗/斜体/删除线/列表/代码块/水平线/链接等
    StarterKit.configure({
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' }
    }),
    // 文字样式：字号 / 字体颜色 / 背景色（依赖 TextStyle）
    TextStyle,
    Color,
    FontSize,
    BackgroundColor,
    // 高亮（多色）
    Highlight.configure({ multicolor: true }),
    // 段落对齐（作用于标题与段落）
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    // 图片（允许 base64 内嵌）
    Image.configure({ inline: false, allowBase64: true }),
    // 表格（可拖拽调整列宽）
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    // 自定义段落属性：首行缩进 / 垂直居中
    ParagraphStyle
  ],
  editorProps: {
    // spellcheck=false 关闭浏览器原生拼写检查（去掉随机字符串下的红色波浪线）
    attributes: { class: 'dot-editor-prose', spellcheck: 'false' },
    /**
     * Ctrl/Cmd 按下/松开时切换光标样式：
     * 按住 Ctrl 悬停链接显示小手（配合 handleClick 的 Ctrl+点击打开）
     */
    handleDOMEvents: {
      keydown: (_view, event) => {
        if (event.ctrlKey || event.metaKey) {
          editor.value?.view.dom.classList.add('ctrl-pressed')
        }
        return false
      },
      keyup: () => {
        editor.value?.view.dom.classList.remove('ctrl-pressed')
        return false
      },
      mouseover: (_view, event) => {
        // Ctrl 按住状态下的 mousemove 才触发（部分系统 keyup 不派发到编辑器）
        if (event.ctrlKey || event.metaKey) {
          editor.value?.view.dom.classList.add('ctrl-pressed')
        } else {
          editor.value?.view.dom.classList.remove('ctrl-pressed')
        }
        return false
      }
    },
    /**
     * Ctrl/Cmd + 点击 链接时在系统浏览器中打开
     * （主进程 setWindowOpenHandler 会将 window.open 重定向到外部浏览器）
     */
    handleClick: (_view, _pos, event) => {
      if (!(event.ctrlKey || event.metaKey)) return false
      const anchor = (event.target as HTMLElement).closest('a')
      if (anchor) {
        const href = anchor.getAttribute('href')
        if (href) window.open(href, '_blank')
        return true
      }
      return false
    },
    /**
     * 粘贴拦截：
     * 1) 剪贴板中的图片文件（截图/复制图片）转 base64 后插入；
     * 2) Word/Excel 粘贴的富文本若引用了本地图片（file:// 协议），
     *    读取原图片文件转 base64 后再整体插入（见 pasteWordHtml）；
     * 3) 其余富文本粘贴交由 ProseMirror 默认流程解析。
     */
    handlePaste: (_view, event) => {
      const clipboard = event.clipboardData
      if (!clipboard) return false

      // 1) 直接粘贴的图片文件
      const imageFiles = Array.from(clipboard.files || []).filter((file) =>
        file.type.startsWith('image/')
      )
      if (imageFiles.length > 0) {
        event.preventDefault()
        insertImageFiles(imageFiles)
        return true
      }

      // 2) Word/Excel 富文本包含本地图片引用（<img src="file:..."> 或 VML <v:imagedata>）
      const html = clipboard.getData('text/html')
      if (html && /src=["']?file:/i.test(html)) {
        event.preventDefault()
        const plainText = clipboard.getData('text/plain')
        void pasteWordHtml(html, plainText)
        return true
      }
      return false
    },
    /**
     * 粘贴 HTML 预处理：清理 Word/Excel 特有杂质，
     * 并剔除指向本地文件的失效图片（file:// 协议无法展示；
     * 含本地图片的粘贴已在 handlePaste 中先行拦截处理）
     */
    transformPastedHTML: (html) =>
      sanitizeWordHtml(html).replace(/<img[^>]+src=["']file:[^"']*["'][^>]*>/gi, '')
  },
  /** 任何事务后刷新工具栏状态 */
  onTransaction: () => {
    toolbarTick.value++
  },
  /** 内容变化时上报父组件（自动保存由父组件负责） */
  onUpdate: () => {
    emit('update:modelValue', editor.value?.getHTML() || '')
  }
})

// ============================== 视图切换 ==============================

/** 当前视图：富文本 / Markdown */
const viewMode = ref<'richtext' | 'markdown'>('richtext')

/** Markdown 视图中的文本内容 */
const markdownText = ref('')

/** 是否已打开文件 */
const hasFile = computed(() => !!props.filePath)

/** Markdown 编辑器主题（跟随全局主题） */
const mdTheme = computed<'light' | 'dark'>(() => (theme.value === 'dark' ? 'dark' : 'light'))

/** Markdown 内容同步父组件的防抖定时器 */
let markdownSyncTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 切换到 Markdown 视图：将当前富文本 HTML 转为 Markdown
 */
const switchToMarkdown = (): void => {
  if (!editor.value) return
  markdownText.value = htmlToMarkdown(editor.value.getHTML())
  viewMode.value = 'markdown'
}

/**
 * 切换回富文本视图：将 Markdown 文本转为 HTML 并写回编辑器
 */
const switchToRichText = (): void => {
  if (!editor.value) return
  const html = markdownToHtml(markdownText.value)
  // emitUpdate 确保内容变化同步到父组件
  editor.value.commands.setContent(html, { emitUpdate: true })
  viewMode.value = 'richtext'
}

/**
 * 监听 Markdown 文本变化：防抖后转换为 HTML 上报父组件，
 * 保证在 Markdown 视图下编辑的内容同样能被自动保存
 */
watch(markdownText, () => {
  if (markdownSyncTimer) clearTimeout(markdownSyncTimer)
  markdownSyncTimer = setTimeout(() => {
    // 已切回富文本视图时不生效，避免旧值覆盖新内容
    if (viewMode.value === 'markdown') {
      emit('update:modelValue', markdownToHtml(markdownText.value))
    }
  }, 500)
})

/**
 * 打开的文件变化时：重置为富文本视图
 */
watch(
  () => props.filePath,
  () => {
    viewMode.value = 'richtext'
  }
)

/**
 * 父组件传入的内容变化时（如打开新文件）：
 * 与编辑器当前内容不一致才重设，避免输入过程中光标跳动
 */
watch(
  () => props.modelValue,
  (value) => {
    const current = editor.value?.getHTML() || ''
    if (value !== current) {
      editor.value?.commands.setContent(value || '<p></p>')
    }
  }
)

/** 组件卸载前清理防抖定时器 */
onBeforeUnmount(() => {
  if (markdownSyncTimer) clearTimeout(markdownSyncTimer)
})

// ============================== 工具栏状态 ==============================

/** 当前字号（取选区 textStyle 属性） */
const currentFontSize = computed(() => {
  void toolbarTick.value
  return editor.value?.getAttributes('textStyle').fontSize || ''
})

/** 加粗激活态 */
const isBoldActive = computed(() => {
  void toolbarTick.value
  return editor.value?.isActive('bold') ?? false
})

/** 倾斜激活态 */
const isItalicActive = computed(() => {
  void toolbarTick.value
  return editor.value?.isActive('italic') ?? false
})

/** 当前高亮颜色 */
const currentHighlightColor = computed(() => {
  void toolbarTick.value
  return editor.value?.getAttributes('highlight').color || ''
})

/** 当前字体颜色 */
const currentFontColor = computed(() => {
  void toolbarTick.value
  return editor.value?.getAttributes('textStyle').color || ''
})

/** 当前段落对齐方式（null 表示未设置） */
const currentAlign = computed<'left' | 'center' | 'right' | null>(() => {
  void toolbarTick.value
  const e = editor.value
  if (!e) return null
  if (e.isActive({ textAlign: 'center' })) return 'center'
  if (e.isActive({ textAlign: 'right' })) return 'right'
  if (e.isActive({ textAlign: 'left' })) return 'left'
  return null
})

/** 首行缩进激活态 */
const isIndentActive = computed(() => {
  void toolbarTick.value
  return !!editor.value?.getAttributes('paragraph').indent
})

/** 垂直居中激活态 */
const isVCenterActive = computed(() => {
  void toolbarTick.value
  return !!editor.value?.getAttributes('paragraph').vCenter
})

// ============================== 文字区操作 ==============================

/**
 * 设置字号；空值表示恢复默认字号
 * @param size 字号（如 '16px'），空串恢复默认
 */
const applyFontSize = (size: string): void => {
  const chain = editor.value?.chain().focus()
  if (!chain) return
  if (size) {
    chain.setFontSize(size).run()
  } else {
    chain.unsetFontSize().run()
  }
}

/** 切换加粗 */
const toggleBold = (): void => {
  editor.value?.chain().focus().toggleBold().run()
}

/** 切换倾斜 */
const toggleItalic = (): void => {
  editor.value?.chain().focus().toggleItalic().run()
}

/**
 * 设置高亮背景色；清空颜色时取消高亮
 * @param color 颜色值（清空为 null）
 */
const applyHighlightColor = (color: string | null): void => {
  const chain = editor.value?.chain().focus()
  if (!chain) return
  if (color) {
    chain.setHighlight({ color }).run()
  } else {
    chain.unsetHighlight().run()
  }
}

/**
 * 设置字体颜色；清空颜色时恢复默认
 * @param color 颜色值（清空为 null）
 */
const applyFontColor = (color: string | null): void => {
  const chain = editor.value?.chain().focus()
  if (!chain) return
  if (color) {
    chain.setColor(color).run()
  } else {
    chain.unsetColor().run()
  }
}

/**
 * 自定义高亮颜色输入（色板中的原生颜色选择器）
 * @param event 原生 color input 的 input 事件
 */
const onCustomHighlightColor = (event: Event): void => {
  applyHighlightColor((event.target as HTMLInputElement).value)
}

/**
 * 自定义字体颜色输入（色板中的原生颜色选择器）
 * @param event 原生 color input 的 input 事件
 */
const onCustomFontColor = (event: Event): void => {
  applyFontColor((event.target as HTMLInputElement).value)
}

// ============================== 段落区操作 ==============================

/**
 * 设置段落水平对齐方式
 * @param align 对齐方式：left / center / right
 */
const applyAlign = (align: 'left' | 'center' | 'right'): void => {
  editor.value?.chain().focus().setTextAlign(align).run()
}

/** 切换首行缩进（data-indent 属性，CSS 实现 2em 缩进） */
const toggleIndent = (): void => {
  const current = editor.value?.getAttributes('paragraph').indent
  editor.value?.chain().focus().updateAttributes('paragraph', { indent: !current }).run()
}

/** 切换垂直居中（data-v-center 属性，CSS 提升行高实现视觉居中） */
const toggleVCenter = (): void => {
  const current = editor.value?.getAttributes('paragraph').vCenter
  editor.value?.chain().focus().updateAttributes('paragraph', { vCenter: !current }).run()
}

// ============================== 插入区操作 ==============================

/** 切换有序列表（1. 2. 3.） */
const toggleOrderedList = (): void => {
  editor.value?.chain().focus().toggleOrderedList().run()
}

/** 切换无序列表（·） */
const toggleBulletList = (): void => {
  editor.value?.chain().focus().toggleBulletList().run()
}

/** 插入水平分割线 */
const insertHorizontalRule = (): void => {
  editor.value?.chain().focus().setHorizontalRule().run()
}

// ---------- 表格 ----------

/** 表格悬浮框实例（插入后关闭） */
const tablePopoverRef = ref<PopoverInstance>()

/** 悬停选中的行数 / 列数 */
const hoverRows = ref(3)
const hoverCols = ref(3)

/** 自定义行列输入值 */
const customRows = ref(3)
const customCols = ref(3)

/**
 * 计算网格单元格的行列坐标
 * @param index 单元格序号（1 起）
 * @returns 行、列（1 起）
 */
const cellPosition = (index: number): { row: number; col: number } => ({
  row: Math.ceil(index / TABLE_GRID_SIZE),
  col: ((index - 1) % TABLE_GRID_SIZE) + 1
})

/**
 * 悬停网格单元格：更新预选行列
 * @param index 单元格序号
 */
const onCellHover = (index: number): void => {
  const { row, col } = cellPosition(index)
  hoverRows.value = row
  hoverCols.value = col
}

/**
 * 判断网格单元格是否处于预选范围内
 * @param index 单元格序号
 */
const isCellActive = (index: number): boolean => {
  const { row, col } = cellPosition(index)
  return row <= hoverRows.value && col <= hoverCols.value
}

/**
 * 按指定行列插入表格并关闭悬浮框
 * @param rows 行数
 * @param cols 列数
 */
const insertTableWithSize = (rows: number, cols: number): void => {
  editor.value?.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run()
  tablePopoverRef.value?.hide()
}

/**
 * 点击网格单元格：按预选行列插入表格
 * @param index 单元格序号
 */
const insertTableByGrid = (index: number): void => {
  const { row, col } = cellPosition(index)
  insertTableWithSize(row, col)
}

/** 通过输入框指定的行列插入表格 */
const insertTableCustom = (): void => {
  insertTableWithSize(customRows.value, customCols.value)
}

// ---------- 图片 ----------

/** 隐藏的图片选择输入框 */
const imageInputRef = ref<HTMLInputElement>()

/**
 * 读取文件为 base64 数据地址
 * @param file 图片文件
 */
const readFileAsDataURL = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

/**
 * 将图片文件批量插入编辑器（base64 内嵌，随文档一起保存）
 * @param files 图片文件列表
 */
const insertImageFiles = async (files: File[]): Promise<void> => {
  try {
    for (const file of files) {
      const src = await readFileAsDataURL(file)
      editor.value?.chain().focus().setImage({ src, alt: file.name }).run()
    }
  } catch (error) {
    console.error('[DotEditor] 插入图片失败:', error)
    ElMessage.error('图片插入失败')
  }
}

/**
 * 图片选择输入框变化：插入所选图片
 * @param event 输入框事件
 */
const onImageInputChange = async (event: Event): Promise<void> => {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files || [])
  if (files.length > 0) {
    await insertImageFiles(files)
  }
  // 重置 value 允许再次选择同一文件
  input.value = ''
}

/** 打开系统文件选择窗口选择图片 */
const pickImage = (): void => {
  imageInputRef.value?.click()
}

// ---------- 链接 ----------

/** 链接弹窗可见性 */
const linkDialogVisible = ref(false)

/** 链接地址 */
const linkUrl = ref('')

/** 链接显示文本（仅无选中内容时使用） */
const linkText = ref('')

/** 打开链接弹窗时是否存在选中文本 */
const linkHasSelection = ref(false)

/**
 * 打开链接插入弹窗：记录当前选区状态并预填已有链接地址
 */
const openLinkDialog = (): void => {
  if (!editor.value) return
  const { from, to } = editor.value.state.selection
  linkHasSelection.value = to > from
  // 已是链接时预填地址，便于修改
  linkUrl.value = editor.value.getAttributes('link').href || ''
  linkText.value = ''
  linkDialogVisible.value = true
}

/**
 * 确认插入链接：
 * - 有选中内容：直接为选中文字设置链接；
 * - 无选中内容：以输入的显示文本新建链接。
 */
const confirmInsertLink = (): void => {
  const href = linkUrl.value.trim()
  if (!href) {
    ElMessage.warning('请输入链接地址')
    return
  }
  if (!/^https?:\/\//i.test(href) && !href.startsWith('#')) {
    ElMessage.warning('链接地址需以 http:// 或 https:// 开头')
    return
  }

  if (linkHasSelection.value) {
    editor.value?.chain().focus().setLink({ href }).run()
  } else {
    const text = linkText.value.trim() || href
    editor.value
      ?.chain()
      .focus()
      .insertContent({
        type: 'text',
        text,
        marks: [{ type: 'link', attrs: { href } }]
      })
      .run()
  }
  linkDialogVisible.value = false
}

// ============================== 功能区操作 ==============================

/** 导出格式选择弹窗可见性 */
const exportDialogVisible = ref(false)

/** 导出格式类型 */
type ExportFormat = 'html' | 'word' | 'pdf' | 'txt'

/**
 * 获取导出文件的基础名（去除路径与扩展名）
 */
const getExportBaseName = (): string =>
  props.filePath
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.[^.]+$/, '') || '未命名文档'

/**
 * 将 HTML 转换为带格式标记的纯文本：
 * 保留换行（段落/标题/列表/表格行）与加粗 **、字号标记
 * @param bodyHtml 正文 HTML
 * @returns 带格式标记的纯文本
 */
const htmlToFormattedText = (bodyHtml: string): string => {
  const doc = new DOMParser().parseFromString(bodyHtml, 'text/html')

  /** 递归将节点转为文本（加粗包 **，字号包标记） */
  const nodeToText = (node: Node): string => {
    // 文本节点直接返回
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''

    const el = node as HTMLElement
    const children = Array.from(el.childNodes).map(nodeToText).join('')

    switch (el.tagName) {
      case 'BR':
        return '\n'
      case 'STRONG':
      case 'B':
        return children ? `**${children}**` : ''
      case 'TABLE': {
        // 表格：每行单元格以制表符分隔
        const rows = Array.from(el.querySelectorAll('tr')).map((tr) =>
          Array.from(tr.querySelectorAll('th,td'))
            .map((cell) => nodeToText(cell).replace(/\n/g, ' '))
            .join('\t')
        )
        return rows.join('\n')
      }
      default: {
        // 块级元素后补换行
        const blockTags = new Set([
          'P',
          'DIV',
          'H1',
          'H2',
          'H3',
          'H4',
          'H5',
          'H6',
          'LI',
          'UL',
          'OL',
          'BLOCKQUOTE',
          'PRE',
          'HR'
        ])
        const size = el.style.fontSize
        const withSize = size ? `【字号:${size}】${children}` : children
        return blockTags.has(el.tagName) ? `${withSize}\n` : withSize
      }
    }
  }

  // 合并多余空行
  return nodeToText(doc.body)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 按所选格式导出当前文档内容
 * - html：仅内容的格式标签（不含 html / body 外壳）与完整格式
 * - word：.docx（OOXML altChunk 方案，Word 打开包含图片、表格、文字段落）
 * - txt ：纯文本，保留换行、加粗、字号格式标记
 * @param format 导出格式
 */
const exportAs = async (format: ExportFormat): Promise<void> => {
  if (!editor.value) return
  // 空段落补 <br> 占位，保证回车产生的空白行在导出文件中可见
  const html = ensureEmptyParagraphBreaks(editor.value.getHTML())
  const baseName = getExportBaseName()

  try {
    if (format === 'html') {
      exportContentFile(`${baseName}.html`, html, 'text/html;charset=utf-8')
      ElMessage.success('已导出 HTML 标签文件')
    } else if (format === 'word') {
      // 生成真正的 .docx（Word 原生渲染 HTML 内容）
      const blob = await htmlToDocxBlob(html)
      exportBlobFile(`${baseName}.docx`, blob)
      ElMessage.success('已导出 Word 文档')
    } else if (format === 'pdf') {
      // html2canvas + jsPDF 生成 A4 分页 PDF
      await exportPdfFile(html, `${baseName}.pdf`)
      ElMessage.success('已导出 PDF 文件')
    } else {
      exportContentFile(`${baseName}.txt`, htmlToFormattedText(html), 'text/plain;charset=utf-8')
      ElMessage.success('已导出 TXT 文本文件')
    }
    exportDialogVisible.value = false
  } catch (error) {
    console.error('[DotEditor] 导出失败:', error)
    ElMessage.error('导出失败')
  }
}

// ---------- AI 编辑 ----------

/** AI 编辑弹窗可见性 */
const aiDialogVisible = ref(false)

/** AI 待编辑的选中文本 */
const aiSelection = ref('')

/** AI 编辑指令 */
const aiInstruction = ref('')

/** AI 请求进行中标记 */
const aiLoading = ref(false)

/**
 * 打开 AI 编辑弹窗：
 * 需先在编辑器中选中内容，否则提示并中断
 */
const openAiDialog = (): void => {
  if (!editor.value) return
  const { from, to } = editor.value.state.selection
  aiSelection.value = editor.value.state.doc.textBetween(from, to, '\n')
  if (!aiSelection.value.trim()) {
    ElMessage.warning('请先选中要编辑的内容')
    return
  }
  aiInstruction.value = ''
  aiDialogVisible.value = true
}

/**
 * 点击快捷指令：直接填入指令输入框
 * @param action 快捷指令文本
 */
const applyAiQuickAction = (action: string): void => {
  aiInstruction.value = action
}

/**
 * 执行 AI 编辑：调用接口处理选中文本，
 * 成功后用结果替换编辑器中的选区（换行保留为换行符）
 */
const runAiEdit = async (): Promise<void> => {
  if (!aiInstruction.value.trim()) {
    ElMessage.warning('请输入编辑指令')
    return
  }
  aiLoading.value = true
  try {
    const result = await requestAiEdit(aiSelection.value, aiInstruction.value)
    // 将结果按行拆分，行间插入换行符节点以保留段落结构
    const lines = result.split(/\r?\n/)
    const content = lines.flatMap((line, index) =>
      index < lines.length - 1
        ? [{ type: 'text', text: line }, { type: 'hardBreak' }]
        : [{ type: 'text', text: line }]
    )
    editor.value?.chain().focus().insertContent(content).run()
    aiDialogVisible.value = false
    ElMessage.success('AI 编辑完成')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : 'AI 编辑失败')
  } finally {
    aiLoading.value = false
  }
}
</script>

<template>
  <!-- eslint-disable vue/no-v-html -- v-html 仅用于渲染组件内置的静态 SVG 图标常量，不包含任何用户输入，无 XSS 风险 -->
  <div class="dot-editor">
    <!-- ==================== 富文本视图（工具区 + 文本编辑区） ==================== -->
    <div v-show="hasFile && viewMode === 'richtext'" class="editor-richtext">
      <!-- 工具区 -->
      <div class="editor-toolbar">
        <!-- 文字区 -->
        <div class="tool-zone">
          <span class="zone-label">文字</span>
          <el-select
            :model-value="currentFontSize"
            class="font-size-select"
            size="small"
            placeholder="字号"
            @change="applyFontSize"
          >
            <el-option
              v-for="option in FONT_SIZE_OPTIONS"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
          <el-tooltip content="加粗" placement="top" :show-after="400">
            <button
              type="button"
              class="tool-btn"
              :class="{ 'is-active': isBoldActive }"
              @mousedown.prevent
              @click="toggleBold"
            >
              <span class="glyph glyph-bold">B</span>
            </button>
          </el-tooltip>
          <el-tooltip content="倾斜" placement="top" :show-after="400">
            <button
              type="button"
              class="tool-btn"
              :class="{ 'is-active': isItalicActive }"
              @mousedown.prevent
              @click="toggleItalic"
            >
              <span class="glyph glyph-italic">I</span>
            </button>
          </el-tooltip>
          <!-- 高亮（背景颜色）：font-bg.svg 图标 + 悬浮色板 -->
          <el-popover trigger="click" placement="bottom-start" :width="236">
            <template #reference>
              <button
                type="button"
                class="tool-btn"
                :class="{ 'is-active': !!currentHighlightColor }"
                title="高亮（背景颜色）"
                @mousedown.prevent
              >
                <img :src="fontBgSvg" class="tool-img" alt="高亮" />
              </button>
            </template>
            <div class="color-panel">
              <div class="color-grid">
                <button
                  v-for="color in PRESET_COLORS"
                  :key="color"
                  type="button"
                  class="color-swatch"
                  :class="{ 'is-active': currentHighlightColor === color }"
                  :style="{ backgroundColor: color }"
                  :title="color"
                  @click="applyHighlightColor(color)"
                ></button>
              </div>
              <div class="color-panel-footer">
                <label class="color-custom" title="自定义颜色">
                  <input type="color" @input="onCustomHighlightColor" />
                  <span>自定义</span>
                </label>
                <el-button size="small" text type="info" @click="applyHighlightColor(null)">
                  清除
                </el-button>
              </div>
            </div>
          </el-popover>
          <!-- 颜色（字体颜色）：font-color.svg 图标 + 悬浮色板 -->
          <el-popover trigger="click" placement="bottom-start" :width="236">
            <template #reference>
              <button
                type="button"
                class="tool-btn"
                :class="{ 'is-active': !!currentFontColor }"
                title="颜色（字体颜色）"
                @mousedown.prevent
              >
                <img :src="fontColorSvg" class="tool-img" alt="颜色" />
              </button>
            </template>
            <div class="color-panel">
              <div class="color-grid">
                <button
                  v-for="color in PRESET_COLORS"
                  :key="color"
                  type="button"
                  class="color-swatch"
                  :class="{ 'is-active': currentFontColor === color }"
                  :style="{ backgroundColor: color }"
                  :title="color"
                  @click="applyFontColor(color)"
                ></button>
              </div>
              <div class="color-panel-footer">
                <label class="color-custom" title="自定义颜色">
                  <input type="color" @input="onCustomFontColor" />
                  <span>自定义</span>
                </label>
                <el-button size="small" text type="info" @click="applyFontColor(null)">
                  清除
                </el-button>
              </div>
            </div>
          </el-popover>
        </div>

        <div class="zone-divider" />

        <!-- 段落区 -->
        <div class="tool-zone">
          <span class="zone-label">段落</span>
          <el-tooltip content="左对齐" placement="top" :show-after="400">
            <button
              type="button"
              class="tool-btn"
              :class="{ 'is-active': currentAlign === 'left' }"
              @mousedown.prevent
              @click="applyAlign('left')"
            >
              <span class="tool-icon" v-html="ICONS.alignLeft"></span>
            </button>
          </el-tooltip>
          <el-tooltip content="居中" placement="top" :show-after="400">
            <button
              type="button"
              class="tool-btn"
              :class="{ 'is-active': currentAlign === 'center' }"
              @mousedown.prevent
              @click="applyAlign('center')"
            >
              <span class="tool-icon" v-html="ICONS.alignCenter"></span>
            </button>
          </el-tooltip>
          <el-tooltip content="右对齐" placement="top" :show-after="400">
            <button
              type="button"
              class="tool-btn"
              :class="{ 'is-active': currentAlign === 'right' }"
              @mousedown.prevent
              @click="applyAlign('right')"
            >
              <span class="tool-icon" v-html="ICONS.alignRight"></span>
            </button>
          </el-tooltip>
          <el-tooltip content="垂直居中" placement="top" :show-after="400">
            <button
              type="button"
              class="tool-btn"
              :class="{ 'is-active': isVCenterActive }"
              @mousedown.prevent
              @click="toggleVCenter"
            >
              <span class="tool-icon" v-html="ICONS.vCenter"></span>
            </button>
          </el-tooltip>
          <el-tooltip content="首行缩进" placement="top" :show-after="400">
            <button
              type="button"
              class="tool-btn"
              :class="{ 'is-active': isIndentActive }"
              @mousedown.prevent
              @click="toggleIndent"
            >
              <span class="tool-icon" v-html="ICONS.indent"></span>
            </button>
          </el-tooltip>
        </div>

        <div class="zone-divider" />

        <!-- 插入区 -->
        <div class="tool-zone">
          <span class="zone-label">插入</span>
          <el-tooltip content="有序列表" placement="top" :show-after="400">
            <button type="button" class="tool-btn" @mousedown.prevent @click="toggleOrderedList">
              <span class="tool-icon" v-html="ICONS.orderedList"></span>
            </button>
          </el-tooltip>
          <el-tooltip content="无序列表" placement="top" :show-after="400">
            <button type="button" class="tool-btn" @mousedown.prevent @click="toggleBulletList">
              <span class="tool-icon" v-html="ICONS.bulletList"></span>
            </button>
          </el-tooltip>
          <el-tooltip content="水平线" placement="top" :show-after="400">
            <button type="button" class="tool-btn" @mousedown.prevent @click="insertHorizontalRule">
              <span class="tool-icon" v-html="ICONS.horizontalRule"></span>
            </button>
          </el-tooltip>
          <!-- 表格：悬浮框拖选 + 自定义行列 -->
          <el-popover ref="tablePopoverRef" trigger="click" placement="bottom-start" :width="252">
            <template #reference>
              <button type="button" class="tool-btn" title="表格">
                <el-icon :size="15"><Grid /></el-icon>
              </button>
            </template>
            <div class="table-grid">
              <div
                v-for="index in TABLE_GRID_SIZE * TABLE_GRID_SIZE"
                :key="index"
                class="table-grid-cell"
                :class="{ 'is-active': isCellActive(index) }"
                @mouseenter="onCellHover(index)"
                @click="insertTableByGrid(index)"
              ></div>
            </div>
            <div class="table-grid-tip">{{ hoverRows }} 行 × {{ hoverCols }} 列</div>
            <el-divider class="table-divider" />
            <div class="table-custom">
              <el-input-number v-model="customRows" :min="1" :max="20" size="small" />
              <span class="table-custom-label">行</span>
              <el-input-number v-model="customCols" :min="1" :max="20" size="small" />
              <span class="table-custom-label">列</span>
              <el-button type="primary" size="small" @click="insertTableCustom">插入</el-button>
            </div>
          </el-popover>
          <el-tooltip content="图片" placement="top" :show-after="400">
            <button
              type="button"
              class="tool-btn"
              title="图片"
              @mousedown.prevent
              @click="pickImage"
            >
              <el-icon :size="15"><Picture /></el-icon>
            </button>
          </el-tooltip>
          <el-tooltip content="链接（Ctrl+点击访问）" placement="top" :show-after="400">
            <button
              type="button"
              class="tool-btn"
              title="链接"
              @mousedown.prevent
              @click="openLinkDialog"
            >
              <el-icon :size="15"><Link /></el-icon>
            </button>
          </el-tooltip>
        </div>

        <div class="zone-divider" />

        <!-- 功能区 -->
        <div class="tool-zone">
          <span class="zone-label">功能</span>
          <el-tooltip
            content="导出（HTML 标签 / Word / PDF / TXT）"
            placement="top"
            :show-after="400"
          >
            <button
              type="button"
              class="tool-btn"
              title="导出"
              @mousedown.prevent
              @click="exportDialogVisible = true"
            >
              <el-icon :size="15"><Download /></el-icon>
            </button>
          </el-tooltip>
          <el-tooltip content="AI 编辑选中内容" placement="top" :show-after="400">
            <button
              type="button"
              class="tool-btn tool-btn-ai"
              title="AI 编辑"
              @mousedown.prevent
              @click="openAiDialog"
            >
              <el-icon :size="15"><MagicStick /></el-icon>
            </button>
          </el-tooltip>
          <el-tooltip content="切换 Markdown 视图" placement="top" :show-after="400">
            <button
              type="button"
              class="tool-btn view-toggle-btn"
              @mousedown.prevent
              @click="switchToMarkdown"
            >
              <span class="tool-icon" v-html="ICONS.markdownView"></span>
            </button>
          </el-tooltip>
        </div>
      </div>

      <!-- 文本编辑区 -->
      <div class="editor-content-wrap">
        <EditorContent :editor="editor" class="editor-content" />
      </div>
    </div>

    <!-- ==================== Markdown 视图（左编辑 / 右预览） ==================== -->
    <div v-if="hasFile && viewMode === 'markdown'" class="editor-markdown">
      <div class="markdown-toolbar">
        <el-button type="primary" size="small" plain @click="switchToRichText">
          <el-icon class="markdown-back-icon"><Back /></el-icon>
          切换富文本视图
        </el-button>
      </div>
      <div class="markdown-body-wrap">
        <MdEditor
          v-model="markdownText"
          class="markdown-editor"
          :theme="mdTheme"
          language="zh-CN"
          :preview="true"
          :toolbars="[]"
          :footers="[]"
          placeholder="在此输入 Markdown 内容"
        />
      </div>
    </div>

    <!-- ==================== 空态（未打开文件） ==================== -->
    <div v-if="!hasFile" class="editor-empty">
      <el-icon :size="64" class="empty-icon"><Document /></el-icon>
      <h3 class="empty-title">请先创建或选择一个文件</h3>
      <p class="empty-desc">在左侧选择已有笔记，或新建文件开始编辑</p>
    </div>

    <!-- ==================== 弹窗与隐藏输入框 ==================== -->
    <!-- 链接弹窗 -->
    <el-dialog v-model="linkDialogVisible" title="插入链接" width="480px" append-to-body>
      <el-form label-width="80px">
        <el-form-item label="链接地址">
          <el-input v-model="linkUrl" placeholder="https://example.com" clearable />
        </el-form-item>
        <el-form-item v-if="!linkHasSelection" label="显示文本">
          <el-input v-model="linkText" placeholder="链接显示的文字（留空则显示地址）" clearable />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="linkDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmInsertLink">确定</el-button>
      </template>
    </el-dialog>

    <!-- AI 编辑弹窗 -->
    <el-dialog v-model="aiDialogVisible" title="AI 编辑" width="560px" append-to-body>
      <div class="ai-selection">
        <div class="ai-selection-label">选中内容</div>
        <div class="ai-selection-text">{{ aiSelection }}</div>
      </div>
      <div class="ai-quick-actions">
        <el-tag
          v-for="action in AI_QUICK_ACTIONS"
          :key="action"
          class="ai-quick-tag"
          effect="plain"
          @click="applyAiQuickAction(action)"
        >
          {{ action }}
        </el-tag>
      </div>
      <el-input
        v-model="aiInstruction"
        type="textarea"
        :rows="3"
        placeholder="输入编辑指令，如：润色这段文字，使其更正式"
      />
      <template #footer>
        <el-button :disabled="aiLoading" @click="aiDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="aiLoading" @click="runAiEdit">
          {{ aiLoading ? 'AI 处理中…' : '开始编辑' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 隐藏的文件选择输入框 -->
    <input
      ref="imageInputRef"
      type="file"
      accept="image/*"
      multiple
      class="hidden-input"
      @change="onImageInputChange"
    />
    <!-- 导出格式选择弹窗 -->
    <el-dialog v-model="exportDialogVisible" title="导出文档" width="380px" append-to-body>
      <div class="export-options">
        <div class="export-option" @click="exportAs('html')">
          <el-icon :size="22" class="option-icon"><Document /></el-icon>
          <div class="option-body">
            <div class="option-title">HTML 标签</div>
            <div class="option-desc">内容的完整格式标签（不包含 html、body）</div>
          </div>
        </div>
        <div class="export-option" @click="exportAs('word')">
          <el-icon :size="22" class="option-icon"><Tickets /></el-icon>
          <div class="option-body">
            <div class="option-title">Word 文档</div>
            <div class="option-desc">包含图片、表格、文字段落等格式</div>
          </div>
        </div>
        <div class="export-option" @click="exportAs('pdf')">
          <el-icon :size="22" class="option-icon"><Printer /></el-icon>
          <div class="option-body">
            <div class="option-title">PDF 文档</div>
            <div class="option-desc">A4 分页排版，保留图片、表格与文字样式</div>
          </div>
        </div>
        <div class="export-option" @click="exportAs('txt')">
          <el-icon :size="22" class="option-icon"><Memo /></el-icon>
          <div class="option-body">
            <div class="option-title">TXT 纯文本</div>
            <div class="option-desc">保留换行、加粗、字体大小格式</div>
          </div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
/* ==================== 组件整体：填充父区域 ==================== */
.dot-editor {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--el-bg-color);
}

.hidden-input {
  display: none;
}

/* ==================== 富文本视图布局 ==================== */
.editor-richtext {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* ==================== 工具区 ==================== */
.editor-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px;
  background: var(--el-bg-color);
  border-bottom: 1px solid var(--el-border-color-light);
}

.tool-zone {
  display: flex;
  align-items: center;
  gap: 4px;
}

.zone-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-right: 2px;
  user-select: none;
}

.zone-divider {
  width: 1px;
  height: 22px;
  margin: 0 6px;
  background: var(--el-border-color-lighter);
}

.font-size-select {
  width: 88px;
}

.tool-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--el-text-color-primary);
  cursor: pointer;
  transition:
    background-color 0.15s,
    color 0.15s;
}

.tool-btn:hover {
  background: var(--el-fill-color);
}

.tool-btn.is-active {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.tool-btn-ai:hover {
  color: var(--el-color-primary);
}

.tool-icon {
  display: inline-flex;
  width: 16px;
  height: 16px;
}

.tool-icon :deep(svg) {
  width: 100%;
  height: 100%;
}

.glyph {
  font-size: 14px;
  line-height: 1;
  user-select: none;
}

.glyph-bold {
  font-weight: 700;
  font-family: Georgia, 'Times New Roman', serif;
}

.glyph-italic {
  font-style: italic;
  font-family: Georgia, 'Times New Roman', serif;
}

/* 工具栏图片图标（高亮 / 字体颜色） */
.tool-img {
  display: block;
  width: 16px;
  height: 16px;
}

/* 颜色面板：预设色板 + 自定义颜色 + 清除 */
.color-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.color-grid {
  display: grid;
  grid-template-columns: repeat(5, 24px);
  gap: 6px;
  justify-content: center;
}

.color-swatch {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--el-border-color);
  border-radius: 5px;
  cursor: pointer;
  transition: transform 0.1s;
}

.color-swatch:hover {
  transform: scale(1.12);
}

.color-swatch.is-active {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 1px;
}

.color-panel-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.color-custom {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  user-select: none;
}

.color-custom input[type='color'] {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--el-border-color);
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
}

/* ==================== 文本编辑区 ==================== */
.editor-content-wrap {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.editor-content {
  height: 100%;
}

/* ProseMirror 编辑区排版样式 */
.editor-content :deep(.dot-editor-prose) {
  min-height: 100%;
  padding: 28px 40px 60px;
  outline: none;
  font-size: 15px;
  line-height: 1.8;
  color: var(--el-text-color-primary);
  word-break: break-word;
}

.editor-content :deep(.dot-editor-prose p) {
  margin: 0.4em 0;
}

/* 修复全局样式重置（base.css 的 * { font-weight: normal }）导致加粗与标题字重丢失 */
.editor-content :deep(.dot-editor-prose strong),
.editor-content :deep(.dot-editor-prose b) {
  font-weight: 700;
}

.editor-content :deep(.dot-editor-prose h1),
.editor-content :deep(.dot-editor-prose h2),
.editor-content :deep(.dot-editor-prose h3) {
  margin: 0.9em 0 0.5em;
  line-height: 1.4;
  font-weight: 600;
}

.editor-content :deep(.dot-editor-prose h1) {
  font-size: 26px;
}

.editor-content :deep(.dot-editor-prose h2) {
  font-size: 21px;
}

.editor-content :deep(.dot-editor-prose h3) {
  font-size: 17px;
}

.editor-content :deep(.dot-editor-prose ul),
.editor-content :deep(.dot-editor-prose ol) {
  padding-left: 1.6em;
  margin: 0.4em 0;
}

/* 恢复列表符号：全局样式（base.css 的 ul { list-style: none }）会去掉圆点/序号 */
.editor-content :deep(.dot-editor-prose ul) {
  list-style: disc;
}

.editor-content :deep(.dot-editor-prose ul ul) {
  list-style: circle;
}

.editor-content :deep(.dot-editor-prose ol) {
  list-style: decimal;
}

.editor-content :deep(.dot-editor-prose li) {
  margin: 2px 0;
}

.editor-content :deep(.dot-editor-prose blockquote) {
  border-left: 4px solid var(--el-color-primary);
  padding: 2px 14px;
  margin: 10px 0;
  color: var(--el-text-color-secondary);
}

.editor-content :deep(.dot-editor-prose pre) {
  background: var(--el-fill-color-darker);
  color: var(--el-text-color-primary);
  padding: 12px 14px;
  border-radius: 8px;
  font-family: Consolas, Monaco, monospace;
  overflow-x: auto;
}

.editor-content :deep(.dot-editor-prose code) {
  background: var(--el-fill-color);
  border-radius: 4px;
  padding: 1px 5px;
  font-family: Consolas, Monaco, monospace;
  font-size: 0.9em;
}

.editor-content :deep(.dot-editor-prose img) {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
  margin: 6px 0;
}

.editor-content :deep(.dot-editor-prose mark) {
  background: #ffe58f;
  border-radius: 2px;
  padding: 0 2px;
}

.editor-content :deep(.dot-editor-prose a) {
  color: var(--el-color-primary);
  text-decoration: none;
}

/* Ctrl 按住时悬停链接显示小手光标 */
.editor-content :deep(.dot-editor-prose.ctrl-pressed a:hover) {
  cursor: pointer;
}

.editor-content :deep(.dot-editor-prose a:hover) {
  text-decoration: underline;
}

.editor-content :deep(.dot-editor-prose hr) {
  border: none;
  border-top: 1px solid var(--el-border-color);
  margin: 18px 0;
}

/* 首行缩进 / 垂直居中（自定义段落属性） */
.editor-content :deep(.dot-editor-prose p[data-indent='true']) {
  text-indent: 2em;
}

.editor-content :deep(.dot-editor-prose p[data-v-center='true']) {
  line-height: 2.8;
  vertical-align: middle;
}

/* 表格样式（含列宽拖拽与单元格选中） */
.editor-content :deep(.dot-editor-prose table) {
  border-collapse: collapse;
  table-layout: fixed;
  width: 100%;
  margin: 10px 0;
  overflow: hidden;
}

.editor-content :deep(.dot-editor-prose td),
.editor-content :deep(.dot-editor-prose th) {
  border: 1px solid var(--el-border-color);
  padding: 6px 10px;
  vertical-align: top;
  position: relative;
  min-width: 1em;
}

.editor-content :deep(.dot-editor-prose th) {
  background: var(--el-fill-color-light);
  font-weight: 600;
  text-align: left;
}

.editor-content :deep(.dot-editor-prose .selectedCell)::after {
  content: '';
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  pointer-events: none;
}

.editor-content :deep(.dot-editor-prose .column-resize-handle) {
  position: absolute;
  right: -2px;
  top: 0;
  bottom: 0;
  width: 4px;
  background: var(--el-color-primary);
  pointer-events: none;
}

.editor-content :deep(.dot-editor-prose.resize-cursor) {
  cursor: col-resize;
}

.editor-content :deep(.dot-editor-prose .tableWrapper) {
  overflow-x: auto;
  margin: 10px 0;
}

/* ==================== 表格悬浮选择框 ==================== */
.table-grid {
  display: grid;
  grid-template-columns: repeat(5, 22px);
  gap: 3px;
  justify-content: center;
}

.table-grid-cell {
  width: 22px;
  height: 22px;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  cursor: pointer;
  transition:
    background-color 0.1s,
    border-color 0.1s;
}

.table-grid-cell:hover,
.table-grid-cell.is-active {
  background: var(--el-color-primary-light-8);
  border-color: var(--el-color-primary);
}

.table-grid-tip {
  margin-top: 8px;
  text-align: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.table-divider {
  margin: 10px 0;
}

.table-custom {
  display: flex;
  align-items: center;
  gap: 8px;
}

.table-custom-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.table-custom .el-button {
  margin-left: auto;
}

/* ==================== Markdown 视图 ==================== */
.editor-markdown {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.markdown-toolbar {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  background: var(--el-bg-color);
  border-bottom: 1px solid var(--el-border-color-light);
}

.markdown-back-icon {
  margin-right: 4px;
}

.markdown-body-wrap {
  flex: 1;
  min-height: 0;
}

.markdown-editor {
  height: 100%;
}

/* 隐藏 md-editor-v3 自带工具栏与页脚，仅保留编辑与预览 */
.markdown-body-wrap :deep(.md-editor-toolbar-wrapper) {
  display: none;
}

.markdown-body-wrap :deep(.md-editor-footer) {
  display: none;
}

/* 恢复 Markdown 预览区的列表符号（同样受全局样式重置影响） */
.markdown-body-wrap :deep(.md-editor-preview ul) {
  list-style: disc;
}

.markdown-body-wrap :deep(.md-editor-preview ul ul) {
  list-style: circle;
}

.markdown-body-wrap :deep(.md-editor-preview ol) {
  list-style: decimal;
}

/* ==================== 空态 ==================== */
.editor-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.empty-icon {
  color: var(--el-text-color-placeholder);
  margin-bottom: 12px;
}

.empty-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}

.empty-desc {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

/* ==================== 导出格式弹窗 ==================== */
.export-options {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.export-option {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background-color 0.15s;
}

.export-option:hover {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

.option-icon {
  color: var(--el-color-primary);
  flex-shrink: 0;
}

.option-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.option-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.option-desc {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* ==================== AI 弹窗 ==================== */
.ai-selection {
  margin-bottom: 12px;
}

.ai-selection-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin-bottom: 4px;
}

.ai-selection-text {
  max-height: 110px;
  overflow-y: auto;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
  white-space: pre-wrap;
  word-break: break-word;
}

.ai-quick-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.ai-quick-tag {
  cursor: pointer;
}

.ai-quick-tag:hover {
  color: var(--el-color-primary);
  border-color: var(--el-color-primary);
}
</style>
