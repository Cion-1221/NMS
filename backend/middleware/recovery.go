package middleware

import (
	"log/slog"
	"net/http"
	"runtime/debug"

	"github.com/gin-gonic/gin"
)

// Recovery 捕获 handler panic 并将完整堆栈写入 slog（落盘到日志文件），
// 替代 gin.Recovery() 的 stderr 输出，避免 panic 信息绕过日志系统。
// 同时返回统一的 500 JSON，而不是直接挂断连接。
func Recovery() gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("panic recovered",
					"err", r,
					"method", c.Request.Method,
					"path", c.Request.URL.Path,
					"ip", c.ClientIP(),
					"stack", string(debug.Stack()),
				)
				c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "服务器内部错误"})
			}
		}()
		c.Next()
	}
}
