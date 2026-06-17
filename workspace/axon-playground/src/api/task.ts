import { get, post, put, del } from './request'
import type { ApiResponse, PageResult, PageQuery } from '@/types/common'
import type { Task, TaskDetail, CreateTaskParams, UpdateTaskParams } from '@/types/task'

/**
 * 任务相关 API
 * 包含任务的增删改查、状态流转等接口
 */

/** 获取任务列表（分页） */
export function getTaskList(params: PageQuery & {
  projectId?: string
  status?: number
  assignee?: string
  keyword?: string
}): Promise<ApiResponse<PageResult<Task>>> {
  return get('/task/list', params)
}

/** 获取任务详情 */
export function getTaskDetail(id: string): Promise<ApiResponse<TaskDetail>> {
  return get(`/task/${id}`)
}

/** 创建任务 */
export function createTask(data: CreateTaskParams): Promise<ApiResponse<{ id: string }>> {
  return post('/task/create', data)
}

/** 更新任务 */
export function updateTask(id: string, data: UpdateTaskParams): Promise<ApiResponse<null>> {
  return put(`/task/${id}`, data)
}

/** 删除任务 */
export function deleteTask(id: string): Promise<ApiResponse<null>> {
  return del(`/task/${id}`)
}

/** 变更任务状态 */
export function changeTaskStatus(id: string, status: number): Promise<ApiResponse<null>> {
  return put(`/task/${id}/status`, { status })
}

/** 指派任务给其他人 */
export function reassignTask(id: string, assigneeId: string): Promise<ApiResponse<null>> {
  return put(`/task/${id}/assignee`, { assigneeId })
}

/** 获取我的待办任务 */
export function getMyTodoTasks(): Promise<ApiResponse<Task[]>> {
  return get('/task/my/todo')
}

/** 批量更新任务状态 */
export function batchUpdateTaskStatus(ids: string[], status: number): Promise<ApiResponse<null>> {
  return post('/task/batch/status', { ids, status })
}
