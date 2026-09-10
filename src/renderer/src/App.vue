<script setup lang="ts">
// App 根组件
import { useTheme } from './composables/useTheme'
const { theme } = useTheme()
</script>

<template>
  <div :class="{ dark: theme === 'dark' }">
    <router-view />
  </div>
</template>

<style>
/* 全局样式 */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}
body {
  background-color: var(--bg-color);
  color: var(--text-color);
}
</style>
