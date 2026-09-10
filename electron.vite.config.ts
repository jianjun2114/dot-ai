import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [
      vue({
        template: {
          compilerOptions: {
            // Electron <webview> 标签是原生元素，告知 Vue 编译器不要按组件处理
            isCustomElement: (tag) => tag === 'webview'
          }
        }
      })
    ]
  }
})
