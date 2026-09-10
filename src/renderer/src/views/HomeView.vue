<script setup lang="ts">
import { useRouter } from 'vue-router'
import { ArrowRight, CircleCheck } from '@element-plus/icons-vue'

import aiChatSvg from '../assets/ai_chat.svg'
import calenNoteSvg from '../assets/calen_note.svg'
import baibaoxiangSvg from '../assets/baibaoxiang.svg'
import settingSvg from '../assets/setting.svg'
import iconPng from '../assets/icon.png'

const router = useRouter()

const navItems = [
  { label: '智能对话', icon: aiChatSvg, route: 'Chat' },
  { label: '日历记事本', icon: calenNoteSvg, route: 'CalenNote' },
  { label: '百宝箱', icon: baibaoxiangSvg, route: 'Toolbox' }
]

const handleNavClick = (route: string): void => {
  router.push({ name: route })
}
import { ref } from 'vue'
const input = ref('')
</script>

<template>
  <el-container class="home-container">
    <!-- 顶部导航 -->
    <el-header class="header">
      <el-row>
        <el-col :span="6">
          <div class="logo">
            <div class="logo-icon">
              <img :src="iconPng" alt="logo" class="logo-img" />
            </div>
            <span class="logo-text">圆点AI</span>
          </div>
        </el-col>
        <el-col :span="15">
          <nav class="nav">
            <div
              v-for="item in navItems"
              :key="item.label"
              class="nav-item"
              @click="handleNavClick(item.route)"
            >
              <img :src="item.icon" :alt="item.label" class="nav-icon" />
              <span class="nav-label">{{ item.label }}</span>
            </div>
          </nav>
        </el-col>
        <el-col :span="3">
          <nav class="nav" style="justify-content: center">
            <div class="nav-item" @click="handleNavClick('Settings')">
              <img :src="settingSvg" alt="设置" class="nav-icon" />
              <span class="nav-label">设置</span>
            </div>
          </nav>
        </el-col>
      </el-row>
    </el-header>

    <!-- 主内容区 -->
    <el-main class="main-content">
      <!-- Hero 区域 -->
      <section class="hero">
        <div class="hero-badge">
          <el-icon><CircleCheck /></el-icon>
          <span>全新 AI 助手</span>
        </div>
        <h1 class="hero-title">探索智能<br />无限可能</h1>
        <p class="hero-desc">与圆点AI对话，获得即时答案、创意灵感和专业帮助</p>
        <div class="hero-actions">
          <el-button type="primary" size="large" @click="router.push({ name: 'Chat' })">
            开始对话
            <el-icon class="el-icon--right"><ArrowRight /></el-icon>
          </el-button>
          <el-button size="large" @click="router.push({ name: 'Settings' })"> 了解更多 </el-button>
        </div>
        <el-input v-model="input" style="width: 240px" placeholder="Please input" />
      </section>
    </el-main>

    <!-- 底部 -->
    <el-footer class="footer">
      <p>&copy; 2026 圆点AI - 让AI触手可及</p>
    </el-footer>
  </el-container>
</template>

<style scoped>
.home-container {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background-image: url('../assets/background.jpeg');
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  background-color: var(--color-bg);
  transition: background-color 0.3s;
}

.el-header {
  position: sticky;
  top: 0;
  z-index: 100;
  border-bottom: 1px solid var(--glass-border);
  transition: all 0.3s ease;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur) saturate(180%);
  -webkit-backdrop-filter: var(--glass-blur) saturate(180%);
  border: 1px solid var(--glass-border);
  border-radius: 16px;
  box-shadow: var(--glass-shadow);
  padding: 12px 24px;
}

.header-content {
  max-width: 1200px;
  margin: 0 auto;
  padding: 16px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.logo {
  display: flex;
  align-items: center;
  gap: 12px;
}

.logo-icon {
  width: 38px;
  height: 38px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.logo-img {
  width: 36px;
  height: 36px;
}

.logo-text {
  font-size: 20px;
  font-weight: 600;
  color: white;
}

.nav {
  display: flex;
  gap: 24px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.3s ease;
  color: white;
}

.nav-item:hover {
  background: var(--glass-bg);
}

.nav-icon {
  width: 20px;
  height: 20px;
}

.nav-label {
  font-size: 14px;
  font-weight: 500;
}

.el-main {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.hero {
  text-align: center;
  padding: 60px;
  border-radius: 24px;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-border);
  box-shadow: var(--glass-shadow);
  transition: all 0.3s ease;
}

.hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 20px;
  font-size: 13px;
  color: white;
  margin-bottom: 24px;
}

.hero-title {
  font-size: 56px;
  font-weight: 700;
  line-height: 1.15;
  color: white;
  margin: 0 0 20px;
  letter-spacing: -1px;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
}

[data-theme='dark'] .hero-title {
  text-shadow: 0 2px 20px var(--color-primary);
}

.hero-desc {
  font-size: 18px;
  color: rgba(255, 255, 255, 0.85);
  margin: 0 0 36px;
  max-width: 480px;
  margin-left: auto;
  margin-right: auto;
}

.hero-actions {
  display: flex;
  justify-content: center;
  gap: 16px;
}

.hero-actions .el-button--primary {
  background: var(--color-primary);
  border: none;
  padding: 20px 32px;
  font-size: 16px;
}

.hero-actions .el-button--primary:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}

.el-footer {
  text-align: center;
  padding: 24px;
  color: rgba(255, 255, 255, 0.6);
  font-size: 13px;
  background: var(--glass-bg);
}

@media (max-width: 768px) {
  .hero-title {
    font-size: 36px;
  }

  .hero-desc {
    font-size: 16px;
  }

  .hero-actions {
    flex-direction: column;
    align-items: center;
  }

  .nav {
    gap: 8px;
  }

  .nav-label {
    display: none;
  }

  .nav-item {
    padding: 8px;
  }
}
</style>
