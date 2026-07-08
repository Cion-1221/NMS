package controllers

import (
	"fmt"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"nms-backend/core"
	"nms-backend/middleware"
	"nms-backend/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// ── Device helpers ─────────────────────────────────────────────────────────────

func writeDeviceAudit(db *gorm.DB, username, action, resourceType string, resourceID *uint, detail string) {
	_ = db.Create(&models.DeviceAuditLog{
		Username:     username,
		Action:       action,
		ResourceType: resourceType,
		ResourceID:   resourceID,
		Detail:       detail,
	}).Error
}

// ── Site CRUD ──────────────────────────────────────────────────────────────────

func ListDeviceSites(db *gorm.DB) gin.HandlerFunc {
	// siteRow extends DeviceSite with a derived PoP count so the Sites table can
	// display it without a secondary request and warn before deletion.
	type siteRow struct {
		models.DeviceSite
		PopCount int64 `json:"pop_count"`
	}
	return func(c *gin.Context) {
		var rows []siteRow
		db.Model(&models.DeviceSite{}).
			Select("device_sites.*, COALESCE(COUNT(device_pops.id), 0) AS pop_count").
			Joins("LEFT JOIN device_pops ON device_pops.site_id = device_sites.id").
			Group("device_sites.id").
			Order("device_sites.name ASC").
			Scan(&rows)
		c.JSON(http.StatusOK, rows)
	}
}

func CreateDeviceSite(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Name        string `json:"name" binding:"required"`
			Region      string `json:"region"`
			Address     string `json:"address"`
			Description string `json:"description"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error(), "code": "bad_request"})
			return
		}
		site := models.DeviceSite{
			Name: req.Name, Region: req.Region,
			Address: req.Address, Description: req.Description,
		}
		if err := db.Create(&site).Error; err != nil {
			if msg := friendlyNameUniqueErr(err, "站点"); msg != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "common.name_taken"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "创建失败: " + err.Error()})
			return
		}
		writeDeviceAudit(db, getUsername(c), "create_site", "site", &site.ID,
			fmt.Sprintf("Created site: %s", req.Name))
		c.JSON(http.StatusOK, site)
	}
}

func UpdateDeviceSite(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var req struct {
			Name        string `json:"name" binding:"required"`
			Region      string `json:"region"`
			Address     string `json:"address"`
			Description string `json:"description"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}
		var site models.DeviceSite
		if err := db.First(&site, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "站点不存在", "code": "not_found"})
			return
		}
		if err := db.Model(&site).Updates(map[string]interface{}{
			"name": req.Name, "region": req.Region,
			"address": req.Address, "description": req.Description,
		}).Error; err != nil {
			if msg := friendlyNameUniqueErr(err, "站点"); msg != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "common.name_taken"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "更新失败: " + err.Error()})
			return
		}
		// Re-fetch so the response always contains the values actually written to the
		// database.  GORM's Updates(map) applies to the DB but does not guarantee
		// that the in-memory struct is updated; a fresh First() call is the safe path.
		db.First(&site, id)
		writeDeviceAudit(db, getUsername(c), "update_site", "site", &id,
			fmt.Sprintf("Updated site %d: %s", id, req.Name))
		c.JSON(http.StatusOK, site)
	}
}

func DeleteDeviceSite(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		// RESTRICT: refuse if PoPs still reference this site
		var popCount int64
		db.Model(&models.DevicePoP{}).Where("site_id = ?", id).Count(&popCount)
		if popCount > 0 {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": fmt.Sprintf("该站点下还有 %d 个 PoP 节点，请先移除所有关联 PoP 后再删除站点", popCount),
				"code":  "device.site_has_pops", "count": popCount,
			})
			return
		}
		txErr := db.Transaction(func(tx *gorm.DB) error {
			// SET NULL on devices that directly reference this site
			tx.Exec("UPDATE devices SET site_id = NULL WHERE site_id = ?", id)
			return tx.Delete(&models.DeviceSite{}, id).Error
		})
		if txErr != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "删除失败: " + txErr.Error()})
			return
		}
		writeDeviceAudit(db, getUsername(c), "delete_site", "site", &id,
			fmt.Sprintf("Deleted site %d", id))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// ── PoP CRUD ───────────────────────────────────────────────────────────────────

func ListDevicePoPs(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var pops []models.DevicePoP
		q := db.Preload("Site").Order("name asc")
		// Optional site_id filter — used when the frontend loads PoPs for a single site
		if siteIDStr := c.Query("site_id"); siteIDStr != "" {
			if siteID, err := strconv.Atoi(siteIDStr); err == nil && siteID > 0 {
				q = q.Where("site_id = ?", siteID)
			}
		}
		q.Find(&pops)
		c.JSON(http.StatusOK, pops)
	}
}

func CreateDevicePoP(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Name        string `json:"name" binding:"required"`
			SiteID      uint   `json:"site_id" binding:"required"`
			Description string `json:"description"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error(), "code": "bad_request"})
			return
		}
		// Verify site exists
		var site models.DeviceSite
		if err := db.First(&site, req.SiteID).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "指定的站点不存在", "code": "not_found"})
			return
		}
		pop := models.DevicePoP{Name: req.Name, SiteID: req.SiteID, Description: req.Description}
		if err := db.Create(&pop).Error; err != nil {
			// device_pops 表唯一约束只有 (site_id, name) 复合索引，命中重复即同名 PoP
			if isDuplicateErr(err) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "该站点下已存在同名的 PoP 节点，请使用其他名称", "code": "device.pop_name_taken"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "创建失败: " + err.Error()})
			return
		}
		db.Preload("Site").First(&pop, pop.ID)
		writeDeviceAudit(db, getUsername(c), "create_pop", "pop", &pop.ID,
			fmt.Sprintf("Created PoP: %s (site: %s)", req.Name, site.Name))
		c.JSON(http.StatusOK, pop)
	}
}

func UpdateDevicePoP(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var req struct {
			Name        string `json:"name" binding:"required"`
			SiteID      uint   `json:"site_id" binding:"required"`
			Description string `json:"description"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}
		// Verify site exists
		if err := db.First(&models.DeviceSite{}, req.SiteID).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "指定的站点不存在", "code": "not_found"})
			return
		}
		var pop models.DevicePoP
		if err := db.First(&pop, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "PoP 不存在", "code": "not_found"})
			return
		}
		oldSiteID := pop.SiteID

		txErr := db.Transaction(func(tx *gorm.DB) error {
			if err := tx.Model(&pop).Updates(map[string]interface{}{
				"name": req.Name, "site_id": req.SiteID, "description": req.Description,
			}).Error; err != nil {
				return err
			}
			// Cascade: when site changes, update all devices that belong to this PoP
			// and had the old site assigned — move them to the new site automatically.
			if req.SiteID != oldSiteID {
				if err := tx.Exec(
					"UPDATE devices SET site_id = ? WHERE pop_id = ? AND site_id = ?",
					req.SiteID, id, oldSiteID,
				).Error; err != nil {
					return err
				}
			}
			return nil
		})
		if txErr != nil {
			// 事务内只有 PoP 更新可能触发唯一冲突（级联更新 devices.site_id 不涉及唯一列）
			if isDuplicateErr(txErr) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "该站点下已存在同名的 PoP 节点，请使用其他名称", "code": "device.pop_name_taken"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "更新失败: " + txErr.Error()})
			return
		}
		db.Preload("Site").First(&pop, id)
		writeDeviceAudit(db, getUsername(c), "update_pop", "pop", &id,
			fmt.Sprintf("Updated PoP %d: %s (site %d→%d)", id, req.Name, oldSiteID, req.SiteID))
		c.JSON(http.StatusOK, pop)
	}
}

func DeleteDevicePoP(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		txErr := db.Transaction(func(tx *gorm.DB) error {
			// SET NULL — no cascade delete of devices
			tx.Exec("UPDATE devices SET pop_id = NULL WHERE pop_id = ?", id)
			return tx.Delete(&models.DevicePoP{}, id).Error
		})
		if txErr != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "删除失败: " + txErr.Error()})
			return
		}
		writeDeviceAudit(db, getUsername(c), "delete_pop", "pop", &id,
			fmt.Sprintf("Deleted PoP %d", id))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// ── Role CRUD ──────────────────────────────────────────────────────────────────

func ListDeviceRoles(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var roles []models.DeviceRole
		db.Order("name asc").Find(&roles)
		c.JSON(http.StatusOK, roles)
	}
}

func CreateDeviceRole(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Name        string `json:"name" binding:"required"`
			Description string `json:"description"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}
		role := models.DeviceRole{Name: req.Name, Description: req.Description}
		if err := db.Create(&role).Error; err != nil {
			if msg := friendlyNameUniqueErr(err, "角色"); msg != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "common.name_taken"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "创建失败: " + err.Error()})
			return
		}
		writeDeviceAudit(db, getUsername(c), "create_role", "role", &role.ID,
			fmt.Sprintf("Created role: %s", req.Name))
		c.JSON(http.StatusOK, role)
	}
}

func UpdateDeviceRole(db *gorm.DB) gin.HandlerFunc {
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
		var role models.DeviceRole
		if err := db.First(&role, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "角色不存在", "code": "not_found"})
			return
		}
		if err := db.Model(&role).Updates(map[string]interface{}{
			"name": req.Name, "description": req.Description,
		}).Error; err != nil {
			if msg := friendlyNameUniqueErr(err, "角色"); msg != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "common.name_taken"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "更新失败: " + err.Error()})
			return
		}
		db.First(&role, id) // re-fetch to ensure response reflects applied updates
		writeDeviceAudit(db, getUsername(c), "update_role", "role", &id,
			fmt.Sprintf("Updated role %d: %s", id, req.Name))
		c.JSON(http.StatusOK, role)
	}
}

func DeleteDeviceRole(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		txErr := db.Transaction(func(tx *gorm.DB) error {
			tx.Exec("UPDATE devices SET role_id = NULL WHERE role_id = ?", id)
			return tx.Delete(&models.DeviceRole{}, id).Error
		})
		if txErr != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "删除失败: " + txErr.Error()})
			return
		}
		writeDeviceAudit(db, getUsername(c), "delete_role", "role", &id,
			fmt.Sprintf("Deleted role %d", id))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// ── Vendor CRUD ────────────────────────────────────────────────────────────────

func ListDeviceVendors(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var vendors []models.DeviceVendor
		db.Order("name asc").Find(&vendors)
		c.JSON(http.StatusOK, vendors)
	}
}

func CreateDeviceVendor(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Name        string `json:"name" binding:"required"`
			Description string `json:"description"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}
		vendor := models.DeviceVendor{Name: req.Name, Description: req.Description}
		if err := db.Create(&vendor).Error; err != nil {
			if msg := friendlyNameUniqueErr(err, "厂商"); msg != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "common.name_taken"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "创建失败: " + err.Error()})
			return
		}
		writeDeviceAudit(db, getUsername(c), "create_vendor", "vendor", &vendor.ID,
			fmt.Sprintf("Created vendor: %s", req.Name))
		c.JSON(http.StatusOK, vendor)
	}
}

func UpdateDeviceVendor(db *gorm.DB) gin.HandlerFunc {
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
		var vendor models.DeviceVendor
		if err := db.First(&vendor, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "厂商不存在", "code": "not_found"})
			return
		}
		if err := db.Model(&vendor).Updates(map[string]interface{}{
			"name": req.Name, "description": req.Description,
		}).Error; err != nil {
			if msg := friendlyNameUniqueErr(err, "厂商"); msg != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "common.name_taken"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "更新失败: " + err.Error()})
			return
		}
		db.First(&vendor, id) // re-fetch to ensure response reflects applied updates
		writeDeviceAudit(db, getUsername(c), "update_vendor", "vendor", &id,
			fmt.Sprintf("Updated vendor %d: %s", id, req.Name))
		c.JSON(http.StatusOK, vendor)
	}
}

func DeleteDeviceVendor(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		txErr := db.Transaction(func(tx *gorm.DB) error {
			tx.Exec("UPDATE devices SET vendor_id = NULL WHERE vendor_id = ?", id)
			return tx.Delete(&models.DeviceVendor{}, id).Error
		})
		if txErr != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "删除失败: " + txErr.Error()})
			return
		}
		writeDeviceAudit(db, getUsername(c), "delete_vendor", "vendor", &id,
			fmt.Sprintf("Deleted vendor %d", id))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// ── Device CRUD ────────────────────────────────────────────────────────────────

// ListDevices 服务端分页 + 过滤。
// 排序规则与旧版前端排序保持一致：有管理 IP 的设备按 IP 数值升序在前
// （MySQL INET6_ATON 同时支持 IPv4/IPv6，IPv4 的 4 字节二进制天然排在
// 大多数 IPv6 的 16 字节之前），无 IP 的设备排在最后。
func ListDevices(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
		pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))
		if page < 1 {
			page = 1
		}
		if pageSize < 1 || pageSize > 200 {
			pageSize = 20
		}

		query := db.Model(&models.Device{})
		if v := c.Query("hostname"); v != "" {
			query = query.Where("hostname LIKE ?", "%"+v+"%")
		}
		if v := c.Query("ip"); v != "" {
			query = query.Where("management_ip LIKE ?", "%"+v+"%")
		}
		if v := c.Query("ipv6"); v != "" {
			query = query.Where("management_ipv6 LIKE ?", "%"+v+"%")
		}
		if v := c.Query("status"); v != "" {
			query = query.Where("status = ?", v)
		}
		if v := c.Query("oper_status"); v != "" {
			query = query.Where("oper_status = ?", v)
		}
		if v := c.Query("polling_mode"); v != "" {
			query = query.Where("polling_mode = ?", v)
		}
		for param, col := range map[string]string{
			"site_id": "site_id", "pop_id": "pop_id", "role_id": "role_id", "vendor_id": "vendor_id",
		} {
			if v := c.Query(param); v != "" {
				if id, err := strconv.Atoi(v); err == nil && id > 0 {
					query = query.Where(col+" = ?", id)
				}
			}
		}

		var total int64
		query.Count(&total)

		var devices []models.Device
		query.
			Preload("Site").Preload("PoP").Preload("Role").Preload("Vendor").Preload("SNMP").
			Order("(management_ip IS NULL AND management_ipv6 IS NULL) ASC").
			Order("COALESCE(INET6_ATON(management_ip), INET6_ATON(management_ipv6)) ASC").
			Order("id ASC").
			Offset((page - 1) * pageSize).Limit(pageSize).
			Find(&devices)
		for i := range devices {
			setDeviceCredentialFlags(&devices[i])
		}
		c.JSON(http.StatusOK, gin.H{"total": total, "items": devices, "page": page, "page_size": pageSize})
	}
}

// validDeviceStatus is the exhaustive set of allowed *admin* status values for a
// Device（管理状态，用户意图）。运行状态（up/down/unknown）在 OperStatus 字段，
// 由采集链路独占写入，不在此校验范围。
// "offline" 是历史遗留值：表单已不再提供该选项（UI 标签展示为"已停用"），但存量
// 数据仍然合法，避免一次性数据迁移。
var validDeviceStatus = map[string]bool{
	"active":      true,
	"offline":     true,
	"maintenance": true,
	"planned":     true,
}

// ── SNMP 配置校验 ──────────────────────────────────────────────────────────────

var validPollingModes = map[string]bool{"none": true, "direct": true, "agent": true}

var validSNMPVersions = map[string]bool{"1": true, "2c": true, "3": true}

// v3 协议枚举与采集侧（device_snmp_poller.go 的 v3AuthProtos/v3PrivProtos）一致。
var validV3AuthProtos = map[string]bool{
	"MD5": true, "SHA": true, "SHA224": true, "SHA256": true, "SHA384": true, "SHA512": true,
}
var validV3PrivProtos = map[string]bool{
	"DES": true, "AES": true, "AES192": true, "AES256": true, "AES192C": true, "AES256C": true,
}

// deviceSNMPReq 是 Create/Update 请求体共享的 SNMP 配置子集。
// 密码类字段（Community / v3 两个口令）语义：创建时按需必填；编辑时留空 = 保持
// 原值（凭证永不回显，前端没有旧值可回填——与改密码的交互一致）。
type deviceSNMPReq struct {
	PollingMode         string  `json:"polling_mode"`
	SNMPAgentID         *string `json:"snmp_agent_id"`
	SNMPVersion         string  `json:"snmp_version"`
	SNMPCommunity       string  `json:"snmp_community"`
	SNMPPort            *int    `json:"snmp_port"`
	SNMPIntervalSeconds *int    `json:"snmp_interval_seconds"`
	CollectInterfaces   bool    `json:"collect_interfaces"`
	SNMPV3User          string  `json:"snmp_v3_user"`
	SNMPV3AuthProto     string  `json:"snmp_v3_auth_proto"`
	SNMPV3AuthPass      string  `json:"snmp_v3_auth_pass"`
	SNMPV3PrivProto     string  `json:"snmp_v3_priv_proto"`
	SNMPV3PrivPass      string  `json:"snmp_v3_priv_pass"`
}

// hasStr 判断可空字符串列是否已有非空值（编辑场景"留空 = 保持原值"的依据）。
func hasStr(p *string) bool { return p != nil && *p != "" }

// validateDeviceSNMP 校验并原地归一化 SNMP 配置块（填默认值、direct 模式清空
// agent 绑定、协议名归一化为大写）。existing 为编辑场景的当前记录（创建传 nil），
// 用于判断密码类字段是否允许留空。返回 nil 表示通过。
func validateDeviceSNMP(db *gorm.DB, req *deviceSNMPReq, existing *models.Device) *core.CodedError {
	if req.PollingMode == "" {
		req.PollingMode = "none"
	}
	if !validPollingModes[req.PollingMode] {
		return &core.CodedError{Code: "device.invalid_polling_mode", Msg: "无效的采集模式，可选: none / direct / agent"}
	}
	if req.SNMPVersion == "" {
		req.SNMPVersion = "2c"
	}
	if !validSNMPVersions[req.SNMPVersion] {
		return &core.CodedError{Code: "device.invalid_snmp_version", Msg: "无效的 SNMP 版本，可选: 1 / 2c / 3"}
	}
	if req.SNMPPort == nil {
		p := 161
		req.SNMPPort = &p
	}
	if *req.SNMPPort < 1 || *req.SNMPPort > 65535 {
		return &core.CodedError{Code: "device.invalid_snmp_port", Msg: "无效的 SNMP 端口（1-65535）"}
	}
	if req.SNMPIntervalSeconds != nil && (*req.SNMPIntervalSeconds < 10 || *req.SNMPIntervalSeconds > 86400) {
		return &core.CodedError{Code: "device.invalid_snmp_interval", Msg: "无效的采集间隔（10-86400 秒，留空使用全局默认）"}
	}
	// v3 协议枚举随时校验（即使 polling_mode=none 也不允许存入非法值）
	req.SNMPV3AuthProto = strings.ToUpper(strings.TrimSpace(req.SNMPV3AuthProto))
	req.SNMPV3PrivProto = strings.ToUpper(strings.TrimSpace(req.SNMPV3PrivProto))
	req.SNMPV3User = strings.TrimSpace(req.SNMPV3User)
	if req.SNMPV3AuthProto != "" && !validV3AuthProtos[req.SNMPV3AuthProto] {
		return &core.CodedError{Code: "device.invalid_snmp_v3_auth_proto", Msg: "无效的 v3 认证协议，可选: MD5/SHA/SHA224/SHA256/SHA384/SHA512"}
	}
	if req.SNMPV3PrivProto != "" && !validV3PrivProtos[req.SNMPV3PrivProto] {
		return &core.CodedError{Code: "device.invalid_snmp_v3_priv_proto", Msg: "无效的 v3 加密协议，可选: DES/AES/AES192/AES256/AES192C/AES256C"}
	}
	if req.SNMPV3PrivProto != "" && req.SNMPV3AuthProto == "" {
		return &core.CodedError{Code: "device.snmp_v3_priv_requires_auth", Msg: "启用 v3 加密（authPriv）必须同时配置认证协议"}
	}
	if req.PollingMode == "none" {
		// 关闭采集时不强制凭证/探针；已存的凭证保留，方便日后重新开启
		return nil
	}
	if req.SNMPVersion == "3" {
		if req.SNMPV3User == "" {
			return &core.CodedError{Code: "device.snmp_v3_user_required", Msg: "SNMPv3 必须填写用户名"}
		}
		if req.SNMPV3AuthProto != "" && req.SNMPV3AuthPass == "" &&
			!(existing != nil && hasStr(existing.SNMPV3AuthPass)) {
			return &core.CodedError{Code: "device.snmp_v3_auth_pass_required", Msg: "配置了认证协议必须填写认证口令"}
		}
		if req.SNMPV3PrivProto != "" && req.SNMPV3PrivPass == "" &&
			!(existing != nil && hasStr(existing.SNMPV3PrivPass)) {
			return &core.CodedError{Code: "device.snmp_v3_priv_pass_required", Msg: "配置了加密协议必须填写加密口令"}
		}
	} else if req.SNMPCommunity == "" && !(existing != nil && existing.SNMPCommunity != "") {
		return &core.CodedError{Code: "device.snmp_credential_required", Msg: "开启 SNMP 采集必须填写 Community"}
	}
	if req.PollingMode == "agent" {
		if req.SNMPAgentID == nil || *req.SNMPAgentID == "" {
			return &core.CodedError{Code: "device.snmp_agent_required", Msg: "探针代理模式必须指定采集探针"}
		}
		var agent models.Agent
		if err := db.Where("agent_id = ?", *req.SNMPAgentID).First(&agent).Error; err != nil {
			return &core.CodedError{Code: "device.snmp_agent_not_found", Msg: "指定的采集探针不存在"}
		}
		if agent.Revoked {
			return &core.CodedError{Code: "device.snmp_agent_revoked", Msg: "指定的采集探针已被吊销，请更换"}
		}
	} else {
		// direct 模式不保留 agent 绑定，避免残留指向产生歧义
		req.SNMPAgentID = nil
	}
	return nil
}

// setDeviceCredentialFlags 填充凭证派生标志（响应前调用；不落库）。
func setDeviceCredentialFlags(d *models.Device) {
	d.SNMPCredentialSet = d.SNMPCommunity != ""
	d.SNMPV3AuthSet = hasStr(d.SNMPV3AuthPass)
	d.SNMPV3PrivSet = hasStr(d.SNMPV3PrivPass)
}

// strPtrOrNil 空串转 nil（可空 varchar 列的入库归一化）。
func strPtrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// formatDevicePolling 生成审计日志里的采集配置摘要——绝不包含凭证明文。
func formatDevicePolling(mode string, agentID *string) string {
	switch mode {
	case "direct":
		return "polling: direct"
	case "agent":
		if agentID != nil {
			return "polling: agent via " + *agentID
		}
		return "polling: agent"
	default:
		return "polling: none"
	}
}

// validateAndNormalizeIPs parses and normalizes both IP fields.
// Returns (ipv4, ipv6, error). Either pointer may be nil when the field was empty.
// Returns an error string (non-empty) when a provided value is not a valid IP address.
// Both pointers nil means the caller should reject the request (at least one required).
func validateAndNormalizeIPs(rawIPv4, rawIPv6 string) (ipv4 *string, ipv6 *string, errMsg string) {
	if rawIPv4 != "" {
		addr, err := netip.ParseAddr(rawIPv4)
		if err != nil {
			return nil, nil, "无效的管理 IP (IPv4) 地址: " + rawIPv4
		}
		s := addr.String()
		ipv4 = &s
	}
	if rawIPv6 != "" {
		addr, err := netip.ParseAddr(rawIPv6)
		if err != nil {
			return nil, nil, "无效的管理 IP (IPv6) 地址: " + rawIPv6
		}
		s := addr.String()
		ipv6 = &s
	}
	return ipv4, ipv6, ""
}

// friendlyDeviceUniqueErr translates MySQL unique-key violations on the devices
// table into field-specific CodedErrors (Chinese message + machine-readable code
// for frontend i18n mapping).
// Returns nil when the error is NOT a uniqueness conflict (caller falls through
// to the generic error path).
// Detection order: IPv6 before IPv4 because "management_ipv6" contains "management_ip"
// as a substring — checking the longer name first avoids false-positive matching.
func friendlyDeviceUniqueErr(err error) *core.CodedError {
	if !isDuplicateErr(err) {
		return nil
	}
	e := err.Error()
	switch {
	case strings.Contains(e, "management_ipv6"):
		return &core.CodedError{Code: "device.ipv6_taken", Msg: "该 IPv6 地址已被其他设备使用，请检查后重试"}
	case strings.Contains(e, "management_ip"):
		return &core.CodedError{Code: "device.ipv4_taken", Msg: "该 IPv4 地址已被其他设备使用，请检查后重试"}
	case strings.Contains(e, "hostname"):
		return &core.CodedError{Code: "device.hostname_taken", Msg: "主机名已存在，请使用其他名称"}
	default:
		return nil
	}
}

// formatDeviceIPs builds a concise IP summary for audit-log detail strings, including
// only fields whose pointer is non-nil and non-empty.  This avoids noisy trailing
// "IPv6: " suffixes when only one address family is configured on a device.
// Examples:
//
//	"IP: 10.0.0.1"
//	"IPv6: 2001:db8::1"
//	"IP: 10.0.0.1, IPv6: 2001:db8::1"
//	"no IP"
func formatDeviceIPs(ipv4, ipv6 *string) string {
	parts := make([]string, 0, 2)
	if ipv4 != nil && *ipv4 != "" {
		parts = append(parts, "IP: "+*ipv4)
	}
	if ipv6 != nil && *ipv6 != "" {
		parts = append(parts, "IPv6: "+*ipv6)
	}
	if len(parts) == 0 {
		return "no IP"
	}
	return strings.Join(parts, ", ")
}

func CreateDevice(db *gorm.DB, snmpCfg SNMPConfig) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Hostname       string `json:"hostname" binding:"required"`
			ManagementIP   string `json:"management_ip"`
			ManagementIPv6 string `json:"management_ipv6"`
			Status         string `json:"status"`
			SiteID         *uint  `json:"site_id"`
			PoPID          *uint  `json:"pop_id"`
			RoleID         *uint  `json:"role_id"`
			VendorID       *uint  `json:"vendor_id"`
			Remark         string `json:"remark"`
			deviceSNMPReq
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error(), "code": "bad_request"})
			return
		}
		if ce := validateDeviceSNMP(db, &req.deviceSNMPReq, nil); ce != nil {
			c.JSON(http.StatusBadRequest, codedErrJSON(ce))
			return
		}
		// Validate & normalize IP addresses
		ipv4, ipv6, ipErr := validateAndNormalizeIPs(req.ManagementIP, req.ManagementIPv6)
		if ipErr != "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": ipErr, "code": "device.invalid_ip"})
			return
		}
		if ipv4 == nil && ipv6 == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "管理 IP (IPv4) 和管理 IPv6 至少填写一个", "code": "device.ip_required"})
			return
		}
		// Default and validate status
		if req.Status == "" {
			req.Status = "active"
		}
		if !validDeviceStatus[req.Status] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的状态值，可选: active / offline / maintenance / planned", "code": "device.invalid_status"})
			return
		}
		// Validate PoP belongs to the selected Site
		if req.SiteID != nil && req.PoPID != nil {
			var pop models.DevicePoP
			if err := db.First(&pop, *req.PoPID).Error; err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "指定的 PoP 不存在"})
				return
			}
			if pop.SiteID != *req.SiteID {
				c.JSON(http.StatusBadRequest, gin.H{"error": "所选 PoP 不属于所选站点", "code": "device.pop_site_mismatch"})
				return
			}
		}
		device := models.Device{
			Hostname:            req.Hostname,
			ManagementIP:        ipv4,
			ManagementIPv6:      ipv6,
			Status:              req.Status,
			SiteID:              req.SiteID,
			PoPID:               req.PoPID,
			RoleID:              req.RoleID,
			VendorID:            req.VendorID,
			Remark:              req.Remark,
			PollingMode:         req.PollingMode,
			SNMPAgentID:         req.SNMPAgentID,
			SNMPVersion:         req.SNMPVersion,
			SNMPCommunity:       sealSNMPSecret(snmpCfg, req.SNMPCommunity),
			SNMPPort:            *req.SNMPPort,
			SNMPIntervalSeconds: req.SNMPIntervalSeconds,
			CollectInterfaces:   req.CollectInterfaces,
			SNMPV3User:          strPtrOrNil(req.SNMPV3User),
			SNMPV3AuthProto:     strPtrOrNil(req.SNMPV3AuthProto),
			SNMPV3AuthPass:      strPtrOrNil(sealSNMPSecret(snmpCfg, req.SNMPV3AuthPass)),
			SNMPV3PrivProto:     strPtrOrNil(req.SNMPV3PrivProto),
			SNMPV3PrivPass:      strPtrOrNil(sealSNMPSecret(snmpCfg, req.SNMPV3PrivPass)),
			OperStatus:          "unknown",
		}
		if err := db.Create(&device).Error; err != nil {
			if ce := friendlyDeviceUniqueErr(err); ce != nil {
				c.JSON(http.StatusBadRequest, codedErrJSON(ce))
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "创建失败: " + err.Error()})
			return
		}
		db.Preload("Site").Preload("PoP").Preload("Role").Preload("Vendor").First(&device, device.ID)
		setDeviceCredentialFlags(&device)
		writeDeviceAudit(db, getUsername(c), "create_device", "device", &device.ID,
			fmt.Sprintf("Created device %s (%s, %s)", device.Hostname,
				formatDeviceIPs(device.ManagementIP, device.ManagementIPv6),
				formatDevicePolling(device.PollingMode, device.SNMPAgentID)))
		c.JSON(http.StatusOK, device)
	}
}

func UpdateDevice(db *gorm.DB, snmpCfg SNMPConfig) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var req struct {
			Hostname       string `json:"hostname" binding:"required"`
			ManagementIP   string `json:"management_ip"`
			ManagementIPv6 string `json:"management_ipv6"`
			Status         string `json:"status"`
			SiteID         *uint  `json:"site_id"`
			PoPID          *uint  `json:"pop_id"`
			RoleID         *uint  `json:"role_id"`
			VendorID       *uint  `json:"vendor_id"`
			Remark         string `json:"remark"`
			deviceSNMPReq
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}
		// Validate & normalize IP addresses
		ipv4, ipv6, ipErr := validateAndNormalizeIPs(req.ManagementIP, req.ManagementIPv6)
		if ipErr != "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": ipErr, "code": "device.invalid_ip"})
			return
		}
		if ipv4 == nil && ipv6 == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "管理 IP (IPv4) 和管理 IPv6 至少填写一个", "code": "device.ip_required"})
			return
		}
		// Default and validate status
		if req.Status == "" {
			req.Status = "active"
		}
		if !validDeviceStatus[req.Status] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的状态值，可选: active / offline / maintenance / planned", "code": "device.invalid_status"})
			return
		}
		// Validate PoP belongs to the selected Site
		if req.SiteID != nil && req.PoPID != nil {
			var pop models.DevicePoP
			if err := db.First(&pop, *req.PoPID).Error; err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "指定的 PoP 不存在"})
				return
			}
			if pop.SiteID != *req.SiteID {
				c.JSON(http.StatusBadRequest, gin.H{"error": "所选 PoP 不属于所选站点", "code": "device.pop_site_mismatch"})
				return
			}
		}
		var device models.Device
		if err := db.First(&device, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "设备不存在", "code": "not_found"})
			return
		}
		// SNMP 配置校验：库里已有对应凭证时允许密码类字段留空（= 保持不变）
		if ce := validateDeviceSNMP(db, &req.deviceSNMPReq, &device); ce != nil {
			c.JSON(http.StatusBadRequest, codedErrJSON(ce))
			return
		}
		// Build the update map explicitly so that nil pointers become SQL NULL
		updates := map[string]interface{}{
			"hostname":     req.Hostname,
			"status":       req.Status,
			"site_id":      req.SiteID,
			"pop_id":       req.PoPID,
			"role_id":      req.RoleID,
			"vendor_id":    req.VendorID,
			"remark":       req.Remark,
			"polling_mode": req.PollingMode,
			"snmp_version": req.SNMPVersion,
			"snmp_port":    *req.SNMPPort,
		}
		if req.SNMPAgentID != nil {
			updates["snmp_agent_id"] = *req.SNMPAgentID
		} else {
			updates["snmp_agent_id"] = nil
		}
		if req.SNMPIntervalSeconds != nil {
			updates["snmp_interval_seconds"] = *req.SNMPIntervalSeconds
		} else {
			updates["snmp_interval_seconds"] = nil
		}
		updates["collect_interfaces"] = req.CollectInterfaces
		// v3 非敏感配置直接覆盖（空 = 清除）
		if req.SNMPV3User != "" {
			updates["snmp_v3_user"] = req.SNMPV3User
		} else {
			updates["snmp_v3_user"] = nil
		}
		if req.SNMPV3AuthProto != "" {
			updates["snmp_v3_auth_proto"] = req.SNMPV3AuthProto
		} else {
			updates["snmp_v3_auth_proto"] = nil
		}
		if req.SNMPV3PrivProto != "" {
			updates["snmp_v3_priv_proto"] = req.SNMPV3PrivProto
		} else {
			updates["snmp_v3_priv_proto"] = nil
		}
		// 密码类字段留空 = 保持原值（永不回显，前端没有旧值可提交）；写入时静态加密
		if req.SNMPCommunity != "" {
			updates["snmp_community"] = sealSNMPSecret(snmpCfg, req.SNMPCommunity)
		}
		if req.SNMPV3AuthPass != "" {
			updates["snmp_v3_auth_pass"] = sealSNMPSecret(snmpCfg, req.SNMPV3AuthPass)
		}
		if req.SNMPV3PrivPass != "" {
			updates["snmp_v3_priv_pass"] = sealSNMPSecret(snmpCfg, req.SNMPV3PrivPass)
		}
		// 关闭采集时立刻归位运行状态，避免最后一次采集结论永久残留（幽灵状态）
		if req.PollingMode == "none" && device.OperStatus != "unknown" {
			updates["oper_status"] = "unknown"
			updates["oper_reason"] = ""
		}
		// Use plain nil (nil interface) so GORM sets the column to SQL NULL;
		// a typed nil *string in an interface is not nil and would skip the update.
		if ipv4 != nil {
			updates["management_ip"] = *ipv4
		} else {
			updates["management_ip"] = nil
		}
		if ipv6 != nil {
			updates["management_ipv6"] = *ipv6
		} else {
			updates["management_ipv6"] = nil
		}
		if err := db.Model(&device).Updates(updates).Error; err != nil {
			if ce := friendlyDeviceUniqueErr(err); ce != nil {
				c.JSON(http.StatusBadRequest, codedErrJSON(ce))
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "更新失败: " + err.Error()})
			return
		}
		db.Preload("Site").Preload("PoP").Preload("Role").Preload("Vendor").Preload("SNMP").First(&device, id)
		setDeviceCredentialFlags(&device)
		writeDeviceAudit(db, getUsername(c), "update_device", "device", &id,
			fmt.Sprintf("Updated device %s (%s, %s)", device.Hostname,
				formatDeviceIPs(device.ManagementIP, device.ManagementIPv6),
				formatDevicePolling(device.PollingMode, device.SNMPAgentID)))
		c.JSON(http.StatusOK, device)
	}
}

func DeleteDevice(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var device models.Device
		if err := db.First(&device, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "设备不存在", "code": "not_found"})
			return
		}
		txErr := db.Transaction(func(tx *gorm.DB) error {
			// 级联清理 SNMP 状态快照 / 自定义 OID 定义 / 指标时序（无外键约束，应用层负责）
			if err := tx.Where("device_id = ?", id).Delete(&models.DeviceSNMPState{}).Error; err != nil {
				return err
			}
			if err := tx.Where("device_id = ?", id).Delete(&models.DeviceSNMPOID{}).Error; err != nil {
				return err
			}
			if err := tx.Where("device_id = ?", id).Delete(&models.DeviceMetricPoint{}).Error; err != nil {
				return err
			}
			if err := tx.Where("device_id = ?", id).Delete(&models.DeviceMetricRollup{}).Error; err != nil {
				return err
			}
			if err := tx.Where("device_id = ?", id).Delete(&models.DeviceInterface{}).Error; err != nil {
				return err
			}
			return tx.Delete(&device).Error
		})
		if txErr != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "删除失败: " + txErr.Error()})
			return
		}
		writeDeviceAudit(db, getUsername(c), "delete_device", "device", &id,
			fmt.Sprintf("Deleted device %s (%s)", device.Hostname, formatDeviceIPs(device.ManagementIP, device.ManagementIPv6)))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// ── SNMP 辅助端点 ──────────────────────────────────────────────────────────────

// ListDeviceAgentsLite GET /api/v1/devices/agents-lite
// Devices 表单"采集探针"下拉专用的轻量 Agent 列表。/api/v1/agents 全量列表是
// admin-only，而设备编辑只要求 devices:write——这里只暴露挑选探针所需的最小字段
// 集（无 IP/证书/版本等敏感运维信息），与其余 devices GET 端点一样登录即可读。
func ListDeviceAgentsLite(db *gorm.DB) gin.HandlerFunc {
	type agentLite struct {
		AgentID    string     `json:"agent_id"`
		Hostname   string     `json:"hostname"`
		Status     string     `json:"status"`
		GroupName  string     `json:"group_name"`
		LastSeenAt *time.Time `json:"last_seen_at"`
	}
	return func(c *gin.Context) {
		var rows []agentLite
		db.Model(&models.Agent{}).
			Select("agents.agent_id, agents.hostname, agents.status, COALESCE(agent_groups.name, '') AS group_name, agents.last_seen_at").
			Joins("LEFT JOIN agent_groups ON agent_groups.id = agents.group_id").
			Where("agents.revoked = ?", false).
			Order("agents.status = 'online' DESC").
			Order("agents.hostname ASC").
			Scan(&rows)
		c.JSON(http.StatusOK, rows)
	}
}

// GetDeviceSNMP GET /api/v1/devices/:id/snmp —— 设备详情 Drawer 的数据源。
// state 为 null 表示尚未有任何采集结论（新配置或从未开启过采集）。
// sys_object_id_name 是 MIB 翻译引擎对 sysObjectID 的解析结果（未命中为 null）。
func GetDeviceSNMP(db *gorm.DB, engine *MIBEngine) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var device models.Device
		if err := db.First(&device, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "设备不存在", "code": "not_found"})
			return
		}
		var statePtr *models.DeviceSNMPState
		var state models.DeviceSNMPState
		if err := db.Where("device_id = ?", id).First(&state).Error; err == nil {
			statePtr = &state
		}
		var sysObjectIDName interface{}
		if statePtr != nil && statePtr.SysObjectID != "" {
			if tr := engine.Translate(statePtr.SysObjectID); tr.Found {
				sysObjectIDName = tr.Qualified
			}
		}
		// 显式初始化为空切片：nil 切片会序列化为 JSON null，前端按数组消费会崩
		customOIDs := make([]models.DeviceSNMPOID, 0)
		db.Where("device_id = ?", id).Order("id asc").Find(&customOIDs)
		interfaces := make([]models.DeviceInterface, 0)
		if device.CollectInterfaces {
			db.Where("device_id = ?", id).Order("if_index asc").Find(&interfaces)
		}
		c.JSON(http.StatusOK, gin.H{
			"device_id":          device.ID,
			"hostname":           device.Hostname,
			"polling_mode":       device.PollingMode,
			"snmp_agent_id":      device.SNMPAgentID,
			"snmp_version":       device.SNMPVersion,
			"snmp_port":          device.SNMPPort,
			"oper_status":        device.OperStatus,
			"oper_reason":        device.OperReason,
			"collect_interfaces": device.CollectInterfaces,
			"state":              statePtr,
			"sys_object_id_name": sysObjectIDName,
			"custom_oids":        customOIDs,
			"interfaces":         interfaces,
		})
	}
}

// ── Device Audit Log ───────────────────────────────────────────────────────────

func ListDeviceAuditLogs(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
		pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))
		if page < 1 {
			page = 1
		}
		if pageSize < 1 || pageSize > 100 {
			pageSize = 20
		}
		query := db.Model(&models.DeviceAuditLog{}).Order("created_at desc")
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
		var logs []models.DeviceAuditLog
		query.Offset((page - 1) * pageSize).Limit(pageSize).Find(&logs)
		c.JSON(http.StatusOK, gin.H{"total": total, "items": logs, "page": page, "page_size": pageSize})
	}
}

func PurgeDeviceAuditLogs(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		daysStr := c.Query("days")
		days, err := strconv.Atoi(daysStr)
		if err != nil || days < 1 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的天数参数（最小 1 天）", "code": "bad_request"})
			return
		}
		cutoff := time.Now().AddDate(0, 0, -days)
		result := db.Where("created_at < ?", cutoff).Delete(&models.DeviceAuditLog{})
		writeDeviceAudit(db, getUsername(c), "purge_audit", "audit_log", nil,
			fmt.Sprintf("Purged device audit logs older than %d days (%d rows)", days, result.RowsAffected))
		c.JSON(http.StatusOK, gin.H{"deleted": result.RowsAffected})
	}
}

// ── Route Registration ─────────────────────────────────────────────────────────

func RegisterDeviceRoutes(r *gin.Engine, db *gorm.DB, authMW gin.HandlerFunc, snmpCfg SNMPConfig, mibDir string, mibEngine *MIBEngine) {
	api := r.Group("/api/v1/devices")
	api.Use(authMW)
	// 读操作对任何已登录用户开放；写操作需要 devices:write 权限（admin 直通）；
	// 审计日志清理与 MIB 库写操作仅限管理员。
	w := middleware.RequirePerm(models.PermDevicesWrite)
	{
		// Devices
		api.GET("", ListDevices(db))
		api.POST("", w, CreateDevice(db, snmpCfg))
		api.PUT("/:id", w, UpdateDevice(db, snmpCfg))
		api.DELETE("/:id", w, DeleteDevice(db))

		// SNMP 辅助端点（读操作登录即可；立即测试会发起网络请求，要求写权限）
		api.GET("/agents-lite", ListDeviceAgentsLite(db))
		api.GET("/:id/snmp", GetDeviceSNMP(db, mibEngine))
		api.POST("/:id/snmp/test", w, TestDeviceSNMP(db, snmpCfg))

		// 自定义标量 OID（随快轮询采集；定义随 /:id/snmp 详情返回）
		api.POST("/:id/snmp/oids", w, CreateDeviceSNMPOID(db, mibEngine))
		api.PUT("/:id/snmp/oids/:oid_id", w, UpdateDeviceSNMPOID(db))
		api.DELETE("/:id/snmp/oids/:oid_id", w, DeleteDeviceSNMPOID(db))
		api.GET("/:id/snmp/oids/:oid_id/series", GetDeviceSNMPOIDSeries(db, snmpCfg))

		// MIB 库（查看/下载/翻译：登录即可；上传/删除：仅管理员——与 Releases
		// 同基调，上传内容会落盘到服务器文件系统）
		api.GET("/mibs", ListDeviceMIBs(db))
		api.GET("/mibs/translate", TranslateMIBOID(mibEngine))
		api.GET("/mibs/:id/download", DownloadDeviceMIB(db))
		api.POST("/mibs", middleware.AdminRequired, UploadDeviceMIB(db, mibDir, mibEngine))
		api.DELETE("/mibs/:id", middleware.AdminRequired, DeleteDeviceMIB(db, mibEngine))

		// Sites
		api.GET("/sites", ListDeviceSites(db))
		api.POST("/sites", w, CreateDeviceSite(db))
		api.PUT("/sites/:id", w, UpdateDeviceSite(db))
		api.DELETE("/sites/:id", w, DeleteDeviceSite(db))

		// PoPs
		api.GET("/pops", ListDevicePoPs(db))
		api.POST("/pops", w, CreateDevicePoP(db))
		api.PUT("/pops/:id", w, UpdateDevicePoP(db))
		api.DELETE("/pops/:id", w, DeleteDevicePoP(db))

		// Roles
		api.GET("/roles", ListDeviceRoles(db))
		api.POST("/roles", w, CreateDeviceRole(db))
		api.PUT("/roles/:id", w, UpdateDeviceRole(db))
		api.DELETE("/roles/:id", w, DeleteDeviceRole(db))

		// Vendors
		api.GET("/vendors", ListDeviceVendors(db))
		api.POST("/vendors", w, CreateDeviceVendor(db))
		api.PUT("/vendors/:id", w, UpdateDeviceVendor(db))
		api.DELETE("/vendors/:id", w, DeleteDeviceVendor(db))

		// Audit Log（查看：登录即可；清理：仅管理员）
		api.GET("/audit-logs", ListDeviceAuditLogs(db))
		api.DELETE("/audit-logs", middleware.AdminRequired, PurgeDeviceAuditLogs(db))
	}
}
