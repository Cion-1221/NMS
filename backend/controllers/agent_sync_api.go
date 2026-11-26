package controllers

import (
	"context"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"sync"
	"time"

	"nms-backend/core"
	"nms-backend/middleware"
	"nms-backend/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// maxSyncBatchBytes Agent 结果上报请求体上限（32 MiB），防止异常大报文打爆内存。
const maxSyncBatchBytes = 32 << 20

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
	// SkipTLSVerify：仅 httpcheck 使用，其余类型 Agent 端忽略。
	SkipTLSVerify bool `json:"skip_tls_verify,omitempty"`
	// AddressFamily：域名 target 的解析地址族（v4/v6/both）；auto 时省略，
	// Agent 端把缺省视为 auto（跟随系统解析偏好），旧版 Agent 忽略此字段。
	AddressFamily string `json:"address_family,omitempty"`
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

// GetAgentTasks GET /api/v1/agent-sync/tasks（兼容无 PKI 注入的测试调用签名）。
func GetAgentTasks(db *gorm.DB, snmpCfg SNMPConfig) gin.HandlerFunc {
	return GetAgentTasksWithPKI(db, nil, snmpCfg)
}

// GetAgentTasksWithPKI GET /api/v1/agent-sync/tasks
// mTLS 校验已由 AgentMTLSWithPKI 中间件完成并将 Agent 记录与客户端证书注入 context。
// 除任务列表与 OTA 升级指令外，还随响应下发当前完整 CA 信任包（ca_bundle_pem）及按需续签标记
// （renew_cert），驱动三阶段平滑 CA 轮换中 Agent 自动热更新本地信任链与客户端证书。
func GetAgentTasksWithPKI(db *gorm.DB, pki *core.PKI, snmpCfg SNMPConfig) gin.HandlerFunc {
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
			fam := t.AddressFamily
			if fam == "auto" {
				fam = "" // 缺省即 auto，省流量且旧版 Agent 无感
			}
			payloads = append(payloads, taskPayload{
				TaskID: t.ID, Type: t.Type, IntervalSeconds: t.IntervalSeconds, Targets: targets,
				SkipTLSVerify: t.SkipTLSVerify, AddressFamily: fam,
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

		resp := gin.H{
			"agent_id":    agent.AgentID,
			"source_ip":   sourceIP,   // raw stored value (backward compat)
			"source_ipv4": sourceIPv4, // parsed IPv4 component
			"source_ipv6": sourceIPv6, // parsed IPv6 component
			"tasks":       payloads,
			"update":      updatePayload, // nil = no update; non-nil = download and replace
		}
		if pki != nil {
			resp["ca_bundle_pem"] = string(pki.CABundlePEM())
			if peerCert := middleware.GetAgentPeerCert(c); peerCert != nil && !pki.IsIssuedByActiveCA(peerCert) {
				resp["renew_cert"] = true
			}
		}

		c.JSON(http.StatusOK, resp)
	}
}

// stackFamilies 解析 agents.stack（"v4" / "v6" / "v4,v6"）。
func stackFamilies(s string) (v4, v6 bool) {
	for _, f := range strings.Split(s, ",") {
		switch strings.TrimSpace(f) {
		case "v4":
			v4 = true
		case "v6":
			v6 = true
		}
	}
	return
}

// agentAddressFamilies 判断 Agent 当前可用的地址族，两层信息取交集：
//
//   - 地址来源（决定"用哪个地址"）：管理员填了 source_ip_override 就以它为准——它也是
//     该 Agent 作为对端时的目标地址；只填 IPv4 即让该节点退出 IPv6 互测。否则用自动
//     追踪的 connection_ipv4 / ipv6（Agent 用 tcp4 / tcp6 各连一次 /my-ip 自发现，两者
//     都空时回退 connection_ip）。
//   - 能力声明（决定"这一族现在能不能用"）：新版 Agent 启动时同步完成自发现，之后
//     每个请求带 X-Agent-Stack，服务端记在 agents.stack。声明里没有的族即便 Override
//     写了也不下发——Override 是管理员的地址选择，压不过节点当下的真实能力；重启 Agent
//     即重新声明，撤掉的 IPv6 随之消失。旧版 Agent 不声明（stack 为空），只按地址来源
//     判断，此时只有 TCP 来源那一族会被自动记录，会被当作单栈——升级 Agent 即可。
func agentAddressFamilies(a *models.Agent) (hasV4, hasV6 bool) {
	mark := func(s string) {
		if addr, err := netip.ParseAddr(strings.TrimSpace(s)); err == nil {
			if addr.Is4() {
				hasV4 = true
			} else {
				hasV6 = true
			}
		}
	}
	if a.SourceIPOverride != nil && *a.SourceIPOverride != "" {
		for _, part := range strings.SplitN(*a.SourceIPOverride, "/", 2) {
			mark(part)
		}
	}
	if !hasV4 && !hasV6 {
		mark(a.ConnectionIPv4)
		mark(a.ConnectionIPv6)
	}
	if !hasV4 && !hasV6 {
		mark(a.ConnectionIP)
	}
	if a.Stack != "" {
		sv4, sv6 := stackFamilies(a.Stack)
		hasV4, hasV6 = hasV4 && sv4, hasV6 && sv6
	}
	return
}

// resolveMeshPingTargets 查询其他"存活"（LastSeenAt 在 onlineThreshold 内、未被吊销）
// Agent 的可达 IP，作为 MeshPing 目标列表（排除自身）。
//
// IP 优先级（每个 peer 独立计算）：
//  1. source_ip_override（管理员手动，支持单 IP 或 "ipv4 / ipv6" 双栈格式）
//  2. connection_ipv4 + connection_ipv6（自动追踪，有哪个发哪个）
//  3. connection_ip（兜底：旧数据或尚未更新的 agent）
//
// 地址族自适应（见 agentAddressFamilies）：一个目标地址只有在请求方和对端**都**可用
// 该族时才下发。只有 IPv4 的 Agent 不会收到对端的 IPv6 地址，反之亦然；对端声明了
// 没有 IPv6，即便它的 Override 里还写着 v6 地址也不会成为目标。否则每个周期都会产生
// 注定失败的记录，既污染矩阵也白白占存储。
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

	selfV4, selfV6 := agentAddressFamilies(self)
	targets := make([]string, 0, len(peers)*2)
	// add 按"请求方 ∩ 对端"的可用地址族过滤后追加目标；保留原始字符串形式（不做规范化），
	// 避免改变已有结果序列的 target 键
	add := func(ip string, peerV4, peerV6 bool) {
		ip = strings.TrimSpace(ip)
		addr, err := netip.ParseAddr(ip)
		if err != nil {
			return
		}
		if addr.Is4() && !(selfV4 && peerV4) {
			return
		}
		if !addr.Is4() && !(selfV6 && peerV6) {
			return
		}
		targets = append(targets, ip)
	}
	for i := range peers {
		p := &peers[i]
		peerV4, peerV6 := agentAddressFamilies(p)
		if p.SourceIPOverride != nil && *p.SourceIPOverride != "" {
			// 管理员手动优先：支持单 IP 或 "ipv4 / ipv6" 双栈格式
			for _, part := range strings.SplitN(*p.SourceIPOverride, "/", 2) {
				add(part, peerV4, peerV6)
			}
		} else if p.ConnectionIPv4 != "" || p.ConnectionIPv6 != "" {
			// 自动追踪的双栈地址：有哪个发哪个
			add(p.ConnectionIPv4, peerV4, peerV6)
			add(p.ConnectionIPv6, peerV4, peerV6)
		} else if p.ConnectionIP != "" {
			add(p.ConnectionIP, peerV4, peerV6)
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
	// CollectedAt（unix 秒）Agent 侧的探测执行时刻。旧版 Agent 不发（解析为 0），
	// 回退用入库时刻——与 snmpResultIn.CollectedAt 同一约定。
	CollectedAt int64 `json:"collected_at"`
}

// resolveCollectedAt 把 Agent 上报的采集时刻转换为样本时间基准：
//   - 0（旧版 Agent 不发）→ 回退入库时刻，ok=true（旧版无重试机制，不影响去重）；
//   - 超窗（未来 5 分钟以上 / 过去 1 小时以上——时钟漂移或超长积压回填）→ ok=false，
//     调用方显式丢弃该样本并计数。不能钳制到入库时刻：同批同序列的多个超窗样本会
//     共享同一时刻撞去重唯一键静默丢行，且重试重放时键值每次不同、去重彻底失效；
//     显式丢弃 + 返回 dropped 计数更诚实——它本身就是"该节点时钟/积压需要排查"的
//     诊断信号。时间窗口与 applySNMPResult 对 SNMP 结论的钳制规则一致（SNMP 通道
//     是快照语义，钳制不丢真相，故保持钳制不丢弃）。
func resolveCollectedAt(sec int64, now time.Time) (time.Time, bool) {
	if sec <= 0 {
		return now, true
	}
	at := time.Unix(sec, 0)
	if at.After(now.Add(5*time.Minute)) || at.Before(now.Add(-time.Hour)) {
		return time.Time{}, false
	}
	return at, true
}

// probeResultInsertChunk：单次 INSERT 语句携带的最大行数。一次性把上千行（尤其
// mtr/meshmtr 的 Detail 是整段 hop 列表 JSON，单行可到数 KB）拼进一条 SQL，很容易
// 超过 MariaDB/MySQL 的 max_allowed_packet（常见默认 4M~16M），服务端会整条拒绝且
// 从不重试；对 Agent 而言这与请求失败无异，会无限重发同一批却永远无法写入——分片
// 后单条语句体积可控，且各分片独立提交，即使某个分片仍然超限，其余分片也不受影响。
const probeResultInsertChunk = 200

// PostAgentResults POST /api/v1/agent-sync/results —— 批量写入探测结果。
//
// 幂等性：Agent 端有上报重试——服务端已成功入库但响应未送达（超时/断连），或本次
// 请求部分分片失败导致最终仍返回 500 时，整批会被原样重发。INSERT .. ON DUPLICATE
// KEY UPDATE id=id（gorm OnConflict DoNothing 在 MySQL 上的展开）配合唯一索引
// idx_probe_dedup (agent_id, task_id, target, reported_at) 静默跳过重复行；
// reported_at 取自 Agent 的 collected_at，重放批次的键值逐行相同，天然命中去重。
// 索引缺失时（见 EnsureProbeDedupIndex 的降级路径）该子句无害，行为退回旧版。
func PostAgentResults(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		agent := middleware.GetAgent(c)
		if agent == nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "未认证"})
			return
		}
		extendTransferDeadlines(c, 2*time.Minute)
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxSyncBatchBytes)

		var req struct {
			Results []probeResultIn `json:"results" binding:"required,dive"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			if isMaxBytesErr(err) {
				c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "上报批次体积超出上限 (32 MiB)"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error()})
			return
		}

		now := time.Now()
		rows := make([]models.ProbeResult, 0, len(req.Results))
		var dropped int64
		for _, r := range req.Results {
			at, ok := resolveCollectedAt(r.CollectedAt, now)
			if !ok {
				dropped++
				continue
			}
			rows = append(rows, models.ProbeResult{
				AgentID: agent.AgentID, TaskID: r.TaskID, Type: r.Type, Target: r.Target,
				Success: r.Success, LatencyMs: r.LatencyMs, Detail: r.Detail,
				ReportedAt: at,
			})
		}
		if dropped > 0 {
			slog.Warn("探测结果丢弃超窗样本（节点时钟漂移或积压超过 1 小时，请排查该 Agent）",
				"agent_id", agent.AgentID, "dropped", dropped, "received", len(req.Results))
		}

		// 分片写入：单个分片失败不阻断其余分片，最大化本次请求能落库的数据量；
		// 只要有任一分片失败，最终仍对 Agent 返回 500——已成功的分片凭幂等索引
		// 保证重放安全，不会被下次重试重复插入。
		var deduped int64
		var insertErr error
		for i := 0; i < len(rows); i += probeResultInsertChunk {
			end := i + probeResultInsertChunk
			if end > len(rows) {
				end = len(rows)
			}
			chunk := rows[i:end]
			result := db.Clauses(clause.OnConflict{DoNothing: true}).Create(&chunk)
			if result.Error != nil {
				// 之前这里只把报错塞进了返回给 Agent 的响应体——Agent 的 reporter
				// 只看状态码、从不读取响应体，真实报错文本因此从未落到任何日志里。
				slog.Error("探测结果写入失败", "agent_id", agent.AgentID,
					"chunk_offset", i, "chunk_size", len(chunk), "err", result.Error)
				insertErr = result.Error
				continue
			}
			upsertProbeLatestStates(db, chunk)
			// RowsAffected = 实际插入行数（重复行计 0）；差值即被去重的重放行
			if d := int64(len(chunk)) - result.RowsAffected; d > 0 {
				deduped += d
			}
		}
		if insertErr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "写入结果失败: " + insertErr.Error()})
			return
		}
		if deduped > 0 {
			slog.Info("探测结果去重（重试重放）", "agent_id", agent.AgentID,
				"received", len(req.Results), "deduped", deduped)
		}
		c.JSON(http.StatusOK, gin.H{"received": len(req.Results), "deduped": deduped, "dropped": dropped})
	}
}

// upsertProbeLatestStates 将已落库分片的最新状态同步至 probe_latest_states 快照表。
// 先在内存按 (type, agent_id, target) 归并保留采集时刻最新的一条，再以单调递增条件
// （VALUES(reported_at) >= reported_at）执行幂等 upsert，防止乱序重试覆盖更新快照。
func upsertProbeLatestStates(db *gorm.DB, rows []models.ProbeResult) {
	if len(rows) == 0 {
		return
	}
	type latestKey struct {
		typ, agentID, target string
	}
	dedup := make(map[latestKey]models.ProbeResult, len(rows))
	for _, r := range rows {
		k := latestKey{r.Type, r.AgentID, r.Target}
		if prev, ok := dedup[k]; !ok || !r.ReportedAt.Before(prev.ReportedAt) {
			dedup[k] = r
		}
	}
	vals := make([]string, 0, len(dedup))
	args := make([]interface{}, 0, len(dedup)*8)
	for _, r := range dedup {
		vals = append(vals, "(?, ?, ?, ?, ?, ?, ?, ?)")
		args = append(args, r.Type, r.AgentID, r.Target, r.TaskID, r.Success, r.LatencyMs, r.Detail, r.ReportedAt)
	}
	// MySQL ON DUPLICATE KEY UPDATE 从左向右顺序赋值：reported_at 必须放在最后，
	// 确保前序字段比较 VALUES(reported_at) >= reported_at 时读取的是旧行的 reported_at。
	sqlStr := `INSERT INTO probe_latest_states
		(type, agent_id, target, task_id, success, latency_ms, detail, reported_at)
		VALUES ` + strings.Join(vals, ",") + `
		ON DUPLICATE KEY UPDATE
		task_id     = IF(VALUES(reported_at) >= reported_at, VALUES(task_id), task_id),
		success     = IF(VALUES(reported_at) >= reported_at, VALUES(success), success),
		latency_ms  = IF(VALUES(reported_at) >= reported_at, VALUES(latency_ms), latency_ms),
		detail      = IF(VALUES(reported_at) >= reported_at, VALUES(detail), detail),
		reported_at = IF(VALUES(reported_at) >= reported_at, VALUES(reported_at), reported_at)`
	if err := db.Exec(sqlStr, args...).Error; err != nil {
		slog.Error("更新探测最新快照表失败", "count", len(dedup), "err", err)
	}
}

// BackfillProbeLatestStates 存量升级一次性回填：按探测类型检查，若某类型在历史热表中有数据但
// 在快照表中尚无记录，则将每个 (agent_id, target) 的最新记录回填至 probe_latest_states。
func BackfillProbeLatestStates(ctx context.Context, wg *sync.WaitGroup, db *gorm.DB) {
	wg.Add(1)
	go func() {
		defer wg.Done()
		var types []string
		if err := db.Model(&models.ProbeResult{}).Distinct().Pluck("type", &types).Error; err != nil || len(types) == 0 {
			return
		}
		var existingTypes []string
		_ = db.Model(&models.ProbeLatestState{}).Distinct().Pluck("type", &existingTypes).Error
		hasType := make(map[string]bool, len(existingTypes))
		for _, t := range existingTypes {
			hasType[t] = true
		}

		var missing []string
		for _, tp := range types {
			if tp != "" && !hasType[tp] {
				missing = append(missing, tp)
			}
		}
		if len(missing) == 0 {
			return
		}

		slog.Info("开始从历史 probe_results 回填 probe_latest_states 快照表", "types", len(missing))
		for _, tp := range missing {
			if ctx.Err() != nil {
				return
			}
			err := db.Exec(`
				INSERT INTO probe_latest_states
					(type, agent_id, target, task_id, success, latency_ms, detail, reported_at)
				SELECT pr.type, pr.agent_id, pr.target, pr.task_id, pr.success, pr.latency_ms, pr.detail, pr.reported_at
				FROM probe_results pr
				INNER JOIN (
					SELECT MAX(p2.id) AS max_id
					FROM probe_results p2
					INNER JOIN (
						SELECT agent_id, target, MAX(reported_at) AS max_time
						FROM probe_results WHERE type = ?
						GROUP BY agent_id, target
					) lt ON p2.agent_id = lt.agent_id AND p2.target = lt.target AND p2.reported_at = lt.max_time
					WHERE p2.type = ?
					GROUP BY p2.agent_id, p2.target
				) pick ON pr.id = pick.max_id
				ON DUPLICATE KEY UPDATE
					task_id     = IF(VALUES(reported_at) >= probe_latest_states.reported_at, VALUES(task_id), probe_latest_states.task_id),
					success     = IF(VALUES(reported_at) >= probe_latest_states.reported_at, VALUES(success), probe_latest_states.success),
					latency_ms  = IF(VALUES(reported_at) >= probe_latest_states.reported_at, VALUES(latency_ms), probe_latest_states.latency_ms),
					detail      = IF(VALUES(reported_at) >= probe_latest_states.reported_at, VALUES(detail), probe_latest_states.detail),
					reported_at = IF(VALUES(reported_at) >= probe_latest_states.reported_at, VALUES(reported_at), probe_latest_states.reported_at)`,
				tp, tp).Error
			if err != nil {
				slog.Error("回填 probe_latest_states 失败", "type", tp, "err", err)
			}
		}
		slog.Info("probe_latest_states 快照表历史回填完成")
	}()
}

// EnsureProbeDedupIndex 确保 probe_results 上存在幂等去重唯一索引 idx_probe_dedup
// （详见 PostAgentResults）。不通过模型 tag 交给 AutoMigrate：存量库可能已有完全
// 重复的历史行（旧版同批结果共享同一入库时刻，重复 Target 行会撞键），AutoMigrate
// 建索引失败是致命错误；这里失败时先清理重复行再重试一次，最终失败仅告警降级——
// 去重能力依赖该索引，缺失时入库行为与旧版一致（可能出现偶发重复点）。
// 大表建索引/清重可能耗时数分钟，放到后台 goroutine，不阻塞启动。
func EnsureProbeDedupIndex(ctx context.Context, wg *sync.WaitGroup, db *gorm.DB) {
	wg.Add(1)
	go func() {
		defer wg.Done()
		if ctx.Err() != nil {
			return
		}
		var n int64
		db.Raw(`SELECT COUNT(*) FROM information_schema.STATISTICS
			WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'probe_results' AND INDEX_NAME = 'idx_probe_dedup'`).
			Scan(&n)
		if n > 0 || ctx.Err() != nil {
			return
		}
		const create = "CREATE UNIQUE INDEX idx_probe_dedup ON probe_results (agent_id, task_id, target, reported_at)"
		if err := db.Exec(create).Error; err == nil {
			slog.Info("probe_results 幂等去重索引已创建", "index", "idx_probe_dedup")
			return
		}
		if ctx.Err() != nil {
			return
		}
		slog.Warn("创建 idx_probe_dedup 失败，尝试清理历史重复行后重试（大表可能耗时较长）")
		del := db.Exec(`DELETE t1 FROM probe_results t1 JOIN probe_results t2
			ON t1.agent_id = t2.agent_id AND t1.task_id = t2.task_id
			AND t1.target = t2.target AND t1.reported_at = t2.reported_at
			AND t1.id > t2.id
			WHERE t1.task_id IS NOT NULL`)
		if del.Error != nil {
			slog.Warn("清理 probe_results 历史重复行失败，去重索引未启用（入库降级为可能出现偶发重复点）",
				"err", del.Error)
			return
		}
		if del.RowsAffected > 0 {
			slog.Info("已清理 probe_results 历史重复行", "deleted", del.RowsAffected)
		}
		if ctx.Err() != nil {
			return
		}
		if err := db.Exec(create).Error; err != nil {
			slog.Warn("重试创建 idx_probe_dedup 仍失败，去重索引未启用（入库降级为可能出现偶发重复点）",
				"err", err)
			return
		}
		slog.Info("probe_results 幂等去重索引已创建", "index", "idx_probe_dedup")
	}()
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
		extendTransferDeadlines(c, 2*time.Minute)
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxSyncBatchBytes)

		var req struct {
			Results []snmpResultIn `json:"results" binding:"required,dive"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			if isMaxBytesErr(err) {
				c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "上报批次体积超出上限 (32 MiB)"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error()})
			return
		}

		accepted, rejected, stale := 0, 0, 0
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
			// 被单调性守卫丢弃的乱序/重放结论单独计数（stale），与 accepted 区分
			if applySNMPResult(db, r.DeviceID, &agent.AgentID, obs) {
				stale++
			} else {
				accepted++
			}
		}
		if rejected > 0 {
			slog.Warn("SNMP 结果部分被拒（设备未指派给该 Agent 或配置已变更）",
				"agent_id", agent.AgentID, "accepted", accepted, "rejected", rejected)
		}
		if stale > 0 {
			slog.Info("SNMP 结果丢弃乱序/重放的旧快照", "agent_id", agent.AgentID,
				"accepted", accepted, "stale", stale)
		}
		c.JSON(http.StatusOK, gin.H{"received": accepted, "rejected": rejected, "stale": stale})
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
			internalErr(c, http.StatusInternalServerError, "签发证书失败", err)
			return
		}
		if err := db.Model(agent).Updates(map[string]interface{}{
			"cert_serial":    issued.Serial,
			"cert_expiry":    issued.Expiry,
			"trusted_ca_fp":  pki.BundleFingerprints(),
			"cert_issuer_fp": pki.ActiveCAFingerprint(),
		}).Error; err != nil {
			internalErr(c, http.StatusInternalServerError, "更新证书记录失败", err)
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"agent_id":    agent.AgentID,
			"cert_pem":    string(issued.CertPEM),
			"key_pem":     string(issued.KeyPEM),
			"ca_cert_pem": string(pki.CABundlePEM()),
			"cert_expiry": issued.Expiry,
		})
	}
}

// StartAgentOfflineSweeper 启动后台任务：周期性把超过 onlineThreshold 仍未刷新心跳
// 的 Agent 从 online 翻转为 offline。AgentMTLS 中间件只负责"标记上线"，没有这个
// sweeper 的话，一台失联的 Agent 会在 Agent List 里永久显示为 online。
func StartAgentOfflineSweeper(ctx context.Context, wg *sync.WaitGroup, db *gorm.DB) {
	wg.Add(1)
	go func() {
		defer wg.Done()
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
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
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
		// 对齐 Agent updater 侧 10 分钟下载超时，防止跨洲低带宽节点被全局 WriteTimeout(120s) 截断
		extendTransferDeadlines(c, 10*time.Minute)
		c.FileAttachment(rel.FilePath, "nms-agent")
	}
}

// RegisterAgentSyncRoutes 挂载到独立的 sync mTLS 引擎（tls.RequireAndVerifyClientCert）。
func RegisterAgentSyncRoutes(r *gin.Engine, db *gorm.DB, pki *core.PKI, clientCertDays int, snmpCfg SNMPConfig) {
	sync := r.Group("/api/v1/agent-sync")
	sync.Use(middleware.AgentMTLSWithPKI(db, pki))
	{
		sync.GET("/tasks", GetAgentTasksWithPKI(db, pki, snmpCfg))
		sync.POST("/results", PostAgentResults(db))
		sync.POST("/snmp-results", PostAgentSNMPResults(db))
		sync.POST("/renew-cert", RenewAgentCert(db, pki, clientCertDays))
		sync.GET("/my-ip", GetMyIP)
		sync.GET("/binary/:id", GetAgentBinary(db))
	}
}
