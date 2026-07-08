package models

import "time"

// ── DeviceSite ─────────────────────────────────────────────────────────────────

type DeviceSite struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"type:varchar(100);uniqueIndex;not null" json:"name"`
	Region      string    `gorm:"type:varchar(100)" json:"region"`
	Address     string    `gorm:"type:varchar(300)" json:"address"`
	Description string    `gorm:"type:varchar(500)" json:"description"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (DeviceSite) TableName() string { return "device_sites" }

// ── DevicePoP ──────────────────────────────────────────────────────────────────
// Composite unique: (site_id, name) — enforced by uniqueIndex:idx_pop_site_name

type DevicePoP struct {
	ID          uint        `gorm:"primaryKey" json:"id"`
	Name        string      `gorm:"type:varchar(100);not null;uniqueIndex:idx_pop_site_name" json:"name"`
	SiteID      uint        `gorm:"not null;index;uniqueIndex:idx_pop_site_name" json:"site_id"`
	Site        *DeviceSite `gorm:"foreignKey:SiteID" json:"site,omitempty"`
	Description string      `gorm:"type:varchar(500)" json:"description"`
	CreatedAt   time.Time   `json:"created_at"`
	UpdatedAt   time.Time   `json:"updated_at"`
}

func (DevicePoP) TableName() string { return "device_pops" }

// ── DeviceRole ─────────────────────────────────────────────────────────────────

type DeviceRole struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"type:varchar(100);uniqueIndex;not null" json:"name"`
	Description string    `gorm:"type:varchar(500)" json:"description"`
	CreatedAt   time.Time `json:"created_at"`
}

func (DeviceRole) TableName() string { return "device_roles" }

// ── DeviceVendor ───────────────────────────────────────────────────────────────

type DeviceVendor struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"type:varchar(100);uniqueIndex;not null" json:"name"`
	Description string    `gorm:"type:varchar(500)" json:"description"`
	CreatedAt   time.Time `json:"created_at"`
}

func (DeviceVendor) TableName() string { return "device_vendors" }

// ── Device ─────────────────────────────────────────────────────────────────────
// ManagementIP (IPv4) and ManagementIPv6 are both nullable so that either can be
// omitted, but application-level validation requires at least one to be present.
// NULL values are stored as SQL NULL (not empty string) to satisfy the unique index
// constraint when a field is not used — MySQL allows multiple NULLs in a UNIQUE column.
//
// 状态双字段模型：
//   - Status（管理状态）：用户在表单设置的生命周期意图（active/maintenance/planned；
//     旧值 offline 仍合法，UI 展示为"已停用"），SNMP 采集不会改写它。
//   - OperStatus（运行状态）：up/down/unknown，只由采集链路（direct poller /
//     agent 上报 / watchdog sweeper）写入，用户不可编辑。OperReason 记录进入当前
//     状态的原因（snmp_timeout / agent_down / poller_stale / agent_revoked …）。
//
// SNMPCommunity / SNMPv3 凭证字段一律 json:"-"：永不出现在任何 API 响应里，
// 前端通过派生字段 SNMPCredentialSet 判断"是否已配置凭证"（编辑时留空 = 不修改）。

type Device struct {
	ID             uint          `gorm:"primaryKey" json:"id"`
	Hostname       string        `gorm:"type:varchar(255);uniqueIndex;not null" json:"hostname"`
	ManagementIP   *string       `gorm:"type:varchar(50);uniqueIndex" json:"management_ip"`
	ManagementIPv6 *string       `gorm:"type:varchar(100);uniqueIndex" json:"management_ipv6"`
	Status         string        `gorm:"type:varchar(20);not null;default:'active'" json:"status"`
	SiteID         *uint         `gorm:"index" json:"site_id"`
	Site           *DeviceSite   `gorm:"foreignKey:SiteID" json:"site,omitempty"`
	PoPID          *uint         `gorm:"column:pop_id;index" json:"pop_id"`
	PoP            *DevicePoP    `gorm:"foreignKey:PoPID" json:"pop,omitempty"`
	RoleID         *uint         `gorm:"index" json:"role_id"`
	Role           *DeviceRole   `gorm:"foreignKey:RoleID" json:"role,omitempty"`
	VendorID       *uint         `gorm:"index" json:"vendor_id"`
	Vendor         *DeviceVendor `gorm:"foreignKey:VendorID" json:"vendor,omitempty"`
	Remark         string        `gorm:"type:text" json:"remark"`

	// ── SNMP 采集配置（用户编辑）─────────────────────────────────────────────
	PollingMode         string  `gorm:"type:varchar(20);not null;default:'none';index" json:"polling_mode"`             // none/direct/agent
	SNMPAgentID         *string `gorm:"column:snmp_agent_id;type:varchar(64);index" json:"snmp_agent_id"`               // agent 模式指派的采集探针
	SNMPVersion         string  `gorm:"column:snmp_version;type:varchar(10);not null;default:'2c'" json:"snmp_version"` // 1/2c（v3 列已预留）
	SNMPCommunity       string  `gorm:"column:snmp_community;type:varchar(200)" json:"-"`
	SNMPPort            int     `gorm:"column:snmp_port;not null;default:161" json:"snmp_port"`
	SNMPIntervalSeconds *int    `gorm:"column:snmp_interval_seconds" json:"snmp_interval_seconds"` // NULL = 用全局默认
	// CollectInterfaces：随每个采集周期 WALK ifTable/ifXTable，维护接口维表
	//（名称/状态/速率），详见 DeviceInterface
	CollectInterfaces bool `gorm:"not null;default:false" json:"collect_interfaces"`

	// SNMPv3（USM）。用户名与协议是非敏感配置（出 JSON 供表单回填）；两个密码
	// 同 community 一样 json:"-" 永不回显，前端以派生标志感知"已配置"。
	// 安全级别由字段组合推导：authProto 空 = noAuthNoPriv；仅 authProto = authNoPriv；
	// authProto + privProto = authPriv（privProto 依赖 authProto，校验强制）。
	SNMPV3User      *string `gorm:"column:snmp_v3_user;type:varchar(100)" json:"snmp_v3_user"`
	SNMPV3AuthProto *string `gorm:"column:snmp_v3_auth_proto;type:varchar(20)" json:"snmp_v3_auth_proto"` // MD5/SHA/SHA224/SHA256/SHA384/SHA512
	SNMPV3AuthPass  *string `gorm:"column:snmp_v3_auth_pass;type:varchar(200)" json:"-"`
	SNMPV3PrivProto *string `gorm:"column:snmp_v3_priv_proto;type:varchar(20)" json:"snmp_v3_priv_proto"` // DES/AES/AES192/AES256/AES192C/AES256C
	SNMPV3PrivPass  *string `gorm:"column:snmp_v3_priv_pass;type:varchar(200)" json:"-"`

	// ── 运行状态（机器写入）────────────────────────────────────────────────
	OperStatus string `gorm:"type:varchar(20);not null;default:'unknown';index" json:"oper_status"` // up/down/unknown
	OperReason string `gorm:"type:varchar(50)" json:"oper_reason"`

	// 派生字段：各凭证是否已配置（handler 填充，不落库；编辑时留空 = 保持不变）
	SNMPCredentialSet bool `gorm:"-" json:"snmp_credential_set"`
	SNMPV3AuthSet     bool `gorm:"-" json:"snmp_v3_auth_set"`
	SNMPV3PrivSet     bool `gorm:"-" json:"snmp_v3_priv_set"`

	// SNMP 状态快照（Preload("SNMP")，随列表/详情返回，供 Uptime 列与 Drawer 展示）
	SNMP *DeviceSNMPState `gorm:"foreignKey:DeviceID" json:"snmp,omitempty"`

	// 自定义标量 OID（按需 Preload("CustomOIDs")：poller/任务合成/SNMP 详情用；
	// 设备列表不预载，保持列表响应精瘦）
	CustomOIDs []DeviceSNMPOID `gorm:"foreignKey:DeviceID" json:"custom_oids,omitempty"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (Device) TableName() string { return "devices" }

// ── DeviceSNMPState ────────────────────────────────────────────────────────────
// 每设备一行的 SNMP 状态快照（RFC 1213 system 组），由采集链路 upsert 覆盖更新，
// 属于"状态"而非时序——历史趋势不在此表（避免污染 probe_results 热表与归档链路）。
// LastPollAt 是 watchdog 的判定依据：最近一次拿到采集"结论"（无论成败）的时间；
// 它停滞说明采集链路本身断了（agent 掉线 / poller 卡死），而非设备 down。

type DeviceSNMPState struct {
	ID            uint       `gorm:"primaryKey" json:"id"`
	DeviceID      uint       `gorm:"not null;uniqueIndex" json:"device_id"`
	SysName       string     `gorm:"type:varchar(255)" json:"sys_name"`
	SysDescr      string     `gorm:"type:text" json:"sys_descr"`
	SysObjectID   string     `gorm:"column:sys_object_id;type:varchar(200)" json:"sys_object_id"`
	SysLocation   string     `gorm:"type:varchar(255)" json:"sys_location"`
	SysContact    string     `gorm:"type:varchar(255)" json:"sys_contact"`
	UptimeTicks   *int64     `json:"uptime_ticks"` // sysUpTime TimeTicks（1/100 秒），32 位约 497 天回绕
	BootTime      *time.Time `json:"boot_time"`    // 由 uptime 反推的开机时间，重启检测与展示用
	LatencyMs     *float64   `json:"latency_ms"`   // 最近一次成功采集的 SNMP 请求耗时
	LastPollAt    *time.Time `gorm:"index" json:"last_poll_at"`
	LastSuccessAt *time.Time `json:"last_success_at"`
	LastError     string     `gorm:"type:varchar(500)" json:"last_error"`
	SourceAgentID *string    `gorm:"column:source_agent_id;type:varchar(64)" json:"source_agent_id"` // agent 模式的采集来源，direct 为 NULL
	UpdatedAt     time.Time  `json:"updated_at"`
}

func (DeviceSNMPState) TableName() string { return "device_snmp_states" }

// ── DeviceMIB ──────────────────────────────────────────────────────────────────
// MIB 文件库（admin 上传管理）。文件按 "<ModuleName>.mib" 落盘——gosmi 解析
// IMPORTS 依赖时按模块名在搜索路径中找文件，命名必须与模块名一致才可解析。
// Parsed/ParseError 由翻译引擎每次 Rebuild 回写：解析失败通常是 IMPORTS 的依赖
// 模块尚未上传，补传依赖后自动转为已解析。FilePath 是服务器内部路径，不外露。

type DeviceMIB struct {
	ID         uint      `gorm:"primaryKey" json:"id"`
	ModuleName string    `gorm:"type:varchar(200);uniqueIndex;not null" json:"module_name"`
	FileName   string    `gorm:"type:varchar(255);not null" json:"file_name"`
	FilePath   string    `gorm:"type:varchar(500);not null;default:''" json:"-"`
	FileSize   int64     `gorm:"not null;default:0" json:"file_size"`
	SHA256     string    `gorm:"type:varchar(64);not null;default:''" json:"sha256"`
	Parsed     bool      `gorm:"not null;default:false" json:"parsed"`
	ParseError string    `gorm:"type:varchar(500)" json:"parse_error"`
	UploadedBy string    `gorm:"type:varchar(100)" json:"uploaded_by"`
	CreatedAt  time.Time `json:"created_at"`
}

func (DeviceMIB) TableName() string { return "device_mibs" }

// ── DeviceSNMPOID ──────────────────────────────────────────────────────────────
// 设备级自定义标量 OID：定义与最新值一体（快照语义，与 DeviceSNMPState 同哲学，
// 不是时序——历史趋势属于后续里程碑）。随每次快轮询一并 GET，值由采集链路
// UpdateColumns 回写，用户编辑只动 OID/Name/Unit 三列。每台设备上限 16 条
//（单个 SNMP GET 报文内完成，不额外增加请求数）。

type DeviceSNMPOID struct {
	ID       uint   `gorm:"primaryKey" json:"id"`
	DeviceID uint   `gorm:"not null;index;uniqueIndex:idx_dev_oid" json:"device_id"`
	OID      string `gorm:"column:oid;type:varchar(200);not null;uniqueIndex:idx_dev_oid" json:"oid"`
	Name     string `gorm:"type:varchar(100)" json:"name"` // 显示名；留空时创建端尝试用 MIB 翻译自动命名
	Unit     string `gorm:"type:varchar(20)" json:"unit"`
	// Kind 决定数值如何进时序（LastNumeric 始终存原始值）：
	//   gauge   —— 瞬时量（温度/百分比/会话数），原值直接入库
	//   counter —— 单调递增计数器（ifInOctets 等），入库时用相邻两次采样换算为
	//              每秒速率；差值为负（回绕/重置）时跳过该点（RRDtool 同语义）
	Kind        string     `gorm:"type:varchar(10);not null;default:'gauge'" json:"kind"`
	LastValue   string     `gorm:"type:varchar(500)" json:"last_value"`
	LastNumeric *float64   `json:"last_numeric"`
	LastError   string     `gorm:"type:varchar(200)" json:"last_error"` // 如 no_such_object（设备不实现该 OID）
	PolledAt    *time.Time `json:"polled_at"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

func (DeviceSNMPOID) TableName() string { return "device_snmp_oids" }

// ── DeviceMetricPoint ──────────────────────────────────────────────────────────
// 自定义 OID 的数值时序（只收数值型采集值；字符串型 OID 仅保留快照）。
// gauge 存原值，counter 已在入库时换算为每秒速率。写入方是采集链路
// （applySNMPResult），保留策略见 snmp.metrics_max_age_days。
// 索引：idx_metric_series (oid_id, reported_at) 服务趋势查询；reported_at 单列
// 服务保留清理。DeviceID 冗余存储，供删除设备时级联清理。

type DeviceMetricPoint struct {
	ID         uint      `gorm:"primaryKey" json:"id"`
	OIDID      uint      `gorm:"column:oid_id;not null;index:idx_metric_series,priority:1" json:"oid_id"`
	DeviceID   uint      `gorm:"not null;index" json:"device_id"`
	Value      float64   `gorm:"not null" json:"value"`
	ReportedAt time.Time `gorm:"not null;index;index:idx_metric_series,priority:2" json:"reported_at"`
}

func (DeviceMetricPoint) TableName() string { return "device_metric_points" }

// ── DeviceMetricRollup ─────────────────────────────────────────────────────────
// 指标时序的降采样归档层（与 probe_rollups 同构的 Cacti RRA 模式）：每小时把
// device_metric_points 原始点聚合到各粒度桶（config snmp.metric_rollups），
// 存 val_sum/val_cnt 而非均值——跨层/跨桶重聚合时加权平均保持精确。
// 唯一键 (oid_id, bucket_seconds, bucket_ts) 支撑幂等 upsert。

type DeviceMetricRollup struct {
	ID            uint    `gorm:"primaryKey" json:"id"`
	OIDID         uint    `gorm:"column:oid_id;not null;uniqueIndex:idx_metric_rollup,priority:1" json:"oid_id"`
	DeviceID      uint    `gorm:"not null;index" json:"device_id"` // 冗余，删设备级联清理用
	BucketSeconds int     `gorm:"not null;uniqueIndex:idx_metric_rollup,priority:2" json:"bucket_seconds"`
	BucketTs      int64   `gorm:"column:bucket_ts;not null;uniqueIndex:idx_metric_rollup,priority:3;index" json:"bucket_ts"`
	ValSum        float64 `gorm:"not null;default:0" json:"val_sum"`
	ValCnt        int64   `gorm:"not null;default:0" json:"val_cnt"`
	MinVal        float64 `gorm:"not null;default:0" json:"min_val"`
	MaxVal        float64 `gorm:"not null;default:0" json:"max_val"`
}

func (DeviceMetricRollup) TableName() string { return "device_metric_rollups" }

// ── DeviceInterface ────────────────────────────────────────────────────────────
// 接口维表：设备开启 collect_interfaces 后，采集链路每周期 WALK ifTable/ifXTable
// 两个子树 reconcile 本表（新增/更新/删除消失的接口）。In/OutBps 由服务端用相邻
// 两次采样的原始计数器换算（HC 64 位优先），原始计数器列 json:"-" 不外发。
// 这是"当前状态"快照——按接口的历史趋势不在此表（关键端口请用自定义 OID +
// counter 类型获得完整时序）。

type DeviceInterface struct {
	ID          uint     `gorm:"primaryKey" json:"id"`
	DeviceID    uint     `gorm:"not null;index;uniqueIndex:idx_dev_if,priority:1" json:"device_id"`
	IfIndex     int      `gorm:"column:if_index;not null;uniqueIndex:idx_dev_if,priority:2" json:"if_index"`
	Name        string   `gorm:"type:varchar(128)" json:"name"`  // ifName 优先，回退 ifDescr
	Alias       string   `gorm:"type:varchar(255)" json:"alias"` // ifAlias（运维备注）
	IfType      int      `gorm:"column:if_type" json:"if_type"`
	SpeedMbps   int64    `json:"speed_mbps"`                  // ifHighSpeed 优先；回退 ifSpeed/1e6
	AdminStatus int      `json:"admin_status"`                // 1 up / 2 down / 3 testing
	OperStatus  int      `json:"oper_status"`                 // 1 up … 7 lowerLayerDown（RFC 2863）
	InBps       *float64 `gorm:"column:in_bps" json:"in_bps"` // bit/s，首个采样周期为 NULL
	OutBps      *float64 `gorm:"column:out_bps" json:"out_bps"`
	InErrors    int64    `json:"in_errors"` // 累计错误计数（原值）
	OutErrors   int64    `json:"out_errors"`
	// 速率换算基准（原始计数器 + 上次采样时刻），不外发
	LastInOctets  *uint64    `gorm:"column:last_in_octets" json:"-"`
	LastOutOctets *uint64    `gorm:"column:last_out_octets" json:"-"`
	PolledAt      *time.Time `json:"polled_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

func (DeviceInterface) TableName() string { return "device_interfaces" }

// ── DeviceAuditLog ─────────────────────────────────────────────────────────────

type DeviceAuditLog struct {
	ID           uint      `gorm:"primaryKey" json:"id"`
	Username     string    `gorm:"type:varchar(100);not null;index" json:"username"`
	Action       string    `gorm:"type:varchar(50);not null" json:"action"`
	ResourceType string    `gorm:"type:varchar(50);not null" json:"resource_type"`
	ResourceID   *uint     `json:"resource_id"`
	Detail       string    `gorm:"type:text" json:"detail"`
	CreatedAt    time.Time `gorm:"index" json:"created_at"`
}

func (DeviceAuditLog) TableName() string { return "device_audit_logs" }
