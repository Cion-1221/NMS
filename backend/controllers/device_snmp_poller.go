package controllers

// 设备 SNMP 采集链路的 Server 侧实现：
//
//   - applySNMPResult：唯一的落库路径。Direct 模式的内置 poller 与 Agent 代理上报
//     （agent_sync_api.go 的 PostAgentSNMPResults）都汇聚到这里，保证两种采集模式
//     的状态机行为完全一致（快照 upsert / oper_status 翻转 / 重启检测）。
//   - StartDeviceSNMPPoller：Direct 模式内置轮询器（worker pool + 到期扫描）。
//   - StartDeviceOperStatusSweeper：全局看门狗。采集结论停滞（Agent 断电/poller
//     卡死）时把 oper_status 归位为 unknown，防止"幽灵 up"永久残留。
//
// 状态机约定（详见 models.Device 注释）：
//   up      —— 最近一次采集成功
//   down    —— 最近一次采集明确失败（超时/SNMP 错误），设备大概率真的有问题
//   unknown —— 没有可信结论：未开启采集、从未采集、采集链路本身断了（watchdog）

import (
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"nms-backend/core"
	"nms-backend/models"

	"github.com/gin-gonic/gin"
	"github.com/gosnmp/gosnmp"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// SNMPConfig 对应 config.yaml 的 snmp 块（默认值见 main.go 的 viper.SetDefault）。
type SNMPConfig struct {
	Enabled                bool
	DefaultIntervalSeconds int          // 设备未单独配置 snmp_interval_seconds 时的快轮询间隔
	InventoryEveryN        int          // 每 N 次快轮询附带一次完整 system 组采集
	TimeoutSeconds         int          // 单次 SNMP 请求超时
	Retries                int          // 超时重试次数（gosnmp 语义：总请求数 = 1 + Retries）
	MaxConcurrent          int          // Direct poller 并发上限
	MetricsMaxAgeDays      int          // 自定义 OID 时序点保留天数（0 = 永久）
	MetricRollups          []RollupTier // 指标归档层（空 = 不启用；见 device_metric_rollup.go）
	// Secrets 凭证静态加密盒（snmp.credentials_key 配置后非 nil）。写路径 Seal，
	// 读路径（poller/任务合成/立即测试）Open；nil 时两者明文直通。
	Secrets *core.SecretBox
}

// openSNMPSecret 解封静态加密的凭证。解密失败（密钥被更换/移除）记日志并返回
// 空串——上层按"凭证缺失"处理，呈现为明确的采集失败，绝不把密文当密码去撞设备。
func openSNMPSecret(cfg SNMPConfig, deviceID uint, field, stored string) string {
	v, err := cfg.Secrets.Open(stored)
	if err != nil {
		slog.Error("SNMP 凭证解密失败", "device_id", deviceID, "field", field, "err", err)
		return ""
	}
	return v
}

// sealSNMPSecret 封装写路径加密（nil 安全，未启用加密时明文直通）。
func sealSNMPSecret(cfg SNMPConfig, plain string) string {
	return cfg.Secrets.Seal(plain)
}

// ── SNMPv3（USM）协议映射 ─────────────────────────────────────────────────────

var v3AuthProtos = map[string]gosnmp.SnmpV3AuthProtocol{
	"MD5": gosnmp.MD5, "SHA": gosnmp.SHA, "SHA224": gosnmp.SHA224,
	"SHA256": gosnmp.SHA256, "SHA384": gosnmp.SHA384, "SHA512": gosnmp.SHA512,
}

var v3PrivProtos = map[string]gosnmp.SnmpV3PrivProtocol{
	"DES": gosnmp.DES, "AES": gosnmp.AES, "AES192": gosnmp.AES192,
	"AES256": gosnmp.AES256, "AES192C": gosnmp.AES192C, "AES256C": gosnmp.AES256C,
}

// buildUSMSecurity 把设备的 v3 配置装配为 gosnmp 的 MsgFlags + USM 参数。
// 安全级别由字段组合推导（建库校验已保证 privProto 依赖 authProto）。
func buildUSMSecurity(user, authProto, authPass, privProto, privPass string) (gosnmp.SnmpV3MsgFlags, *gosnmp.UsmSecurityParameters) {
	flags := gosnmp.NoAuthNoPriv
	sp := &gosnmp.UsmSecurityParameters{UserName: user}
	if authProto != "" {
		flags = gosnmp.AuthNoPriv
		sp.AuthenticationProtocol = v3AuthProtos[authProto]
		sp.AuthenticationPassphrase = authPass
		if privProto != "" {
			flags = gosnmp.AuthPriv
			sp.PrivacyProtocol = v3PrivProtos[privProto]
			sp.PrivacyPassphrase = privPass
		}
	}
	return flags, sp
}

// Normalize 兜底非法配置值，避免 0 值导致除零/忙轮询。
func (c *SNMPConfig) Normalize() {
	if c.DefaultIntervalSeconds < 10 {
		c.DefaultIntervalSeconds = 60
	}
	if c.InventoryEveryN < 1 {
		c.InventoryEveryN = 10
	}
	if c.TimeoutSeconds < 1 {
		c.TimeoutSeconds = 3
	}
	if c.Retries < 0 {
		c.Retries = 1
	}
	if c.MaxConcurrent < 1 {
		c.MaxConcurrent = 16
	}
}

// RFC 1213 system 组标量 OID（第一阶段固定集合，无需 MIB）。
const (
	oidSysDescr    = "1.3.6.1.2.1.1.1.0"
	oidSysObjectID = "1.3.6.1.2.1.1.2.0"
	oidSysUpTime   = "1.3.6.1.2.1.1.3.0"
	oidSysContact  = "1.3.6.1.2.1.1.4.0"
	oidSysName     = "1.3.6.1.2.1.1.5.0"
	oidSysLocation = "1.3.6.1.2.1.1.6.0"
)

// ── 接口表（ifTable/ifXTable）────────────────────────────────────────────────

// ifTable / ifXTable 的表项子树（一次 WALK 各取整个子树，按列号分拣）。
const (
	oidIfTableEntry  = "1.3.6.1.2.1.2.2.1"
	oidIfXTableEntry = "1.3.6.1.2.1.31.1.1.1"
)

// maxInterfacesPerDevice 防御上限：核心机框可达数千逻辑接口，超出部分丢弃并记
// 日志（按 ifIndex 升序保留前 N 个）。
const maxInterfacesPerDevice = 512

// snmpInterfaceIn 一个接口的采集值（direct 本地生成 / Agent 上报还原）。
// In/OutOctets 是原始计数器（HC 64 位优先），速率由服务端用相邻采样换算。
type snmpInterfaceIn struct {
	IfIndex     int    `json:"if_index"`
	Name        string `json:"name"`
	Alias       string `json:"alias"`
	IfType      int    `json:"if_type"`
	SpeedMbps   int64  `json:"speed_mbps"`
	AdminStatus int    `json:"admin_status"`
	OperStatus  int    `json:"oper_status"`
	InOctets    uint64 `json:"in_octets"`
	OutOctets   uint64 `json:"out_octets"`
	InErrors    int64  `json:"in_errors"`
	OutErrors   int64  `json:"out_errors"`
}

// snmpOIDValue 自定义 OID 的单个采集值（direct 本地生成 / Agent 上报还原）。
type snmpOIDValue struct {
	OID     string   `json:"oid"`
	Value   string   `json:"value"`             // 字符串表示（计数器为十进制、OctetString 为文本）
	Numeric *float64 `json:"numeric,omitempty"` // 数值类型的浮点表示；非数值为 nil
	Err     string   `json:"error,omitempty"`   // no_such_object 等（设备不实现该 OID）
}

// snmpObservation 一次 SNMP 采集的结论——direct poller 本地生成，或由 Agent 上报
// 端点从 JSON 还原。字段语义与 Agent 端 probe.SNMPResult 保持一一对应。
// CollectedAt 是采集时刻（零值回退为入库时刻）：counter 速率换算与时序点的时间
// 基准必须用它——Agent 批量上报会把同一设备的多个采集点在几毫秒内先后送达，
// 用入库时刻算速率会得到 dt≈0 的天文数字假点。
type snmpObservation struct {
	CollectedAt  time.Time
	Success      bool
	ErrorKind    string // 归类错误（写 devices.oper_reason）：no_target/unreachable/snmp_timeout/snmp_error/auth_fail
	Error        string // 原始错误文本（写 device_snmp_states.last_error）
	LatencyMs    *float64
	UptimeTicks  *int64 // sysUpTime TimeTicks；nil = 本次未取到
	HasInventory bool   // 本次是否包含完整 system 组（慢轮询）
	SysName      string
	SysDescr     string
	SysObjectID  string
	SysLocation  string
	SysContact   string
	Values       []snmpOIDValue // 自定义 OID 的采集值（随每次快轮询）
	// HasInterfaces 区分"WALK 成功但零接口"（reconcile 清空维表）与"本次没走/
	// WALK 失败"（不动维表，保留最后已知状态）
	HasInterfaces bool
	Interfaces    []snmpInterfaceIn
}

// applySNMPResult 把一次采集结论写入数据库：
//  1. 重启检测：新 uptime < 旧 uptime 即判定设备重启过，落审计日志（username=system）。
//     注意 32 位 TimeTicks 约 497 天自然回绕也会触发一次误报——概率极低，可接受。
//  2. upsert device_snmp_states 快照（LastPollAt 无论成败都刷新，它是 watchdog 依据）。
//  3. 翻转 devices.oper_status/oper_reason。用 UpdateColumns 且仅在值变化时写：
//     不触碰 devices.updated_at（该字段语义保留给"用户配置修改时间"），也避免每个
//     采集周期都产生一次无效 UPDATE。polling_mode='none' 守卫防御停用后迟到的结果
//     把状态写回去（幽灵状态）。
//
// 返回值 stale=true 表示结论被单调性守卫丢弃（乱序/重放，未做任何处理），供
// Agent 上报端点单独计数；写库失败等内部错误不算 stale（已尝试处理，错误落日志）。
func applySNMPResult(db *gorm.DB, deviceID uint, sourceAgentID *string, obs snmpObservation) (stale bool) {
	now := time.Now()
	// 采集时刻（速率换算/时序时间轴的基准）；缺失或明显异常（未来 5 分钟以上、
	// 过去 1 小时以上——Agent 时钟漂移或积压陈旧数据）时回退为入库时刻
	at := obs.CollectedAt
	if at.IsZero() || at.After(now.Add(5*time.Minute)) || at.Before(now.Add(-time.Hour)) {
		at = now
	}

	// 重启检测需要旧 uptime，单调性守卫需要旧采集时刻，都必须在 upsert 之前读
	var prev struct {
		UptimeTicks     *int64
		LastCollectedAt *time.Time
	}
	prevErr := db.Model(&models.DeviceSNMPState{}).
		Select("uptime_ticks, last_collected_at").Where("device_id = ?", deviceID).Take(&prev).Error

	// 单调性守卫（仅对携带采集时刻的上报生效，direct poller 的 CollectedAt 为零值
	// 天然跳过）：Agent 上报重试会把整批快照延迟几分钟原样重放，期间可能已有更新的
	// 结论落库——采集时刻不晚于已处理值的结论直接丢弃，防止状态机/快照倒退。
	// 相等即丢弃（重复重放的典型特征）；被钳制的 at=now 单调递增，不会误伤。
	if !obs.CollectedAt.IsZero() && prevErr == nil &&
		prev.LastCollectedAt != nil && !at.After(*prev.LastCollectedAt) {
		slog.Debug("丢弃乱序/重放的 SNMP 结论", "device_id", deviceID,
			"collected_at", at, "last_collected_at", *prev.LastCollectedAt)
		return true
	}

	state := models.DeviceSNMPState{DeviceID: deviceID, LastPollAt: &now, LastCollectedAt: &at, UpdatedAt: now}
	assign := map[string]interface{}{
		"last_poll_at":      now,
		"last_collected_at": at,
		"updated_at":        now,
	}
	if sourceAgentID != nil {
		state.SourceAgentID = sourceAgentID
		assign["source_agent_id"] = *sourceAgentID
	} else {
		assign["source_agent_id"] = nil
	}
	if obs.Success {
		state.LastSuccessAt = &now
		state.LatencyMs = obs.LatencyMs
		assign["last_success_at"] = now
		assign["last_error"] = ""
		assign["latency_ms"] = obs.LatencyMs
		if obs.UptimeTicks != nil {
			bootTime := now.Add(-time.Duration(*obs.UptimeTicks) * 10 * time.Millisecond)
			state.UptimeTicks = obs.UptimeTicks
			state.BootTime = &bootTime
			assign["uptime_ticks"] = *obs.UptimeTicks
			assign["boot_time"] = bootTime
		}
		if obs.HasInventory {
			state.SysName, state.SysDescr = obs.SysName, obs.SysDescr
			state.SysObjectID, state.SysLocation, state.SysContact = obs.SysObjectID, obs.SysLocation, obs.SysContact
			assign["sys_name"] = obs.SysName
			assign["sys_descr"] = obs.SysDescr
			assign["sys_object_id"] = obs.SysObjectID
			assign["sys_location"] = obs.SysLocation
			assign["sys_contact"] = obs.SysContact
		}
	} else {
		state.LastError = obs.Error
		assign["last_error"] = obs.Error
	}
	if err := db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "device_id"}},
		DoUpdates: clause.Assignments(assign),
	}).Create(&state).Error; err != nil {
		slog.Error("SNMP 状态快照写入失败", "device_id", deviceID, "err", err)
		return
	}

	// 重启检测（成功采集且新旧 uptime 均存在时才有意义）
	if obs.Success && obs.UptimeTicks != nil && prevErr == nil &&
		prev.UptimeTicks != nil && *obs.UptimeTicks < *prev.UptimeTicks {
		id := deviceID
		writeDeviceAudit(db, "system", "reboot_detected", "device", &id,
			fmt.Sprintf("SNMP sysUpTime went backwards (%d → %d ticks) — device likely rebooted",
				*prev.UptimeTicks, *obs.UptimeTicks))
		slog.Warn("SNMP 检测到设备疑似重启", "device_id", deviceID,
			"prev_ticks", *prev.UptimeTicks, "new_ticks", *obs.UptimeTicks)
	}

	// 自定义 OID：快照回写 + 数值时序入库。先取定义行（需要 Kind 与上一次原值做
	// counter 速率换算），采集在途期间被用户删除的 OID 自然不在 map 里，静默丢弃。
	if len(obs.Values) > 0 {
		var oidRows []models.DeviceSNMPOID
		db.Where("device_id = ?", deviceID).Find(&oidRows)
		byOID := make(map[string]*models.DeviceSNMPOID, len(oidRows))
		for i := range oidRows {
			byOID[oidRows[i].OID] = &oidRows[i]
		}
		points := make([]models.DeviceMetricPoint, 0, len(obs.Values))
		for _, v := range obs.Values {
			row, ok := byOID[v.OID]
			if !ok {
				continue
			}
			// 时序点（仅数值型且本次无错）：gauge 存原值；counter 用相邻两次采样
			// 换算每秒速率——差值为负（回绕/设备重置）跳过；dt < 1s（时钟回拨、
			// 重复上报或异常密集采样）同样跳过，避免除以近零产生假尖峰。
			// 时间基准一律用采集时刻 at，快照照常更新。
			if v.Err == "" && v.Numeric != nil {
				switch row.Kind {
				case "counter":
					if row.LastNumeric != nil && row.PolledAt != nil {
						dt := at.Sub(*row.PolledAt).Seconds()
						delta := *v.Numeric - *row.LastNumeric
						if dt >= 1 && delta >= 0 {
							points = append(points, models.DeviceMetricPoint{
								OIDID: row.ID, DeviceID: deviceID, Value: delta / dt, ReportedAt: at,
							})
						}
					}
				default: // gauge
					points = append(points, models.DeviceMetricPoint{
						OIDID: row.ID, DeviceID: deviceID, Value: *v.Numeric, ReportedAt: at,
					})
				}
			}
			db.Model(&models.DeviceSNMPOID{}).Where("id = ?", row.ID).
				UpdateColumns(map[string]interface{}{
					"last_value":   v.Value,
					"last_numeric": v.Numeric,
					"last_error":   v.Err,
					"polled_at":    at,
					"updated_at":   now,
				})
		}
		if len(points) > 0 {
			if err := db.Create(&points).Error; err != nil {
				slog.Error("SNMP 指标时序写入失败", "device_id", deviceID, "err", err)
			}
		}
	}

	// 接口维表 reconcile：upsert 本次看到的接口（速率由相邻采样换算），删除消失的。
	// 只有 HasInterfaces=true（WALK 明确成功）才动维表——WALK 失败保留最后已知状态。
	if obs.HasInterfaces {
		var existing []models.DeviceInterface
		db.Where("device_id = ?", deviceID).Find(&existing)
		prevByIdx := make(map[int]*models.DeviceInterface, len(existing))
		for i := range existing {
			prevByIdx[existing[i].IfIndex] = &existing[i]
		}
		truncRunes := func(s string, n int) string {
			if r := []rune(s); len(r) > n {
				return string(r[:n])
			}
			return s
		}
		seen := make([]int, 0, len(obs.Interfaces))
		for _, in := range obs.Interfaces {
			seen = append(seen, in.IfIndex)
			// 速率：Δ计数器 ×8 / Δt。计数器回退（回绕/设备重置）或 dt<1s 时置 NULL
			//（不显示陈旧速率），下个周期恢复
			var inBps, outBps *float64
			if prev := prevByIdx[in.IfIndex]; prev != nil && prev.PolledAt != nil {
				dt := at.Sub(*prev.PolledAt).Seconds()
				if dt >= 1 {
					if prev.LastInOctets != nil && in.InOctets >= *prev.LastInOctets {
						r := float64(in.InOctets-*prev.LastInOctets) * 8 / dt
						inBps = &r
					}
					if prev.LastOutOctets != nil && in.OutOctets >= *prev.LastOutOctets {
						r := float64(in.OutOctets-*prev.LastOutOctets) * 8 / dt
						outBps = &r
					}
				}
			}
			inO, outO := in.InOctets, in.OutOctets
			row := models.DeviceInterface{
				DeviceID: deviceID, IfIndex: in.IfIndex,
				Name: truncRunes(in.Name, 128), Alias: truncRunes(in.Alias, 255),
				IfType: in.IfType, SpeedMbps: in.SpeedMbps,
				AdminStatus: in.AdminStatus, OperStatus: in.OperStatus,
				InBps: inBps, OutBps: outBps,
				InErrors: in.InErrors, OutErrors: in.OutErrors,
				LastInOctets: &inO, LastOutOctets: &outO,
				PolledAt: &at, UpdatedAt: now,
			}
			if err := db.Clauses(clause.OnConflict{
				Columns: []clause.Column{{Name: "device_id"}, {Name: "if_index"}},
				DoUpdates: clause.Assignments(map[string]interface{}{
					"name": row.Name, "alias": row.Alias, "if_type": row.IfType,
					"speed_mbps": row.SpeedMbps, "admin_status": row.AdminStatus,
					"oper_status": row.OperStatus, "in_bps": inBps, "out_bps": outBps,
					"in_errors": row.InErrors, "out_errors": row.OutErrors,
					"last_in_octets": inO, "last_out_octets": outO,
					"polled_at": at, "updated_at": now,
				}),
			}).Create(&row).Error; err != nil {
				slog.Error("接口维表写入失败", "device_id", deviceID, "if_index", in.IfIndex, "err", err)
			}
		}
		if len(seen) > 0 {
			db.Where("device_id = ? AND if_index NOT IN ?", deviceID, seen).
				Delete(&models.DeviceInterface{})
		} else {
			db.Where("device_id = ?", deviceID).Delete(&models.DeviceInterface{})
		}
	}

	newStatus, newReason := "up", ""
	if !obs.Success {
		newStatus, newReason = "down", obs.ErrorKind
	}
	db.Model(&models.Device{}).
		Where("id = ? AND polling_mode <> 'none' AND (oper_status <> ? OR oper_reason <> ?)",
			deviceID, newStatus, newReason).
		UpdateColumns(map[string]interface{}{"oper_status": newStatus, "oper_reason": newReason})
	return false
}

// classifySNMPError 把 gosnmp 错误文本归类为 oper_reason。
// v3 有显式的认证失败报文（USM 统计/摘要错误）；v1/v2c 协议下 community 错误的
// 表现就是无响应（等同超时），无法与真离线区分——这是协议限制。
// notInTimeWindow（usmStatsNotInTimeWindows）必须在 usm 匹配之前单独识别：它是
// v3 时间窗重同步信号（gosnmp 收到 Report 后自动重同步并重试），偶发残留属于
// 时钟漂移/网络抖动，归类为普通 snmp_error 而非 auth_fail，避免把"等一轮就好"
// 误报成"凭证错误"。
func classifySNMPError(err error) string {
	e := strings.ToLower(err.Error())
	switch {
	case strings.Contains(e, "time window"), strings.Contains(e, "timewindow"):
		return "snmp_error"
	case strings.Contains(e, "usm"), strings.Contains(e, "authent"),
		strings.Contains(e, "unknown user"), strings.Contains(e, "wrong digest"),
		strings.Contains(e, "decryption"):
		return "auth_fail"
	case strings.Contains(e, "timeout"):
		return "snmp_timeout"
	default:
		return "snmp_error"
	}
}

// snmpCollect 对单台设备执行一次 SNMP GET（Direct 模式）。full=true 采完整 system
// 组，false 只采 sysUpTime（快轮询，兼做存活判定，报文最小化）；extraOIDs 为设备
// 的自定义标量 OID，无论快慢档都随包一并 GET（≤16 条，单报文完成）。
func snmpCollect(dev models.Device, extraOIDs []models.DeviceSNMPOID, cfg SNMPConfig, full bool) snmpObservation {
	target := ""
	if dev.ManagementIP != nil && *dev.ManagementIP != "" {
		target = *dev.ManagementIP
	} else if dev.ManagementIPv6 != nil && *dev.ManagementIPv6 != "" {
		target = *dev.ManagementIPv6
	}
	if target == "" {
		return snmpObservation{ErrorKind: "no_target", Error: "device has no management IP"}
	}

	g := &gosnmp.GoSNMP{
		Target:  target,
		Port:    uint16(dev.SNMPPort),
		Timeout: time.Duration(cfg.TimeoutSeconds) * time.Second,
		Retries: cfg.Retries,
	}
	switch dev.SNMPVersion {
	case "3":
		user := ""
		if dev.SNMPV3User != nil {
			user = *dev.SNMPV3User
		}
		authProto, privProto := "", ""
		if dev.SNMPV3AuthProto != nil {
			authProto = *dev.SNMPV3AuthProto
		}
		if dev.SNMPV3PrivProto != nil {
			privProto = *dev.SNMPV3PrivProto
		}
		authPass, privPass := "", ""
		if authProto != "" && dev.SNMPV3AuthPass != nil {
			authPass = openSNMPSecret(cfg, dev.ID, "v3_auth_pass", *dev.SNMPV3AuthPass)
			if authPass == "" {
				return snmpObservation{ErrorKind: "auth_fail", Error: "v3 auth passphrase unavailable (decrypt failed or not set)"}
			}
		}
		if privProto != "" && dev.SNMPV3PrivPass != nil {
			privPass = openSNMPSecret(cfg, dev.ID, "v3_priv_pass", *dev.SNMPV3PrivPass)
			if privPass == "" {
				return snmpObservation{ErrorKind: "auth_fail", Error: "v3 privacy passphrase unavailable (decrypt failed or not set)"}
			}
		}
		flags, sp := buildUSMSecurity(user, authProto, authPass, privProto, privPass)
		g.Version = gosnmp.Version3
		g.SecurityModel = gosnmp.UserSecurityModel
		g.MsgFlags = flags
		g.SecurityParameters = sp
	case "1":
		g.Version = gosnmp.Version1
		g.Community = openSNMPSecret(cfg, dev.ID, "community", dev.SNMPCommunity)
	default: // "2c"
		g.Version = gosnmp.Version2c
		g.Community = openSNMPSecret(cfg, dev.ID, "community", dev.SNMPCommunity)
	}

	if err := g.Connect(); err != nil {
		return snmpObservation{ErrorKind: "unreachable", Error: "connect: " + err.Error()}
	}
	defer g.Conn.Close()

	oids := []string{oidSysUpTime}
	if full {
		oids = []string{oidSysUpTime, oidSysName, oidSysDescr, oidSysObjectID, oidSysLocation, oidSysContact}
	}
	for _, x := range extraOIDs {
		oids = append(oids, x.OID)
	}

	start := time.Now()
	pkt, err := g.Get(oids)
	if err != nil {
		return snmpObservation{ErrorKind: classifySNMPError(err), Error: err.Error()}
	}
	latency := float64(time.Since(start)) / float64(time.Millisecond)
	if pkt.Error != gosnmp.NoError {
		return snmpObservation{ErrorKind: "snmp_error", Error: "SNMP error status: " + pkt.Error.String()}
	}

	obs := snmpObservation{Success: true, LatencyMs: &latency, HasInventory: full}
	parseSNMPSystemVars(pkt.Variables, &obs)
	if len(extraOIDs) > 0 {
		obs.Values = parseSNMPExtraValues(pkt.Variables, extraOIDs)
	}
	// 接口表：WALK 失败不影响本次采集结论（scalar GET 已成功），维表保留最后已知状态
	if dev.CollectInterfaces {
		if ifs, err := collectSNMPInterfaces(g); err != nil {
			slog.Warn("接口表 WALK 失败", "device_id", dev.ID, "err", err)
		} else {
			obs.HasInterfaces = true
			obs.Interfaces = ifs
		}
	}
	return obs
}

// collectSNMPInterfaces WALK ifTable + ifXTable 两个子树并按列号组装接口列表。
// ifXTable 失败被容忍（老设备/v1 常无此表，退回 32 位计数器与 ifDescr）。
// v2c/v3 用 GETBULK 遍历，v1 退回逐个 GETNEXT。
func collectSNMPInterfaces(g *gosnmp.GoSNMP) ([]snmpInterfaceIn, error) {
	walk := g.BulkWalkAll
	if g.Version == gosnmp.Version1 {
		walk = g.WalkAll
	}

	type ifRow struct {
		snmpInterfaceIn
		descr       string
		spdBps      int64   // ifSpeed（bit/s，32 位，10G 以上饱和）
		spdMbps     int64   // ifHighSpeed（Mbps，权威）
		hcIn, hcOut *uint64 // HC 64 位计数器（存在即优先）
	}
	rows := map[int]*ifRow{}
	get := func(idx int) *ifRow {
		r, ok := rows[idx]
		if !ok {
			r = &ifRow{}
			r.IfIndex = idx
			rows[idx] = r
		}
		return r
	}
	asStr := func(v gosnmp.SnmpPDU) string {
		if b, ok := v.Value.([]byte); ok {
			return strings.TrimSpace(string(b))
		}
		if s, ok := v.Value.(string); ok {
			return strings.TrimSpace(s)
		}
		return ""
	}
	asInt := func(v gosnmp.SnmpPDU) int64 {
		if n := gosnmp.ToBigInt(v.Value); n != nil {
			return n.Int64()
		}
		return 0
	}
	asUint := func(v gosnmp.SnmpPDU) uint64 {
		if n := gosnmp.ToBigInt(v.Value); n != nil {
			return n.Uint64()
		}
		return 0
	}
	// 表项变量名形如 <entry>.<列号>.<ifIndex>（ifTable 索引是单个整数）
	dispatch := func(pdus []gosnmp.SnmpPDU, entry string, handle func(r *ifRow, col int, v gosnmp.SnmpPDU)) {
		prefix := entry + "."
		for _, v := range pdus {
			rest := strings.TrimPrefix(strings.TrimPrefix(v.Name, "."), prefix)
			if rest == strings.TrimPrefix(v.Name, ".") {
				continue // 不在该子树（防御）
			}
			parts := strings.SplitN(rest, ".", 2)
			if len(parts) != 2 {
				continue
			}
			col, err1 := strconv.Atoi(parts[0])
			idx, err2 := strconv.Atoi(parts[1])
			if err1 != nil || err2 != nil {
				continue
			}
			handle(get(idx), col, v)
		}
	}

	pdus, err := walk(oidIfTableEntry)
	if err != nil {
		return nil, err
	}
	dispatch(pdus, oidIfTableEntry, func(r *ifRow, col int, v gosnmp.SnmpPDU) {
		switch col {
		case 2:
			r.descr = asStr(v)
		case 3:
			r.IfType = int(asInt(v))
		case 5:
			r.spdBps = asInt(v)
		case 7:
			r.AdminStatus = int(asInt(v))
		case 8:
			r.OperStatus = int(asInt(v))
		case 10:
			r.InOctets = asUint(v)
		case 14:
			r.InErrors = asInt(v)
		case 16:
			r.OutOctets = asUint(v)
		case 20:
			r.OutErrors = asInt(v)
		}
	})
	if xpdus, xerr := walk(oidIfXTableEntry); xerr == nil {
		dispatch(xpdus, oidIfXTableEntry, func(r *ifRow, col int, v gosnmp.SnmpPDU) {
			switch col {
			case 1:
				r.Name = asStr(v)
			case 6:
				u := asUint(v)
				r.hcIn = &u
			case 10:
				u := asUint(v)
				r.hcOut = &u
			case 15:
				r.spdMbps = asInt(v)
			case 18:
				r.Alias = asStr(v)
			}
		})
	}

	idxs := make([]int, 0, len(rows))
	for idx := range rows {
		idxs = append(idxs, idx)
	}
	sort.Ints(idxs)
	if len(idxs) > maxInterfacesPerDevice {
		slog.Warn("接口数量超过上限，仅保留前 N 个（按 ifIndex）",
			"total", len(idxs), "kept", maxInterfacesPerDevice)
		idxs = idxs[:maxInterfacesPerDevice]
	}
	out := make([]snmpInterfaceIn, 0, len(idxs))
	for _, idx := range idxs {
		r := rows[idx]
		if r.Name == "" {
			r.Name = r.descr
		}
		if r.spdMbps > 0 {
			r.SpeedMbps = r.spdMbps
		} else {
			r.SpeedMbps = r.spdBps / 1_000_000
		}
		if r.hcIn != nil {
			r.InOctets = *r.hcIn
		}
		if r.hcOut != nil {
			r.OutOctets = *r.hcOut
		}
		out = append(out, r.snmpInterfaceIn)
	}
	return out, nil
}

// parseSNMPExtraValues 从响应变量中提取自定义 OID 的值。定义顺序无关——按归一化
// OID 精确匹配；system 组变量天然不在 wanted 集内会被跳过。
func parseSNMPExtraValues(vars []gosnmp.SnmpPDU, extraOIDs []models.DeviceSNMPOID) []snmpOIDValue {
	wanted := make(map[string]bool, len(extraOIDs))
	for _, x := range extraOIDs {
		wanted[x.OID] = true
	}
	out := make([]snmpOIDValue, 0, len(extraOIDs))
	for _, v := range vars {
		oid := strings.TrimPrefix(v.Name, ".")
		if !wanted[oid] {
			continue
		}
		out = append(out, decodeSNMPValue(oid, v))
	}
	return out
}

// decodeSNMPValue 把单个 PDU 解码为通用的字符串 + 可选数值表示。
func decodeSNMPValue(oid string, v gosnmp.SnmpPDU) snmpOIDValue {
	res := snmpOIDValue{OID: oid}
	switch v.Type {
	case gosnmp.NoSuchObject, gosnmp.NoSuchInstance:
		res.Err = "no_such_object"
	case gosnmp.Null:
		res.Err = "null"
	case gosnmp.OctetString:
		if b, ok := v.Value.([]byte); ok {
			res.Value = string(b)
		}
	case gosnmp.ObjectIdentifier, gosnmp.IPAddress:
		if s, ok := v.Value.(string); ok {
			res.Value = s
		}
	case gosnmp.OpaqueFloat:
		if f, ok := v.Value.(float32); ok {
			f64 := float64(f)
			res.Numeric = &f64
			res.Value = strconv.FormatFloat(f64, 'f', -1, 64)
		}
	case gosnmp.OpaqueDouble:
		if f, ok := v.Value.(float64); ok {
			res.Numeric = &f
			res.Value = strconv.FormatFloat(f, 'f', -1, 64)
		}
	default:
		// Integer/Counter32/Gauge32/Counter64/TimeTicks/Uinteger32 等整数族
		n := gosnmp.ToBigInt(v.Value)
		if n != nil {
			f := float64(n.Int64())
			res.Numeric = &f
			res.Value = n.String()
		}
	}
	return res
}

// parseSNMPSystemVars 把 system 组变量绑定到 observation 字段。Direct poller 使用；
// 变量名带不带前导点都能匹配。NoSuchObject/NoSuchInstance 等异常类型静默跳过——
// 个别标量缺失（某些精简固件不实现 sysLocation）不影响整体成功判定。
func parseSNMPSystemVars(vars []gosnmp.SnmpPDU, obs *snmpObservation) {
	asString := func(v gosnmp.SnmpPDU) string {
		switch val := v.Value.(type) {
		case []byte:
			return string(val)
		case string:
			return val
		default:
			return ""
		}
	}
	for _, v := range vars {
		switch strings.TrimPrefix(v.Name, ".") {
		case oidSysUpTime:
			if v.Type == gosnmp.TimeTicks {
				ticks := gosnmp.ToBigInt(v.Value).Int64()
				obs.UptimeTicks = &ticks
			}
		case oidSysName:
			obs.SysName = asString(v)
		case oidSysDescr:
			obs.SysDescr = asString(v)
		case oidSysObjectID:
			obs.SysObjectID = asString(v)
		case oidSysLocation:
			obs.SysLocation = asString(v)
		case oidSysContact:
			obs.SysContact = asString(v)
		}
	}
}

// TestDeviceSNMP POST /api/v1/devices/:id/snmp/test —— 手动触发一次同步采集
// （完整 system 组）。结果走 applySNMPResult 正常落库，运行状态与快照即时刷新：
// 配置完凭证点一下即可验证，不必等下一个采集周期。
// 仅支持 direct 模式：agent 模式的采集在探针侧执行（管理网段通常只有探针可达，
// Server 代为直连会得出误导性的结论），返回明确错误引导等待采集周期。
// 同步阻塞时长上限 ≈ timeout ×（1 + retries），默认约 6 秒。
func TestDeviceSNMP(db *gorm.DB, cfg SNMPConfig) gin.HandlerFunc {
	cfg.Normalize()
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var device models.Device
		if err := db.First(&device, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "设备不存在", "code": "not_found"})
			return
		}
		if device.PollingMode != "direct" {
			c.JSON(http.StatusBadRequest, codedErrJSON(&core.CodedError{
				Code: "device.snmp_test_direct_only",
				Msg:  "仅直连采集模式支持立即测试；探针代理模式请等待下一个采集周期",
			}))
			return
		}
		if device.SNMPVersion == "3" {
			if device.SNMPV3User == nil || *device.SNMPV3User == "" {
				c.JSON(http.StatusBadRequest, codedErrJSON(&core.CodedError{
					Code: "device.snmp_v3_user_required",
					Msg:  "SNMPv3 必须填写用户名",
				}))
				return
			}
		} else if device.SNMPCommunity == "" {
			c.JSON(http.StatusBadRequest, codedErrJSON(&core.CodedError{
				Code: "device.snmp_credential_required",
				Msg:  "开启 SNMP 采集必须填写 Community",
			}))
			return
		}
		var extraOIDs []models.DeviceSNMPOID
		db.Where("device_id = ?", device.ID).Order("id asc").Find(&extraOIDs)
		obs := snmpCollect(device, extraOIDs, cfg, true)
		applySNMPResult(db, device.ID, nil, obs)
		c.JSON(http.StatusOK, gin.H{
			"success":      obs.Success,
			"latency_ms":   obs.LatencyMs,
			"error_kind":   obs.ErrorKind,
			"error":        obs.Error,
			"uptime_ticks": obs.UptimeTicks,
			"sys_name":     obs.SysName,
			"sys_descr":    obs.SysDescr,
		})
	}
}

// StartDeviceSNMPPoller 启动 Direct 模式内置轮询器。
//
// 调度模型：每 5 秒扫一次"到期"设备（LEFT JOIN 状态快照，last_poll_at 距今超过
// 设备各自的采集间隔即到期），投入 worker pool 并发执行。特性：
//   - inFlight 去重：单台设备同一时刻最多一个在途请求，慢设备不会被重复排队；
//   - 并发上限 MaxConcurrent：大量设备同时到期时按信号量放行（首次启动的齐射
//     被自然摊平，之后各设备的相位由各自完成时间错开）；
//   - 快/慢两档：每 InventoryEveryN 次快轮询附带一次完整 system 组；进程重启后
//     计数器归零，首轮全部做全量采集，顺带把快照补齐。
func StartDeviceSNMPPoller(db *gorm.DB, cfg SNMPConfig) {
	cfg.Normalize()
	go func() {
		var mu sync.Mutex
		inFlight := make(map[uint]bool)
		pollCount := make(map[uint]uint64) // 仅调度 goroutine 读写
		sem := make(chan struct{}, cfg.MaxConcurrent)

		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		slog.Info("Device SNMP poller 已启动",
			"default_interval_s", cfg.DefaultIntervalSeconds, "max_concurrent", cfg.MaxConcurrent)

		for range ticker.C {
			// planned（未上架）与 offline（已停用）都不采集；时间基准用 Go 侧时钟传参，
			// 与 last_poll_at 的写入方（applySNMPResult 的 time.Now()）保持同源，
			// 避免 DB 会话时区与应用时区不一致时的判定漂移
			var due []models.Device
			err := db.
				Joins("LEFT JOIN device_snmp_states s ON s.device_id = devices.id").
				Where("devices.polling_mode = ? AND devices.status NOT IN ('planned','offline')", "direct").
				Where("s.id IS NULL OR s.last_poll_at IS NULL OR TIMESTAMPDIFF(SECOND, s.last_poll_at, ?) >= COALESCE(devices.snmp_interval_seconds, ?)",
					time.Now(), cfg.DefaultIntervalSeconds).
				Find(&due).Error
			if err != nil {
				slog.Error("SNMP 到期设备扫描失败", "err", err)
				continue
			}

			for _, d := range due {
				mu.Lock()
				if inFlight[d.ID] {
					mu.Unlock()
					continue
				}
				inFlight[d.ID] = true
				mu.Unlock()

				full := pollCount[d.ID]%uint64(cfg.InventoryEveryN) == 0
				pollCount[d.ID]++

				sem <- struct{}{}
				go func(dev models.Device, full bool) {
					defer func() {
						<-sem
						mu.Lock()
						delete(inFlight, dev.ID)
						mu.Unlock()
					}()
					// 自定义 OID 每次采集前取最新定义（用户可能刚增删；量小且有索引）
					var extraOIDs []models.DeviceSNMPOID
					db.Where("device_id = ?", dev.ID).Order("id asc").Find(&extraOIDs)
					obs := snmpCollect(dev, extraOIDs, cfg, full)
					applySNMPResult(db, dev.ID, nil, obs)
				}(d, full)
			}
		}
	}()
}

// EncryptExistingSNMPCredentials 启动时一次性把存量凭证收敛到"当前密钥密文"：
// 明文（首次启用加密）与旧密钥密文（配置了 credentials_key_previous 的轮换场景）
// 都被 Reseal 重封；已是当前密钥的密文原样跳过——幂等，重复执行零副作用。
// 两把密钥都解不开的密文记日志跳过、绝不覆盖（保留人工用正确密钥恢复的机会）。
// UpdateColumns 不触碰 updated_at（这是迁移，不是用户编辑）。
func EncryptExistingSNMPCredentials(db *gorm.DB, cfg SNMPConfig) {
	if cfg.Secrets == nil {
		return
	}
	var devices []models.Device
	db.Select("id, snmp_community, snmp_v3_auth_pass, snmp_v3_priv_pass").
		Where("snmp_community <> '' OR snmp_v3_auth_pass IS NOT NULL OR snmp_v3_priv_pass IS NOT NULL").
		Find(&devices)
	count, failed := 0, 0
	reseal := func(deviceID uint, field, stored string) (string, bool) {
		out, changed, err := cfg.Secrets.Reseal(stored)
		if err != nil {
			failed++
			slog.Error("SNMP 凭证重封失败（两把密钥均不匹配，保留原值）",
				"device_id", deviceID, "field", field, "err", err)
			return stored, false
		}
		return out, changed
	}
	for _, d := range devices {
		updates := map[string]interface{}{}
		if d.SNMPCommunity != "" {
			if s, changed := reseal(d.ID, "community", d.SNMPCommunity); changed {
				updates["snmp_community"] = s
			}
		}
		if d.SNMPV3AuthPass != nil && *d.SNMPV3AuthPass != "" {
			if s, changed := reseal(d.ID, "v3_auth_pass", *d.SNMPV3AuthPass); changed {
				updates["snmp_v3_auth_pass"] = s
			}
		}
		if d.SNMPV3PrivPass != nil && *d.SNMPV3PrivPass != "" {
			if s, changed := reseal(d.ID, "v3_priv_pass", *d.SNMPV3PrivPass); changed {
				updates["snmp_v3_priv_pass"] = s
			}
		}
		if len(updates) > 0 {
			db.Model(&models.Device{}).Where("id = ?", d.ID).UpdateColumns(updates)
			count++
		}
	}
	if count > 0 || failed > 0 {
		slog.Info("SNMP 凭证静态加密/轮换清扫完成", "resealed_devices", count, "failed", failed)
	}
}

// StartDeviceMetricRetention 启动时序点保留清理（每 12 小时一次；与 audit_retention
// 的探测结果清理同哲学，独立于 rollup 归档——时序表按 snmp.metrics_max_age_days
// 滚动保留，0 = 永久不清理，不启动本任务）。
func StartDeviceMetricRetention(db *gorm.DB, cfg SNMPConfig) {
	if cfg.MetricsMaxAgeDays <= 0 {
		return
	}
	go func() {
		ticker := time.NewTicker(12 * time.Hour)
		defer ticker.Stop()
		for {
			cutoff := time.Now().AddDate(0, 0, -cfg.MetricsMaxAgeDays)
			res := db.Where("reported_at < ?", cutoff).Delete(&models.DeviceMetricPoint{})
			if res.Error != nil {
				slog.Error("SNMP 指标时序保留清理失败", "err", res.Error)
			} else if res.RowsAffected > 0 {
				slog.Info("SNMP 指标时序保留清理完成",
					"deleted", res.RowsAffected, "max_age_days", cfg.MetricsMaxAgeDays)
			}
			<-ticker.C
		}
	}()
}

// StartDeviceOperStatusSweeper 启动运行状态看门狗（每分钟）。
//
// 连环故障场景：Agent 断电后无法上报"设备超时"，如果没有这个 sweeper，其名下所有
// 设备的 oper_status 会永远停在最后一次结论（多半是 up）。判定依据是设备自身的
// last_poll_at（最近一次拿到采集结论的时间）而非 Agent 心跳——这样 Direct 模式的
// poller 卡死同样会被兜底。阈值 = max(3 × 设备采集间隔, 300 秒)。
//
// 第二条规则处理绑定失效：指派的 Agent 被吊销或删除（snmp_agent_id 已被置 NULL）
// 时立即归位 unknown/agent_revoked，不必等结论停滞满阈值。
func StartDeviceOperStatusSweeper(db *gorm.DB, cfg SNMPConfig) {
	cfg.Normalize()
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			// 规则 0：planned/offline 设备不参与采集（poller 与任务合成都跳过），
			// 其最后一次结论必须归位 unknown（原因留空，不误导为链路故障），
			// 否则一台已停用设备会永远显示最后一次的 up/down。
			res := db.Exec(`UPDATE devices
				SET oper_status = 'unknown', oper_reason = ''
				WHERE polling_mode IN ('direct','agent')
				  AND status IN ('planned','offline')
				  AND oper_status <> 'unknown'`)
			if res.Error != nil {
				slog.Error("设备停用状态归位扫描失败", "err", res.Error)
			} else if res.RowsAffected > 0 {
				slog.Info("设备停用状态归位：已归位 unknown", "count", res.RowsAffected)
			}

			res = db.Exec(`UPDATE devices d
				LEFT JOIN device_snmp_states s ON s.device_id = d.id
				SET d.oper_status = 'unknown',
				    d.oper_reason = IF(d.polling_mode = 'agent', 'agent_down', 'poller_stale')
				WHERE d.polling_mode IN ('direct','agent')
				  AND d.status NOT IN ('planned','offline')
				  AND d.oper_status <> 'unknown'
				  AND (s.id IS NULL OR s.last_poll_at IS NULL
				       OR TIMESTAMPDIFF(SECOND, s.last_poll_at, ?) > GREATEST(COALESCE(d.snmp_interval_seconds, ?) * 3, 300))`,
				time.Now(), cfg.DefaultIntervalSeconds)
			if res.Error != nil {
				slog.Error("设备运行状态看门狗扫描失败", "err", res.Error)
			} else if res.RowsAffected > 0 {
				slog.Info("设备运行状态看门狗：采集结论停滞，已归位 unknown", "count", res.RowsAffected)
			}

			res = db.Exec(`UPDATE devices d
				LEFT JOIN agents a ON a.agent_id = d.snmp_agent_id
				SET d.oper_status = 'unknown', d.oper_reason = 'agent_revoked'
				WHERE d.polling_mode = 'agent'
				  AND d.oper_status <> 'unknown'
				  AND (d.snmp_agent_id IS NULL OR a.agent_id IS NULL OR a.revoked = 1)`)
			if res.Error != nil {
				slog.Error("设备探针绑定失效扫描失败", "err", res.Error)
			} else if res.RowsAffected > 0 {
				slog.Info("设备探针绑定失效：已归位 unknown", "count", res.RowsAffected)
			}
			<-ticker.C
		}
	}()
}
