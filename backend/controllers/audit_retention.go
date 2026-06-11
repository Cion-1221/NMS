package controllers

import (
	"log/slog"
	"time"

	"nms-backend/models"

	"gorm.io/gorm"
)

// StartAuditRetention 启动审计日志自动保留任务：启动时立即清理一次，
// 之后每 24 小时清理一次超过 maxAgeDays 的 IPAM / Devices 审计日志。
// maxAgeDays <= 0 时不启用（永久保留，仍可通过各模块的手动清理接口删除）。
func StartAuditRetention(db *gorm.DB, maxAgeDays int) {
	if maxAgeDays <= 0 {
		slog.Info("审计日志自动保留未启用 (audit.max_age_days = 0)")
		return
	}
	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			purgeExpiredAuditLogs(db, maxAgeDays)
			<-ticker.C
		}
	}()
}

func purgeExpiredAuditLogs(db *gorm.DB, maxAgeDays int) {
	cutoff := time.Now().AddDate(0, 0, -maxAgeDays)
	ipam := db.Where("created_at < ?", cutoff).Delete(&models.IPAMAuditLog{})
	device := db.Where("created_at < ?", cutoff).Delete(&models.DeviceAuditLog{})
	if ipam.Error != nil || device.Error != nil {
		slog.Error("审计日志自动清理失败",
			"ipam_err", ipam.Error, "device_err", device.Error)
		return
	}
	if ipam.RowsAffected > 0 || device.RowsAffected > 0 {
		slog.Info("审计日志自动清理完成",
			"max_age_days", maxAgeDays,
			"ipam_deleted", ipam.RowsAffected,
			"device_deleted", device.RowsAffected,
		)
	}
}
