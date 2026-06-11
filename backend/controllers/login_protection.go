package controllers

import (
	"encoding/json"
	"fmt"
	"net/http"
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
	failures    []time.Time
	lockedUntil time.Time
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
func (t *loginTracker) fail(key string, s LoginProtectionSettings) {
	now := time.Now()
	windowStart := now.Add(-time.Duration(s.WindowMinutes) * time.Minute)

	t.mu.Lock()
	defer t.mu.Unlock()
	rec, ok := t.records[key]
	if !ok {
		rec = &loginRecord{}
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
		rec.lockedUntil = now.Add(time.Duration(s.LockoutMinutes) * time.Minute)
		rec.failures = nil
	}
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
	loginGuard.fail(loginGuardKey(username, ip), s)
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
