package models

import (
	"time"
)

type RootPrefix struct {
	ID        uint      `gorm:"primaryKey"`
	IPVersion int       `gorm:"not null"`
	CIDR      string    `gorm:"type:varchar(50);uniqueIndex;not null"`
	Group     string    `gorm:"type:varchar(100)"`
	Type      string    `gorm:"type:varchar(100)"`
	CreatedAt time.Time
	UpdatedAt time.Time
}

func (RootPrefix) TableName() string {
	return "ipam_root_prefixes"
}

type Subnet struct {
	ID           uint      `gorm:"primaryKey"`
	RootPrefixID uint      `gorm:"not null;index;constraint:OnDelete:CASCADE;"`
	IPVersion    int       `gorm:"not null"`
	CIDR         string    `gorm:"type:varchar(50);uniqueIndex;not null"`
	Level        string    `gorm:"type:varchar(10);not null"`
	ParentID     *uint     `gorm:"index"`
	CreatedAt    time.Time
}

func (Subnet) TableName() string {
	return "ipam_subnets"
}
