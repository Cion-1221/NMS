package core

import (
	"net/netip"
	"testing"
	"time"
)

func TestSecretBoxTOTPSealOpenAndKeyRotation(t *testing.T) {
	secret, err := GenerateTOTPSecret()
	if err != nil {
		t.Fatalf("GenerateTOTPSecret: %v", err)
	}

	box1, err := NewSecretBox("old-passphrase-key-1", "")
	if err != nil {
		t.Fatalf("NewSecretBox: %v", err)
	}
	sealed := box1.Seal(secret)
	if sealed == secret {
		t.Fatalf("expected sealed ciphertext to differ from plaintext")
	}
	if len(sealed) > 500 {
		t.Fatalf("sealed secret length %d exceeds sys_users.totp_secret varchar(500)", len(sealed))
	}

	opened, err := box1.Open(sealed)
	if err != nil || opened != secret {
		t.Fatalf("Open got (%q, %v), want %q", opened, err, secret)
	}

	// Key rotation: box2 has new primary key and box1's key as previous
	box2, err := NewSecretBox("new-passphrase-key-2", "old-passphrase-key-1")
	if err != nil {
		t.Fatalf("NewSecretBox rotation: %v", err)
	}
	resealed, changed, err := box2.Reseal(sealed)
	if err != nil || !changed {
		t.Fatalf("Reseal expected changed=true, err=nil; got changed=%v, err=%v", changed, err)
	}

	// Verify TOTP validation still works after decrypting resealed secret with new key only
	box2Final, _ := NewSecretBox("new-passphrase-key-2", "")
	plainAfterRotate, err := box2Final.Open(resealed)
	if err != nil || plainAfterRotate != secret {
		t.Fatalf("Open after rotation got (%q, %v), want %q", plainAfterRotate, err, secret)
	}

	now := time.Unix(1_700_000_000, 0)
	rawKey, err := b32.DecodeString(secret)
	if err != nil {
		t.Fatalf("DecodeString: %v", err)
	}
	code := hotp(rawKey, uint64(now.Unix()/totpPeriod))
	if _, ok := ValidateTOTP(plainAfterRotate, code, now, 0); !ok {
		t.Fatalf("ValidateTOTP failed on rotated secret")
	}
}

func TestStrictCIDRAndOverlap(t *testing.T) {
	p1, err := ValidateStrictCIDR("10.0.0.0/8")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	p2, err := ValidateStrictCIDR("10.10.0.0/16")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !p1.Overlaps(p2) {
		t.Fatalf("expected %s and %s to overlap", p1, p2)
	}

	p3 := netip.MustParsePrefix("172.16.0.0/12")
	if p1.Overlaps(p3) {
		t.Fatalf("did not expect %s and %s to overlap", p1, p3)
	}
}
