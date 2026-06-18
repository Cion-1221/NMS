package controllers

import (
	"log/slog"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"nms-backend/core"
	"nms-backend/middleware"
	"nms-backend/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// onlineThreshold：超过该时长未通过 mTLS 调用刷新心跳的 Agent 不再视为"存活"，
// 不会被纳入 MeshPing 目标列表。
const onlineThreshold = 5 * time.Minute

// taskPayload 是下发给 Agent 的单条任务结构。
type taskPayload struct {
	TaskID          uint     `json:"task_id"`
	Type            string   `json:"type"`
	IntervalSeconds int      `json:"interval_seconds"`
	Targets         []string `json:"targets"`
}

// GetAgentTasks GET /api/v1/agent-sync/tasks
// mTLS 校验已由 AgentMTLS 中间件完成并将 Agent 记录注入 context。
// 组装该 Agent 当前生效的任务列表：全局任务 + 所属 Group 任务 + 专属任务；
// meshping 任务的目标列表动态替换为同组存活 Agent 的 IP。
func GetAgentTasks(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		agent := middleware.GetAgent(c)
		if agent == nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "未认证"})
			return
		}

		q := db.Model(&models.AgentTask{}).Where("enabled = ?", true)
		if agent.GroupID != nil {
			q = q.Where(
				"scope = ? OR (scope = ? AND group_id = ?) OR (scope = ? AND agent_id = ?)",
				"global", "group", *agent.GroupID, "agent", agent.AgentID,
			)
		} else {
			// 未分组 Agent 不可能命中按组下发的任务，跳过 group_id 条件避免 NULL 比较歧义。
			q = q.Where("scope = ? OR (scope = ? AND agent_id = ?)", "global", "agent", agent.AgentID)
		}
		var tasks []models.AgentTask
		q.Order("id asc").Find(&tasks)

		payloads := make([]taskPayload, 0, len(tasks))
		for _, t := range tasks {
			targets := t.Targets()
			if t.Type == "meshping" {
				targets = resolveMeshPingTargets(db, agent, t)
			}
			payloads = append(payloads, taskPayload{
				TaskID: t.ID, Type: t.Type, IntervalSeconds: t.IntervalSeconds, Targets: targets,
			})
		}

		var sourceIP, sourceIPv4, sourceIPv6 *string
		if agent.SourceIPOverride != nil && *agent.SourceIPOverride != "" {
			sourceIP = agent.SourceIPOverride
			for _, part := range strings.SplitN(*agent.SourceIPOverride, "/", 2) {
				part = strings.TrimSpace(part)
				if a, err := netip.ParseAddr(part); err == nil {
					s := a.String()
					if a.Is4() {
						sourceIPv4 = &s
					} else {
						sourceIPv6 = &s
					}
				}
			}
		}

		c.JSON(http.StatusOK, gin.H{
			"agent_id":    agent.AgentID,
			"source_ip":   sourceIP,   // raw stored value (backward compat)
			"source_ipv4": sourceIPv4, // parsed IPv4 component
			"source_ipv6": sourceIPv6, // parsed IPv6 component
			"tasks":       payloads,
		})
	}
}

// resolveMeshPingTargets 查询其他"存活"（LastSeenAt 在 onlineThreshold 内、未被吊销）
// Agent 的可达 IP，作为 MeshPing 目标列表（排除自身）。
//
// IP 优先级（每个 peer 独立计算）：
//  1. source_ip_override（管理员手动，支持单 IP 或 "ipv4 / ipv6" 双栈格式）
//  2. connection_ipv4 + connection_ipv6（自动追踪，有哪个发哪个）
//  3. connection_ip（兜底：旧数据或尚未更新的 agent）
//
// scope=group：仅限任务指定 Group 内的成员。
// scope=global / scope=agent：所有存活 Agent（无 group 过滤）。
func resolveMeshPingTargets(db *gorm.DB, self *models.Agent, task models.AgentTask) []string {
	q := db.Where("agent_id <> ? AND revoked = ?", self.AgentID, false).
		Where("last_seen_at > ?", time.Now().Add(-onlineThreshold))

	if task.Scope == "group" {
		if task.GroupID == nil {
			return []string{}
		}
		q = q.Where("group_id = ?", *task.GroupID)
	}

	var peers []models.Agent
	q.Find(&peers)

	targets := make([]string, 0, len(peers)*2)
	for _, p := range peers {
		if p.SourceIPOverride != nil && *p.SourceIPOverride != "" {
			// 管理员手动优先：支持单 IP 或 "ipv4 / ipv6" 双栈格式
			for _, part := range strings.SplitN(*p.SourceIPOverride, "/", 2) {
				if part = strings.TrimSpace(part); part != "" {
					targets = append(targets, part)
				}
			}
		} else if p.ConnectionIPv4 != "" || p.ConnectionIPv6 != "" {
			// 自动追踪的双栈地址：有哪个发哪个，agent 自行处理不可达
			if p.ConnectionIPv4 != "" {
				targets = append(targets, p.ConnectionIPv4)
			}
			if p.ConnectionIPv6 != "" {
				targets = append(targets, p.ConnectionIPv6)
			}
		} else if p.ConnectionIP != "" {
			targets = append(targets, p.ConnectionIP)
		}
	}
	return targets
}

// ── 结果上报 ───────────────────────────────────────────────────────────────

type probeResultIn struct {
	TaskID    *uint    `json:"task_id"`
	Type      string   `json:"type" binding:"required"`
	Target    string   `json:"target" binding:"required"`
	Success   bool     `json:"success"`
	LatencyMs *float64 `json:"latency_ms"`
	Detail    string   `json:"detail"`
}

// PostAgentResults POST /api/v1/agent-sync/results —— 批量写入探测结果。
func PostAgentResults(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		agent := middleware.GetAgent(c)
		if agent == nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "未认证"})
			return
		}
		var req struct {
			Results []probeResultIn `json:"results" binding:"required,dive"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error()})
			return
		}

		now := time.Now()
		rows := make([]models.ProbeResult, 0, len(req.Results))
		for _, r := range req.Results {
			rows = append(rows, models.ProbeResult{
				AgentID: agent.AgentID, TaskID: r.TaskID, Type: r.Type, Target: r.Target,
				Success: r.Success, LatencyMs: r.LatencyMs, Detail: r.Detail, ReportedAt: now,
			})
		}
		if len(rows) > 0 {
			if err := db.Create(&rows).Error; err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "写入结果失败: " + err.Error()})
				return
			}
		}
		c.JSON(http.StatusOK, gin.H{"received": len(rows)})
	}
}

// RenewAgentCert POST /api/v1/agent-sync/renew-cert —— 证书续期。
// 调用方已通过 mTLS 证明自己持有一张当前仍有效（未过期、未被吊销）的客户端证书，
// 因此续期无需再走一次性 token：直接用同一个 AgentID 重新签发一张新证书，更新
// CertSerial/CertExpiry。语义上类似 Refresh Token——用一个仍有效的凭证换一个新的，
// 而不要求证书快到期才允许续期（旧证书在新证书签发后仍然有效，直到自然过期或被
// 显式吊销；多次续期不构成安全弱化，因为每次续期都需要先通过 mTLS 校验）。
func RenewAgentCert(db *gorm.DB, pki *core.PKI, clientCertDays int) gin.HandlerFunc {
	return func(c *gin.Context) {
		agent := middleware.GetAgent(c)
		if agent == nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "未认证"})
			return
		}
		issued, err := pki.IssueClientCert(agent.AgentID, clientCertDays)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "签发证书失败: " + err.Error()})
			return
		}
		if err := db.Model(agent).Updates(map[string]interface{}{
			"cert_serial": issued.Serial, "cert_expiry": issued.Expiry,
		}).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "更新证书记录失败: " + err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"agent_id":    agent.AgentID,
			"cert_pem":    string(issued.CertPEM),
			"key_pem":     string(issued.KeyPEM),
			"ca_cert_pem": string(pki.CACertPEM()),
			"cert_expiry": issued.Expiry,
		})
	}
}

// StartAgentOfflineSweeper 启动后台任务：周期性把超过 onlineThreshold 仍未刷新心跳
// 的 Agent 从 online 翻转为 offline。AgentMTLS 中间件只负责"标记上线"，没有这个
// sweeper 的话，一台失联的 Agent 会在 Agent List 里永久显示为 online。
func StartAgentOfflineSweeper(db *gorm.DB) {
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			result := db.Model(&models.Agent{}).
				Where("status = ? AND (last_seen_at IS NULL OR last_seen_at < ?)", "online", time.Now().Add(-onlineThreshold)).
				Update("status", "offline")
			if result.Error != nil {
				slog.Error("Agent 离线状态扫描失败", "err", result.Error)
			} else if result.RowsAffected > 0 {
				slog.Info("Agent 离线状态扫描完成", "marked_offline", result.RowsAffected)
			}
			<-ticker.C
		}
	}()
}

// RegisterAgentSyncRoutes 挂载到独立的 sync mTLS 引擎（tls.RequireAndVerifyClientCert）。
func RegisterAgentSyncRoutes(r *gin.Engine, db *gorm.DB, pki *core.PKI, clientCertDays int) {
	sync := r.Group("/api/v1/agent-sync")
	sync.Use(middleware.AgentMTLS(db))
	{
		sync.GET("/tasks", GetAgentTasks(db))
		sync.POST("/results", PostAgentResults(db))
		sync.POST("/renew-cert", RenewAgentCert(db, pki, clientCertDays))
	}
}
