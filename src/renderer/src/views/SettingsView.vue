<script setup lang="ts">
/**
 * 设置中心
 *
 * 四大模块：通用设置 / 智能配置 / 智能对话 / 关于
 * - 左侧模块导航 + 右侧内容面板布局
 * - 所有颜色均取自 base.css 主题变量，随 data-theme 自动切换
 * - 挂载时通过 useSettings 加载配置，配置变化自动持久化
 */
import { ref, onMounted } from 'vue'
import { Setting, Cpu, ChatDotRound, InfoFilled } from '@element-plus/icons-vue'
import BackHome from '../components/BackHome.vue'
import GeneralSettings from '../components/settings/GeneralSettings.vue'
import SmartConfig from '../components/settings/SmartConfig.vue'
import ChatEndpoints from '../components/settings/ChatEndpoints.vue'
import { loadSettings } from '../composables/useSettings'

/** 设置模块标识 */
type SettingsTab = 'general' | 'smart' | 'chat' | 'about'

/** 左侧导航元信息 */
const NAV_ITEMS: { key: SettingsTab; label: string; icon: typeof Setting }[] = [
  { key: 'general', label: '通用设置', icon: Setting },
  { key: 'smart', label: '智能配置', icon: Cpu },
  { key: 'chat', label: '智能对话', icon: ChatDotRound },
  { key: 'about', label: '关于', icon: InfoFilled }
]

/** 当前激活模块 */
const activeTab = ref<SettingsTab>('general')

onMounted(() => {
  loadSettings()
})
</script>

<template>
  <div class="settings-page">
    <!-- 顶部标题栏 -->
    <header class="settings-header">
      <BackHome />
      <h1 class="page-title">设置中心</h1>
      <span class="header-spacer" />
    </header>

    <!-- 主体：左侧导航 + 右侧内容 -->
    <div class="settings-body">
      <aside class="settings-sidebar">
        <button
          v-for="item in NAV_ITEMS"
          :key="item.key"
          type="button"
          class="sidebar-item"
          :class="{ active: activeTab === item.key }"
          @click="activeTab = item.key"
        >
          <el-icon class="item-icon"><component :is="item.icon" /></el-icon>
          <span class="item-label">{{ item.label }}</span>
        </button>
      </aside>

      <main class="settings-content">
        <GeneralSettings v-show="activeTab === 'general'" />
        <SmartConfig v-show="activeTab === 'smart'" />
        <ChatEndpoints v-show="activeTab === 'chat'" />

        <!-- 关于 -->
        <div v-show="activeTab === 'about'" class="panel-section">
          <h2 class="section-title">关于</h2>
          <div class="about-card">
            <img src="../../../../resources/icon.png" alt="应用图标" class="about-logo" />
            <h3 class="about-name">圆点AI</h3>
            <p class="about-version">版本 1.0.0</p>
            <p class="about-slogan">让 AI 触手可及</p>
            <div class="about-divider" />
            <p class="about-desc">简洁高效的 AI 助手</p>
            <p class="about-copyright">© 2026 圆点AI</p>
          </div>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
/* ============ 页面骨架 ============ */
.settings-page {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: var(--color-bg);
  color: var(--color-text);
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  border-bottom: 1px solid var(--color-border);
}

.page-title {
  font-size: 18px;
  font-weight: 600;
  margin: 0;
}

/* 与左侧返回按钮对称的占位，保证标题居中 */
.header-spacer {
  width: 40px;
}

.settings-body {
  display: flex;
  flex: 1;
}

/* ============ 左侧导航 ============ */
.settings-sidebar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 200px;
  padding: 20px 12px;
  border-right: 1px solid var(--color-border);
}

.sidebar-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 16px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition:
    background-color 0.2s ease,
    color 0.2s ease;
}

.sidebar-item:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

.sidebar-item.active {
  background: var(--color-primary);
  color: #ffffff;
  font-weight: 500;
}

.item-icon {
  font-size: 17px;
}

.item-label {
  font-weight: inherit;
}

/* ============ 右侧内容区 ============ */
.settings-content {
  flex: 1;
  padding: 28px 32px;
  overflow-y: auto;
}

.panel-section {
  max-width: 860px;
}

.section-title {
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 20px;
  color: var(--color-text);
}

/* ============ 关于卡片 ============ */
.about-card {
  background: var(--color-card);
  border: 1px solid var(--color-border);
  border-radius: 14px;
  padding: 44px 40px;
  text-align: center;
  box-shadow: var(--shadow-card);
}

.about-logo {
  width: 80px;
  height: 80px;
  border-radius: 18px;
  margin-bottom: 16px;
}

.about-name {
  font-size: 24px;
  font-weight: 600;
  margin: 0 0 8px;
  color: var(--color-text);
}

.about-version {
  font-size: 13px;
  color: var(--color-text-secondary);
  margin: 0 0 8px;
}

.about-slogan {
  font-size: 15px;
  color: var(--color-text);
  margin: 0 0 20px;
}

.about-divider {
  width: 64px;
  height: 2px;
  background: var(--color-border);
  margin: 0 auto 20px;
  border-radius: 1px;
}

.about-desc {
  font-size: 13px;
  color: var(--color-text-secondary);
  margin: 0 0 8px;
}

.about-copyright {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin: 0;
  opacity: 0.7;
}

/* ============ 移动端适配 ============ */
@media (max-width: 768px) {
  .settings-body {
    flex-direction: column;
  }

  .settings-sidebar {
    flex-direction: row;
    width: 100%;
    padding: 10px 12px;
    overflow-x: auto;
    border-right: none;
    border-bottom: 1px solid var(--color-border);
  }

  .sidebar-item {
    flex: 1;
    flex-direction: column;
    gap: 4px;
    padding: 10px 8px;
    text-align: center;
  }

  .item-label {
    font-size: 12px;
  }

  .settings-content {
    padding: 20px 16px;
  }
}
</style>
