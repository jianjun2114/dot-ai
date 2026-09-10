import './assets/main.css'

import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'

import App from './App.vue'
import router from './router'
import { useTheme } from './composables/useTheme'
import { loadSettings } from './composables/useSettings'

const app = createApp(App)

// 注册所有图标
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

// 初始化主题
const { initTheme } = useTheme()
initTheme()

app.use(router)
app.use(ElementPlus)

// 启动时先加载持久化配置，再挂载应用，避免初始页面读到空配置
loadSettings().finally(() => {
  app.mount('#app')
})
