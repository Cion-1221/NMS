package controllers

import (
	"fmt"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"nms-backend/middleware"
	"nms-backend/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// ListProbeResults GET /api/v1/probe-results —— 服务端分页查询，供 ping/tcpping/
// httpcheck/mtr 等通用结果 Tab 复用（前端固定 type 参数）。q 模糊匹配 agent_id/target。
func ListProbeResults(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
		pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))
		if page < 1 {
			page = 1
		}
		if pageSize < 1 || pageSize > 200 {
			pageSize = 20
		}

		q := db.Model(&models.ProbeResult{})
		if v := c.Query("type"); v != "" {
			q = q.Where("type = ?", v)
		}
		if v := c.Query("agent_id"); v != "" {
			q = q.Where("agent_id = ?", v)
		}
		if v := c.Query("q"); v != "" {
			agentSub := db.Model(&models.Agent{}).Select("agent_id").
				Where("agent_id LIKE ? OR hostname LIKE ?", "%"+v+"%", "%"+v+"%")
			q = q.Where("agent_id IN (?) OR target LIKE ?", agentSub, "%"+v+"%")
		}
		if v := c.Query("success"); v != "" {
			q = q.Where("success = ?", v == "true")
		}
		if v := c.Query("start"); v != "" {
			if t, err := time.Parse(time.RFC3339, v); err == nil {
				q = q.Where("reported_at >= ?", t)
			}
		}
		if v := c.Query("end"); v != "" {
			if t, err := time.Parse(time.RFC3339, v); err == nil {
				q = q.Where("reported_at <= ?", t)
			}
		}

		var total int64
		q.Count(&total)
		var results []models.ProbeResult
		q.Order("agent_id asc, reported_at desc").Offset((page - 1) * pageSize).Limit(pageSize).Find(&results)
		c.JSON(http.StatusOK, gin.H{"total": total, "items": results, "page": page, "page_size": pageSize})
	}
}

// GetLatestProbeResults GET /api/v1/probe-results/latest —— "当前状态"快照视图：
// 每个 (agent_id, target) 组合只返回最新一条结果，而不是完整历史。与
// ListProbeResults 共享同一套过滤参数（type 必填，agent_id/q/success 可选）。
//
// 用闭包重新构建查询而不是复用同一个 *gorm.DB 链对象分别 Count/Scan——这条查询带
// 自定义 Joins 子查询，比简单的 Where 链更容易在"复用查询对象做 Count 再 Find"上
// 出岔子，分别构建虽然多几行但每次都是全新语句，不存在状态复用的歧义。
func GetLatestProbeResults(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
		pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))
		if page < 1 {
			page = 1
		}
		if pageSize < 1 || pageSize > 200 {
			pageSize = 20
		}
		typeFilter := c.Query("type")
		if typeFilter == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 type 参数", "code": "bad_request"})
			return
		}
		agentID := c.Query("agent_id")
		q := c.Query("q")
		successStr := c.Query("success")
		targetExact := c.Query("target") // 精确 target IP 过滤，供 MeshPing→MTR 跳转使用

		buildQuery := func() *gorm.DB {
			tx := db.Table("probe_results AS pr").
				Joins(`INNER JOIN (
					SELECT agent_id, target, MAX(reported_at) AS max_time
					FROM probe_results WHERE type = ?
					GROUP BY agent_id, target
				) latest ON pr.agent_id = latest.agent_id AND pr.target = latest.target AND pr.reported_at = latest.max_time`, typeFilter).
				Where("pr.type = ?", typeFilter)
			if agentID != "" {
				tx = tx.Where("pr.agent_id = ?", agentID)
			}
			if targetExact != "" {
				tx = tx.Where("pr.target = ?", targetExact)
			}
			if q != "" {
				agentSub := db.Model(&models.Agent{}).Select("agent_id").
					Where("agent_id LIKE ? OR hostname LIKE ?", "%"+q+"%", "%"+q+"%")
				tx = tx.Where("pr.agent_id IN (?) OR pr.target LIKE ?", agentSub, "%"+q+"%")
			}
			if successStr != "" {
				tx = tx.Where("pr.success = ?", successStr == "true")
			}
			return tx
		}

		var total int64
		buildQuery().Count(&total)

		var results []models.ProbeResult
		buildQuery().Select("pr.*").Order("pr.agent_id asc, pr.reported_at desc").
			Offset((page - 1) * pageSize).Limit(pageSize).Scan(&results)

		c.JSON(http.StatusOK, gin.H{"total": total, "items": results, "page": page, "page_size": pageSize})
	}
}

// meshPingLatestRow 是矩阵聚合 SQL 的扫描目标。
type meshPingLatestRow struct {
	AgentID    string
	Target     string
	Success    bool
	LatencyMs  *float64
	ReportedAt time.Time
}

// GetMeshPingMatrix GET /api/v1/probe-results/meshping-matrix —— 将 meshping 结果
// 透视为 NxN 矩阵：行/列 = 当前非吊销 Agent，单元格结构为 {"v4": {...}, "v6": {...}}。
// 同一 (src, dst) 对的 IPv4 和 IPv6 探测结果独立存储，前端分别渲染，支持双栈同时显示。
func GetMeshPingMatrix(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		agentQuery := db.Model(&models.Agent{}).Where("revoked = ?", false)
		if v := c.Query("group_id"); v != "" {
			if id, err := strconv.Atoi(v); err == nil && id > 0 {
				agentQuery = agentQuery.Where("group_id = ?", id)
			}
		}
		if v := c.Query("q"); v != "" {
			agentQuery = agentQuery.Where("agent_id LIKE ? OR hostname LIKE ?", "%"+v+"%", "%"+v+"%")
		}
		var agents []models.Agent
		agentQuery.Order("group_id asc, agent_id asc").Find(&agents)

		var rows []meshPingLatestRow
		db.Raw(`
			SELECT pr.agent_id AS agent_id, pr.target AS target, pr.success AS success,
			       pr.latency_ms AS latency_ms, pr.reported_at AS reported_at
			FROM probe_results pr
			INNER JOIN (
				SELECT agent_id, target, MAX(reported_at) AS max_time
				FROM probe_results
				WHERE type = ?
				GROUP BY agent_id, target
			) latest
			ON pr.agent_id = latest.agent_id AND pr.target = latest.target AND pr.reported_at = latest.max_time
			WHERE pr.type = ?
		`, "meshping", "meshping").Scan(&rows)

		// 建立 IP → AgentID 的反查表：覆盖所有可能的 IP 字段 + source_ip_override
		ipToAgent := make(map[string]string, len(agents)*3)
		for _, a := range agents {
			registerIP := func(ip string) {
				if ip != "" {
					ipToAgent[ip] = a.AgentID
				}
			}
			registerIP(a.ConnectionIP)
			registerIP(a.ConnectionIPv4)
			registerIP(a.ConnectionIPv6)
			if a.SourceIPOverride != nil && *a.SourceIPOverride != "" {
				for _, part := range strings.SplitN(*a.SourceIPOverride, "/", 2) {
					registerIP(strings.TrimSpace(part))
				}
			}
		}

		// matrix[srcAgentID][dstAgentID] = {"v4": {...}, "v6": {...}}
		// v4/v6 键独立存储，均为可选（nil 表示无对应协议探测结果）
		matrix := make(map[string]map[string]gin.H, len(agents))
		for _, a := range agents {
			matrix[a.AgentID] = make(map[string]gin.H)
		}
		for _, row := range rows {
			targetAgentID, ok := ipToAgent[row.Target]
			if !ok {
				continue
			}
			srcMap, ok := matrix[row.AgentID]
			if !ok {
				continue
			}
			addr, _ := netip.ParseAddr(row.Target)
			protoKey := "v6"
			if addr.Is4() {
				protoKey = "v4"
			}
			if srcMap[targetAgentID] == nil {
				srcMap[targetAgentID] = gin.H{}
			}
			srcMap[targetAgentID][protoKey] = gin.H{
				"success": row.Success, "latency_ms": row.LatencyMs, "reported_at": row.ReportedAt,
				"target_ip": row.Target, // 暴露实际探测 IP，供前端 MeshPing→MTR 跳转查询使用
			}
		}

		agentList := make([]gin.H, 0, len(agents))
		for _, a := range agents {
			agentList = append(agentList, gin.H{"agent_id": a.AgentID, "hostname": a.Hostname})
		}
		c.JSON(http.StatusOK, gin.H{"agents": agentList, "matrix": matrix})
	}
}

// DeleteProbeResultPair DELETE /api/v1/probe-results/pair?agent_id=X&target=Y&type=Z
// 删除指定 (agent_id, target, type) 组合的全部历史记录（管理员专用）。
// 在 "latest" 快照视图里删除一行时，必须清掉该组合的所有历史，否则上一条历史记录会
// 立刻成为新的 "latest" 补回来，视觉上看不到任何变化。Agent 再上报时新数据自然写入。
func DeleteProbeResultPair(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		agentID := c.Query("agent_id")
		target := c.Query("target")
		typeFilter := c.Query("type")
		if agentID == "" || target == "" || typeFilter == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "缺少必要参数 agent_id / target / type", "code": "bad_request"})
			return
		}
		result := db.Where("agent_id = ? AND target = ? AND type = ?", agentID, target, typeFilter).
			Delete(&models.ProbeResult{})
		if result.Error != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "删除失败: " + result.Error.Error(), "code": "server_error"})
			return
		}
		// 与 PurgeProbeResults 同口径：管理员删数据必须留审计痕迹
		writeAgentAudit(db, getUsername(c), "delete_probe_pair", "probe_results", "",
			fmt.Sprintf("Deleted probe results for agent=%s target=%s type=%s (%d rows)", agentID, target, typeFilter, result.RowsAffected))
		c.JSON(http.StatusOK, gin.H{"deleted": result.RowsAffected})
	}
}

// PurgeProbeResults DELETE /api/v1/probe-results?days=N —— 手动清理探测结果（管理员专用）。
// days=0 清空全部；days>0 清理 N 天前的数据。与 PurgeAuditLogs / PurgeDeviceAuditLogs 同款语义。
func PurgeProbeResults(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		daysStr := c.DefaultQuery("days", "")
		days, err := strconv.Atoi(daysStr)
		if err != nil || days < 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的 days 参数（0 = 全部清空，正整数 = 清理 N 天前的数据）", "code": "bad_request"})
			return
		}
		var result *gorm.DB
		if days == 0 {
			result = db.Session(&gorm.Session{AllowGlobalUpdate: true}).Delete(&models.ProbeResult{})
		} else {
			cutoff := time.Now().AddDate(0, 0, -days)
			result = db.Where("reported_at < ?", cutoff).Delete(&models.ProbeResult{})
		}
		if result.Error != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "清理失败: " + result.Error.Error(), "code": "server_error"})
			return
		}
		writeAgentAudit(db, getUsername(c), "purge_probe_results", "probe_results", "",
			fmt.Sprintf("Purged probe results (days=%d, deleted=%d rows)", days, result.RowsAffected))
		c.JSON(http.StatusOK, gin.H{"deleted": result.RowsAffected})
	}
}

// RegisterProbeResultsRoutes 挂载到主 JWT 引擎，仅需登录（与 IPAM/Devices 同等级别）——
// 监控结果查看不属于安全敏感操作，不要求管理员权限。清理接口额外要求管理员权限。
func RegisterProbeResultsRoutes(r *gin.Engine, db *gorm.DB, authMW gin.HandlerFunc) {
	pr := r.Group("/api/v1/probe-results")
	pr.Use(authMW)
	{
		pr.GET("", ListProbeResults(db))
		pr.GET("/latest", GetLatestProbeResults(db))
		pr.GET("/meshping-matrix", GetMeshPingMatrix(db))
	}

	prAdmin := r.Group("/api/v1/probe-results")
	prAdmin.Use(authMW, middleware.AdminRequired)
	{
		prAdmin.DELETE("", PurgeProbeResults(db))
		prAdmin.DELETE("/pair", DeleteProbeResultPair(db))
	}
}
