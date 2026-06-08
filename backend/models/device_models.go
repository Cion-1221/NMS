package models

import "time"

// ── DeviceSite ─────────────────────────────────────────────────────────────────

type DeviceSite struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"type:varchar(100);uniqueIndex;not null" json:"name"`
	Region      string    `gorm:"type:varchar(100)" json:"region"`
	Address     string    `gorm:"type:varchar(300)" json:"address"`
	Description string    `gorm:"type:varchar(500)" json:"description"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (DeviceSite) TableName() string { return "device_sites" }

// ── DevicePoP ──────────────────────────────────────────────────────────────────
// Composite unique: (site_id, name) — enforced by uniqueIndex:idx_pop_site_name

type DevicePoP struct {
	ID          uint        `gorm:"primaryKey" json:"id"`
	Name        string      `gorm:"type:varchar(100);not null;uniqueIndex:idx_pop_site_name" json:"name"`
	SiteID      uint        `gorm:"not null;index;uniqueIndex:idx_pop_site_name" json:"site_id"`
	Site        *DeviceSite `gorm:"foreignKey:SiteID" json:"site,omitempty"`
	Description string      `gorm:"type:varchar(500)" json:"description"`
	CreatedAt   time.Time   `json:"created_at"`
	UpdatedAt   time.Time   `json:"updated_at"`
}

func (DevicePoP) TableName() string { return "device_pops" }

// ── DeviceRole ─────────────────────────────────────────────────────────────────

type DeviceRole struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"type:varchar(100);uniqueIndex;not null" json:"name"`
	Description string    `gorm:"type:varchar(500)" json:"description"`
	CreatedAt   time.Time `json:"created_at"`
}

func (DeviceRole) TableName() string { return "device_roles" }

// ── DeviceVendor ───────────────────────────────────────────────────────────────

type DeviceVendor struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"type:varchar(100);uniqueIndex;not null" json:"name"`
	Description string    `gorm:"type:varchar(500)" json:"description"`
	CreatedAt   time.Time `json:"created_at"`
}

func (DeviceVendor) TableName() string { return "device_vendors" }

// ── Device ─────────────────────────────────────────────────────────────────────
// ManagementIP (IPv4) and ManagementIPv6 are both nullable so that either can be
// omitted, but application-level validation requires at least one to be present.
// NULL values are stored as SQL NULL (not empty string) to satisfy the unique index
// constraint when a field is not used — MySQL allows multiple NULLs in a UNIQUE column.

type Device struct {
	ID             uint          `gorm:"primaryKey" json:"id"`
	Hostname       string        `gorm:"type:varchar(255);uniqueIndex;not null" json:"hostname"`
	ManagementIP   *string       `gorm:"type:varchar(50);uniqueIndex" json:"management_ip"`
	ManagementIPv6 *string       `gorm:"type:varchar(100);uniqueIndex" json:"management_ipv6"`
	Status         string        `gorm:"type:varchar(20);not null;default:'active'" json:"status"`
	SiteID         *uint         `gorm:"index" json:"site_id"`
	Site           *DeviceSite   `gorm:"foreignKey:SiteID" json:"site,omitempty"`
	PoPID          *uint         `gorm:"column:pop_id;index" json:"pop_id"`
	PoP            *DevicePoP    `gorm:"foreignKey:PoPID" json:"pop,omitempty"`
	RoleID         *uint         `gorm:"index" json:"role_id"`
	Role           *DeviceRole   `gorm:"foreignKey:RoleID" json:"role,omitempty"`
	VendorID       *uint         `gorm:"index" json:"vendor_id"`
	Vendor         *DeviceVendor `gorm:"foreignKey:VendorID" json:"vendor,omitempty"`
	Remark         string        `gorm:"type:text" json:"remark"`
	CreatedAt      time.Time     `json:"created_at"`
	UpdatedAt      time.Time     `json:"updated_at"`
}

func (Device) TableName() string { return "devices" }

// ── DeviceAuditLog ─────────────────────────────────────────────────────────────

type DeviceAuditLog struct {
	ID           uint      `gorm:"primaryKey" json:"id"`
	Username     string    `gorm:"type:varchar(100);not null;index" json:"username"`
	Action       string    `gorm:"type:varchar(50);not null" json:"action"`
	ResourceType string    `gorm:"type:varchar(50);not null" json:"resource_type"`
	ResourceID   *uint     `json:"resource_id"`
	Detail       string    `gorm:"type:text" json:"detail"`
	CreatedAt    time.Time `gorm:"index" json:"created_at"`
}

func (DeviceAuditLog) TableName() string { return "device_audit_logs" }
