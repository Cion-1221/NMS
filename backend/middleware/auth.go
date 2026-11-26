package middleware

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"nms-backend/models"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"gorm.io/gorm"
)

// Claims JWT 载荷定义。SessionFamily 绑定当前会话家族（SysRefreshToken.FamilyID），
// 配合服务端会话活性缓存，使强制下线、禁用/删除用户、改密、吊销单条会话均能立即生效。
type Claims struct {
	UserID             uint     `json:"user_id"`
	Username           string   `json:"username"`
	IsAdmin            bool     `json:"is_admin"`
	MustChangePassword bool     `json:"must_change_password"`
	Permissions        []string `json:"perms,omitempty"`
	SessionFamily      string   `json:"sid,omitempty"`
	jwt.RegisteredClaims
}

// CtxUserKey 在 gin.Context 中存储用户信息的 key
const CtxUserKey = "auth_claims"

const authCacheTTL = 5 * time.Second

type cachedUserAuth struct {
	exists             bool
	enabled            bool
	isAdmin            bool
	mustChangePassword bool
	perms              []string
	activeFamilies     map[string]bool
	hasActiveSession   bool
	expiresAt          time.Time
}

var (
	authCacheMu sync.RWMutex
	authCache   = make(map[uint]cachedUserAuth)
)

// InvalidateUserAuthCache 立即失效指定用户的会话与权限缓存（在禁用、删除、强制下线、
// 改密、吊销会话、重置 2FA 等操作后调用，使存量 Access Token 在下一次请求时立即被拒）。
func InvalidateUserAuthCache(userID uint) {
	authCacheMu.Lock()
	delete(authCache, userID)
	authCacheMu.Unlock()
}

// InvalidateAllAuthCache 失效全部用户的权限缓存（在修改用户组权限后调用）。
func InvalidateAllAuthCache() {
	authCacheMu.Lock()
	authCache = make(map[uint]cachedUserAuth)
	authCacheMu.Unlock()
}

func loadUserAuthState(db *gorm.DB, userID uint) (cachedUserAuth, error) {
	now := time.Now()
	authCacheMu.RLock()
	if entry, ok := authCache[userID]; ok && now.Before(entry.expiresAt) {
		authCacheMu.RUnlock()
		return entry, nil
	}
	authCacheMu.RUnlock()

	var user models.SysUser
	if err := db.Preload("Group").First(&user, userID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			entry := cachedUserAuth{exists: false, expiresAt: now.Add(authCacheTTL)}
			authCacheMu.Lock()
			authCache[userID] = entry
			authCacheMu.Unlock()
			return entry, nil
		}
		// 瞬时数据库错误（连接池耗尽、网络抖动、重启窗口）绝不写入负缓存，由上层返回 503
		return cachedUserAuth{}, err
	}

	var sessions []models.SysRefreshToken
	if err := db.Select("family_id").
		Where("user_id = ? AND expires_at > ? AND rotated_at IS NULL", userID, now).
		Find(&sessions).Error; err != nil {
		return cachedUserAuth{}, err
	}
	fams := make(map[string]bool, len(sessions))
	for _, s := range sessions {
		if s.FamilyID != "" {
			fams[s.FamilyID] = true
		}
	}

	entry := cachedUserAuth{
		exists:             true,
		enabled:            user.Enabled,
		isAdmin:            user.Group.IsAdmin(),
		mustChangePassword: user.MustChangePassword,
		perms:              user.Group.PermList(),
		activeFamilies:     fams,
		hasActiveSession:   len(sessions) > 0,
		expiresAt:          now.Add(authCacheTTL),
	}
	authCacheMu.Lock()
	authCache[userID] = entry
	authCacheMu.Unlock()
	return entry, nil
}

// JWTAuth JWT 认证中间件，挂载在所有需要保护的路由组上。
// 传入 db 时会结合轻量内存缓存校验账号启停状态与会话活性（强制下线/删除/禁用/改密即时生效）。
func JWTAuth(jwtSecret string, db ...*gorm.DB) gin.HandlerFunc {
	var conn *gorm.DB
	if len(db) > 0 {
		conn = db[0]
	}
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "未登录或 Token 缺失", "code": "auth.token_missing"})
			return
		}

		tokenStr := strings.TrimPrefix(authHeader, "Bearer ")
		claims := &Claims{}
		token, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, jwt.ErrSignatureInvalid
			}
			return []byte(jwtSecret), nil
		})
		if err != nil || !token.Valid {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "Token 无效或已过期，请重新登录", "code": "auth.token_invalid"})
			return
		}

		if conn != nil {
			st, err := loadUserAuthState(conn, claims.UserID)
			if err != nil {
				slog.Error("加载用户认证状态失败", "user_id", claims.UserID, "err", err)
				c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "服务暂时不可用，请稍后重试", "code": "server_error"})
				return
			}
			if !st.exists || !st.enabled {
				c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "账号已停用或不存在，请重新登录", "code": "auth.token_invalid"})
				return
			}
			// 校验会话活性：新签发的 Token 绑定了 SessionFamily（sid），吊销单条或全部会话后立即失效；
			// 升级前签发的旧版 Token 无 sid，只要该用户已无任何活跃 Refresh Token（如被强制下线）同样失效。
			if claims.SessionFamily != "" {
				if !st.activeFamilies[claims.SessionFamily] {
					c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "会话已失效或被强制下线，请重新登录", "code": "auth.token_invalid"})
					return
				}
			} else if !st.hasActiveSession {
				c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "会话已失效或被强制下线，请重新登录", "code": "auth.token_invalid"})
				return
			}
			// 同步最新权限与改密状态（用户组权限变更、管理员重置密码即时生效）
			claims.IsAdmin = st.isAdmin
			claims.Permissions = st.perms
			claims.MustChangePassword = st.mustChangePassword
		}

		// 强制改密时只允许访问 me / change-password / logout 接口
		if claims.MustChangePassword {
			path := c.Request.URL.Path
			allowedPaths := map[string]bool{
				"/api/v1/auth/me":              true,
				"/api/v1/auth/change-password": true,
				"/api/v1/auth/logout":          true,
			}
			if !allowedPaths[path] {
				c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
					"error":   "must_change_password",
					"code":    "auth.must_change_password",
					"message": "请先修改初始密码后再使用系统",
				})
				return
			}
		}

		c.Set(CtxUserKey, claims)
		c.Next()
	}
}

// RequirePerm 模块级权限校验中间件（必须在 JWTAuth 之后使用）：
// 管理员直通；否则要求 JWT 权限声明中包含指定权限（如 "ipam:write"）。
func RequirePerm(perm string) gin.HandlerFunc {
	return func(c *gin.Context) {
		raw, exists := c.Get(CtxUserKey)
		if !exists {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "未认证", "code": "auth.unauthenticated"})
			return
		}
		claims := raw.(*Claims)
		if claims.IsAdmin {
			c.Next()
			return
		}
		for _, p := range claims.Permissions {
			if p == perm {
				c.Next()
				return
			}
		}
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
			"error": "权限不足，该操作需要权限: " + perm,
			"code":  "auth.perm_required", "perm": perm,
		})
	}
}

// AdminRequired 管理员权限校验中间件，必须在 JWTAuth 之后使用
func AdminRequired(c *gin.Context) {
	raw, exists := c.Get(CtxUserKey)
	if !exists {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "未认证", "code": "auth.unauthenticated"})
		return
	}
	if !raw.(*Claims).IsAdmin {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "权限不足，该操作需要管理员权限", "code": "auth.admin_required"})
		return
	}
	c.Next()
}
