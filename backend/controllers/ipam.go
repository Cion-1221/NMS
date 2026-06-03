package controllers

import (
	"fmt"
	"net/http"

	"ipam-backend/core"
	"ipam-backend/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func CreateRootPrefix(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			IPVersion int    `json:"ip_version" binding:"required,oneof=4 6"`
			CIDR      string `json:"cidr" binding:"required"`
			Group     string `json:"group"`
			Type      string `json:"type"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error()})
			return
		}

		prefix, err := core.ValidateStrictCIDR(req.CIDR)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		root := models.RootPrefix{
			IPVersion: req.IPVersion,
			CIDR:      prefix.String(),
			Group:     req.Group,
			Type:      req.Type,
		}

		if err := db.Create(&root).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "创建失败: " + err.Error()})
			return
		}
		c.JSON(http.StatusOK, root)
	}
}

func ListRootPrefixes(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var roots []models.RootPrefix
		db.Order("created_at desc").Find(&roots)
		c.JSON(http.StatusOK, roots)
	}
}

func UpdateRootPrefix(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")
		var req struct {
			Group string `json:"group"`
			Type  string `json:"type"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}

		if err := db.Model(&models.RootPrefix{}).Where("id = ?", id).
			Select("Group", "Type").
			Updates(models.RootPrefix{Group: req.Group, Type: req.Type}).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "更新失败: " + err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

func DeleteRootPrefix(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")
		if err := db.Where("id = ?", id).Delete(&models.RootPrefix{}).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "删除失败: " + err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

type SubnetNode struct {
	ID       uint         `json:"id"`
	Level    string       `json:"level"`
	CIDR     string       `json:"cidr"`
	ParentID *uint        `json:"parent_id"`
	Children []SubnetNode `json:"children"`
}

func GetSubnetTree(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		rootPrefixID := c.Param("id")
		var subnets []models.Subnet

		if err := db.Where("root_prefix_id = ?", rootPrefixID).Order("cidr asc").Find(&subnets).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "查询树失败: " + err.Error()})
			return
		}

		var l1Nodes []SubnetNode
		childrenMap := make(map[uint][]SubnetNode)

		for _, s := range subnets {
			if s.Level == "L2" && s.ParentID != nil {
				node := SubnetNode{ID: s.ID, Level: s.Level, CIDR: s.CIDR, ParentID: s.ParentID, Children: []SubnetNode{}}
				childrenMap[*s.ParentID] = append(childrenMap[*s.ParentID], node)
			}
		}

		for _, s := range subnets {
			if s.Level == "L1" {
				node := SubnetNode{ID: s.ID, Level: s.Level, CIDR: s.CIDR, ParentID: nil}
				if children, ok := childrenMap[s.ID]; ok {
					node.Children = children
				} else {
					node.Children = []SubnetNode{}
				}
				l1Nodes = append(l1Nodes, node)
			}
		}

		c.JSON(http.StatusOK, l1Nodes)
	}
}

func SplitSubnet(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			TargetType string `json:"target_type" binding:"required,oneof=root subnet"`
			TargetID   uint   `json:"target_id" binding:"required"`
			TargetBits int    `json:"target_bits" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}

		err := db.Transaction(func(tx *gorm.DB) error {
			var parentCIDR string
			var rootPrefixID uint
			var ipVersion int
			var newLevel string
			var newParentID *uint

			if req.TargetType == "root" {
				var root models.RootPrefix
				if err := tx.First(&root, req.TargetID).Error; err != nil {
					return fmt.Errorf("指定的根前缀不存在")
				}
				parentCIDR, rootPrefixID, ipVersion = root.CIDR, root.ID, root.IPVersion
				newLevel, newParentID = "L1", nil

				if err := tx.Where("root_prefix_id = ?", root.ID).Delete(&models.Subnet{}).Error; err != nil {
					return fmt.Errorf("清空旧子网失败")
				}
			} else {
				var subnet models.Subnet
				if err := tx.First(&subnet, req.TargetID).Error; err != nil {
					return fmt.Errorf("指定的子网不存在")
				}
				
				parentCIDR, rootPrefixID, ipVersion = subnet.CIDR, subnet.RootPrefixID, subnet.IPVersion
				
				if subnet.Level == "L1" {
					newLevel = "L2"
					newParentID = &subnet.ID
					if err := tx.Where("parent_id = ?", subnet.ID).Delete(&models.Subnet{}).Error; err != nil {
						return fmt.Errorf("清空旧的二级子网失败")
					}
				} else if subnet.Level == "L2" {
					newLevel = "L2"
					newParentID = subnet.ParentID
					if err := tx.Where("id = ?", subnet.ID).Delete(&models.Subnet{}).Error; err != nil {
						return fmt.Errorf("清空旧 L2 失败")
					}
				} else {
					return fmt.Errorf("未知级别的子网")
				}
			}

			newCIDRs, err := core.CalculateSplitSubnets(parentCIDR, req.TargetBits)
			if err != nil {
				return err
			}

			var newSubnets []models.Subnet
			for _, cidr := range newCIDRs {
				newSubnets = append(newSubnets, models.Subnet{
					RootPrefixID: rootPrefixID,
					IPVersion:    ipVersion,
					CIDR:         cidr,
					Level:        newLevel,
					ParentID:     newParentID,
				})
			}

			if len(newSubnets) > 0 {
				if err := tx.Create(&newSubnets).Error; err != nil {
					return fmt.Errorf("批量写入新子网数据失败")
				}
			}

			return nil
		})

		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

func MergeSubnets(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			SubnetIDs []uint `json:"subnet_ids" binding:"required,min=2"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误，至少需要选择两个子网"})
			return
		}

		err := db.Transaction(func(tx *gorm.DB) error {
			var subnets []models.Subnet
			if err := tx.Where("id IN ?", req.SubnetIDs).Find(&subnets).Error; err != nil {
				return fmt.Errorf("查询数据库失败")
			}
			if len(subnets) != len(req.SubnetIDs) {
				return fmt.Errorf("部分选中的子网已不存在")
			}

			baseLevel, baseParentID, baseRootID := subnets[0].Level, subnets[0].ParentID, subnets[0].RootPrefixID
			var cidrList []string

			for _, s := range subnets {
				if s.Level != baseLevel {
					return fmt.Errorf("所选子网不属于同一级别，禁止合并")
				}
				if (s.ParentID == nil && baseParentID != nil) ||
					(s.ParentID != nil && baseParentID == nil) ||
					(s.ParentID != nil && baseParentID != nil && *s.ParentID != *baseParentID) {
					return fmt.Errorf("所选子网不属于同一个父级节点，禁止合并")
				}
				cidrList = append(cidrList, s.CIDR)
			}

			mergedCIDR, err := core.CalculateMergeSubnets(cidrList)
			if err != nil {
				return err
			}

			newSubnet := models.Subnet{
				RootPrefixID: baseRootID,
				IPVersion:    subnets[0].IPVersion,
				CIDR:         mergedCIDR,
				Level:        baseLevel,
				ParentID:     baseParentID,
			}
			if err := tx.Create(&newSubnet).Error; err != nil {
				return fmt.Errorf("创建聚合子网失败")
			}

			if err := tx.Model(&models.Subnet{}).
				Where("parent_id IN ?", req.SubnetIDs).
				Update("parent_id", newSubnet.ID).Error; err != nil {
				return fmt.Errorf("子节点自动重归属失败")
			}

			if err := tx.Where("id IN ?", req.SubnetIDs).Delete(&models.Subnet{}).Error; err != nil {
				return fmt.Errorf("销毁旧子网碎片失败")
			}

			return nil
		})

		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

func RegisterIPAMRoutes(r *gin.Engine, db *gorm.DB) {
	api := r.Group("/api/v1/ipam")
	{
		api.POST("/root-prefixes", CreateRootPrefix(db))
		api.GET("/root-prefixes", ListRootPrefixes(db))
		api.PUT("/root-prefixes/:id", UpdateRootPrefix(db))
		api.DELETE("/root-prefixes/:id", DeleteRootPrefix(db))

		api.GET("/root-prefixes/:id/tree", GetSubnetTree(db))
		api.POST("/split", SplitSubnet(db))
		api.POST("/merge", MergeSubnets(db))
	}
}
