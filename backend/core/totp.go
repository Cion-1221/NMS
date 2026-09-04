package core

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// ── TOTP（RFC 6238）——纯标准库实现，不引入第三方依赖 ─────────────────────────
// 参数固定为主流验证器（Google Authenticator / Microsoft Authenticator / 1Password
// 等）的默认值：HMAC-SHA1、6 位、30 秒步长。secret 为 base32（无 padding）编码的
// 20 字节随机密钥（RFC 4226 推荐长度），可直接放进 otpauth:// URI 供扫码。

const (
	totpDigits = 6
	totpPeriod = 30
	totpSkew   = 1 // 允许前后各 1 个步长（±30s）的时钟漂移
)

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// GenerateTOTPSecret 生成 20 字节随机密钥并 base32 编码。
func GenerateTOTPSecret() (string, error) {
	buf := make([]byte, 20)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return b32.EncodeToString(buf), nil
}

// TOTPURI 构造验证器 App 扫码用的 otpauth:// URI。
func TOTPURI(issuer, account, secret string) string {
	label := url.PathEscape(issuer + ":" + account)
	q := url.Values{}
	q.Set("secret", secret)
	q.Set("issuer", issuer)
	q.Set("algorithm", "SHA1")
	q.Set("digits", fmt.Sprint(totpDigits))
	q.Set("period", fmt.Sprint(totpPeriod))
	return "otpauth://totp/" + label + "?" + q.Encode()
}

func hotp(key []byte, counter uint64) string {
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], counter)
	mac := hmac.New(sha1.New, key)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	code := (binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff) % 1000000
	return fmt.Sprintf("%06d", code)
}

// IsTOTPCode 判断输入是否形如 6 位数字验证码（否则按恢复码处理）。
func IsTOTPCode(code string) bool {
	code = strings.TrimSpace(code)
	if len(code) != totpDigits {
		return false
	}
	for _, r := range code {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// ValidateTOTP 校验 6 位验证码。返回命中的时间步计数，供调用方记录后拒绝同一步长
// 内的重放：lastCounter 为该用户上次成功使用的计数，不大于它的步长一律不接受。
func ValidateTOTP(secret, code string, now time.Time, lastCounter int64) (int64, bool) {
	code = strings.TrimSpace(code)
	if !IsTOTPCode(code) {
		return 0, false
	}
	key, err := b32.DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	if err != nil || len(key) == 0 {
		return 0, false
	}
	base := now.Unix() / totpPeriod
	for i := -totpSkew; i <= totpSkew; i++ {
		counter := base + int64(i)
		if counter <= lastCounter {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(hotp(key, uint64(counter))), []byte(code)) == 1 {
			return counter, true
		}
	}
	return 0, false
}

// ── 恢复码 ──────────────────────────────────────────────────────────────────
// 8 组 "xxxxx-xxxxx"（小写字母数字，剔除 0/o/1/l/i 等易混淆字符），每组一次性，
// 库内只存 SHA-256；明文仅在生成时展示一次。

const recoveryCodeCount = 8

const recoveryAlphabet = "abcdefghjkmnpqrstuvwxyz23456789"

// GenerateRecoveryCodes 返回 (明文列表, 哈希列表)。
func GenerateRecoveryCodes() ([]string, []string, error) {
	plain := make([]string, 0, recoveryCodeCount)
	hashes := make([]string, 0, recoveryCodeCount)
	for i := 0; i < recoveryCodeCount; i++ {
		raw := make([]byte, 10)
		if _, err := rand.Read(raw); err != nil {
			return nil, nil, err
		}
		var sb strings.Builder
		for j, b := range raw {
			if j == 5 {
				sb.WriteByte('-')
			}
			sb.WriteByte(recoveryAlphabet[int(b)%len(recoveryAlphabet)])
		}
		code := sb.String()
		plain = append(plain, code)
		hashes = append(hashes, HashRecoveryCode(code))
	}
	return plain, hashes, nil
}

// HashRecoveryCode 归一化（去空白与连字符、小写）后取 SHA-256 hex。
func HashRecoveryCode(code string) string {
	norm := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(code), "-", ""))
	sum := sha256.Sum256([]byte(norm))
	return hex.EncodeToString(sum[:])
}
