package controllers

// 自定义 OID 指标时序的分层归档（与 probe_rollup.go 同构的 Cacti/RRD RRA 模式）。
// 原始点（device_metric_points）为短期工作集（snmp.metrics_max_age_days）；本文件
// 的后台任务每小时把原始点聚合到 device_metric_rollups 的各归档层（幂等 upsert），
// 并按层清理过期桶。趋势查询（GetDeviceSNMPOIDSeries）按时间窗口自动选源：
// 原始点覆盖不到的长窗口自动落到能覆盖的最细归档层。

import (
	"fmt"
	"log/slog"
	"time"

	"nms-backend/models"

	"gorm.io/gorm"
)

// metricRollupRecomputeWindow 每次汇总重算的回看窗口——远大于运行间隔（1 小时），
// 任务漏跑/进程重启后自动补算；配合唯一键 upsert 天然幂等。
const metricRollupRecomputeWindow = 26 * time.Hour

// metricRollupLockName MySQL 咨询锁：多实例部署时同一时刻只有一个实例执行归档。
const metricRollupLockName = "nms_metric_rollup"

// ValidateMetricRollups 启动时校验指标归档层配置（fail-fast，规则与
// ValidateRetentionConfig 的 probe_rollups 一致）。rawDays 为原始点保留天数
// （snmp.metrics_max_age_days，0 = 永久）。
func ValidateMetricRollups(tiers []RollupTier, rawDays int) error {
	prevBucket, prevAge := 0, 0
	for i, tier := range tiers {
		if tier.BucketMinutes < 1 || tier.BucketMinutes > 44640 {
			return fmt.Errorf("metric_rollups[%d]: bucket_minutes 取值范围 1-44640", i)
		}
		if tier.MaxAgeDays < 1 {
			return fmt.Errorf("metric_rollups[%d]: max_age_days 必须 ≥ 1", i)
		}
		if tier.BucketMinutes <= prevBucket {
			return fmt.Errorf("metric_rollups[%d]: 各层 bucket_minutes 必须严格递增", i)
		}
		if tier.MaxAgeDays < prevAge {
			return fmt.Errorf("metric_rollups[%d]: 粗粒度层的 max_age_days 不应短于细粒度层", i)
		}
		prevBucket, prevAge = tier.BucketMinutes, tier.MaxAgeDays
	}
	if len(tiers) > 0 && rawDays > 0 {
		maxBucket := tiers[len(tiers)-1].BucketMinutes
		minRawDays := maxBucket/1440*2 + 2
		if rawDays < minRawDays {
			return fmt.Errorf("metrics_max_age_days (%d 天) 过短：启用归档时需 ≥ %d 天（最大桶 %d 分钟的 2 倍 + 余量），否则原始点在被聚合前就会过期",
				rawDays, minRawDays, maxBucket)
		}
	}
	return nil
}

// StartDeviceMetricRollups 启动指标归档任务：立即执行一次，之后每小时一次。
// 未配置归档层时不启动（趋势查询只用原始点）。
func StartDeviceMetricRollups(db *gorm.DB, cfg SNMPConfig) {
	if len(cfg.MetricRollups) == 0 {
		return
	}
	slog.Info("SNMP 指标归档已启用", "tiers", len(cfg.MetricRollups))
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			runMetricRollups(db, cfg)
			<-ticker.C
		}
	}()
}

func runMetricRollups(db *gorm.DB, cfg SNMPConfig) {
	// 同 probe_rollup.go：GET_LOCK 是会话级的，用 db.Connection 钉住一条连接持锁，
	// 实际聚合放回普通连接池执行（钉住连接的 Statement 会被 Scan 目标污染）。
	err := db.Connection(func(conn *gorm.DB) error {
		var got int
		if err := conn.Raw("SELECT GET_LOCK(?, 0)", metricRollupLockName).Scan(&got).Error; err != nil {
			return err
		}
		if got != 1 {
			slog.Info("指标归档：其他实例正在执行，本轮跳过")
			return nil
		}
		defer conn.Exec("SELECT RELEASE_LOCK(?)", metricRollupLockName)
		doMetricRollups(db, cfg)
		return nil
	})
	if err != nil {
		slog.Error("指标归档：加锁执行失败", "err", err)
	}
}

func doMetricRollups(db *gorm.DB, cfg SNMPConfig) {
	start := time.Now()
	since := start.Add(-metricRollupRecomputeWindow)

	// 各层聚合 upsert：直接从原始点计算（非层间级联），min/max 全程保真；
	// 存 val_sum/val_cnt 使查询期的跨桶重聚合精确（加权平均）。
	for _, tier := range cfg.MetricRollups {
		bucketSec := tier.BucketMinutes * 60
		if err := db.Exec(`
			INSERT INTO device_metric_rollups
				(oid_id, device_id, bucket_seconds, bucket_ts, val_sum, val_cnt, min_val, max_val)
			SELECT p.oid_id, MAX(p.device_id), ?,
				CAST(FLOOR(UNIX_TIMESTAMP(p.reported_at)/?)*? AS SIGNED),
				SUM(p.value), COUNT(*), MIN(p.value), MAX(p.value)
			FROM device_metric_points p
			WHERE p.reported_at >= ?
			GROUP BY p.oid_id, FLOOR(UNIX_TIMESTAMP(p.reported_at)/?)
			ON DUPLICATE KEY UPDATE
				val_sum = VALUES(val_sum), val_cnt = VALUES(val_cnt),
				min_val = VALUES(min_val), max_val = VALUES(max_val)`,
			bucketSec, bucketSec, bucketSec, since, bucketSec).Error; err != nil {
			slog.Error("指标归档：层聚合失败", "bucket_minutes", tier.BucketMinutes, "err", err)
			return
		}
	}

	// 各层过期清理
	var purged int64
	for _, tier := range cfg.MetricRollups {
		cutoff := time.Now().AddDate(0, 0, -tier.MaxAgeDays).Unix()
		res := db.Where("bucket_seconds = ? AND bucket_ts < ?", tier.BucketMinutes*60, cutoff).
			Delete(&models.DeviceMetricRollup{})
		if res.Error != nil {
			slog.Error("指标归档：过期清理失败", "bucket_minutes", tier.BucketMinutes, "err", res.Error)
		} else {
			purged += res.RowsAffected
		}
	}

	slog.Info("SNMP 指标归档完成",
		"tiers", len(cfg.MetricRollups),
		"purged", purged,
		"took", time.Since(start).Round(time.Millisecond).String(),
	)
}
