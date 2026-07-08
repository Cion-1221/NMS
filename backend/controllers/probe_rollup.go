package controllers

import (
	"fmt"
	"log/slog"
	"time"

	"nms-backend/models"

	"gorm.io/gorm"
)

// ─────────────────────────────────────────────────────────────────────────────
// 探测结果分层保留（Cacti/RRD RRA 同构）。
// 原始点（probe_results）为短期工作集；本文件的后台任务每小时把原始点聚合到
// probe_rollups 的各归档层（幂等 upsert），并按层清理过期桶。
// 路径类结果（mtr/meshmtr/traceroute，detail 为大 JSON、仅消费最新快照）不参与
// 归档，且可用 path_results_max_age_days 独立设置保留期。
// ─────────────────────────────────────────────────────────────────────────────

// RollupTier 一个归档层：桶粒度 + 保留期（对应 config.yaml 的 audit.probe_rollups 条目）。
type RollupTier struct {
	BucketMinutes int
	MaxAgeDays    int
}

// RetentionConfig 探测数据与审计日志的完整保留策略（main.go 由 config 装配）。
type RetentionConfig struct {
	AuditMaxAgeDays        int          // 审计日志保留天数，0 = 永久
	ProbeResultsMaxAgeDays int          // 原始探测点保留天数，0 = 永久
	PathResultsMaxAgeDays  int          // 路径类结果独立保留天数，0 = 跟随 ProbeResultsMaxAgeDays
	Rollups                []RollupTier // 归档层（可为空 = 不启用归档）
}

// pathProbeTypes 路径类探测：detail 为整段 JSON（逐跳数据），无标量延迟归档价值。
var pathProbeTypes = []string{"traceroute", "mtr", "meshmtr"}

// rollupRecomputeWindow 每次汇总重算的回看窗口。远大于运行间隔（1 小时），
// 任务漏跑/进程重启后自动补算；配合唯一主键 upsert 天然幂等。
const rollupRecomputeWindow = 26 * time.Hour

// ValidateRetentionConfig 启动时校验保留策略；配置矛盾会静默损坏长期数据，
// 因此校验失败应拒绝启动（fail-fast）。
func ValidateRetentionConfig(rc RetentionConfig) error {
	prevBucket, prevAge := 0, 0
	for i, tier := range rc.Rollups {
		if tier.BucketMinutes < 1 || tier.BucketMinutes > 44640 {
			return fmt.Errorf("probe_rollups[%d]: bucket_minutes 取值范围 1-44640", i)
		}
		if tier.MaxAgeDays < 1 {
			return fmt.Errorf("probe_rollups[%d]: max_age_days 必须 ≥ 1", i)
		}
		if tier.BucketMinutes <= prevBucket {
			return fmt.Errorf("probe_rollups[%d]: 各层 bucket_minutes 必须严格递增", i)
		}
		if tier.MaxAgeDays < prevAge {
			return fmt.Errorf("probe_rollups[%d]: 粗粒度层的 max_age_days 不应短于细粒度层", i)
		}
		prevBucket, prevAge = tier.BucketMinutes, tier.MaxAgeDays
	}
	if len(rc.Rollups) > 0 && rc.ProbeResultsMaxAgeDays > 0 {
		// 归档从原始点聚合：原始保留必须覆盖最大桶 + 重算窗口 + 余量
		maxBucket := rc.Rollups[len(rc.Rollups)-1].BucketMinutes
		minRawDays := maxBucket/1440*2 + 2
		if rc.ProbeResultsMaxAgeDays < minRawDays {
			return fmt.Errorf("probe_results_max_age_days (%d 天) 过短：启用归档时需 ≥ %d 天（最大桶 %d 分钟的 2 倍 + 余量），否则原始点在被聚合前就会过期",
				rc.ProbeResultsMaxAgeDays, minRawDays, maxBucket)
		}
	}
	return nil
}

// StartProbeRollups 启动归档任务：立即执行一次，之后每小时一次。
// 每次运行：补齐序列维表 → 各层幂等 upsert 最近 rollupRecomputeWindow 的桶 →
// 各层清理过期桶。未配置归档层时不启动。
func StartProbeRollups(db *gorm.DB, rc RetentionConfig) {
	if len(rc.Rollups) == 0 {
		slog.Info("探测结果归档未启用 (audit.probe_rollups 未配置)")
		return
	}
	slog.Info("探测结果归档已启用", "tiers", len(rc.Rollups))
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			runProbeRollups(db, rc)
			<-ticker.C
		}
	}()
}

// rollupLockName MySQL 咨询锁：多实例部署时保证同一时刻只有一个实例执行归档。
// 拿不到锁（其他实例正在跑）直接跳过本轮——upsert 幂等，下一小时自然补算；
// 实例崩溃时会话断开，锁自动释放，无死锁风险。
const rollupLockName = "nms_probe_rollup"

func runProbeRollups(db *gorm.DB, rc RetentionConfig) {
	// GET_LOCK 是会话级的：加锁与解锁必须发生在同一条连接上，故用 db.Connection
	// 钉住一条连接专门持锁。实际的聚合/清理工作必须放回普通连接池（db）执行——
	// 钉住的 conn 内部共享同一个 Statement，builder API（Where/Delete）会被此前
	// Scan(&got) 残留的目标污染，报 "Table not set / unsupported data type"；
	// 锁操作本身只用 Raw/Exec（自带完整 SQL），不受影响。
	err := db.Connection(func(conn *gorm.DB) error {
		var got int
		if err := conn.Raw("SELECT GET_LOCK(?, 0)", rollupLockName).Scan(&got).Error; err != nil {
			return err
		}
		if got != 1 {
			slog.Info("归档：其他实例正在执行，本轮跳过")
			return nil
		}
		defer conn.Exec("SELECT RELEASE_LOCK(?)", rollupLockName)
		doProbeRollups(db, rc)
		return nil
	})
	if err != nil {
		slog.Error("归档：加锁执行失败", "err", err)
	}
}

func doProbeRollups(db *gorm.DB, rc RetentionConfig) {
	start := time.Now()
	since := start.Add(-rollupRecomputeWindow)

	// 1. 补齐序列维表（INSERT IGNORE 幂等；路径类不建序列）
	if err := db.Exec(`
		INSERT IGNORE INTO probe_series (type, agent_id, target, created_at)
		SELECT DISTINCT pr.type, pr.agent_id, pr.target, NOW()
		FROM probe_results pr
		WHERE pr.reported_at >= ? AND pr.type NOT IN ?`,
		since, pathProbeTypes).Error; err != nil {
		slog.Error("归档：序列维表补齐失败", "err", err)
		return
	}

	// 2. 各层聚合 upsert：直接从原始点计算（非层间级联），min/max/丢包全程保真。
	//    存 lat_sum/lat_cnt（而非均值）使跨层重聚合精确；全失败桶 lat_cnt=0。
	for _, tier := range rc.Rollups {
		bucketSec := tier.BucketMinutes * 60
		if err := db.Exec(`
			INSERT INTO probe_rollups
				(series_id, bucket_seconds, bucket_ts, lat_sum, lat_cnt, min_ms, max_ms, runs, failed)
			SELECT s.id, ?,
				CAST(FLOOR(UNIX_TIMESTAMP(pr.reported_at)/?)*? AS SIGNED),
				COALESCE(SUM(pr.latency_ms), 0),
				COUNT(pr.latency_ms),
				COALESCE(MIN(pr.latency_ms), 0),
				COALESCE(MAX(pr.latency_ms), 0),
				COUNT(*),
				CAST(SUM(pr.success = 0) AS SIGNED)
			FROM probe_results pr
			JOIN probe_series s
				ON s.type = pr.type AND s.agent_id = pr.agent_id AND s.target = pr.target
			WHERE pr.reported_at >= ?
			GROUP BY s.id, FLOOR(UNIX_TIMESTAMP(pr.reported_at)/?)
			ON DUPLICATE KEY UPDATE
				lat_sum = VALUES(lat_sum), lat_cnt = VALUES(lat_cnt),
				min_ms = VALUES(min_ms), max_ms = VALUES(max_ms),
				runs = VALUES(runs), failed = VALUES(failed)`,
			bucketSec, bucketSec, bucketSec, since, bucketSec).Error; err != nil {
			slog.Error("归档：层聚合失败", "bucket_minutes", tier.BucketMinutes, "err", err)
			return
		}
	}

	// 3. 各层过期清理
	var purged int64
	for _, tier := range rc.Rollups {
		cutoff := time.Now().AddDate(0, 0, -tier.MaxAgeDays).Unix()
		res := db.Where("bucket_seconds = ? AND bucket_ts < ?", tier.BucketMinutes*60, cutoff).
			Delete(&models.ProbeRollup{})
		if res.Error != nil {
			slog.Error("归档：过期清理失败", "bucket_minutes", tier.BucketMinutes, "err", res.Error)
		} else {
			purged += res.RowsAffected
		}
	}

	slog.Info("探测结果归档完成",
		"tiers", len(rc.Rollups),
		"purged", purged,
		"took", time.Since(start).Round(time.Millisecond).String(),
	)
}
