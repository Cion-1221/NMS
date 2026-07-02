package core

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

// PKI 持有 NMS 内置 Root CA，负责签发 mTLS 服务端/客户端证书，并支持 CA 轮换。
//
// CA 轮换模型：Rotate/Finalize 只落盘文件（ca.crt/ca.key/ca-previous.crt），不在运行
// 中的进程内热切换信任池——同时变更一个正被并发 TLS 握手读取的 *x509.CertPool 需要
// 额外的同步原语才能避免数据竞争，而这里的收益（省一次重启）远小于引入复杂度的代价。
// 因此 Rotate/Finalize 生效都需要重启进程，与本项目其余配置变更（端口、SAN 等）的
// 生效方式保持一致——见 LoadOrCreatePKI 在启动时把 ca-previous.crt（如果存在）一并
// 加入信任池。
type PKI struct {
	dir string

	caCert *x509.Certificate
	caKey  *ecdsa.PrivateKey
	caPEM  []byte

	// previousCAPEM 非空代表存在一个"轮换中尚未终结"的旧 CA——仍被信任池接纳（用于
	// 验证旧 CA 签发、尚未续期的 Agent 证书），但不再用于签发任何新证书。
	previousCAPEM []byte

	caPool *x509.CertPool
}

// PKIStatus 供管理界面展示当前 CA 状态（GET /api/v1/agents/ca/status）。
type PKIStatus struct {
	ActiveCAExpiry     time.Time  `json:"active_ca_expiry"`
	ActiveCASerial     string     `json:"active_ca_serial"`
	HasPendingPrevious bool       `json:"has_pending_previous"`
	PreviousCAExpiry   *time.Time `json:"previous_ca_expiry,omitempty"`
}

// LoadOrCreatePKI 从 dir 加载已存在的 Root CA，不存在则生成一份新的
// （ECDSA P-256，有效期 caDays 天）并写入磁盘（私钥 0600 权限）。
// 如果 dir 下存在 ca-previous.crt（上一轮 Rotate 留下、尚未 Finalize），也会一并
// 加载进信任池。
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
	p.caPool = pool
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// generateCA 生成一份新的自签发 Root CA（不落盘），供 createPKI 和 Rotate 共用。
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

	if err := os.WriteFile(certPath, certPEM, 0644); err != nil {
		return nil, fmt.Errorf("写入 ca.crt 失败: %w", err)
	}
	if err := os.WriteFile(keyPath, keyPEM, 0600); err != nil {
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

// CACertPEM 返回当前活跃 Root CA 的公开证书（PEM），供 GET /api/v1/agents/ca-cert 和
// Agent 首次引导建立信任使用。
func (p *PKI) CACertPEM() []byte { return p.caPEM }

// Status 返回当前 CA 状态，供管理界面展示。
func (p *PKI) Status() PKIStatus {
	s := PKIStatus{
		ActiveCAExpiry: p.caCert.NotAfter,
		ActiveCASerial: p.caCert.SerialNumber.String(),
	}
	if len(p.previousCAPEM) > 0 {
		s.HasPendingPrevious = true
		if block, _ := pem.Decode(p.previousCAPEM); block != nil {
			if prevCert, err := x509.ParseCertificate(block.Bytes); err == nil {
				exp := prevCert.NotAfter
				s.PreviousCAExpiry = &exp
			}
		}
	}
	return s
}

// Rotate 生成一份新的 Root CA 并使其成为活跃 CA；原 CA 的公钥证书保留在
// dir/ca-previous.crt，在调用 Finalize 之前仍会被信任（用于验证用旧 CA 签发、尚未
// 续期的 Agent 证书）。仅落盘，需重启进程后才会真正生效——见类型注释。
func (p *PKI) Rotate(caDays int) error {
	if p.dir == "" {
		return fmt.Errorf("PKI 未初始化磁盘目录，无法执行轮换")
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

	prevPath := filepath.Join(p.dir, "ca-previous.crt")
	certPath := filepath.Join(p.dir, "ca.crt")
	keyPath := filepath.Join(p.dir, "ca.key")

	// 旧 CA 的公钥证书保留作为信任池的一部分；旧私钥不再需要（之后不会再用它签发任何
	// 新证书），直接丢弃，不落盘。
	if err := os.WriteFile(prevPath, p.caPEM, 0644); err != nil {
		return fmt.Errorf("写入 ca-previous.crt 失败: %w", err)
	}
	if err := os.WriteFile(certPath, newCertPEM, 0644); err != nil {
		return fmt.Errorf("写入新 ca.crt 失败: %w", err)
	}
	if err := os.WriteFile(keyPath, newKeyPEM, 0600); err != nil {
		return fmt.Errorf("写入新 ca.key 失败: %w", err)
	}
	return nil
}

// Finalize 结束轮换过渡期：删除 dir/ca-previous.crt，停止信任旧 CA。
// 同样只落盘，需重启进程才会真正从信任池中移除。
func (p *PKI) Finalize() error {
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
