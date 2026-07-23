package controllers

import (
	"log/slog"
	"time"

	"nms-backend/core"
	"nms-backend/models"

	"gorm.io/gorm"
)

// StartAuditRetention 启动自动保留任务，启动时立即清理一次，之后每 24 小时一次：
//   - AuditMaxAgeDays 控制 IPAM / Devices / Agent / System 四个模块的审计日志。
//   - ProbeResultsMaxAgeDays 控制原始探测点（启用归档层后可大幅缩短，长期数据由
//     probe_rollups 各归档层接力，见 probe_rollup.go）。
//   - PathResultsMaxAgeDays 独立控制路径类结果（mtr/meshmtr/traceroute，detail 为
//     大 JSON、仅消费最新快照）；0 = 跟随 ProbeResultsMaxAgeDays。
//
// 各参数 <= 0 即视为该项不启用（永久保留，仍可通过各模块的手动清理接口删除）。
// 后台 goroutine 始终启动：还承担过期 Refresh Token 的每日兜底清理。
func StartAuditRetention(db *gorm.DB, rc RetentionConfig) {
	if rc.AuditMaxAgeDays <= 0 {
		slog.Info("审计日志自动保留未启用 (audit.max_age_days = 0)")
	}
	if rc.ProbeResultsMaxAgeDays <= 0 {
		slog.Info("探测结果自动保留未启用 (audit.probe_results_max_age_days = 0)")
	}
	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			if rc.AuditMaxAgeDays > 0 {
				purgeExpiredAuditLogs(db, rc.AuditMaxAgeDays)
			}
			purgeExpiredProbeResults(db, rc)
			purgeExpiredRefreshTokens(db)
			<-ticker.C
		}
	}()
}

// purgeExpiredRefreshTokens 全局清理已过期的 Refresh Token。按用户的清理只在该用户
// 登录/刷新时触发（见 auth_api.go 的 cleanupExpiredTokens），不再回来的用户会永远
// 留下过期记录，这里每日兜底回收。
func purgeExpiredRefreshTokens(db *gorm.DB) {
	result := db.Where("expires_at < ?", time.Now()).Delete(&models.SysRefreshToken{})
	if result.Error != nil {
		slog.Error("过期 Refresh Token 清理失败", "err", result.Error)
		return
	}
	if result.RowsAffected > 0 {
		slog.Info("过期 Refresh Token 清理完成", "deleted", result.RowsAffected)
	}
}

func purgeExpiredAuditLogs(db *gorm.DB, maxAgeDays int) {
	cutoff := time.Now().AddDate(0, 0, -maxAgeDays)
	ipam := db.Where("created_at < ?", cutoff).Delete(&models.IPAMAuditLog{})
	device := db.Where("created_at < ?", cutoff).Delete(&models.DeviceAuditLog{})
	agent := db.Where("created_at < ?", cutoff).Delete(&models.AgentAuditLog{})
	sys := db.Where("created_at < ?", cutoff).Delete(&models.SysAuditLog{})
	if ipam.Error != nil || device.Error != nil || agent.Error != nil || sys.Error != nil {
		slog.Error("审计日志自动清理失败",
			"ipam_err", ipam.Error, "device_err", device.Error,
			"agent_err", agent.Error, "sys_err", sys.Error)
		return
	}
	if ipam.RowsAffected > 0 || device.RowsAffected > 0 || agent.RowsAffected > 0 || sys.RowsAffected > 0 {
		slog.Info("审计日志自动清理完成",
			"max_age_days", maxAgeDays,
			"ipam_deleted", ipam.RowsAffected,
			"device_deleted", device.RowsAffected,
			"agent_deleted", agent.RowsAffected,
			"sys_deleted", sys.RowsAffected,
		)
	}
}

// purgeExpiredProbeResults 清理过期的原始探测点。路径类结果（pathProbeTypes）配置了
// 独立保留期时按各自 cutoff 分开清理——路径类的 detail 是大 JSON，通常应短留；
// 标量延迟类的长期数据由归档层接力，原始点可以短留。
func purgeExpiredProbeResults(db *gorm.DB, rc RetentionConfig) {
	probeDays, pathDays := rc.ProbeResultsMaxAgeDays, rc.PathResultsMaxAgeDays

	if pathDays > 0 && pathDays != probeDays {
		// 分开清理：标量类按 probeDays，路径类按 pathDays
		var scalarDeleted, pathDeleted int64
		if probeDays > 0 {
			cutoff := time.Now().AddDate(0, 0, -probeDays)
			deleted, err := deleteProbeResultsChunked(db, "reported_at < ? AND type NOT IN ?", cutoff, pathProbeTypes)
			if err != nil {
				slog.Error("探测结果自动清理失败（标量类）", "err", err)
				return
			}
			scalarDeleted = deleted
		}
		pathCutoff := time.Now().AddDate(0, 0, -pathDays)
		deleted, err := deleteProbeResultsChunked(db, "reported_at < ? AND type IN ?", pathCutoff, pathProbeTypes)
		if err != nil {
			slog.Error("探测结果自动清理失败（路径类）", "err", err)
			return
		}
		pathDeleted = deleted
		if scalarDeleted > 0 || pathDeleted > 0 {
			slog.Info("探测结果自动清理完成",
				"max_age_days", probeDays, "path_max_age_days", pathDays,
				"scalar_deleted", scalarDeleted, "path_deleted", pathDeleted)
		}
		return
	}

	if probeDays <= 0 {
		return
	}
	cutoff := time.Now().AddDate(0, 0, -probeDays)
	deleted, err := deleteProbeResultsChunked(db, "reported_at < ?", cutoff)
	if err != nil {
		slog.Error("探测结果自动清理失败", "err", err)
		return
	}
	if deleted > 0 {
		slog.Info("探测结果自动清理完成", "max_age_days", probeDays, "deleted", deleted)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 磁盘空间兜底（默认关闭，audit.probe_disk_guard.enabled 开启）：2026-07-23
// 事故复盘——常规保留任务 24 小时才跑一次，那次事故里 probe_results 从有余量到
// 把磁盘（9.2G 小盘）打满、MariaDB 因无法分配 InnoDB 临时表空间而崩溃，只花了
// 几个小时，24 小时的检查周期完全来不及反应。这里加一个更高频、更激进的独立
// 兜底：定期查可用磁盘空间，跌破阈值时立即对 probe_results 做一次比正常配置
// 狠得多的紧急清理，不等下一次常规周期。生产环境磁盘通常远大于本例，默认关闭；
// 磁盘较小的部署（测试机/小型 VPS）建议开启。
// ─────────────────────────────────────────────────────────────────────────────

// diskSpaceCheckPath：磁盘检查的探针路径，用进程当前工作目录。多数部署（包括
// 2026-07-23 事故所在的单分区小盘）里这与 MariaDB 数据目录同一分区；如果你的
// 部署把数据库放在独立挂载点，这个检查覆盖不到那个分区，需要另行监控。
const diskSpaceCheckPath = "."

// DiskGuardConfig 对应 config.yaml 的 audit.probe_disk_guard 块。
type DiskGuardConfig struct {
	Enabled              bool
	CheckIntervalMinutes int
	CriticalFreeMB       int
}

// StartDiskSpaceGuard 启动磁盘空间守护 goroutine（dg.Enabled=false 时直接跳过，
// 不启动 goroutine）：立即检查一次，之后每 dg.CheckIntervalMinutes 检查一次；
// 可用空间跌破 dg.CriticalFreeMB 时对 probe_results 执行一次紧急清理。紧急清理
// 比 rc.ProbeResultsMaxAgeDays 更激进（对半砍），但不会砍破归档层要求的最小
// 原始点保留天数（否则会破坏 rollup 聚合前原始点必须存在的前提，见
// ValidateRetentionConfig）。当前平台不支持磁盘查询时（FreeDiskBytes 返回
// ok=false）静默跳过，不影响其他功能。
func StartDiskSpaceGuard(db *gorm.DB, rc RetentionConfig, dg DiskGuardConfig) {
	if !dg.Enabled {
		slog.Info("磁盘空间兜底未启用 (audit.probe_disk_guard.enabled = false)")
		return
	}
	criticalBytes := uint64(dg.CriticalFreeMB) * 1024 * 1024
	interval := time.Duration(dg.CheckIntervalMinutes) * time.Minute
	slog.Info("磁盘空间兜底已启用", "check_interval_minutes", dg.CheckIntervalMinutes, "critical_free_mb", dg.CriticalFreeMB)

	check := func() {
		free, ok := core.FreeDiskBytes(diskSpaceCheckPath)
		if !ok || free >= criticalBytes {
			return
		}
		days := emergencyPurgeCutoffDays(rc)
		slog.Error("磁盘可用空间严重不足，触发探测结果紧急清理",
			"free_bytes", free, "threshold_bytes", criticalBytes, "cutoff_days", days)
		deleted, err := deleteProbeResultsChunked(db, "reported_at < ?", time.Now().AddDate(0, 0, -days))
		if err != nil {
			slog.Error("磁盘紧急清理失败", "err", err)
			return
		}
		slog.Warn("磁盘紧急清理完成", "cutoff_days", days, "deleted", deleted)
	}
	go func() {
		check()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			check()
		}
	}()
}

// emergencyPurgeCutoffDays 计算紧急清理的保留天数：正常配置的一半，但不低于
// 归档层要求的最小原始点保留天数（未配置归档层时最低 1 天）。
func emergencyPurgeCutoffDays(rc RetentionConfig) int {
	floor := 1
	if len(rc.Rollups) > 0 {
		maxBucket := rc.Rollups[len(rc.Rollups)-1].BucketMinutes
		if need := maxBucket/1440*2 + 2; need > floor {
			floor = need
		}
	}
	half := rc.ProbeResultsMaxAgeDays / 2
	if half < floor {
		return floor
	}
	return half
}
