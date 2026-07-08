package core

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

// secretPrefix 标记静态加密后的密文。带前缀的值是 base64(nonce ‖ ciphertext)，
// 不带前缀的值按明文处理——这让"未启用加密的旧数据"与"启用后新写入的密文"可以
// 在同一列共存，配合启动时的一次性加密清扫实现渐进迁移，无需停机换列。
const secretPrefix = "enc:v1:"

// SecretBox —— AES-256-GCM 对称加密封装，用于敏感凭证的静态加密（encryption at
// rest，如 SNMP community / SNMPv3 密码）。密钥由 config 口令经 SHA-256 派生为
// 32 字节，任意长度口令均可。*SecretBox 为 nil（未配置密钥）时 Seal/Open 明文
// 直通，调用方无需判空。
//
// 密钥轮换：prev 持有上一代密钥（config 的 credentials_key_previous）。Open 先试
// 当前密钥、失败再试旧密钥（读路径在过渡期无缝）；Seal 一律用当前密钥；启动清扫
// （EncryptExistingSNMPCredentials）用 Reseal 把旧钥密文/明文统一重封为当前密钥。
// 轮换流程：credentials_key 填新口令、credentials_key_previous 填旧口令 → 重启
// （清扫自动重封全部凭证）→ 下次发版前移除 previous。
//
// ⚠️ 两把密钥都丢失 = 已加密凭证不可恢复，只能重新录入。
type SecretBox struct {
	aead cipher.AEAD
	prev cipher.AEAD // 上一代密钥（轮换过渡期），可为 nil
}

// deriveAEAD 口令 → SHA-256 派生 AES-256-GCM。
func deriveAEAD(passphrase string) (cipher.AEAD, error) {
	key := sha256.Sum256([]byte(passphrase))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, fmt.Errorf("初始化 AES 失败: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("初始化 GCM 失败: %w", err)
	}
	return aead, nil
}

// NewSecretBox 由口令构造。当前口令为空返回 (nil, nil) —— 表示未启用加密
// （此时 previous 被忽略：没有当前密钥就无从重封）。
func NewSecretBox(passphrase, previousPassphrase string) (*SecretBox, error) {
	if passphrase == "" {
		return nil, nil
	}
	aead, err := deriveAEAD(passphrase)
	if err != nil {
		return nil, err
	}
	box := &SecretBox{aead: aead}
	if previousPassphrase != "" && previousPassphrase != passphrase {
		if box.prev, err = deriveAEAD(previousPassphrase); err != nil {
			return nil, fmt.Errorf("初始化旧密钥失败: %w", err)
		}
	}
	return box, nil
}

// Seal 加密明文。box 为 nil、明文为空、或值已带密文前缀（幂等，供启动清扫反复
// 调用）时原样返回。
func (b *SecretBox) Seal(plain string) string {
	if b == nil || plain == "" || strings.HasPrefix(plain, secretPrefix) {
		return plain
	}
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		// crypto/rand 失败意味着系统熵源不可用，属于不可恢复环境故障；
		// 返回明文比返回损坏密文安全（至少不会静默丢数据）。
		return plain
	}
	ct := b.aead.Seal(nonce, nonce, []byte(plain), nil)
	return secretPrefix + base64.StdEncoding.EncodeToString(ct)
}

// Open 解密。不带前缀的值视为明文原样返回（旧数据或未启用加密时期写入）。
// 带前缀时先试当前密钥，失败再试旧密钥（轮换过渡期读路径无缝）。box 为 nil
// （密钥被移除）或两把密钥都失败时报错——调用方应把该设备按"凭证缺失"处理并
// 记日志，而不是拿密文字符串当密码去撞设备。
func (b *SecretBox) Open(stored string) (string, error) {
	plain, _, err := b.open(stored)
	return plain, err
}

// open 是 Open 的内部形态，额外返回 stale=true 表示该值需要重封
// （明文、或由旧密钥解出——两种情况 Reseal 都应改写为当前密钥的密文）。
func (b *SecretBox) open(stored string) (plain string, stale bool, err error) {
	if !strings.HasPrefix(stored, secretPrefix) {
		return stored, stored != "", nil // 明文：非空即视为待重封
	}
	if b == nil {
		return "", false, errors.New("凭证已静态加密，但 snmp.credentials_key 未配置")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(stored, secretPrefix))
	if err != nil {
		return "", false, fmt.Errorf("密文格式损坏: %w", err)
	}
	ns := b.aead.NonceSize()
	if len(raw) < ns {
		return "", false, errors.New("密文长度不足")
	}
	if p, err := b.aead.Open(nil, raw[:ns], raw[ns:], nil); err == nil {
		return string(p), false, nil // 当前密钥命中，无需重封
	}
	if b.prev != nil {
		if p, err := b.prev.Open(nil, raw[:ns], raw[ns:], nil); err == nil {
			return string(p), true, nil // 旧密钥命中 → 待重封
		}
	}
	return "", false, errors.New("解密失败（credentials_key / credentials_key_previous 均不匹配）")
}

// Reseal 把存量值统一收敛到"当前密钥密文"：明文 → 加密；旧密钥密文 → 用当前
// 密钥重封；已是当前密钥密文 → 原样。changed=false 时无需写库。
// 解密彻底失败（两把密钥都不匹配）时返回错误，调用方记日志跳过——绝不能把
// 打不开的密文改写掉，那会把"密钥配错可恢复"变成"数据被覆盖不可恢复"。
func (b *SecretBox) Reseal(stored string) (out string, changed bool, err error) {
	if b == nil || stored == "" {
		return stored, false, nil
	}
	plain, stale, err := b.open(stored)
	if err != nil {
		return stored, false, err
	}
	if !stale {
		return stored, false, nil
	}
	return b.Seal(plain), true, nil
}
