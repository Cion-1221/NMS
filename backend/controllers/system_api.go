package controllers

import (
	"fmt"
	"net/http"
	"strconv"

	"nms-backend/middleware"
	"nms-backend/models"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

// ─── 辅助函数 ────────────────────────────────────────────────────────────────

func parseUserID(c *gin.Context) (uint, bool) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil || id == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的用户 ID"})
		return 0, false
	}
	return uint(id), true
}

func parseGroupIDParam(c *gin.Context) (uint, bool) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil || id == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的用户组 ID"})
		return 0, false
	}
	return uint(id), true
}

// countRemainingAdminUsers 计算排除 excludeUserID 后，系统内剩余的管理员用户数
func countRemainingAdminUsers(db *gorm.DB, excludeUserID uint) (int64, error) {
	var allGroups []models.SysGroup
	if err := db.Find(&allGroups).Error; err != nil {
		return 0, err
	}
	var adminGroupIDs []uint
	for _, g := range allGroups {
		if g.IsAdmin() {
			adminGroupIDs = append(adminGroupIDs, g.ID)
		}
	}
	if len(adminGroupIDs) == 0 {
		return 0, nil
	}
	var count int64
	db.Model(&models.SysUser{}).
		Where("group_id IN ? AND id != ?", adminGroupIDs, excludeUserID).
		Count(&count)
	return count, nil
}

// countOtherAdminGroups 计算排除 excludeGroupID 后，系统内剩余的管理员组数
func countOtherAdminGroups(db *gorm.DB, excludeGroupID uint) int64 {
	var allGroups []models.SysGroup
	db.Find(&allGroups)
	var count int64
	for _, g := range allGroups {
		if g.IsAdmin() && g.ID != excludeGroupID {
			count++
		}
	}
	return count
}

// ─── 用户管理 ─────────────────────────────────────────────────────────────────

// ListUsers GET /api/v1/system/users
func ListUsers(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var users []models.SysUser
		db.Preload("Group").Order("id asc").Find(&users)
		c.JSON(http.StatusOK, users)
	}
}

// CreateUser POST /api/v1/system/users
func CreateUser(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Username string `json:"username" binding:"required,min=3,max=50"`
			Password string `json:"password" binding:"required,min=8"`
			GroupID  uint   `json:"group_id" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error()})
			return
		}

		var group models.SysGroup
		if err := db.First(&group, req.GroupID).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "指定的用户组不存在"})
			return
		}

		hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "密码处理失败"})
			return
		}

		user := models.SysUser{
			Username:           req.Username,
			PasswordHash:       string(hash),
			GroupID:            req.GroupID,
			MustChangePassword: true, // 新用户首次登录必须改密
		}
		if err := db.Create(&user).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "用户创建失败: " + err.Error()})
			return
		}
		db.Preload("Group").First(&user, user.ID)
		c.JSON(http.StatusOK, user)
	}
}

// UpdateUser PUT /api/v1/system/users/:id（仅管理员可调用）
func UpdateUser(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		claims := c.MustGet(middleware.CtxUserKey).(*middleware.Claims)
		targetID, ok := parseUserID(c)
		if !ok {
			return
		}

		var req struct {
			GroupID  *uint  `json:"group_id"`
			Password string `json:"password"` // 留空则不修改
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}

		var user models.SysUser
		if err := db.Preload("Group").First(&user, targetID).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "用户不存在"})
			return
		}

		// 防止管理员将自己移出管理员组（避免权限锁死）
		if claims.UserID == targetID && req.GroupID != nil && *req.GroupID != user.GroupID {
			c.JSON(http.StatusBadRequest, gin.H{"error": "不能修改自己的用户组，如需调整请联系其他管理员"})
			return
		}

		updates := map[string]interface{}{}

		if req.GroupID != nil && *req.GroupID != user.GroupID {
			var newGroup models.SysGroup
			if err := db.First(&newGroup, *req.GroupID).Error; err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "目标用户组不存在"})
				return
			}
			updates["group_id"] = *req.GroupID
		}

		if req.Password != "" {
			if len(req.Password) < 8 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "新密码至少需要 8 位"})
				return
			}
			hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "密码处理失败"})
				return
			}
			updates["password_hash"] = string(hash)
			updates["must_change_password"] = true // 强制用户下次登录改密
		}

		if len(updates) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "未提供任何可更新的字段"})
			return
		}

		if err := db.Model(&user).Updates(updates).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "更新失败: " + err.Error()})
			return
		}
		db.Preload("Group").First(&user, user.ID)
		c.JSON(http.StatusOK, user)
	}
}

// DeleteUser DELETE /api/v1/system/users/:id
func DeleteUser(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		claims := c.MustGet(middleware.CtxUserKey).(*middleware.Claims)
		targetID, ok := parseUserID(c)
		if !ok {
			return
		}

		// 不能删除自己
		if claims.UserID == targetID {
			c.JSON(http.StatusBadRequest, gin.H{"error": "不能删除当前登录的用户账号"})
			return
		}

		var user models.SysUser
		if err := db.Preload("Group").First(&user, targetID).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "用户不存在"})
			return
		}

		// 如果被删用户是管理员，检查是否为系统最后一个管理员用户
		if user.Group.IsAdmin() {
			remaining, err := countRemainingAdminUsers(db, targetID)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "权限校验失败"})
				return
			}
			if remaining == 0 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "无法删除系统中最后一个管理员账号"})
				return
			}
		}

		if err := db.Delete(&user).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "删除失败"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// ─── 用户组管理 ───────────────────────────────────────────────────────────────

// ListGroups GET /api/v1/system/groups
func ListGroups(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var groups []models.SysGroup
		db.Order("id asc").Find(&groups)
		c.JSON(http.StatusOK, groups)
	}
}

// CreateGroup POST /api/v1/system/groups
func CreateGroup(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Name        string `json:"name" binding:"required,min=2,max=100"`
			Permissions string `json:"permissions"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error()})
			return
		}
		if req.Permissions == "" {
			req.Permissions = "[]"
		}

		group := models.SysGroup{Name: req.Name, Permissions: req.Permissions}
		if err := db.Create(&group).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "用户组创建失败: " + err.Error()})
			return
		}
		c.JSON(http.StatusOK, group)
	}
}

// UpdateGroup PUT /api/v1/system/groups/:id
func UpdateGroup(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		gid, ok := parseGroupIDParam(c)
		if !ok {
			return
		}

		var req struct {
			Name        string `json:"name"`
			Permissions string `json:"permissions"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}

		var group models.SysGroup
		if err := db.First(&group, gid).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "用户组不存在"})
			return
		}

		updates := map[string]interface{}{}
		if req.Name != "" {
			updates["name"] = req.Name
		}
		if req.Permissions != "" {
			updates["permissions"] = req.Permissions
		}
		if len(updates) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "未提供任何可更新的字段"})
			return
		}

		// 防止将唯一管理员组的 admin 权限撤销（检查其他管理员组数量）
		if req.Permissions == "[]" && group.IsAdmin() {
			otherAdminGroups := countOtherAdminGroups(db, gid)
			if otherAdminGroups == 0 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "无法撤销唯一管理员组的权限，系统至少需要保留一个管理员组"})
				return
			}
		}

		if err := db.Model(&group).Updates(updates).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "更新失败"})
			return
		}
		db.First(&group, gid)
		c.JSON(http.StatusOK, group)
	}
}

// DeleteGroup DELETE /api/v1/system/groups/:id
func DeleteGroup(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		gid, ok := parseGroupIDParam(c)
		if !ok {
			return
		}

		var group models.SysGroup
		if err := db.First(&group, gid).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "用户组不存在"})
			return
		}

		// 不允许删除含有用户的组
		var userCount int64
		db.Model(&models.SysUser{}).Where("group_id = ?", gid).Count(&userCount)
		if userCount > 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("该用户组下仍有 %d 个用户，请先将其迁移至其他组后再删除", userCount)})
			return
		}

		// 不允许删除最后一个管理员组
		if group.IsAdmin() {
			otherAdminGroups := countOtherAdminGroups(db, gid)
			if otherAdminGroups == 0 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "无法删除系统中最后一个管理员组"})
				return
			}
		}

		if err := db.Delete(&group).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "删除失败"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// RegisterSystemRoutes 注册系统管理路由（全部需要 JWT + 管理员权限）
func RegisterSystemRoutes(r *gin.Engine, db *gorm.DB, authMW gin.HandlerFunc) {
	sys := r.Group("/api/v1/system")
	sys.Use(authMW, middleware.AdminRequired)
	{
		sys.GET("/users", ListUsers(db))
		sys.POST("/users", CreateUser(db))
		sys.PUT("/users/:id", UpdateUser(db))
		sys.DELETE("/users/:id", DeleteUser(db))

		sys.GET("/groups", ListGroups(db))
		sys.POST("/groups", CreateGroup(db))
		sys.PUT("/groups/:id", UpdateGroup(db))
		sys.DELETE("/groups/:id", DeleteGroup(db))

		// 安全设置（登录防爆破阈值）
		sys.GET("/settings/security", GetSecuritySettings(db))
		sys.PUT("/settings/security", UpdateSecuritySettings(db))
	}
}
