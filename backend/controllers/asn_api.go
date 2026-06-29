package controllers

import (
	"log/slog"
	"net/http"
	"strings"

	"nms-backend/asndb"

	"github.com/gin-gonic/gin"
)

// LookupASN GET /api/v1/asn?ips=8.8.8.8,1.1.1.1,2001:4860::1
// Batch IP→ASN lookup for MTR hop annotation.
// Returns map[ip]→{asn,name}; value is JSON null for private/unknown addresses.
func LookupASN(db *asndb.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		raw := c.Query("ips")
		if raw == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 ips 参数"})
			return
		}
		result := make(map[string]interface{})
		for _, ip := range strings.Split(raw, ",") {
			ip = strings.TrimSpace(ip)
			if ip == "" || ip == "???" {
				continue
			}
			result[ip] = db.Lookup(ip) // nil serializes as JSON null
		}
		c.JSON(http.StatusOK, result)
	}
}

// ReloadASNDB POST /api/v1/admin/asndb/reload
// Hot-reloads ASN data files from disk without restarting the server.
// Admin places new files on disk first, then calls this endpoint.
func ReloadASNDB(db *asndb.DB, v4, v6, names string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if err := db.Load(v4, v6, names); err != nil {
			slog.Error("asndb: 手动重载失败", "err", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		slog.Info("asndb: 手动重载成功")
		c.JSON(http.StatusOK, gin.H{"message": "ASN DB 已重载"})
	}
}

// TriggerASNDownload POST /api/v1/admin/asndb/download
// Starts an async download + reload in the background and returns 202 immediately.
// Progress and errors are written to the server log.
func TriggerASNDownload(db *asndb.DB, v4, v6, names string) gin.HandlerFunc {
	return func(c *gin.Context) {
		go func() {
			if err := db.DownloadAndUpdate(v4, v6, names); err != nil {
				slog.Error("asndb: 手动触发下载失败", "err", err)
				return
			}
			slog.Info("asndb: 手动触发下载成功")
		}()
		c.JSON(http.StatusAccepted, gin.H{
			"message": "ASN DB 下载任务已在后台启动，请通过服务器日志查看进度",
		})
	}
}

// RegisterASNRoutes wires up ASN lookup and admin management endpoints.
func RegisterASNRoutes(r *gin.Engine, db *asndb.DB,
	authMW, adminMW gin.HandlerFunc, v4, v6, names string) {
	// Any authenticated user can look up ASN (needed for MTR hop display).
	r.GET("/api/v1/asn", authMW, LookupASN(db))
	// Admin-only management endpoints.
	r.POST("/api/v1/admin/asndb/reload", authMW, adminMW, ReloadASNDB(db, v4, v6, names))
	r.POST("/api/v1/admin/asndb/download", authMW, adminMW, TriggerASNDownload(db, v4, v6, names))
}
