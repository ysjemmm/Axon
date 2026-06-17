<script setup lang="ts">
/**
 * 筛选栏组件
 * 提供关键字搜索、状态筛选等通用筛选功能
 */
import { ref, watch } from 'vue'
import type { OptionItem } from '@/types/common'

interface Props {
  /** 搜索框占位文字 */
  placeholder?: string
  /** 状态选项列表 */
  statusOptions?: OptionItem[]
  /** 是否显示状态筛选 */
  showStatus?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  placeholder: '请输入关键字搜索',
  statusOptions: () => [],
  showStatus: true,
})

const emit = defineEmits<{
  (e: 'search', keyword: string): void
  (e: 'status-change', status: number | undefined): void
  (e: 'reset'): void
}>()

const keyword = ref('')
const selectedStatus = ref<number | undefined>(undefined)

/** 触发搜索 */
function handleSearch() {
  emit('search', keyword.value.trim())
}

/** 状态筛选变化 */
watch(selectedStatus, (val) => {
  emit('status-change', val)
})

/** 重置筛选条件 */
function handleReset() {
  keyword.value = ''
  selectedStatus.value = undefined
  emit('reset')
}
</script>

<template>
  <div class="filter-bar">
    <div class="filter-bar__left">
      <a-input-search
        v-model="keyword"
        :placeholder="placeholder"
        allow-clear
        style="width: 280px"
        @search="handleSearch"
        @clear="handleSearch"
      />
      <a-select
        v-if="showStatus && statusOptions.length"
        v-model="selectedStatus"
        placeholder="状态筛选"
        allow-clear
        style="width: 160px; margin-left: 12px"
      >
        <a-option
          v-for="option in statusOptions"
          :key="option.value"
          :value="option.value"
          :label="option.label"
        />
      </a-select>
    </div>
    <div class="filter-bar__right">
      <a-button @click="handleReset">重置</a-button>
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped lang="less">
.filter-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 0;

  &__left {
    display: flex;
    align-items: center;
  }

  &__right {
    display: flex;
    align-items: center;
    gap: 8px;
  }
}
</style>
