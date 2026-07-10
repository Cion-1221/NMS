package models

import (
	"encoding/json"
	"time"
)

// ── 权限模型 ─────────────────────────────────────────────────────────────────
// admin 为超级管理员（隐含全部权限，System/Agent 管理仅限 admin）；
// 其余为模块级写权限——所有登录用户都可读 IPAM/Devices/ProbeResults，
// 写操作需要对应权限。新增权限值时同步更新此表（后端校验与前端复选框均以此为准）。

const (
	PermAdmin        = "admin"
	PermIPAMWrite    = "ipam:write"
	PermDevicesWrite = "devices:write"
)

// KnownPermissions 权限值全集，用于用户组 permissions 字段的白名单校验。
var KnownPermissions = []string{PermAdmin, PermIPAMWrite, PermDevicesWrite}

type SysGroup struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"type:varchar(100);uniqueIndex;not null" json:"name"`
	Permissions string    `gorm:"type:text;not null;default:'[]'" json:"permissions"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (SysGroup) TableName() string { return "sys_groups" }

// PermList 解析 permissions JSON 数组；解析失败返回 nil（视为无任何权限）。
func (g *SysGroup) PermList() []string {
	var perms []string
	if err := json.Unmarshal([]byte(g.Permissions), &perms); err != nil {
		return nil
	}
	return perms
}

func (g *SysGroup) IsAdmin() bool {
	for _, p := range g.PermList() {
		if p == PermAdmin {
			return true
		}
	}
	return false
}

type SysUser struct {
	ID                 uint     `gorm:"primaryKey" json:"id"`
	Username           string   `gorm:"type:varchar(100);uniqueIndex;not null" json:"username"`
	PasswordHash       string   `gorm:"type:varchar(255);not null" json:"-"`
	GroupID            uint     `gorm:"not null;index" json:"group_id"`
	Group              SysGroup `gorm:"foreignKey:GroupID;constraint:OnUpdate:CASCADE,OnDelete:RESTRICT" json:"group,omitempty"`
	MustChangePassword bool     `gorm:"not null;default:true" json:"must_change_password"`
	TokenLifetimeHours int      `gorm:"not null;default:24" json:"token_lifetime_hours"`
	// Enabled=false 的账号：密码校验通过后仍拒绝登录、Refresh 被拒；停用即吊销全部
	// Refresh Token（存量 Access Token 在其有效期内仍可用——已知取舍，同密码重置）
	Enabled     bool       `gorm:"not null;default:true" json:"enabled"`
	LastLoginAt *time.Time `json:"last_login_at"`
	// UI preferences (stored per-user)
	Theme     string    `gorm:"type:varchar(20);not null;default:'system'" json:"theme"`
	Language  string    `gorm:"type:varchar(10);not null;default:'en'" json:"language"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	// ActiveSessions 当前未过期的 Refresh Token 数（ListUsers 聚合填充，不入库）
	ActiveSessions int64 `gorm:"-" json:"active_sessions"`
}

func (SysUser) TableName() string { return "sys_users" }

// ── SysAuditLog ──────────────────────────────────────────────────────────────
// System 模块审计：用户/用户组/安全设置/会话管理的全部敏感操作留痕。
// ResourceID 用字符串（用户名、锁定 key 等均非数字 ID）。

type SysAuditLog struct {
	ID           uint      `gorm:"primaryKey" json:"id"`
	Username     string    `gorm:"type:varchar(100);not null;index" json:"username"`
	Action       string    `gorm:"type:varchar(50);not null" json:"action"`
	ResourceType string    `gorm:"type:varchar(50);not null" json:"resource_type"`
	ResourceID   string    `gorm:"type:varchar(100)" json:"resource_id"`
	Detail       string    `gorm:"type:text" json:"detail"`
	CreatedAt    time.Time `gorm:"index" json:"created_at"`
}

func (SysAuditLog) TableName() string { return "sys_audit_logs" }

// SysSetting 系统级键值配置（由 System 模块管理界面维护）。
// 列名使用 setting_key 而非 key —— key 是 MySQL 保留字。
type SysSetting struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	Key       string    `gorm:"column:setting_key;type:varchar(100);uniqueIndex;not null" json:"key"`
	Value     string    `gorm:"type:varchar(1000);not null" json:"value"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (SysSetting) TableName() string { return "sys_settings" }

type SysRefreshToken struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	UserID    uint      `gorm:"not null;index" json:"user_id"`
	TokenHash string    `gorm:"type:varchar(64);uniqueIndex;not null" json:"-"`
	ExpiresAt time.Time `gorm:"not null;index" json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}

func (SysRefreshToken) TableName() string { return "sys_refresh_tokens" }
