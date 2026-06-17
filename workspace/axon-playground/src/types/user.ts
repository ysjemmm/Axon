/**
 * 用户相关类型定义
 * 包含用户信息、登录参数等
 */

/** 用户基本信息 */
export interface UserInfo {
  /** 用户 ID */
  id: string
  /** 用户名（工号） */
  account: string
  /** 姓名 */
  name: string
  /** 头像地址 */
  avatar: string
  /** 邮箱 */
  email: string
  /** 手机号 */
  phone: string
  /** 所属部门 ID */
  departmentId: string
  /** 所属部门名称 */
  departmentName: string
  /** 角色列表 */
  roles: string[]
  /** 权限列表 */
  permissions: string[]
  /** 创建时间 */
  createdAt: string
}

/** 用户列表项（简化版） */
export interface UserListItem {
  id: string
  account: string
  name: string
  avatar: string
  departmentName: string
}

/** 登录请求参数 */
export interface LoginParams {
  /** 用户名 */
  username: string
  /** 密码 */
  password: string
}

/** 修改密码参数 */
export interface UpdatePasswordParams {
  /** 旧密码 */
  oldPassword: string
  /** 新密码 */
  newPassword: string
  /** 确认新密码 */
  confirmPassword: string
}

/** 部门节点（树形结构） */
export interface DepartmentNode {
  id: string
  name: string
  parentId: string
  children?: DepartmentNode[]
}
