package main

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"nms-backend/asndb"
	"nms-backend/controllers"
	"nms-backend/core"
	"nms-backend/middleware"
	"nms-backend/models"

	"github.com/gin-gonic/gin"
	"github.com/spf13/viper"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

// builtinMIBFS：编译进二进制的标准 MIB 基础模块（SNMPv2-SMI/TC/CONF、IF-MIB 等），
// 首次启动 seed 进 MIB 文件库——厂商 MIB 几乎都 IMPORTS 它们。清单与来源见
// backend/mibs_builtin/README.md。
//
//go:embed mibs_builtin/*.mib
var builtinMIBFS embed.FS

// Config 全量配置结构，对应 config.yaml
type Config struct {
	Server struct {
		Port int `mapstructure:"port"`
		// TrustedProxies：主 API 引擎信任的反向代理地址（单 IP 或 CIDR）。只有来自
		// 这些地址的连接，其 X-Forwarded-For 才会被采信为客户端真实 IP——否则任何
		// 人都能伪造 XFF 绕过登录防爆破的按 IP 锁定。默认只信任本机回环。
		TrustedProxies []string `mapstructure:"trusted_proxies"`
		// HTTP 超时参数（可选，单位：秒；<= 0 表示不限制该项）：
		// 防御慢速连接耗尽（Slowloris）及空闲连接堆积，同时作用于主端口与 Agent TLS 端口。
		ReadHeaderTimeoutSeconds int `mapstructure:"read_header_timeout_seconds"`
		ReadTimeoutSeconds       int `mapstructure:"read_timeout_seconds"`
		WriteTimeoutSeconds      int `mapstructure:"write_timeout_seconds"`
		IdleTimeoutSeconds       int `mapstructure:"idle_timeout_seconds"`
	} `mapstructure:"server"`
	Database struct {
		Host     string `mapstructure:"host"`
		Port     int    `mapstructure:"port"`
		User     string `mapstructure:"user"`
		Password string `mapstructure:"password"`
		DBName   string `mapstructure:"dbname"`
		// 连接池参数 —— ConnMaxLifetime 必须小于 MySQL wait_timeout（默认 8 小时），
		// 否则空闲连接被服务端单方面关闭后，下一个请求会拿到死连接
		MaxOpenConns           int `mapstructure:"max_open_conns"`
		MaxIdleConns           int `mapstructure:"max_idle_conns"`
		ConnMaxLifetimeMinutes int `mapstructure:"conn_max_lifetime_minutes"`
		ConnMaxIdleTimeMinutes int `mapstructure:"conn_max_idle_time_minutes"`
	} `mapstructure:"database"`
	JWT struct {
		Secret           string `mapstructure:"secret"`
		RefreshTokenDays int    `mapstructure:"refresh_token_days"`
	} `mapstructure:"jwt"`
	Log   LogConfig `mapstructure:"log"`
	Audit struct {
		// 审计日志（IPAM/Devices/Agent/System 人工操作记录）保留天数，0 = 永久保留
		MaxAgeDays int `mapstructure:"max_age_days"`
		// 原始探测点（粒度=任务 Interval）保留天数，0 = 永久保留。
		// 启用 probe_rollups 归档后可大幅缩短（长期数据由归档层接力）
		ProbeResultsMaxAgeDays int `mapstructure:"probe_results_max_age_days"`
		// 路径类结果（mtr/meshmtr/traceroute，detail 为大 JSON）独立保留天数，
		// 0 = 跟随 probe_results_max_age_days
		PathResultsMaxAgeDays int `mapstructure:"path_results_max_age_days"`
		// 降采样归档层（Cacti RRA 风格），不配置 = 不启用
		ProbeRollups []struct {
			BucketMinutes int `mapstructure:"bucket_minutes"`
			MaxAgeDays    int `mapstructure:"max_age_days"`
		} `mapstructure:"probe_rollups"`
		// 磁盘空间兜底：默认关闭——生产环境磁盘通常远大于测试/小型部署，常规每日
		// 一次的保留任务已经够用。磁盘较小的部署（如 2026-07-23 事故里 9.2G 的
		// 小型 VPS，几小时内就被 probe_results 打满导致 MariaDB 崩溃）建议开启：
		// 高频检查可用空间，跌破阈值立即对 probe_results 做一次紧急清理。
		ProbeDiskGuard struct {
			Enabled              bool   `mapstructure:"enabled"`
			CheckIntervalMinutes int    `mapstructure:"check_interval_minutes"`
			CriticalFreeMB       int    `mapstructure:"critical_free_mb"`
			CheckPath            string `mapstructure:"check_path"`
		} `mapstructure:"probe_disk_guard"`
	} `mapstructure:"audit"`
	// ASN 查询：基于 CAIDA RouteViews + RIPE 数据的 IP→ASN 前缀匹配
	ASNDB struct {
		Enabled      bool   `mapstructure:"enabled"`
		V4PrefixFile string `mapstructure:"v4_prefix_file"`
		V6PrefixFile string `mapstructure:"v6_prefix_file"`
		NamesFile    string `mapstructure:"names_file"`
		// UpdateHour：每天几点执行自动下载更新（0–23，服务器本地时间）
		UpdateHour int `mapstructure:"update_hour"`
	} `mapstructure:"asndb"`
	// SNMP 设备采集：Direct 模式内置轮询器 + 运行状态看门狗 + 探针代理任务合成
	SNMP struct {
		Enabled                bool `mapstructure:"enabled"`
		DefaultIntervalSeconds int  `mapstructure:"default_interval_seconds"` // 快轮询间隔（sysUpTime + 存活）
		InventoryEveryN        int  `mapstructure:"inventory_every_n"`        // 每 N 次快轮询附带完整 system 组
		TimeoutSeconds         int  `mapstructure:"timeout_seconds"`
		Retries                int  `mapstructure:"retries"`
		MaxConcurrent          int  `mapstructure:"max_concurrent"`       // Direct poller 并发上限
		MetricsMaxAgeDays      int  `mapstructure:"metrics_max_age_days"` // 自定义 OID 时序保留天数，0 = 永久
		// MetricRollups：指标时序降采样归档层（Cacti RRA 风格，同 audit.probe_rollups；
		// 不配置 = 不启用，长窗口趋势查询只能覆盖原始点保留期内的数据）
		MetricRollups []struct {
			BucketMinutes int `mapstructure:"bucket_minutes"`
			MaxAgeDays    int `mapstructure:"max_age_days"`
		} `mapstructure:"metric_rollups"`
		MibsDir string `mapstructure:"mibs_dir"` // MIB 文件库存储目录
		// CredentialsKey：SNMP 凭证静态加密口令（任意长度，SHA-256 派生 AES-256 密钥）。
		// 留空 = 明文存储；配置后启动时自动加密存量明文凭证。
		// CredentialsKeyPrevious：密钥轮换过渡用的上一代口令——轮换时 key 填新口令、
		// previous 填旧口令，重启后启动清扫自动把全部凭证重封为新密钥，之后可移除
		// previous。⚠️ 两把口令都丢失时已加密凭证不可恢复，只能重新录入。
		CredentialsKey         string `mapstructure:"credentials_key"`
		CredentialsKeyPrevious string `mapstructure:"credentials_key_previous"`
	} `mapstructure:"snmp"`
	// Agent PKI：内置 CA + mTLS 注册引导/任务同步两个独立 TLS 端口
	AgentPKI struct {
		Enabled        bool     `mapstructure:"enabled"`
		Dir            string   `mapstructure:"dir"`              // CA + 证书存储目录
		ReleasesDir    string   `mapstructure:"releases_dir"`     // Agent 二进制文件存储目录
		EnrollPort     int      `mapstructure:"enroll_port"`      // 单向 HTTPS：Agent 首次注册
		SyncPort       int      `mapstructure:"sync_port"`        // mTLS：任务拉取/结果上报
		ServerSAN      []string `mapstructure:"server_san"`       // 服务端证书 SAN（Agent 据此拨号的主机名/IP）
		ClientCertDays int      `mapstructure:"client_cert_days"` // 签发给 Agent 的客户端证书有效期
		ServerCertDays int      `mapstructure:"server_cert_days"` // 服务端叶子证书有效期
		CACertDays     int      `mapstructure:"ca_cert_days"`     // Root CA 有效期
	} `mapstructure:"agent_pki"`
}

func loadConfig() (*Config, error) {
	viper.SetConfigName("config")
	viper.SetConfigType("yaml")
	viper.AddConfigPath(".")

	// 受信反代缺省值：只信任本机回环（Nginx 同机部署的标准拓扑）
	viper.SetDefault("server.trusted_proxies", []string{"127.0.0.1", "::1"})
	// HTTP 服务超时缺省值（秒，可选项，config.yaml 未配置时使用默认值，设为 0 则不限制）
	viper.SetDefault("server.read_header_timeout_seconds", 10)
	viper.SetDefault("server.read_timeout_seconds", 30)
	viper.SetDefault("server.write_timeout_seconds", 120)
	viper.SetDefault("server.idle_timeout_seconds", 120)

	// 数据库连接池缺省值：兼顾 Direct SNMP 轮询器、归档聚合与前端/Agent 高频并发
	viper.SetDefault("database.max_open_conns", 50)
	viper.SetDefault("database.max_idle_conns", 15)
	viper.SetDefault("database.conn_max_lifetime_minutes", 60)
	viper.SetDefault("database.conn_max_idle_time_minutes", 10)

	// 审计日志保留缺省值。probe_results 保持 30 天（与旧版一致）；path_results 0 =
	// 跟随全局；归档层默认不启用——推荐配置见 config.example.yaml 的 audit 块
	viper.SetDefault("audit.max_age_days", 180)
	viper.SetDefault("audit.probe_results_max_age_days", 30)
	viper.SetDefault("audit.path_results_max_age_days", 0)

	// 磁盘空间兜底缺省值：默认关闭；开启后每 10 分钟检查一次，可用空间跌破
	// 500MB 触发紧急清理
	viper.SetDefault("audit.probe_disk_guard.enabled", false)
	viper.SetDefault("audit.probe_disk_guard.check_interval_minutes", 10)
	viper.SetDefault("audit.probe_disk_guard.critical_free_mb", 500)
	viper.SetDefault("audit.probe_disk_guard.check_path", ".")

	// ASN DB 缺省值：功能默认关闭，开启后使用标准路径
	viper.SetDefault("asndb.enabled", false)
	viper.SetDefault("asndb.v4_prefix_file", "data/asndb/pfx2as_v4.txt")
	viper.SetDefault("asndb.v6_prefix_file", "data/asndb/pfx2as_v6.txt")
	viper.SetDefault("asndb.names_file", "data/asndb/asnames.txt")
	viper.SetDefault("asndb.update_hour", 3)

	// SNMP 采集缺省值：功能默认开启（没有配置任何设备开启采集时零开销）
	viper.SetDefault("snmp.enabled", true)
	viper.SetDefault("snmp.default_interval_seconds", 60)
	viper.SetDefault("snmp.inventory_every_n", 10)
	viper.SetDefault("snmp.timeout_seconds", 3)
	viper.SetDefault("snmp.retries", 1)
	viper.SetDefault("snmp.max_concurrent", 16)
	viper.SetDefault("snmp.metrics_max_age_days", 14)
	viper.SetDefault("snmp.mibs_dir", "data/mibs")
	viper.SetDefault("snmp.credentials_key", "")
	viper.SetDefault("snmp.credentials_key_previous", "")

	// Agent PKI 缺省值：旧版 config.yaml 未配置时保持开箱即用
	viper.SetDefault("agent_pki.enabled", true)
	viper.SetDefault("agent_pki.dir", "data/pki")
	viper.SetDefault("agent_pki.releases_dir", "data/releases")
	viper.SetDefault("agent_pki.enroll_port", 8443)
	viper.SetDefault("agent_pki.sync_port", 8444)
	viper.SetDefault("agent_pki.server_san", []string{"localhost", "127.0.0.1"})
	viper.SetDefault("agent_pki.client_cert_days", 365)
	viper.SetDefault("agent_pki.server_cert_days", 730)
	viper.SetDefault("agent_pki.ca_cert_days", 3650)

	// log 配置缺省值：旧版 config.yaml 没有 log: 块时保持开箱即用
	viper.SetDefault("log.dir", "logs")
	viper.SetDefault("log.max_age_days", 30)
	viper.SetDefault("log.max_backups", 30)
	viper.SetDefault("log.compress", true)
	viper.SetDefault("log.level", "info")
	viper.SetDefault("log.format", "json")
	viper.SetDefault("log.stdout", false)
	viper.SetDefault("log.access_log", true)

	if err := viper.ReadInConfig(); err != nil {
		return nil, err
	}
	var cfg Config
	if err := viper.Unmarshal(&cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func slogGinMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		slog.Info("HTTP",
			slog.Int("status", c.Writer.Status()),
			slog.String("method", c.Request.Method),
			slog.String("path", c.Request.URL.Path),
			slog.String("ip", c.ClientIP()),
			slog.Duration("latency", time.Since(start)),
		)
	}
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		fmt.Printf("无法加载 config.yaml（请确认文件位于二进制同级目录）: %v\n", err)
		os.Exit(1)
	}

	// 启动安全检查
	defaultSecret := "CHANGE_ME_TO_A_RANDOM_SECRET_STRING_AT_LEAST_32_CHARS"
	if cfg.JWT.Secret == "" || cfg.JWT.Secret == defaultSecret {
		fmt.Println("⚠️  警告: jwt.secret 未设置或仍为默认占位符，请在 config.yaml 中配置强随机密钥！")
	}
	if cfg.JWT.RefreshTokenDays <= 0 {
		cfg.JWT.RefreshTokenDays = 7
	}

	logCloser := initLogger(cfg.Log)
	slog.Info("NMS 后端服务启动中...")

	// 全局停机上下文与后台任务 WaitGroup：收到 SIGINT/SIGTERM 时通知所有后台协程退出，
	// 并在关闭数据库连接池与日志文件前等待在途 SQL / SNMP 轮询收尾。
	appCtx, appStop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer appStop()
	var bgWG sync.WaitGroup

	dsn := fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?charset=utf8mb4&parseTime=True&loc=Local",
		cfg.Database.User, cfg.Database.Password,
		cfg.Database.Host, cfg.Database.Port, cfg.Database.DBName)

	db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{
		// 禁止在 AutoMigrate 的 CREATE TABLE DDL 中内联 FOREIGN KEY 约束。
		// 部分 MySQL/MariaDB 版本对 GORM 生成的外键语法报 errno 150；禁用后
		// GORM 关联查询（Preload 等）照常工作，应用层已自行管理级联逻辑。
		DisableForeignKeyConstraintWhenMigrating: true,
	})
	if err != nil {
		slog.Error("MySQL 连接失败", "err", err)
		os.Exit(1)
	}

	// 连接池配置（参数详见 config.yaml database 块注释）
	sqlDB, err := db.DB()
	if err != nil {
		slog.Error("获取底层数据库连接池失败", "err", err)
		os.Exit(1)
	}
	sqlDB.SetMaxOpenConns(cfg.Database.MaxOpenConns)
	sqlDB.SetMaxIdleConns(cfg.Database.MaxIdleConns)
	sqlDB.SetConnMaxLifetime(time.Duration(cfg.Database.ConnMaxLifetimeMinutes) * time.Minute)
	sqlDB.SetConnMaxIdleTime(time.Duration(cfg.Database.ConnMaxIdleTimeMinutes) * time.Minute)

	// 一次性 schema 修正：agent_releases.download_url 在 URL 方案时期为 NOT NULL，
	// 迁移到文件上传方案后 model 中已无此字段，但 AutoMigrate 不会自动删列。
	// 不能用 DROP COLUMN IF EXISTS——那是 MariaDB 扩展语法，MySQL（含 8.x）不支持；
	// 改为先查 information_schema 判断列是否存在，两种数据库通用且天然幂等。
	var legacyCol int64
	db.Raw(`SELECT COUNT(*) FROM information_schema.COLUMNS
		WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_releases' AND COLUMN_NAME = 'download_url'`).
		Scan(&legacyCol)
	if legacyCol > 0 {
		if err := db.Exec("ALTER TABLE agent_releases DROP COLUMN download_url").Error; err != nil {
			slog.Error("删除遗留列 agent_releases.download_url 失败，请手动处理", "err", err)
		} else {
			slog.Info("已删除遗留列 agent_releases.download_url")
		}
	}

	// 自动迁移：IPAM 模块 + Device 模块 + System 模块
	// 迁移顺序：lookup 表必须先于引用它们的主表
	if err := db.AutoMigrate(
		// IPAM
		&models.IPAMGroup{},
		&models.IPAMType{},
		&models.IPAMVRF{},
		&models.RootPrefix{},
		&models.Subnet{},
		&models.IPAMAuditLog{},
		// Device
		&models.DeviceSite{},
		&models.DevicePoP{},
		&models.DeviceRole{},
		&models.DeviceVendor{},
		&models.Device{},
		&models.DeviceSNMPState{},
		&models.DeviceSNMPOID{},
		&models.DeviceMetricPoint{},
		&models.DeviceMetricRollup{},
		&models.DeviceInterface{},
		&models.DeviceMIB{},
		&models.DeviceAuditLog{},
		// System
		&models.SysGroup{},
		&models.SysUser{},
		&models.SysRefreshToken{},
		&models.SysSetting{},
		&models.SysAuditLog{},
		// Agent（Group 必须先于引用它的 Agent/Task；Agent 必须先于引用它的 Task/ProbeResult）
		&models.AgentGroup{},
		&models.Agent{},
		&models.AgentToken{},
		&models.AgentTask{},
		&models.ProbeResult{},
		&models.ProbeLatestState{},
		&models.AgentAuditLog{},
		&models.AgentRelease{},
		// 探测结果降采样归档（序列维表 + 归档桶）
		&models.ProbeSeries{},
		&models.ProbeRollup{},
	); err != nil {
		slog.Error("自动迁移数据库失败", "err", err)
		os.Exit(1)
	}

	// 一次性 schema 修正：清理 v1.31.0 未显式指定 column tag 时自动生成的冗余列 agents.trusted_cafp
	var legacyCAFPCol int64
	db.Raw(`SELECT COUNT(*) FROM information_schema.COLUMNS
		WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agents' AND COLUMN_NAME = 'trusted_cafp'`).
		Scan(&legacyCAFPCol)
	if legacyCAFPCol > 0 {
		if err := db.Exec("ALTER TABLE agents DROP COLUMN trusted_cafp").Error; err != nil {
			slog.Warn("删除遗留列 agents.trusted_cafp 失败", "err", err)
		} else {
			slog.Info("已删除遗留列 agents.trusted_cafp")
		}
	}

	// 写入初始化种子数据（仅空库首次执行）
	controllers.SeedDatabase(db)

	// probe_results 幂等去重唯一索引与 probe_latest_states 存量快照回填（后台执行，不阻塞启动）
	controllers.EnsureProbeDedupIndex(appCtx, &bgWG, db)
	controllers.BackfillProbeLatestStates(appCtx, &bgWG, db)

	// 确保 Agent 二进制存储目录存在
	releasesDir := filepath.Clean(cfg.AgentPKI.ReleasesDir)
	if err := os.MkdirAll(releasesDir, 0755); err != nil {
		slog.Error("创建 releases 目录失败", "err", err, "dir", releasesDir)
		os.Exit(1)
	}

	// 确保 MIB 文件库目录存在（与 snmp.enabled 无关——MIB 库是独立资产管理）
	mibsDir := filepath.Clean(cfg.SNMP.MibsDir)
	if err := os.MkdirAll(mibsDir, 0755); err != nil {
		slog.Error("创建 mibs 目录失败", "err", err, "dir", mibsDir)
		os.Exit(1)
	}

	// 保留策略装配 + 启动校验（配置矛盾会静默损坏长期数据，fail-fast）
	retention := controllers.RetentionConfig{
		AuditMaxAgeDays:        cfg.Audit.MaxAgeDays,
		ProbeResultsMaxAgeDays: cfg.Audit.ProbeResultsMaxAgeDays,
		PathResultsMaxAgeDays:  cfg.Audit.PathResultsMaxAgeDays,
	}
	for _, t := range cfg.Audit.ProbeRollups {
		retention.Rollups = append(retention.Rollups, controllers.RollupTier{
			BucketMinutes: t.BucketMinutes, MaxAgeDays: t.MaxAgeDays,
		})
	}
	if err := controllers.ValidateRetentionConfig(retention); err != nil {
		slog.Error("audit 保留策略配置无效", "err", err)
		os.Exit(1)
	}

	// 审计日志 + 探测结果自动保留（后台任务）
	controllers.StartAuditRetention(appCtx, &bgWG, db, retention)
	// 探测结果降采样归档（Cacti RRA 风格，未配置归档层时不启动）
	controllers.StartProbeRollups(appCtx, &bgWG, db, retention)
	// 磁盘空间兜底（默认关闭，见 audit.probe_disk_guard 注释）
	controllers.StartDiskSpaceGuard(appCtx, &bgWG, db, retention, controllers.DiskGuardConfig{
		Enabled:              cfg.Audit.ProbeDiskGuard.Enabled,
		CheckIntervalMinutes: cfg.Audit.ProbeDiskGuard.CheckIntervalMinutes,
		CriticalFreeMB:       cfg.Audit.ProbeDiskGuard.CriticalFreeMB,
		CheckPath:            cfg.Audit.ProbeDiskGuard.CheckPath,
	})

	// 敏感凭证静态加密（snmp.credentials_key 配置后启用，同时保护 SNMP 凭证与用户 TOTP 种子；previous 供密钥轮换过渡）
	secretBox, err := core.NewSecretBox(cfg.SNMP.CredentialsKey, cfg.SNMP.CredentialsKeyPrevious)
	if err != nil {
		slog.Error("初始化凭证加密失败", "err", err)
		os.Exit(1)
	}

	// SNMP 设备采集装配：Direct 模式内置轮询器 + 运行状态看门狗。
	snmpCfg := controllers.SNMPConfig{
		Enabled:                cfg.SNMP.Enabled,
		DefaultIntervalSeconds: cfg.SNMP.DefaultIntervalSeconds,
		InventoryEveryN:        cfg.SNMP.InventoryEveryN,
		TimeoutSeconds:         cfg.SNMP.TimeoutSeconds,
		Retries:                cfg.SNMP.Retries,
		MaxConcurrent:          cfg.SNMP.MaxConcurrent,
		MetricsMaxAgeDays:      cfg.SNMP.MetricsMaxAgeDays,
		Secrets:                secretBox,
	}
	for _, t := range cfg.SNMP.MetricRollups {
		snmpCfg.MetricRollups = append(snmpCfg.MetricRollups, controllers.RollupTier{
			BucketMinutes: t.BucketMinutes, MaxAgeDays: t.MaxAgeDays,
		})
	}
	if err := controllers.ValidateMetricRollups(snmpCfg.MetricRollups, snmpCfg.MetricsMaxAgeDays); err != nil {
		slog.Error("snmp.metric_rollups 配置无效", "err", err)
		os.Exit(1)
	}
	if secretBox != nil {
		slog.Info("静态加密已启用（SNMP 凭证 + TOTP 种子密钥）")
		controllers.EncryptExistingSNMPCredentials(db, snmpCfg)
		controllers.EncryptExistingTOTPSecrets(db, secretBox)
	}
	if snmpCfg.Enabled {
		controllers.StartDeviceSNMPPoller(appCtx, &bgWG, db, snmpCfg)
		controllers.StartDeviceOperStatusSweeper(appCtx, &bgWG, db, snmpCfg)
		controllers.StartDeviceMetricRetention(appCtx, &bgWG, db, snmpCfg)
		controllers.StartDeviceMetricRollups(appCtx, &bgWG, db, snmpCfg)
	} else {
		slog.Info("snmp: 设备 SNMP 采集已禁用（snmp.enabled = false）")
	}

	// 首次启动：内置标准 MIB 基础模块 seed 进文件库（幂等标记，尊重后续人工删除）
	if builtinSub, err := fs.Sub(builtinMIBFS, "mibs_builtin"); err == nil {
		controllers.SeedBuiltinMIBs(db, mibsDir, builtinSub)
	} else {
		slog.Error("内置 MIB 资源初始化失败", "err", err)
	}

	// MIB 翻译引擎：加载 MIB 文件库（解析失败的模块回写状态，不阻塞启动）
	mibEngine := controllers.NewMIBEngine(mibsDir)
	mibEngine.Rebuild(db)

	// Agent PKI：启动时自动生成/加载内置 Root CA（10 年期，跨重启持久化于磁盘）
	var pki *core.PKI
	if cfg.AgentPKI.Enabled {
		pki, err = core.LoadOrCreatePKI(cfg.AgentPKI.Dir, cfg.AgentPKI.CACertDays)
		if err != nil {
			slog.Error("初始化 Agent PKI 失败", "err", err)
			os.Exit(1)
		}
		slog.Info("Agent PKI 已就绪", slog.String("dir", cfg.AgentPKI.Dir))
	}

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	if err := r.SetTrustedProxies(cfg.Server.TrustedProxies); err != nil {
		slog.Error("设置受信代理失败（请检查 server.trusted_proxies 配置）", "err", err)
		os.Exit(1)
	}
	r.MaxMultipartMemory = 128 << 20 // 128 MiB，支持上传较大的 Agent 二进制
	r.Use(middleware.Recovery())
	r.Use(middleware.SecurityHeaders())
	if cfg.Log.AccessLog {
		r.Use(slogGinMiddleware())
	}

	// 健康检查（无需认证）
	r.GET("/api/health", middleware.RateLimit(120, time.Minute), func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
		defer cancel()
		if err := sqlDB.PingContext(ctx); err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "degraded", "db": "down"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ok", "db": "up"})
	})

	// JWT 中间件实例
	authMW := middleware.JWTAuth(cfg.JWT.Secret, db)

	// 认证配置（携带 Secrets 用于 TOTP 静态加密）
	authCfg := controllers.AuthConfig{
		JWTSecret:        cfg.JWT.Secret,
		RefreshTokenDays: cfg.JWT.RefreshTokenDays,
		Secrets:          secretBox,
	}

	// 注册各模块路由
	controllers.RegisterAuthRoutes(r, db, authCfg)
	controllers.RegisterIPAMRoutes(r, db, authMW)
	controllers.RegisterDeviceRoutes(r, db, authMW, snmpCfg, mibsDir, mibEngine)
	controllers.RegisterSystemRoutes(r, db, authMW)
	controllers.RegisterAgentAdminRoutes(r, db, authMW, releasesDir)
	controllers.RegisterProbeResultsRoutes(r, db, authMW, retention)
	controllers.RegisterOverviewRoutes(r, db, authMW)
	if pki != nil {
		controllers.RegisterAgentPKIRoutes(r, db, pki, cfg.AgentPKI.CACertDays, authMW)
		controllers.StartAgentOfflineSweeper(appCtx, &bgWG, db)
	}

	// ASN 查询功能（可选，由 asndb.enabled 控制）
	if cfg.ASNDB.Enabled {
		asnDB := new(asndb.DB)
		if err := asnDB.Load(
			cfg.ASNDB.V4PrefixFile,
			cfg.ASNDB.V6PrefixFile,
			cfg.ASNDB.NamesFile,
		); err != nil {
			slog.Warn("asndb: 初始加载失败，ASN 列将显示空值；可通过管理接口手动触发下载",
				"err", err,
				"download_endpoint", "POST /api/v1/admin/asndb/download",
			)
		}
		asndb.StartScheduler(appCtx, &bgWG, asnDB,
			cfg.ASNDB.V4PrefixFile,
			cfg.ASNDB.V6PrefixFile,
			cfg.ASNDB.NamesFile,
			cfg.ASNDB.UpdateHour,
		)
		controllers.RegisterASNRoutes(r, asnDB, authMW, middleware.AdminRequired,
			cfg.ASNDB.V4PrefixFile,
			cfg.ASNDB.V6PrefixFile,
			cfg.ASNDB.NamesFile,
		)
		slog.Info("asndb: ASN 查询功能已启用", "update_hour", cfg.ASNDB.UpdateHour)
	} else {
		slog.Info("asndb: ASN 查询功能已禁用（asndb.enabled = false）")
	}

	applyTimeouts := func(s *http.Server) *http.Server {
		if cfg.Server.ReadHeaderTimeoutSeconds > 0 {
			s.ReadHeaderTimeout = time.Duration(cfg.Server.ReadHeaderTimeoutSeconds) * time.Second
		}
		if cfg.Server.ReadTimeoutSeconds > 0 {
			s.ReadTimeout = time.Duration(cfg.Server.ReadTimeoutSeconds) * time.Second
		}
		if cfg.Server.WriteTimeoutSeconds > 0 {
			s.WriteTimeout = time.Duration(cfg.Server.WriteTimeoutSeconds) * time.Second
		}
		if cfg.Server.IdleTimeoutSeconds > 0 {
			s.IdleTimeout = time.Duration(cfg.Server.IdleTimeoutSeconds) * time.Second
		}
		return s
	}
	addr := fmt.Sprintf("0.0.0.0:%d", cfg.Server.Port)
	srv := applyTimeouts(&http.Server{Addr: addr, Handler: r})

	go func() {
		slog.Info("服务监听中", slog.String("addr", addr))
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("服务启动失败", "err", err)
			os.Exit(1)
		}
	}()

	var enrollSrv, syncSrv *http.Server
	if pki != nil {
		serverCert, err := pki.IssueServerCert(cfg.AgentPKI.ServerSAN, cfg.AgentPKI.ServerCertDays)
		if err != nil {
			slog.Error("签发 Agent PKI 服务端证书失败", "err", err)
			os.Exit(1)
		}

		enrollEngine := gin.New()
		_ = enrollEngine.SetTrustedProxies(nil)
		enrollEngine.Use(middleware.Recovery())
		controllers.RegisterAgentEnrollRoutes(enrollEngine, db, pki, controllers.AgentPKIConfig{
			ClientCertDays: cfg.AgentPKI.ClientCertDays,
			SyncPort:       cfg.AgentPKI.SyncPort,
		})
		enrollSrv = applyTimeouts(&http.Server{
			Addr:      fmt.Sprintf(":%d", cfg.AgentPKI.EnrollPort),
			Handler:   enrollEngine,
			TLSConfig: pki.TLSConfig(serverCert, false),
		})

		syncEngine := gin.New()
		_ = syncEngine.SetTrustedProxies(nil)
		syncEngine.Use(middleware.Recovery())
		controllers.RegisterAgentSyncRoutes(syncEngine, db, pki, cfg.AgentPKI.ClientCertDays, snmpCfg)
		syncSrv = applyTimeouts(&http.Server{
			Addr:      fmt.Sprintf(":%d", cfg.AgentPKI.SyncPort),
			Handler:   syncEngine,
			TLSConfig: pki.TLSConfig(serverCert, true),
		})

		go func() {
			slog.Info("Agent Enroll 服务监听中（单向 HTTPS）", slog.Int("port", cfg.AgentPKI.EnrollPort))
			if err := enrollSrv.ListenAndServeTLS("", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
				slog.Error("Agent Enroll 服务启动失败", "err", err)
				os.Exit(1)
			}
		}()
		go func() {
			slog.Info("Agent Sync 服务监听中（mTLS）", slog.Int("port", cfg.AgentPKI.SyncPort))
			if err := syncSrv.ListenAndServeTLS("", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
				slog.Error("Agent Sync 服务启动失败", "err", err)
				os.Exit(1)
			}
		}()
	}

	<-appCtx.Done()
	appStop()
	slog.Info("收到退出信号，开始优雅停机...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("主 HTTP 服务停机超时", "err", err)
	}
	if enrollSrv != nil {
		if err := enrollSrv.Shutdown(shutdownCtx); err != nil {
			slog.Error("Agent Enroll 服务停机超时", "err", err)
		}
	}
	if syncSrv != nil {
		if err := syncSrv.Shutdown(shutdownCtx); err != nil {
			slog.Error("Agent Sync 服务停机超时", "err", err)
		}
	}

	// 等待后台任务（SNMP 在途轮询、归档聚合、异步分片清理）收尾后再关闭连接池与日志文件
	bgDone := make(chan struct{})
	go func() {
		bgWG.Wait()
		controllers.WaitProbeJobs()
		close(bgDone)
	}()
	select {
	case <-bgDone:
		slog.Info("后台任务已全部安全收尾")
	case <-time.After(10 * time.Second):
		slog.Warn("等待后台任务收尾超时（10s），继续退出")
	}

	if err := sqlDB.Close(); err != nil {
		slog.Warn("关闭数据库连接池失败", "err", err)
	}
	slog.Info("服务已优雅停止")
	if logCloser != nil {
		_ = logCloser.Close()
	}
}
