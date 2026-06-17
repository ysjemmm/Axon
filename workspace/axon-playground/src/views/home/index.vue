<script setup lang="ts">
/**
 * 首页看板
 * 展示项目概览、待办任务、统计数据等
 */
import { ref, onMounted } from 'vue'

// 统计数据
const stats = ref({
  totalProjects: 12,
  activeProjects: 5,
  totalTasks: 48,
  pendingTasks: 16,
  completedTasks: 30,
  overdueItems: 3,
})

// 近期待办
const todoList = ref([
  { id: '1', title: '完成用户模块接口联调', project: '客户管理系统', deadline: '2024-03-20' },
  { id: '2', title: '修复登录页样式问题', project: '产研管理平台', deadline: '2024-03-21' },
  { id: '3', title: '编写单元测试', project: '数据分析工具', deadline: '2024-03-22' },
  { id: '4', title: '需求评审会议', project: '移动端 App', deadline: '2024-03-23' },
])

onMounted(() => {
  // 实际项目中加载首页数据
  console.log('[Home] 首页数据加载完成')
})
</script>

<template>
  <div class="home-page">
    <div class="home-page__header">
      <h1 class="home-page__title">工作台</h1>
      <p class="home-page__subtitle">欢迎回来，今天有 3 个待办事项</p>
    </div>

    <!-- 统计卡片 -->
    <a-row :gutter="16" class="home-page__stats">
      <a-col :span="6">
        <a-card>
          <a-statistic title="进行中项目" :value="stats.activeProjects" />
        </a-card>
      </a-col>
      <a-col :span="6">
        <a-card>
          <a-statistic title="待处理任务" :value="stats.pendingTasks" />
        </a-card>
      </a-col>
      <a-col :span="6">
        <a-card>
          <a-statistic title="已完成任务" :value="stats.completedTasks" />
        </a-card>
      </a-col>
      <a-col :span="6">
        <a-card>
          <a-statistic title="逾期事项" :value="stats.overdueItems" value-style="color: #f53f3f" />
        </a-card>
      </a-col>
    </a-row>

    <!-- 待办列表 -->
    <a-card title="我的待办" class="home-page__todo">
      <a-list :data="todoList" :bordered="false">
        <template #item="{ item }">
          <a-list-item>
            <a-list-item-meta :title="item.title" :description="`${item.project} · 截止 ${item.deadline}`" />
          </a-list-item>
        </template>
      </a-list>
    </a-card>
  </div>
</template>

<style scoped lang="less">
.home-page {
  &__header {
    margin-bottom: 24px;
  }

  &__title {
    margin: 0;
    font-size: 24px;
    font-weight: 600;
    color: #1d2129;
  }

  &__subtitle {
    margin: 8px 0 0;
    font-size: 14px;
    color: #86909c;
  }

  &__stats {
    margin-bottom: 24px;
  }

  &__todo {
    margin-bottom: 24px;
  }
}
</style>
