package controllers

import (
	"log/slog"

	"nms-backend/models"

	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

// SeedDatabase 首次启动时写入默认数据（幂等，已存在则跳过）
func SeedDatabase(db *gorm.DB) {
	// 1. 确保默认 admin 用户组存在
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

	// 2. 确保默认 admin 用户存在
	var adminUser models.SysUser
	if err := db.Where("username = ?", "admin").First(&adminUser).Error; err != nil {
		hash, err := bcrypt.GenerateFromPassword([]byte("admin"), 12)
		if err != nil {
			slog.Error("bcrypt 初始化失败", "err", err)
			return
		}
		adminUser = models.SysUser{
			Username:           "admin",
			PasswordHash:       string(hash),
			GroupID:            adminGroup.ID,
			MustChangePassword: true,
		}
		if err := db.Create(&adminUser).Error; err != nil {
			slog.Error("创建默认 admin 用户失败", "err", err)
			return
		}
		slog.Warn("已创建默认管理员账号 admin/admin，请登录后立即修改密码！")
	}
}
