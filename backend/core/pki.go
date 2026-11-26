package core

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// PKI 持有 NMS 内置 Root CA，负责签发 mTLS 服务端/客户端证书，并支持三阶段零中断 CA 轮换：
//  1. Prepare（预分发）：生成 ca-next.crt/ca-next.key，保持当前活跃 ca.crt 继续签发服务端证书；
//     同时将 Active CA + Next CA 合并进 CABundlePEM()，通过 GET /agent-sync/tasks 下发给所有
//     在线 Agent 热更新本地 ca.crt，待在线 Agent 同步完成后再进入下一阶段。
//  2. Promote / Rotate（切换激活）：将当前 ca.crt 归档为 ca-previous.crt，把 ca-next.{crt,key}
//     提升为新的 ca.{crt,key}。重启进程后，服务端叶子证书由新 CA 签发（Agent 端已在阶段 1 信任新 CA，
//     零断连），旧客户端证书由信任池中的 ca-previous.crt 兜底，且服务端在 /tasks 中返回 renew_cert=true
//     驱动在线 Agent 在一个同步周期内自动续期为新 CA 签发的客户端证书。
//  3. Finalize（终结轮换）：所有 Agent 完成客户端证书续期后删除 ca-previous.crt，重启后彻底移除旧 CA。
type PKI struct {
	dir string

	caCert *x509.Certificate
	caKey  *ecdsa.PrivateKey
	caPEM  []byte

	// previousCAPEM 非空代表存在一个"轮换中尚未终结"的旧 CA——仍被信任池接纳（用于
	// 验证旧 CA 签发、尚未续期的 Agent 证书），但不再用于签发任何新证书。
	previousCert  *x509.Certificate
	previousCAPEM []byte

	caPool *x509.CertPool

	// mu 保护运行期内 Prepare / Promote / Finalize 更新的预分发状态与重启提示标记，
	// 不触碰正被并发 TLS 握手读取的 caPool / caCert。
	mu              sync.RWMutex
	nextCert        *x509.Certificate
	nextCAPEM       []byte
	promotedCAPEM   []byte // Promote/Rotate 后至进程重启前保留在 CABundlePEM 中，防止重启前丢失新 CA
	restartRequired bool
}

// PKIStatus 供管理界面展示当前 CA 状态（GET /api/v1/agents/ca/status）。
type PKIStatus struct {
	ActiveCAExpiry        time.Time  `json:"active_ca_expiry"`
	ActiveCASerial        string     `json:"active_ca_serial"`
	ActiveCAFP            string     `json:"active_ca_fp"`
	HasPreparedNext       bool       `json:"has_prepared_next"`
	NextCAExpiry          *time.Time `json:"next_ca_expiry,omitempty"`
	NextCAFP              string     `json:"next_ca_fp,omitempty"`
	HasPendingPrevious    bool       `json:"has_pending_previous"`
	PreviousCAExpiry      *time.Time `json:"previous_ca_expiry,omitempty"`
	PreviousCAFP          string     `json:"previous_ca_fp,omitempty"`
	RestartRequired       bool       `json:"restart_required"`
	OnlineAgents          int64      `json:"online_agents"`
	NextCATrustedAgents   int64      `json:"next_ca_trusted_agents"`
	ActiveCAIssuedAgents  int64      `json:"active_ca_issued_agents"`
}

// CertFingerprint 返回证书 DER 的前 8 字节 SHA-256 十六进制指纹（16 字符），
// 与 Agent 侧 internal/cert.CAFingerprints 口径严格一致。
func CertFingerprint(c *x509.Certificate) string {
	if c == nil {
		return ""
	}
	sum := sha256.Sum256(c.Raw)
	return hex.EncodeToString(sum[:8])
}

// LoadOrCreatePKI 从 dir 加载已存在的 Root CA，不存在则生成一份新的
// （ECDSA P-256，有效期 caDays 天）并写入磁盘（私钥 0600 权限）。
// 如果 dir 下存在 ca-previous.crt 或 ca-next.crt，也会一并加载。
func LoadOrCreatePKI(dir string, caDays int) (*PKI, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("创建 PKI 目录失败: %w", err)
	}
	certPath := filepath.Join(dir, "ca.crt")
	keyPath := filepath.Join(dir, "ca.key")

	var p *PKI
	var err error
	if fileExists(certPath) && fileExists(keyPath) {
		p, err = loadPKI(certPath, keyPath)
	} else {
		p, err = createPKI(certPath, keyPath, caDays)
	}
	if err != nil {
		return nil, err
	}
	p.dir = dir

	prevPath := filepath.Join(dir, "ca-previous.crt")
	if fileExists(prevPath) {
		prevPEM, err := os.ReadFile(prevPath)
		if err != nil {
			return nil, fmt.Errorf("读取 ca-previous.crt 失败: %w", err)
		}
		p.previousCAPEM = prevPEM
		if block, _ := pem.Decode(prevPEM); block != nil {
			p.previousCert, _ = x509.ParseCertificate(block.Bytes)
		}
	}

	nextCertPath := filepath.Join(dir, "ca-next.crt")
	nextKeyPath := filepath.Join(dir, "ca-next.key")
	if fileExists(nextCertPath) && fileExists(nextKeyPath) {
		nextPKI, err := loadPKI(nextCertPath, nextKeyPath)
		if err != nil {
			return nil, fmt.Errorf("读取预分发 CA (ca-next) 失败: %w", err)
		}
		p.nextCert = nextPKI.caCert
		p.nextCAPEM = nextPKI.caPEM
	}

	p.rebuildTrustPool()
	return p, nil
}

func (p *PKI) rebuildTrustPool() {
	pool := x509.NewCertPool()
	pool.AddCert(p.caCert)
	if len(p.previousCAPEM) > 0 {
		pool.AppendCertsFromPEM(p.previousCAPEM)
	}
	if len(p.nextCAPEM) > 0 {
		pool.AppendCertsFromPEM(p.nextCAPEM)
	}
	p.caPool = pool
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// writeFileAtomic 在同一目录写入临时文件后重命名，避免异常中断留下半截证书或密钥。
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}
	if _, err := tmp.Write(data); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Chmod(tmpPath, perm); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

// generateCA 生成一份新的自签发 Root CA（不落盘），供 createPKI / Prepare / Rotate 共用。
func generateCA(caDays int) (cert *x509.Certificate, key *ecdsa.PrivateKey, certPEM []byte, err error) {
	key, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("生成 CA 私钥失败: %w", err)
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, nil, nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "NMS Root CA", Organization: []string{"NMS"}},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(0, 0, caDays),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("自签发 Root CA 证书失败: %w", err)
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	cert, err = x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, nil, err
	}
	return cert, key, certPEM, nil
}

func createPKI(certPath, keyPath string, caDays int) (*PKI, error) {
	cert, key, certPEM, err := generateCA(caDays)
	if err != nil {
		return nil, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("序列化 CA 私钥失败: %w", err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	if err := writeFileAtomic(certPath, certPEM, 0644); err != nil {
		return nil, fmt.Errorf("写入 ca.crt 失败: %w", err)
	}
	if err := writeFileAtomic(keyPath, keyPEM, 0600); err != nil {
		return nil, fmt.Errorf("写入 ca.key 失败: %w", err)
	}
	return &PKI{caCert: cert, caKey: key, caPEM: certPEM}, nil
}

func loadPKI(certPath, keyPath string) (*PKI, error) {
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return nil, fmt.Errorf("读取 ca.crt 失败: %w", err)
	}
	keyPEMBytes, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, fmt.Errorf("读取 ca.key 失败: %w", err)
	}
	if _, err := tls.X509KeyPair(certPEM, keyPEMBytes); err != nil {
		return nil, fmt.Errorf("CA 证书与私钥不匹配: %w", err)
	}
	certBlock, _ := pem.Decode(certPEM)
	if certBlock == nil {
		return nil, fmt.Errorf("ca.crt 不是有效的 PEM 文件")
	}
	cert, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return nil, fmt.Errorf("解析 ca.crt 失败: %w", err)
	}
	keyBlock, _ := pem.Decode(keyPEMBytes)
	if keyBlock == nil {
		return nil, fmt.Errorf("ca.key 不是有效的 PEM 文件")
	}
	key, err := x509.ParseECPrivateKey(keyBlock.Bytes)
	if err != nil {
		return nil, fmt.Errorf("解析 ca.key 失败: %w", err)
	}
	return &PKI{caCert: cert, caKey: key, caPEM: certPEM}, nil
}

func randomSerial() (*big.Int, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	return rand.Int(rand.Reader, limit)
}

// CACertPEM 返回当前活跃 Root CA 的公开证书（PEM）。
func (p *PKI) CACertPEM() []byte { return p.caPEM }

// ActiveCAFingerprint 返回当前活跃 Root CA 的 16 位十六进制指纹。
func (p *PKI) ActiveCAFingerprint() string { return CertFingerprint(p.caCert) }

// PreviousCAFingerprint 返回过渡期旧 Root CA 的指纹（若不存在则为空）。
func (p *PKI) PreviousCAFingerprint() string { return CertFingerprint(p.previousCert) }

// IsIssuedByActiveCA 判断客户端叶子证书是否由当前活跃 Root CA 签发。
// 在阶段 2（切换新 CA 并重启后），仍持旧 CA 所签证书的 Agent 会返回 false，
// 服务端据此在 /agent-sync/tasks 下发 renew_cert=true 触发自动平滑续期。
func (p *PKI) IsIssuedByActiveCA(leaf *x509.Certificate) bool {
	if p == nil || p.caCert == nil || leaf == nil {
		return false
	}
	return leaf.CheckSignatureFrom(p.caCert) == nil
}

// ClassifyIssuerFP 识别叶子证书是由当前活跃 CA 还是过渡期旧 CA 签发，返回对应 CA 指纹。
func (p *PKI) ClassifyIssuerFP(leaf *x509.Certificate) string {
	if p == nil || leaf == nil {
		return ""
	}
	if p.caCert != nil && leaf.CheckSignatureFrom(p.caCert) == nil {
		return CertFingerprint(p.caCert)
	}
	if p.previousCert != nil && leaf.CheckSignatureFrom(p.previousCert) == nil {
		return CertFingerprint(p.previousCert)
	}
	return ""
}

// CABundlePEM 返回供 Agent 信任的完整 CA 证书链集合（Active + Next/Promoted + Previous，去重拼接）。
// Prepare 阶段立即在内存生效，无需重启即可通过 /agent-sync/tasks 预分发给在线 Agent。
func (p *PKI) CABundlePEM() []byte {
	p.mu.RLock()
	nextPEM := p.nextCAPEM
	promotedPEM := p.promotedCAPEM
	p.mu.RUnlock()

	var buf bytes.Buffer
	seen := make(map[string]bool, 4)
	appendUnique := func(raw []byte) {
		rest := raw
		for len(rest) > 0 {
			var block *pem.Block
			block, rest = pem.Decode(rest)
			if block == nil {
				break
			}
			if block.Type != "CERTIFICATE" {
				continue
			}
			c, err := x509.ParseCertificate(block.Bytes)
			if err != nil {
				continue
			}
			fp := CertFingerprint(c)
			if seen[fp] {
				continue
			}
			seen[fp] = true
			_ = pem.Encode(&buf, &pem.Block{Type: "CERTIFICATE", Bytes: block.Bytes})
		}
	}

	appendUnique(p.caPEM)
	appendUnique(nextPEM)
	appendUnique(promotedPEM)
	appendUnique(p.previousCAPEM)
	return buf.Bytes()
}

// BundleFingerprints 返回 CABundlePEM() 中所有 CA 的排序指纹串（逗号分隔），用于 enroll/renew 初始化记录。
func (p *PKI) BundleFingerprints() string {
	bundle := p.CABundlePEM()
	var fps []string
	rest := bundle
	for len(rest) > 0 {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		if block.Type != "CERTIFICATE" {
			continue
		}
		if c, err := x509.ParseCertificate(block.Bytes); err == nil {
			fps = append(fps, CertFingerprint(c))
		}
	}
	sort.Strings(fps)
	return strings.Join(fps, ",")
}

// HasPreparedNext 返回是否存在已生成待激活的下一代 CA（ca-next）。
func (p *PKI) HasPreparedNext() bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.nextCert != nil {
		return true
	}
	if p.dir == "" {
		return false
	}
	return fileExists(filepath.Join(p.dir, "ca-next.crt")) && fileExists(filepath.Join(p.dir, "ca-next.key"))
}

// Status 返回当前 CA 状态，供管理界面展示。
func (p *PKI) Status() PKIStatus {
	p.mu.RLock()
	nextCert := p.nextCert
	restartReq := p.restartRequired
	p.mu.RUnlock()

	s := PKIStatus{
		ActiveCAExpiry:  p.caCert.NotAfter,
		ActiveCASerial:  p.caCert.SerialNumber.String(),
		ActiveCAFP:      CertFingerprint(p.caCert),
		RestartRequired: restartReq,
	}
	if nextCert != nil {
		s.HasPreparedNext = true
		exp := nextCert.NotAfter
		s.NextCAExpiry = &exp
		s.NextCAFP = CertFingerprint(nextCert)
	}
	prevExistsOnDisk := p.dir != "" && fileExists(filepath.Join(p.dir, "ca-previous.crt"))
	if len(p.previousCAPEM) > 0 || prevExistsOnDisk {
		if len(p.previousCAPEM) > 0 && p.previousCert != nil {
			s.HasPendingPrevious = prevExistsOnDisk || !restartReq
			exp := p.previousCert.NotAfter
			s.PreviousCAExpiry = &exp
			s.PreviousCAFP = CertFingerprint(p.previousCert)
		} else if prevExistsOnDisk {
			s.HasPendingPrevious = true
			if raw, err := os.ReadFile(filepath.Join(p.dir, "ca-previous.crt")); err == nil {
				if block, _ := pem.Decode(raw); block != nil {
					if prevCert, err := x509.ParseCertificate(block.Bytes); err == nil {
						exp := prevCert.NotAfter
						s.PreviousCAExpiry = &exp
						s.PreviousCAFP = CertFingerprint(prevCert)
					}
				}
			}
		}
	}
	return s
}

// Prepare 阶段一：预生成下一代 Root CA（ca-next.crt / ca-next.key）并立即纳入内存 CABundlePEM()，
// 供所有在线 Agent 通过 /agent-sync/tasks 提前同步信任锚，零重启生效且不影响当前活跃 CA。
func (p *PKI) Prepare(caDays int) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.dir == "" {
		return fmt.Errorf("PKI 未初始化磁盘目录，无法预生成 CA")
	}
	prevPath := filepath.Join(p.dir, "ca-previous.crt")
	if len(p.previousCAPEM) > 0 || fileExists(prevPath) {
		return &CodedError{Code: "agent.ca_pending_finalize", Msg: "存在尚未终结的旧 CA 轮换，请先终结后再发起新一轮预分发"}
	}
	nextCertPath := filepath.Join(p.dir, "ca-next.crt")
	nextKeyPath := filepath.Join(p.dir, "ca-next.key")
	if p.nextCert != nil || fileExists(nextCertPath) {
		return &CodedError{Code: "agent.ca_already_prepared", Msg: "已存在预生成的下一代 CA，请等待 Agent 同步后直接切换"}
	}

	nextCert, nextKey, nextCertPEM, err := generateCA(caDays)
	if err != nil {
		return err
	}
	nextKeyDER, err := x509.MarshalECPrivateKey(nextKey)
	if err != nil {
		return fmt.Errorf("序列化下一代 CA 私钥失败: %w", err)
	}
	nextKeyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: nextKeyDER})

	if err := writeFileAtomic(nextKeyPath, nextKeyPEM, 0600); err != nil {
		return fmt.Errorf("写入 ca-next.key 失败: %w", err)
	}
	if err := writeFileAtomic(nextCertPath, nextCertPEM, 0644); err != nil {
		_ = os.Remove(nextKeyPath)
		return fmt.Errorf("写入 ca-next.crt 失败: %w", err)
	}

	p.nextCert = nextCert
	p.nextCAPEM = nextCertPEM
	return nil
}

// Promote 阶段二：将已预分发的 ca-next.{crt,key} 提升为活跃 ca.{crt,key}，
// 并将当前活跃 CA 公钥保留至 ca-previous.crt。需重启 NMS 进程使新服务端证书与信任池生效。
func (p *PKI) Promote() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.dir == "" {
		return fmt.Errorf("PKI 未初始化磁盘目录，无法执行切换")
	}
	prevPath := filepath.Join(p.dir, "ca-previous.crt")
	if fileExists(prevPath) {
		return &CodedError{Code: "agent.ca_pending_finalize", Msg: "存在尚未终结的旧 CA 轮换，请先终结轮换"}
	}
	nextCertPath := filepath.Join(p.dir, "ca-next.crt")
	nextKeyPath := filepath.Join(p.dir, "ca-next.key")
	if !fileExists(nextCertPath) || !fileExists(nextKeyPath) {
		return &CodedError{Code: "agent.ca_prepare_required", Msg: "请先执行「预分发新 CA」，待在线 Agent 同步信任链后再激活切换"}
	}

	nextPKI, err := loadPKI(nextCertPath, nextKeyPath)
	if err != nil {
		return fmt.Errorf("校验预分发 CA 失败: %w", err)
	}

	certPath := filepath.Join(p.dir, "ca.crt")
	keyPath := filepath.Join(p.dir, "ca.key")
	if err := writeFileAtomic(prevPath, p.caPEM, 0644); err != nil {
		return fmt.Errorf("写入 ca-previous.crt 失败: %w", err)
	}
	if err := os.Rename(nextCertPath, certPath); err != nil {
		_ = os.Remove(prevPath)
		return fmt.Errorf("提升 ca-next.crt 为 ca.crt 失败: %w", err)
	}
	if err := os.Rename(nextKeyPath, keyPath); err != nil {
		return fmt.Errorf("提升 ca-next.key 为 ca.key 失败: %w", err)
	}

	p.promotedCAPEM = nextPKI.caPEM
	p.nextCert = nil
	p.nextCAPEM = nil
	p.restartRequired = true
	return nil
}

// Rotate 激活下一代 Root CA：若已执行 Prepare 则直接 Promote；否则执行紧急直接轮换
// （生成新 CA 覆盖 ca.crt/ca.key，原 CA 写入 ca-previous.crt）。需重启进程生效。
func (p *PKI) Rotate(caDays int) error {
	if p.HasPreparedNext() {
		return p.Promote()
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	if p.dir == "" {
		return fmt.Errorf("PKI 未初始化磁盘目录，无法执行轮换")
	}
	prevPath := filepath.Join(p.dir, "ca-previous.crt")
	if fileExists(prevPath) {
		return &CodedError{Code: "agent.ca_pending_finalize", Msg: "存在尚未终结的旧 CA 轮换，请先终结轮换"}
	}

	_, newKey, newCertPEM, err := generateCA(caDays)
	if err != nil {
		return err
	}
	newKeyDER, err := x509.MarshalECPrivateKey(newKey)
	if err != nil {
		return fmt.Errorf("序列化新 CA 私钥失败: %w", err)
	}
	newKeyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: newKeyDER})

	certPath := filepath.Join(p.dir, "ca.crt")
	keyPath := filepath.Join(p.dir, "ca.key")

	if err := writeFileAtomic(prevPath, p.caPEM, 0644); err != nil {
		return fmt.Errorf("写入 ca-previous.crt 失败: %w", err)
	}
	if err := writeFileAtomic(certPath, newCertPEM, 0644); err != nil {
		return fmt.Errorf("写入新 ca.crt 失败: %w", err)
	}
	if err := writeFileAtomic(keyPath, newKeyPEM, 0600); err != nil {
		return fmt.Errorf("写入新 ca.key 失败: %w", err)
	}
	p.promotedCAPEM = newCertPEM
	p.restartRequired = true
	return nil
}

// Finalize 阶段三：结束轮换过渡期，删除 dir/ca-previous.crt，停止信任旧 CA。
// 需重启进程才会真正从监听器信任池中移除。
func (p *PKI) Finalize() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.dir == "" {
		return fmt.Errorf("PKI 未初始化磁盘目录，无法执行操作")
	}
	prevPath := filepath.Join(p.dir, "ca-previous.crt")
	if !fileExists(prevPath) {
		return &CodedError{Code: "agent.ca_no_pending", Msg: "当前没有待终结的轮换"}
	}
	if err := os.Remove(prevPath); err != nil {
		return fmt.Errorf("删除 ca-previous.crt 失败: %w", err)
	}
	if len(p.previousCAPEM) > 0 {
		p.restartRequired = true
	}
	return nil
}

// IssueServerCert 签发一张服务端叶子证书，SAN 取自 sans（IP 或域名均可，自动识别）。
// 不落盘——每次进程启动都基于当前配置重新签发，避免 SAN 变更后旧证书需要手工清理。
func (p *PKI) IssueServerCert(sans []string, validDays int) (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("生成服务端私钥失败: %w", err)
	}
	serial, err := randomSerial()
	if err != nil {
		return tls.Certificate{}, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "nms-agent-pki"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().AddDate(0, 0, validDays),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	for _, s := range sans {
		if ip := net.ParseIP(s); ip != nil {
			tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
		} else if s != "" {
			tmpl.DNSNames = append(tmpl.DNSNames, s)
		}
	}
	if len(tmpl.DNSNames) == 0 && len(tmpl.IPAddresses) == 0 {
		tmpl.DNSNames = []string{"localhost"}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, p.caCert, &key.PublicKey, p.caKey)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("签发服务端证书失败: %w", err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return tls.X509KeyPair(certPEM, keyPEM)
}

// IssuedClientCert 是 IssueClientCert 的返回值：PEM 编码的证书+私钥，供 Agent 落地到
// 本地文件，以及 Server 端登记到 Agent 表用于后续吊销比对的元数据（Serial/Expiry）。
type IssuedClientCert struct {
	CertPEM []byte
	KeyPEM  []byte
	Serial  string
	Expiry  time.Time
}

// IssueClientCert 签发一张客户端叶子证书，CN=commonName（即 AgentID）。
// mTLS 中间件通过解析 PeerCertificates[0].Subject.CommonName 取回 AgentID。
// 用于首次 enroll，也用于既有 Agent 通过 mTLS 续期（见 RenewAgentCert）。
func (p *PKI) IssueClientCert(commonName string, validDays int) (*IssuedClientCert, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("生成客户端私钥失败: %w", err)
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	expiry := time.Now().AddDate(0, 0, validDays)
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: commonName},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     expiry,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, p.caCert, &key.PublicKey, p.caKey)
	if err != nil {
		return nil, fmt.Errorf("签发客户端证书失败: %w", err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, err
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return &IssuedClientCert{CertPEM: certPEM, KeyPEM: keyPEM, Serial: serial.String(), Expiry: expiry}, nil
}

// TLSConfig 构造监听器用的 tls.Config。
// requireClientCert=true → agent-sync 端口：tls.RequireAndVerifyClientCert + ClientCAs=信任池
// （活跃 CA + 轮换过渡期内的旧 CA）。
// requireClientCert=false → enroll 端口：单向 HTTPS，不要求客户端证书。
func (p *PKI) TLSConfig(serverCert tls.Certificate, requireClientCert bool) *tls.Config {
	cfg := &tls.Config{
		Certificates: []tls.Certificate{serverCert},
		MinVersion:   tls.VersionTLS12,
	}
	if requireClientCert {
		cfg.ClientAuth = tls.RequireAndVerifyClientCert
		cfg.ClientCAs = p.caPool
	} else {
		cfg.ClientAuth = tls.NoClientCert
	}
	return cfg
}
