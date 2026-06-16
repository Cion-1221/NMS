package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"nms-backend/controllers"
	"nms-backend/core"
	"nms-backend/middleware"
	"nms-backend/models"

	"github.com/gin-gonic/gin"
	"github.com/spf13/viper"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

// Config 全量配置结构，对应 config.yaml
type Config struct {
	Server struct {
		Port int `mapstructure:"port"`
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
	Log LogConfig `mapstructure:"log"`
	Audit struct {
		// 审计日志（IPAM/Devices/Agent 人工操作记录）保留天数，0 = 永久保留
		MaxAgeDays int `mapstructure:"max_age_days"`
		// probe_results（Agent 自动周期探测写入，量级远高于审计日志）保留天数，0 = 永久保留
		ProbeResultsMaxAgeDays int `mapstructure:"probe_results_max_age_days"`
	} `mapstructure:"audit"`
	// Agent PKI：内置 CA + mTLS 注册引导/任务同步两个独立 TLS 端口
	AgentPKI struct {
		Enabled        bool     `mapstructure:"enabled"`
		Dir            string   `mapstructure:"dir"`             // CA + 证书存储目录
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

	// 数据库连接池缺省值：旧版 config.yaml 未配置时保持开箱即用
	viper.SetDefault("database.max_open_conns", 25)
	viper.SetDefault("database.max_idle_conns", 10)
	viper.SetDefault("database.conn_max_lifetime_minutes", 60)
	viper.SetDefault("database.conn_max_idle_time_minutes", 10)

	// 审计日志保留缺省值
	viper.SetDefault("audit.max_age_days", 180)
	viper.SetDefault("audit.probe_results_max_age_days", 30)

	// Agent PKI 缺省值：旧版 config.yaml 未配置时保持开箱即用
	viper.SetDefault("agent_pki.enabled", true)
	viper.SetDefault("agent_pki.dir", "data/pki")
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

	initLogger(cfg.Log)
	slog.Info("NMS 后端服务启动中...")

	dsn := fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?charset=utf8mb4&parseTime=True&loc=Local",
		cfg.Database.User, cfg.Database.Password,
		cfg.Database.Host, cfg.Database.Port, cfg.Database.DBName)

	db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{})
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
		&models.DeviceAuditLog{},
		// System
		&models.SysGroup{},
		&models.SysUser{},
		&models.SysRefreshToken{},
		&models.SysSetting{},
		// Agent（Group 必须先于引用它的 Agent/Task；Agent 必须先于引用它的 Task/ProbeResult）
		&models.AgentGroup{},
		&models.Agent{},
		&models.AgentToken{},
		&models.AgentTask{},
		&models.ProbeResult{},
		&models.AgentAuditLog{},
	); err != nil {
		slog.Error("自动迁移数据库失败", "err", err)
		os.Exit(1)
	}

	// 写入初始化种子数据（幂等）
	controllers.SeedDatabase(db)

	// 审计日志 + 探测结果自动保留（后台任务，对应 max_age_days = 0 时不启用）
	controllers.StartAuditRetention(db, cfg.Audit.MaxAgeDays, cfg.Audit.ProbeResultsMaxAgeDays)

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
	// 自定义 Recovery：panic 堆栈写入 slog（落盘），而非 gin 默认的 stderr
	r.Use(middleware.Recovery())
	if cfg.Log.AccessLog {
		r.Use(slogGinMiddleware())
	}

	// 健康检查（无需认证）：探测数据库连通性，供 LB / 监控发现 DB 故障
	r.GET("/api/health", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
		defer cancel()
		if err := sqlDB.PingContext(ctx); err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "degraded", "db": "down"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ok", "db": "up"})
	})

	// JWT 中间件实例（共享给 IPAM / System 路由组）
	authMW := middleware.JWTAuth(cfg.JWT.Secret)

	// 认证配置
	authCfg := controllers.AuthConfig{
		JWTSecret:        cfg.JWT.Secret,
		RefreshTokenDays: cfg.JWT.RefreshTokenDays,
	}

	// 注册各模块路由
	controllers.RegisterAuthRoutes(r, db, authCfg)
	controllers.RegisterIPAMRoutes(r, db, authMW)
	controllers.RegisterDeviceRoutes(r, db, authMW)
	controllers.RegisterSystemRoutes(r, db, authMW)
	if pki != nil {
		controllers.RegisterAgentAdminRoutes(r, db, pki, cfg.AgentPKI.CACertDays, authMW)
		controllers.RegisterProbeResultsRoutes(r, db, authMW)
		// 后台扫描：把超过心跳阈值仍标记 online 的 Agent 翻转为 offline
		controllers.StartAgentOfflineSweeper(db)
	}

	// 优雅停机：收到 SIGINT/SIGTERM 后停止接收新连接，
	// 等待进行中的请求完成（上限 15 秒）后退出，避免发版/重启掐断在途请求
	addr := fmt.Sprintf("0.0.0.0:%d", cfg.Server.Port)
	srv := &http.Server{Addr: addr, Handler: r}

	go func() {
		slog.Info("服务监听中", slog.String("addr", addr))
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("服务启动失败", "err", err)
			os.Exit(1)
		}
	}()

	// Agent Enroll（单向 HTTPS）+ Agent Sync（mTLS）：与主 API 端口并存的两个独立 TLS
	// 监听器。Go 的 tls.Config.ClientAuth 按监听器全局生效，无法在同一端口对不同路径
	// 区分"是否要求客户端证书"，故两者必须分开监听——这两个端口需要让 Agent 直连
	// （绕开现有 Nginx/Caddy），因为 mTLS 校验在本进程内完成。
	var enrollSrv, syncSrv *http.Server
	if pki != nil {
		serverCert, err := pki.IssueServerCert(cfg.AgentPKI.ServerSAN, cfg.AgentPKI.ServerCertDays)
		if err != nil {
			slog.Error("签发 Agent PKI 服务端证书失败", "err", err)
			os.Exit(1)
		}

		enrollEngine := gin.New()
		enrollEngine.Use(middleware.Recovery())
		controllers.RegisterAgentEnrollRoutes(enrollEngine, db, pki, controllers.AgentPKIConfig{
			ClientCertDays: cfg.AgentPKI.ClientCertDays,
			SyncPort:       cfg.AgentPKI.SyncPort,
		})
		// Addr 留空主机部分（":PORT" 而非 "0.0.0.0:PORT"）—— Agent 需要同时支持
		// IPv4/IPv6（Source IP、Target 均可为任一族），监听端口本身也必须双栈可达，
		// 否则纯 IPv6 或优先 IPv6 路由的 Agent 主机连不上 enroll/sync 端口。
		// 空主机让 Go 在系统支持双栈套接字时监听 "[::]"（同时接受 v4-mapped 连接），
		// 在确实没有 IPv6 的系统上会自动回退为仅 IPv4，不需要按平台特判。
		enrollSrv = &http.Server{
			Addr:      fmt.Sprintf(":%d", cfg.AgentPKI.EnrollPort),
			Handler:   enrollEngine,
			TLSConfig: pki.TLSConfig(serverCert, false),
		}

		syncEngine := gin.New()
		syncEngine.Use(middleware.Recovery())
		controllers.RegisterAgentSyncRoutes(syncEngine, db, pki, cfg.AgentPKI.ClientCertDays)
		syncSrv = &http.Server{
			Addr:      fmt.Sprintf(":%d", cfg.AgentPKI.SyncPort),
			Handler:   syncEngine,
			TLSConfig: pki.TLSConfig(serverCert, true),
		}

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

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	slog.Info("收到退出信号，开始优雅停机...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("优雅停机超时，强制退出", "err", err)
	} else {
		slog.Info("服务已优雅停止")
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
}
