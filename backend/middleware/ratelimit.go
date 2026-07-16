package middleware

import (
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// ─────────────────────────────────────────────────────────────────────────────
// RateLimit：按客户端 IP 的滑动窗口限速中间件，用于未认证的轻量端点
// （/api/health、/auth/login、/auth/refresh），防止被脚本高频轰击放大数据库压力。
//
// 与 login_protection 的锁定机制互补：那边按"用户名+IP"限失败次数（防定向爆破），
// 这里按 IP 限总请求数（防大范围喷洒与匿名端点滥用）。阈值应设置得远高于正常
// 客户端行为——只拦异常流量，不影响真实用户。
//
// 计数保存在内存（单实例语义，与 login_protection 同取舍）：重启即清零，不会误伤。
// 滑动窗口用 Cloudflare 式两窗口近似：估算值 = 当前窗口计数 + 上一窗口计数 × 重叠比，
// O(1) 内存/每 IP，无需保存时间戳序列。
// ─────────────────────────────────────────────────────────────────────────────

// rlMaxEntries：条目数超过该阈值时触发惰性清理（剔除两个窗口内无活动的 IP），
// 保证长期运行下内存有界；正常规模远达不到。
const rlMaxEntries = 4096

// RateLimit 返回一个独立计数的限速 handler：窗口 window 内每 IP 最多 maxRequests 次，
// 超限返回 429（附 Retry-After 头与 common.rate_limited 错误码）。
// 每次调用返回的 handler 持有自己的计数器，不同端点互不影响。
func RateLimit(maxRequests int, window time.Duration) gin.HandlerFunc {
	type entry struct {
		windowStart time.Time // 当前窗口起点（对齐到 window 整数倍）
		curr, prev  int       // 当前 / 上一窗口的请求计数
	}
	var (
		mu      sync.Mutex
		entries = make(map[string]*entry)
	)

	return func(c *gin.Context) {
		now := time.Now()
		curWindow := now.Truncate(window)
		ip := c.ClientIP()

		mu.Lock()
		if len(entries) > rlMaxEntries {
			for k, e := range entries {
				if now.Sub(e.windowStart) >= 2*window {
					delete(entries, k)
				}
			}
		}

		e, ok := entries[ip]
		if !ok {
			e = &entry{windowStart: curWindow}
			entries[ip] = e
		}
		if !e.windowStart.Equal(curWindow) {
			if e.windowStart.Add(window).Equal(curWindow) {
				e.prev = e.curr // 恰好跨入下一窗口：当前计数退位
			} else {
				e.prev = 0 // 跨了不止一个窗口：历史全部过期
			}
			e.curr = 0
			e.windowStart = curWindow
		}

		// 滑动窗口近似：上一窗口按剩余重叠比例折算进估算值
		overlap := 1 - float64(now.Sub(curWindow))/float64(window)
		estimated := float64(e.curr) + float64(e.prev)*overlap
		if estimated >= float64(maxRequests) {
			mu.Unlock()
			// Retry-After = 距当前窗口结束的秒数（向上取整），客户端据此退避
			c.Header("Retry-After", fmt.Sprintf("%d", int((window-now.Sub(curWindow)).Seconds())+1))
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error": "请求过于频繁，请稍后再试",
				"code":  "common.rate_limited",
			})
			return
		}
		e.curr++
		mu.Unlock()

		c.Next()
	}
}
