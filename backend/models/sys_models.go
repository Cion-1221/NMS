package models

import (
	"encoding/json"
	"time"
)

// SysGroup 系统用户组
type SysGroup struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"type:varchar(100);uniqueIndex;not null" json:"name"`
	Permissions string    `gorm:"type:text;not null;default:'[]'" json:"permissions"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (SysGroup) TableName() string { return "sys_groups" }

// IsAdmin 判断此用户组是否拥有管理员权限
func (g *SysGroup) IsAdmin() bool {
	var perms []string
	if err := json.Unmarshal([]byte(g.Permissions), &perms); err != nil {
		return false
	}
	for _, p := range perms {
		if p == "admin" {
			return true
		}
	}
	return false
}

// SysUser 系统用户
type SysUser struct {
	ID                 uint      `gorm:"primaryKey" json:"id"`
	Username           string    `gorm:"type:varchar(100);uniqueIndex;not null" json:"username"`
	PasswordHash       string    `gorm:"type:varchar(255);not null" json:"-"`
	GroupID            uint      `gorm:"not null;index" json:"group_id"`
	Group              SysGroup  `gorm:"foreignKey:GroupID;constraint:OnUpdate:CASCADE,OnDelete:RESTRICT" json:"group,omitempty"`
	MustChangePassword bool      `gorm:"not null;default:true" json:"must_change_password"`
	// TokenLifetimeHours 该用户的会话令牌有效期（小时），0 = 使用系统默认 24h
	TokenLifetimeHours int       `gorm:"not null;default:24" json:"token_lifetime_hours"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

func (SysUser) TableName() string { return "sys_users" }

// SysRefreshToken 刷新令牌表（SHA-256 哈希存储，不存明文）
type SysRefreshToken struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	UserID    uint      `gorm:"not null;index" json:"user_id"`
	TokenHash string    `gorm:"type:varchar(64);uniqueIndex;not null" json:"-"`
	ExpiresAt time.Time `gorm:"not null;index" json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}

func (SysRefreshToken) TableName() string { return "sys_refresh_tokens" }
