package controllers

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"nms-backend/models"

	"gorm.io/gorm"
)

// ─────────────────────────────────────────────────────────────────────────────
// 探测结果分层保留（Cacti/RRD RRA 同构）。
// 原始点（probe_results）为短期工作集；本文件的后台任务每 10 分钟把原始点增量聚合到
// 最细归档层，粗粒度层优先从基础归档层做级联重聚合（sum/cnt/min/max/runs/failed 精确保真），
// 并按层清理过期桶。
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

// rollupRecomputeWindow 增量周期（10 分钟）下的默认回看窗口：2 小时足以覆盖 Agent 侧
// 最长 1 小时的断网重试积压与进程短暂重启窗口；启动首轮仍传 fullBackfill=true 全量自愈。
const rollupRecomputeWindow = 2 * time.Hour

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

// StartProbeRollups 启动归档任务：立即执行一次（全量覆盖原始保留期以自愈历史残缺桶），
// 之后每 10 分钟增量重算一次。
// 每次运行：补齐序列维表 → 各层按桶边界对齐幂等 upsert → 各层清理过期桶。
// 未配置归档层时不启动。
func StartProbeRollups(ctx context.Context, wg *sync.WaitGroup, db *gorm.DB, rc RetentionConfig) {
	if len(rc.Rollups) == 0 {
		slog.Info("探测结果归档未启用 (audit.probe_rollups 未配置)")
		return
	}
	slog.Info("探测结果归档已启用", "tiers", len(rc.Rollups))
	wg.Add(1)
	go func() {
		defer wg.Done()
		runProbeRollups(db, rc, true)
		ticker := time.NewTicker(10 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				runProbeRollups(db, rc, false)
			}
		}
	}()
}

// rollupLockName MySQL 咨询锁：多实例部署时保证同一时刻只有一个实例执行归档。
// 拿不到锁（其他实例正在跑）直接跳过本轮——upsert 幂等，下一轮自然补算；
// 实例崩溃时会话断开，锁自动释放，无死锁风险。
const rollupLockName = "nms_probe_rollup"

// alignRollupSince 计算单个归档层的回看起点，并向下对齐到 bucketSec 的整数倍边界。
// 必须对齐桶边界：否则滑动窗口左端落在某个粗粒度桶（如 2h / 1d）中间时，
// WHERE reported_at >= since 只会扫描该桶后半段样本，并通过 ON DUPLICATE KEY UPDATE
// 将原本完整的历史桶覆盖为残缺数据。
func alignRollupSince(now time.Time, bucketMinutes int, rawMaxAgeDays int, fullBackfill bool) time.Time {
	bucketSec := int64(bucketMinutes) * 60
	if bucketSec <= 0 {
		bucketSec = 60
	}
	lookback := rollupRecomputeWindow
	if minWin := time.Duration(bucketSec*2) * time.Second; lookback < minWin {
		lookback = minWin
	}
	if fullBackfill {
		rawDays := rawMaxAgeDays
		if rawDays <= 0 || rawDays > 45 {
			rawDays = 45
		}
		if rawWin := time.Duration(rawDays) * 24 * time.Hour; rawWin > lookback {
			lookback = rawWin
		}
	}
	sinceUnix := (now.Add(-lookback).Unix() / bucketSec) * bucketSec
	return time.Unix(sinceUnix, 0).UTC()
}

func runProbeRollups(db *gorm.DB, rc RetentionConfig, fullBackfill bool) {
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
		doProbeRollups(db, rc, fullBackfill)
		return nil
	})
	if err != nil {
		slog.Error("归档：加锁执行失败", "err", err)
	}
}

func doProbeRollups(db *gorm.DB, rc RetentionConfig, fullBackfill bool) {
	start := time.Now()
	baseTier := rc.Rollups[0]
	baseSec := baseTier.BucketMinutes * 60

	// 1. 补齐序列维表：第 0 层必读原始表；仅当存在无法从第 0 层整除级联的特殊配置层时才扩大原始扫描窗口
	rawEarliest := alignRollupSince(start, baseTier.BucketMinutes, rc.ProbeResultsMaxAgeDays, fullBackfill)
	for i := 1; i < len(rc.Rollups); i++ {
		tier := rc.Rollups[i]
		bucketSec := tier.BucketMinutes * 60
		canCascade := bucketSec%baseSec == 0 && baseTier.MaxAgeDays*86400 >= bucketSec*2
		if !canCascade {
			if ts := alignRollupSince(start, tier.BucketMinutes, rc.ProbeResultsMaxAgeDays, fullBackfill); ts.Before(rawEarliest) {
				rawEarliest = ts
			}
		}
	}

	if err := db.Exec(`
		INSERT IGNORE INTO probe_series (type, agent_id, target, created_at)
		SELECT DISTINCT pr.type, pr.agent_id, pr.target, NOW()
		FROM probe_results pr
		WHERE pr.reported_at >= ? AND pr.type NOT IN ?`,
		rawEarliest, pathProbeTypes).Error; err != nil {
		slog.Error("归档：序列维表补齐失败", "err", err)
		return
	}

	// 2. 各层聚合 upsert：第 0 层从 probe_results 原始点聚合；更高层优先从第 0 层归档桶级联聚合，
	//    利用 lat_sum/lat_cnt/min_ms/max_ms/runs/failed 的结合律实现零精度损失，同时避免粗粒度桶
	//    （如 1440m）每 10 分钟对原始热表做多日大范围扫描。
	for i, tier := range rc.Rollups {
		bucketSec := tier.BucketMinutes * 60
		canCascade := i > 0 && bucketSec%baseSec == 0 && baseTier.MaxAgeDays*86400 >= bucketSec*2
		if canCascade {
			tierSince := alignRollupSince(start, tier.BucketMinutes, baseTier.MaxAgeDays, fullBackfill)
			if err := db.Exec(`
				INSERT INTO probe_rollups
					(series_id, bucket_seconds, bucket_ts, lat_sum, lat_cnt, min_ms, max_ms, runs, failed)
				SELECT r.series_id, ?,
					CAST(FLOOR(r.bucket_ts/?)*? AS SIGNED),
					SUM(r.lat_sum),
					SUM(r.lat_cnt),
					COALESCE(MIN(CASE WHEN r.lat_cnt > 0 THEN r.min_ms END), 0),
					COALESCE(MAX(CASE WHEN r.lat_cnt > 0 THEN r.max_ms END), 0),
					SUM(r.runs),
					SUM(r.failed)
				FROM probe_rollups r
				WHERE r.bucket_seconds = ? AND r.bucket_ts >= ?
				GROUP BY r.series_id, FLOOR(r.bucket_ts/?)
				ON DUPLICATE KEY UPDATE
					lat_sum = VALUES(lat_sum), lat_cnt = VALUES(lat_cnt),
					min_ms = VALUES(min_ms), max_ms = VALUES(max_ms),
					runs = VALUES(runs), failed = VALUES(failed)`,
				bucketSec, bucketSec, bucketSec, baseSec, tierSince.Unix(), bucketSec).Error; err != nil {
				slog.Error("归档：级联聚合失败", "bucket_minutes", tier.BucketMinutes, "err", err)
				return
			}
			continue
		}

		tierSince := alignRollupSince(start, tier.BucketMinutes, rc.ProbeResultsMaxAgeDays, fullBackfill)
		if err := db.Exec(`
			INSERT INTO probe_rollups
				(series_id, bucket_seconds, bucket_ts, lat_sum, lat_cnt, min_ms, max_ms, runs, failed)
			SELECT s.id, ?,
				CAST(FLOOR(UNIX_TIMESTAMP(pr.reported_at)/?)*? AS SIGNED),
				COALESCE(SUM(CASE WHEN pr.success = 1 THEN pr.latency_ms END), 0),
				COUNT(CASE WHEN pr.success = 1 THEN pr.latency_ms END),
				COALESCE(MIN(CASE WHEN pr.success = 1 THEN pr.latency_ms END), 0),
				COALESCE(MAX(CASE WHEN pr.success = 1 THEN pr.latency_ms END), 0),
				COUNT(*),
				CAST(SUM(pr.success = 0) AS SIGNED)
			FROM probe_results pr
			JOIN probe_series s
				ON s.type = pr.type AND s.agent_id = pr.agent_id AND s.target = pr.target
			WHERE pr.reported_at >= ? AND pr.type NOT IN ?
			GROUP BY s.id, FLOOR(UNIX_TIMESTAMP(pr.reported_at)/?)
			ON DUPLICATE KEY UPDATE
				lat_sum = VALUES(lat_sum), lat_cnt = VALUES(lat_cnt),
				min_ms = VALUES(min_ms), max_ms = VALUES(max_ms),
				runs = VALUES(runs), failed = VALUES(failed)`,
			bucketSec, bucketSec, bucketSec, tierSince, pathProbeTypes, bucketSec).Error; err != nil {
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
