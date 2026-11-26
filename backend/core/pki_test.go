package core

import (
	"crypto/x509"
	"encoding/pem"
	"errors"
	"strings"
	"testing"
)

func parseAllCerts(t *testing.T, raw []byte) []*x509.Certificate {
	t.Helper()
	var certs []*x509.Certificate
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
			t.Fatalf("parse cert: %v", err)
		}
		certs = append(certs, c)
	}
	return certs
}

func TestPKIThreePhaseSmoothRotation(t *testing.T) {
	dir := t.TempDir()

	pki1, err := LoadOrCreatePKI(dir, 3650)
	if err != nil {
		t.Fatalf("LoadOrCreatePKI: %v", err)
	}
	oldFP := pki1.ActiveCAFingerprint()
	if oldFP == "" {
		t.Fatal("expected non-empty active CA fingerprint")
	}

	// Issue a client cert under Old CA.
	issuedOld, err := pki1.IssueClientCert("AGT-TEST0001", 365)
	if err != nil {
		t.Fatalf("IssueClientCert: %v", err)
	}
	oldClientCert := parseAllCerts(t, issuedOld.CertPEM)[0]
	if !pki1.IsIssuedByActiveCA(oldClientCert) {
		t.Fatal("expected old client cert to be issued by active CA")
	}

	// Phase 1: Prepare next CA (zero-restart in-memory bundle update).
	if err := pki1.Prepare(3650); err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	st1 := pki1.Status()
	if !st1.HasPreparedNext || st1.NextCAFP == "" || st1.NextCAFP == oldFP {
		t.Fatalf("unexpected status after Prepare: %+v", st1)
	}

	// Duplicate Prepare must be rejected with agent.ca_already_prepared.
	var coded *CodedError
	if err := pki1.Prepare(3650); !errors.As(err, &coded) || coded.Code != "agent.ca_already_prepared" {
		t.Fatalf("expected agent.ca_already_prepared, got %v", err)
	}

	// CABundlePEM must contain both Old CA and Next CA immediately.
	bundle1 := parseAllCerts(t, pki1.CABundlePEM())
	if len(bundle1) != 2 {
		t.Fatalf("expected 2 certs in CABundlePEM after Prepare, got %d", len(bundle1))
	}
	fps1 := pki1.BundleFingerprints()
	if !strings.Contains(fps1, oldFP) || !strings.Contains(fps1, st1.NextCAFP) {
		t.Fatalf("BundleFingerprints %q missing %q or %q", fps1, oldFP, st1.NextCAFP)
	}

	// Phase 2: Promote prepared CA to active on disk, then simulate server restart.
	if err := pki1.Promote(); err != nil {
		t.Fatalf("Promote: %v", err)
	}
	if !pki1.Status().RestartRequired {
		t.Fatal("expected RestartRequired=true after Promote")
	}

	// Simulate server restart: LoadOrCreatePKI loads promoted ca.crt + ca-previous.crt.
	pki2, err := LoadOrCreatePKI(dir, 3650)
	if err != nil {
		t.Fatalf("LoadOrCreatePKI after Promote: %v", err)
	}
	if pki2.ActiveCAFingerprint() != st1.NextCAFP {
		t.Fatalf("active CA after restart = %q, want %q", pki2.ActiveCAFingerprint(), st1.NextCAFP)
	}
	if pki2.PreviousCAFingerprint() != oldFP {
		t.Fatalf("previous CA after restart = %q, want %q", pki2.PreviousCAFingerprint(), oldFP)
	}

	// Old client cert must still verify against pki2's trust pool (ca-previous.crt),
	// AND IsIssuedByActiveCA must return false so /tasks triggers renew_cert=true.
	if _, err := oldClientCert.Verify(x509.VerifyOptions{
		Roots:     pki2.caPool,
		KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}); err != nil {
		t.Fatalf("old client cert failed verification during transition: %v", err)
	}
	if pki2.IsIssuedByActiveCA(oldClientCert) {
		t.Fatal("expected IsIssuedByActiveCA=false for old client cert after promotion")
	}
	if got := pki2.ClassifyIssuerFP(oldClientCert); got != oldFP {
		t.Fatalf("ClassifyIssuerFP(oldClientCert) = %q, want %q", got, oldFP)
	}

	// Renewed client cert under pki2 must be issued by New Active CA.
	issuedNew, err := pki2.IssueClientCert("AGT-TEST0001", 365)
	if err != nil {
		t.Fatalf("IssueClientCert under new CA: %v", err)
	}
	newClientCert := parseAllCerts(t, issuedNew.CertPEM)[0]
	if !pki2.IsIssuedByActiveCA(newClientCert) {
		t.Fatal("expected new client cert to be issued by active CA")
	}

	// Phase 3: Finalize removes ca-previous.crt; after restart old client cert is rejected.
	if err := pki2.Finalize(); err != nil {
		t.Fatalf("Finalize: %v", err)
	}
	pki3, err := LoadOrCreatePKI(dir, 3650)
	if err != nil {
		t.Fatalf("LoadOrCreatePKI after Finalize: %v", err)
	}
	if _, err := oldClientCert.Verify(x509.VerifyOptions{
		Roots:     pki3.caPool,
		KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}); err == nil {
		t.Fatal("expected old client cert to be rejected after Finalize + restart")
	}
	if _, err := newClientCert.Verify(x509.VerifyOptions{
		Roots:     pki3.caPool,
		KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}); err != nil {
		t.Fatalf("new client cert failed verification after Finalize: %v", err)
	}
}
