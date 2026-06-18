package controllers

import (
	"crypto/rand"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"sync"
	"time"

	"nms-backend/core"
	"nms-backend/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// AgentPKIConfig 注册引导相关配置。
type AgentPKIConfig struct {
	ClientCertDays int // 签发给 Agent 的客户端证书有效期（天）—— 规范要求 1 年 (365)
	SyncPort       int // 注册成功后告知 Agent 应连接的 mTLS 端口
}

var errTokenInvalid = errors.New("provisioning token 无效、已被使用或已过期")

// generateAgentID 分配一个全局唯一的 AgentID（如 AGT-3F2A9B7C）。
// 碰撞概率极低（4 字节随机），重试 5 次兜底。
func generateAgentID(db *gorm.DB) (string, error) {
	for i := 0; i < 5; i++ {
		b := make([]byte, 4)
		if _, err := rand.Read(b); err != nil {
			return "", err
		}
		id := fmt.Sprintf("AGT-%X", b)
		var count int64
		db.Model(&models.Agent{}).Where("agent_id = ?", id).Count(&count)
		if count == 0 {
			return id, nil
		}
	}
	return "", fmt.Errorf("分配 AgentID 失败，请重试")
}

// ── enroll 防爆破 ────────────────────────────────────────────────────────────
// 同款滑动窗口计数 + 临时锁定（参见 login_protection.go 的 loginTracker），按来源 IP
// 计数——enroll 请求没有"用户名"概念，token 本身就是被猜测的对象。
// 阈值固定（非 System 界面可调）：这是兜底防护，不是需要暴露给管理员调整的业务策略。
const (
	enrollMaxAttempts    = 10
	enrollWindowMinutes  = 10
	enrollLockoutMinutes = 15
)

type enrollRecord struct {
	failures    []time.Time
	lockedUntil time.Time
}

type enrollTracker struct {
	mu      sync.Mutex
	records map[string]*enrollRecord
}

var enrollGuard = newEnrollTracker()

func newEnrollTracker() *enrollTracker {
	t := &enrollTracker{records: make(map[string]*enrollRecord)}
	go func() {
		for range time.Tick(30 * time.Minute) {
			t.sweep()
		}
	}()
	return t
}

func (t *enrollTracker) check(ip string) (locked bool, until time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	rec, ok := t.records[ip]
	if !ok {
		return false, time.Time{}
	}
	if time.Now().Before(rec.lockedUntil) {
		return true, rec.lockedUntil
	}
	return false, time.Time{}
}

func (t *enrollTracker) fail(ip string) {
	now := time.Now()
	windowStart := now.Add(-time.Duration(enrollWindowMinutes) * time.Minute)

	t.mu.Lock()
	defer t.mu.Unlock()
	rec, ok := t.records[ip]
	if !ok {
		rec = &enrollRecord{}
		t.records[ip] = rec
	}
	kept := rec.failures[:0]
	for _, f := range rec.failures {
		if f.After(windowStart) {
			kept = append(kept, f)
		}
	}
	rec.failures = append(kept, now)
	if len(rec.failures) >= enrollMaxAttempts {
		rec.lockedUntil = now.Add(time.Duration(enrollLockoutMinutes) * time.Minute)
		rec.failures = nil
	}
}

func (t *enrollTracker) success(ip string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.records, ip)
}

func (t *enrollTracker) sweep() {
	cutoff := time.Now().Add(-time.Hour)
	t.mu.Lock()
	defer t.mu.Unlock()
	for ip, rec := range t.records {
		if time.Now().After(rec.lockedUntil) &&
			(len(rec.failures) == 0 || rec.failures[len(rec.failures)-1].Before(cutoff)) {
			delete(t.records, ip)
		}
	}
}

// EnrollAgent POST /api/v1/agents/enroll （单向 HTTPS，无需客户端证书）。
// 验证一次性 provisioning_token，通过后分配 AgentID 并使用内置 Root CA 签发客户端证书。
//
// Token 的校验与"标记已用"在同一条带条件的 UPDATE 语句里完成（WHERE status='unused'
// AND expires_at>now，检查 RowsAffected），而不是先 SELECT 读取再 UPDATE——
// 否则两个并发请求可能都通过只读校验、各自签发证书，让一个一次性注册码注册出两个
// Agent。InnoDB 的 UPDATE 对其扫描到的行使用当前读（而非可重复读快照）并加锁，
// 第二个并发请求的 UPDATE 会等待第一个提交后才重新评估 WHERE 条件，从而正确地把
// RowsAffected 算成 0。
func EnrollAgent(db *gorm.DB, pki *core.PKI, cfg AgentPKIConfig) gin.HandlerFunc {
	return func(c *gin.Context) {
		clientIP := c.ClientIP()
		if locked, until := enrollGuard.check(clientIP); locked {
			mins := int(time.Until(until).Minutes()) + 1
			c.JSON(http.StatusTooManyRequests, gin.H{"error": fmt.Sprintf("注册请求过于频繁，请 %d 分钟后重试", mins)})
			return
		}

		var req struct {
			ProvisioningToken string `json:"provisioning_token" binding:"required"`
			Hostname          string `json:"hostname" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误: " + err.Error()})
			return
		}

		agentID, err := generateAgentID(db)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		var issued *core.IssuedClientCert
		txErr := db.Transaction(func(tx *gorm.DB) error {
			tokenHash := hashToken(req.ProvisioningToken)
			result := tx.Model(&models.AgentToken{}).
				Where("token_hash = ? AND status = ? AND expires_at > ?", tokenHash, "unused", time.Now()).
				Updates(map[string]interface{}{
					"status": "used", "used_by_agent_id": agentID, "used_at": time.Now(),
				})
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected == 0 {
				return errTokenInvalid
			}

			// 此刻该 token 已被我们在本事务内独占（上面的条件 UPDATE 是唯一的真相来源），
			// 安全读取其 PresetGroupID。
			var token models.AgentToken
			tx.Where("token_hash = ?", tokenHash).First(&token)

			var err error
			issued, err = pki.IssueClientCert(agentID, cfg.ClientCertDays)
			if err != nil {
				return err
			}

			agent := models.Agent{
				AgentID:      agentID,
				Hostname:     req.Hostname,
				GroupID:      token.PresetGroupID,
				ConnectionIP: clientIP,
				Status:       "offline", // 等待首次 mTLS 调用 agent-sync 才会被标记为 online
				RegisteredAt: time.Now(),
				CertExpiry:   issued.Expiry,
				CertSerial:   issued.Serial,
			}
			if addr, err := netip.ParseAddr(clientIP); err == nil {
				if addr.Is4() {
					agent.ConnectionIPv4 = clientIP
				} else {
					agent.ConnectionIPv6 = clientIP
				}
			}
			return tx.Create(&agent).Error
		})

		if txErr != nil {
			enrollGuard.fail(clientIP)
			if errors.Is(txErr, errTokenInvalid) {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "注册码无效、已被使用或已过期"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "注册失败: " + txErr.Error()})
			return
		}
		enrollGuard.success(clientIP)

		c.JSON(http.StatusOK, gin.H{
			"agent_id":    agentID,
			"cert_pem":    string(issued.CertPEM),
			"key_pem":     string(issued.KeyPEM),
			"ca_cert_pem": string(pki.CACertPEM()),
			"cert_expiry": issued.Expiry,
			"sync_port":   cfg.SyncPort,
		})
	}
}

// GetCACert GET /api/v1/agents/ca-cert （公开端点，单向 HTTPS，无需认证）。
// 供 Agent / 管理员预先获取 Root CA 公钥证书，用于首次引导建立信任链。
func GetCACert(pki *core.PKI) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Data(http.StatusOK, "application/x-pem-file", pki.CACertPEM())
	}
}

// RegisterAgentEnrollRoutes 挂载到独立的 enroll TLS 引擎（tls.NoClientCert，单向 HTTPS）。
func RegisterAgentEnrollRoutes(r *gin.Engine, db *gorm.DB, pki *core.PKI, cfg AgentPKIConfig) {
	r.POST("/api/v1/agents/enroll", EnrollAgent(db, pki, cfg))
	r.GET("/api/v1/agents/ca-cert", GetCACert(pki))
}
