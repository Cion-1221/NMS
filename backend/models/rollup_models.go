package models

import "time"

// ── 探测结果降采样归档（Cacti/RRD RRA 同构）───────────────────────────────────
// 原始点（probe_results，粒度 = 任务 Interval）只作短期工作集；后台任务按配置的
// 归档层（如 5 分钟/30 分钟/2 小时/1 天）聚合到 probe_rollups，各层独立保留期。
// 延迟趋势图按时间范围自动选择"能覆盖起点的最细数据源"，曲线永不断档。
//
// 存储设计对标 RRD 的紧凑度（见 README「分层保留」）：
//   - 序列身份 (type, agent_id, target) 归一化到 probe_series 维表，归档行只存 4 字节 ID；
//   - probe_rollups 用 (series_id, bucket_seconds, bucket_ts) 复合主键聚簇，零二级索引；
//   - 存 lat_sum/lat_cnt 而非均值，跨层重聚合精确无失真（SUM(sum)/SUM(cnt)）。

// ProbeSeries 探测序列维表：一条 (类型, 源 Agent, 目标) 序列一行。
type ProbeSeries struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	Type      string    `gorm:"type:varchar(20);not null;uniqueIndex:idx_series_ident,priority:1" json:"type"`
	AgentID   string    `gorm:"type:varchar(64);not null;uniqueIndex:idx_series_ident,priority:2" json:"agent_id"`
	Target    string    `gorm:"type:varchar(255);not null;uniqueIndex:idx_series_ident,priority:3" json:"target"`
	CreatedAt time.Time `json:"created_at"`
}

func (ProbeSeries) TableName() string { return "probe_series" }

// ProbeRollup 单个归档桶。BucketTs 为桶起始时间（Unix 秒，UTC 对齐到 BucketSeconds
// 的整数倍）；MinMs/MaxMs 用 FLOAT（4 字节）足够毫秒级延迟精度；LatSum 保持 DOUBLE
// 保证长窗口求和精度。全部失败的桶 LatCnt=0，Min/Max 无意义（查询侧须过滤）。
type ProbeRollup struct {
	SeriesID      uint    `gorm:"primaryKey;autoIncrement:false" json:"series_id"`
	BucketSeconds int     `gorm:"primaryKey;autoIncrement:false" json:"bucket_seconds"`
	BucketTs      int64   `gorm:"primaryKey;autoIncrement:false" json:"bucket_ts"`
	LatSum        float64 `gorm:"not null;default:0" json:"lat_sum"`
	LatCnt        int64   `gorm:"not null;default:0" json:"lat_cnt"`
	MinMs         float32 `gorm:"type:float;not null;default:0" json:"min_ms"`
	MaxMs         float32 `gorm:"type:float;not null;default:0" json:"max_ms"`
	Runs          int64   `gorm:"not null;default:0" json:"runs"`
	Failed        int64   `gorm:"not null;default:0" json:"failed"`
}

func (ProbeRollup) TableName() string { return "probe_rollups" }
