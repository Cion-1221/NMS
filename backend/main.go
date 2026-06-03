package main

import (
	"fmt"
	"log/slog"
	"os"
	"time"

	"ipam-backend/controllers"
	"ipam-backend/models"

	"github.com/gin-gonic/gin"
	"github.com/spf13/viper"
	"gopkg.in/natefinch/lumberjack.v2"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

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
		Filename:   "logs/ipam.log",
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
		latency := time.Since(start)

		slog.Info("HTTP Request",
			slog.Int("status", c.Writer.Status()),
			slog.String("method", c.Request.Method),
			slog.String("path", c.Request.URL.Path),
			slog.String("ip", c.ClientIP()),
			slog.Duration("latency", latency),
		)
	}
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		fmt.Printf("无法加载 config.yaml (请确认该文件在二进制文件同级目录): %v\n", err)
		os.Exit(1)
	}

	initLogger()
	slog.Info("IPAM 后端服务开始启动...")

	dsn := fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?charset=utf8mb4&parseTime=True&loc=Local",
		cfg.Database.User, cfg.Database.Password, cfg.Database.Host, cfg.Database.Port, cfg.Database.DBName)
	
	db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{})
	if err != nil {
		slog.Error("MySQL 连接失败", "err", err)
		os.Exit(1)
	}

	if err := db.AutoMigrate(&models.RootPrefix{}, &models.Subnet{}); err != nil {
		slog.Error("自动迁移数据库失败", "err", err)
		os.Exit(1)
	}

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery(), slogGinMiddleware())

	controllers.RegisterIPAMRoutes(r, db)

	addr := fmt.Sprintf("0.0.0.0:%d", cfg.Server.Port)
	slog.Info("服务监听中", slog.String("addr", addr))
	r.Run(addr)
}
