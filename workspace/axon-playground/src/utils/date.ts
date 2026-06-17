import dayjs from 'dayjs'

/**
 * 日期工具函数
 * 基于 dayjs 封装常用的日期格式化和计算方法
 */

/** 默认日期格式 */
const DEFAULT_FORMAT = 'YYYY/MM/DD'
/** 日期时间格式 */
const DATETIME_FORMAT = 'YYYY-MM-DD HH:mm:ss'

/**
 * 格式化日期
 * @param date 日期值
 * @param format 格式字符串
 */
export function formatDate(date: string | Date | number, format: string = DEFAULT_FORMAT): string {
  if (!date) return '-'
  return dayjs(date).format(format)
}

/**
 * 格式化为日期时间
 * @param date 日期值
 */
export function formatDateTime(date: string | Date | number): string {
  if (!date) return '-'
  return dayjs(date).format(DATETIME_FORMAT)
}

/**
 * 获取相对时间描述（如：3 天前、刚刚）
 * @param date 日期值
 */
export function getRelativeTime(date: string | Date | number): string {
  if (!date) return '-'
  const target = dayjs(date)
  const now = dayjs()
  const diffMinutes = now.diff(target, 'minute')

  if (diffMinutes < 1) return '刚刚'
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`
  const diffHours = now.diff(target, 'hour')
  if (diffHours < 24) return `${diffHours} 小时前`
  const diffDays = now.diff(target, 'day')
  if (diffDays < 30) return `${diffDays} 天前`
  const diffMonths = now.diff(target, 'month')
  if (diffMonths < 12) return `${diffMonths} 个月前`
  return `${now.diff(target, 'year')} 年前`
}

/**
 * 判断是否已过期
 * @param deadline 截止日期
 */
export function isOverdue(deadline: string | Date): boolean {
  if (!deadline) return false
  return dayjs().isAfter(dayjs(deadline), 'day')
}

/**
 * 计算两个日期之间的天数差
 * @param start 开始日期
 * @param end 结束日期
 */
export function getDaysDiff(start: string | Date, end: string | Date): number {
  return dayjs(end).diff(dayjs(start), 'day')
}

/**
 * 获取日期范围的快捷选项（用于 DatePicker）
 */
export function getDateRangeShortcuts() {
  return [
    { label: '最近 7 天', value: () => [dayjs().subtract(7, 'day').toDate(), dayjs().toDate()] },
    { label: '最近 30 天', value: () => [dayjs().subtract(30, 'day').toDate(), dayjs().toDate()] },
    { label: '本月', value: () => [dayjs().startOf('month').toDate(), dayjs().endOf('month').toDate()] },
  ]
}
