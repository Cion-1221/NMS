package models

import (
	"strings"
	"time"
)

// ── AgentGroup ───────────────────────────────────────────────────────────────
// Logical grouping of Agents (e.g. HKG / SIN / LAX). Doubles as the "Mesh group"
// boundary for meshping tasks — see ResolveAgentTasks in agent_sync_api.go.

type AgentGroup struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"type:varchar(100);uniqueIndex;not null" json:"name"`
	Description string    `gorm:"type:varchar(500)" json:"description"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (AgentGroup) TableName() string { return "agent_groups" }

// ── Agent ────────────────────────────────────────────────────────────────────
// AgentID is server-allocated at enroll time (e.g. "AGT-3F2A9B7C") and is also the
// certificate Subject.CommonName the mTLS middleware reads to identify the caller,
// so it is the primary key rather than a surrogate uint ID.

type Agent struct {
	AgentID          string      `gorm:"primaryKey;type:varchar(64)" json:"agent_id"`
	Hostname         string      `gorm:"type:varchar(255);not null" json:"hostname"`
	GroupID          *uint       `gorm:"index" json:"group_id"`
	Group            *AgentGroup `gorm:"foreignKey:GroupID" json:"group,omitempty"`
	ConnectionIP     string      `gorm:"type:varchar(100)" json:"connection_ip"`
	ConnectionIPv4   string      `gorm:"type:varchar(100)" json:"connection_ipv4"`
	ConnectionIPv6   string      `gorm:"type:varchar(100)" json:"connection_ipv6"`
	SourceIPOverride *string     `gorm:"type:varchar(100)" json:"source_ip_override"`
	Status           string      `gorm:"type:varchar(20);not null;default:'offline'" json:"status"`
	Version          string      `gorm:"type:varchar(50)" json:"version"`
	OS               string      `gorm:"type:varchar(50)" json:"os"`
	Arch             string      `gorm:"type:varchar(20)" json:"arch"`
	RegisteredAt     time.Time   `json:"registered_at"`
	CertExpiry       time.Time   `json:"cert_expiry"`
	CertSerial       string      `gorm:"type:varchar(100)" json:"-"`
	Revoked          bool        `gorm:"not null;default:false" json:"revoked"`
	LastSeenAt       *time.Time  `json:"last_seen_at"`
}

func (Agent) TableName() string { return "agents" }

// ── AgentToken ───────────────────────────────────────────────────────────────
// One-time provisioning code consumed by POST /agents/enroll. Mirrors the
// hash-at-rest pattern used by SysRefreshToken (see generateRefreshToken in
// controllers/auth_api.go) — the raw token is only ever returned to the caller
// once, at creation time; only its SHA-256 hash is persisted.

type AgentToken struct {
	ID            uint        `gorm:"primaryKey" json:"id"`
	TokenHash     string      `gorm:"type:varchar(64);uniqueIndex;not null" json:"-"`
	Status        string      `gorm:"type:varchar(20);not null;default:'unused'" json:"status"` // unused/used/revoked
	PresetGroupID *uint       `gorm:"index" json:"preset_group_id"`
	PresetGroup   *AgentGroup `gorm:"foreignKey:PresetGroupID" json:"preset_group,omitempty"`
	ExpiresAt     time.Time   `gorm:"not null;index" json:"expires_at"`
	UsedByAgentID *string     `gorm:"type:varchar(64)" json:"used_by_agent_id"`
	UsedAt        *time.Time  `json:"used_at"`
	CreatedBy     string      `gorm:"type:varchar(100)" json:"created_by"`
	CreatedAt     time.Time   `json:"created_at"`
}

func (AgentToken) TableName() string { return "agent_tokens" }

// ── AgentTask ────────────────────────────────────────────────────────────────
// TargetsRaw stores newline-separated targets verbatim as typed in the Probe
// Config UI. meshping tasks ignore TargetsRaw entirely at dispatch time — the
// server resolves live group members instead (see ResolveAgentTasks).

type AgentTask struct {
	ID              uint        `gorm:"primaryKey" json:"id"`
	Name            string      `gorm:"type:varchar(150);not null" json:"name"`
	Type            string      `gorm:"type:varchar(20);not null;index" json:"type"`
	TargetsRaw      string      `gorm:"type:text" json:"targets_raw"`
	IntervalSeconds int         `gorm:"not null;default:60" json:"interval_seconds"`
	Scope           string      `gorm:"type:varchar(20);not null;default:'global'" json:"scope"` // global/group/agent
	GroupID         *uint       `gorm:"index" json:"group_id"`
	Group           *AgentGroup `gorm:"foreignKey:GroupID" json:"group,omitempty"`
	AgentID         *string     `gorm:"type:varchar(64);index" json:"agent_id"`
	Agent           *Agent      `gorm:"foreignKey:AgentID;references:AgentID" json:"agent,omitempty"`
	Enabled         bool        `gorm:"not null;default:true" json:"enabled"`
	// SkipTLSVerify：仅 httpcheck 类型使用——跳过证书校验，用于探测裸 IP（证书 SAN
	// 只签给域名，裸 IP 天然过不了校验）或自签证书设备。其余类型忽略此字段。
	SkipTLSVerify bool `gorm:"not null;default:false" json:"skip_tls_verify"`
	// AddressFamily：域名 target 的解析地址族——auto（跟随系统解析偏好，与历史行为
	// 一致）/ v4 / v6 / both（v4+v6 各探测一次，Agent 端结果以 " (v4)"/" (v6)" 后缀
	// 区分两条序列）。字面 IP target 天然携带自身地址族，不受此字段影响；
	// meshping/meshmtr 的目标由 Server 解析成字面 IP，同样不受影响。
	AddressFamily string    `gorm:"type:varchar(10);not null;default:'auto'" json:"address_family"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

func (AgentTask) TableName() string { return "agent_tasks" }

// Targets splits TargetsRaw on newlines, trimming whitespace and dropping blanks.
func (t *AgentTask) Targets() []string {
	lines := strings.Split(t.TargetsRaw, "\n")
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

// ── ProbeResult ──────────────────────────────────────────────────────────────

// 索引设计（probe_results 是全库写入最热的表，每个索引都要有明确归属）：
//   - idx_probe_type_reported (type, reported_at)：历史列表按 Type 过滤 + 时间排序；
//     最左前缀规则下仅按 Type 过滤的查询同样命中。
//   - idx_probe_latest (type, agent_id, target, reported_at)：latest 快照与 meshping
//     矩阵的核心子查询 `WHERE type=? GROUP BY agent_id,target 取 MAX(reported_at)`
//     可走纯索引扫描，避免对该 Type 的全部行做全表扫描（这两个端点被前端 30s 轮询）；
//     DeleteProbeResultPair 的 (type, agent_id, target) 精确删除同样命中前缀。
//   - reported_at 单列索引：overview 看板的时间窗聚合（WHERE reported_at >= ?，不带
//     type 条件）与保留策略清理（reported_at < cutoff）使用。
//   - idx_probe_dedup (agent_id, task_id, target, reported_at) 唯一索引：Agent 上报
//     重试的幂等性依据——响应丢失时整批原样重发，靠它 + INSERT..ON DUPLICATE KEY
//     静默跳过重复行。不写在 gorm tag 里：存量库可能已有完全重复的历史行，
//     AutoMigrate 建唯一索引失败是致命错误；改由 EnsureProbeDedupIndex（启动后台）
//     创建，失败自动清理重复行重试，最终失败仅告警降级（去重依赖索引，缺失时行为
//     与旧版一致）。task_id 为 NULL 的行不受唯一约束（MySQL 语义），可接受。
//   - Target 不再单独建索引（模糊搜索 LIKE '%..%' 本就用不上索引，精确匹配已由
//     idx_probe_latest 覆盖）；AutoMigrate 不会删除既有索引，旧部署可手动
//     `DROP INDEX idx_probe_results_target ON probe_results` 回收写放大。
//
// ReportedAt 是样本时间基准：新版 Agent 上报采集时刻 collected_at（unix 秒），
// 缺失（旧版 Agent）时回退为入库时刻；明显异常（时钟漂移/超长积压）的样本被
// 显式丢弃并计数返回，不落库——见 PostAgentResults / resolveCollectedAt。
type ProbeResult struct {
	ID         uint      `gorm:"primaryKey" json:"id"`
	AgentID    string    `gorm:"type:varchar(64);not null;index;index:idx_probe_latest,priority:2" json:"agent_id"`
	TaskID     *uint     `gorm:"index" json:"task_id"`
	Type       string    `gorm:"type:varchar(20);not null;index:idx_probe_type_reported,priority:1;index:idx_probe_latest,priority:1" json:"type"`
	Target     string    `gorm:"type:varchar(255);not null;index:idx_probe_latest,priority:3" json:"target"`
	Success    bool      `gorm:"not null" json:"success"`
	LatencyMs  *float64  `json:"latency_ms"`
	Detail     string    `gorm:"type:text" json:"detail"`
	ReportedAt time.Time `gorm:"not null;index;index:idx_probe_type_reported,priority:2;index:idx_probe_latest,priority:4" json:"reported_at"`
}

func (ProbeResult) TableName() string { return "probe_results" }

// ── AgentAuditLog ────────────────────────────────────────────────────────────
// Same shape as DeviceAuditLog/IPAMAuditLog, except ResourceID is a string since
// Agent resources are keyed by AgentID (string) rather than a numeric ID.

type AgentAuditLog struct {
	ID           uint      `gorm:"primaryKey" json:"id"`
	Username     string    `gorm:"type:varchar(100);not null;index" json:"username"`
	Action       string    `gorm:"type:varchar(50);not null" json:"action"`
	ResourceType string    `gorm:"type:varchar(50);not null" json:"resource_type"`
	ResourceID   string    `gorm:"type:varchar(64)" json:"resource_id"`
	Detail       string    `gorm:"type:text" json:"detail"`
	CreatedAt    time.Time `gorm:"index" json:"created_at"`
}

func (AgentAuditLog) TableName() string { return "agent_audit_logs" }

// ── AgentRelease ─────────────────────────────────────────────────────────────
// 记录每个 OS/Arch 组合对应的 Agent 二进制版本与下载地址。
// 同一 OS+Arch 同时只能有一条 active=true 的记录；激活某条时服务端自动将同 OS+Arch 的其他
// 记录设为 false。当 Agent 的 OS+Arch 命中激活记录且版本不同时，任务同步响应附带 update
// 字段，Agent 自行下载、校验、替换并重启。
type AgentRelease struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	Version   string    `gorm:"type:varchar(50);not null;uniqueIndex:idx_release_ver_os_arch" json:"version"`
	OS        string    `gorm:"type:varchar(20);not null;uniqueIndex:idx_release_ver_os_arch" json:"os"`
	Arch      string    `gorm:"type:varchar(20);not null;uniqueIndex:idx_release_ver_os_arch" json:"arch"`
	FilePath  string    `gorm:"type:varchar(500);not null;default:''" json:"file_path"`
	FileSize  int64     `gorm:"not null;default:0" json:"file_size"`
	SHA256    string    `gorm:"type:varchar(64);not null;default:''" json:"sha256"`
	Notes     string    `gorm:"type:varchar(500)" json:"notes"`
	Active    bool      `gorm:"not null;default:false" json:"active"`
	CreatedBy string    `gorm:"type:varchar(100)" json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
}

func (AgentRelease) TableName() string { return "agent_releases" }
