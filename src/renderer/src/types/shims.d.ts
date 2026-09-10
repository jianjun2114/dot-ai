/**
 * 第三方库类型声明补充
 * mammoth：docx 转 HTML（浏览器环境，通过 browser 字段解析）
 * turndown-plugin-gfm：turndown 的 GFM 插件（表格/删除线/任务列表）
 */
declare module 'mammoth' {
  /**
   * 将 docx 文件转换为 HTML
   * @param input 包含 arrayBuffer 的输入对象
   * @returns 转换结果，value 为 HTML 字符串
   */
  export function convertToHtml(input: {
    arrayBuffer: ArrayBuffer
  }): Promise<{ value: string; messages: unknown[] }>
}

declare module 'turndown-plugin-gfm' {
  /**
   * 为 turndown 实例启用 GFM 支持
   * @param turndownService turndown 实例
   */
  export function gfm(turndownService: unknown): void
}
