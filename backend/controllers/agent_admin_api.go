package controllers

import (
	"fmt"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"nms-backend/core"
	"nms-backend/middleware"
	"nms-backend/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// ── 共享 ───────────────────────────────────────────────────────────────────

func writeAgentAudit(db *gorm.DB, username, action, resourceType, resourceID, detail string) {
	_ = db.Create(&models.AgentAuditLog{
		Username: username, Action: action, ResourceType: resourceType,
		ResourceID: resourceID, Detail: detail,
	}).Error
}

// parseSourceIPOverride 验证并规范化 Source IP Override：
// 支持单个 IPv4、单个 IPv6，或 "ipv4 / ipv6" 双栈格式（顺序不限，以 / 分隔）。
func parseSourceIPOverride(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	parts := strings.SplitN(raw, "/", 2)
	var addrs []netip.Addr
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		a, err := netip.ParseAddr(p)
		if err != nil {
			return "", fmt.Errorf("无效的 IP 地址: %s", p)
		}
		addrs = append(addrs, a)
	}
	if len(addrs) == 0 {
		return "", fmt.Errorf("Source IP 不能为空")
	}
	if len(addrs) == 1 {
		return addrs[0].String(), nil
	}
	a0, a1 := addrs[0], addrs[1]
	if a0.Is4() == a1.Is4() {
		return "", fmt.Errorf("双栈配置需要分别填写 IPv4 和 IPv6 地址")
	}
	if !a0.Is4() {
		a0, a1 = a1, a0
	}
	return a0.String() + " / " + a1.String(), nil
}

var validTaskTypes = map[string]bool{
	"ping": true, "tcpping": true, "httpcheck": true, "dnscheck": true,
	"traceroute": true, "mtr": true, "meshping": true,
}

// ── Agent 管理（List / 修改 SourceIP+Group / 删除 / 作废证书）──────────────────

func ListAgents(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
		pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))
		if page < 1 {
			page = 1
		}
		if pageSize < 1 || pageSize > 200 {
			pageSize = 20
		}

		q := db.Model(&models.Agent{})
		if v := c.Query("q"); v != "" {
			q = q.Where("agent_id LIKE ? OR hostname LIKE ? OR connection_ip LIKE ? OR connection_ipv4 LIKE ? OR connection_ipv6 LIKE ?",
				"%"+v+"%", "%"+v+"%", "%"+v+"%", "%"+v+"%", "%"+v+"%")
		}
		if v := c.Query("group_id"); v != "" {
			if id, err := strconv.Atoi(v); err == nil && id > 0 {
				q = q.Where("group_id = ?", id)
			}
		}
		if v := c.Query("status"); v != "" {
			q = q.Where("status = ?", v)
		}

		var total int64
		q.Count(&total)
		var agents []models.Agent
		q.Preload("Group").Order("registered_at desc").
			Offset((page - 1) * pageSize).Limit(pageSize).Find(&agents)
		c.JSON(http.StatusOK, gin.H{"total": total, "items": agents, "page": page, "page_size": pageSize})
	}
}

// UpdateAgent PUT /api/v1/agents/:agent_id —— 整体覆盖式更新（与 UpdateDevice 同款语义）：
// source_ip_override 空字符串=清除；group_id 为 null=清除分组；hostname 不可为空。
func UpdateAgent(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		agentID := c.Param("agent_id")
		var req struct {
			Hostname         string `json:"hostname" binding:"required"`
			SourceIPOverride string `json:"source_ip_override"`
			GroupID          *uint  `json:"group_id"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error()})
			return
		}
		var agent models.Agent
		if err := db.Where("agent_id = ?", agentID).First(&agent).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "Agent 不存在"})
			return
		}

		var sourceIP interface{}
		if req.SourceIPOverride != "" {
			normalized, err := parseSourceIPOverride(req.SourceIPOverride)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
				return
			}
			sourceIP = normalized
		}
		if req.GroupID != nil {
			if err := db.First(&models.AgentGroup{}, *req.GroupID).Error; err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "指定的 Group 不存在"})
				return
			}
		}

		if err := db.Model(&agent).Updates(map[string]interface{}{
			"hostname":           req.Hostname,
			"source_ip_override": sourceIP,
			"group_id":           req.GroupID,
		}).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "更新失败: " + err.Error()})
			return
		}
		db.Preload("Group").Where("agent_id = ?", agentID).First(&agent)
		writeAgentAudit(db, getUsername(c), "update_agent", "agent", agentID,
			fmt.Sprintf("Updated agent %s (hostname=%s)", agentID, req.Hostname))
		c.JSON(http.StatusOK, agent)
	}
}

func DeleteAgent(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		agentID := c.Param("agent_id")
		var agent models.Agent
		if err := db.Where("agent_id = ?", agentID).First(&agent).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "Agent 不存在"})
			return
		}
		if err := db.Delete(&agent).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "删除失败: " + err.Error()})
			return
		}
		writeAgentAudit(db, getUsername(c), "delete_agent", "agent", agentID,
			fmt.Sprintf("Deleted agent %s (%s)", agentID, agent.Hostname))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// RevokeAgent POST /api/v1/agents/:agent_id/revoke —— 作废证书：保留 Agent 记录及历史
// 结果，仅阻止其后续 mTLS 调用（AgentMTLS 中间件会拒绝 Revoked=true 的 Agent）。
func RevokeAgent(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		agentID := c.Param("agent_id")
		var agent models.Agent
		if err := db.Where("agent_id = ?", agentID).First(&agent).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "Agent 不存在"})
			return
		}
		if err := db.Model(&agent).Updates(map[string]interface{}{"revoked": true, "status": "offline"}).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "作废失败: " + err.Error()})
			return
		}
		writeAgentAudit(db, getUsername(c), "revoke_agent", "agent", agentID,
			fmt.Sprintf("Revoked certificate for agent %s", agentID))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// ── AgentGroup 管理（同 TabVendors / DeviceVendor 模式）─────────────────────

func ListAgentGroups(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var groups []models.AgentGroup
		db.Order("name asc").Find(&groups)
		c.JSON(http.StatusOK, groups)
	}
}

func CreateAgentGroup(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Name        string `json:"name" binding:"required"`
			Description string `json:"description"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		group := models.AgentGroup{Name: req.Name, Description: req.Description}
		if err := db.Create(&group).Error; err != nil {
			if msg := friendlyNameUniqueErr(err, "分组"); msg != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": msg})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "创建失败: " + err.Error()})
			return
		}
		writeAgentAudit(db, getUsername(c), "create_group", "agent_group", strconv.Itoa(int(group.ID)),
			fmt.Sprintf("Created agent group: %s", req.Name))
		c.JSON(http.StatusOK, group)
	}
}

func UpdateAgentGroup(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var req struct {
			Name        string `json:"name" binding:"required"`
			Description string `json:"description"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}
		var group models.AgentGroup
		if err := db.First(&group, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "分组不存在"})
			return
		}
		if err := db.Model(&group).Updates(map[string]interface{}{
			"name": req.Name, "description": req.Description,
		}).Error; err != nil {
			if msg := friendlyNameUniqueErr(err, "分组"); msg != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": msg})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "更新失败: " + err.Error()})
			return
		}
		db.First(&group, id)
		writeAgentAudit(db, getUsername(c), "update_group", "agent_group", strconv.Itoa(int(id)),
			fmt.Sprintf("Updated agent group %d: %s", id, req.Name))
		c.JSON(http.StatusOK, group)
	}
}

// DeleteAgentGroup 删除分组前将引用方 SET NULL（与 DeviceRole/DeviceVendor 同策略），
// 不做 RESTRICT —— Agent/Task 失去分组后退化为"未分组"，不阻塞删除操作。
func DeleteAgentGroup(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		txErr := db.Transaction(func(tx *gorm.DB) error {
			tx.Exec("UPDATE agents SET group_id = NULL WHERE group_id = ?", id)
			tx.Exec("UPDATE agent_tasks SET group_id = NULL WHERE group_id = ?", id)
			return tx.Delete(&models.AgentGroup{}, id).Error
		})
		if txErr != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "删除失败: " + txErr.Error()})
			return
		}
		writeAgentAudit(db, getUsername(c), "delete_group", "agent_group", strconv.Itoa(int(id)),
			fmt.Sprintf("Deleted agent group %d", id))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// ── AgentTask 管理（Probe Config）────────────────────────────────────────────

func ListAgentTasks(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var tasks []models.AgentTask
		db.Preload("Group").Preload("Agent").Order("id desc").Find(&tasks)
		c.JSON(http.StatusOK, tasks)
	}
}

// validateTargets 校验 targets_raw 里每一行都是合法的 IPv4 或 IPv6 地址（netip.ParseAddr
// 对两者一视同仁）。meshping 任务的 Target 由 Server 动态解析，调用方应跳过校验。
func validateTargets(raw string) string {
	task := models.AgentTask{TargetsRaw: raw}
	for _, target := range task.Targets() {
		if _, err := netip.ParseAddr(target); err != nil {
			return fmt.Sprintf("无效的 Target 地址: %s（仅支持 IPv4/IPv6 地址）", target)
		}
	}
	return ""
}

func validateTaskScope(scope string, groupID *uint, agentID *string) string {
	switch scope {
	case "global":
		return ""
	case "group":
		if groupID == nil {
			return "Scope=group 时必须指定 Group"
		}
		return ""
	case "agent":
		if agentID == nil || *agentID == "" {
			return "Scope=agent 时必须指定 Agent"
		}
		return ""
	default:
		return "无效的 Scope，可选: global / group / agent"
	}
}

// CreateAgentTasks POST /api/v1/agent-tasks —— Probe Config 的"多选任务类型"提交：
// 一次提交可勾选多个 Type，按所选类型各拆分成一条独立的 AgentTask 记录
// （共享 Name/Targets/Interval/Scope/归属），保持每条任务/每条结果单一类型，便于
// 与 ProbeResult.Type 一一对应展示。
func CreateAgentTasks(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Name            string   `json:"name" binding:"required"`
			Types           []string `json:"types" binding:"required,min=1"`
			TargetsRaw      string   `json:"targets_raw"`
			IntervalSeconds int      `json:"interval_seconds" binding:"required,min=1"`
			Scope           string   `json:"scope" binding:"required"`
			GroupID         *uint    `json:"group_id"`
			AgentID         *string  `json:"agent_id"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error()})
			return
		}
		needsTargetValidation := false
		for _, ty := range req.Types {
			if !validTaskTypes[ty] {
				c.JSON(http.StatusBadRequest, gin.H{"error": "不支持的任务类型: " + ty})
				return
			}
			if ty != "meshping" {
				needsTargetValidation = true
			}
		}
		if msg := validateTaskScope(req.Scope, req.GroupID, req.AgentID); msg != "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": msg})
			return
		}
		// meshping 的 Target 由 Server 动态解析，忽略用户填写的内容；其余类型必须是
		// 合法的 IPv4/IPv6 地址。多选类型时只要有一个非 meshping 类型就需要校验，因为
		// 这些类型会真正使用 TargetsRaw。
		if needsTargetValidation {
			if msg := validateTargets(req.TargetsRaw); msg != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": msg})
				return
			}
		}

		created := make([]models.AgentTask, 0, len(req.Types))
		for _, ty := range req.Types {
			task := models.AgentTask{
				Name: req.Name, Type: ty, TargetsRaw: req.TargetsRaw,
				IntervalSeconds: req.IntervalSeconds, Scope: req.Scope,
				GroupID: req.GroupID, AgentID: req.AgentID, Enabled: true,
			}
			if err := db.Create(&task).Error; err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "创建失败: " + err.Error()})
				return
			}
			created = append(created, task)
		}
		writeAgentAudit(db, getUsername(c), "create_task", "agent_task", req.Name,
			fmt.Sprintf("Created %d task(s) (%v) for %q", len(created), req.Types, req.Name))
		c.JSON(http.StatusOK, created)
	}
}

func UpdateAgentTask(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var req struct {
			Name            string  `json:"name" binding:"required"`
			Type            string  `json:"type" binding:"required"`
			TargetsRaw      string  `json:"targets_raw"`
			IntervalSeconds int     `json:"interval_seconds" binding:"required,min=1"`
			Scope           string  `json:"scope" binding:"required"`
			GroupID         *uint   `json:"group_id"`
			AgentID         *string `json:"agent_id"`
			Enabled         bool    `json:"enabled"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error()})
			return
		}
		if !validTaskTypes[req.Type] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "不支持的任务类型: " + req.Type})
			return
		}
		if msg := validateTaskScope(req.Scope, req.GroupID, req.AgentID); msg != "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": msg})
			return
		}
		if req.Type != "meshping" {
			if msg := validateTargets(req.TargetsRaw); msg != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": msg})
				return
			}
		}

		var task models.AgentTask
		if err := db.First(&task, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "任务不存在"})
			return
		}
		if err := db.Model(&task).Updates(map[string]interface{}{
			"name": req.Name, "type": req.Type, "targets_raw": req.TargetsRaw,
			"interval_seconds": req.IntervalSeconds, "scope": req.Scope,
			"group_id": req.GroupID, "agent_id": req.AgentID, "enabled": req.Enabled,
		}).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "更新失败: " + err.Error()})
			return
		}
		db.Preload("Group").Preload("Agent").First(&task, id)
		writeAgentAudit(db, getUsername(c), "update_task", "agent_task", strconv.Itoa(int(id)),
			fmt.Sprintf("Updated task %d: %s", id, req.Name))
		c.JSON(http.StatusOK, task)
	}
}

func DeleteAgentTask(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if err := db.Delete(&models.AgentTask{}, id).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "删除失败: " + err.Error()})
			return
		}
		writeAgentAudit(db, getUsername(c), "delete_task", "agent_task", strconv.Itoa(int(id)),
			fmt.Sprintf("Deleted task %d", id))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// ── AgentToken 管理（Token Tab：生成一次性注册码）───────────────────────────

func ListAgentTokens(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
		pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))
		if page < 1 {
			page = 1
		}
		if pageSize < 1 || pageSize > 100 {
			pageSize = 20
		}
		q := db.Model(&models.AgentToken{})
		var total int64
		q.Count(&total)
		var tokens []models.AgentToken
		q.Preload("PresetGroup").Order("created_at desc").
			Offset((page - 1) * pageSize).Limit(pageSize).Find(&tokens)
		c.JSON(http.StatusOK, gin.H{"total": total, "items": tokens, "page": page, "page_size": pageSize})
	}
}

// CreateAgentToken POST /api/v1/agent-tokens —— 生成一次性注册码。
// 复用 auth_api.go 的 generateRefreshToken（32 字节随机 + SHA-256 哈希）：
// 明文 token 仅在本次响应中返回一次，DB 只持久化其哈希。
func CreateAgentToken(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			ExpiresInMinutes int   `json:"expires_in_minutes" binding:"required,min=1"`
			PresetGroupID    *uint `json:"preset_group_id"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error()})
			return
		}
		if req.PresetGroupID != nil {
			if err := db.First(&models.AgentGroup{}, *req.PresetGroupID).Error; err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "指定的 Group 不存在"})
				return
			}
		}
		raw, hashed, err := generateRefreshToken()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "生成失败"})
			return
		}
		token := models.AgentToken{
			TokenHash:     hashed,
			Status:        "unused",
			PresetGroupID: req.PresetGroupID,
			ExpiresAt:     time.Now().Add(time.Duration(req.ExpiresInMinutes) * time.Minute),
			CreatedBy:     getUsername(c),
		}
		if err := db.Create(&token).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "创建失败: " + err.Error()})
			return
		}
		writeAgentAudit(db, getUsername(c), "create_token", "agent_token", strconv.Itoa(int(token.ID)),
			fmt.Sprintf("Generated provisioning token, expires in %d minutes", req.ExpiresInMinutes))
		c.JSON(http.StatusOK, gin.H{"id": token.ID, "token": raw, "expires_at": token.ExpiresAt})
	}
}

func RevokeAgentToken(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var token models.AgentToken
		if err := db.First(&token, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "Token 不存在"})
			return
		}
		if token.Status != "unused" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "仅可作废未使用的 Token"})
			return
		}
		db.Model(&token).Update("status", "revoked")
		writeAgentAudit(db, getUsername(c), "revoke_token", "agent_token", strconv.Itoa(int(id)),
			"Revoked unused provisioning token")
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// ── CA 状态/轮换（Token Tab 顶部的 CA 管理面板）─────────────────────────────

func GetCAStatus(pki *core.PKI) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.JSON(http.StatusOK, pki.Status())
	}
}

// RotateCA POST /api/v1/agents/ca/rotate —— 生成新 Root CA 并写入磁盘。
// 仅落盘生效，需要重启 NMS 进程后新的信任边界才会真正生效（原因见 core/pki.go
// 类型注释：避免热切换一个正被 TLS 握手并发读取的信任池引入数据竞争）。
func RotateCA(db *gorm.DB, pki *core.PKI, caDays int) gin.HandlerFunc {
	return func(c *gin.Context) {
		if err := pki.Rotate(caDays); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "轮换失败: " + err.Error()})
			return
		}
		writeAgentAudit(db, getUsername(c), "rotate_ca", "ca", "",
			"Rotated Root CA; restart required to take effect")
		c.JSON(http.StatusOK, gin.H{
			"message": "已生成新 Root CA，重启 NMS 服务后生效；旧 CA 在 Finalize 之前仍被信任",
		})
	}
}

// FinalizeCA POST /api/v1/agents/ca/finalize —— 结束轮换过渡期，不再信任旧 CA。
// 仅落盘生效，需要重启 NMS 进程。
func FinalizeCA(db *gorm.DB, pki *core.PKI) gin.HandlerFunc {
	return func(c *gin.Context) {
		if err := pki.Finalize(); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		writeAgentAudit(db, getUsername(c), "finalize_ca", "ca", "",
			"Finalized CA rotation; restart required to take effect")
		c.JSON(http.StatusOK, gin.H{"message": "已终结轮换，重启 NMS 服务后旧 CA 将不再被信任"})
	}
}

// ── Agent 健康汇总（Agent List 顶部统计卡片）────────────────────────────────

func GetAgentSummary(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var total, revoked, online int64
		db.Model(&models.Agent{}).Count(&total)
		db.Model(&models.Agent{}).Where("revoked = ?", true).Count(&revoked)
		db.Model(&models.Agent{}).Where("revoked = ? AND status = ?", false, "online").Count(&online)
		offline := total - revoked - online

		cutoff := time.Now().Add(-time.Hour)
		var recentTotal, recentFailed int64
		db.Model(&models.ProbeResult{}).Where("reported_at > ?", cutoff).Count(&recentTotal)
		db.Model(&models.ProbeResult{}).Where("reported_at > ? AND success = ?", cutoff, false).Count(&recentFailed)
		var failureRate float64
		if recentTotal > 0 {
			failureRate = float64(recentFailed) / float64(recentTotal) * 100
		}

		c.JSON(http.StatusOK, gin.H{
			"total_agents":            total,
			"online_agents":           online,
			"offline_agents":          offline,
			"revoked_agents":          revoked,
			"recent_probes_1h":        recentTotal,
			"recent_failed_1h":        recentFailed,
			"recent_failure_rate_pct": failureRate,
		})
	}
}

// ── Route Registration ─────────────────────────────────────────────────────

// RegisterAgentAdminRoutes 注册不依赖 PKI 的 Agent 管理路由（agents/groups/tasks/tokens），
// 无论 agent_pki.enabled 是否开启都应调用。
func RegisterAgentAdminRoutes(r *gin.Engine, db *gorm.DB, authMW gin.HandlerFunc) {
	agents := r.Group("/api/v1/agents")
	agents.Use(authMW, middleware.AdminRequired)
	{
		agents.GET("", ListAgents(db))
		agents.GET("/summary", GetAgentSummary(db))
		agents.PUT("/:agent_id", UpdateAgent(db))
		agents.DELETE("/:agent_id", DeleteAgent(db))
		agents.POST("/:agent_id/revoke", RevokeAgent(db))
	}

	groups := r.Group("/api/v1/agent-groups")
	groups.Use(authMW, middleware.AdminRequired)
	{
		groups.GET("", ListAgentGroups(db))
		groups.POST("", CreateAgentGroup(db))
		groups.PUT("/:id", UpdateAgentGroup(db))
		groups.DELETE("/:id", DeleteAgentGroup(db))
	}

	tasks := r.Group("/api/v1/agent-tasks")
	tasks.Use(authMW, middleware.AdminRequired)
	{
		tasks.GET("", ListAgentTasks(db))
		tasks.POST("", CreateAgentTasks(db))
		tasks.PUT("/:id", UpdateAgentTask(db))
		tasks.DELETE("/:id", DeleteAgentTask(db))
	}

	tokens := r.Group("/api/v1/agent-tokens")
	tokens.Use(authMW, middleware.AdminRequired)
	{
		tokens.GET("", ListAgentTokens(db))
		tokens.POST("", CreateAgentToken(db))
		tokens.POST("/:id/revoke", RevokeAgentToken(db))
	}
}

// RegisterAgentPKIRoutes 注册依赖 PKI 的 CA 管理路由（ca-cert/ca/status/rotate/finalize），
// 仅在 agent_pki.enabled=true 且 PKI 初始化成功时调用。
func RegisterAgentPKIRoutes(r *gin.Engine, db *gorm.DB, pki *core.PKI, caDays int, authMW gin.HandlerFunc) {
	agents := r.Group("/api/v1/agents")
	agents.Use(authMW, middleware.AdminRequired)
	{
		// 浏览器走主站 HTTPS/HTTP，无法直接信任 enroll 端口上自签发的内置 CA 证书，
		// 故在主引擎上镜像一份 GetCACert，方便 Token Tab 展示/下载 CA 公钥。
		agents.GET("/ca-cert", GetCACert(pki))
		agents.GET("/ca/status", GetCAStatus(pki))
		agents.POST("/ca/rotate", RotateCA(db, pki, caDays))
		agents.POST("/ca/finalize", FinalizeCA(db, pki))
	}
}
