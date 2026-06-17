<script setup lang="ts">
/**
 * 任务列表页
 * 支持按项目、状态、负责人等条件筛选任务
 */
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useTable } from '@/composables/useTable'
import { getTaskList } from '@/api/task'
import { taskStatusOptions } from '@/utils/status'
import type { Task } from '@/types/task'

const router = useRouter()

const columns = [
  { title: '任务标题', dataIndex: 'title', width: 250 },
  { title: '所属项目', dataIndex: 'projectName', width: 150 },
  { title: '负责人', dataIndex: 'assigneeName', width: 100 },
  { title: '状态', dataIndex: 'status', width: 100, slotName: 'status' },
  { title: '优先级', dataIndex: 'priority', width: 80, slotName: 'priority' },
  { title: '截止日期', dataIndex: 'deadline', width: 120 },
  { title: '操作', width: 180, slotName: 'actions', fixed: 'right' },
]

const {
  tableData,
  loading,
  total,
  pagination,
  fetchData,
  handlePageChange,
  handlePageSizeChange,
  setFilter,
  refresh,
} = useTable<Task>(getTaskList)

/** 搜索 */
function handleSearch(keyword: string) {
  setFilter('keyword', keyword)
}

/** 状态筛选 */
function handleStatusChange(status: number | undefined) {
  setFilter('status', status)
}

/** 跳转到创建任务页面 */
function handleCreate() {
  router.push('/task/create')
}

onMounted(() => {
  fetchData()
})
</script>

<template>
  <div class="task-list">
    <a-card title="任务管理">
      <!-- 筛选栏 -->
      <FilterBar
        placeholder="搜索任务标题"
        :status-options="taskStatusOptions"
        @search="handleSearch"
        @status-change="handleStatusChange"
        @reset="refresh"
      >
        <template #actions>
          <a-button type="primary" @click="handleCreate">创建任务</a-button>
        </template>
      </FilterBar>

      <!-- 表格 -->
      <BaseTable
        :data="tableData"
        :columns="columns"
        :loading="loading"
        :total="total"
        :current-page="pagination.page"
        :page-size="pagination.pageSize"
        show-selection
        @page-change="handlePageChange"
        @page-size-change="handlePageSizeChange"
      >
        <template #status="{ record }">
          <StatusTag :status="record.status" type="task" />
        </template>
        <template #priority="{ record }">
          <a-tag v-if="record.priority === 3" color="red">紧急</a-tag>
          <a-tag v-else-if="record.priority === 2" color="orange">高</a-tag>
          <a-tag v-else-if="record.priority === 1" color="blue">中</a-tag>
          <a-tag v-else color="gray">低</a-tag>
        </template>
        <template #actions="{ record }">
          <a-button type="text" size="small">编辑</a-button>
          <a-button type="text" size="small">完成</a-button>
          <a-button type="text" size="small" status="danger">删除</a-button>
        </template>
      </BaseTable>
    </a-card>
  </div>
</template>

<style scoped lang="less">
.task-list {
  // 页面无额外样式
}
</style>
