<script setup lang="ts">
import { computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ArrowLeft } from '@element-plus/icons-vue'
import shellSvg from '../assets/shell.svg'
import liulanqiSvg from '../assets/liulanqi.svg'
import apiTestSvg from '../assets/api_test.svg'
import docConvSvg from '../assets/doc_conv.svg'

const router = useRouter()
const route = useRoute()

/** 是否为百宝箱入口页（无子路由激活时展示功能卡片） */
const isEntry = computed(() => route.path === '/toolbox')

/** 返回首页 */
const goHome = (): void => {
  router.push({ name: 'Home' })
}

/**
 * 功能入口配置：
 * - shell 为独立窗口，通过 IPC 由主进程创建
 * - 其余功能在当前窗口内以子路由切换
 */
const features = [
  {
    key: 'shell',
    title: 'Shell 终端',
    desc: '远程 SSH / 本地 PowerShell 连接管理，多标签终端，SFTP 双栏传输，AI 智能辅助',
    icon: shellSvg,
    accent: 'var(--color-primary)',
    handler: (): void => {
      window.dot.toolbox.openShellWindow()
    }
  },
  {
    key: 'browser',
    title: '浏览器',
    desc: '多标签网页浏览，支持在本地浏览器打开，AI 仿人工自动化操作网页',
    icon: liulanqiSvg,
    accent: 'var(--color-success)',
    handler: (): void => {
      window.dot.toolbox.openBrowserWindow()
    }
  },
  {
    key: 'api',
    title: '接口测试',
    desc: 'HTTP / WebSocket / TCP 请求测试，支持 JSON、表单与 SSE 流式响应',
    icon: apiTestSvg,
    accent: 'var(--color-warning)',
    handler: (): void => {
      router.push({ name: 'ToolboxApi' })
    }
  },
  {
    key: 'doc',
    title: '文档转换',
    desc: 'Word、图片、TXT、HTML 转 PDF，PDF 转 Word、图片，Base64 转文档',
    icon: docConvSvg,
    accent: 'var(--color-danger)',
    handler: (): void => {
      router.push({ name: 'ToolboxDoc' })
    }
  }
]
</script>

<template>
  <div class="toolbox-page">
    <!-- 顶栏：返回首页 + 标题 -->
    <header class="toolbox-header">
      <div class="toolbox-header-left">
        <button class="back-btn" @click="goHome">
          <el-icon :size="16"><ArrowLeft /></el-icon>
          <span>返回首页</span>
        </button>
        <h1 class="toolbox-title">百宝箱</h1>
      </div>
      <span class="toolbox-subtitle">常用开发工具集合</span>
    </header>

    <!-- 子功能页面（浏览器 / 接口测试 / 文档转换） -->
    <main v-if="!isEntry" class="toolbox-child">
      <router-view />
    </main>

    <!-- 功能入口卡片 -->
    <main v-else class="toolbox-main">
      <div
        v-for="feature in features"
        :key="feature.key"
        class="feature-card"
        @click="feature.handler()"
      >
        <div class="feature-glow" :style="{ background: feature.accent }"></div>
        <div class="feature-icon">
          <img :src="feature.icon" :alt="feature.title" class="feature-icon-img" />
        </div>
        <div class="feature-text">
          <h2 class="feature-title">{{ feature.title }}</h2>
          <p class="feature-desc">{{ feature.desc }}</p>
        </div>
        <div class="feature-arrow">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M5 12h14M12 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.toolbox-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  /* 主题化背景：基础底色 + 品牌色极淡氛围光斑，随 data-theme 联动 */
  background:
    radial-gradient(
      1000px 520px at 85% -10%,
      color-mix(in srgb, var(--color-primary) 6%, var(--color-bg)),
      transparent 60%
    ),
    radial-gradient(
      800px 460px at -8% 108%,
      color-mix(in srgb, var(--color-primary) 4%, var(--color-bg)),
      transparent 60%
    ),
    var(--color-bg);
}

/* ===== 顶栏 ===== */
.toolbox-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 40px 12px;
}

.toolbox-header-left {
  display: flex;
  align-items: center;
  gap: 20px;
}

/* 返回首页按钮：主题化胶囊按钮 */
.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-card);
  color: var(--color-text);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.25s ease;
}

.back-btn:hover {
  background: var(--color-hover);
  transform: translateX(-2px);
}

.toolbox-title {
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 2px;
  color: var(--color-text);
}

.toolbox-subtitle {
  font-size: 13px;
  color: var(--color-text-secondary);
  letter-spacing: 1px;
}

/* ===== 子页面占满剩余空间 ===== */
.toolbox-child {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.toolbox-child > :deep(*) {
  flex: 1;
}

/* ===== 功能入口卡片 ===== */
.toolbox-main {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  padding: 12px 40px 48px;
  align-content: flex-start;
  overflow-y: auto;
}

.feature-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 20px;
  width: calc(50% - 12px);
  min-width: 400px;
  min-height: 150px;
  padding: 28px 32px;
  border: 1px solid var(--color-border);
  border-radius: 20px;
  background: var(--color-card);
  box-shadow: var(--shadow-card);
  cursor: pointer;
  overflow: hidden;
  transition: all 0.3s ease;
}

.feature-card:hover {
  transform: translateY(-6px);
  border-color: var(--color-primary-light);
  box-shadow: var(--shadow-card-hover);
}

/* hover 时的彩色光晕（跟随各功能语义色） */
.feature-glow {
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity 0.3s ease;
  -webkit-mask-image: linear-gradient(120deg, transparent 55%, #000 100%);
  mask-image: linear-gradient(120deg, transparent 55%, #000 100%);
}

.feature-card:hover .feature-glow {
  opacity: 0.1;
}

.feature-icon {
  flex-shrink: 0;
  width: 72px;
  height: 72px;
  border-radius: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.3s ease;
}

.feature-card:hover .feature-icon {
  transform: scale(1.08) rotate(-3deg);
}

/* 彩色 svg 图标放大显示，无背景 */
.feature-icon-img {
  width: 56px;
  height: 56px;
  border-radius: 12px;
}

.feature-text {
  flex: 1;
  min-width: 0;
}

.feature-title {
  margin: 0 0 8px;
  font-size: 20px;
  font-weight: 700;
  color: var(--color-text);
}

.feature-desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--color-text-secondary);
}

/* 右侧箭头 */
.feature-arrow {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-hover);
  color: var(--color-text-secondary);
  transition: all 0.3s ease;
}

.feature-arrow svg {
  width: 18px;
  height: 18px;
}

.feature-card:hover .feature-arrow {
  background: var(--color-primary);
  color: #fff;
  transform: translateX(4px);
}

@media (max-width: 1000px) {
  .feature-card {
    width: 100%;
  }
}
</style>
