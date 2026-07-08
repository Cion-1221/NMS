package controllers

// 设备自定义标量 OID 的 CRUD（Devices → SNMP Drawer 内管理）。
// 定义与最新值同表（models.DeviceSNMPOID），本文件只动定义列
// （OID/Name/Unit），值列由采集链路（applySNMPResult）独占回写。

import (
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"nms-backend/core"
	"nms-backend/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// maxCustomOIDsPerDevice：单设备上限。所有自定义 OID 与 system 组在同一个 SNMP
// GET 报文内完成（gosnmp 默认 MaxOids=60），16 条既够用又稳妥不超包。
const maxCustomOIDsPerDevice = 16

// snmpOIDRe 数字点分 OID：至少两段，每段纯数字。
var snmpOIDRe = regexp.MustCompile(`^\d+(\.\d+)+$`)

type deviceOIDReq struct {
	OID  string `json:"oid" binding:"required"`
	Name string `json:"name"`
	Unit string `json:"unit"`
	Kind string `json:"kind"` // gauge（默认）/ counter
}

// validateDeviceOIDReq 归一化并校验请求体（去前导点/空白、格式、长度、kind 枚举）。
func validateDeviceOIDReq(req *deviceOIDReq) *core.CodedError {
	req.OID = strings.TrimPrefix(strings.TrimSpace(req.OID), ".")
	req.Name = strings.TrimSpace(req.Name)
	req.Unit = strings.TrimSpace(req.Unit)
	req.Kind = strings.ToLower(strings.TrimSpace(req.Kind))
	if req.Kind == "" {
		req.Kind = "gauge"
	}
	if req.Kind != "gauge" && req.Kind != "counter" {
		return &core.CodedError{Code: "device.invalid_snmp_oid_kind", Msg: "无效的指标类型，可选: gauge / counter"}
	}
	if len(req.OID) > 200 || !snmpOIDRe.MatchString(req.OID) {
		return &core.CodedError{Code: "device.invalid_snmp_oid", Msg: "无效的 OID（数字点分格式，如 1.3.6.1.2.1.1.3.0）"}
	}
	if rn := []rune(req.Name); len(rn) > 100 {
		req.Name = string(rn[:100])
	}
	if rn := []rune(req.Unit); len(rn) > 20 {
		req.Unit = string(rn[:20])
	}
	return nil
}

// CreateDeviceSNMPOID POST /api/v1/devices/:id/snmp/oids
// Name 留空时尝试用 MIB 翻译引擎自动命名（未命中保持空，前端回退显示数字 OID）。
func CreateDeviceSNMPOID(db *gorm.DB, engine *MIBEngine) gin.HandlerFunc {
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
		var req deviceOIDReq
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error(), "code": "bad_request"})
			return
		}
		if ce := validateDeviceOIDReq(&req); ce != nil {
			c.JSON(http.StatusBadRequest, codedErrJSON(ce))
			return
		}
		var count int64
		db.Model(&models.DeviceSNMPOID{}).Where("device_id = ?", id).Count(&count)
		if count >= maxCustomOIDsPerDevice {
			c.JSON(http.StatusBadRequest, codedErrJSON(&core.CodedError{
				Code: "device.snmp_oid_limit", Msg: fmt.Sprintf("每台设备最多 %d 个自定义 OID", maxCustomOIDsPerDevice),
				Params: map[string]string{"max": fmt.Sprint(maxCustomOIDsPerDevice)},
			}))
			return
		}
		if req.Name == "" {
			if tr := engine.Translate(req.OID); tr.Found {
				if rn := []rune(tr.Name); len(rn) > 100 {
					tr.Name = string(rn[:100])
				}
				req.Name = tr.Name
			}
		}
		row := models.DeviceSNMPOID{DeviceID: id, OID: req.OID, Name: req.Name, Unit: req.Unit, Kind: req.Kind}
		if err := db.Create(&row).Error; err != nil {
			if isDuplicateErr(err) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "该设备已存在相同 OID", "code": "device.snmp_oid_taken"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "创建失败: " + err.Error()})
			return
		}
		writeDeviceAudit(db, getUsername(c), "add_snmp_oid", "device", &id,
			fmt.Sprintf("Added custom OID %s (%s) to device %s", req.OID, req.Name, device.Hostname))
		c.JSON(http.StatusOK, row)
	}
}

// UpdateDeviceSNMPOID PUT /api/v1/devices/:id/snmp/oids/:oid_id
// 改 OID 或指标类型时清空旧值列并删除时序点——旧序列属于旧指标语义
// （换 OID 是不同对象；gauge↔counter 换算方式不同，混在一起的曲线是错的）。
func UpdateDeviceSNMPOID(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		oidID, err := parseIDParam(c, "oid_id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var req deviceOIDReq
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}
		if ce := validateDeviceOIDReq(&req); ce != nil {
			c.JSON(http.StatusBadRequest, codedErrJSON(ce))
			return
		}
		var row models.DeviceSNMPOID
		if err := db.Where("id = ? AND device_id = ?", oidID, id).First(&row).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "自定义 OID 不存在", "code": "not_found"})
			return
		}
		updates := map[string]interface{}{"oid": req.OID, "name": req.Name, "unit": req.Unit, "kind": req.Kind}
		seriesReset := req.OID != row.OID || req.Kind != row.Kind
		if seriesReset {
			updates["last_value"] = ""
			updates["last_numeric"] = nil
			updates["last_error"] = ""
			updates["polled_at"] = nil
		}
		txErr := db.Transaction(func(tx *gorm.DB) error {
			if err := tx.Model(&row).Updates(updates).Error; err != nil {
				return err
			}
			if seriesReset {
				if err := tx.Where("oid_id = ?", row.ID).Delete(&models.DeviceMetricPoint{}).Error; err != nil {
					return err
				}
				return tx.Where("oid_id = ?", row.ID).Delete(&models.DeviceMetricRollup{}).Error
			}
			return nil
		})
		if txErr != nil {
			if isDuplicateErr(txErr) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "该设备已存在相同 OID", "code": "device.snmp_oid_taken"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "更新失败: " + txErr.Error()})
			return
		}
		db.First(&row, oidID)
		writeDeviceAudit(db, getUsername(c), "update_snmp_oid", "device", &id,
			fmt.Sprintf("Updated custom OID %d → %s (%s, %s)", oidID, req.OID, req.Name, req.Kind))
		c.JSON(http.StatusOK, row)
	}
}

// DeleteDeviceSNMPOID DELETE /api/v1/devices/:id/snmp/oids/:oid_id —— 连带时序点。
func DeleteDeviceSNMPOID(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		oidID, err := parseIDParam(c, "oid_id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var row models.DeviceSNMPOID
		if err := db.Where("id = ? AND device_id = ?", oidID, id).First(&row).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "自定义 OID 不存在", "code": "not_found"})
			return
		}
		txErr := db.Transaction(func(tx *gorm.DB) error {
			if err := tx.Where("oid_id = ?", row.ID).Delete(&models.DeviceMetricPoint{}).Error; err != nil {
				return err
			}
			if err := tx.Where("oid_id = ?", row.ID).Delete(&models.DeviceMetricRollup{}).Error; err != nil {
				return err
			}
			return tx.Delete(&row).Error
		})
		if txErr != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "删除失败: " + txErr.Error()})
			return
		}
		writeDeviceAudit(db, getUsername(c), "delete_snmp_oid", "device", &id,
			fmt.Sprintf("Deleted custom OID %s (%s)", row.OID, row.Name))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// ── 趋势序列 ───────────────────────────────────────────────────────────────────

// metricSeriesRange 把 range 选择器映射为统计窗口与显示桶宽（60–120 个显示桶）。
func metricSeriesRange(r string) (window, bucket time.Duration) {
	switch r {
	case "1h":
		return time.Hour, time.Minute
	case "6h":
		return 6 * time.Hour, 5 * time.Minute
	case "7d":
		return 7 * 24 * time.Hour, 2 * time.Hour
	case "30d":
		return 30 * 24 * time.Hour, 6 * time.Hour
	case "90d":
		return 90 * 24 * time.Hour, 24 * time.Hour
	default: // "24h"
		return 24 * time.Hour, 15 * time.Minute
	}
}

// pickMetricSource 按窗口自动选数据源：原始点保留期能覆盖窗口就用原始点（最细）；
// 否则选保留期能覆盖窗口的最细归档层；都覆盖不了就用最粗层（尽力而为）。
// 返回 (选中的层, 是否用原始点)。与 latency-series 的选源哲学一致。
func pickMetricSource(cfg SNMPConfig, window time.Duration) (RollupTier, bool) {
	rawCovers := cfg.MetricsMaxAgeDays <= 0 ||
		time.Duration(cfg.MetricsMaxAgeDays)*24*time.Hour >= window
	if rawCovers || len(cfg.MetricRollups) == 0 {
		return RollupTier{}, true
	}
	for _, tier := range cfg.MetricRollups {
		if time.Duration(tier.MaxAgeDays)*24*time.Hour >= window {
			return tier, false
		}
	}
	return cfg.MetricRollups[len(cfg.MetricRollups)-1], false
}

// GetDeviceSNMPOIDSeries GET /api/v1/devices/:id/snmp/oids/:oid_id/series?range=1h|6h|24h|7d|30d|90d
// 时间桶聚合（avg/min/max/样本数），登录即可读。counter 序列的值已是每秒速率。
// 数据源按窗口自动选择（原始点 → 归档层），响应的 source 字段标注实际来源。
func GetDeviceSNMPOIDSeries(db *gorm.DB, cfg SNMPConfig) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		oidID, err := parseIDParam(c, "oid_id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var row models.DeviceSNMPOID
		if err := db.Where("id = ? AND device_id = ?", oidID, id).First(&row).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "自定义 OID 不存在", "code": "not_found"})
			return
		}
		rangeStr := c.DefaultQuery("range", "24h")
		switch rangeStr {
		case "1h", "6h", "24h", "7d", "30d", "90d":
		default:
			rangeStr = "24h"
		}
		window, bucket := metricSeriesRange(rangeStr)
		bucketSec := int64(bucket.Seconds())
		start := time.Now().Add(-window)

		type bucketRow struct {
			Bucket int64
			Avg    float64
			Min    float64
			Max    float64
			Cnt    int64
		}
		var rows []bucketRow
		tier, useRaw := pickMetricSource(cfg, window)
		source := "raw"
		if useRaw {
			db.Model(&models.DeviceMetricPoint{}).
				Select("CAST(FLOOR(UNIX_TIMESTAMP(reported_at)/?) AS SIGNED) AS bucket, "+
					"AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max, "+
					"CAST(COUNT(*) AS SIGNED) AS cnt", bucketSec).
				Where("oid_id = ? AND reported_at >= ?", row.ID, start).
				Group("bucket").Order("bucket").Scan(&rows)
		} else {
			// 归档层→显示桶的重聚合：加权平均 SUM(val_sum)/SUM(val_cnt)（层里存的是
			// 和与样本数，精确无损）；显示桶宽不低于层桶宽，避免"放大"出假点
			source = fmt.Sprintf("rollup:%dm", tier.BucketMinutes)
			tierSec := int64(tier.BucketMinutes * 60)
			if bucketSec < tierSec {
				bucketSec = tierSec
			}
			db.Model(&models.DeviceMetricRollup{}).
				Select("CAST(FLOOR(bucket_ts/?) AS SIGNED) AS bucket, "+
					"SUM(val_sum)/SUM(val_cnt) AS avg, MIN(min_val) AS min, MAX(max_val) AS max, "+
					"CAST(SUM(val_cnt) AS SIGNED) AS cnt", bucketSec).
				Where("oid_id = ? AND bucket_seconds = ? AND bucket_ts >= ? AND val_cnt > 0",
					row.ID, tierSec, start.Unix()).
				Group("bucket").Order("bucket").Scan(&rows)
		}

		points := make([]gin.H, 0, len(rows))
		for _, r := range rows {
			points = append(points, gin.H{
				"ts":  time.Unix(r.Bucket*bucketSec, 0).UTC().Format(time.RFC3339),
				"avg": r.Avg, "min": r.Min, "max": r.Max, "count": r.Cnt,
			})
		}
		c.JSON(http.StatusOK, gin.H{
			"oid_id": row.ID, "oid": row.OID, "name": row.Name,
			"unit": row.Unit, "kind": row.Kind, "range": rangeStr,
			"source": source, "points": points,
		})
	}
}
