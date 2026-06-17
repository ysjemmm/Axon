import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

/**
 * 路由配置
 * 包含主布局嵌套路由和独立页面路由
 */

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: () => import('@/layout/index.vue'),
    redirect: '/home',
    children: [
      {
        path: 'home',
        name: 'Home',
        component: () => import('@/views/home/index.vue'),
        meta: { title: '首页看板', icon: 'icon-dashboard' },
      },
      {
        path: 'project',
        name: 'Project',
        redirect: '/project/list',
        meta: { title: '项目管理', icon: 'icon-folder' },
        children: [
          {
            path: 'list',
            name: 'ProjectList',
            component: () => import('@/views/project/index.vue'),
            meta: { title: '项目列表' },
          },
          {
            path: ':id',
            name: 'ProjectDetail',
            component: () => import('@/views/project/detail.vue'),
            meta: { title: '项目详情', hidden: true },
          },
        ],
      },
      {
        path: 'task',
        name: 'Task',
        redirect: '/task/list',
        meta: { title: '任务管理', icon: 'icon-check-circle' },
        children: [
          {
            path: 'list',
            name: 'TaskList',
            component: () => import('@/views/task/index.vue'),
            meta: { title: '任务列表' },
          },
          {
            path: 'create',
            name: 'TaskCreate',
            component: () => import('@/views/task/create.vue'),
            meta: { title: '创建任务' },
          },
        ],
      },
      {
        path: 'user',
        name: 'User',
        meta: { title: '个人中心', icon: 'icon-user' },
        children: [
          {
            path: 'profile',
            name: 'UserProfile',
            component: () => import('@/views/user/profile.vue'),
            meta: { title: '个人设置' },
          },
        ],
      },
      {
        path: '/settings',
        name: 'Settings',
        component: () => import('@/views/user/profile.vue'),
        meta: { title: '系统设置' },
      },
    ],
  },
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/home/index.vue'), // 演示项目复用首页
    meta: { title: '登录', requiresAuth: false },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'NotFound',
    component: () => import('@/views/home/index.vue'), // 404 复用
    meta: { title: '页面不存在' },
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

// 路由守卫：检查登录状态
router.beforeEach((to, _from, next) => {
  const token = localStorage.getItem('access_token')
  if (to.meta.requiresAuth !== false && !token) {
    next({ name: 'Login' })
  } else {
    document.title = `${to.meta.title || '产研管理系统'}`
    next()
  }
})

export default router
