/**
 * 任务相关类型定义
 * 包含任务实体、创建/更新参数等
 */

/** 任务状态枚举 */
export enum TaskStatus {
  /** 待处理 */
  Pending = 0,
  /** 进行中 */
  InProgress = 1,
  /** 已完成 */
  Done = 2,
  /** 已关闭 */
  Closed = 3,
  /** 已取消 */
  Cancelled = 4,
}

/** 任务优先级枚举 */
export enum TaskPriority {
  /** 低 */
  Low = 0,
  /** 中 */
  Medium = 1,
  /** 高 */
  High = 2,
  /** 紧急 */
  Urgent = 3,
}

/** 任务类型枚举 */
export enum TaskType {
  /** 开发 */
  Development = 'development',
  /** 测试 */
  Testing = 'testing',
  /** 设计 */
  Design = 'design',
  /** 文档 */
  Documentation = 'documentation',
  /** 缺陷修复 */
  BugFix = 'bugfix',
}

/** 任务列表项 */
export interface Task {
  /** 任务 ID */
  id: string
  /** 任务标题 */
  title: string
  /** 所属项目 ID */
  projectId: string
  /** 所属项目名称 */
  projectName: string
  /** 任务状态 */
  status: TaskStatus
  /** 优先级 */
  priority: TaskPriority
  /** 任务类型 */
  type: TaskType
  /** 负责人 ID */
  assigneeId: string
  /** 负责人姓名 */
  assigneeName: string
  /** 预估工时（小时） */
  estimatedHours: number
  /** 截止日期 */
  deadline: string
  /** 创建时间 */
  createdAt: string
}

/** 任务详情 */
export interface TaskDetail extends Task {
  /** 任务描述（支持富文本） */
  description: string
  /** 创建人 ID */
  creatorId: string
  /** 创建人姓名 */
  creatorName: string
  /** 实际工时（小时） */
  actualHours: number
  /** 开始时间 */
  startedAt: string
  /** 完成时间 */
  completedAt: string
  /** 标签列表 */
  tags: string[]
  /** 附件列表 */
  attachments: TaskAttachment[]
}

/** 任务附件 */
export interface TaskAttachment {
  id: string
  name: string
  url: string
  size: number
  uploadedAt: string
}

/** 创建任务参数 */
export interface CreateTaskParams {
  title: string
  projectId: string
  description?: string
  priority: TaskPriority
  type: TaskType
  assigneeId: string
  estimatedHours?: number
  deadline?: string
  tags?: string[]
}

/** 更新任务参数 */
export interface UpdateTaskParams {
  title?: string
  description?: string
  priority?: TaskPriority
  type?: TaskType
  assigneeId?: string
  estimatedHours?: number
  deadline?: string
  tags?: string[]
}
