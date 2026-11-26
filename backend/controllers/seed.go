package controllers

import (
	"log/slog"

	"nms-backend/models"

	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

// initialSeededKey 标记数据库已完成首次初始化种子写入（sys_settings）。
// 一旦标记存在或库内已有任何用户账号，后续重启不再自动补建默认 admin/admin，
// 尊重管理员在生产环境中重命名或删除默认 admin 账号的安全加固操作。
const initialSeededKey = "sys_initial_seeded"

// SeedDatabase 首次启动时在空库上写入默认管理员组与初始账号（一次性幂等）。
func SeedDatabase(db *gorm.DB) {
	var flag models.SysSetting
	if err := db.Where("setting_key = ?", initialSeededKey).First(&flag).Error; err == nil {
		return
	}

	var userCount int64
	if err := db.Model(&models.SysUser{}).Count(&userCount).Error; err != nil {
		slog.Error("检查存量用户数量失败", "err", err)
		return
	}
	if userCount > 0 {
		// 存量库升级：已有用户账号，仅补写初始化完成标记，绝不复活默认 admin/admin
		_ = db.Create(&models.SysSetting{Key: initialSeededKey, Value: "1"}).Error
		return
	}

	// 1. 全新空库：确保默认 admin 用户组存在
	var adminGroup models.SysGroup
	if err := db.Where("name = ?", "admin").First(&adminGroup).Error; err != nil {
		adminGroup = models.SysGroup{
			Name:        "admin",
			Permissions: `["admin"]`,
		}
		if err := db.Create(&adminGroup).Error; err != nil {
			slog.Error("创建默认 admin 用户组失败", "err", err)
			return
		}
		slog.Info("已创建默认用户组", "name", "admin")
	}

	// 2. 创建初始 admin 用户
	hash, err := bcrypt.GenerateFromPassword([]byte("admin"), 12)
	if err != nil {
		slog.Error("bcrypt 初始化失败", "err", err)
		return
	}
	adminUser := models.SysUser{
		Username:           "admin",
		PasswordHash:       string(hash),
		GroupID:            adminGroup.ID,
		MustChangePassword: true,
	}
	if err := db.Create(&adminUser).Error; err != nil {
		slog.Error("创建默认 admin 用户失败", "err", err)
		return
	}
	_ = db.Create(&models.SysSetting{Key: initialSeededKey, Value: "1"}).Error
	slog.Warn("已创建默认管理员账号 admin/admin，请登录后立即修改密码！")
}
