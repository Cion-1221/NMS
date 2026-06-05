package models

import (
	"encoding/json"
	"time"
)

type SysGroup struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"type:varchar(100);uniqueIndex;not null" json:"name"`
	Permissions string    `gorm:"type:text;not null;default:'[]'" json:"permissions"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (SysGroup) TableName() string { return "sys_groups" }

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

type SysUser struct {
	ID                 uint      `gorm:"primaryKey" json:"id"`
	Username           string    `gorm:"type:varchar(100);uniqueIndex;not null" json:"username"`
	PasswordHash       string    `gorm:"type:varchar(255);not null" json:"-"`
	GroupID            uint      `gorm:"not null;index" json:"group_id"`
	Group              SysGroup  `gorm:"foreignKey:GroupID;constraint:OnUpdate:CASCADE,OnDelete:RESTRICT" json:"group,omitempty"`
	MustChangePassword bool      `gorm:"not null;default:true" json:"must_change_password"`
	TokenLifetimeHours int       `gorm:"not null;default:24" json:"token_lifetime_hours"`
	// UI preferences (stored per-user)
	Theme    string `gorm:"type:varchar(20);not null;default:'system'" json:"theme"`
	Language string `gorm:"type:varchar(10);not null;default:'en'" json:"language"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (SysUser) TableName() string { return "sys_users" }

type SysRefreshToken struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	UserID    uint      `gorm:"not null;index" json:"user_id"`
	TokenHash string    `gorm:"type:varchar(64);uniqueIndex;not null" json:"-"`
	ExpiresAt time.Time `gorm:"not null;index" json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}

func (SysRefreshToken) TableName() string { return "sys_refresh_tokens" }
