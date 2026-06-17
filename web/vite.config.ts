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
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  }
})
