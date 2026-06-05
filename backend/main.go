package main

import (
	"fmt"
	"log/slog"
	"os"
	"time"

	"nms-backend/controllers"
	"nms-backend/middleware"
	"nms-backend/models"

	"github.com/gin-gonic/gin"
	"github.com/spf13/viper"
	"gopkg.in/natefinch/lumberjack.v2"
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
	} `mapstructure:"database"`
	JWT struct {
		Secret           string `mapstructure:"secret"`
		RefreshTokenDays int    `mapstructure:"refresh_token_days"`
	} `mapstructure:"jwt"`
}

func loadConfig() (*Config, error) {
	viper.SetConfigName("config")
	viper.SetConfigType("yaml")
	viper.AddConfigPath(".")
	if err := viper.ReadInConfig(); err != nil {
		return nil, err
	}
	var cfg Config
	if err := viper.Unmarshal(&cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func initLogger() {
	_ = os.MkdirAll("logs", 0755)
	logRotator := &lumberjack.Logger{
		Filename:   "logs/nms.log",
		MaxSize:    10,
		MaxAge:     7,
		MaxBackups: 5,
		Compress:   true,
	}
	handler := slog.NewJSONHandler(logRotator, nil)
	slog.SetDefault(slog.New(handler))
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

	initLogger()
	slog.Info("NMS 后端服务启动中...")

	dsn := fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?charset=utf8mb4&parseTime=True&loc=Local",
		cfg.Database.User, cfg.Database.Password,
		cfg.Database.Host, cfg.Database.Port, cfg.Database.DBName)

	db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{})
	if err != nil {
		slog.Error("MySQL 连接失败", "err", err)
		os.Exit(1)
	}

	// 自动迁移：IPAM 模块 + System 模块
	if err := db.AutoMigrate(
		&models.RootPrefix{},
		&models.Subnet{},
		&models.SysGroup{},
		&models.SysUser{},
		&models.SysRefreshToken{},
	); err != nil {
		slog.Error("自动迁移数据库失败", "err", err)
		os.Exit(1)
	}

	// 写入初始化种子数据（幂等）
	controllers.SeedDatabase(db)

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery(), slogGinMiddleware())

	// 健康检查（无需认证）
	r.GET("/api/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok"})
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
	controllers.RegisterSystemRoutes(r, db, authMW)

	addr := fmt.Sprintf("0.0.0.0:%d", cfg.Server.Port)
	slog.Info("服务监听中", slog.String("addr", addr))
	if err := r.Run(addr); err != nil {
		slog.Error("服务启动失败", "err", err)
		os.Exit(1)
	}
}
