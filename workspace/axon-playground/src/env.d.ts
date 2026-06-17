/// <reference types="vite/client" />

/** Vite 环境变量类型声明 */
interface ImportMetaEnv {
  /** API 基础地址 */
  readonly VITE_API_BASE_URL: string
  /** 当前运行环境 */
  readonly VITE_APP_ENV: string
  /** 是否启用 Mock 数据 */
  readonly VITE_ENABLE_MOCK: string
  /** 应用标题 */
  readonly VITE_APP_TITLE: string
  /** 开发服务器端口 */
  readonly VITE_PORT: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Vue 单文件组件类型声明 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
