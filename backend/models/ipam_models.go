package models

import (
	"time"
)

type RootPrefix struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	IPVersion int       `gorm:"not null" json:"ip_version"`
	CIDR      string    `gorm:"type:varchar(50);uniqueIndex;not null" json:"cidr"`
	Group     string    `gorm:"type:varchar(100)" json:"group"`
	Type      string    `gorm:"type:varchar(100)" json:"type"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (RootPrefix) TableName() string {
	return "ipam_root_prefixes"
}

type Subnet struct {
	ID           uint       `gorm:"primaryKey" json:"id"`
	RootPrefixID uint       `gorm:"not null;index" json:"root_prefix_id"`
	RootPrefix   RootPrefix `gorm:"foreignKey:RootPrefixID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE;" json:"-"`
	IPVersion    int        `gorm:"not null" json:"ip_version"`
	CIDR         string     `gorm:"type:varchar(50);uniqueIndex;not null" json:"cidr"`
	Level        string     `gorm:"type:varchar(10);not null" json:"level"`
	ParentID     *uint      `gorm:"index" json:"parent_id"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

func (Subnet) TableName() string {
	return "ipam_subnets"
}
