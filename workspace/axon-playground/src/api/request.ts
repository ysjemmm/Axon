import axios from 'axios'
import type { AxiosInstance, AxiosRequestConfig, InternalAxiosRequestConfig, AxiosResponse } from 'axios'
import type { ApiResponse } from '@/types/common'

/**
 * Axios 实例封装
 * 包含请求拦截器、响应拦截器、统一错误处理
 */

const service: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
})

// 请求拦截器：注入 Token 和请求日志
service.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = localStorage.getItem('access_token')
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`
    }
    console.log(`[Request] ${config.method?.toUpperCase()} ${config.url}`)
    return config
  },
  (error) => {
    console.error('[Request Error]', error)
    return Promise.reject(error)
  }
)

// 响应拦截器：统一处理业务状态码和 HTTP 错误
service.interceptors.response.use(
  (response: AxiosResponse<ApiResponse>) => {
    const { code, message } = response.data

    // 业务成功
    if (code === 200) {
      return response.data as any
    }

    // Token 过期，跳转登录
    if (code === 401) {
      localStorage.removeItem('access_token')
      window.location.href = '/login'
      return Promise.reject(new Error('登录已过期，请重新登录'))
    }

    // 其他业务错误
    console.error(`[Business Error] code: ${code}, message: ${message}`)
    return Promise.reject(new Error(message || '请求失败'))
  },
  (error) => {
    const status = error.response?.status
    const errorMap: Record<number, string> = {
      400: '请求参数错误',
      403: '没有访问权限',
      404: '请求资源不存在',
      500: '服务器内部错误',
      502: '网关错误',
      503: '服务不可用',
    }
    const message = errorMap[status] || '网络连接异常，请稍后重试'
    console.error(`[HTTP Error] status: ${status}, message: ${message}`)
    return Promise.reject(new Error(message))
  }
)

/** 通用 GET 请求 */
export function get<T>(url: string, params?: object, config?: AxiosRequestConfig): Promise<ApiResponse<T>> {
  return service.get(url, { params, ...config })
}

/** 通用 POST 请求 */
export function post<T>(url: string, data?: object, config?: AxiosRequestConfig): Promise<ApiResponse<T>> {
  return service.post(url, data, config)
}

/** 通用 PUT 请求 */
export function put<T>(url: string, data?: object, config?: AxiosRequestConfig): Promise<ApiResponse<T>> {
  return service.put(url, data, config)
}

/** 通用 DELETE 请求 */
export function del<T>(url: string, params?: object, config?: AxiosRequestConfig): Promise<ApiResponse<T>> {
  return service.delete(url, { params, ...config })
}

export default service
