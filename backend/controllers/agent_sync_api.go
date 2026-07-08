package controllers

import (
	"log/slog"
	"net/http"
	"net/netip"
	"os"
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
// SNMP 字段仅 snmp_poll 类型携带（omitempty），旧版 Agent 解析不受影响。
type taskPayload struct {
	TaskID          uint            `json:"task_id"`
	Type            string          `json:"type"`
	IntervalSeconds int             `json:"interval_seconds"`
	Targets         []string        `json:"targets"`
	SNMP            *snmpTaskParams `json:"snmp,omitempty"`
}

// snmpTaskParams 是 snmp_poll 任务的参数块。凭证经 mTLS 信道以明文下发（静态
// 加密只作用于库内存储；安全性等同现有任务体系），Agent 端只在内存持有、不落盘。
type snmpTaskParams struct {
	DeviceID        uint     `json:"device_id"`
	Version         string   `json:"version"` // 1 / 2c / 3
	Community       string   `json:"community,omitempty"`
	Port            int      `json:"port"`
	TimeoutSeconds  int      `json:"timeout_seconds"`
	Retries         int      `json:"retries"`
	InventoryEveryN int      `json:"inventory_every_n"` // 每 N 次快轮询附带完整 system 组
	V3User          string   `json:"v3_user,omitempty"` // ── SNMPv3（USM）──
	V3AuthProto     string   `json:"v3_auth_proto,omitempty"`
	V3AuthPass      string   `json:"v3_auth_pass,omitempty"`
	V3PrivProto     string   `json:"v3_priv_proto,omitempty"`
	V3PrivPass      string   `json:"v3_priv_pass,omitempty"`
	ExtraOIDs       []string `json:"extra_oids,omitempty"`         // 自定义标量 OID，随每次快轮询一并 GET
	CollectIfaces   bool     `json:"collect_interfaces,omitempty"` // 每周期 WALK ifTable/ifXTable
}

// snmpTaskIDBase：合成任务的虚拟 TaskID 偏移。snmp_poll 任务不存在于 agent_tasks
// 表（从 devices 表即时合成，见 resolveSNMPPollTasks），但 Agent 端调度器按 task_id
// 整数做 goroutine reconcile，必须全局唯一——真实 AgentTask 自增 ID 不可能达到 2^30，
// 用 1<<30 + device_id 保证两个命名空间永不冲突。
const snmpTaskIDBase = 1 << 30

// GetAgentTasks GET /api/v1/agent-sync/tasks
// mTLS 校验已由 AgentMTLS 中间件完成并将 Agent 记录注入 context。
// 组装该 Agent 当前生效的任务列表：全局任务 + 所属 Group 任务 + 专属任务；
// meshping 任务的目标列表动态替换为同组存活 Agent 的 IP；此外附加从 devices 表
// 即时合成的 snmp_poll 任务（指派给本 Agent 的探针代理采集，见 resolveSNMPPollTasks）。
func GetAgentTasks(db *gorm.DB, snmpCfg SNMPConfig) gin.HandlerFunc {
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
			if t.Type == "meshping" || t.Type == "meshmtr" {
				// meshmtr 与 meshping 使用完全相同的目标解析逻辑：
				// 自动枚举同组存活 Agent 的 IP，agent 侧负责具体的探测方式。
				targets = resolveMeshPingTargets(db, agent, t)
			}
			payloads = append(payloads, taskPayload{
				TaskID: t.ID, Type: t.Type, IntervalSeconds: t.IntervalSeconds, Targets: targets,
			})
		}

		// SNMP 探针代理任务：从 devices 表即时合成（devices 即真源，改配置/换探针
		// 无需同步任何任务记录，下个同步周期自动生效——与 meshping 动态解析同思路）
		if snmpCfg.Enabled {
			payloads = append(payloads, resolveSNMPPollTasks(db, agent, snmpCfg)...)
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

		// 检查该 Agent OS+Arch 是否有激活的可用更新（版本不同且文件已上传才下发）
		var updatePayload interface{}
		if agent.OS != "" && agent.Arch != "" {
			var rel models.AgentRelease
			if db.Where("os = ? AND arch = ? AND active = ?", agent.OS, agent.Arch, true).First(&rel).Error == nil {
				if rel.Version != agent.Version && rel.FilePath != "" {
					updatePayload = gin.H{
						"version":   rel.Version,
						"binary_id": rel.ID,
						"sha256":    rel.SHA256,
						"file_size": rel.FileSize,
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
			"update":      updatePayload, // nil = no update; non-nil = download and replace
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

// resolveSNMPPollTasks 为当前 Agent 合成 snmp_poll 任务列表：polling_mode='agent'
// 且 snmp_agent_id 指向本 Agent 的所有设备，每台一条。status 为 planned（未上架）
// 或 offline（已停用）的设备不采集。目标 IP 优先 IPv4，缺失时用 IPv6。
// 库内静态加密的凭证在此解封后随 mTLS 信道下发。
func resolveSNMPPollTasks(db *gorm.DB, agent *models.Agent, cfg SNMPConfig) []taskPayload {
	cfg.Normalize()
	var devices []models.Device
	db.Where("polling_mode = ? AND snmp_agent_id = ? AND status NOT IN ('planned','offline')", "agent", agent.AgentID).
		Order("id asc").Find(&devices)
	if len(devices) == 0 {
		return nil
	}

	// 一次性取出这批设备的全部自定义 OID，按设备分组
	ids := make([]uint, 0, len(devices))
	for _, d := range devices {
		ids = append(ids, d.ID)
	}
	var oidRows []models.DeviceSNMPOID
	db.Where("device_id IN ?", ids).Order("id asc").Find(&oidRows)
	oidsByDevice := make(map[uint][]string, len(devices))
	for _, r := range oidRows {
		oidsByDevice[r.DeviceID] = append(oidsByDevice[r.DeviceID], r.OID)
	}

	payloads := make([]taskPayload, 0, len(devices))
	for _, d := range devices {
		target := ""
		if d.ManagementIP != nil && *d.ManagementIP != "" {
			target = *d.ManagementIP
		} else if d.ManagementIPv6 != nil && *d.ManagementIPv6 != "" {
			target = *d.ManagementIPv6
		}
		if target == "" {
			continue // 无目标不下发（建库校验已挡住，这里防御脏数据）
		}
		params := &snmpTaskParams{
			DeviceID:        d.ID,
			Version:         d.SNMPVersion,
			Port:            d.SNMPPort,
			TimeoutSeconds:  cfg.TimeoutSeconds,
			Retries:         cfg.Retries,
			InventoryEveryN: cfg.InventoryEveryN,
			ExtraOIDs:       oidsByDevice[d.ID],
			CollectIfaces:   d.CollectInterfaces,
		}
		if d.SNMPVersion == "3" {
			if d.SNMPV3User == nil || *d.SNMPV3User == "" {
				continue // v3 无用户名不下发
			}
			params.V3User = *d.SNMPV3User
			if d.SNMPV3AuthProto != nil {
				params.V3AuthProto = *d.SNMPV3AuthProto
			}
			if d.SNMPV3PrivProto != nil {
				params.V3PrivProto = *d.SNMPV3PrivProto
			}
			if params.V3AuthProto != "" && d.SNMPV3AuthPass != nil {
				params.V3AuthPass = openSNMPSecret(cfg, d.ID, "v3_auth_pass", *d.SNMPV3AuthPass)
				if params.V3AuthPass == "" {
					continue // 解密失败不下发（日志已由 openSNMPSecret 记录）
				}
			}
			if params.V3PrivProto != "" && d.SNMPV3PrivPass != nil {
				params.V3PrivPass = openSNMPSecret(cfg, d.ID, "v3_priv_pass", *d.SNMPV3PrivPass)
				if params.V3PrivPass == "" {
					continue
				}
			}
		} else {
			params.Community = openSNMPSecret(cfg, d.ID, "community", d.SNMPCommunity)
			if params.Community == "" {
				continue // 无凭证/解密失败不下发
			}
		}
		interval := cfg.DefaultIntervalSeconds
		if d.SNMPIntervalSeconds != nil && *d.SNMPIntervalSeconds >= 10 {
			interval = *d.SNMPIntervalSeconds
		}
		payloads = append(payloads, taskPayload{
			TaskID:          snmpTaskIDBase + d.ID,
			Type:            "snmp_poll",
			IntervalSeconds: interval,
			Targets:         []string{target},
			SNMP:            params,
		})
	}
	return payloads
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

// ── SNMP 采集结果上报 ────────────────────────────────────────────────────────

// snmpResultIn 与 Agent 端 probe.SNMPResult 一一对应。
// CollectedAt（unix 秒）是 Agent 侧的采集时刻——批量上报会把同一设备的多个采集
// 点在几毫秒内先后送达，counter 速率换算必须以它为时间基准，不能用入库时刻。
type snmpResultIn struct {
	DeviceID      uint              `json:"device_id" binding:"required"`
	CollectedAt   int64             `json:"collected_at"`
	Success       bool              `json:"success"`
	ErrorKind     string            `json:"error_kind"`
	Error         string            `json:"error"`
	LatencyMs     *float64          `json:"latency_ms"`
	UptimeTicks   *int64            `json:"uptime_ticks"`
	HasInventory  bool              `json:"has_inventory"`
	SysName       string            `json:"sys_name"`
	SysDescr      string            `json:"sys_descr"`
	SysObjectID   string            `json:"sys_object_id"`
	SysLocation   string            `json:"sys_location"`
	SysContact    string            `json:"sys_contact"`
	Values        []snmpOIDValue    `json:"values"`         // 自定义 OID 采集值
	HasInterfaces bool              `json:"has_interfaces"` // WALK 明确成功才 reconcile 维表
	Interfaces    []snmpInterfaceIn `json:"interfaces"`
}

// PostAgentSNMPResults POST /api/v1/agent-sync/snmp-results —— 探针代理模式的
// SNMP 结论回传，不走 probe_results（那是延迟时序热表，SNMP 快照是状态语义）。
//
// 越权防御：每条结果必须命中"该设备当前确实以 agent 模式指派给调用方"才落库——
// 一台被攻陷的 Agent 只能影响指派给它的设备，无法伪造全网设备状态；配置刚被
// 管理员改走（换探针/关采集）时迟到的结果同样被丢弃。
func PostAgentSNMPResults(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		agent := middleware.GetAgent(c)
		if agent == nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "未认证"})
			return
		}
		var req struct {
			Results []snmpResultIn `json:"results" binding:"required,dive"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error()})
			return
		}

		accepted, rejected := 0, 0
		for _, r := range req.Results {
			var device models.Device
			err := db.Select("id").
				Where("id = ? AND polling_mode = ? AND snmp_agent_id = ?", r.DeviceID, "agent", agent.AgentID).
				Take(&device).Error
			if err != nil {
				rejected++
				continue
			}
			obs := snmpObservation{
				Success:       r.Success,
				ErrorKind:     r.ErrorKind,
				Error:         r.Error,
				LatencyMs:     r.LatencyMs,
				UptimeTicks:   r.UptimeTicks,
				HasInventory:  r.HasInventory,
				SysName:       r.SysName,
				SysDescr:      r.SysDescr,
				SysObjectID:   r.SysObjectID,
				SysLocation:   r.SysLocation,
				SysContact:    r.SysContact,
				Values:        r.Values,
				HasInterfaces: r.HasInterfaces,
				Interfaces:    r.Interfaces,
			}
			if r.CollectedAt > 0 {
				obs.CollectedAt = time.Unix(r.CollectedAt, 0)
			}
			applySNMPResult(db, r.DeviceID, &agent.AgentID, obs)
			accepted++
		}
		if rejected > 0 {
			slog.Warn("SNMP 结果部分被拒（设备未指派给该 Agent 或配置已变更）",
				"agent_id", agent.AgentID, "accepted", accepted, "rejected", rejected)
		}
		c.JSON(http.StatusOK, gin.H{"received": accepted, "rejected": rejected})
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

// GetMyIP GET /api/v1/agent-sync/my-ip —— 返回 server 所见的 agent TCP 来源 IP。
// Agent 通过强制 tcp4/tcp6 的 mTLS 客户端各调一次，即可得到双栈公网地址，穿透任何 NAT。
func GetMyIP(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"ip": c.ClientIP()})
}

// GetAgentBinary GET /api/v1/agent-sync/binary/:id —— 流式下发 Agent 二进制文件。
// 受 AgentMTLS 中间件保护：只有持有有效客户端证书的 Agent 才能下载。
func GetAgentBinary(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var rel models.AgentRelease
		if err := db.First(&rel, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "Release 不存在"})
			return
		}
		if rel.FilePath == "" {
			c.JSON(http.StatusNotFound, gin.H{"error": "文件未上传"})
			return
		}
		if _, err := os.Stat(rel.FilePath); os.IsNotExist(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "文件不存在（可能已被删除）"})
			return
		}
		c.FileAttachment(rel.FilePath, "nms-agent")
	}
}

// RegisterAgentSyncRoutes 挂载到独立的 sync mTLS 引擎（tls.RequireAndVerifyClientCert）。
func RegisterAgentSyncRoutes(r *gin.Engine, db *gorm.DB, pki *core.PKI, clientCertDays int, snmpCfg SNMPConfig) {
	sync := r.Group("/api/v1/agent-sync")
	sync.Use(middleware.AgentMTLS(db))
	{
		sync.GET("/tasks", GetAgentTasks(db, snmpCfg))
		sync.POST("/results", PostAgentResults(db))
		sync.POST("/snmp-results", PostAgentSNMPResults(db))
		sync.POST("/renew-cert", RenewAgentCert(db, pki, clientCertDays))
		sync.GET("/my-ip", GetMyIP)
		sync.GET("/binary/:id", GetAgentBinary(db))
	}
}
