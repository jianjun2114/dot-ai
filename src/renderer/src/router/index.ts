import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

// 页面显示名称（路由 name → 窗口标题片段）
// 带 " - " 的值视为完整标题（独立窗口用，不再追加后缀），否则自动追加 " - dot-ai"
const PAGE_TITLES: Record<string, string> = {
  Home: '首页',
  Chat: '智能对话',
  CalenNote: '日历记事本',
  Toolbox: '百宝箱',
  ToolboxApi: '接口测试',
  ToolboxDoc: '文档转换',
  ToolboxShell: '终端 - 百宝箱',
  ToolboxBrowser: '浏览器 - 百宝箱',
  Settings: '设置'
}

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

// 路由切换时更新窗口标题，Electron BrowserWindow 会自动跟随 document.title
router.afterEach((to) => {
  const name = to.name as string | undefined
  const title = (name && PAGE_TITLES[name]) || name || 'dot-ai'
  // 已含 " - " 视为完整标题（独立窗口），否则统一追加 " - dot-ai"
  document.title = title.includes(' - ') ? title : `${title}`
})

export default router
