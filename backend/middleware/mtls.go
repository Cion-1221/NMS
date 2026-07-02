package middleware

import (
	"net/http"
	"net/netip"
	"time"

	"nms-backend/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// CtxAgentKey 在 gin.Context 中存储已认证 Agent 记录的 key（mTLS 校验通过后写入）。
const CtxAgentKey = "agent_claims"

// heartbeatWriteInterval 心跳写节流间隔：距上次 last_seen_at 落库不足该间隔、且本次
// 请求没有任何字段变化时跳过 UPDATE。DB 中 last_seen_at 最多滞后该间隔，远小于
// agent_sync_api.go 的 onlineThreshold（5 分钟），不影响离线判定与 MeshPing 目标解析。
const heartbeatWriteInterval = 30 * time.Second

// AgentMTLS 校验 mTLS 客户端证书并解析出调用方 AgentID。
// 证书链信任已由监听器的 tls.RequireAndVerifyClientCert + ClientCAs=Root CA 在 TLS
// 握手阶段完成校验；这里只需取出 PeerCertificates[0]，按其 CommonName（=AgentID）
// 查找 Agent 记录，并检查吊销状态/证书序列号是否与登记时一致——标准库的证书链校验
// 不检查吊销列表，吊销必须在应用层兜底。
func AgentMTLS(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.TLS == nil || len(c.Request.TLS.PeerCertificates) == 0 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "缺少客户端证书"})
			return
		}
		cert := c.Request.TLS.PeerCertificates[0]
		agentID := cert.Subject.CommonName

		var agent models.Agent
		if err := db.Where("agent_id = ?", agentID).First(&agent).Error; err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "未知 Agent"})
			return
		}
		if agent.Revoked {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "证书已作废"})
			return
		}
		if cert.SerialNumber.String() != agent.CertSerial {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "证书序列号不匹配，请重新注册"})
			return
		}

		// 心跳：mTLS 双向校验通过即视为存活。写库做了节流——只有字段实际变化、
		// 或距上次 last_seen_at 落库超过 heartbeatWriteInterval 时才 UPDATE，
		// 避免 Agent 短周期同步时每个请求都写一次 agents 表（心跳写放大）。
		// IP 来源优先级：
		//   1. Agent 主动上报的 X-Agent-IPv4 / X-Agent-IPv6 header（双栈可同时写入两个字段）
		//   2. Fallback：TCP 连接来源 IP（c.ClientIP()），只能记录本次握手所用的协议
		// connection_ip 始终记录 TCP 来源 IP，供旧字段兼容。
		now := time.Now()
		ip := c.ClientIP()
		updates := map[string]interface{}{}
		if agent.ConnectionIP != ip {
			updates["connection_ip"] = ip
		}
		if agent.Status != "online" {
			updates["status"] = "online"
		}

		// setIfChanged：值非空且与当前记录不同才纳入 UPDATE（同时刷新内存副本）
		setIfChanged := func(col string, field *string, val string) {
			if val != "" && *field != val {
				updates[col] = val
				*field = val
			}
		}

		hv4 := c.GetHeader("X-Agent-IPv4")
		hv6 := c.GetHeader("X-Agent-IPv6")
		if hv4 != "" || hv6 != "" {
			// Agent 主动上报：校验地址族后分别写入
			if hv4 != "" {
				if addr, err := netip.ParseAddr(hv4); err == nil && addr.Is4() && !addr.IsLoopback() && !addr.IsUnspecified() {
					setIfChanged("connection_ipv4", &agent.ConnectionIPv4, hv4)
				}
			}
			if hv6 != "" {
				if addr, err := netip.ParseAddr(hv6); err == nil && !addr.Is4() && !addr.IsLoopback() && !addr.IsUnspecified() {
					setIfChanged("connection_ipv6", &agent.ConnectionIPv6, hv6)
				}
			}
		} else {
			// Fallback：从 TCP 连接来源 IP 推断协议版本
			if addr, err := netip.ParseAddr(ip); err == nil {
				if addr.Is4() {
					setIfChanged("connection_ipv4", &agent.ConnectionIPv4, ip)
				} else {
					setIfChanged("connection_ipv6", &agent.ConnectionIPv6, ip)
				}
			}
		}

		setIfChanged("version", &agent.Version, c.GetHeader("X-Agent-Version"))
		setIfChanged("os", &agent.OS, c.GetHeader("X-Agent-OS"))
		setIfChanged("arch", &agent.Arch, c.GetHeader("X-Agent-Arch"))

		if len(updates) > 0 || agent.LastSeenAt == nil ||
			now.Sub(*agent.LastSeenAt) >= heartbeatWriteInterval {
			updates["last_seen_at"] = now
			db.Model(&agent).Updates(updates)
		}
		agent.ConnectionIP = ip
		agent.LastSeenAt = &now
		agent.Status = "online"

		c.Set(CtxAgentKey, &agent)
		c.Next()
	}
}

// GetAgent 从 gin.Context 中取出经 AgentMTLS 校验过的 Agent 记录。
func GetAgent(c *gin.Context) *models.Agent {
	raw, exists := c.Get(CtxAgentKey)
	if !exists {
		return nil
	}
	agent, ok := raw.(*models.Agent)
	if !ok {
		return nil
	}
	return agent
}
