<script setup lang="ts">
/**
 * 顶部导航栏组件
 * 包含 Logo、搜索框、用户信息
 */
import { useUserStore } from '@/store/user'
import { useAppStore } from '@/store/app'
import { useRouter } from 'vue-router'

const userStore = useUserStore()
const appStore = useAppStore()
const router = useRouter()

/** 退出登录 */
function handleLogout() {
  userStore.logout()
  router.push('/login')
}

/** 切换主题 */
function handleToggleTheme() {
  appStore.toggleTheme()
}
</script>

<template>
  <div class="navbar">
    <div class="navbar__left">
      <div class="navbar__logo">
        <img src="" alt="logo" class="navbar__logo-img" />
        <span class="navbar__logo-text">产研管理系统</span>
      </div>
    </div>

    <div class="navbar__center">
      <a-input-search placeholder="全局搜索..." style="width: 320px" />
    </div>

    <div class="navbar__right">
      <a-button shape="circle" @click="handleToggleTheme">
        <template #icon>
          <icon-sun-fill v-if="appStore.isDarkMode" />
          <icon-moon-fill v-else />
        </template>
      </a-button>

      <a-button type="text" @click="handleLogout">退出登录</a-button>

      <a-dropdown>
        <div class="navbar__user">
          <a-avatar :size="28">{{ userStore.userName.slice(0, 1) }}</a-avatar>
          <span class="navbar__user-name">{{ userStore.userName }}</span>
        </div>
        <template #content>
          <a-doption @click="router.push('/user/profile')">个人设置</a-doption>
          <a-doption @click="handleLogout">退出登录</a-doption>
        </template>
      </a-dropdown>
    </div>
  </div>
</template>

<style scoped lang="less">
.navbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 56px;
  padding: 0 20px;
  background-color: #fff;
  border-bottom: 1px solid #e5e6eb;

  &__left {
    display: flex;
    align-items: center;
  }

  &__logo {
    display: flex;
    align-items: center;
    gap: 8px;

    &-img {
      width: 28px;
      height: 28px;
    }

    &-text {
      font-size: 16px;
      font-weight: 600;
      color: #1d2129;
    }
  }

  &__right {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  &__user {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;

    &-name {
      font-size: 14px;
      color: #4e5969;
    }
  }
}
</style>
