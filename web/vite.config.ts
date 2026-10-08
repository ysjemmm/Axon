import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  // 基址：默认绝对 "/"（浏览器/server 形态）。
  // 打包进 VS Code webview 时设 AXON_WEB_BASE="./" 产出相对路径，便于 webview 解析本地资源。
  base: process.env.AXON_WEB_BASE || '/',
  // sourcemap 常开，便于 webview 里出错时定位真实源码（生产可接受的体积代价）
  build: {
    sourcemap: true,
    // Monaco、Markdown 与图表能力会形成较大的稳定主包；这里的提示不代表构建失败，
    // 只会把真实错误淹没。拆包策略另行处理，构建阶段不再对已知主包刷警告。
    chunkSizeWarningLimit: 5000,
    // VS Code webview 的本地资源代理会拒绝部分 modulepreload 请求。
    // Vite preload 失败会阻断首次 dynamic import，但第二次因已标记预加载而成功，
    // 表现就是 Mermaid 预览要点两次。webview 构建禁用 preload，直接 import chunk。
    modulePreload: process.env.AXON_WEB_BASE === "./" ? false : undefined,
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  }
})
