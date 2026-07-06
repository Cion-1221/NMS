package controllers

import (
	"log/slog"
	"time"

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
			res := db.Where("reported_at < ? AND type NOT IN ?", cutoff, pathProbeTypes).
				Delete(&models.ProbeResult{})
			if res.Error != nil {
				slog.Error("探测结果自动清理失败（标量类）", "err", res.Error)
				return
			}
			scalarDeleted = res.RowsAffected
		}
		pathCutoff := time.Now().AddDate(0, 0, -pathDays)
		res := db.Where("reported_at < ? AND type IN ?", pathCutoff, pathProbeTypes).
			Delete(&models.ProbeResult{})
		if res.Error != nil {
			slog.Error("探测结果自动清理失败（路径类）", "err", res.Error)
			return
		}
		pathDeleted = res.RowsAffected
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
	result := db.Where("reported_at < ?", cutoff).Delete(&models.ProbeResult{})
	if result.Error != nil {
		slog.Error("探测结果自动清理失败", "err", result.Error)
		return
	}
	if result.RowsAffected > 0 {
		slog.Info("探测结果自动清理完成", "max_age_days", probeDays, "deleted", result.RowsAffected)
	}
}
