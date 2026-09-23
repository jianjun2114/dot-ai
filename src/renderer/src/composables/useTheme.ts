import { ref, watch } from 'vue'
import { getAppPath } from '../utils/config'

/** 应用支持的主题：亮色 / 暗色 / 六款新主题 */
export type Theme =
  | 'light'
  | 'dark'
  | 'ink-blue'
  | 'charcoal'
  | 'ink-green'
  | 'mist-blue'
  | 'earth-brown'
  | 'gray-purple'

/** 暗色系主题集合（需挂载 Element Plus 的 html.dark 类） */
const DARK_THEMES: Theme[] = ['dark', 'ink-blue', 'charcoal', 'ink-green']

/** 判断主题是否为暗色系 */
export function isDarkTheme(t: Theme): boolean {
  return DARK_THEMES.includes(t)
}

const theme = ref<Theme>('light')

export function useTheme(): {
  theme: typeof theme
  setTheme: (newTheme: Theme) => void
  initTheme: () => void
} {
  const setTheme = (newTheme: Theme): void => {
    theme.value = newTheme
    applyTheme(newTheme)
    localStorage.setItem('theme', newTheme)
    // 保存到 dot.json
    saveThemeToFile(newTheme)
  }

  const applyTheme = (t: Theme): void => {
    const html = document.documentElement
    html.setAttribute('data-theme', t)
    // Element Plus 的暗色变量表依赖 html.dark 类，暗色系主题需同步挂载
    html.classList.toggle('dark', isDarkTheme(t))
  }

  const saveThemeToFile = async (t: Theme): Promise<void> => {
    try {
      if (window.dot) {
        const appPath = await getAppPath()
        const filePath = `${appPath}/dot.json`
        const exists = await window.dot.localFiles('exists', filePath)
        let settings = {}
        if (exists) {
          const content = (await window.dot.localFiles('read', filePath)) as string
          settings = JSON.parse(content)
        }
        settings = { ...settings, theme: t }
        await window.dot.localFiles('write', filePath, JSON.stringify(settings, null, 2))
      }
    } catch (error) {
      console.error('保存主题失败:', error)
    }
  }

  const initTheme = (): void => {
    const saved = localStorage.getItem('theme') as Theme | null
    const systemPrefers = window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
    const DARK_THEMES: Theme[] = ['dark', 'ink-blue', 'charcoal', 'ink-green']
    // 兼容旧版主题值（retro / deep-blue 已移除），无效值按系统偏好回退
    const initialTheme: Theme = saved
      ? DARK_THEMES.includes(saved as Theme) || saved === 'light'
        ? (saved as Theme)
        : 'light'
      : systemPrefers
    setTheme(initialTheme)
  }

  watch(theme, (newTheme) => {
    applyTheme(newTheme)
  })

  return {
    theme,
    setTheme,
    initTheme
  }
}
