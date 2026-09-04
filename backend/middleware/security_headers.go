package middleware

import "github.com/gin-gonic/gin"

// SecurityHeaders 给主 API 引擎的所有响应加基础安全头。页面级的 CSP / HSTS 由前端
// 构建期注入的 <meta> 与 Nginx 负责（见 README 部署章节）；这里只覆盖 API 响应本身：
//   - nosniff：JSON 响应不被浏览器嗅探成脚本 / HTML
//   - DENY：API 响应不允许被嵌入 iframe
//   - no-referrer：不向第三方泄露带路径的 API URL
//   - no-store：带 Bearer 的响应不进浏览器 / 中间缓存
func SecurityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.Writer.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cache-Control", "no-store")
		c.Next()
	}
}
