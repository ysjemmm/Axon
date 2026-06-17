<script setup lang="ts">
/**
 * 项目列表页
 * 支持搜索、筛选、分页查看所有项目
 */
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useTable } from '@/composables/useTable'
import { getProjectList } from '@/api/project'
import { projectStatusOptions } from '@/utils/status'
import type { Project } from '@/types/project'

const router = useRouter()

const columns = [
  { title: '项目名称', dataIndex: 'name', width: 200 },
  { title: '项目编号', dataIndex: 'code', width: 120 },
  { title: '负责人', dataIndex: 'ownerName', width: 100 },
  { title: '状态', dataIndex: 'status', width: 100, slotName: 'status' },
  { title: '进度', dataIndex: 'progress', width: 120, slotName: 'progress' },
  { title: '计划时间', dataIndex: 'planStartDate', width: 200, slotName: 'planTime' },
  { title: '操作', width: 150, slotName: 'actions', fixed: 'right' },
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
} = useTable<Project>(getProjectList)

/** 查看项目详情 */
function handleDetail(record: Project) {
  router.push(`/project/${record.id}`)
}

/** 搜索 */
function handleSearch(keyword: string) {
  setFilter('keyword', keyword)
}

/** 状态筛选 */
function handleStatusChange(status: number | undefined) {
  setFilter('status', status)
}

onMounted(() => {
  fetchData()
})
</script>

<template>
  <div class="project-list">
    <a-card title="项目管理">
      <!-- 筛选栏 -->
      <FilterBar
        placeholder="搜索项目名称/编号"
        :status-options="projectStatusOptions"
        @search="handleSearch"
        @status-change="handleStatusChange"
        @reset="refresh"
      >
        <template #actions>
          <a-button type="primary">新建项目</a-button>
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
        @page-change="handlePageChange"
        @page-size-change="handlePageSizeChange"
      >
        <template #status="{ record }">
          <StatusTag :status="record.status" type="project" />
        </template>
        <template #progress="{ record }">
          <a-progress :percent="record.progress / 100" size="small" />
        </template>
        <template #planTime="{ record }">
          {{ record.planStartDate }} ~ {{ record.planEndDate }}
        </template>
        <template #actions="{ record }">
          <a-button type="text" size="small" @click="handleDetail(record)">详情</a-button>
          <a-button type="text" size="small" status="danger">删除</a-button>
        </template>
      </BaseTable>
    </a-card>
  </div>
</template>

<style scoped lang="less">
.project-list {
  // 页面无额外样式
}
</style>
