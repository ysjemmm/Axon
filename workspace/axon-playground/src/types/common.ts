/**
 * 通用类型定义
 * 包含 API 响应、分页、通用枚举等基础类型
 */

/** 统一 API 响应结构 */
export interface ApiResponse<T = any> {
  /** 业务状态码 */
  code: number
  /** 提示信息 */
  message: string
  /** 响应数据 */
  data: T
}

/** 分页查询参数 */
export interface PageQuery {
  /** 当前页码（从 1 开始） */
  page: number
  /** 每页条数 */
  pageSize: number
  /** 排序字段 */
  sortField?: string
  /** 排序方向 */
  sortOrder?: 'ascend' | 'descend'
}

/** 分页响应结构 */
export interface PageResult<T> {
  /** 数据列表 */
  list: T[]
  /** 总条数 */
  total: number
  /** 当前页码 */
  page: number
  /** 每页条数 */
  pageSize: number
}

/** 通用选项类型（用于下拉框等） */
export interface OptionItem {
  label: string
  value: string | number
  disabled?: boolean
}

/** 通用键值对 */
export interface KeyValuePair {
  key: string
  value: string
}

/** 时间范围 */
export interface TimeRange {
  startTime: string
  endTime: string
}
