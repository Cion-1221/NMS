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
		// 审计日志保留天数，0 = 永久保留
		MaxAgeDays int `mapstructure:"max_age_days"`
	} `mapstructure:"audit"`
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
	); err != nil {
		slog.Error("自动迁移数据库失败", "err", err)
		os.Exit(1)
	}

	// 写入初始化种子数据（幂等）
	controllers.SeedDatabase(db)

	// 审计日志自动保留（后台任务，max_age_days = 0 时不启用）
	controllers.StartAuditRetention(db, cfg.Audit.MaxAgeDays)

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
}
