package controllers

import (
	"net/http"
	"time"

	"nms-backend/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// ── NOC Overview 看板聚合 ─────────────────────────────────────────────────────
// 单一聚合端点，供前端 Dashboard 拉取需要服务端按时间桶聚合、客户端无法自行计算的
// 数据（探测量时序 + KPI sparkline）。其余 KPI/设备状态/Top mesh 前端仍可由现有列表
// 接口组合，但本端点同样返回 devices/agents/probes 概要，便于后续统一数据源。

// overviewRange 把 ?range= 选择器映射为统计窗口、时间桶大小与桶数量。
func overviewRange(r string) (window, bucket time.Duration, n int) {
	switch r {
	case "1h":
		return time.Hour, 5 * time.Minute, 12 // 12 × 5min
	case "7d":
		return 7 * 24 * time.Hour, 6 * time.Hour, 28 // 28 × 6h
	default: // "24h"
		return 24 * time.Hour, time.Hour, 24 // 24 × 1h
	}
}

// GetOverview GET /api/v1/overview?range=1h|24h|7d
// 任何已登录用户可访问（只读，直接查库，不依赖管理员限定的 agent 路由）。
func GetOverview(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		rangeStr := c.DefaultQuery("range", "24h")
		switch rangeStr {
		case "1h", "24h", "7d":
		default:
			rangeStr = "24h"
		}
		window, bucket, nBuckets := overviewRange(rangeStr)
		now := time.Now()
		start := now.Add(-window)
		bucketSec := int64(bucket.Seconds())

		// ── Devices：总数 + 按状态分面 ──
		type statusCount struct {
			Status string
			Cnt    int64
		}
		var devRows []statusCount
		db.Model(&models.Device{}).Select("status, COUNT(*) AS cnt").Group("status").Scan(&devRows)
		devices := gin.H{"total": int64(0), "active": int64(0), "offline": int64(0), "maintenance": int64(0), "planned": int64(0)}
		var devTotal int64
		for _, r := range devRows {
			devTotal += r.Cnt
			if _, ok := devices[r.Status]; ok {
				devices[r.Status] = r.Cnt
			}
		}
		devices["total"] = devTotal

		// ── Devices 运行状态分面（SNMP 采集结论，仅统计开启采集的设备）──
		// proxy_down 单列：unknown 且原因为探针失联/吊销——设备本身状态未知，但对
		// NOC 而言它是需要立即处理的采集链路故障，不能淹没在普通 unknown 里。
		type operCount struct {
			OperStatus string
			OperReason string
			Cnt        int64
		}
		var operRows []operCount
		db.Model(&models.Device{}).
			Select("oper_status, oper_reason, COUNT(*) AS cnt").
			Where("polling_mode <> 'none'").
			Group("oper_status, oper_reason").Scan(&operRows)
		var operMonitored, operUp, operDown, operProxyDown, operUnknown int64
		for _, r := range operRows {
			operMonitored += r.Cnt
			switch {
			case r.OperStatus == "up":
				operUp += r.Cnt
			case r.OperStatus == "down":
				operDown += r.Cnt
			case r.OperReason == "agent_down" || r.OperReason == "agent_revoked":
				operProxyDown += r.Cnt
			default:
				operUnknown += r.Cnt
			}
		}
		devices["oper"] = gin.H{
			"monitored":  operMonitored,
			"up":         operUp,
			"down":       operDown,
			"proxy_down": operProxyDown,
			"unknown":    operUnknown,
		}

		// ── Agents：total/online/offline/revoked（与 GetAgentSummary 同口径）──
		var agTotal, agRevoked, agOnline int64
		db.Model(&models.Agent{}).Count(&agTotal)
		db.Model(&models.Agent{}).Where("revoked = ?", true).Count(&agRevoked)
		db.Model(&models.Agent{}).Where("revoked = ? AND status = ?", false, "online").Count(&agOnline)
		agOffline := agTotal - agRevoked - agOnline

		// ── 探测时序：在 SQL 中按时间桶聚合 runs/failed，Go 侧补齐空桶 ──
		type bucketRow struct {
			Bucket int64
			Runs   int64
			Failed int64
		}
		var rows []bucketRow
		db.Model(&models.ProbeResult{}).
			Select("CAST(FLOOR(UNIX_TIMESTAMP(reported_at)/?) AS SIGNED) AS bucket, "+
				"CAST(COUNT(*) AS SIGNED) AS runs, "+
				"CAST(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS SIGNED) AS failed", bucketSec).
			Where("reported_at >= ?", start).
			Group("bucket").Order("bucket").Scan(&rows)

		runsByBucket := make(map[int64]int64, len(rows))
		failedByBucket := make(map[int64]int64, len(rows))
		var windowRuns, windowFailed int64
		for _, r := range rows {
			runsByBucket[r.Bucket] = r.Runs
			failedByBucket[r.Bucket] = r.Failed
			windowRuns += r.Runs
			windowFailed += r.Failed
		}

		// 对齐到"当前桶"为最后一桶，向前展开 nBuckets 个连续桶。
		lastBucket := now.Unix() / bucketSec
		firstBucket := lastBucket - int64(nBuckets) + 1
		series := make([]gin.H, 0, nBuckets)
		sparkProbes := make([]int64, 0, nBuckets)
		sparkFailure := make([]int64, 0, nBuckets)
		for i := 0; i < nBuckets; i++ {
			b := firstBucket + int64(i)
			ts := time.Unix(b*bucketSec, 0).UTC().Format(time.RFC3339)
			runs := runsByBucket[b]
			failed := failedByBucket[b]
			series = append(series, gin.H{"ts": ts, "runs": runs, "failed": failed})
			sparkProbes = append(sparkProbes, runs)
			sparkFailure = append(sparkFailure, failed)
		}

		var failureRate float64
		if windowRuns > 0 {
			failureRate = float64(windowFailed) / float64(windowRuns) * 100
		}

		// delta：与紧邻的上一个等长窗口对比
		var prevRuns int64
		db.Model(&models.ProbeResult{}).
			Where("reported_at >= ? AND reported_at < ?", start.Add(-window), start).Count(&prevRuns)
		var deltaPct float64
		if prevRuns > 0 {
			deltaPct = float64(windowRuns-prevRuns) / float64(prevRuns) * 100
		}

		// ── 各分组（region）健康度 ──
		type regionRow struct {
			Region string
			Total  int64
			Online int64
		}
		var regRows []regionRow
		db.Table("agents a").
			Select("COALESCE(g.name, 'Ungrouped') AS region, "+
				"CAST(COUNT(*) AS SIGNED) AS total, "+
				"CAST(SUM(CASE WHEN a.status = 'online' AND a.revoked = 0 THEN 1 ELSE 0 END) AS SIGNED) AS online").
			Joins("LEFT JOIN agent_groups g ON g.id = a.group_id").
			Group("a.group_id, g.name").Order("total DESC").Limit(6).Scan(&regRows)
		regions := make([]gin.H, 0, len(regRows))
		for _, r := range regRows {
			var uptime float64
			if r.Total > 0 {
				uptime = float64(r.Online) / float64(r.Total) * 100
			}
			regions = append(regions, gin.H{"region": r.Region, "online": r.Online, "total": r.Total, "uptime_pct": uptime})
		}

		// ── 最近告警：窗口内最新的失败探测 ──
		type alertRow struct {
			Hostname   string
			Target     string
			Type       string
			ReportedAt time.Time
		}
		var alertRows []alertRow
		db.Table("probe_results pr").
			Select("COALESCE(a.hostname, pr.agent_id) AS hostname, pr.target, pr.type, pr.reported_at").
			Joins("LEFT JOIN agents a ON a.agent_id = pr.agent_id").
			Where("pr.success = ? AND pr.reported_at >= ?", false, start).
			Order("pr.reported_at DESC").Limit(8).Scan(&alertRows)
		recentAlerts := make([]gin.H, 0, len(alertRows))
		for _, r := range alertRows {
			recentAlerts = append(recentAlerts, gin.H{
				"severity": "critical",
				"title":    r.Hostname + " → " + r.Target + " failed",
				"detail":   r.Type,
				"at":       r.ReportedAt.UTC().Format(time.RFC3339),
			})
		}

		c.JSON(http.StatusOK, gin.H{
			"range":   rangeStr,
			"devices": devices,
			"agents":  gin.H{"total": agTotal, "online": agOnline, "offline": agOffline, "revoked": agRevoked},
			"probes": gin.H{
				"window_runs":      windowRuns,
				"window_failed":    windowFailed,
				"failure_rate_pct": failureRate,
				"delta_pct":        deltaPct,
			},
			"probe_series":  series,
			"sparklines":    gin.H{"probes": sparkProbes, "failure": sparkFailure, "devices": []int64{}, "agents": []int64{}},
			"region_health": regions,
			"recent_alerts": recentAlerts,
			"alerts": gin.H{
				"open_total": int64(len(recentAlerts)) + agOffline,
				"critical":   int64(len(recentAlerts)),
				"warning":    agOffline,
			},
		})
	}
}

// RegisterOverviewRoutes 注册 NOC 看板聚合端点。任何已登录用户可访问（只读），
// 与 probe-results 读路由一致，不要求管理员。
func RegisterOverviewRoutes(r *gin.Engine, db *gorm.DB, authMW gin.HandlerFunc) {
	g := r.Group("/api/v1/overview")
	g.Use(authMW)
	{
		g.GET("", GetOverview(db))
	}
}
