import type { UserInfo, UserListItem } from '@/types/user'

/**
 * 用户 Mock 数据
 * 模拟后端返回的用户信息
 */

/** 当前登录用户 */
export const currentUser: UserInfo = {
  id: 'user-001',
  account: 'zhangsan',
  name: '张三',
  avatar: '',
  email: 'zhangsan@company.com',
  phone: '13800138001',
  departmentId: 'dept-01',
  departmentName: '研发一部',
  roles: ['developer', 'team-leader'],
  permissions: ['project:read', 'project:write', 'task:read', 'task:write', 'task:delete'],
  createdAt: '2023-01-15 10:00:00',
}

/** 人员列表 Mock 数据 */
export const userList: UserListItem[] = [
  { id: 'user-001', account: 'zhangsan', name: '张三', avatar: '', departmentName: '研发一部' },
  { id: 'user-002', account: 'lisi', name: '李四', avatar: '', departmentName: '研发一部' },
  { id: 'user-003', account: 'wangwu', name: '王五', avatar: '', departmentName: '研发二部' },
  { id: 'user-004', account: 'zhaoliu', name: '赵六', avatar: '', departmentName: '测试部' },
  { id: 'user-005', account: 'sunqi', name: '孙七', avatar: '', departmentName: '产品部' },
  { id: 'user-006', account: 'zhouba', name: '周八', avatar: '', departmentName: '设计部' },
  { id: 'user-007', account: 'wujiu', name: '吴九', avatar: '', departmentName: '研发二部' },
  { id: 'user-008', account: 'zhengshi', name: '郑十', avatar: '', departmentName: '测试部' },
]

/** 部门组织树 Mock 数据 */
export const departmentTree = [
  {
    id: 'dept-root',
    name: '天谷数智化中心',
    parentId: '',
    children: [
      {
        id: 'dept-01',
        name: '研发一部',
        parentId: 'dept-root',
        children: [],
      },
      {
        id: 'dept-02',
        name: '研发二部',
        parentId: 'dept-root',
        children: [],
      },
      {
        id: 'dept-03',
        name: '测试部',
        parentId: 'dept-root',
        children: [],
      },
      {
        id: 'dept-04',
        name: '产品部',
        parentId: 'dept-root',
        children: [],
      },
      {
        id: 'dept-05',
        name: '设计部',
        parentId: 'dept-root',
        children: [],
      },
    ],
  },
]
