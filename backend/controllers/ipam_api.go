package controllers

import (
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"sort"
	"strconv"
	"time"

	"nms-backend/core"
	"nms-backend/middleware"
	"nms-backend/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ── Shared helpers ─────────────────────────────────────────────────────────────
// parseIDParam / getUsername / codedErrJSON / friendlyNameUniqueErr 等跨模块工具
// 已收拢到 common.go。

func writeAudit(db *gorm.DB, username, action, resourceType string, resourceID *uint, detail string) {
	_ = db.Create(&models.IPAMAuditLog{
		Username:     username,
		Action:       action,
		ResourceType: resourceType,
		ResourceID:   resourceID,
		Detail:       detail,
	}).Error
}

func sortSubnetsByIP(subnets []models.Subnet) {
	sort.Slice(subnets, func(i, j int) bool {
		pi, errI := netip.ParsePrefix(subnets[i].CIDR)
		pj, errJ := netip.ParsePrefix(subnets[j].CIDR)
		if errI != nil || errJ != nil {
			return subnets[i].CIDR < subnets[j].CIDR
		}
		c := pi.Addr().Compare(pj.Addr())
		if c != 0 {
			return c < 0
		}
		return pi.Bits() < pj.Bits()
	})
}

func sortRootsByIP(roots []models.RootPrefix) {
	sort.Slice(roots, func(i, j int) bool {
		pi, errI := netip.ParsePrefix(roots[i].CIDR)
		pj, errJ := netip.ParsePrefix(roots[j].CIDR)
		if errI != nil || errJ != nil {
			return roots[i].CIDR < roots[j].CIDR
		}
		c := pi.Addr().Compare(pj.Addr())
		if c != 0 {
			return c < 0
		}
		return pi.Bits() < pj.Bits()
	})
}

// ── IPAM Group CRUD ────────────────────────────────────────────────────────────

func ListIPAMGroups(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var groups []models.IPAMGroup
		db.Order("name asc").Find(&groups)
		c.JSON(http.StatusOK, groups)
	}
}

func CreateIPAMGroup(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Name        string `json:"name" binding:"required"`
			Description string `json:"description"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}
		g := models.IPAMGroup{Name: req.Name, Description: req.Description}
		if err := db.Create(&g).Error; err != nil {
			if msg := friendlyNameUniqueErr(err, "分组"); msg != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "common.name_taken"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "创建失败: " + err.Error(), "code": "server_error"})
			return
		}
		writeAudit(db, getUsername(c), "create_group", "group", &g.ID, fmt.Sprintf("Created group: %s", req.Name))
		c.JSON(http.StatusOK, g)
	}
}

func UpdateIPAMGroup(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var req struct {
			Name        string `json:"name" binding:"required"`
			Description string `json:"description"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}
		var g models.IPAMGroup
		if err := db.First(&g, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "分组不存在", "code": "not_found"})
			return
		}
		if err := db.Model(&g).Updates(map[string]interface{}{"name": req.Name, "description": req.Description}).Error; err != nil {
			if msg := friendlyNameUniqueErr(err, "分组"); msg != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "common.name_taken"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "更新失败: " + err.Error(), "code": "server_error"})
			return
		}
		writeAudit(db, getUsername(c), "update_group", "group", &id, fmt.Sprintf("Updated group %d: %s", id, req.Name))
		c.JSON(http.StatusOK, g)
	}
}

func DeleteIPAMGroup(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		txErr := db.Transaction(func(tx *gorm.DB) error {
			tx.Exec("UPDATE ipam_root_prefixes SET group_id = NULL WHERE group_id = ?", id)
			tx.Exec("UPDATE ipam_subnets SET group_id = NULL WHERE group_id = ?", id)
			return tx.Delete(&models.IPAMGroup{}, id).Error
		})
		if txErr != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "删除失败: " + txErr.Error()})
			return
		}
		writeAudit(db, getUsername(c), "delete_group", "group", &id, fmt.Sprintf("Deleted group %d", id))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// ── IPAM Type CRUD ─────────────────────────────────────────────────────────────

func ListIPAMTypes(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var types []models.IPAMType
		db.Order("name asc").Find(&types)
		c.JSON(http.StatusOK, types)
	}
}

func CreateIPAMType(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Name        string `json:"name" binding:"required"`
			Description string `json:"description"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}
		t := models.IPAMType{Name: req.Name, Description: req.Description}
		if err := db.Create(&t).Error; err != nil {
			if msg := friendlyNameUniqueErr(err, "类型"); msg != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "common.name_taken"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "创建失败: " + err.Error(), "code": "server_error"})
			return
		}
		writeAudit(db, getUsername(c), "create_type", "type", &t.ID, fmt.Sprintf("Created type: %s", req.Name))
		c.JSON(http.StatusOK, t)
	}
}

func UpdateIPAMType(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var req struct {
			Name        string `json:"name" binding:"required"`
			Description string `json:"description"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}
		var t models.IPAMType
		if err := db.First(&t, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "类型不存在", "code": "not_found"})
			return
		}
		if err := db.Model(&t).Updates(map[string]interface{}{"name": req.Name, "description": req.Description}).Error; err != nil {
			if msg := friendlyNameUniqueErr(err, "类型"); msg != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "common.name_taken"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "更新失败: " + err.Error(), "code": "server_error"})
			return
		}
		writeAudit(db, getUsername(c), "update_type", "type", &id, fmt.Sprintf("Updated type %d: %s", id, req.Name))
		c.JSON(http.StatusOK, t)
	}
}

func DeleteIPAMType(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		txErr := db.Transaction(func(tx *gorm.DB) error {
			tx.Exec("UPDATE ipam_root_prefixes SET type_id = NULL WHERE type_id = ?", id)
			tx.Exec("UPDATE ipam_subnets SET type_id = NULL WHERE type_id = ?", id)
			return tx.Delete(&models.IPAMType{}, id).Error
		})
		if txErr != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "删除失败: " + txErr.Error()})
			return
		}
		writeAudit(db, getUsername(c), "delete_type", "type", &id, fmt.Sprintf("Deleted type %d", id))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// ── IPAM VRF CRUD ──────────────────────────────────────────────────────────────

func ListVRFs(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var vrfs []models.IPAMVRF
		db.Order("name asc").Find(&vrfs)
		c.JSON(http.StatusOK, vrfs)
	}
}

func CreateVRF(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Name        string `json:"name" binding:"required"`
			RD          string `json:"rd"`
			Description string `json:"description"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}
		v := models.IPAMVRF{Name: req.Name, RD: req.RD, Description: req.Description}
		if err := db.Create(&v).Error; err != nil {
			if msg := friendlyNameUniqueErr(err, "VRF"); msg != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "common.name_taken"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "创建失败: " + err.Error(), "code": "server_error"})
			return
		}
		writeAudit(db, getUsername(c), "create_vrf", "vrf", &v.ID, fmt.Sprintf("Created VRF: %s (RD: %s)", req.Name, req.RD))
		c.JSON(http.StatusOK, v)
	}
}

func UpdateVRF(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var req struct {
			Name        string `json:"name" binding:"required"`
			RD          string `json:"rd"`
			Description string `json:"description"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}
		var v models.IPAMVRF
		if err := db.First(&v, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "VRF 不存在", "code": "not_found"})
			return
		}
		if err := db.Model(&v).Updates(map[string]interface{}{"name": req.Name, "rd": req.RD, "description": req.Description}).Error; err != nil {
			if msg := friendlyNameUniqueErr(err, "VRF"); msg != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "common.name_taken"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "更新失败: " + err.Error(), "code": "server_error"})
			return
		}
		writeAudit(db, getUsername(c), "update_vrf", "vrf", &id, fmt.Sprintf("Updated VRF %d: %s", id, req.Name))
		c.JSON(http.StatusOK, v)
	}
}

func DeleteVRF(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		txErr := db.Transaction(func(tx *gorm.DB) error {
			tx.Exec("UPDATE ipam_root_prefixes SET vrf_id = NULL WHERE vrf_id = ?", id)
			tx.Exec("UPDATE ipam_subnets SET vrf_id = NULL WHERE vrf_id = ?", id)
			return tx.Delete(&models.IPAMVRF{}, id).Error
		})
		if txErr != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "删除失败: " + txErr.Error()})
			return
		}
		writeAudit(db, getUsername(c), "delete_vrf", "vrf", &id, fmt.Sprintf("Deleted VRF %d", id))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// ── Root Prefix CRUD ───────────────────────────────────────────────────────────

func CreateRootPrefix(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			IPVersion int    `json:"ip_version" binding:"required,oneof=4 6"`
			CIDR      string `json:"cidr" binding:"required"`
			GroupID   *uint  `json:"group_id"`
			TypeID    *uint  `json:"type_id"`
			VRFID     *uint  `json:"vrf_id"`
			Remark    string `json:"remark"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error(), "code": "bad_request"})
			return
		}
		prefix, err := core.ValidateStrictCIDR(req.CIDR)
		if err != nil {
			c.JSON(http.StatusBadRequest, codedErrJSON(err))
			return
		}
		if prefix.Addr().Is4() && req.IPVersion != 4 || prefix.Addr().Is6() && req.IPVersion != 6 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "IP 版本与 CIDR 地址族不一致", "code": "ipam.version_mismatch"})
			return
		}
		root := models.RootPrefix{
			IPVersion: req.IPVersion,
			CIDR:      prefix.String(),
			GroupID:   req.GroupID,
			TypeID:    req.TypeID,
			VRFID:     req.VRFID,
			Remark:    req.Remark,
		}
		if err := db.Create(&root).Error; err != nil {
			if isDuplicateErr(err) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "该根前缀已存在", "code": "ipam.cidr_taken"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "创建失败: " + err.Error(), "code": "server_error"})
			return
		}
		db.Preload("Group").Preload("Type").Preload("VRF").First(&root, root.ID)
		writeAudit(db, getUsername(c), "create_root", "root_prefix", &root.ID,
			fmt.Sprintf("Created root prefix %s", root.CIDR))
		c.JSON(http.StatusOK, root)
	}
}

func ListRootPrefixes(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var roots []models.RootPrefix
		db.Preload("Group").Preload("Type").Preload("VRF").Find(&roots)
		sortRootsByIP(roots)
		c.JSON(http.StatusOK, roots)
	}
}

func UpdateRootPrefix(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var req struct {
			GroupID *uint  `json:"group_id"`
			TypeID  *uint  `json:"type_id"`
			VRFID   *uint  `json:"vrf_id"`
			Remark  string `json:"remark"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}
		var root models.RootPrefix
		if err := db.First(&root, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "未找到该前缀", "code": "not_found"})
			return
		}
		if err := db.Model(&root).Updates(map[string]interface{}{
			"group_id": req.GroupID,
			"type_id":  req.TypeID,
			"vrf_id":   req.VRFID,
			"remark":   req.Remark,
		}).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "更新失败: " + err.Error(), "code": "server_error"})
			return
		}
		db.Preload("Group").Preload("Type").Preload("VRF").First(&root, id)
		writeAudit(db, getUsername(c), "update_root", "root_prefix", &id,
			fmt.Sprintf("Updated root prefix %s attributes", root.CIDR))
		c.JSON(http.StatusOK, root)
	}
}

func DeleteRootPrefix(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var root models.RootPrefix
		result := db.Clauses(clause.Locking{Strength: "UPDATE"}).First(&root, id)
		if errors.Is(result.Error, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "未找到该根前缀", "code": "not_found"})
			return
		}
		cidr := root.CIDR
		if err := db.Transaction(func(tx *gorm.DB) error {
			if err := tx.Where("root_prefix_id = ?", id).Delete(&models.Subnet{}).Error; err != nil {
				return err
			}
			return tx.Delete(&root).Error
		}); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "删除失败: " + err.Error()})
			return
		}
		writeAudit(db, getUsername(c), "delete_root", "root_prefix", &id,
			fmt.Sprintf("Deleted root prefix %s and all subnets", cidr))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// ── Subnet Tree ────────────────────────────────────────────────────────────────

type SubnetNode struct {
	ID       uint              `json:"id"`
	Level    string            `json:"level"`
	CIDR     string            `json:"cidr"`
	ParentID *uint             `json:"parent_id"`
	GroupID  *uint             `json:"group_id"`
	Group    *models.IPAMGroup `json:"group,omitempty"`
	TypeID   *uint             `json:"type_id"`
	Type     *models.IPAMType  `json:"type,omitempty"`
	VRFID    *uint             `json:"vrf_id"`
	VRF      *models.IPAMVRF   `json:"vrf,omitempty"`
	Remark   string            `json:"remark"`
	Children []SubnetNode      `json:"children"`
}

func GetSubnetTree(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		rootPrefixID := c.Param("id")
		var subnets []models.Subnet
		if err := db.Where("root_prefix_id = ?", rootPrefixID).
			Preload("Group").Preload("Type").Preload("VRF").
			Find(&subnets).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "查询树失败: " + err.Error()})
			return
		}
		sortSubnetsByIP(subnets)

		childrenMap := make(map[uint][]SubnetNode)
		for _, s := range subnets {
			if s.Level == "L2" && s.ParentID != nil {
				childrenMap[*s.ParentID] = append(childrenMap[*s.ParentID], SubnetNode{
					ID: s.ID, Level: s.Level, CIDR: s.CIDR, ParentID: s.ParentID,
					GroupID: s.GroupID, Group: s.Group,
					TypeID: s.TypeID, Type: s.Type,
					VRFID: s.VRFID, VRF: s.VRF,
					Remark: s.Remark,
					Children: []SubnetNode{},
				})
			}
		}

		var l1Nodes []SubnetNode
		for _, s := range subnets {
			if s.Level == "L1" {
				node := SubnetNode{
					ID: s.ID, Level: s.Level, CIDR: s.CIDR, ParentID: nil,
					GroupID: s.GroupID, Group: s.Group,
					TypeID: s.TypeID, Type: s.Type,
					VRFID: s.VRFID, VRF: s.VRF,
					Remark: s.Remark,
				}
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

// ── Subnet Update ──────────────────────────────────────────────────────────────

func UpdateSubnet(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var req struct {
			GroupID *uint  `json:"group_id"`
			TypeID  *uint  `json:"type_id"`
			VRFID   *uint  `json:"vrf_id"`
			Remark  string `json:"remark"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}
		var subnet models.Subnet
		if err := db.First(&subnet, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "子网不存在", "code": "not_found"})
			return
		}
		if err := db.Model(&subnet).Updates(map[string]interface{}{
			"group_id": req.GroupID,
			"type_id":  req.TypeID,
			"vrf_id":   req.VRFID,
			"remark":   req.Remark,
		}).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "更新失败: " + err.Error(), "code": "server_error"})
			return
		}
		writeAudit(db, getUsername(c), "update_subnet", "subnet", &id,
			fmt.Sprintf("Updated subnet %s group/type/vrf", subnet.CIDR))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// ── Split ──────────────────────────────────────────────────────────────────────

func SplitSubnet(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			TargetType string `json:"target_type" binding:"required,oneof=root subnet"`
			TargetID   uint   `json:"target_id" binding:"required"`
			TargetBits int    `json:"target_bits" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}

		var splitCIDR string
		err := db.Transaction(func(tx *gorm.DB) error {
			var parentCIDR string
			var rootPrefixID uint
			var ipVersion int
			var newLevel string
			var newParentID *uint

			if req.TargetType == "root" {
				var root models.RootPrefix
				if err := tx.First(&root, req.TargetID).Error; err != nil {
					return &core.CodedError{Code: "not_found", Msg: "指定的根前缀不存在"}
				}
				parentCIDR, rootPrefixID, ipVersion = root.CIDR, root.ID, root.IPVersion
				newLevel, newParentID = "L1", nil
				splitCIDR = root.CIDR
				if err := tx.Where("root_prefix_id = ?", root.ID).Delete(&models.Subnet{}).Error; err != nil {
					return fmt.Errorf("清空旧子网失败")
				}
			} else {
				var subnet models.Subnet
				if err := tx.First(&subnet, req.TargetID).Error; err != nil {
					return &core.CodedError{Code: "not_found", Msg: "指定的子网不存在"}
				}
				parentCIDR, rootPrefixID, ipVersion = subnet.CIDR, subnet.RootPrefixID, subnet.IPVersion
				splitCIDR = subnet.CIDR
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

			// Load root prefix to inherit group/type/vrf
			var rootPfx models.RootPrefix
			if err := tx.First(&rootPfx, rootPrefixID).Error; err != nil {
				return fmt.Errorf("无法获取根前缀信息")
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
					GroupID:      rootPfx.GroupID,
					TypeID:       rootPfx.TypeID,
					VRFID:        rootPfx.VRFID,
				})
			}
			if len(newSubnets) > 0 {
				if err := tx.Create(&newSubnets).Error; err != nil {
					// ipam_subnets.cidr 全局唯一：拆分结果可能与其他根前缀下的既有子网撞号
					if isDuplicateErr(err) {
						return &core.CodedError{Code: "ipam.subnet_conflict", Msg: "拆分结果与现有子网冲突：目标网段已存在于其他前缀下"}
					}
					return fmt.Errorf("批量写入新子网数据失败")
				}
			}
			return nil
		})

		if err != nil {
			c.JSON(http.StatusBadRequest, codedErrJSON(err))
			return
		}
		writeAudit(db, getUsername(c), "split", "subnet", &req.TargetID,
			fmt.Sprintf("Split %s into /%d subnets", splitCIDR, req.TargetBits))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// ── Merge ──────────────────────────────────────────────────────────────────────

func MergeSubnets(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			SubnetIDs []uint `json:"subnet_ids" binding:"required,min=2"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误，至少需要选择两个子网", "code": "ipam.merge_min_two"})
			return
		}

		var mergedCIDR string
		err := db.Transaction(func(tx *gorm.DB) error {
			var subnets []models.Subnet
			if err := tx.Where("id IN ?", req.SubnetIDs).Find(&subnets).Error; err != nil {
				return fmt.Errorf("查询数据库失败")
			}
			if len(subnets) != len(req.SubnetIDs) {
				return &core.CodedError{Code: "ipam.subnet_missing", Msg: "部分选中的子网已不存在"}
			}

			baseLevel, baseParentID, baseRootID := subnets[0].Level, subnets[0].ParentID, subnets[0].RootPrefixID
			var cidrList []string
			for _, s := range subnets {
				if s.Level != baseLevel {
					return &core.CodedError{Code: "ipam.merge_level_mismatch", Msg: "所选子网不属于同一级别，禁止合并"}
				}
				if s.RootPrefixID != baseRootID {
					return &core.CodedError{Code: "ipam.merge_root_mismatch", Msg: "所选子网不属于同一个根前缀，禁止合并"}
				}
				if (s.ParentID == nil && baseParentID != nil) ||
					(s.ParentID != nil && baseParentID == nil) ||
					(s.ParentID != nil && baseParentID != nil && *s.ParentID != *baseParentID) {
					return &core.CodedError{Code: "ipam.merge_parent_mismatch", Msg: "所选子网不属于同一个父级节点，禁止合并"}
				}
				cidrList = append(cidrList, s.CIDR)
			}

			result, err := core.CalculateMergeSubnets(cidrList)
			if err != nil {
				return err
			}
			mergedCIDR = result

			newSubnet := models.Subnet{
				RootPrefixID: baseRootID,
				IPVersion:    subnets[0].IPVersion,
				CIDR:         mergedCIDR,
				Level:        baseLevel,
				ParentID:     baseParentID,
				GroupID:      subnets[0].GroupID,
				TypeID:       subnets[0].TypeID,
				VRFID:        subnets[0].VRFID,
			}
			if err := tx.Create(&newSubnet).Error; err != nil {
				if isDuplicateErr(err) {
					return &core.CodedError{Code: "ipam.subnet_conflict", Msg: "合并结果与现有子网冲突：目标网段已存在于其他前缀下"}
				}
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
			c.JSON(http.StatusBadRequest, codedErrJSON(err))
			return
		}
		firstID := req.SubnetIDs[0]
		writeAudit(db, getUsername(c), "merge", "subnet", &firstID,
			fmt.Sprintf("Merged %d subnets into %s", len(req.SubnetIDs), mergedCIDR))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// ── Audit Log ──────────────────────────────────────────────────────────────────

func ListAuditLogs(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
		pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))
		if page < 1 {
			page = 1
		}
		if pageSize < 1 || pageSize > 100 {
			pageSize = 20
		}
		query := db.Model(&models.IPAMAuditLog{}).Order("created_at desc")
		if u := c.Query("username"); u != "" {
			query = query.Where("username LIKE ?", "%"+u+"%")
		}
		if a := c.Query("action"); a != "" {
			query = query.Where("action = ?", a)
		}
		if rt := c.Query("resource_type"); rt != "" {
			query = query.Where("resource_type = ?", rt)
		}
		var total int64
		query.Count(&total)
		var logs []models.IPAMAuditLog
		query.Offset((page - 1) * pageSize).Limit(pageSize).Find(&logs)
		c.JSON(http.StatusOK, gin.H{"total": total, "items": logs, "page": page, "page_size": pageSize})
	}
}

func PurgeAuditLogs(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		daysStr := c.Query("days")
		days, err := strconv.Atoi(daysStr)
		if err != nil || days < 1 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的天数参数（最小 1 天）", "code": "bad_request"})
			return
		}
		cutoff := time.Now().AddDate(0, 0, -days)
		result := db.Where("created_at < ?", cutoff).Delete(&models.IPAMAuditLog{})
		writeAudit(db, getUsername(c), "purge_audit", "audit_log", nil,
			fmt.Sprintf("Purged audit logs older than %d days (%d rows)", days, result.RowsAffected))
		c.JSON(http.StatusOK, gin.H{"deleted": result.RowsAffected})
	}
}

// ── Route Registration ─────────────────────────────────────────────────────────

func RegisterIPAMRoutes(r *gin.Engine, db *gorm.DB, authMW gin.HandlerFunc) {
	api := r.Group("/api/v1/ipam")
	api.Use(authMW)
	// 读操作对任何已登录用户开放；写操作需要 ipam:write 权限（admin 直通）；
	// 审计日志清理仅限管理员。
	w := middleware.RequirePerm(models.PermIPAMWrite)
	{
		// Root Prefixes
		api.POST("/root-prefixes", w, CreateRootPrefix(db))
		api.GET("/root-prefixes", ListRootPrefixes(db))
		api.PUT("/root-prefixes/:id", w, UpdateRootPrefix(db))
		api.DELETE("/root-prefixes/:id", w, DeleteRootPrefix(db))

		// Subnet Tree & Operations
		api.GET("/root-prefixes/:id/tree", GetSubnetTree(db))
		api.POST("/split", w, SplitSubnet(db))
		api.POST("/merge", w, MergeSubnets(db))
		api.PUT("/subnets/:id", w, UpdateSubnet(db))

		// Lookup Tables
		api.GET("/groups", ListIPAMGroups(db))
		api.POST("/groups", w, CreateIPAMGroup(db))
		api.PUT("/groups/:id", w, UpdateIPAMGroup(db))
		api.DELETE("/groups/:id", w, DeleteIPAMGroup(db))

		api.GET("/types", ListIPAMTypes(db))
		api.POST("/types", w, CreateIPAMType(db))
		api.PUT("/types/:id", w, UpdateIPAMType(db))
		api.DELETE("/types/:id", w, DeleteIPAMType(db))

		api.GET("/vrfs", ListVRFs(db))
		api.POST("/vrfs", w, CreateVRF(db))
		api.PUT("/vrfs/:id", w, UpdateVRF(db))
		api.DELETE("/vrfs/:id", w, DeleteVRF(db))

		// Audit Log（查看：登录即可；清理：仅管理员）
		api.GET("/audit-logs", ListAuditLogs(db))
		api.DELETE("/audit-logs", middleware.AdminRequired, PurgeAuditLogs(db))
	}
}
