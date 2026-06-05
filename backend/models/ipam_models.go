package models

import "time"

// ── Lookup entities ────────────────────────────────────────────────────────────

type IPAMGroup struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"type:varchar(100);uniqueIndex;not null" json:"name"`
	Description string    `gorm:"type:varchar(500)" json:"description"`
	CreatedAt   time.Time `json:"created_at"`
}

func (IPAMGroup) TableName() string { return "ipam_groups" }

type IPAMType struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"type:varchar(100);uniqueIndex;not null" json:"name"`
	Description string    `gorm:"type:varchar(500)" json:"description"`
	CreatedAt   time.Time `json:"created_at"`
}

func (IPAMType) TableName() string { return "ipam_types" }

type IPAMVRF struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"type:varchar(100);uniqueIndex;not null" json:"name"`
	RD          string    `gorm:"type:varchar(100)" json:"rd"`
	Description string    `gorm:"type:varchar(500)" json:"description"`
	CreatedAt   time.Time `json:"created_at"`
}

func (IPAMVRF) TableName() string { return "ipam_vrfs" }

// ── Audit log ──────────────────────────────────────────────────────────────────

type IPAMAuditLog struct {
	ID           uint      `gorm:"primaryKey" json:"id"`
	Username     string    `gorm:"type:varchar(100);not null;index" json:"username"`
	Action       string    `gorm:"type:varchar(50);not null" json:"action"`
	ResourceType string    `gorm:"type:varchar(50);not null" json:"resource_type"`
	ResourceID   *uint     `json:"resource_id"`
	Detail       string    `gorm:"type:text" json:"detail"`
	CreatedAt    time.Time `gorm:"index" json:"created_at"`
}

func (IPAMAuditLog) TableName() string { return "ipam_audit_logs" }

// ── Core IPAM ──────────────────────────────────────────────────────────────────

type RootPrefix struct {
	ID        uint       `gorm:"primaryKey" json:"id"`
	IPVersion int        `gorm:"not null" json:"ip_version"`
	CIDR      string     `gorm:"type:varchar(50);uniqueIndex;not null" json:"cidr"`
	GroupID   *uint      `gorm:"index" json:"group_id"`
	Group     *IPAMGroup `gorm:"foreignKey:GroupID" json:"group,omitempty"`
	TypeID    *uint      `gorm:"index" json:"type_id"`
	Type      *IPAMType  `gorm:"foreignKey:TypeID" json:"type,omitempty"`
	VRFID     *uint      `gorm:"index" json:"vrf_id"`
	VRF       *IPAMVRF   `gorm:"foreignKey:VRFID" json:"vrf,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
}

func (RootPrefix) TableName() string { return "ipam_root_prefixes" }

type Subnet struct {
	ID           uint       `gorm:"primaryKey" json:"id"`
	RootPrefixID uint       `gorm:"not null;index" json:"root_prefix_id"`
	RootPrefix   RootPrefix `gorm:"foreignKey:RootPrefixID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE;" json:"-"`
	IPVersion    int        `gorm:"not null" json:"ip_version"`
	CIDR         string     `gorm:"type:varchar(50);uniqueIndex;not null" json:"cidr"`
	Level        string     `gorm:"type:varchar(10);not null" json:"level"`
	ParentID     *uint      `gorm:"index" json:"parent_id"`
	GroupID      *uint      `gorm:"index" json:"group_id"`
	Group        *IPAMGroup `gorm:"foreignKey:GroupID" json:"group,omitempty"`
	TypeID       *uint      `gorm:"index" json:"type_id"`
	Type         *IPAMType  `gorm:"foreignKey:TypeID" json:"type,omitempty"`
	VRFID        *uint      `gorm:"index" json:"vrf_id"`
	VRF          *IPAMVRF   `gorm:"foreignKey:VRFID" json:"vrf,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

func (Subnet) TableName() string { return "ipam_subnets" }
