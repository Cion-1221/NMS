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

		// 心跳：mTLS 双向校验通过即视为存活，顺手刷新连接 IP/状态/版本号。
		// IP 来源优先级：
		//   1. Agent 主动上报的 X-Agent-IPv4 / X-Agent-IPv6 header（双栈可同时写入两个字段）
		//   2. Fallback：TCP 连接来源 IP（c.ClientIP()），只能记录本次握手所用的协议
		// connection_ip 始终记录 TCP 来源 IP，供旧字段兼容。
		now := time.Now()
		ip := c.ClientIP()
		updates := map[string]interface{}{
			"connection_ip": ip,
			"last_seen_at":  now,
			"status":        "online",
		}

		hv4 := c.GetHeader("X-Agent-IPv4")
		hv6 := c.GetHeader("X-Agent-IPv6")
		if hv4 != "" || hv6 != "" {
			// Agent 主动上报：校验地址族后分别写入
			if hv4 != "" {
				if addr, err := netip.ParseAddr(hv4); err == nil && addr.Is4() && !addr.IsLoopback() && !addr.IsUnspecified() {
					updates["connection_ipv4"] = hv4
					agent.ConnectionIPv4 = hv4
				}
			}
			if hv6 != "" {
				if addr, err := netip.ParseAddr(hv6); err == nil && !addr.Is4() && !addr.IsLoopback() && !addr.IsUnspecified() {
					updates["connection_ipv6"] = hv6
					agent.ConnectionIPv6 = hv6
				}
			}
		} else {
			// Fallback：从 TCP 连接来源 IP 推断协议版本
			if addr, err := netip.ParseAddr(ip); err == nil {
				if addr.Is4() {
					updates["connection_ipv4"] = ip
					agent.ConnectionIPv4 = ip
				} else {
					updates["connection_ipv6"] = ip
					agent.ConnectionIPv6 = ip
				}
			}
		}

		if v := c.GetHeader("X-Agent-Version"); v != "" {
			updates["version"] = v
			agent.Version = v
		}
		if v := c.GetHeader("X-Agent-OS"); v != "" {
			updates["os"] = v
			agent.OS = v
		}
		if v := c.GetHeader("X-Agent-Arch"); v != "" {
			updates["arch"] = v
			agent.Arch = v
		}
		db.Model(&agent).Updates(updates)
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
