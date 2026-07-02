package controllers

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"time"

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

// ─── 内部工具函数 ─────────────────────────────────────────────────────────────

// buildToken 签发 Access Token，有效期由用户的 TokenLifetimeHours 决定
func buildToken(user *models.SysUser, isAdmin bool, secret string) (tokenStr string, expiresAt time.Time, err error) {
	hours := user.TokenLifetimeHours
	if hours <= 0 || hours > 720 {
		hours = 24 // 兜底：1h～720h 之外均使用 24h
	}
	expiresAt = time.Now().Add(time.Duration(hours) * time.Hour)

	claims := middleware.Claims{
		UserID:             user.ID,
		Username:           user.Username,
		IsAdmin:            isAdmin,
		MustChangePassword: user.MustChangePassword,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	tokenStr, err = jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
	return
}

// generateRefreshToken 生成一对 (rawToken, sha256Hash)
// rawToken 返回给客户端；hash 存入数据库
func generateRefreshToken() (raw, hashed string, err error) {
	b := make([]byte, 32)
	if _, err = rand.Read(b); err != nil {
		return
	}
	raw = hex.EncodeToString(b)
	sum := sha256.Sum256([]byte(raw))
	hashed = hex.EncodeToString(sum[:])
	return
}

// hashToken 对外部提供的 token 字符串计算 SHA-256 哈希
func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// buildUserInfo 构造返回给前端的用户信息
func buildUserInfo(user *models.SysUser, isAdmin bool) gin.H {
	return gin.H{
		"id":                   user.ID,
		"username":             user.Username,
		"group_id":             user.GroupID,
		"group_name":           user.Group.Name,
		"is_admin":             isAdmin,
		"must_change_password": user.MustChangePassword,
		"token_lifetime_hours": user.TokenLifetimeHours,
		"theme":                user.Theme,
		"language":             user.Language,
	}
}

// issueRefreshToken 在 DB 中创建新的 Refresh Token 记录并返回 rawToken
func issueRefreshToken(db *gorm.DB, userID uint, days int) (string, error) {
	raw, hashed, err := generateRefreshToken()
	if err != nil {
		return "", err
	}
	rt := models.SysRefreshToken{
		UserID:    userID,
		TokenHash: hashed,
		ExpiresAt: time.Now().Add(time.Duration(days) * 24 * time.Hour),
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

// ─── 路由处理器 ───────────────────────────────────────────────────────────────

// Login POST /api/v1/auth/login
func Login(db *gorm.DB, cfg AuthConfig) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Username string `json:"username" binding:"required"`
			Password string `json:"password" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}

		// 防爆破：处于锁定期的 用户名+IP 直接拒绝，不触碰数据库密码校验
		clientIP := c.ClientIP()
		if msg, mins := loginGuardCheck(db, req.Username, clientIP); msg != "" {
			c.JSON(http.StatusTooManyRequests, gin.H{"error": msg, "code": "auth.locked", "minutes": mins})
			return
		}

		var user models.SysUser
		if err := db.Preload("Group").Where("username = ?", req.Username).First(&user).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				// 用户不存在与密码错误同样计入失败，避免通过响应差异枚举用户名
				loginGuardFail(db, req.Username, clientIP)
				c.JSON(http.StatusUnauthorized, gin.H{"error": "用户名或密码错误", "code": "auth.invalid_credentials"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "服务器内部错误", "code": "server_error"})
			return
		}

		if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
			loginGuardFail(db, req.Username, clientIP)
			c.JSON(http.StatusUnauthorized, gin.H{"error": "用户名或密码错误", "code": "auth.invalid_credentials"})
			return
		}

		// 登录成功：清除该 用户名+IP 的失败计数
		loginGuardSuccess(req.Username, clientIP)

		// 清理过期的 Refresh Token
		cleanupExpiredTokens(db, user.ID)

		isAdmin := user.Group.IsAdmin()
		accessToken, expiresAt, err := buildToken(&user, isAdmin, cfg.JWTSecret)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Token 生成失败", "code": "server_error"})
			return
		}

		refreshToken, err := issueRefreshToken(db, user.ID, cfg.RefreshTokenDays)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Refresh Token 生成失败", "code": "server_error"})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"access_token":            accessToken,
			"refresh_token":           refreshToken,
			"access_token_expires_at": expiresAt.UTC().Format(time.RFC3339),
			"user":                    buildUserInfo(&user, isAdmin),
		})
	}
}

// Refresh POST /api/v1/auth/refresh（无需 JWT，仅凭 Refresh Token 换取新 Access Token）
func Refresh(db *gorm.DB, cfg AuthConfig) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			RefreshToken string `json:"refresh_token" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}

		hashed := hashToken(req.RefreshToken)

		var rt models.SysRefreshToken
		if err := db.Where("token_hash = ? AND expires_at > ?", hashed, time.Now()).
			First(&rt).Error; err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Refresh Token 无效或已过期，请重新登录", "code": "auth.refresh_invalid"})
			return
		}

		// 加载用户信息
		var user models.SysUser
		if err := db.Preload("Group").First(&user, rt.UserID).Error; err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "关联用户不存在", "code": "auth.refresh_invalid"})
			return
		}

		// Refresh Token 旋转：删除旧 Token，签发新 Token
		db.Delete(&rt)
		cleanupExpiredTokens(db, user.ID)

		isAdmin := user.Group.IsAdmin()
		accessToken, expiresAt, err := buildToken(&user, isAdmin, cfg.JWTSecret)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Access Token 生成失败", "code": "server_error"})
			return
		}

		newRefreshToken, err := issueRefreshToken(db, user.ID, cfg.RefreshTokenDays)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Refresh Token 签发失败", "code": "server_error"})
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

// GetMe GET /api/v1/auth/me
func GetMe(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		claims := c.MustGet(middleware.CtxUserKey).(*middleware.Claims)
		var user models.SysUser
		if err := db.Preload("Group").First(&user, claims.UserID).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "用户不存在", "code": "auth.user_not_found"})
			return
		}
		c.JSON(http.StatusOK, buildUserInfo(&user, user.Group.IsAdmin()))
	}
}

// ChangePassword POST /api/v1/auth/change-password（自助改密，需提供旧密码）
func ChangePassword(db *gorm.DB, cfg AuthConfig) gin.HandlerFunc {
	return func(c *gin.Context) {
		claims := c.MustGet(middleware.CtxUserKey).(*middleware.Claims)

		var req struct {
			OldPassword string `json:"old_password" binding:"required"`
			NewPassword string `json:"new_password" binding:"required,min=8"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误：新密码至少需要 8 位", "code": "auth.pwd_too_short"})
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
			c.JSON(http.StatusInternalServerError, gin.H{"error": "密码加密失败", "code": "server_error"})
			return
		}

		if err := db.Model(&user).Updates(map[string]interface{}{
			"password_hash":        string(newHash),
			"must_change_password": false,
		}).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "密码更新失败", "code": "server_error"})
			return
		}

		// 密码修改成功：签发新 Token 对（旧 Refresh Token 自然过期，不强制删除以避免前端竞态）
		user.MustChangePassword = false
		isAdmin := user.Group.IsAdmin()
		accessToken, expiresAt, err := buildToken(&user, isAdmin, cfg.JWTSecret)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Token 签发失败", "code": "server_error"})
			return
		}

		newRefreshToken, err := issueRefreshToken(db, user.ID, cfg.RefreshTokenDays)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Refresh Token 签发失败", "code": "server_error"})
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

		if err := db.Model(&models.SysUser{}).
			Where("id = ?", claims.UserID).
			Update("token_lifetime_hours", req.TokenLifetimeHours).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "设置更新失败", "code": "server_error"})
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
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Update failed", "code": "server_error"})
			return
		}
		db.Preload("Group").First(&user, claims.UserID)
		c.JSON(http.StatusOK, buildUserInfo(&user, user.Group.IsAdmin()))
	}
}

// RegisterAuthRoutes 注册认证相关路由
func RegisterAuthRoutes(r *gin.Engine, db *gorm.DB, cfg AuthConfig) {
	authMW := middleware.JWTAuth(cfg.JWTSecret)

	auth := r.Group("/api/v1/auth")

	// ── 无需 JWT ──────────────────────────────────────────────────
	auth.POST("/login", Login(db, cfg))
	auth.POST("/refresh", Refresh(db, cfg))

	// ── 需要 JWT（change-password 在 must_change_password 状态下也被放行）──
	auth.Use(authMW)
	{
		auth.GET("/me", GetMe(db))
		auth.POST("/change-password", ChangePassword(db, cfg))
		auth.PUT("/settings", UpdateTokenSettings(db))
		auth.PUT("/profile", UpdateProfile(db))
	}
}
