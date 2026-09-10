// 应用路径缓存（应用生命周期内不变）
let appPathCache = ''

/**
 * 获取应用数据目录（带缓存）
 * @returns 应用数据目录路径
 */
export const getAppPath = async (): Promise<string> => {
  if (!appPathCache) {
    appPathCache = await window.dot.getAppPath()
  }
  return appPathCache
}

// 配置缓存
const configCache: Record<string, unknown> = {}

/**
 * 获取配置项
 * @param key 配置键名
 * @returns 配置值
 */
export const getConfig = async (key: string): Promise<string | undefined> => {
  // 优先从缓存获取
  if (configCache[key] !== undefined) {
    return configCache[key] as string
  }

  // 从 dot.json 获取
  if (window.dot) {
    try {
      const appPath = await getAppPath()
      const filePath = `${appPath}/dot.json`
      const exists = await window.dot.localFiles('exists', filePath)
      if (exists) {
        const content = (await window.dot.localFiles('read', filePath)) as string
        const settings = JSON.parse(content)
        const value = settings[key]
        if (value !== undefined) {
          configCache[key] = value
        }
        return value
      }
    } catch (error) {
      console.error(`获取配置 ${key} 失败:`, error)
    }
  }

  return undefined
}

/**
 * 获取配置项（带默认值）
 * @param key 配置键名
 * @param defaultValue 默认值
 * @returns 配置值
 */
export const getConfigWithDefault = async <T>(key: string, defaultValue: T): Promise<T> => {
  const value = await getConfig(key)
  return (value as T) ?? defaultValue
}

/**
 * 清除配置缓存
 */
export const clearConfigCache = (): void => {
  Object.keys(configCache).forEach((key: string) => {
    delete configCache[key]
  })
}
