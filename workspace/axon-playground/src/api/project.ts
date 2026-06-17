import { get, post, put, del } from './request'
import type { ApiResponse, PageResult, PageQuery } from '@/types/common'
import type { Project, ProjectDetail, CreateProjectParams, UpdateProjectParams } from '@/types/project'

/**
 * 项目相关 API
 * 包含项目的增删改查、成员管理等接口
 */

/** 获取项目列表（分页） */
export function getProjectList(params: PageQuery & { status?: number; keyword?: string }): Promise<ApiResponse<PageResult<Project>>> {
  return get('/project/list', params)
}

/** 获取项目详情 */
export function getProjectDetail(id: string): Promise<ApiResponse<ProjectDetail>> {
  return get(`/project/${id}`)
}

/** 创建项目 */
export function createProject(data: CreateProjectParams): Promise<ApiResponse<{ id: string }>> {
  return post('/project/create', data)
}

/** 更新项目 */
export function updateProject(id: string, data: UpdateProjectParams): Promise<ApiResponse<null>> {
  return put(`/project/${id}`, data)
}

/** 删除项目 */
export function deleteProject(id: string): Promise<ApiResponse<null>> {
  return del(`/project/${id}`)
}

/** 获取项目成员列表 */
export function getProjectMembers(projectId: string): Promise<ApiResponse<any[]>> {
  return get(`/project/${projectId}/members`)
}

/** 添加项目成员 */
export function addProjectMember(projectId: string, userId: string): Promise<ApiResponse<null>> {
  return post(`/project/${projectId}/members`, { userId })
}

/** 移除项目成员 */
export function removeProjectMember(projectId: string, userId: string): Promise<ApiResponse<null>> {
  return del(`/project/${projectId}/members/${userId}`)
}

/** 获取我参与的项目 */
export function getMyProjects(): Promise<ApiResponse<Project[]>> {
  return get('/project/my')
}
