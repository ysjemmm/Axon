<script setup lang="ts">
/**
 * 侧边栏组件
 * 显示菜单导航，支持折叠
 */
import { ref, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAppStore } from '@/store/app'

const router = useRouter()
const route = useRoute()
const appStore = useAppStore()

/** 菜单数据 */
const menuItems = ref([
  { key: '/home', title: '首页看板', icon: 'icon-dashboard' },
  { key: '/project/list', title: '项目管理', icon: 'icon-folder' },
  { key: '/task/list', title: '任务管理', icon: 'icon-check-circle' },
  { key: '/user/profile', title: '个人中心', icon: 'icon-user' },
])

/** 当前选中的菜单项 */
const selectedKeys = computed(() => [route.path])

/** 菜单点击导航 */
function handleMenuClick(key: string) {
  router.push(key)
}
</script>

<template>
  <div class="sidebar" :class="{ 'sidebar--collapsed': appStore.sidebarCollapsed }">
    <a-menu
      :selected-keys="selectedKeys"
      :collapsed="appStore.sidebarCollapsed"
      @menu-item-click="handleMenuClick"
    >
      <a-menu-item v-for="item in menuItems" :key="item.key">
        <template #icon><component :is="item.icon" /></template>
        {{ item.title }}
      </a-menu-item>
    </a-menu>

    <!-- 折叠按钮 -->
    <div class="sidebar__collapse-btn" @click="appStore.toggleSidebar">
      <icon-menu-fold v-if="!appStore.sidebarCollapsed" />
      <icon-menu-unfold v-else />
    </div>
  </div>
</template>

<style scoped lang="less">
.sidebar {
  width: 220px;
  height: 100%;
  background-color: #fff;
  border-right: 1px solid #e5e6eb;
  display: flex;
  flex-direction: column;
  transition: width 0.2s ease;

  &--collapsed {
    width: 48px;
  }

  &__collapse-btn {
    padding: 12px;
    text-align: center;
    cursor: pointer;
    border-top: 1px solid #e5e6eb;
    color: #86909c;

    &:hover {
      color: #165dff;
    }
  }
}
</style>
