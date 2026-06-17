<script setup lang="ts">
/**
 * 项目详情页
 * 展示项目基本信息、成员列表、关联任务等
 */
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import type { ProjectDetail } from '@/types/project'

const route = useRoute()
const projectId = route.params.id as string

const detail = ref<ProjectDetail | null>(null)
const loading = ref(false)
const activeTab = ref('info')

/** 加载项目详情 */
async function loadDetail() {
  loading.value = true
  try {
    // 实际项目中调用 API
    // const res = await getProjectDetail(projectId)
    // detail.value = res.data
    console.log('[ProjectDetail] 加载项目详情:', projectId)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadDetail()
})
</script>

<template>
  <div class="project-detail">
    <a-spin :loading="loading" style="width: 100%">
      <a-card v-if="detail">
        <!-- 项目基本信息 -->
        <template #title>
          <div class="project-detail__header">
            <h3>{{ detail.name }}</h3>
            <StatusTag :status="detail.status" type="project" />
          </div>
        </template>

        <a-descriptions :column="3" bordered>
          <a-descriptions-item label="项目编号">{{ detail.code }}</a-descriptions-item>
          <a-descriptions-item label="负责人">{{ detail.ownerName }}</a-descriptions-item>
          <a-descriptions-item label="进度">
            <a-progress :percent="detail.progress / 100" />
          </a-descriptions-item>
          <a-descriptions-item label="计划时间">
            {{ detail.planStartDate }} ~ {{ detail.planEndDate }}
          </a-descriptions-item>
          <a-descriptions-item label="成员数">{{ detail.memberCount }} 人</a-descriptions-item>
          <a-descriptions-item label="任务数">{{ detail.taskCount }} 个</a-descriptions-item>
        </a-descriptions>
      </a-card>

      <!-- Tab 切换 -->
      <a-card style="margin-top: 16px">
        <a-tabs v-model:active-key="activeTab">
          <a-tab-pane key="info" title="项目信息">
            <p>{{ detail?.description || '暂无描述' }}</p>
          </a-tab-pane>
          <a-tab-pane key="members" title="项目成员">
            <a-table :data="detail?.members || []" :pagination="false">
              <a-table-column title="姓名" data-index="name" />
              <a-table-column title="角色" data-index="role" />
              <a-table-column title="加入时间" data-index="joinedAt" />
            </a-table>
          </a-tab-pane>
          <a-tab-pane key="tasks" title="关联任务">
            <a-empty description="暂无关联任务" />
          </a-tab-pane>
        </a-tabs>
      </a-card>

      <!-- 空状态 -->
      <a-card v-if="!detail && !loading">
        <a-empty description="项目不存在或已被删除" />
      </a-card>
    </a-spin>
  </div>
</template>

<style scoped lang="less">
.project-detail {
  &__header {
    display: flex;
    align-items: center;
    gap: 12px;

    h3 {
      margin: 0;
      font-size: 18px;
    }
  }
}
</style>
