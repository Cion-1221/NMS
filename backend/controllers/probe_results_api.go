package controllers

import (
	"database/sql"
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
// 每个 (agent_id, target) 组合只返回最新一条结果，直接查询千行级的 probe_latest_states
// 快照表，零热表聚合开销。与 ListProbeResults 共享同一套过滤参数（type 必填）。
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
			tx := db.Model(&models.ProbeLatestState{}).Where("type = ?", typeFilter)
			if agentID != "" {
				tx = tx.Where("agent_id = ?", agentID)
			}
			if targetExact != "" {
				tx = tx.Where("target = ?", targetExact)
			}
			if q != "" {
				agentSub := db.Model(&models.Agent{}).Select("agent_id").
					Where("agent_id LIKE ? OR hostname LIKE ?", "%"+q+"%", "%"+q+"%")
				tx = tx.Where("agent_id IN (?) OR target LIKE ?", agentSub, "%"+q+"%")
			}
			if successStr != "" {
				tx = tx.Where("success = ?", successStr == "true")
			}
			return tx
		}

		var total int64
		buildQuery().Count(&total)

		results := make([]models.ProbeLatestState, 0)
		buildQuery().Order("agent_id asc, reported_at desc").
			Offset((page - 1) * pageSize).Limit(pageSize).Find(&results)

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

// meshMatrixStaleWindow 矩阵只采纳这个时间窗内的结果。矩阵是"当前状态"视图，而
// "每对最新一条"对不再产生新结果的序列会一直停在最后一次结论上——对端下线、地址
// 变更、或某一族目标因自适应不再下发之后，那格 "v6 Failed" 会挂满整个保留期
// （默认 30 天）。24 小时远大于任何合理的 meshping 间隔，又足够让失效序列自然消失。
const meshMatrixStaleWindow = 24 * time.Hour

// GetMeshPingMatrix GET /api/v1/probe-results/meshping-matrix —— 将 meshping 结果
// 透视为 NxN 矩阵：行/列 = 当前非吊销 Agent，单元格结构为 {"v4": {...}, "v6": {...}}。
// 直接读取 probe_latest_states 快照表，无需扫描历史热表。
func GetMeshPingMatrix(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		since := time.Now().Add(-meshMatrixStaleWindow)
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

		rows := make([]meshPingLatestRow, 0)
		db.Model(&models.ProbeLatestState{}).
			Select("agent_id, target, success, latency_ms, reported_at").
			Where("type = ? AND reported_at >= ?", "meshping", since).
			Scan(&rows)

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

// deleteProbeSeriesRollups 同步清理某条 (type, agent_id, target) 序列的快照与归档数据。
func deleteProbeSeriesRollups(db *gorm.DB, agentID, target, typeFilter string) {
	db.Where("type = ? AND agent_id = ? AND target = ?", typeFilter, agentID, target).
		Delete(&models.ProbeLatestState{})
	var series models.ProbeSeries
	if err := db.Where("type = ? AND agent_id = ? AND target = ?", typeFilter, agentID, target).
		First(&series).Error; err == nil {
		db.Where("series_id = ?", series.ID).Delete(&models.ProbeRollup{})
		db.Delete(&series)
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
		deleted, err := deleteProbeResultsChunked(db, "agent_id = ? AND target = ? AND type = ?", agentID, target, typeFilter)
		if err != nil {
			internalErr(c, http.StatusInternalServerError, "删除失败", err)
			return
		}
		deleteProbeSeriesRollups(db, agentID, target, typeFilter)
		// 与 PurgeProbeResults 同口径：管理员删数据必须留审计痕迹
		writeAgentAudit(db, getUsername(c), "delete_probe_pair", "probe_results", "",
			fmt.Sprintf("Deleted probe results for agent=%s target=%s type=%s (%d rows)", agentID, target, typeFilter, deleted))
		c.JSON(http.StatusOK, gin.H{"deleted": deleted})
	}
}

// GetProbeResultTargets GET /api/v1/probe-results/targets?type=X[&agent_id=Y]
// 通用结果 Tab 的 Target 下拉候选：直接从 probe_latest_states 快照表取去重后的 target。
func GetProbeResultTargets(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		typeFilter := c.Query("type")
		if typeFilter == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 type 参数", "code": "bad_request"})
			return
		}
		q := db.Model(&models.ProbeLatestState{}).Where("type = ?", typeFilter)
		if v := c.Query("agent_id"); v != "" {
			q = q.Where("agent_id = ?", v)
		}
		// 显式初始化为空切片，避免 nil 序列化成 JSON null
		targets := make([]string, 0)
		q.Distinct().Order("target ASC").Pluck("target", &targets)
		c.JSON(http.StatusOK, gin.H{"targets": targets})
	}
}

// probeResultPairsMax：一次批量删除最多接受的 (agent_id, target) 组合数，与列表
// 单页上限（page_size ≤ 200）对齐——前端的多选/全选是页级的。
const probeResultPairsMax = 200

// DeleteProbeResultPairs POST /api/v1/probe-results/pairs/bulk-delete —— 批量版
// DeleteProbeResultPair（管理员专用）。请求体 {type, pairs:[{agent_id,target}]}。
// 顺序逐对删除而不是让前端并发打单条接口：并发 DELETE 同一张热表会互相等锁甚至
// 死锁（见 deleteProbeResultsChunked 的说明），串行 + 分片对上报写入最友好。
// 单对失败不中断其余组合，最后汇总 deleted / failed。
// 异步执行（同 PurgeProbeResults）：立即返回 202 {job_id}，进度按组合数计。
func DeleteProbeResultPairs(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Type  string `json:"type" binding:"required"`
			Pairs []struct {
				AgentID string `json:"agent_id" binding:"required"`
				Target  string `json:"target" binding:"required"`
			} `json:"pairs" binding:"required,min=1,dive"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error(), "code": "bad_request"})
			return
		}
		if len(req.Pairs) > probeResultPairsMax {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": fmt.Sprintf("单次最多删除 %d 个组合", probeResultPairsMax),
				"code":  "bad_request",
			})
			return
		}

		user := getUsername(c) // gin.Context 不能带进 goroutine，先取出来
		pairs := req.Pairs
		typeFilter := req.Type

		job, started := probeJobs.start("bulk_delete", user,
			func(j *probeJob) { j.PairsTotal = len(pairs) },
			func(update func(func(*probeJob))) error {
				var deleted int64
				failed := 0
				var firstErr error
				for _, p := range pairs {
					n, err := deleteProbeResultsChunkedProgress(db, func(rows int64) {
						update(func(j *probeJob) { j.DeletedRows += rows })
					}, "agent_id = ? AND target = ? AND type = ?", p.AgentID, p.Target, typeFilter)
					deleted += n
					if err != nil {
						failed++
						if firstErr == nil {
							firstErr = err
						}
					} else {
						deleteProbeSeriesRollups(db, p.AgentID, p.Target, typeFilter)
					}
					update(func(j *probeJob) { j.PairsDone++ })
				}
				// 与单条删除同口径：管理员删数据必须留审计痕迹
				writeAgentAudit(db, user, "delete_probe_pairs", "probe_results", "",
					fmt.Sprintf("Bulk deleted probe results for %d pair(s) type=%s (%d rows, %d failed)",
						len(pairs), typeFilter, deleted, failed))
				if failed > 0 {
					return fmt.Errorf("%d 个组合删除失败: %s", failed, firstErr.Error())
				}
				return nil
			})
		if !started {
			c.JSON(http.StatusConflict, gin.H{"error": "已有清理/删除任务正在运行", "code": "probe.job_running", "job_id": job.ID})
			return
		}
		c.JSON(http.StatusAccepted, gin.H{"job_id": job.ID})
	}
}

// probeResultsPurgeChunk：单次 DELETE 语句最多删除的行数。probe_results 是持续
// 高频写入的热表，一条不设上限的 DELETE 在千万级表上要跑几十秒甚至更久，期间
// 持有的行锁/gap 锁会跟并发的 Agent 上报 INSERT 互相等待，轻则把整个请求拖到
// 客户端超时（前端显示"请求失败"，其实后端仍在正常执行），重则直接死锁
// （MySQL/MariaDB 错误 1213）。分片删除让每个事务尽量短，分片之间主动让出一小段
// 时间片给并发事务insert，大幅降低这两种情况的概率。
const probeResultsPurgeChunk = 5000

// deleteProbeResultsChunked 按 probeResultsPurgeChunk 分片删除 probe_results，
// 命中死锁（MySQL/MariaDB 1213，官方文档就是建议应用层捕获后重试）时退避重试
// 几次；其余错误直接返回，不做无意义重试。cond 为空字符串表示删除全表（仍走
// 分片，不需要 AllowGlobalUpdate）。
func deleteProbeResultsChunked(db *gorm.DB, cond string, args ...interface{}) (int64, error) {
	return deleteProbeResultsChunkedProgress(db, nil, cond, args...)
}

// deleteProbeResultsChunkedProgress 同 deleteProbeResultsChunked，每删完一片回调
// 一次 progress(本片行数)，供异步维护任务（probe_jobs.go）上报进度；可传 nil。
func deleteProbeResultsChunkedProgress(db *gorm.DB, progress func(rows int64), cond string, args ...interface{}) (int64, error) {
	const maxRetries = 5
	var total int64
	for {
		var affected int64
		var lastErr error
		for attempt := 0; attempt < maxRetries; attempt++ {
			affected, lastErr = deleteProbeResultsChunkOnce(db, cond, args...)
			if lastErr == nil || !isRetryableLockErr(lastErr) {
				break
			}
			time.Sleep(time.Duration(200*(attempt+1)) * time.Millisecond)
		}
		if lastErr != nil {
			return total, lastErr
		}
		total += affected
		if progress != nil && affected > 0 {
			progress(affected)
		}
		if affected < probeResultsPurgeChunk {
			return total, nil
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// deleteProbeResultsChunkOnce 执行一片删除。每次调用都从根 db 重新构建语句，并放在
// 独立的 READ COMMITTED 事务里：
//   - gorm 链式对象执行过一次之后带着 Error 和已结束的事务状态，复用它重试不会再
//     执行 SQL，只会每次追加一条 "invalid transaction"——此前的死锁重试就是这样
//     失效的（日志形如 "Deadlock found …; invalid transaction; invalid transaction…"）；
//   - REPEATABLE READ 下按索引区间扫描的 DELETE 会对区间加 gap 锁，与并发的 Agent
//     上报 INSERT 互相等待，这正是 1213 的主要来源；READ COMMITTED 只锁命中的行。
//     清理的是历史点，不需要可重复读语义。
func deleteProbeResultsChunkOnce(db *gorm.DB, cond string, args ...interface{}) (int64, error) {
	tx := db.Begin(&sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if tx.Error != nil {
		return 0, tx.Error
	}
	q := tx
	if cond != "" {
		q = q.Where(cond, args...)
	} else {
		// 全表清空也分片进行；gorm 要求 Delete 必须带 WHERE，用恒真条件代替 AllowGlobalUpdate
		q = q.Where("1 = 1")
	}
	res := q.Limit(probeResultsPurgeChunk).Delete(&models.ProbeResult{})
	if res.Error != nil {
		tx.Rollback()
		return 0, res.Error
	}
	if err := tx.Commit().Error; err != nil {
		return 0, err
	}
	return res.RowsAffected, nil
}

// PurgeProbeResults DELETE /api/v1/probe-results?days=N —— 手动清理探测结果（管理员专用）。
// days=0 清空全部；days>0 清理 N 天前的数据。与 PurgeAuditLogs / PurgeDeviceAuditLogs 同款语义。
//
// 异步执行：立即返回 202 {job_id}，删除在后台分片进行，前端轮询
// GET /probe-results/jobs/:id 展示进度（见 probe_jobs.go）。已有维护任务在跑时
// 返回 409 probe.job_running 并附带该任务的 job_id，前端直接挂到它的进度上。
func PurgeProbeResults(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		daysStr := c.DefaultQuery("days", "")
		days, err := strconv.Atoi(daysStr)
		if err != nil || days < 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的 days 参数（0 = 全部清空，正整数 = 清理 N 天前的数据）", "code": "bad_request"})
			return
		}
		// 条件在 goroutine 外定死：cond 为空 = 全表
		var cutoff time.Time
		cond, args := "", []interface{}{}
		if days > 0 {
			cutoff = time.Now().AddDate(0, 0, -days)
			cond, args = "reported_at < ?", []interface{}{cutoff}
		}
		user := getUsername(c) // gin.Context 不能带进 goroutine，先取出来

		job, started := probeJobs.start("purge", user,
			func(j *probeJob) { j.Status = probeJobCounting },
			func(update func(func(*probeJob))) error {
				// 先统计待删行数用于进度百分比：按天走 reported_at 索引，全表则是 COUNT(*)
				var total int64
				cq := db.Model(&models.ProbeResult{})
				if cond != "" {
					cq = cq.Where(cond, args...)
				}
				cq.Count(&total)
				update(func(j *probeJob) {
					j.TotalRows = total
					j.Status = probeJobRunning
				})

				deleted, delErr := deleteProbeResultsChunkedProgress(db, func(n int64) {
					update(func(j *probeJob) { j.DeletedRows += n })
				}, cond, args...)
				if delErr == nil {
					if days == 0 {
						db.Where("1 = 1").Delete(&models.ProbeLatestState{})
						db.Where("1 = 1").Delete(&models.ProbeRollup{})
						db.Where("1 = 1").Delete(&models.ProbeSeries{})
					} else {
						db.Where("reported_at < ?", cutoff).Delete(&models.ProbeLatestState{})
					}
				}
				detail := fmt.Sprintf("Purged probe results (days=%d, deleted=%d rows)", days, deleted)
				if delErr != nil {
					detail += " — FAILED: " + delErr.Error()
				}
				writeAgentAudit(db, user, "purge_probe_results", "probe_results", "", detail)
				return delErr
			})
		if !started {
			c.JSON(http.StatusConflict, gin.H{"error": "已有清理/删除任务正在运行", "code": "probe.job_running", "job_id": job.ID})
			return
		}
		c.JSON(http.StatusAccepted, gin.H{"job_id": job.ID})
	}
}

// ── 延迟趋势序列 ─────────────────────────────────────────────────────────────

// latencyBucketRow 是延迟序列聚合 SQL 的扫描目标（原始表与归档表共用）。
type latencyBucketRow struct {
	Ts     int64
	LatSum float64
	LatCnt int64
	MinMs  *float64
	MaxMs  *float64
	Runs   int64
	Failed int64
}

// latencySeriesMaxPoints 单次响应的目标显示点数上限（显示桶按此自适应放大）。
const latencySeriesMaxPoints = 500

// GetLatencySeries GET /api/v1/probe-results/latency-series
// ?agent_id=&target=&type=&start=&end=（RFC3339，end 缺省为当前时间，start 缺省为 end-1h）
//
// 数据源自动选择（Cacti/RRD 同款语义，整窗单一数据源）：
//  1. 窗口起点落在原始保留期内且窗口 ≤ 45 天 → 查原始表，分桶下限 = 任务 Interval；
//  2. 否则选择保留期能覆盖起点的最细归档层，显示桶为该层桶的整数倍。
//
// 归档桶存的是 lat_sum/lat_cnt，跨粒度重聚合用 SUM(sum)/SUM(cnt) 精确计算。
func GetLatencySeries(db *gorm.DB, rc RetentionConfig) gin.HandlerFunc {
	return func(c *gin.Context) {
		agentID := c.Query("agent_id")
		target := c.Query("target")
		typeFilter := c.Query("type")
		if agentID == "" || target == "" || typeFilter == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "缺少必要参数 agent_id / target / type", "code": "bad_request"})
			return
		}

		end := time.Now()
		if v := c.Query("end"); v != "" {
			t, err := time.Parse(time.RFC3339, v)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "无效的 end 时间格式（需 RFC3339）", "code": "bad_request"})
				return
			}
			end = t
		}
		start := end.Add(-time.Hour)
		if v := c.Query("start"); v != "" {
			t, err := time.Parse(time.RFC3339, v)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "无效的 start 时间格式（需 RFC3339）", "code": "bad_request"})
				return
			}
			start = t
		}
		if !start.Before(end) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "start 必须早于 end", "code": "bad_request"})
			return
		}
		windowSec := int64(end.Sub(start).Seconds())

		// 该序列的任务 Interval（原始点粒度）：取最近一条结果反查任务，回退 60s
		intervalSec := 60
		var latest models.ProbeResult
		if err := db.Select("task_id").
			Where("type = ? AND agent_id = ? AND target = ?", typeFilter, agentID, target).
			Order("reported_at desc").Limit(1).First(&latest).Error; err == nil && latest.TaskID != nil {
			var task models.AgentTask
			if err := db.Select("interval_seconds").First(&task, *latest.TaskID).Error; err == nil && task.IntervalSeconds > 0 {
				intervalSec = task.IntervalSeconds
			}
		}

		// ── 选源 ──
		// 未配置归档层时无条件走原始表（超出保留期的部分自然为空，不会 panic 于空层列表）。
		// 留 1 小时余量容忍前后端时钟微差与日常清理边界（原先减 1 整天会导致 8 天保留期下
		// 点 7D 预设直接跌落到归档表，甚至保留期为 1 天时 1H 预设都无法命中原始表）。
		rawCovers := rc.ProbeResultsMaxAgeDays == 0 ||
			start.After(time.Now().AddDate(0, 0, -rc.ProbeResultsMaxAgeDays).Add(time.Hour))
		useRaw := len(rc.Rollups) == 0 || (rawCovers && windowSec <= 45*86400)

		var rows []latencyBucketRow
		source := "raw"
		sourceBucket := intervalSec

		if useRaw {
			displayBucket := alignBucket(windowSec, int64(intervalSec))
			db.Raw(`
				SELECT CAST(FLOOR(UNIX_TIMESTAMP(reported_at)/?)*? AS SIGNED) AS ts,
					COALESCE(SUM(CASE WHEN success = 1 THEN latency_ms END), 0) AS lat_sum,
					COUNT(CASE WHEN success = 1 THEN latency_ms END) AS lat_cnt,
					MIN(CASE WHEN success = 1 THEN latency_ms END) AS min_ms,
					MAX(CASE WHEN success = 1 THEN latency_ms END) AS max_ms,
					COUNT(*) AS runs,
					CAST(SUM(success = 0) AS SIGNED) AS failed
				FROM probe_results
				WHERE type = ? AND agent_id = ? AND target = ? AND reported_at >= ? AND reported_at < ?
				GROUP BY ts ORDER BY ts`,
				displayBucket, displayBucket, typeFilter, agentID, target, start, end).Scan(&rows)
			sourceBucket = int(displayBucket)
		} else {
			// 选择保留期能覆盖起点的最细归档层（带 1 小时容差防止预设刚好卡在边界掉层）；
			// 都覆盖不了则用最粗层（尽力返回现存数据）
			tier := rc.Rollups[len(rc.Rollups)-1]
			for _, t := range rc.Rollups {
				if start.After(time.Now().AddDate(0, 0, -t.MaxAgeDays).Add(-time.Hour)) {
					tier = t
					break
				}
			}
			source = "rollup"
			tierSec := int64(tier.BucketMinutes) * 60
			displayBucket := alignBucket(windowSec, tierSec)
			sourceBucket = int(displayBucket)

			var series models.ProbeSeries
			if err := db.Where("type = ? AND agent_id = ? AND target = ?", typeFilter, agentID, target).
				First(&series).Error; err == nil {
				db.Raw(`
					SELECT CAST(FLOOR(bucket_ts/?)*? AS SIGNED) AS ts,
						SUM(lat_sum) AS lat_sum,
						SUM(lat_cnt) AS lat_cnt,
						MIN(CASE WHEN lat_cnt > 0 THEN min_ms END) AS min_ms,
						MAX(CASE WHEN lat_cnt > 0 THEN max_ms END) AS max_ms,
						SUM(runs) AS runs,
						SUM(failed) AS failed
					FROM probe_rollups
					WHERE series_id = ? AND bucket_seconds = ? AND bucket_ts >= ? AND bucket_ts < ?
					GROUP BY ts ORDER BY ts`,
					displayBucket, displayBucket, series.ID, tierSec, start.Unix(), end.Unix()).Scan(&rows)
			}

			// 尾部实时补齐：后台归档周期之间（或新序列首次归档前）最新几分钟的数据尚在
			// probe_results 中，用原始表补齐最后一个显示桶及之后的尾段，确保图表右端实时不断档。
			tailFrom := start
			if len(rows) > 0 {
				lastBucketStart := time.Unix(rows[len(rows)-1].Ts, 0)
				if lastBucketStart.After(tailFrom) {
					tailFrom = lastBucketStart
				}
			}
			var tailRows []latencyBucketRow
			db.Raw(`
				SELECT CAST(FLOOR(UNIX_TIMESTAMP(reported_at)/?)*? AS SIGNED) AS ts,
					COALESCE(SUM(CASE WHEN success = 1 THEN latency_ms END), 0) AS lat_sum,
					COUNT(CASE WHEN success = 1 THEN latency_ms END) AS lat_cnt,
					MIN(CASE WHEN success = 1 THEN latency_ms END) AS min_ms,
					MAX(CASE WHEN success = 1 THEN latency_ms END) AS max_ms,
					COUNT(*) AS runs,
					CAST(SUM(success = 0) AS SIGNED) AS failed
				FROM probe_results
				WHERE type = ? AND agent_id = ? AND target = ? AND reported_at >= ? AND reported_at < ?
				GROUP BY ts ORDER BY ts`,
				displayBucket, displayBucket, typeFilter, agentID, target, tailFrom, end).Scan(&tailRows)
			if len(tailRows) > 0 {
				if len(rows) > 0 && rows[len(rows)-1].Ts >= tailRows[0].Ts {
					rows = rows[:len(rows)-1]
				}
				rows = append(rows, tailRows...)
			}
		}

		// ── 组装响应 + 窗口汇总 ──
		points := make([]gin.H, 0, len(rows))
		var sumLat float64
		var cntLat, totalRuns, totalFailed int64
		var winMin, winMax *float64
		for _, r := range rows {
			var avg *float64
			if r.LatCnt > 0 {
				v := r.LatSum / float64(r.LatCnt)
				avg = &v
			}
			points = append(points, gin.H{
				"ts": r.Ts, "avg_ms": avg, "min_ms": r.MinMs, "max_ms": r.MaxMs,
				"runs": r.Runs, "failed": r.Failed,
			})
			sumLat += r.LatSum
			cntLat += r.LatCnt
			totalRuns += r.Runs
			totalFailed += r.Failed
			if r.MinMs != nil && (winMin == nil || *r.MinMs < *winMin) {
				winMin = r.MinMs
			}
			if r.MaxMs != nil && (winMax == nil || *r.MaxMs > *winMax) {
				winMax = r.MaxMs
			}
		}
		var summary gin.H
		if totalRuns > 0 {
			var avg *float64
			if cntLat > 0 {
				v := sumLat / float64(cntLat)
				avg = &v
			}
			summary = gin.H{
				"avg_ms": avg, "min_ms": winMin, "max_ms": winMax,
				"runs": totalRuns, "failed": totalFailed,
				"loss_pct": float64(totalFailed) / float64(totalRuns) * 100,
			}
		}

		c.JSON(http.StatusOK, gin.H{
			"source":                source,
			"source_bucket_seconds": sourceBucket,
			"interval_seconds":      intervalSec,
			"points":                points,
			"summary":               summary,
		})
	}
}

// alignBucket 计算显示桶：以 granularity（Interval 或归档层桶）为最小单位，
// 向上对齐到能把窗口压进 latencySeriesMaxPoints 个点的整数倍。
func alignBucket(windowSec, granularity int64) int64 {
	if granularity < 1 {
		granularity = 60
	}
	bucket := windowSec / latencySeriesMaxPoints
	if bucket < granularity {
		return granularity
	}
	// 向上取整到 granularity 的整数倍
	return (bucket + granularity - 1) / granularity * granularity
}

// RegisterProbeResultsRoutes 挂载到主 JWT 引擎，仅需登录（与 IPAM/Devices 同等级别）——
// 监控结果查看不属于安全敏感操作，不要求管理员权限。清理接口额外要求管理员权限。
func RegisterProbeResultsRoutes(r *gin.Engine, db *gorm.DB, authMW gin.HandlerFunc, rc RetentionConfig) {
	pr := r.Group("/api/v1/probe-results")
	pr.Use(authMW)
	{
		pr.GET("", ListProbeResults(db))
		pr.GET("/latest", GetLatestProbeResults(db))
		pr.GET("/meshping-matrix", GetMeshPingMatrix(db))
		pr.GET("/latency-series", GetLatencySeries(db, rc))
		pr.GET("/targets", GetProbeResultTargets(db))
	}

	prAdmin := r.Group("/api/v1/probe-results")
	prAdmin.Use(authMW, middleware.AdminRequired)
	{
		prAdmin.DELETE("", PurgeProbeResults(db))
		prAdmin.DELETE("/pair", DeleteProbeResultPair(db))
		prAdmin.POST("/pairs/bulk-delete", DeleteProbeResultPairs(db))
		prAdmin.GET("/jobs/:id", GetProbeJob) // :id = current 时返回正在运行的任务
	}
}
