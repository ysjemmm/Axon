import { get, post, put } from './request'
import type { ApiResponse, PageResult, PageQuery } from '@/types/common'
import type { UserInfo, UserListItem, LoginParams, UpdatePasswordParams } from '@/types/user'

/**
 * 用户相关 API
 * 包含登录、用户信息、人员列表等接口
 */

/** 用户登录 */
export function login(data: LoginParams): Promise<ApiResponse<{ token: string }>> {
  return post('/auth/login', data)
}

/** 获取当前登录用户信息 */
export function getCurrentUser(): Promise<ApiResponse<UserInfo>> {
  return get('/user/current')
}

/** 修改密码 */
export function updatePassword(data: UpdatePasswordParams): Promise<ApiResponse<null>> {
  return put('/user/password', data)
}

/** 获取用户列表（分页） */
export function getUserList(params: PageQuery & { keyword?: string }): Promise<ApiResponse<PageResult<UserListItem>>> {
  return get('/user/list', params)
}

/** 获取所有人员（用于选择器） */
export function getAllPersons(): Promise<ApiResponse<UserListItem[]>> {
  return get('/user/all-persons')
}

/** 获取部门组织树 */
export function getDepartmentTree(): Promise<ApiResponse<any[]>> {
  return get('/user/department/tree')
}

/** 根据部门获取人员列表 */
export function getPersonsByDepartment(departmentId: string): Promise<ApiResponse<UserListItem[]>> {
  return get(`/user/department/${departmentId}/persons`)
}

/** 更新用户信息 */
export function updateUserInfo(data: Partial<UserInfo>): Promise<ApiResponse<null>> {
  return put('/user/info', data)
}
