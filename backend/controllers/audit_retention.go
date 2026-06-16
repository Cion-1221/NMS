package controllers

import (
	"log/slog"
	"time"

	"nms-backend/models"

	"gorm.io/gorm"
)

// StartAuditRetention 启动两个独立的自动保留任务，均在启动时立即清理一次，之后每
// 24 小时清理一次：
//   - auditMaxAgeDays 控制 IPAM / Devices / Agent 三个模块的审计日志（人工操作记录，
//     量级低，默认保留期长）。
//   - probeResultMaxAgeDays 单独控制 probe_results（由 Agent 自动周期探测写入，量级
//     远高于审计日志，默认保留期应更短）。
//
// 任一参数 <= 0 即视为该项不启用（永久保留，仍可通过各模块的手动清理接口删除）。
func StartAuditRetention(db *gorm.DB, auditMaxAgeDays int, probeResultMaxAgeDays int) {
	if auditMaxAgeDays <= 0 {
		slog.Info("审计日志自动保留未启用 (audit.max_age_days = 0)")
	}
	if probeResultMaxAgeDays <= 0 {
		slog.Info("探测结果自动保留未启用 (audit.probe_results_max_age_days = 0)")
	}
	if auditMaxAgeDays <= 0 && probeResultMaxAgeDays <= 0 {
		return
	}
	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			if auditMaxAgeDays > 0 {
				purgeExpiredAuditLogs(db, auditMaxAgeDays)
			}
			if probeResultMaxAgeDays > 0 {
				purgeExpiredProbeResults(db, probeResultMaxAgeDays)
			}
			<-ticker.C
		}
	}()
}

func purgeExpiredAuditLogs(db *gorm.DB, maxAgeDays int) {
	cutoff := time.Now().AddDate(0, 0, -maxAgeDays)
	ipam := db.Where("created_at < ?", cutoff).Delete(&models.IPAMAuditLog{})
	device := db.Where("created_at < ?", cutoff).Delete(&models.DeviceAuditLog{})
	agent := db.Where("created_at < ?", cutoff).Delete(&models.AgentAuditLog{})
	if ipam.Error != nil || device.Error != nil || agent.Error != nil {
		slog.Error("审计日志自动清理失败",
			"ipam_err", ipam.Error, "device_err", device.Error, "agent_err", agent.Error)
		return
	}
	if ipam.RowsAffected > 0 || device.RowsAffected > 0 || agent.RowsAffected > 0 {
		slog.Info("审计日志自动清理完成",
			"max_age_days", maxAgeDays,
			"ipam_deleted", ipam.RowsAffected,
			"device_deleted", device.RowsAffected,
			"agent_deleted", agent.RowsAffected,
		)
	}
}

// purgeExpiredProbeResults 清理超过 maxAgeDays 的探测结果。独立于审计日志的保留期，
// 因为 probe_results 由自动周期探测写入，写入速率通常远高于人工操作产生的审计日志。
func purgeExpiredProbeResults(db *gorm.DB, maxAgeDays int) {
	cutoff := time.Now().AddDate(0, 0, -maxAgeDays)
	result := db.Where("reported_at < ?", cutoff).Delete(&models.ProbeResult{})
	if result.Error != nil {
		slog.Error("探测结果自动清理失败", "err", result.Error)
		return
	}
	if result.RowsAffected > 0 {
		slog.Info("探测结果自动清理完成", "max_age_days", maxAgeDays, "deleted", result.RowsAffected)
	}
}
