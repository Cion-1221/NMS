package models

import (
	"sync"
	"testing"

	"gorm.io/gorm/schema"
)

func TestAgentSchemaColumnNames(t *testing.T) {
	s, err := schema.Parse(&Agent{}, &sync.Map{}, schema.NamingStrategy{})
	if err != nil {
		t.Fatalf("schema.Parse: %v", err)
	}
	wantCols := map[string]string{
		"TrustedCAFP":  "trusted_ca_fp",
		"CertIssuerFP": "cert_issuer_fp",
	}
	for fieldName, wantCol := range wantCols {
		f := s.LookUpField(fieldName)
		if f == nil {
			t.Fatalf("field %s not found in parsed schema", fieldName)
		}
		if f.DBName != wantCol {
			t.Fatalf("field %s DBName = %q, want %q", fieldName, f.DBName, wantCol)
		}
	}
}
