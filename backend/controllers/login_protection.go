package controllers

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"nms-backend/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// ─────────────────────────────────────────────────────────────────────────────
// 登录防爆破：按 用户名+IP 的滑动窗口失败计数 + 临时锁定。
// 阈值由 System 模块管理界面配置，存储在 sys_settings 表（key=login_protection）。
// 计数器保存在内存中——单实例部署下足够，且重启即清零不会造成误锁。
// ─────────────────────────────────────────────────────────────────────────────

const loginProtectionKey = "login_protection"

// LoginProtectionSettings 登录安全配置，System 界面可调
type LoginProtectionSettings struct {
	Enabled        bool `json:"enabled"`         // 总开关
	MaxAttempts    int  `json:"max_attempts"`    // 窗口内最大失败次数
	WindowMinutes  int  `json:"window_minutes"`  // 失败计数窗口（分钟）
	LockoutMinutes int  `json:"lockout_minutes"` // 触发后的锁定时长（分钟）
}

func defaultLoginProtectionSettings() LoginProtectionSettings {
	return LoginProtectionSettings{
		Enabled:        true,
		MaxAttempts:    5,
		WindowMinutes:  5,
		LockoutMinutes: 15,
	}
}

// getLoginProtectionSettings 读取配置；记录缺失或损坏时回退默认值，保证登录永不被配置问题阻塞
func getLoginProtectionSettings(db *gorm.DB) LoginProtectionSettings {
	var row models.SysSetting
	if err := db.Where("setting_key = ?", loginProtectionKey).First(&row).Error; err != nil {
		return defaultLoginProtectionSettings()
	}
	var s LoginProtectionSettings
	if err := json.Unmarshal([]byte(row.Value), &s); err != nil {
		return defaultLoginProtectionSettings()
	}
	return s
}

func saveLoginProtectionSettings(db *gorm.DB, s LoginProtectionSettings) error {
	raw, err := json.Marshal(s)
	if err != nil {
		return err
	}
	var row models.SysSetting
	if err := db.Where("setting_key = ?", loginProtectionKey).First(&row).Error; err != nil {
		return db.Create(&models.SysSetting{Key: loginProtectionKey, Value: string(raw)}).Error
	}
	return db.Model(&row).Update("value", string(raw)).Error
}

// ── 内存滑动窗口计数器 ──────────────────────────────────────────────────────────

type loginRecord struct {
	// username / ip 冗余存储原始值，供锁定列表展示（key 不可逆向解析，
	// 因为用户名理论上可包含分隔符）
	username    string
	ip          string
	failures    []time.Time
	lockedAt    time.Time
	lockedUntil time.Time
}

// LockoutEntry 锁定列表条目（System 管理界面展示用）
type LockoutEntry struct {
	Key         string    `json:"key"`
	Username    string    `json:"username"`
	IP          string    `json:"ip"`
	LockedAt    time.Time `json:"locked_at"`
	LockedUntil time.Time `json:"locked_until"`
}

type loginTracker struct {
	mu      sync.Mutex
	records map[string]*loginRecord
}

// loginGuard 进程级单例；janitor goroutine 定期清理失活条目防止内存增长
var loginGuard = newLoginTracker()

func newLoginTracker() *loginTracker {
	t := &loginTracker{records: make(map[string]*loginRecord)}
	go func() {
		for range time.Tick(30 * time.Minute) {
			t.sweep()
		}
	}()
	return t
}

func loginGuardKey(username, ip string) string {
	return strings.ToLower(strings.TrimSpace(username)) + "|" + ip
}

// check 返回该 key 是否处于锁定状态及解锁时间
func (t *loginTracker) check(key string) (locked bool, until time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	rec, ok := t.records[key]
	if !ok {
		return false, time.Time{}
	}
	if time.Now().Before(rec.lockedUntil) {
		return true, rec.lockedUntil
	}
	return false, time.Time{}
}

// fail 记录一次失败；窗口内失败次数达到阈值时触发锁定并清空计数
func (t *loginTracker) fail(username, ip string, s LoginProtectionSettings) {
	key := loginGuardKey(username, ip)
	now := time.Now()
	windowStart := now.Add(-time.Duration(s.WindowMinutes) * time.Minute)

	t.mu.Lock()
	defer t.mu.Unlock()
	rec, ok := t.records[key]
	if !ok {
		rec = &loginRecord{
			username: strings.ToLower(strings.TrimSpace(username)),
			ip:       ip,
		}
		t.records[key] = rec
	}
	// 只保留窗口内的失败记录
	kept := rec.failures[:0]
	for _, f := range rec.failures {
		if f.After(windowStart) {
			kept = append(kept, f)
		}
	}
	rec.failures = append(kept, now)
	if len(rec.failures) >= s.MaxAttempts {
		rec.lockedAt = now
		rec.lockedUntil = now.Add(time.Duration(s.LockoutMinutes) * time.Minute)
		rec.failures = nil
	}
}

// lockedEntries 返回当前处于锁定状态的全部条目，按锁定时间从新到旧排序
func (t *loginTracker) lockedEntries() []LockoutEntry {
	now := time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	entries := make([]LockoutEntry, 0)
	for key, rec := range t.records {
		if now.Before(rec.lockedUntil) {
			entries = append(entries, LockoutEntry{
				Key:         key,
				Username:    rec.username,
				IP:          rec.ip,
				LockedAt:    rec.lockedAt,
				LockedUntil: rec.lockedUntil,
			})
		}
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].LockedAt.After(entries[j].LockedAt)
	})
	return entries
}

// unlock 解除指定 key 的锁定（连同失败计数一并清除），返回实际解除的条数
func (t *loginTracker) unlock(keys []string) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	n := 0
	for _, k := range keys {
		if _, ok := t.records[k]; ok {
			delete(t.records, k)
			n++
		}
	}
	return n
}

// success 登录成功后清除该 key 的全部状态
func (t *loginTracker) success(key string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.records, key)
}

// sweep 移除已解锁且无近期失败的条目（近期 = 1 小时内，覆盖所有合理窗口配置）
func (t *loginTracker) sweep() {
	cutoff := time.Now().Add(-time.Hour)
	t.mu.Lock()
	defer t.mu.Unlock()
	for key, rec := range t.records {
		if time.Now().After(rec.lockedUntil) &&
			(len(rec.failures) == 0 || rec.failures[len(rec.failures)-1].Before(cutoff)) {
			delete(t.records, key)
		}
	}
}

// ── 供 Login handler 调用的封装 ─────────────────────────────────────────────────

// loginGuardCheck 在密码校验前调用。返回非空字符串时应直接以 429 拒绝。
func loginGuardCheck(db *gorm.DB, username, ip string) string {
	s := getLoginProtectionSettings(db)
	if !s.Enabled {
		return ""
	}
	if locked, until := loginGuard.check(loginGuardKey(username, ip)); locked {
		mins := int(time.Until(until).Minutes()) + 1
		return fmt.Sprintf("登录失败次数过多，账号已临时锁定，请 %d 分钟后重试", mins)
	}
	return ""
}

// loginGuardFail 在用户不存在或密码错误时调用（两种情况同样计数，防止用户名枚举差异）
func loginGuardFail(db *gorm.DB, username, ip string) {
	s := getLoginProtectionSettings(db)
	if !s.Enabled {
		return
	}
	loginGuard.fail(username, ip, s)
}

// loginGuardSuccess 在登录成功后调用
func loginGuardSuccess(username, ip string) {
	loginGuard.success(loginGuardKey(username, ip))
}

// ── System 模块管理 API（注册在 /api/v1/system 下，自带管理员门禁）────────────────

// GetSecuritySettings GET /api/v1/system/settings/security
func GetSecuritySettings(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.JSON(http.StatusOK, getLoginProtectionSettings(db))
	}
}

// UpdateSecuritySettings PUT /api/v1/system/settings/security
func UpdateSecuritySettings(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req LoginProtectionSettings
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error()})
			return
		}
		if req.MaxAttempts < 1 || req.MaxAttempts > 100 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "最大失败次数取值范围 1-100"})
			return
		}
		if req.WindowMinutes < 1 || req.WindowMinutes > 1440 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "统计窗口取值范围 1-1440 分钟"})
			return
		}
		if req.LockoutMinutes < 1 || req.LockoutMinutes > 1440 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "锁定时长取值范围 1-1440 分钟"})
			return
		}
		if err := saveLoginProtectionSettings(db, req); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "保存失败: " + err.Error()})
			return
		}
		c.JSON(http.StatusOK, req)
	}
}

// ListLockouts GET /api/v1/system/security/lockouts
// 服务端分页查询当前锁定条目：?page=&page_size=&q=
// q 同时模糊匹配用户名和 IP；列表来自内存快照，过滤/切片成本可忽略
func ListLockouts() gin.HandlerFunc {
	return func(c *gin.Context) {
		page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
		pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "10"))
		if page < 1 {
			page = 1
		}
		if pageSize < 1 || pageSize > 100 {
			pageSize = 10
		}
		q := strings.ToLower(strings.TrimSpace(c.Query("q")))

		entries := loginGuard.lockedEntries()
		if q != "" {
			kept := make([]LockoutEntry, 0, len(entries))
			for _, e := range entries {
				// username 入库时已统一小写；IP 转小写以兼容 IPv6 十六进制大写形式
				if strings.Contains(e.Username, q) || strings.Contains(strings.ToLower(e.IP), q) {
					kept = append(kept, e)
				}
			}
			entries = kept
		}

		total := len(entries)
		start := (page - 1) * pageSize
		if start > total {
			start = total
		}
		end := start + pageSize
		if end > total {
			end = total
		}
		c.JSON(http.StatusOK, gin.H{
			"total": total, "items": entries[start:end], "page": page, "page_size": pageSize,
		})
	}
}

// UnlockLockouts POST /api/v1/system/security/lockouts/unlock
// 管理员手动解除锁定，支持单条或批量（keys 来自 ListLockouts 返回的 key 字段）
func UnlockLockouts() gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Keys []string `json:"keys" binding:"required,min=1"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: 请至少选择一条要解除的锁定"})
			return
		}
		n := loginGuard.unlock(req.Keys)
		slog.Info("管理员手动解除登录锁定",
			"operator", getUsername(c), "requested", len(req.Keys), "unlocked", n)
		c.JSON(http.StatusOK, gin.H{"unlocked": n})
	}
}
