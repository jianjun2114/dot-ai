<script setup lang="ts">
/**
 * 通用设置模块
 *
 * - 主题：亮色 / 暗色 / 复古黄 / 深蓝，四选一卡片（带色板预览）
 * - 记事本目录：通过系统目录选择器选取记事本根目录
 */
import { ref } from 'vue'
import { FolderOpened } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useTheme, type Theme } from '../../composables/useTheme'
import { useSettings } from '../../composables/useSettings'

const { theme, setTheme } = useTheme()
const { settings } = useSettings()

/** 主题选项元信息（swatch 为主题预览色板，与 base.css 中定义保持一致） */
interface ThemeOption {
  value: Theme
  label: string
  desc: string
  /** 预览色板：背景 / 卡片 / 主色 / 文字 */
  swatch: { bg: string; card: string; accent: string; text: string }
}

const themeOptions: ThemeOption[] = [
  {
    value: 'light',
    label: '亮色',
    desc: '清爽明快',
    swatch: { bg: '#f5f7fa', card: '#ffffff', accent: '#0077DB', text: '#1a1a2e' }
  },
  {
    value: 'dark',
    label: '暗色',
    desc: '沉浸专注',
    swatch: { bg: '#0f172a', card: '#252540', accent: '#0077DB', text: '#f0f0f5' }
  },
  {
    value: 'retro',
    label: '复古黄',
    desc: '温暖怀旧',
    swatch: { bg: '#fdf6e3', card: '#fef9e7', accent: '#d4a017', text: '#5c4b37' }
  },
  {
    value: 'deep-blue',
    label: '深蓝',
    desc: '深邃沉稳',
    swatch: { bg: '#0f172a', card: '#1e293b', accent: '#1e40af', text: '#e2e8f0' }
  }
]

/** 是否正在选择目录 */
const picking = ref(false)

/** 打开系统目录选择器，选取记事本根目录 */
const chooseNotesDir = async (): Promise<void> => {
  picking.value = true
  try {
    if (window.dot) {
      const dir = await window.dot.selectDirectory()
      if (dir) {
        settings.value.calendarNotesPath = dir
        ElMessage.success('记事本目录已更新')
      }
    } else {
      // 浏览器环境降级：手动输入
      const dir = window.prompt('请输入记事本根目录路径')
      if (dir) settings.value.calendarNotesPath = dir
    }
  } finally {
    picking.value = false
  }
}
</script>

<template>
  <section class="panel-section">
    <h2 class="section-title">通用设置</h2>

    <!-- 主题选择 -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">主题外观</span>
        <span class="card-desc">选择应用的显示风格</span>
      </div>
      <div class="theme-grid">
        <button
          v-for="option in themeOptions"
          :key="option.value"
          type="button"
          class="theme-card"
          :class="{ active: theme === option.value }"
          @click="setTheme(option.value)"
        >
          <!-- 主题预览缩略图 -->
          <span class="theme-preview" :style="{ background: option.swatch.bg }">
            <span class="preview-bar" :style="{ background: option.swatch.card }">
              <i class="preview-dot" :style="{ background: option.swatch.accent }" />
              <i class="preview-line" :style="{ background: option.swatch.text }" />
            </span>
            <span
              class="preview-block"
              :style="{ background: option.swatch.card, borderColor: option.swatch.accent }"
            />
          </span>
          <span class="theme-meta">
            <span class="theme-label">{{ option.label }}</span>
            <span class="theme-desc">{{ option.desc }}</span>
          </span>
          <span v-if="theme === option.value" class="theme-check">✓</span>
        </button>
      </div>
    </div>

    <!-- 记事本目录 -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">记事本目录</span>
        <span class="card-desc">日历记事本的数据存储根目录</span>
      </div>
      <div class="dir-row">
        <el-input
          :model-value="settings.calendarNotesPath"
          placeholder="未设置时使用默认目录"
          readonly
          class="dir-input"
        >
          <template #prefix>
            <el-icon><FolderOpened /></el-icon>
          </template>
        </el-input>
        <el-button type="primary" :icon="FolderOpened" :loading="picking" @click="chooseNotesDir">
          选择目录
        </el-button>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* ============ 卡片容器 ============ */
.card {
  background: var(--color-card);
  border: 1px solid var(--color-border);
  border-radius: 14px;
  padding: 20px 24px;
  box-shadow: var(--shadow-card);
}

.card + .card {
  margin-top: 16px;
}

.card-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 16px;
}

.card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
}

.card-desc {
  font-size: 13px;
  color: var(--color-text-secondary);
}

/* ============ 主题卡片网格 ============ */
.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 14px;
}

.theme-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: var(--color-bg);
  border: 2px solid var(--color-border);
  border-radius: 12px;
  cursor: pointer;
  text-align: left;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    transform 0.2s ease;
}

.theme-card:hover {
  border-color: var(--color-primary-light);
  transform: translateY(-2px);
}

.theme-card.active {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-card-hover);
}

/* 主题预览缩略图 */
.theme-preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 76px;
  padding: 10px;
  border-radius: 8px;
  overflow: hidden;
}

.preview-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 16px;
  padding: 0 6px;
  border-radius: 4px;
}

.preview-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.preview-line {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  opacity: 0.35;
}

.preview-block {
  flex: 1;
  border: 1px dashed;
  border-radius: 6px;
  opacity: 0.75;
}

/* 主题信息 */
.theme-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.theme-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}

.theme-desc {
  font-size: 12px;
  color: var(--color-text-secondary);
}

/* 选中角标 */
.theme-check {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--color-primary);
  color: #ffffff;
  font-size: 12px;
  font-weight: 700;
}

/* ============ 目录选择行 ============ */
.dir-row {
  display: flex;
  gap: 12px;
}

.dir-input {
  flex: 1;
}

/* ============ 移动端适配 ============ */
@media (max-width: 768px) {
  .dir-row {
    flex-direction: column;
  }
}
</style>
