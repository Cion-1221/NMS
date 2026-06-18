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

		// 心跳：mTLS 双向校验通过即视为存活，顺手刷新连接 IP/状态/版本号，
		// 无需 Agent 端额外实现心跳接口。版本号是 Agent 自报的软件版本（可选头），
		// 用于在 Agent List 里识别哪些 Agent 还跑着旧版本。
		now := time.Now()
		ip := c.ClientIP()
		updates := map[string]interface{}{
			"connection_ip": ip,
			"last_seen_at":  now,
			"status":        "online",
		}
		if addr, err := netip.ParseAddr(ip); err == nil {
			if addr.Is4() {
				updates["connection_ipv4"] = ip
				agent.ConnectionIPv4 = ip
			} else {
				updates["connection_ipv6"] = ip
				agent.ConnectionIPv6 = ip
			}
		}
		if v := c.GetHeader("X-Agent-Version"); v != "" {
			updates["version"] = v
			agent.Version = v
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
