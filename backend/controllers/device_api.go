package controllers

import (
	"fmt"
	"net/http"
	"net/netip"
	"sort"
	"strconv"
	"time"

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

// derefStr safely dereferences a *string; returns "" for nil.
func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// sortDevicesByIP sorts by ManagementIP (IPv4) first; falls back to ManagementIPv6.
// Devices with no parseable IP sort last (zero netip.Addr{} is smallest — but since
// valid addresses are always > Addr{} they naturally sink to the bottom after valid ones).
func sortDevicesByIP(devices []models.Device) {
	getPrimaryAddr := func(d models.Device) netip.Addr {
		if d.ManagementIP != nil {
			if a, err := netip.ParseAddr(*d.ManagementIP); err == nil {
				return a
			}
		}
		if d.ManagementIPv6 != nil {
			if a, err := netip.ParseAddr(*d.ManagementIPv6); err == nil {
				return a
			}
		}
		return netip.Addr{} // invalid — sorts after all valid addresses
	}
	sort.Slice(devices, func(i, j int) bool {
		ai := getPrimaryAddr(devices[i])
		aj := getPrimaryAddr(devices[j])
		return ai.Compare(aj) < 0
	})
}

// ── Site CRUD ──────────────────────────────────────────────────────────────────

func ListDeviceSites(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var sites []models.DeviceSite
		db.Order("name asc").Find(&sites)
		c.JSON(http.StatusOK, sites)
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
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error()})
			return
		}
		site := models.DeviceSite{
			Name: req.Name, Region: req.Region,
			Address: req.Address, Description: req.Description,
		}
		if err := db.Create(&site).Error; err != nil {
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
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		var site models.DeviceSite
		if err := db.First(&site, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "站点不存在"})
			return
		}
		if err := db.Model(&site).Updates(map[string]interface{}{
			"name": req.Name, "region": req.Region,
			"address": req.Address, "description": req.Description,
		}).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "更新失败: " + err.Error()})
			return
		}
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
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf(
				"该站点下还有 %d 个 PoP 节点，请先移除所有关联 PoP 后再删除站点", popCount)})
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
		db.Preload("Site").Order("name asc").Find(&pops)
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
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error()})
			return
		}
		// Verify site exists
		var site models.DeviceSite
		if err := db.First(&site, req.SiteID).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "指定的站点不存在"})
			return
		}
		pop := models.DevicePoP{Name: req.Name, SiteID: req.SiteID, Description: req.Description}
		if err := db.Create(&pop).Error; err != nil {
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
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		// Verify site exists
		if err := db.First(&models.DeviceSite{}, req.SiteID).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "指定的站点不存在"})
			return
		}
		var pop models.DevicePoP
		if err := db.First(&pop, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "PoP 不存在"})
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
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		role := models.DeviceRole{Name: req.Name, Description: req.Description}
		if err := db.Create(&role).Error; err != nil {
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
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		var role models.DeviceRole
		if err := db.First(&role, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "角色不存在"})
			return
		}
		if err := db.Model(&role).Updates(map[string]interface{}{
			"name": req.Name, "description": req.Description,
		}).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "更新失败: " + err.Error()})
			return
		}
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
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		vendor := models.DeviceVendor{Name: req.Name, Description: req.Description}
		if err := db.Create(&vendor).Error; err != nil {
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
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		var vendor models.DeviceVendor
		if err := db.First(&vendor, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "厂商不存在"})
			return
		}
		if err := db.Model(&vendor).Updates(map[string]interface{}{
			"name": req.Name, "description": req.Description,
		}).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "更新失败: " + err.Error()})
			return
		}
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

func ListDevices(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var devices []models.Device
		db.Preload("Site").Preload("PoP").Preload("Role").Preload("Vendor").Find(&devices)
		sortDevicesByIP(devices)
		c.JSON(http.StatusOK, devices)
	}
}

// validDeviceStatus is the exhaustive set of allowed status values for a Device.
var validDeviceStatus = map[string]bool{
	"active":      true,
	"offline":     true,
	"maintenance": true,
	"planned":     true,
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

func CreateDevice(db *gorm.DB) gin.HandlerFunc {
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
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error()})
			return
		}
		// Validate & normalize IP addresses
		ipv4, ipv6, ipErr := validateAndNormalizeIPs(req.ManagementIP, req.ManagementIPv6)
		if ipErr != "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": ipErr})
			return
		}
		if ipv4 == nil && ipv6 == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "管理 IP (IPv4) 和管理 IPv6 至少填写一个"})
			return
		}
		// Default and validate status
		if req.Status == "" {
			req.Status = "active"
		}
		if !validDeviceStatus[req.Status] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的状态值，可选: active / offline / maintenance / planned"})
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
				c.JSON(http.StatusBadRequest, gin.H{"error": "所选 PoP 不属于所选站点"})
				return
			}
		}
		device := models.Device{
			Hostname:       req.Hostname,
			ManagementIP:   ipv4,
			ManagementIPv6: ipv6,
			Status:         req.Status,
			SiteID:         req.SiteID,
			PoPID:          req.PoPID,
			RoleID:         req.RoleID,
			VendorID:       req.VendorID,
			Remark:         req.Remark,
		}
		if err := db.Create(&device).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "创建失败: " + err.Error()})
			return
		}
		db.Preload("Site").Preload("PoP").Preload("Role").Preload("Vendor").First(&device, device.ID)
		writeDeviceAudit(db, getUsername(c), "create_device", "device", &device.ID,
			fmt.Sprintf("Created device %s (IP: %s IPv6: %s)",
				device.Hostname, derefStr(device.ManagementIP), derefStr(device.ManagementIPv6)))
		c.JSON(http.StatusOK, device)
	}
}

func UpdateDevice(db *gorm.DB) gin.HandlerFunc {
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
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		// Validate & normalize IP addresses
		ipv4, ipv6, ipErr := validateAndNormalizeIPs(req.ManagementIP, req.ManagementIPv6)
		if ipErr != "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": ipErr})
			return
		}
		if ipv4 == nil && ipv6 == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "管理 IP (IPv4) 和管理 IPv6 至少填写一个"})
			return
		}
		// Default and validate status
		if req.Status == "" {
			req.Status = "active"
		}
		if !validDeviceStatus[req.Status] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的状态值，可选: active / offline / maintenance / planned"})
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
				c.JSON(http.StatusBadRequest, gin.H{"error": "所选 PoP 不属于所选站点"})
				return
			}
		}
		var device models.Device
		if err := db.First(&device, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "设备不存在"})
			return
		}
		// Build the update map explicitly so that nil pointers become SQL NULL
		updates := map[string]interface{}{
			"hostname": req.Hostname,
			"status":   req.Status,
			"site_id":  req.SiteID,
			"pop_id":   req.PoPID,
			"role_id":  req.RoleID,
			"vendor_id": req.VendorID,
			"remark":   req.Remark,
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
			c.JSON(http.StatusBadRequest, gin.H{"error": "更新失败: " + err.Error()})
			return
		}
		db.Preload("Site").Preload("PoP").Preload("Role").Preload("Vendor").First(&device, id)
		writeDeviceAudit(db, getUsername(c), "update_device", "device", &id,
			fmt.Sprintf("Updated device %s (IP: %s IPv6: %s)",
				device.Hostname, derefStr(device.ManagementIP), derefStr(device.ManagementIPv6)))
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
			c.JSON(http.StatusNotFound, gin.H{"error": "设备不存在"})
			return
		}
		if err := db.Delete(&device).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "删除失败: " + err.Error()})
			return
		}
		writeDeviceAudit(db, getUsername(c), "delete_device", "device", &id,
			fmt.Sprintf("Deleted device %s (IP: %s IPv6: %s)",
				device.Hostname, derefStr(device.ManagementIP), derefStr(device.ManagementIPv6)))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
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
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的天数参数（最小 1 天）"})
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

func RegisterDeviceRoutes(r *gin.Engine, db *gorm.DB, authMW gin.HandlerFunc) {
	api := r.Group("/api/v1/devices")
	api.Use(authMW)
	{
		// Devices
		api.GET("", ListDevices(db))
		api.POST("", CreateDevice(db))
		api.PUT("/:id", UpdateDevice(db))
		api.DELETE("/:id", DeleteDevice(db))

		// Sites
		api.GET("/sites", ListDeviceSites(db))
		api.POST("/sites", CreateDeviceSite(db))
		api.PUT("/sites/:id", UpdateDeviceSite(db))
		api.DELETE("/sites/:id", DeleteDeviceSite(db))

		// PoPs
		api.GET("/pops", ListDevicePoPs(db))
		api.POST("/pops", CreateDevicePoP(db))
		api.PUT("/pops/:id", UpdateDevicePoP(db))
		api.DELETE("/pops/:id", DeleteDevicePoP(db))

		// Roles
		api.GET("/roles", ListDeviceRoles(db))
		api.POST("/roles", CreateDeviceRole(db))
		api.PUT("/roles/:id", UpdateDeviceRole(db))
		api.DELETE("/roles/:id", DeleteDeviceRole(db))

		// Vendors
		api.GET("/vendors", ListDeviceVendors(db))
		api.POST("/vendors", CreateDeviceVendor(db))
		api.PUT("/vendors/:id", UpdateDeviceVendor(db))
		api.DELETE("/vendors/:id", DeleteDeviceVendor(db))

		// Audit Log
		api.GET("/audit-logs", ListDeviceAuditLogs(db))
		api.DELETE("/audit-logs", PurgeDeviceAuditLogs(db))
	}
}
