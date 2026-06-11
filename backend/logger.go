package main

import (
	"compress/gzip"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// 日志子系统：按天轮转 + 历史压缩 + 过期清理，零第三方依赖（纯 stdlib 实现）。
// 文件名格式: nms-server-2006-01-02.log（压缩后追加 .gz 后缀）。
// ─────────────────────────────────────────────────────────────────────────────

// LogConfig 日志配置，对应 config.yaml 的 log: 块
type LogConfig struct {
	Dir        string `mapstructure:"dir"`          // 日志目录，支持绝对路径
	MaxAgeDays int    `mapstructure:"max_age_days"` // 保留天数，0 = 不限制
	MaxBackups int    `mapstructure:"max_backups"`  // 最多保留的旧文件数，0 = 不限制
	Compress   bool   `mapstructure:"compress"`     // 是否 gzip 压缩历史文件
	Level      string `mapstructure:"level"`        // debug | info | warn | error
	Format     string `mapstructure:"format"`       // json | text
	Stdout     bool   `mapstructure:"stdout"`       // 是否同时输出到标准输出
	AccessLog  bool   `mapstructure:"access_log"`   // 是否记录 HTTP 访问日志
}

const (
	logBaseName = "nms-server"
	dateLayout  = "2006-01-02"
)

// 仅匹配本程序生成的日志文件，其他文件（含旧版 lumberjack 的 nms.log）一律不动
var logFileRe = regexp.MustCompile(`^` + logBaseName + `-(\d{4}-\d{2}-\d{2})\.log(\.gz)?$`)

// dailyRotateWriter 按自然日轮转的 io.Writer。
// 每次写入时检查日期，跨天则关闭旧文件、打开当日新文件，
// 并在后台 goroutine 中压缩历史文件、清理过期文件（不阻塞业务写入）。
type dailyRotateWriter struct {
	mu         sync.Mutex // 保护 file / curDate
	maintainMu sync.Mutex // 串行化后台维护任务，防止并发压缩/删除
	dir        string
	maxAgeDays int
	maxBackups int
	compress   bool

	file    *os.File
	curDate string // 当前文件对应的日期（dateLayout 格式）
}

func newDailyRotateWriter(cfg LogConfig) (*dailyRotateWriter, error) {
	dir := cfg.Dir
	if dir == "" {
		dir = "logs"
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("创建日志目录失败: %w", err)
	}
	w := &dailyRotateWriter{
		dir:        dir,
		maxAgeDays: cfg.MaxAgeDays,
		maxBackups: cfg.MaxBackups,
		compress:   cfg.Compress,
	}
	// 启动即打开当日文件，尽早暴露目录权限类错误
	w.mu.Lock()
	err := w.openLocked(time.Now().Format(dateLayout))
	w.mu.Unlock()
	if err != nil {
		return nil, err
	}
	// 启动时维护一次：压缩上次运行遗留的历史明文日志、清理过期文件
	go w.maintain()
	return w, nil
}

// Close 关闭当前日志文件（生产环境随进程存活无需调用，供测试使用）
func (w *dailyRotateWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}

func (w *dailyRotateWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	today := time.Now().Format(dateLayout)
	if w.file == nil || today != w.curDate {
		if err := w.openLocked(today); err != nil {
			return 0, err
		}
		go w.maintain()
	}
	return w.file.Write(p)
}

// openLocked 关闭当前文件并打开指定日期的新文件，调用方必须持有 w.mu
func (w *dailyRotateWriter) openLocked(date string) error {
	if w.file != nil {
		_ = w.file.Close()
		w.file = nil
	}
	path := filepath.Join(w.dir, fmt.Sprintf("%s-%s.log", logBaseName, date))
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return fmt.Errorf("打开日志文件 %s 失败: %w", path, err)
	}
	w.file = f
	w.curDate = date
	return nil
}

// maintain 压缩历史明文日志并按 maxAgeDays / maxBackups 清理过期文件。
// 当日活跃文件永不触碰；非本程序命名规则的文件一律跳过。
func (w *dailyRotateWriter) maintain() {
	w.maintainMu.Lock()
	defer w.maintainMu.Unlock()

	w.mu.Lock()
	curDate := w.curDate
	w.mu.Unlock()

	entries, err := os.ReadDir(w.dir)
	if err != nil {
		return
	}

	type oldLog struct {
		name string
		date string
	}
	var olds []oldLog
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		m := logFileRe.FindStringSubmatch(e.Name())
		if m == nil || m[1] == curDate {
			continue
		}
		name := e.Name()
		if w.compress && strings.HasSuffix(name, ".log") {
			if err := gzipAndRemove(filepath.Join(w.dir, name)); err == nil {
				name += ".gz"
			}
		}
		olds = append(olds, oldLog{name: name, date: m[1]})
	}

	// 从新到旧排序后应用双重保留策略（日期字符串可直接比较）
	sort.Slice(olds, func(i, j int) bool { return olds[i].date > olds[j].date })

	cutoff := ""
	if w.maxAgeDays > 0 {
		cutoff = time.Now().AddDate(0, 0, -w.maxAgeDays).Format(dateLayout)
	}
	for i, o := range olds {
		expired := cutoff != "" && o.date < cutoff
		overflow := w.maxBackups > 0 && i >= w.maxBackups
		if expired || overflow {
			_ = os.Remove(filepath.Join(w.dir, o.name))
		}
	}
}

// gzipAndRemove 将 path 压缩为 path.gz 并删除原文件。
// 任一步骤失败则删除残缺的 .gz、保留原文件，等待下次维护重试。
func gzipAndRemove(path string) error {
	src, err := os.Open(path)
	if err != nil {
		return err
	}
	gzPath := path + ".gz"
	dst, err := os.Create(gzPath)
	if err != nil {
		src.Close()
		return err
	}
	gz := gzip.NewWriter(dst)
	_, copyErr := io.Copy(gz, src)
	src.Close() // Windows 下必须先关闭才能 Remove
	gzErr := gz.Close()
	dstErr := dst.Close()
	if copyErr != nil || gzErr != nil || dstErr != nil {
		_ = os.Remove(gzPath)
		if copyErr != nil {
			return copyErr
		}
		if gzErr != nil {
			return gzErr
		}
		return dstErr
	}
	return os.Remove(path)
}

// parseLogLevel 解析配置中的日志级别，无法识别时回退 info 并返回 false
func parseLogLevel(s string) (slog.Level, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug, true
	case "info", "":
		return slog.LevelInfo, true
	case "warn", "warning":
		return slog.LevelWarn, true
	case "error":
		return slog.LevelError, true
	default:
		return slog.LevelInfo, false
	}
}

// initLogger 根据配置初始化全局 slog。
// 日志目录不可用时退化为纯 stdout 输出，保证服务可用性优先于日志落盘。
func initLogger(cfg LogConfig) {
	level, levelOK := parseLogLevel(cfg.Level)

	format := strings.ToLower(strings.TrimSpace(cfg.Format))
	formatOK := true
	switch format {
	case "", "json":
		format = "json"
	case "text":
	default:
		format, formatOK = "json", false
	}

	var w io.Writer
	rotator, rotErr := newDailyRotateWriter(cfg)
	switch {
	case rotErr != nil:
		w = os.Stdout
	case cfg.Stdout:
		w = io.MultiWriter(rotator, os.Stdout)
	default:
		w = rotator
	}

	opts := &slog.HandlerOptions{Level: level}
	var handler slog.Handler
	if format == "text" {
		handler = slog.NewTextHandler(w, opts)
	} else {
		handler = slog.NewJSONHandler(w, opts)
	}
	slog.SetDefault(slog.New(handler))

	if rotErr != nil {
		slog.Warn("日志目录初始化失败，日志仅输出到 stdout", "dir", cfg.Dir, "err", rotErr)
	}
	if !levelOK {
		slog.Warn("log.level 配置值无法识别，已回退为 info", "value", cfg.Level)
	}
	if !formatOK {
		slog.Warn("log.format 配置值无法识别，已回退为 json", "value", cfg.Format)
	}
}
