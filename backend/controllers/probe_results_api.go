package controllers

import (
	"net/http"
	"strconv"
	"time"

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
			q = q.Where("agent_id LIKE ? OR target LIKE ?", "%"+v+"%", "%"+v+"%")
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
		q.Order("reported_at desc").Offset((page - 1) * pageSize).Limit(pageSize).Find(&results)
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
			c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 type 参数"})
			return
		}
		agentID := c.Query("agent_id")
		q := c.Query("q")
		successStr := c.Query("success")

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
			if q != "" {
				tx = tx.Where("pr.agent_id LIKE ? OR pr.target LIKE ?", "%"+q+"%", "%"+q+"%")
			}
			if successStr != "" {
				tx = tx.Where("pr.success = ?", successStr == "true")
			}
			return tx
		}

		var total int64
		buildQuery().Count(&total)

		var results []models.ProbeResult
		buildQuery().Select("pr.*").Order("pr.reported_at desc").
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
// 透视为 NxN 矩阵：行/列 = 当前存活的 Agent（可用 group_id/q 过滤参与的 Agent 集合），
// 单元格 = 该 Agent 对另一 Agent 的最新一次探测结果。
//
// 已知简化：ProbeResult.Target 存的是探测发起时对端的 ConnectionIP（Agent 侧只认
// IP，不感知对端 AgentID），矩阵在读取时按"各 Agent 当前 ConnectionIP"反查回
// AgentID 做单元格归属。若某 Agent 的 ConnectionIP 在两次探测之间发生变化，历史
// 结果可能无法归位到正确的列——这是当前 Agent↔Server 协议（只传 IP）下的固有限制，
// 而非 bug。
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
		agentQuery.Order("agent_id asc").Find(&agents)

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

		ipToAgent := make(map[string]string, len(agents))
		for _, a := range agents {
			if a.ConnectionIP != "" {
				ipToAgent[a.ConnectionIP] = a.AgentID
			}
		}

		matrix := make(map[string]map[string]gin.H, len(agents))
		for _, a := range agents {
			matrix[a.AgentID] = make(map[string]gin.H)
		}
		for _, row := range rows {
			targetAgentID, ok := ipToAgent[row.Target]
			if !ok {
				continue
			}
			if _, ok := matrix[row.AgentID]; !ok {
				continue
			}
			matrix[row.AgentID][targetAgentID] = gin.H{
				"success": row.Success, "latency_ms": row.LatencyMs, "reported_at": row.ReportedAt,
			}
		}

		agentList := make([]gin.H, 0, len(agents))
		for _, a := range agents {
			agentList = append(agentList, gin.H{"agent_id": a.AgentID, "hostname": a.Hostname})
		}
		c.JSON(http.StatusOK, gin.H{"agents": agentList, "matrix": matrix})
	}
}

// RegisterProbeResultsRoutes 挂载到主 JWT 引擎，仅需登录（与 IPAM/Devices 同等级别）——
// 监控结果查看不属于安全敏感操作，不要求管理员权限。
func RegisterProbeResultsRoutes(r *gin.Engine, db *gorm.DB, authMW gin.HandlerFunc) {
	pr := r.Group("/api/v1/probe-results")
	pr.Use(authMW)
	{
		pr.GET("", ListProbeResults(db))
		pr.GET("/latest", GetLatestProbeResults(db))
		pr.GET("/meshping-matrix", GetMeshPingMatrix(db))
	}
}
