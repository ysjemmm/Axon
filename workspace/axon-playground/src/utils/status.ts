import type { OptionItem } from '@/types/common'

/**
 * 状态配置工具
 * 统一管理项目、任务等模块的状态文本和颜色映射
 */

/** 状态配置项 */
interface StatusConfig {
  text: string
  color: string
  bgColor?: string
}

/** 项目状态映射 */
const projectStatusMap: Record<number, StatusConfig> = {
  0: { text: '规划中', color: 'gray' },
  1: { text: '进行中', color: 'blue' },
  2: { text: '已完成', color: 'green' },
  3: { text: '已暂停', color: 'orange' },
  4: { text: '已取消', color: 'red' },
}

/** 任务状态映射 */
const taskStatusMap: Record<number | string, StatusConfig> = {
  0: { text: '待处理', color: 'gray' },
  1: { text: '进行中', color: 'blue' },
  2: { text: '已完成', color: 'green' },
  3: { text: '已关闭', color: 'purple' },
  4: { text: '已取消', color: 'red' },
  overdue: { text: '已逾期', color: '#f53f3f', bgColor: '#fff2f0' },
}

/** 任务优先级映射 */
const taskPriorityMap: Record<number, StatusConfig> = {
  0: { text: '低', color: 'gray' },
  1: { text: '中', color: 'blue' },
  2: { text: '高', color: 'orange' },
  3: { text: '紧急', color: 'red' },
}

/**
 * 获取状态配置
 * @param type 状态类型
 * @param value 状态值
 */
export function getStatusConfig(type: 'project' | 'task', value: number | string): StatusConfig {
  const map = type === 'project' ? projectStatusMap : taskStatusMap
  return map[value] || { text: '未知', color: 'gray' }
}

/**
 * 获取优先级配置
 * @param value 优先级值
 */
export function getPriorityConfig(value: number): StatusConfig {
  return taskPriorityMap[value] || { text: '未知', color: 'gray' }
}

/** 项目状态选项（用于筛选下拉框） */
export const projectStatusOptions: OptionItem[] = Object.entries(projectStatusMap).map(
  ([value, config]) => ({
    label: config.text,
    value: Number(value),
  })
)

/** 任务状态选项（用于筛选下拉框） */
export const taskStatusOptions: OptionItem[] = Object.entries(taskStatusMap).map(
  ([value, config]) => ({
    label: config.text,
    value: Number.isNaN(Number(value)) ? value : Number(value),
  })
)

/** 优先级选项 */
export const priorityOptions: OptionItem[] = Object.entries(taskPriorityMap).map(
  ([value, config]) => ({
    label: config.text,
    value: Number(value),
  })
)
