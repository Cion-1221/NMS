package controllers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"nms-backend/core"
	"nms-backend/middleware"
	"nms-backend/models"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

// ─── 辅助函数 ────────────────────────────────────────────────────────────────

// writeSysAudit System 模块审计（用户/用户组/安全设置/会话管理的敏感操作留痕）
func writeSysAudit(db *gorm.DB, username, action, resourceType, resourceID, detail string) {
	_ = db.Create(&models.SysAuditLog{
		Username: username, Action: action, ResourceType: resourceType,
		ResourceID: resourceID, Detail: detail,
	}).Error
}

// validatePermissions 校验用户组 permissions 字段：必须是合法 JSON 字符串数组，
// 且只含 models.KnownPermissions 中的已知值。返回规范化（去重）后的 JSON 与是否
// 含 admin。任意字符串直接入库曾导致两个问题：坏 JSON 让 IsAdmin() 静默降权；
// "唯一管理员组"保护可被非 "[]" 的值绕过。
func validatePermissions(raw string) (normalized string, isAdmin bool, ce *core.CodedError) {
	var perms []string
	if err := json.Unmarshal([]byte(raw), &perms); err != nil {
		return "", false, &core.CodedError{Code: "sys.perms_invalid", Msg: `permissions 必须是合法的 JSON 字符串数组，如 ["admin"]`}
	}
	known := make(map[string]bool, len(models.KnownPermissions))
	for _, p := range models.KnownPermissions {
		known[p] = true
	}
	seen := make(map[string]bool, len(perms))
	out := make([]string, 0, len(perms))
	for _, p := range perms {
		if !known[p] {
			return "", false, &core.CodedError{Code: "sys.perms_unknown", Msg: "包含未知权限值: " + p}
		}
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	b, _ := json.Marshal(out)
	return string(b), seen[models.PermAdmin], nil
}

func parseUserID(c *gin.Context) (uint, bool) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil || id == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的用户 ID", "code": "bad_request"})
		return 0, false
	}
	return uint(id), true
}

func parseGroupIDParam(c *gin.Context) (uint, bool) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil || id == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的用户组 ID", "code": "bad_request"})
		return 0, false
	}
	return uint(id), true
}

// countRemainingAdminUsers 计算排除 excludeUserID 后，系统内剩余的**启用状态**
// 管理员用户数（被停用的管理员不算数——删除/停用保护都以"还有人能登录管理"为准）
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
		Where("group_id IN ? AND id != ? AND enabled = ?", adminGroupIDs, excludeUserID, true).
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

// ListUsers GET /api/v1/system/users —— 附带每个用户当前未过期的 Refresh Token
// 数量（活跃会话），供管理界面展示与"强制下线"操作参考。
func ListUsers(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var users []models.SysUser
		db.Preload("Group").Order("id asc").Find(&users)

		type sessRow struct {
			UserID uint
			Cnt    int64
		}
		var rows []sessRow
		db.Model(&models.SysRefreshToken{}).
			Select("user_id, COUNT(*) AS cnt").
			Where("expires_at > ?", time.Now()).
			Group("user_id").Scan(&rows)
		cnt := make(map[uint]int64, len(rows))
		for _, r := range rows {
			cnt[r.UserID] = r.Cnt
		}
		for i := range users {
			users[i].ActiveSessions = cnt[users[i].ID]
		}
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
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error(), "code": "bad_request"})
			return
		}

		var group models.SysGroup
		if err := db.First(&group, req.GroupID).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "指定的用户组不存在", "code": "not_found"})
			return
		}

		hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "密码处理失败", "code": "server_error"})
			return
		}

		user := models.SysUser{
			Username:           req.Username,
			PasswordHash:       string(hash),
			GroupID:            req.GroupID,
			MustChangePassword: true, // 新用户首次登录必须改密
		}
		if err := db.Create(&user).Error; err != nil {
			if isDuplicateErr(err) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "用户名已存在，请使用其他用户名", "code": "sys.username_taken"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "用户创建失败: " + err.Error(), "code": "server_error"})
			return
		}
		db.Preload("Group").First(&user, user.ID)
		writeSysAudit(db, getUsername(c), "create_user", "user", user.Username,
			fmt.Sprintf("Created user %q in group %q", user.Username, user.Group.Name))
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
			Enabled  *bool  `json:"enabled"`  // nil = 不修改
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}

		var user models.SysUser
		if err := db.Preload("Group").First(&user, targetID).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "用户不存在", "code": "not_found"})
			return
		}

		// 防止管理员将自己移出管理员组（避免权限锁死）
		if claims.UserID == targetID && req.GroupID != nil && *req.GroupID != user.GroupID {
			c.JSON(http.StatusBadRequest, gin.H{"error": "不能修改自己的用户组，如需调整请联系其他管理员", "code": "sys.cannot_change_own_group"})
			return
		}

		updates := map[string]interface{}{}
		var auditParts []string

		if req.GroupID != nil && *req.GroupID != user.GroupID {
			var newGroup models.SysGroup
			if err := db.First(&newGroup, *req.GroupID).Error; err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "目标用户组不存在", "code": "not_found"})
				return
			}
			updates["group_id"] = *req.GroupID
			auditParts = append(auditParts, fmt.Sprintf("group %q → %q", user.Group.Name, newGroup.Name))
		}

		if req.Password != "" {
			if len(req.Password) < 8 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "新密码至少需要 8 位", "code": "auth.pwd_too_short"})
				return
			}
			hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "密码处理失败", "code": "server_error"})
				return
			}
			updates["password_hash"] = string(hash)
			updates["must_change_password"] = true // 强制用户下次登录改密
			auditParts = append(auditParts, "password reset")
		}

		disabling := req.Enabled != nil && !*req.Enabled && user.Enabled
		if req.Enabled != nil && *req.Enabled != user.Enabled {
			// 不能停用自己（正在操作的会话立刻自断，且可能锁死系统）
			if disabling && claims.UserID == targetID {
				c.JSON(http.StatusBadRequest, gin.H{"error": "不能停用当前登录的用户账号", "code": "sys.cannot_disable_self"})
				return
			}
			// 不能停用最后一个启用状态的管理员（防御 JWT 权限快照过期等边界情况）
			if disabling && user.Group.IsAdmin() {
				remaining, err := countRemainingAdminUsers(db, targetID)
				if err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": "权限校验失败", "code": "server_error"})
					return
				}
				if remaining == 0 {
					c.JSON(http.StatusBadRequest, gin.H{"error": "无法停用系统中最后一个启用的管理员账号", "code": "sys.last_admin_user"})
					return
				}
			}
			updates["enabled"] = *req.Enabled
			if disabling {
				auditParts = append(auditParts, "disabled")
			} else {
				auditParts = append(auditParts, "enabled")
			}
		}

		if len(updates) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "未提供任何可更新的字段", "code": "bad_request"})
			return
		}

		if err := db.Model(&user).Updates(updates).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "更新失败: " + err.Error(), "code": "server_error"})
			return
		}

		// 管理员重置密码与停用账号均属安全事件：吊销该用户全部 Refresh Token，
		// 让既有会话无法续期——否则若操作原因正是"账号疑似被盗"，攻击者手里的旧
		// Refresh Token 依然可以无限换新，操作形同虚设。
		if _, pwChanged := updates["password_hash"]; pwChanged || disabling {
			db.Where("user_id = ?", user.ID).Delete(&models.SysRefreshToken{})
		}

		writeSysAudit(db, getUsername(c), "update_user", "user", user.Username,
			fmt.Sprintf("Updated user %q: %s", user.Username, strings.Join(auditParts, ", ")))

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
			c.JSON(http.StatusBadRequest, gin.H{"error": "不能删除当前登录的用户账号", "code": "sys.cannot_delete_self"})
			return
		}

		var user models.SysUser
		if err := db.Preload("Group").First(&user, targetID).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "用户不存在", "code": "not_found"})
			return
		}

		// 如果被删用户是管理员，检查是否为系统最后一个管理员用户
		if user.Group.IsAdmin() {
			remaining, err := countRemainingAdminUsers(db, targetID)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "权限校验失败", "code": "server_error"})
				return
			}
			if remaining == 0 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "无法删除系统中最后一个管理员账号", "code": "sys.last_admin_user"})
				return
			}
		}

		// 删除用户时连同其全部 Refresh Token 一并清理：既有会话立即无法续期，
		// 也避免 sys_refresh_tokens 留下无主记录等到自然过期
		txErr := db.Transaction(func(tx *gorm.DB) error {
			if err := tx.Where("user_id = ?", targetID).Delete(&models.SysRefreshToken{}).Error; err != nil {
				return err
			}
			return tx.Delete(&user).Error
		})
		if txErr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "删除失败", "code": "server_error"})
			return
		}
		writeSysAudit(db, getUsername(c), "delete_user", "user", user.Username,
			fmt.Sprintf("Deleted user %q (group %q)", user.Username, user.Group.Name))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// ForceLogoutUser POST /api/v1/system/users/:id/force-logout
// 吊销目标用户全部 Refresh Token：所有会话在当前 Access Token 到期后无法续期。
// （Access Token 本身不可吊销，存量 Token 在有效期内仍可用——与密码重置同款取舍）
func ForceLogoutUser(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		targetID, ok := parseUserID(c)
		if !ok {
			return
		}
		var user models.SysUser
		if err := db.First(&user, targetID).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "用户不存在", "code": "not_found"})
			return
		}
		result := db.Where("user_id = ?", targetID).Delete(&models.SysRefreshToken{})
		if result.Error != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "操作失败", "code": "server_error"})
			return
		}
		writeSysAudit(db, getUsername(c), "force_logout", "user", user.Username,
			fmt.Sprintf("Revoked %d active session(s) of user %q", result.RowsAffected, user.Username))
		c.JSON(http.StatusOK, gin.H{"revoked": result.RowsAffected})
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
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error(), "code": "bad_request"})
			return
		}
		if req.Permissions == "" {
			req.Permissions = "[]"
		}
		normalized, _, ce := validatePermissions(req.Permissions)
		if ce != nil {
			c.JSON(http.StatusBadRequest, codedErrJSON(ce))
			return
		}

		group := models.SysGroup{Name: req.Name, Permissions: normalized}
		if err := db.Create(&group).Error; err != nil {
			if isDuplicateErr(err) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "用户组名称已存在，请使用其他名称", "code": "common.name_taken"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "用户组创建失败: " + err.Error(), "code": "server_error"})
			return
		}
		writeSysAudit(db, getUsername(c), "create_group", "group", group.Name,
			fmt.Sprintf("Created group %q with permissions %s", group.Name, group.Permissions))
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
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}

		var group models.SysGroup
		if err := db.First(&group, gid).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "用户组不存在", "code": "not_found"})
			return
		}

		updates := map[string]interface{}{}
		if req.Name != "" {
			updates["name"] = req.Name
		}
		if req.Permissions != "" {
			normalized, newIsAdmin, ce := validatePermissions(req.Permissions)
			if ce != nil {
				c.JSON(http.StatusBadRequest, codedErrJSON(ce))
				return
			}
			// 防止撤销唯一管理员组的 admin 权限——按解析结果判断"改完还是不是管理员组"，
			// 而非旧版的 `== "[]"` 字符串比较（任何不含 admin 的其他值都能绕过那个检查，
			// 导致全系统失去管理员、只能改库恢复）
			if group.IsAdmin() && !newIsAdmin && countOtherAdminGroups(db, gid) == 0 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "无法撤销唯一管理员组的权限，系统至少需要保留一个管理员组", "code": "sys.last_admin_group"})
				return
			}
			updates["permissions"] = normalized
		}
		if len(updates) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "未提供任何可更新的字段", "code": "bad_request"})
			return
		}

		if err := db.Model(&group).Updates(updates).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "更新失败", "code": "server_error"})
			return
		}
		db.First(&group, gid)
		writeSysAudit(db, getUsername(c), "update_group", "group", group.Name,
			fmt.Sprintf("Updated group %q: permissions=%s", group.Name, group.Permissions))
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
			c.JSON(http.StatusNotFound, gin.H{"error": "用户组不存在", "code": "not_found"})
			return
		}

		// 不允许删除含有用户的组
		var userCount int64
		db.Model(&models.SysUser{}).Where("group_id = ?", gid).Count(&userCount)
		if userCount > 0 {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": fmt.Sprintf("该用户组下仍有 %d 个用户，请先将其迁移至其他组后再删除", userCount),
				"code":  "sys.group_has_users", "count": userCount,
			})
			return
		}

		// 不允许删除最后一个管理员组
		if group.IsAdmin() {
			otherAdminGroups := countOtherAdminGroups(db, gid)
			if otherAdminGroups == 0 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "无法删除系统中最后一个管理员组", "code": "sys.last_admin_group"})
				return
			}
		}

		if err := db.Delete(&group).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "删除失败", "code": "server_error"})
			return
		}
		writeSysAudit(db, getUsername(c), "delete_group", "group", group.Name,
			fmt.Sprintf("Deleted group %q", group.Name))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// ─── System 审计日志 ─────────────────────────────────────────────────────────

// ListSysAuditLogs GET /api/v1/system/audit-logs（分页 + username/action 过滤）
func ListSysAuditLogs(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
		pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))
		if page < 1 {
			page = 1
		}
		if pageSize < 1 || pageSize > 100 {
			pageSize = 20
		}
		query := db.Model(&models.SysAuditLog{}).Order("created_at desc")
		if u := c.Query("username"); u != "" {
			query = query.Where("username LIKE ?", "%"+u+"%")
		}
		if a := c.Query("action"); a != "" {
			query = query.Where("action = ?", a)
		}
		var total int64
		query.Count(&total)
		var logs []models.SysAuditLog
		query.Offset((page - 1) * pageSize).Limit(pageSize).Find(&logs)
		c.JSON(http.StatusOK, gin.H{"total": total, "items": logs, "page": page, "page_size": pageSize})
	}
}

// PurgeSysAuditLogs DELETE /api/v1/system/audit-logs?days=N（保留最近 N 天）
func PurgeSysAuditLogs(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		days, err := strconv.Atoi(c.Query("days"))
		if err != nil || days < 1 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的天数参数（最小 1 天）", "code": "bad_request"})
			return
		}
		cutoff := time.Now().AddDate(0, 0, -days)
		result := db.Where("created_at < ?", cutoff).Delete(&models.SysAuditLog{})
		writeSysAudit(db, getUsername(c), "purge_audit", "audit_log", "",
			fmt.Sprintf("Purged system audit logs older than %d days (%d rows)", days, result.RowsAffected))
		c.JSON(http.StatusOK, gin.H{"deleted": result.RowsAffected})
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
		sys.POST("/users/:id/force-logout", ForceLogoutUser(db))

		sys.GET("/groups", ListGroups(db))
		sys.POST("/groups", CreateGroup(db))
		sys.PUT("/groups/:id", UpdateGroup(db))
		sys.DELETE("/groups/:id", DeleteGroup(db))

		// 安全设置（登录防爆破阈值 + 会话策略）
		sys.GET("/settings/security", GetSecuritySettings(db))
		sys.PUT("/settings/security", UpdateSecuritySettings(db))
		sys.GET("/settings/session", GetSessionPolicyAPI(db))
		sys.PUT("/settings/session", UpdateSessionPolicyAPI(db))

		// 锁定列表：查看 + 手动解除（单条/批量）
		sys.GET("/security/lockouts", ListLockouts())
		sys.POST("/security/lockouts/unlock", UnlockLockouts(db))

		// System 审计日志（用户/组/安全设置/会话管理操作留痕）
		sys.GET("/audit-logs", ListSysAuditLogs(db))
		sys.DELETE("/audit-logs", PurgeSysAuditLogs(db))
	}
}
