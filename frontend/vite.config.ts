import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// 生产构建注入的 Content-Security-Policy（<meta http-equiv>）。
//   - script-src 'self'：React 生产包、antd、G2 5.2+ 都不依赖 eval / inline script
//   - style-src 'unsafe-inline'：antd 的 cssinjs 在运行时注入 <style>，无法去掉
//   - img-src data: blob:：内联图标与导出预览
//   - font-src 'self'：字体已随 @fontsource 打包，不再有第三方来源
// 只在 build 时注入：Vite 开发服务器的 HMR 需要内联脚本与 ws 连接，注入会把 dev 打挂。
// Nginx 建议同时以响应头下发同一策略并追加 frame-ancestors 'none'（meta 形式不支持
// 该指令），见 README「部署运维」。若日后某个图表在严格策略下报 CSP 错误，先在
// Nginx 头里临时放开 script-src 'unsafe-eval' 定位，不要直接放宽这里。
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

const cspMeta = (): Plugin => ({
  name: 'cion-csp-meta',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
      injectTo: 'head-prepend',
    },
  ],
})

export default defineConfig({
  plugins: [react(), cspMeta()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true
      }
    }
  }
})
