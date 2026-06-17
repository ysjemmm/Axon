<script setup lang="ts">
/**
 * 通用表格组件
 * 基于 Arco Design Table 封装，支持分页、选择、排序
 */
import { computed } from 'vue'

interface Props {
  /** 表格数据 */
  data: any[]
  /** 表格列配置 */
  columns: any[]
  /** 是否加载中 */
  loading?: boolean
  /** 总条数（分页用） */
  total?: number
  /** 当前页码 */
  currentPage?: number
  /** 每页条数 */
  pageSize?: number
  /** 选中的行 keys */
  selectedKeys?: string[]
  /** 是否显示选择列 */
  showSelection?: boolean
  /** 行 key 字段名 */
  rowKey?: string
}

const props = withDefaults(defineProps<Props>(), {
  loading: false,
  total: 0,
  currentPage: 1,
  pageSize: 20,
  selectedKeys: () => [],
  showSelection: false,
  rowKey: 'id',
})

const emit = defineEmits<{
  (e: 'page-change', page: number): void
  (e: 'page-size-change', pageSize: number): void
  (e: 'selection-change', keys: string[]): void
  (e: 'sort-change', field: string, order: 'ascend' | 'descend'): void
}>()

/** 分页配置 */
const paginationConfig = computed(() => ({
  total: props.total,
  current: props.currentPage,
  pageSize: props.pageSize,
  showTotal: true,
  showPageSize: true,
}))
</script>

<template>
  <div class="base-table">
    <a-table
      :data="data"
      :columns="columns"
      :loading="loading"
      :pagination="paginationConfig"
      :row-key="rowKey"
      :row-selection="showSelection ? { type: 'checkbox', selectedRowKeys: selectedKeys } : undefined"
      @page-change="emit('page-change', $event)"
      @page-size-change="emit('page-size-change', $event)"
      @selection-change="emit('selection-change', $event)"
      @sorter-change="emit('sort-change', $event.field, $event.direction)"
    >
      <!-- 透传所有插槽 -->
      <template v-for="(_, name) in $slots" #[name]="slotData">
        <slot :name="name" v-bind="slotData || {}" />
      </template>
    </a-table>
  </div>
</template>

<style scoped lang="less">
.base-table {
  background-color: #fff;
  border-radius: 4px;
}
</style>
