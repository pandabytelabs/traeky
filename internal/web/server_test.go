package web

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAppInfoIncludesDashboardLegalLinks(t *testing.T) {
	mux := http.NewServeMux()
	RegisterWithConfig(mux, slog.New(slog.NewTextHandler(io.Discard, nil)), Config{
		Version:          "v3.1.4",
		Commit:           "abcdef1234567890",
		PrivacyPolicyURL: "https://dashboard.example.org/privacy#tracking",
		ImprintURL:       "https://dashboard.example.org/imprint",
	})

	req := httptest.NewRequest(http.MethodGet, "/api/app/info", nil)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
	}

	var got appInfoResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode app info: %v", err)
	}
	if got.Version != "3.1.4" {
		t.Fatalf("version = %q", got.Version)
	}
	if got.Commit != "abcdef1234567890" {
		t.Fatalf("commit = %q", got.Commit)
	}
	if got.CommitShort != "abcdef1" {
		t.Fatalf("commit_short = %q", got.CommitShort)
	}
	if got.PrivacyPolicyURL != "https://dashboard.example.org/privacy" {
		t.Fatalf("privacy_policy_url = %q", got.PrivacyPolicyURL)
	}
	if got.ImprintURL != "https://dashboard.example.org/imprint" {
		t.Fatalf("imprint_url = %q", got.ImprintURL)
	}
}

func TestAppInfoRejectsInvalidLegalLinkSchemes(t *testing.T) {
	mux := http.NewServeMux()
	RegisterWithConfig(mux, slog.New(slog.NewTextHandler(io.Discard, nil)), Config{
		PrivacyPolicyURL: "javascript:alert(1)",
		ImprintURL:       "mailto:legal@example.org",
	})

	req := httptest.NewRequest(http.MethodGet, "/api/app/info", nil)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
	}
	var got appInfoResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode app info: %v", err)
	}
	if got.PrivacyPolicyURL != "" || got.ImprintURL != "" {
		t.Fatalf("invalid links should be omitted, got %#v", got)
	}
}
