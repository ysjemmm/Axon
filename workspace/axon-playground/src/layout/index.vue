<script setup lang="ts">
/**
 * 主布局组件
 * 包含顶部导航栏、侧边栏和内容区域
 */
import { computed } from 'vue'
import { useAppStore } from '@/store/app'
import Navbar from './Navbar.vue'
import Sidebar from './Sidebar.vue'

const appStore = useAppStore()

/** 内容区域左边距随侧边栏宽度变化 */
const contentStyle = computed(() => ({
  marginLeft: `${appStore.sidebarWidth}px`,
  transition: 'margin-left 0.2s ease',
}))
</script>

<template>
  <div class="layout">
    <!-- 顶部导航栏 -->
    <Navbar class="layout__navbar" />

    <!-- 侧边栏 -->
    <Sidebar class="layout__sidebar" />

    <!-- 主内容区域 -->
    <main class="layout__content" :style="contentStyle">
      <div class="layout__breadcrumb">
        <a-breadcrumb>
          <a-breadcrumb-item v-for="item in appStore.breadcrumbs" :key="item.title">
            <router-link v-if="item.path" :to="item.path">{{ item.title }}</router-link>
            <span v-else>{{ item.title }}</span>
          </a-breadcrumb-item>
        </a-breadcrumb>
      </div>
      <div class="layout__page">
        <router-view />
      </div>
    </main>
  </div>
</template>

<style scoped lang="less">
.layout {
  min-height: 100vh;
  background-color: #f2f3f5;

  &__navbar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 100;
    height: 56px;
  }

  &__sidebar {
    position: fixed;
    top: 56px;
    left: 0;
    bottom: 0;
    z-index: 99;
  }

  &__content {
    padding-top: 56px;
    min-height: 100vh;
  }

  &__breadcrumb {
    padding: 16px 24px 0;
  }

  &__page {
    padding: 16px 24px 24px;
  }
}
</style>
