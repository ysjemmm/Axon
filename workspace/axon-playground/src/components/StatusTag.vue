<script setup lang="ts">
/**
 * 状态标签组件
 * 根据状态值显示对应颜色和文本的标签
 */
import { computed } from 'vue'
import { getStatusConfig } from '@/utils/status'

interface Props {
  /** 状态值 */
  status: number | string
  /** 状态类型（决定使用哪套配置） */
  type?: 'project' | 'task'
}

const props = withDefaults(defineProps<Props>(), {
  type: 'task',
})

/** 根据状态值获取配置 */
const statusConfig = computed(() => {
  return getStatusConfig(props.type, props.status)
})
</script>

<template>
  <a-tag :color="statusConfig.color" size="small">
    {{ statusConfig.text }}
  </a-tag>
</template>

<style scoped lang="less">
// 无需额外样式，Arco Tag 自带样式
</style>
