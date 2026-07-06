package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

// Claims JWT 载荷定义。Permissions 为所属用户组的模块级权限快照（如 ipam:write），
// 与 IsAdmin 一样在签发时固化——组权限变更在下次 Token 刷新时生效。
type Claims struct {
	UserID             uint     `json:"user_id"`
	Username           string   `json:"username"`
	IsAdmin            bool     `json:"is_admin"`
	MustChangePassword bool     `json:"must_change_password"`
	Permissions        []string `json:"perms,omitempty"`
	jwt.RegisteredClaims
}

// CtxUserKey 在 gin.Context 中存储用户信息的 key
const CtxUserKey = "auth_claims"

// JWTAuth JWT 认证中间件，挂载在所有需要保护的路由组上
func JWTAuth(jwtSecret string) gin.HandlerFunc {
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

		// 强制改密时只允许访问 me 和 change-password 接口
		if claims.MustChangePassword {
			path := c.Request.URL.Path
			allowedPaths := map[string]bool{
				"/api/v1/auth/me":              true,
				"/api/v1/auth/change-password": true,
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
