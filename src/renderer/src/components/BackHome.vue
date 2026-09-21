<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useTheme } from '../composables/useTheme'

/** 返回目标路由名称，默认首页；百宝箱子页面传 'Toolbox' 返回百宝箱 */
const props = withDefaults(defineProps<{ to?: string }>(), { to: 'Home' })

const router = useRouter()
const { theme } = useTheme()

const goHome = (): void => {
  router.push({ name: props.to })
}
</script>

<template>
  <div class="back-home" @click="goHome">
    <svg
      class="back-icon"
      :class="{ light: theme === 'dark' }"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polyline points="15 18 9 12 15 6"></polyline>
    </svg>
  </div>
</template>

<style scoped>
.back-home {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  cursor: pointer;
  transition: all 0.3s ease;
}

.back-home:hover {
  background: color-mix(in srgb, var(--color-primary) 20%, transparent);
  transform: scale(1.05);
}

.back-home:active {
  transform: scale(0.95);
}

.back-icon {
  width: 20px;
  height: 20px;
  color: var(--color-primary);
  transition: color 0.3s ease;
}

.back-icon.light {
  color: var(--color-primary-light);
}

.back-home:hover .back-icon {
  transform: translateX(-2px);
}
</style>
