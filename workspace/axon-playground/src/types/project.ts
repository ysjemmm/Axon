/**
 * 项目相关类型定义
 * 包含项目实体、创建/更新参数等
 */

/** 项目状态枚举 */
export enum ProjectStatus {
  /** 规划中 */
  Planning = 0,
  /** 进行中 */
  InProgress = 1,
  /** 已完成 */
  Completed = 2,
  /** 已暂停 */
  Paused = 3,
  /** 已取消 */
  Cancelled = 4,
}

/** 项目列表项 */
export interface Project {
  /** 项目 ID */
  id: string
  /** 项目名称 */
  name: string
  /** 项目编号 */
  code: string
  /** 项目描述 */
  description: string
  /** 项目状态 */
  status: ProjectStatus
  /** 项目负责人 ID */
  ownerId: string
  /** 项目负责人姓名 */
  ownerName: string
  /** 计划开始日期 */
  planStartDate: string
  /** 计划结束日期 */
  planEndDate: string
  /** 进度百分比（0~100） */
  progress: number
  /** 成员数量 */
  memberCount: number
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
}

/** 项目详情（包含更多字段） */
export interface ProjectDetail extends Project {
  /** 实际开始日期 */
  actualStartDate: string
  /** 实际结束日期 */
  actualEndDate: string
  /** 项目成员列表 */
  members: ProjectMember[]
  /** 关联任务数 */
  taskCount: number
  /** 已完成任务数 */
  completedTaskCount: number
}

/** 项目成员 */
export interface ProjectMember {
  userId: string
  name: string
  avatar: string
  role: 'owner' | 'developer' | 'tester' | 'viewer'
  joinedAt: string
}

/** 创建项目参数 */
export interface CreateProjectParams {
  name: string
  code: string
  description: string
  ownerId: string
  planStartDate: string
  planEndDate: string
  memberIds?: string[]
}

/** 更新项目参数 */
export interface UpdateProjectParams {
  name?: string
  description?: string
  status?: ProjectStatus
  ownerId?: string
  planStartDate?: string
  planEndDate?: string
}
