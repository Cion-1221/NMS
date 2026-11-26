package controllers

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
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
	"traceroute": true, "mtr": true, "meshping": true, "meshmtr": true,
}

// meshAutoTypes：目标列表由 Server 动态解析的任务类型，不需要也不应校验 targets_raw。
var meshAutoTypes = map[string]bool{"meshping": true, "meshmtr": true}

// portOptionalTypes：targets_raw 每行允许携带 host:port（IPv6 用 [addr]:port 括号形式，
// 与 Agent 侧 net.SplitHostPort 解析方式一致）后缀的任务类型——tcpping 用端口做 TCP
// 探测目标，httpcheck 用端口构造探测 URL；两者省略端口时 Agent 侧也有默认值兜底
// （分别见 NMS_Agent 的 tcpping.go/httpcheck.go），因此端口是可选的、不是必须的。
var portOptionalTypes = map[string]bool{"tcpping": true, "httpcheck": true}

// validAddressFamilies：AgentTask.AddressFamily 的合法取值。auto = 跟随系统解析
// 偏好（历史行为）；both = 域名 target 按 v4/v6 各探测一次、出两条结果。
var validAddressFamilies = map[string]bool{"auto": true, "v4": true, "v6": true, "both": true}

// hostnameRe 允许常见主机名/FQDN（含下划线——RFC 上不合法但内网常见），不做穷举式
// 校验：域名是否真实可解析交给 Agent 运行时报错兜底（与对畸形 host:port 不做穷举
// 校验的宽松策略一致）。
var hostnameRe = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$`)

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
			// 口径与 GetAgentSummary 及列表展示一致：已作废的 Agent 在表格里显示为
			// Revoked 而非 online/offline，因此 online/offline 只匹配未作废的记录。
			switch v {
			case "revoked":
				q = q.Where("revoked = ?", true)
			case "online":
				q = q.Where("revoked = ? AND status = ?", false, "online")
			case "offline":
				q = q.Where("revoked = ? AND status <> ?", false, "online")
			}
		}
		if v := c.Query("version"); v != "" {
			q = q.Where("version = ?", v)
		}
		if v := c.Query("os"); v != "" {
			q = q.Where("os = ?", v)
		}
		if v := c.Query("arch"); v != "" {
			q = q.Where("arch = ?", v)
		}

		var total int64
		q.Count(&total)
		agents := make([]models.Agent, 0)
		q.Preload("Group").Order("group_id asc, agent_id asc").
			Offset((page - 1) * pageSize).Limit(pageSize).Find(&agents)
		c.JSON(http.StatusOK, gin.H{"total": total, "items": agents, "page": page, "page_size": pageSize})
	}
}

// GetAgentFilterOptions GET /api/v1/agents/filter-options —— Agent List 筛选栏
// 下拉的候选值：存量 Agent 去重后的版本号与 OS/Arch 组合。列表是服务端分页，
// 前端无法从当前页推导全集，故由后端一次给出。Group 候选走 /agent-groups。
func GetAgentFilterOptions(db *gorm.DB) gin.HandlerFunc {
	type profileRow struct {
		OS   string `json:"os"`
		Arch string `json:"arch"`
	}
	return func(c *gin.Context) {
		// 显式初始化为空切片：Scan 零行时不触碰目标，nil 会序列化为 JSON null
		versions := make([]string, 0)
		db.Model(&models.Agent{}).
			Where("version <> ''").
			Distinct().Order("version ASC").
			Pluck("version", &versions)
		profiles := make([]profileRow, 0)
		db.Model(&models.Agent{}).
			Select("os, arch").
			Where("os <> '' OR arch <> ''").
			Group("os, arch").Order("os ASC, arch ASC").
			Scan(&profiles)
		c.JSON(http.StatusOK, gin.H{"versions": versions, "profiles": profiles})
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
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error(), "code": "bad_request"})
			return
		}
		var agent models.Agent
		if err := db.Where("agent_id = ?", agentID).First(&agent).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "Agent 不存在", "code": "not_found"})
			return
		}

		var sourceIP interface{}
		if req.SourceIPOverride != "" {
			normalized, err := parseSourceIPOverride(req.SourceIPOverride)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "agent.invalid_source_ip"})
				return
			}
			sourceIP = normalized
		}
		if req.GroupID != nil {
			if err := db.First(&models.AgentGroup{}, *req.GroupID).Error; err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "指定的 Group 不存在", "code": "not_found"})
				return
			}
		}

		if err := db.Model(&agent).Updates(map[string]interface{}{
			"hostname":           req.Hostname,
			"source_ip_override": sourceIP,
			"group_id":           req.GroupID,
		}).Error; err != nil {
			dbErr(c, "更新", err)
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
			c.JSON(http.StatusNotFound, gin.H{"error": "Agent 不存在", "code": "not_found"})
			return
		}
		if c.Query("purge") == "true" {
			if _, err := deleteProbeResultsChunked(db, "agent_id = ?", agentID); err != nil {
				dbErr(c, "清除探测记录", err)
				return
			}
			db.Where("agent_id = ?", agentID).Delete(&models.ProbeLatestState{})
			var seriesIDs []uint
			db.Model(&models.ProbeSeries{}).Where("agent_id = ?", agentID).Pluck("id", &seriesIDs)
			if len(seriesIDs) > 0 {
				db.Where("series_id IN ?", seriesIDs).Delete(&models.ProbeRollup{})
				db.Where("id IN ?", seriesIDs).Delete(&models.ProbeSeries{})
			}
		}
		txErr := db.Transaction(func(tx *gorm.DB) error {
			// scope=agent 的专属任务随 Agent 一并删除，避免 Probe Config 留下悬空引用的孤儿任务
			if err := tx.Where("scope = ? AND agent_id = ?", "agent", agentID).Delete(&models.AgentTask{}).Error; err != nil {
				return fmt.Errorf("清除专属任务失败: %w", err)
			}
			// 解绑以此 Agent 为 SNMP 采集探针的设备，运行状态立即归位 unknown
			//（watchdog 的 agent_revoked 规则也会兜底，这里同步处理让前端立刻一致）
			if err := tx.Exec("UPDATE devices SET snmp_agent_id = NULL, oper_status = 'unknown', oper_reason = 'agent_revoked' WHERE snmp_agent_id = ?", agentID).Error; err != nil {
				return fmt.Errorf("解绑设备采集探针失败: %w", err)
			}
			return tx.Delete(&agent).Error
		})
		if txErr != nil {
			dbErr(c, "删除", txErr)
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
			c.JSON(http.StatusNotFound, gin.H{"error": "Agent 不存在", "code": "not_found"})
			return
		}
		if err := db.Model(&agent).Updates(map[string]interface{}{"revoked": true, "status": "offline"}).Error; err != nil {
			dbErr(c, "作废", err)
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
		db.Order("id asc").Find(&groups)
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
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}
		group := models.AgentGroup{Name: req.Name, Description: req.Description}
		if err := db.Create(&group).Error; err != nil {
			if msg := friendlyNameUniqueErr(err, "分组"); msg != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "common.name_taken"})
				return
			}
			dbErr(c, "创建", err)
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
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误", "code": "bad_request"})
			return
		}
		var group models.AgentGroup
		if err := db.First(&group, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "分组不存在", "code": "not_found"})
			return
		}
		if err := db.Model(&group).Updates(map[string]interface{}{
			"name": req.Name, "description": req.Description,
		}).Error; err != nil {
			if msg := friendlyNameUniqueErr(err, "分组"); msg != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "common.name_taken"})
				return
			}
			dbErr(c, "更新", err)
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
			if err := tx.Exec("UPDATE agents SET group_id = NULL WHERE group_id = ?", id).Error; err != nil {
				return err
			}
			// 绑定了该分组的任务清掉 group_id 并自动停用（等待管理员重新指定分组后再启用），
			// 避免残留 scope=group 但 group_id=NULL 的孤儿启用任务
			if err := tx.Exec("UPDATE agent_tasks SET group_id = NULL, enabled = false WHERE group_id = ?", id).Error; err != nil {
				return err
			}
			// 同步清除注册码上的预设分组引用，防止后续用该注册码注册的 Agent 指向已删分组
			if err := tx.Exec("UPDATE agent_tokens SET preset_group_id = NULL WHERE preset_group_id = ?", id).Error; err != nil {
				return err
			}
			return tx.Delete(&models.AgentGroup{}, id).Error
		})
		if txErr != nil {
			dbErr(c, "删除", txErr)
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
		db.Preload("Group").Preload("Agent").Order("id asc").Find(&tasks)
		c.JSON(http.StatusOK, tasks)
	}
}

// hostOK：字面 IPv4/IPv6 地址（netip.ParseAddr 对两者一视同仁）或形似主机名/域名。
func hostOK(s string) bool {
	if _, err := netip.ParseAddr(s); err == nil {
		return true
	}
	return hostnameRe.MatchString(s)
}

func portOK(p string) bool {
	n, err := strconv.Atoi(p)
	return err == nil && n >= 1 && n <= 65535
}

// targetLineOK 校验 targets_raw 的单行。基础形态是字面 IP 或域名；portTolerant
// 额外放行 host:port（IPv6 用 [addr]:port 括号形式，与 Agent 侧 net.SplitHostPort
// 解析方式一致）；urlTolerant 额外放行完整 http(s):// URL；dnsServerTolerant 额外
// 放行 domain@server 或 domain@server:port（供 dnscheck 指定上游 DNS 服务器）。
func targetLineOK(target string, portTolerant, urlTolerant, dnsServerTolerant bool) bool {
	if urlTolerant && (strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://")) {
		u, err := url.Parse(target)
		if err != nil || u.Hostname() == "" {
			return false
		}
		if p := u.Port(); p != "" && !portOK(p) {
			return false
		}
		return hostOK(u.Hostname())
	}
	if dnsServerTolerant {
		if domain, srv, hasAt := strings.Cut(target, "@"); hasAt {
			if !hostOK(domain) || srv == "" {
				return false
			}
			if hostOK(srv) {
				return true
			}
			if h, p, err := net.SplitHostPort(srv); err == nil {
				return hostOK(h) && portOK(p)
			}
			return false
		}
	}
	if hostOK(target) {
		return true
	}
	if portTolerant {
		if host, port, err := net.SplitHostPort(target); err == nil {
			return hostOK(host) && portOK(port)
		}
	}
	return false
}

// validateTargets 校验 targets_raw 里的每一行。所有需要手动指定 Target 的类型都
// 接受字面 IPv4/IPv6 地址或域名（域名的解析地址族由任务的 AddressFamily 控制）；
// tcpping/httpcheck 额外接受 host:port；httpcheck 额外接受完整 http(s):// URL；
// dnscheck 额外接受 domain@server[:port]。
func validateTargets(raw string, types []string) string {
	portTolerant := false
	urlTolerant := false
	dnsServerTolerant := false
	for _, ty := range types {
		if portOptionalTypes[ty] {
			portTolerant = true
		}
		if ty == "httpcheck" {
			urlTolerant = true
		}
		if ty == "dnscheck" {
			dnsServerTolerant = true
		}
	}
	task := models.AgentTask{TargetsRaw: raw}
	for _, target := range task.Targets() {
		if targetLineOK(target, portTolerant, urlTolerant, dnsServerTolerant) {
			continue
		}
		hint := "支持 IPv4/IPv6 地址或域名"
		if portTolerant {
			hint += "，可选 host:port（IPv6 用 [addr]:port）"
		}
		if urlTolerant {
			hint += "，httpcheck 亦支持完整 http(s):// URL"
		}
		if dnsServerTolerant {
			hint += "，dnscheck 亦支持 domain@server[:port]"
		}
		return fmt.Sprintf("无效的 Target 地址: %s（%s）", target, hint)
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
			IntervalSeconds int      `json:"interval_seconds" binding:"required,min=10,max=86400"`
			Scope           string   `json:"scope" binding:"required"`
			GroupID         *uint    `json:"group_id"`
			AgentID         *string  `json:"agent_id"`
			SkipTLSVerify   bool     `json:"skip_tls_verify"`
			AddressFamily   string   `json:"address_family"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error(), "code": "bad_request"})
			return
		}
		if req.AddressFamily == "" {
			req.AddressFamily = "auto"
		}
		if !validAddressFamilies[req.AddressFamily] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的地址族，可选: auto / v4 / v6 / both", "code": "agent.invalid_address_family"})
			return
		}
		needsTargetValidation := false
		for _, ty := range req.Types {
			if !validTaskTypes[ty] {
				c.JSON(http.StatusBadRequest, gin.H{"error": "不支持的任务类型: " + ty, "code": "agent.invalid_task_type"})
				return
			}
			if !meshAutoTypes[ty] {
				needsTargetValidation = true
			}
		}
		if msg := validateTaskScope(req.Scope, req.GroupID, req.AgentID); msg != "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "agent.invalid_scope"})
			return
		}
		// meshping/meshmtr 的 Target 由 Server 动态解析，忽略用户填写的内容；其余类型必须是
		// 合法的 IPv4/IPv6 地址。多选类型时只要有一个需要手动指定 Target 的类型就触发校验。
		if needsTargetValidation {
			if msg := validateTargets(req.TargetsRaw, req.Types); msg != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "agent.invalid_target"})
				return
			}
		}

		created := make([]models.AgentTask, 0, len(req.Types))
		for _, ty := range req.Types {
			task := models.AgentTask{
				Name: req.Name, Type: ty, TargetsRaw: req.TargetsRaw,
				IntervalSeconds: req.IntervalSeconds, Scope: req.Scope,
				GroupID: req.GroupID, AgentID: req.AgentID, Enabled: true,
				SkipTLSVerify: req.SkipTLSVerify, AddressFamily: req.AddressFamily,
			}
			if err := db.Create(&task).Error; err != nil {
				dbErr(c, "创建", err)
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
			IntervalSeconds int     `json:"interval_seconds" binding:"required,min=10,max=86400"`
			Scope           string  `json:"scope" binding:"required"`
			GroupID         *uint   `json:"group_id"`
			AgentID         *string `json:"agent_id"`
			Enabled         bool    `json:"enabled"`
			SkipTLSVerify   bool    `json:"skip_tls_verify"`
			AddressFamily   string  `json:"address_family"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error(), "code": "bad_request"})
			return
		}
		if req.AddressFamily == "" {
			req.AddressFamily = "auto"
		}
		if !validAddressFamilies[req.AddressFamily] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的地址族，可选: auto / v4 / v6 / both", "code": "agent.invalid_address_family"})
			return
		}
		if !validTaskTypes[req.Type] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "不支持的任务类型: " + req.Type, "code": "agent.invalid_task_type"})
			return
		}
		if msg := validateTaskScope(req.Scope, req.GroupID, req.AgentID); msg != "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "agent.invalid_scope"})
			return
		}
		if !meshAutoTypes[req.Type] {
			if msg := validateTargets(req.TargetsRaw, []string{req.Type}); msg != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "agent.invalid_target"})
				return
			}
		}

		var task models.AgentTask
		if err := db.First(&task, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "任务不存在", "code": "not_found"})
			return
		}
		if err := db.Model(&task).Updates(map[string]interface{}{
			"name": req.Name, "type": req.Type, "targets_raw": req.TargetsRaw,
			"interval_seconds": req.IntervalSeconds, "scope": req.Scope,
			"group_id": req.GroupID, "agent_id": req.AgentID, "enabled": req.Enabled,
			"skip_tls_verify": req.SkipTLSVerify, "address_family": req.AddressFamily,
		}).Error; err != nil {
			dbErr(c, "更新", err)
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
			dbErr(c, "删除", err)
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
		q.Preload("PresetGroup").Order("id desc").
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
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error(), "code": "bad_request"})
			return
		}
		if req.PresetGroupID != nil {
			if err := db.First(&models.AgentGroup{}, *req.PresetGroupID).Error; err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "指定的 Group 不存在", "code": "not_found"})
				return
			}
		}
		raw, hashed, err := generateRefreshToken()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "生成失败", "code": "server_error"})
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
			dbErr(c, "创建", err)
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
			c.JSON(http.StatusNotFound, gin.H{"error": "Token 不存在", "code": "not_found"})
			return
		}
		if token.Status != "unused" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "仅可作废未使用的 Token", "code": "agent.token_not_unused"})
			return
		}
		db.Model(&token).Update("status", "revoked")
		writeAgentAudit(db, getUsername(c), "revoke_token", "agent_token", strconv.Itoa(int(id)),
			"Revoked unused provisioning token")
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// ── CA 状态/轮换（Token Tab 顶部的三阶段平滑 CA 管理面板）─────────────────────

func hasCAFP(csv, target string) bool {
	if csv == "" || target == "" {
		return false
	}
	for _, p := range strings.Split(csv, ",") {
		if strings.TrimSpace(p) == target {
			return true
		}
	}
	return false
}

func GetCAStatus(db *gorm.DB, pki *core.PKI) gin.HandlerFunc {
	return func(c *gin.Context) {
		st := pki.Status()
		if db != nil {
			var onlineAgents []models.Agent
			db.Select("agent_id", "trusted_ca_fp", "cert_issuer_fp").
				Where("revoked = ? AND status = ?", false, "online").
				Find(&onlineAgents)
			st.OnlineAgents = int64(len(onlineAgents))
			for _, a := range onlineAgents {
				if st.NextCAFP != "" && hasCAFP(a.TrustedCAFP, st.NextCAFP) {
					st.NextCATrustedAgents++
				}
				if st.ActiveCAFP != "" && a.CertIssuerFP == st.ActiveCAFP {
					st.ActiveCAIssuedAgents++
				}
			}
		}
		c.JSON(http.StatusOK, st)
	}
}

// PrepareCA POST /api/v1/agents/ca/prepare —— 阶段一：预生成下一代 Root CA 并通过
// /agent-sync/tasks 预分发给所有在线 Agent 热更新信任锚，无需重启进程、不中断现有握手。
func PrepareCA(db *gorm.DB, pki *core.PKI, caDays int) gin.HandlerFunc {
	return func(c *gin.Context) {
		if err := pki.Prepare(caDays); err != nil {
			if _, ok := err.(*core.CodedError); ok {
				c.JSON(http.StatusBadRequest, codedErrJSON(err))
				return
			}
			internalErr(c, http.StatusInternalServerError, "预生成下一代 CA 失败", err)
			return
		}
		writeAgentAudit(db, getUsername(c), "prepare_ca", "ca", "",
			"Prepared next Root CA for pre-distribution to online agents")
		c.JSON(http.StatusOK, gin.H{
			"message": "已生成下一代 Root CA 并开始预分发，待在线 Agent 同步就绪后即可执行「激活新 CA」",
		})
	}
}

// RotateCA POST /api/v1/agents/ca/rotate —— 阶段二：将已预分发的下一代 Root CA 提升为活跃 CA
// （默认要求已先执行 PrepareCA，除非显式传 ?force=true 执行紧急直接轮换）。需重启 NMS 服务生效。
func RotateCA(db *gorm.DB, pki *core.PKI, caDays int) gin.HandlerFunc {
	return func(c *gin.Context) {
		force := c.Query("force") == "true"
		var err error
		if force && !pki.HasPreparedNext() {
			err = pki.Rotate(caDays)
		} else {
			err = pki.Promote()
		}
		if err != nil {
			if _, ok := err.(*core.CodedError); ok {
				c.JSON(http.StatusBadRequest, codedErrJSON(err))
				return
			}
			internalErr(c, http.StatusInternalServerError, "轮换失败", err)
			return
		}
		writeAgentAudit(db, getUsername(c), "rotate_ca", "ca", "",
			"Activated new Root CA; restart required to take effect")
		c.JSON(http.StatusOK, gin.H{
			"message": "已切换至新 Root CA，请重启 NMS 服务生效；旧 CA 在终结轮换前仍被信任，重启后在线 Agent 将自动续期客户端证书",
		})
	}
}

// FinalizeCA POST /api/v1/agents/ca/finalize —— 结束轮换过渡期，不再信任旧 CA。
// 仅落盘生效，需要重启 NMS 进程。
func FinalizeCA(db *gorm.DB, pki *core.PKI) gin.HandlerFunc {
	return func(c *gin.Context) {
		if err := pki.Finalize(); err != nil {
			// "无待终结的轮换" 由 core 层以 CodedError 携带 agent.ca_no_pending 返回
			if _, ok := err.(*core.CodedError); ok {
				c.JSON(http.StatusBadRequest, codedErrJSON(err))
				return
			}
			internalErr(c, http.StatusInternalServerError, "终结轮换失败", err)
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

// ── AgentRelease 管理（版本更新）──────────────────────────────────────────────

func ListAgentReleases(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var releases []models.AgentRelease
		db.Order("id desc").Find(&releases)
		c.JSON(http.StatusOK, releases)
	}
}

// maxAgentReleaseSize 单个 Agent 二进制上传体积上限（256 MiB）。
const maxAgentReleaseSize = 256 << 20

// CreateAgentRelease POST /api/v1/agent-releases（multipart/form-data）
// 字段：version, os, arch, notes（文本） + file（二进制文件）。
// 服务端流式写盘、同时计算 SHA256，不在内存中缓存整个文件。
func CreateAgentRelease(db *gorm.DB, releaseDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		extendTransferDeadlines(c, 10*time.Minute)
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAgentReleaseSize+(4<<20))

		version := strings.TrimSpace(c.PostForm("version"))
		osName := strings.TrimSpace(c.PostForm("os"))
		arch := strings.TrimSpace(c.PostForm("arch"))
		notes := strings.TrimSpace(c.PostForm("notes"))
		if version == "" || osName == "" || arch == "" {
			if isMaxBytesErr(c.Request.Context().Err()) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "二进制文件过大（上限 256 MiB）", "code": "agent.release_too_large"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "version / os / arch 不能为空", "code": "bad_request"})
			return
		}

		fh, err := c.FormFile("file")
		if err != nil {
			if isMaxBytesErr(err) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "二进制文件过大（上限 256 MiB）", "code": "agent.release_too_large"})
				return
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": "缺少二进制文件（字段名 file）", "code": "agent.release_file_missing"})
			return
		}
		if fh.Size > maxAgentReleaseSize {
			c.JSON(http.StatusBadRequest, gin.H{"error": "二进制文件过大（上限 256 MiB）", "code": "agent.release_too_large"})
			return
		}
		src, err := fh.Open()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "无法读取上传文件", "code": "server_error"})
			return
		}
		defer src.Close()

		// 临时文件与最终文件在同一目录，保证 rename 是同分区原子操作
		tmp, err := os.CreateTemp(releaseDir, "upload-*")
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "创建临时文件失败", "code": "server_error"})
			return
		}
		tmpPath := tmp.Name()
		cleanTmp := true
		defer func() {
			if cleanTmp {
				tmp.Close()
				os.Remove(tmpPath)
			}
		}()

		// 流式写盘 + 同步计算 SHA256
		h := sha256.New()
		written, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(src, maxAgentReleaseSize+1))
		tmp.Close()
		if err != nil {
			if isMaxBytesErr(err) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "二进制文件过大（上限 256 MiB）", "code": "agent.release_too_large"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "写入文件失败", "code": "server_error"})
			return
		}
		if written > maxAgentReleaseSize {
			c.JSON(http.StatusBadRequest, gin.H{"error": "二进制文件过大（上限 256 MiB）", "code": "agent.release_too_large"})
			return
		}
		checksum := hex.EncodeToString(h.Sum(nil))

		// 先建 DB 记录取 ID，再以 ID 为文件名落盘
		rel := models.AgentRelease{
			Version: version, OS: osName, Arch: arch,
			SHA256: checksum, FileSize: written,
			Notes: notes, CreatedBy: getUsername(c),
		}
		if err := db.Create(&rel).Error; err != nil {
			dbErr(c, "创建记录", err)
			return
		}

		finalPath := filepath.Join(releaseDir, strconv.FormatUint(uint64(rel.ID), 10))
		if err := os.Rename(tmpPath, finalPath); err != nil {
			db.Delete(&rel)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "保存文件失败", "code": "server_error"})
			return
		}
		cleanTmp = false           // rename 成功，不再清理（已不是 tmpPath）
		os.Chmod(finalPath, 0o755) // 保证文件可执行

		db.Model(&rel).Updates(map[string]interface{}{"file_path": finalPath})
		rel.FilePath = finalPath

		writeAgentAudit(db, getUsername(c), "create_release", "agent_releases", strconv.Itoa(int(rel.ID)),
			fmt.Sprintf("Uploaded release %s (%s/%s) size=%d sha256=%s", rel.Version, rel.OS, rel.Arch, written, checksum))
		c.JSON(http.StatusOK, rel)
	}
}

func DeleteAgentRelease(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var rel models.AgentRelease
		if err := db.First(&rel, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "Release 不存在", "code": "not_found"})
			return
		}
		if err := db.Delete(&rel).Error; err != nil {
			dbErr(c, "删除", err)
			return
		}
		if rel.FilePath != "" {
			_ = os.Remove(rel.FilePath) // 忽略文件不存在等错误
		}
		writeAgentAudit(db, getUsername(c), "delete_release", "agent_releases", strconv.Itoa(int(id)),
			fmt.Sprintf("Deleted release %s (%s/%s)", rel.Version, rel.OS, rel.Arch))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}

// SetAgentReleaseActive POST /api/v1/agent-releases/:id/set-active
// {"active":true} 激活时自动把同 OS+Arch 的其他记录设为 inactive，保证同类型只有一个激活版本。
func SetAgentReleaseActive(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var req struct {
			Active bool `json:"active"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error(), "code": "bad_request"})
			return
		}
		var rel models.AgentRelease
		if err := db.First(&rel, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "Release 不存在", "code": "not_found"})
			return
		}
		if req.Active {
			db.Model(&models.AgentRelease{}).
				Where("os = ? AND arch = ? AND id <> ?", rel.OS, rel.Arch, id).
				Update("active", false)
		}
		if err := db.Model(&rel).Update("active", req.Active).Error; err != nil {
			dbErr(c, "更新", err)
			return
		}
		rel.Active = req.Active
		writeAgentAudit(db, getUsername(c), "set_release_active", "agent_releases", strconv.Itoa(int(id)),
			fmt.Sprintf("Set release %s (%s/%s) active=%v", rel.Version, rel.OS, rel.Arch, req.Active))
		c.JSON(http.StatusOK, rel)
	}
}

// agentProgressItem 是 GetAgentReleaseProgress 的单条 Agent 记录。
type agentProgressItem struct {
	AgentID        string     `json:"agent_id"`
	Hostname       string     `json:"hostname"`
	CurrentVersion string     `json:"current_version"`
	Updated        bool       `json:"updated"`
	Status         string     `json:"status"`
	LastSeenAt     *time.Time `json:"last_seen_at"`
}

// GetAgentReleaseProgress GET /api/v1/agent-releases/:id/progress
// 返回与该 Release OS/Arch 匹配的所有 Agent 及其版本状态，供前端轮询展示更新进度。
func GetAgentReleaseProgress(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var rel models.AgentRelease
		if err := db.First(&rel, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "Release 不存在", "code": "not_found"})
			return
		}

		var agents []models.Agent
		db.Where("os = ? AND arch = ? AND revoked = ?", rel.OS, rel.Arch, false).Find(&agents)

		items := make([]agentProgressItem, 0, len(agents))
		updatedCount := 0
		for _, a := range agents {
			updated := a.Version == rel.Version
			if updated {
				updatedCount++
			}
			items = append(items, agentProgressItem{
				AgentID:        a.AgentID,
				Hostname:       a.Hostname,
				CurrentVersion: a.Version,
				Updated:        updated,
				Status:         a.Status,
				LastSeenAt:     a.LastSeenAt,
			})
		}

		c.JSON(http.StatusOK, gin.H{
			"release_version": rel.Version,
			"os":              rel.OS,
			"arch":            rel.Arch,
			"total":           len(items),
			"updated_count":   updatedCount,
			"agents":          items,
		})
	}
}

// ── Agent Audit Log ────────────────────────────────────────────────────────

func ListAgentAuditLogs(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
		pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "20"))
		if page < 1 {
			page = 1
		}
		if pageSize < 1 || pageSize > 100 {
			pageSize = 20
		}
		query := db.Model(&models.AgentAuditLog{}).Order("created_at desc")
		if u := c.Query("username"); u != "" {
			query = query.Where("username LIKE ?", "%"+u+"%")
		}
		if a := c.Query("action"); a != "" {
			query = query.Where("action = ?", a)
		}
		if rt := c.Query("resource_type"); rt != "" {
			query = query.Where("resource_type = ?", rt)
		}
		var total int64
		query.Count(&total)
		var logs []models.AgentAuditLog
		query.Offset((page - 1) * pageSize).Limit(pageSize).Find(&logs)
		c.JSON(http.StatusOK, gin.H{"total": total, "items": logs, "page": page, "page_size": pageSize})
	}
}

func PurgeAgentAuditLogs(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		daysStr := c.Query("days")
		days, err := strconv.Atoi(daysStr)
		if err != nil || days < 1 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的天数参数（最小 1 天）", "code": "bad_request"})
			return
		}
		cutoff := time.Now().AddDate(0, 0, -days)
		result := db.Where("created_at < ?", cutoff).Delete(&models.AgentAuditLog{})
		writeAgentAudit(db, getUsername(c), "purge_audit", "audit_log", "",
			fmt.Sprintf("Purged agent audit logs older than %d days (%d rows)", days, result.RowsAffected))
		c.JSON(http.StatusOK, gin.H{"deleted": result.RowsAffected})
	}
}

// ── Route Registration ─────────────────────────────────────────────────────

// RegisterAgentAdminRoutes 注册不依赖 PKI 的 Agent 管理路由（agents/groups/tasks/tokens/releases），
// 无论 agent_pki.enabled 是否开启都应调用。releaseDir 为 Agent 二进制文件存储目录。
func RegisterAgentAdminRoutes(r *gin.Engine, db *gorm.DB, authMW gin.HandlerFunc, releaseDir string) {
	// 轻量级全量探针元数据（不含 IP/证书敏感字段），登录即可读，无 200 条分页截断
	r.GET("/api/v1/agents-lite", authMW, ListDeviceAgentsLite(db))

	agents := r.Group("/api/v1/agents")
	agents.Use(authMW, middleware.AdminRequired)
	{
		agents.GET("", ListAgents(db))
		agents.GET("/summary", GetAgentSummary(db))
		agents.GET("/filter-options", GetAgentFilterOptions(db))
		agents.GET("/audit-logs", ListAgentAuditLogs(db))
		agents.DELETE("/audit-logs", PurgeAgentAuditLogs(db))
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

	releases := r.Group("/api/v1/agent-releases")
	releases.Use(authMW, middleware.AdminRequired)
	{
		releases.GET("", ListAgentReleases(db))
		releases.GET("/:id/progress", GetAgentReleaseProgress(db))
		releases.POST("", CreateAgentRelease(db, releaseDir))
		releases.DELETE("/:id", DeleteAgentRelease(db))
		releases.POST("/:id/set-active", SetAgentReleaseActive(db))
	}
}

// RegisterAgentPKIRoutes 注册依赖 PKI 的 CA 管理路由（ca-cert/ca/status/prepare/rotate/finalize），
// 仅在 agent_pki.enabled=true 且 PKI 初始化成功时调用。
func RegisterAgentPKIRoutes(r *gin.Engine, db *gorm.DB, pki *core.PKI, caDays int, authMW gin.HandlerFunc) {
	agents := r.Group("/api/v1/agents")
	agents.Use(authMW, middleware.AdminRequired)
	{
		// 浏览器走主站 HTTPS/HTTP，无法直接信任 enroll 端口上自签发的内置 CA 证书，
		// 故在主引擎上镜像一份 GetCACert，方便 Token Tab 展示/下载 CA 公钥。
		agents.GET("/ca-cert", GetCACert(pki))
		agents.GET("/ca/status", GetCAStatus(db, pki))
		agents.POST("/ca/prepare", PrepareCA(db, pki, caDays))
		agents.POST("/ca/rotate", RotateCA(db, pki, caDays))
		agents.POST("/ca/finalize", FinalizeCA(db, pki))
	}
}
