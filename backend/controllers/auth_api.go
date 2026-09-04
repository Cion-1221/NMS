package controllers

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"nms-backend/core"
	"nms-backend/middleware"
	"nms-backend/models"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

// AuthConfig 认证模块配置
type AuthConfig struct {
	JWTSecret        string
	RefreshTokenDays int // Refresh Token 有效期（天），默认 7
}

// totpIssuer 验证器 App 里显示的签发方名称
const totpIssuer = "CION NMS"

// maxPasswordLen bcrypt 只取前 72 字节：超长直接拒绝，而不是静默截断让用户以为
// 后面的字符也参与了校验
const maxPasswordLen = 72

// refreshReuseGrace 旋转后的旧 Refresh Token 在此宽限期内再次出现，视为并发刷新
// （多标签页同时到期、页面重载与定时刷新撞车），照常再签一枚同家族 Token；超过
// 宽限期再出现即视为泄露重放，整个家族吊销。
const refreshReuseGrace = 30 * time.Second

// ─── 内部工具函数 ─────────────────────────────────────────────────────────────

// buildToken 签发 Access Token。有效期 = 用户自设 TokenLifetimeHours，且不超过
// 管理员在安全设置中配置的全局上限（maxHours，见 login_protection.go 的 SessionPolicy）。
// 用户组的模块级权限随 Token 固化进 perms 声明，组权限变更在下次刷新时生效。
func buildToken(user *models.SysUser, isAdmin bool, secret string, maxHours int) (tokenStr string, expiresAt time.Time, err error) {
	hours := user.TokenLifetimeHours
	if hours <= 0 || hours > 720 {
		hours = 24 // 兜底：1h～720h 之外均使用 24h
	}
	if maxHours > 0 && hours > maxHours {
		hours = maxHours
	}
	expiresAt = time.Now().Add(time.Duration(hours) * time.Hour)

	claims := middleware.Claims{
		UserID:             user.ID,
		Username:           user.Username,
		IsAdmin:            isAdmin,
		MustChangePassword: user.MustChangePassword,
		Permissions:        user.Group.PermList(),
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	tokenStr, err = jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
	return
}

// randomHex 生成 n 字节加密随机数的 hex 串（Refresh Token / 会话家族 ID / MFA 挑战）
func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// generateRefreshToken 生成一对 (rawToken, sha256Hash)
// rawToken 返回给客户端；hash 存入数据库
func generateRefreshToken() (raw, hashed string, err error) {
	raw, err = randomHex(32)
	if err != nil {
		return
	}
	hashed = hashToken(raw)
	return
}

// hashToken 对外部提供的 token 字符串计算 SHA-256 哈希
func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// buildUserInfo 构造返回给前端的用户信息（permissions 供前端按模块权限隐藏写操作入口）
func buildUserInfo(user *models.SysUser, isAdmin bool) gin.H {
	perms := user.Group.PermList()
	if perms == nil {
		perms = []string{}
	}
	return gin.H{
		"id":                   user.ID,
		"username":             user.Username,
		"group_id":             user.GroupID,
		"group_name":           user.Group.Name,
		"is_admin":             isAdmin,
		"permissions":          perms,
		"must_change_password": user.MustChangePassword,
		"token_lifetime_hours": user.TokenLifetimeHours,
		"theme":                user.Theme,
		"language":             user.Language,
		"totp_enabled":         user.TOTPEnabled,
	}
}

// issueRefreshToken 签发一行 Refresh Token 并返回明文。familyID 为空表示一次新登录
// （生成新家族）；旋转时传入旧行的家族 ID 以继承，重放检测按家族整体吊销。
func issueRefreshToken(db *gorm.DB, userID uint, days int, c *gin.Context, familyID string) (string, error) {
	raw, hashed, err := generateRefreshToken()
	if err != nil {
		return "", err
	}
	if familyID == "" {
		if familyID, err = randomHex(16); err != nil {
			return "", err
		}
	}
	ua := c.Request.UserAgent()
	if len(ua) > 255 {
		ua = ua[:255]
	}
	rt := models.SysRefreshToken{
		UserID:    userID,
		TokenHash: hashed,
		CreatedIP: c.ClientIP(),
		UserAgent: ua,
		ExpiresAt: time.Now().Add(time.Duration(days) * 24 * time.Hour),
		FamilyID:  familyID,
	}
	if err := db.Create(&rt).Error; err != nil {
		return "", err
	}
	return raw, nil
}

// cleanupExpiredTokens 清理当前用户已过期的 Refresh Token（登录/刷新时调用）
func cleanupExpiredTokens(db *gorm.DB, userID uint) {
	db.Where("user_id = ? AND expires_at < ?", userID, time.Now()).
		Delete(&models.SysRefreshToken{})
}

// clientInfo 审计详情用的客户端描述片段
func clientInfo(c *gin.Context) string {
	ua := c.Request.UserAgent()
	if len(ua) > 120 {
		ua = ua[:120] + "…"
	}
	return fmt.Sprintf("ip=%s ua=%q", c.ClientIP(), ua)
}

// auditUsername 审计表 username 列为 varchar(100)：登录失败时用户名来自请求体，
// 截断以免超长输入让审计写入静默失败
func auditUsername(u string) string {
	if len(u) > 100 {
		return u[:100]
	}
	return u
}

// issueSession 登录（含二次验证）全部通过后的收尾：清计数、清过期 Token、记最后
// 登录时间、签发新家族的 Token 对、写审计。
func issueSession(db *gorm.DB, cfg AuthConfig, c *gin.Context, user *models.SysUser, method string) (gin.H, error) {
	clientIP := c.ClientIP()
	loginGuardSuccess(user.Username, clientIP)
	cleanupExpiredTokens(db, user.ID)
	now := time.Now()
	db.Model(user).Update("last_login_at", now)

	isAdmin := user.Group.IsAdmin()
	accessToken, expiresAt, err := buildToken(user, isAdmin, cfg.JWTSecret, getSessionPolicy(db).MaxTokenLifetimeHours)
	if err != nil {
		return nil, err
	}
	refreshToken, err := issueRefreshToken(db, user.ID, cfg.RefreshTokenDays, c, "")
	if err != nil {
		return nil, err
	}
	writeSysAudit(db, user.Username, "login_success", "session", user.Username, "method="+method+" "+clientInfo(c))
	slog.Info("login success", "username", user.Username, "ip", clientIP, "method", method)
	return gin.H{
		"access_token":            accessToken,
		"refresh_token":           refreshToken,
		"access_token_expires_at": expiresAt.UTC().Format(time.RFC3339),
		"user":                    buildUserInfo(user, isAdmin),
	}, nil
}

// recordLoginFailure 失败计数 + 审计 + 固定格式日志（供 fail2ban 之类的工具匹配）
func recordLoginFailure(db *gorm.DB, c *gin.Context, username, reason string) {
	clientIP := c.ClientIP()
	loginGuardFail(db, username, clientIP)
	u := auditUsername(username)
	writeSysAudit(db, u, "login_failed", "session", u, "reason="+reason+" "+clientInfo(c))
	slog.Warn("login failed", "username", u, "ip", clientIP, "reason", reason)
}

// ─── MFA 挑战（登录第一步通过后、第二步之前的短期凭据）────────────────────────
// 内存存储（单实例语义，与登录锁定同取舍）：5 分钟有效，绑定来源 IP，单个挑战最多
// 尝试 mfaMaxAttempts 次验证码——与按用户名+IP 的锁定互补，攻击者拿到密码后也不能
// 无限猜验证码。

const (
	mfaTTL         = 5 * time.Minute
	mfaMaxAttempts = 5
)

type mfaChallenge struct {
	userID   uint
	ip       string
	expires  time.Time
	attempts int
}

type mfaStore struct {
	mu sync.Mutex
	m  map[string]*mfaChallenge
}

var mfaChallenges = &mfaStore{m: map[string]*mfaChallenge{}}

func (s *mfaStore) create(userID uint, ip string) (string, error) {
	tok, err := randomHex(32)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for k, v := range s.m { // 惰性清理过期挑战，防止内存增长
		if now.After(v.expires) {
			delete(s.m, k)
		}
	}
	s.m[tok] = &mfaChallenge{userID: userID, ip: ip, expires: now.Add(mfaTTL)}
	return tok, nil
}

// consumeAttempt 校验挑战有效并记一次尝试；返回其 userID。次数用尽即作废。
func (s *mfaStore) consumeAttempt(tok, ip string) (uint, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch, ok := s.m[tok]
	if !ok || time.Now().After(ch.expires) || ch.ip != ip {
		return 0, false
	}
	ch.attempts++
	if ch.attempts > mfaMaxAttempts {
		delete(s.m, tok)
		return 0, false
	}
	return ch.userID, true
}

func (s *mfaStore) finish(tok string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, tok)
}

// verifySecondFactor 校验验证器 6 位码或一次性恢复码；成功时持久化防重放状态
// （TOTP 推进时间步计数、恢复码消费掉），并发场景用条件 UPDATE 保证只成功一次。
func verifySecondFactor(db *gorm.DB, user *models.SysUser, code string) bool {
	code = strings.TrimSpace(code)
	if core.IsTOTPCode(code) {
		counter, ok := core.ValidateTOTP(user.TOTPSecret, code, time.Now(), user.TOTPLastCounter)
		if !ok {
			return false
		}
		res := db.Model(&models.SysUser{}).
			Where("id = ? AND totp_last_counter < ?", user.ID, counter).
			Update("totp_last_counter", counter)
		return res.Error == nil && res.RowsAffected == 1
	}

	// 恢复码：逐个常量时间比较哈希，命中即从列表移除
	var hashes []string
	if user.TOTPRecoveryCodes == "" || json.Unmarshal([]byte(user.TOTPRecoveryCodes), &hashes) != nil {
		return false
	}
	h := core.HashRecoveryCode(code)
	idx := -1
	for i, x := range hashes {
		if subtle.ConstantTimeCompare([]byte(x), []byte(h)) == 1 {
			idx = i
			break
		}
	}
	if idx < 0 {
		return false
	}
	remaining := make([]string, 0, len(hashes)-1)
	remaining = append(remaining, hashes[:idx]...)
	remaining = append(remaining, hashes[idx+1:]...)
	b, _ := json.Marshal(remaining)
	res := db.Model(&models.SysUser{}).
		Where("id = ? AND totp_recovery_codes = ?", user.ID, user.TOTPRecoveryCodes).
		Update("totp_recovery_codes", string(b))
	if res.Error != nil || res.RowsAffected != 1 {
		return false
	}
	writeSysAudit(db, user.Username, "totp_recovery_used", "user", user.Username,
		fmt.Sprintf("Recovery code used, %d remaining", len(remaining)))
	return true
}

// ─── 路由处理器 ───────────────────────────────────────────────────────────────

// Login POST /api/v1/auth/login —— 第一步：用户名 + 密码。
// 账号开启了两步验证时不签发 Token，返回一次性 mfa_token，由 LoginTOTP 完成第二步。
func Login(db *gorm.DB, cfg AuthConfig) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Username string `json:"username" binding:"required,max=100"`
			Password string `json:"password" binding:"required,max=72"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}

		// 防爆破：处于锁定期的 用户名+IP（或跨 IP 的用户名）直接拒绝，不触碰数据库密码校验
		clientIP := c.ClientIP()
		if msg, mins := loginGuardCheck(db, req.Username, clientIP); msg != "" {
			slog.Warn("login rejected: locked", "username", auditUsername(req.Username), "ip", clientIP)
			c.JSON(http.StatusTooManyRequests, gin.H{"error": msg, "code": "auth.locked", "minutes": mins})
			return
		}

		var user models.SysUser
		if err := db.Preload("Group").Where("username = ?", req.Username).First(&user).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				// 用户不存在与密码错误同样计入失败，避免通过响应差异枚举用户名
				recordLoginFailure(db, c, req.Username, "credentials")
				c.JSON(http.StatusUnauthorized, gin.H{"error": "用户名或密码错误", "code": "auth.invalid_credentials"})
				return
			}
			internalErr(c, http.StatusInternalServerError, "服务器内部错误", err)
			return
		}

		if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
			recordLoginFailure(db, c, req.Username, "credentials")
			c.JSON(http.StatusUnauthorized, gin.H{"error": "用户名或密码错误", "code": "auth.invalid_credentials"})
			return
		}

		// 停用检查放在密码校验之后：凭错误密码探测不到账号的停用状态（防枚举），
		// 持有正确凭据的本人则能得到明确提示
		if !user.Enabled {
			c.JSON(http.StatusForbidden, gin.H{"error": "账号已被停用，请联系管理员", "code": "auth.account_disabled"})
			return
		}

		// 两步验证：密码正确不算登录成功——失败计数此时不清（否则拿到密码的攻击者
		// 每猜 4 次验证码就重登一次密码把计数归零），只发一枚短期挑战
		if user.TOTPEnabled {
			tok, err := mfaChallenges.create(user.ID, clientIP)
			if err != nil {
				internalErr(c, http.StatusInternalServerError, "登录失败", err)
				return
			}
			c.JSON(http.StatusOK, gin.H{"totp_required": true, "mfa_token": tok})
			return
		}

		bundle, err := issueSession(db, cfg, c, &user, "password")
		if err != nil {
			internalErr(c, http.StatusInternalServerError, "Token 生成失败", err)
			return
		}
		c.JSON(http.StatusOK, bundle)
	}
}

// LoginTOTP POST /api/v1/auth/login/totp —— 第二步：验证器 6 位码或恢复码。
func LoginTOTP(db *gorm.DB, cfg AuthConfig) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			MFAToken string `json:"mfa_token" binding:"required,max=128"`
			Code     string `json:"code" binding:"required,max=64"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}
		clientIP := c.ClientIP()
		userID, ok := mfaChallenges.consumeAttempt(req.MFAToken, clientIP)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "验证会话已过期，请重新登录", "code": "auth.mfa_invalid"})
			return
		}
		var user models.SysUser
		if err := db.Preload("Group").First(&user, userID).Error; err != nil || !user.TOTPEnabled || !user.Enabled {
			mfaChallenges.finish(req.MFAToken)
			c.JSON(http.StatusUnauthorized, gin.H{"error": "验证会话已过期，请重新登录", "code": "auth.mfa_invalid"})
			return
		}
		if msg, mins := loginGuardCheck(db, user.Username, clientIP); msg != "" {
			c.JSON(http.StatusTooManyRequests, gin.H{"error": msg, "code": "auth.locked", "minutes": mins})
			return
		}
		if !verifySecondFactor(db, &user, req.Code) {
			recordLoginFailure(db, c, user.Username, "totp")
			c.JSON(http.StatusUnauthorized, gin.H{"error": "验证码错误", "code": "auth.totp_invalid"})
			return
		}
		mfaChallenges.finish(req.MFAToken)

		bundle, err := issueSession(db, cfg, c, &user, "totp")
		if err != nil {
			internalErr(c, http.StatusInternalServerError, "Token 生成失败", err)
			return
		}
		c.JSON(http.StatusOK, bundle)
	}
}

// Refresh POST /api/v1/auth/refresh（无需 JWT，仅凭 Refresh Token 换取新 Access Token）
//
// 旋转 + 重放检测：旧行不再删除，而是标记 rotated_at 保留到自然过期。已旋转的
// Token 再次出现——宽限期内视为并发刷新照常放行；超过宽限期即视为泄露重放，吊销该
// 家族全部 Token 并写审计，持有者（无论是本人还是攻击者）都必须重新登录。
func Refresh(db *gorm.DB, cfg AuthConfig) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			RefreshToken string `json:"refresh_token" binding:"required,max=128"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}

		hashed := hashToken(req.RefreshToken)
		var rt models.SysRefreshToken
		if err := db.Where("token_hash = ?", hashed).First(&rt).Error; err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Refresh Token 无效或已过期，请重新登录", "code": "auth.refresh_invalid"})
			return
		}
		now := time.Now()
		if now.After(rt.ExpiresAt) {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Refresh Token 无效或已过期，请重新登录", "code": "auth.refresh_invalid"})
			return
		}
		if rt.RotatedAt != nil && now.Sub(*rt.RotatedAt) > refreshReuseGrace {
			var owner models.SysUser
			db.First(&owner, rt.UserID)
			if rt.FamilyID != "" {
				db.Where("family_id = ?", rt.FamilyID).Delete(&models.SysRefreshToken{})
			} else {
				db.Delete(&rt)
			}
			writeSysAudit(db, owner.Username, "refresh_reused", "session", owner.Username,
				"Rotated refresh token reused; whole session family revoked "+clientInfo(c))
			slog.Warn("refresh token reuse detected", "username", owner.Username, "ip", c.ClientIP())
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "检测到已失效的会话令牌被重复使用，该登录的全部会话已吊销，请重新登录",
				"code":  "auth.refresh_reused",
			})
			return
		}

		// 加载用户信息
		var user models.SysUser
		if err := db.Preload("Group").First(&user, rt.UserID).Error; err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "关联用户不存在", "code": "auth.refresh_invalid"})
			return
		}
		if !user.Enabled {
			c.JSON(http.StatusForbidden, gin.H{"error": "账号已被停用，请联系管理员", "code": "auth.account_disabled"})
			return
		}

		// 旋转：旧行标记已旋转（首次旋转时才写，宽限期内的并发刷新保留最初时间戳），
		// 新行继承家族；升级前签发的旧行没有家族 ID，补一个
		family := rt.FamilyID
		if family == "" {
			var err error
			if family, err = randomHex(16); err != nil {
				internalErr(c, http.StatusInternalServerError, "Refresh Token 签发失败", err)
				return
			}
			db.Model(&rt).Update("family_id", family)
		}
		if rt.RotatedAt == nil {
			db.Model(&rt).Update("rotated_at", now)
		}
		cleanupExpiredTokens(db, user.ID)

		isAdmin := user.Group.IsAdmin()
		accessToken, expiresAt, err := buildToken(&user, isAdmin, cfg.JWTSecret, getSessionPolicy(db).MaxTokenLifetimeHours)
		if err != nil {
			internalErr(c, http.StatusInternalServerError, "Access Token 生成失败", err)
			return
		}

		newRefreshToken, err := issueRefreshToken(db, user.ID, cfg.RefreshTokenDays, c, family)
		if err != nil {
			internalErr(c, http.StatusInternalServerError, "Refresh Token 签发失败", err)
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"access_token":            accessToken,
			"refresh_token":           newRefreshToken,
			"access_token_expires_at": expiresAt.UTC().Format(time.RFC3339),
			"user":                    buildUserInfo(&user, isAdmin),
		})
	}
}

// Logout POST /api/v1/auth/logout —— 服务端登出：吊销本会话的 Refresh Token 家族。
// 只清浏览器本地存储的话，令牌在服务端仍有效，被盗后照常续期。Access Token 本身
// 到期前仍可用（与强制下线同款取舍）。
func Logout(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		claims := c.MustGet(middleware.CtxUserKey).(*middleware.Claims)
		var req struct {
			RefreshToken string `json:"refresh_token"`
		}
		_ = c.ShouldBindJSON(&req)

		var revoked int64
		if req.RefreshToken != "" {
			var rt models.SysRefreshToken
			// user_id 同时入条件：不能拿别人的 Token 触发吊销
			if err := db.Where("token_hash = ? AND user_id = ?", hashToken(req.RefreshToken), claims.UserID).
				First(&rt).Error; err == nil {
				if rt.FamilyID != "" {
					res := db.Where("family_id = ? AND user_id = ?", rt.FamilyID, claims.UserID).Delete(&models.SysRefreshToken{})
					revoked = res.RowsAffected
				} else {
					db.Delete(&rt)
					revoked = 1
				}
			}
		}
		writeSysAudit(db, claims.Username, "logout", "session", claims.Username,
			fmt.Sprintf("revoked=%d %s", revoked, clientInfo(c)))
		c.JSON(http.StatusOK, gin.H{"revoked": revoked})
	}
}

// GetMe GET /api/v1/auth/me
func GetMe(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		claims := c.MustGet(middleware.CtxUserKey).(*middleware.Claims)
		var user models.SysUser
		if err := db.Preload("Group").First(&user, claims.UserID).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "用户不存在", "code": "auth.user_not_found"})
			return
		}
		if !user.Enabled {
			c.JSON(http.StatusForbidden, gin.H{"error": "账号已被停用，请联系管理员", "code": "auth.account_disabled"})
			return
		}
		c.JSON(http.StatusOK, buildUserInfo(&user, user.Group.IsAdmin()))
	}
}

// ChangePassword POST /api/v1/auth/change-password（自助改密，需提供旧密码）
// 改密属安全事件：吊销该用户其余全部会话（用户发现异常自己改密时，攻击者手里的
// 会话必须同时失效），只保留本次新签发的一对。
func ChangePassword(db *gorm.DB, cfg AuthConfig) gin.HandlerFunc {
	return func(c *gin.Context) {
		claims := c.MustGet(middleware.CtxUserKey).(*middleware.Claims)

		var req struct {
			OldPassword string `json:"old_password" binding:"required,max=72"`
			NewPassword string `json:"new_password" binding:"required,min=8"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误：新密码至少需要 8 位", "code": "auth.pwd_too_short"})
			return
		}
		if len(req.NewPassword) > maxPasswordLen {
			c.JSON(http.StatusBadRequest, gin.H{"error": "密码最长 72 个字符", "code": "auth.pwd_too_long"})
			return
		}
		if req.OldPassword == req.NewPassword {
			c.JSON(http.StatusBadRequest, gin.H{"error": "新密码不能与当前密码相同", "code": "auth.pwd_same"})
			return
		}

		var user models.SysUser
		if err := db.Preload("Group").First(&user, claims.UserID).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "用户不存在", "code": "auth.user_not_found"})
			return
		}

		if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.OldPassword)); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "当前密码不正确", "code": "auth.pwd_old_wrong"})
			return
		}

		newHash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), 12)
		if err != nil {
			internalErr(c, http.StatusInternalServerError, "密码加密失败", err)
			return
		}

		if err := db.Model(&user).Updates(map[string]interface{}{
			"password_hash":        string(newHash),
			"must_change_password": false,
		}).Error; err != nil {
			internalErr(c, http.StatusInternalServerError, "密码更新失败", err)
			return
		}

		// 吊销其余会话后再签发新的一对——响应体里的新 Token 是改密后唯一有效的会话
		db.Where("user_id = ?", user.ID).Delete(&models.SysRefreshToken{})
		writeSysAudit(db, user.Username, "change_password", "user", user.Username,
			"User changed own password; other sessions revoked "+clientInfo(c))

		user.MustChangePassword = false
		isAdmin := user.Group.IsAdmin()
		accessToken, expiresAt, err := buildToken(&user, isAdmin, cfg.JWTSecret, getSessionPolicy(db).MaxTokenLifetimeHours)
		if err != nil {
			internalErr(c, http.StatusInternalServerError, "Token 签发失败", err)
			return
		}

		newRefreshToken, err := issueRefreshToken(db, user.ID, cfg.RefreshTokenDays, c, "")
		if err != nil {
			internalErr(c, http.StatusInternalServerError, "Refresh Token 签发失败", err)
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"message":                 "密码已成功修改",
			"access_token":            accessToken,
			"refresh_token":           newRefreshToken,
			"access_token_expires_at": expiresAt.UTC().Format(time.RFC3339),
			"user":                    buildUserInfo(&user, isAdmin),
		})
	}
}

// UpdateTokenSettings PUT /api/v1/auth/settings（用户自定义会话时长）
func UpdateTokenSettings(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		claims := c.MustGet(middleware.CtxUserKey).(*middleware.Claims)

		var req struct {
			TokenLifetimeHours int `json:"token_lifetime_hours" binding:"required,min=1,max=720"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误：token_lifetime_hours 须在 1～720 小时之间", "code": "auth.lifetime_range"})
			return
		}

		// 不允许超过管理员配置的全局会话时长上限
		if maxHours := getSessionPolicy(db).MaxTokenLifetimeHours; maxHours > 0 && req.TokenLifetimeHours > maxHours {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": fmt.Sprintf("超出管理员限制的最大会话时长（%d 小时）", maxHours),
				"code":  "auth.lifetime_over_cap", "max": maxHours,
			})
			return
		}

		if err := db.Model(&models.SysUser{}).
			Where("id = ?", claims.UserID).
			Update("token_lifetime_hours", req.TokenLifetimeHours).Error; err != nil {
			internalErr(c, http.StatusInternalServerError, "设置更新失败", err)
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"message":              "会话时长已更新，将在下次 Token 刷新时生效",
			"token_lifetime_hours": req.TokenLifetimeHours,
		})
	}
}

// UpdateProfile PUT /api/v1/auth/profile（更新 UI 偏好设置：主题、语言）
func UpdateProfile(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		claims := c.MustGet(middleware.CtxUserKey).(*middleware.Claims)

		var req struct {
			Theme    *string `json:"theme"`
			Language *string `json:"language"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body", "code": "bad_request"})
			return
		}

		updates := map[string]interface{}{}
		if req.Theme != nil {
			valid := map[string]bool{"light": true, "dark": true, "system": true}
			if !valid[*req.Theme] {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid theme value, must be light|dark|system", "code": "bad_request"})
				return
			}
			updates["theme"] = *req.Theme
		}
		if req.Language != nil {
			valid := map[string]bool{"en": true, "zh": true}
			if !valid[*req.Language] {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid language value, must be en|zh", "code": "bad_request"})
				return
			}
			updates["language"] = *req.Language
		}
		if len(updates) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "No fields to update", "code": "bad_request"})
			return
		}

		var user models.SysUser
		if err := db.Preload("Group").First(&user, claims.UserID).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "User not found", "code": "auth.user_not_found"})
			return
		}
		if err := db.Model(&user).Updates(updates).Error; err != nil {
			internalErr(c, http.StatusInternalServerError, "Update failed", err)
			return
		}
		db.Preload("Group").First(&user, claims.UserID)
		c.JSON(http.StatusOK, buildUserInfo(&user, user.Group.IsAdmin()))
	}
}

// ─── 两步验证（TOTP）自助管理 ──────────────────────────────────────────────────
// 流程：setup 生成待确认密钥（此时登录仍不要求验证码）→ enable 用 App 里的验证码
// 确认后正式开启并返回一次性恢复码 → disable 需要当前密码 + 验证码（或恢复码）。
// 管理员为用户重置见 system_api.go ResetUserTOTP。

func loadCurrentUser(db *gorm.DB, c *gin.Context) (*models.SysUser, bool) {
	claims := c.MustGet(middleware.CtxUserKey).(*middleware.Claims)
	var user models.SysUser
	if err := db.Preload("Group").First(&user, claims.UserID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "用户不存在", "code": "auth.user_not_found"})
		return nil, false
	}
	return &user, true
}

// TOTPSetup POST /api/v1/auth/totp/setup —— 生成待确认密钥与 otpauth URI（前端渲染二维码）
func TOTPSetup(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user, ok := loadCurrentUser(db, c)
		if !ok {
			return
		}
		if user.TOTPEnabled {
			c.JSON(http.StatusBadRequest, gin.H{"error": "两步验证已开启", "code": "auth.totp_already_enabled"})
			return
		}
		secret, err := core.GenerateTOTPSecret()
		if err != nil {
			internalErr(c, http.StatusInternalServerError, "生成密钥失败", err)
			return
		}
		if err := db.Model(user).Updates(map[string]interface{}{
			"totp_secret": secret, "totp_last_counter": 0,
		}).Error; err != nil {
			internalErr(c, http.StatusInternalServerError, "保存密钥失败", err)
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"secret":      secret,
			"otpauth_uri": core.TOTPURI(totpIssuer, user.Username, secret),
		})
	}
}

// TOTPEnable POST /api/v1/auth/totp/enable {code} —— 用验证码确认密钥已正确录入，正式开启
func TOTPEnable(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Code string `json:"code" binding:"required,max=16"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}
		user, ok := loadCurrentUser(db, c)
		if !ok {
			return
		}
		if user.TOTPEnabled {
			c.JSON(http.StatusBadRequest, gin.H{"error": "两步验证已开启", "code": "auth.totp_already_enabled"})
			return
		}
		if user.TOTPSecret == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "请先开始设置以获取密钥", "code": "auth.totp_setup_required"})
			return
		}
		counter, valid := core.ValidateTOTP(user.TOTPSecret, req.Code, time.Now(), user.TOTPLastCounter)
		if !valid {
			c.JSON(http.StatusBadRequest, gin.H{"error": "验证码错误", "code": "auth.totp_invalid"})
			return
		}
		plain, hashes, err := core.GenerateRecoveryCodes()
		if err != nil {
			internalErr(c, http.StatusInternalServerError, "生成恢复码失败", err)
			return
		}
		b, _ := json.Marshal(hashes)
		if err := db.Model(user).Updates(map[string]interface{}{
			"totp_enabled": true, "totp_last_counter": counter, "totp_recovery_codes": string(b),
		}).Error; err != nil {
			internalErr(c, http.StatusInternalServerError, "开启两步验证失败", err)
			return
		}
		writeSysAudit(db, user.Username, "totp_enabled", "user", user.Username, "Two-factor authentication enabled "+clientInfo(c))
		c.JSON(http.StatusOK, gin.H{"recovery_codes": plain})
	}
}

// TOTPDisable POST /api/v1/auth/totp/disable {password, code}
func TOTPDisable(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Password string `json:"password" binding:"required,max=72"`
			Code     string `json:"code" binding:"required,max=64"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}
		user, ok := loadCurrentUser(db, c)
		if !ok {
			return
		}
		if !user.TOTPEnabled {
			c.JSON(http.StatusBadRequest, gin.H{"error": "该账号未开启两步验证", "code": "auth.totp_not_enabled"})
			return
		}
		if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "当前密码不正确", "code": "auth.pwd_old_wrong"})
			return
		}
		if !verifySecondFactor(db, user, req.Code) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "验证码错误", "code": "auth.totp_invalid"})
			return
		}
		if err := db.Model(user).Updates(map[string]interface{}{
			"totp_enabled": false, "totp_secret": "", "totp_last_counter": 0, "totp_recovery_codes": "",
		}).Error; err != nil {
			internalErr(c, http.StatusInternalServerError, "关闭两步验证失败", err)
			return
		}
		writeSysAudit(db, user.Username, "totp_disabled", "user", user.Username, "Two-factor authentication disabled "+clientInfo(c))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// TOTPRegenerateRecoveryCodes POST /api/v1/auth/totp/recovery-codes {code} —— 旧码立即失效
func TOTPRegenerateRecoveryCodes(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Code string `json:"code" binding:"required,max=64"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}
		user, ok := loadCurrentUser(db, c)
		if !ok {
			return
		}
		if !user.TOTPEnabled {
			c.JSON(http.StatusBadRequest, gin.H{"error": "该账号未开启两步验证", "code": "auth.totp_not_enabled"})
			return
		}
		if !verifySecondFactor(db, user, req.Code) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "验证码错误", "code": "auth.totp_invalid"})
			return
		}
		plain, hashes, err := core.GenerateRecoveryCodes()
		if err != nil {
			internalErr(c, http.StatusInternalServerError, "生成恢复码失败", err)
			return
		}
		b, _ := json.Marshal(hashes)
		if err := db.Model(user).Update("totp_recovery_codes", string(b)).Error; err != nil {
			internalErr(c, http.StatusInternalServerError, "保存恢复码失败", err)
			return
		}
		writeSysAudit(db, user.Username, "totp_recovery_regenerated", "user", user.Username, "Recovery codes regenerated "+clientInfo(c))
		c.JSON(http.StatusOK, gin.H{"recovery_codes": plain})
	}
}

// RegisterAuthRoutes 注册认证相关路由
func RegisterAuthRoutes(r *gin.Engine, db *gorm.DB, cfg AuthConfig) {
	authMW := middleware.JWTAuth(cfg.JWTSecret)

	auth := r.Group("/api/v1/auth")

	// ── 无需 JWT ──────────────────────────────────────────────────
	// 按 IP 限速是防爆破锁定之外的粗粒度外层护栏：锁定按"用户名+IP"与"用户名"计
	// 失败次数，挡不住同一 IP 喷洒大量不同用户名；refresh 无锁定机制，全靠这里兜底
	auth.POST("/login", middleware.RateLimit(30, time.Minute), Login(db, cfg))
	auth.POST("/login/totp", middleware.RateLimit(30, time.Minute), LoginTOTP(db, cfg))
	auth.POST("/refresh", middleware.RateLimit(60, time.Minute), Refresh(db, cfg))

	// ── 需要 JWT（change-password / logout 在 must_change_password 状态下也被放行）──
	auth.Use(authMW)
	{
		auth.GET("/me", GetMe(db))
		auth.POST("/logout", Logout(db))
		auth.POST("/change-password", ChangePassword(db, cfg))
		auth.PUT("/settings", UpdateTokenSettings(db))
		auth.PUT("/profile", UpdateProfile(db))
		auth.POST("/totp/setup", TOTPSetup(db))
		auth.POST("/totp/enable", TOTPEnable(db))
		auth.POST("/totp/disable", TOTPDisable(db))
		auth.POST("/totp/recovery-codes", TOTPRegenerateRecoveryCodes(db))
	}
}
