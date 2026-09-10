import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'Home',
    component: () => import('../views/HomeView.vue')
  },
  {
    path: '/chat',
    name: 'Chat',
    component: () => import('../views/ChatView.vue')
  },
  {
    path: '/calen-note',
    name: 'CalenNote',
    component: () => import('../views/CalenNoteView.vue')
  },
  {
    // 百宝箱主页（功能入口，子页面通过 router-view 渲染）
    path: '/toolbox',
    name: 'Toolbox',
    component: () => import('../views/ToolboxView.vue'),
    children: [
      {
        // 接口测试
        path: 'api',
        name: 'ToolboxApi',
        component: () => import('../views/toolbox/ApiTestView.vue')
      },
      {
        // 文档转换
        path: 'doc',
        name: 'ToolboxDoc',
        component: () => import('../views/toolbox/DocConvertView.vue')
      }
    ]
  },
  {
    // Shell 独立窗口页面（由主进程新窗口加载）
    path: '/toolbox/shell',
    name: 'ToolboxShell',
    component: () => import('../views/toolbox/ShellView.vue')
  },
  {
    // 浏览器独立窗口页面（由主进程新窗口加载）
    path: '/toolbox/browser',
    name: 'ToolboxBrowser',
    component: () => import('../views/toolbox/BrowserView.vue')
  },
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('../views/SettingsView.vue')
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

export default router
