package cloud

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func createVaultForTest(t *testing.T, mux http.Handler, vaultID, remoteAddr, forwardedFor string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPut, "/api/v1/vaults/"+vaultID, strings.NewReader(`{"body":{"ciphertext":"opaque"}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-None-Match", "*")
	if remoteAddr != "" {
		req.RemoteAddr = remoteAddr
	}
	if forwardedFor != "" {
		req.Header.Set("X-Forwarded-For", forwardedFor)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestHandlerEnforcesCloudStorageQuotas(t *testing.T) {
	mux := http.NewServeMux()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	Register(mux, Config{
		Store:                store,
		AllowAnonymousVaults: true,
		MaxVaultCount:        1,
		MaxTotalStoredBytes:  1024,
	})

	first := createVaultForTest(t, mux, "vault_quota_one1234567890abcdefghijk", "198.51.100.1:12345", "")
	if first.Code != http.StatusCreated {
		t.Fatalf("first create status = %d, body=%s", first.Code, first.Body.String())
	}

	second := createVaultForTest(t, mux, "vault_quota_two1234567890abcdefghijk", "198.51.100.1:12345", "")
	if second.Code != http.StatusInsufficientStorage {
		t.Fatalf("second create status = %d, want 507, body=%s", second.Code, second.Body.String())
	}
}

func TestHandlerEnforcesTotalPayloadQuota(t *testing.T) {
	mux := http.NewServeMux()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	Register(mux, Config{
		Store:                store,
		AllowAnonymousVaults: true,
		MaxTotalStoredBytes:  5,
	})

	rec := createVaultForTest(t, mux, "vault_payload_quota1234567890abcdef", "198.51.100.1:12345", "")
	if rec.Code != http.StatusInsufficientStorage {
		t.Fatalf("create status = %d, want 507, body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandlerCreateLimitUsesTrustedForwardedFor(t *testing.T) {
	mux := http.NewServeMux()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	Register(mux, Config{
		Store:                   store,
		AllowAnonymousVaults:    true,
		CreateLimitPerIPMinute:  1,
		CreateLimitPerIPHour:    100,
		TrustedProxyCIDRs:       []string{"192.0.2.10/32"},
		ClientIPHeaders:         []string{"X-Forwarded-For"},
		RateLimitPerIPMinute:    100,
		RateLimitPerVaultMinute: 100,
	})

	remoteProxy := "192.0.2.10:54321"
	first := createVaultForTest(t, mux, "vault_proxy_ip_one1234567890abcdefg", remoteProxy, "198.51.100.7")
	if first.Code != http.StatusCreated {
		t.Fatalf("first create status = %d, body=%s", first.Code, first.Body.String())
	}
	secondSameClient := createVaultForTest(t, mux, "vault_proxy_ip_two1234567890abcdefg", remoteProxy, "198.51.100.7")
	if secondSameClient.Code != http.StatusTooManyRequests {
		t.Fatalf("same client second create status = %d, want 429, body=%s", secondSameClient.Code, secondSameClient.Body.String())
	}
	thirdDifferentClient := createVaultForTest(t, mux, "vault_proxy_ip_three1234567890abcde", remoteProxy, "198.51.100.8")
	if thirdDifferentClient.Code != http.StatusCreated {
		t.Fatalf("different client create status = %d, body=%s", thirdDifferentClient.Code, thirdDifferentClient.Body.String())
	}
}

func TestHandlerIgnoresForwardedForFromUntrustedPeer(t *testing.T) {
	mux := http.NewServeMux()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	Register(mux, Config{
		Store:                  store,
		AllowAnonymousVaults:   true,
		CreateLimitPerIPMinute: 1,
		CreateLimitPerIPHour:   100,
		RateLimitPerIPMinute:   100,
	})

	remoteClient := "203.0.113.9:12345"
	first := createVaultForTest(t, mux, "vault_untrusted_xff_one1234567890ab", remoteClient, "198.51.100.7")
	if first.Code != http.StatusCreated {
		t.Fatalf("first create status = %d, body=%s", first.Code, first.Body.String())
	}
	secondSpoofedHeader := createVaultForTest(t, mux, "vault_untrusted_xff_two1234567890ab", remoteClient, "198.51.100.8")
	if secondSpoofedHeader.Code != http.StatusTooManyRequests {
		t.Fatalf("spoofed header create status = %d, want 429, body=%s", secondSpoofedHeader.Code, secondSpoofedHeader.Body.String())
	}
}

func TestHandlerInfoDoesNotExposeAbuseControls(t *testing.T) {
	mux := http.NewServeMux()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	Register(mux, Config{
		Store:                  store,
		MaxPayloadBytes:        1234,
		MaxTotalStoredBytes:    5678,
		MaxVaultCount:          90,
		CreateLimitPerIPMinute: 11,
		CreateLimitPerIPHour:   22,
		TrustedProxyCIDRs:      []string{"192.0.2.10/32"},
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/info", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("info status = %d, body=%s", rec.Code, rec.Body.String())
	}
	for _, forbidden := range []string{
		`"max_payload_bytes"`,
		`"max_total_stored_bytes"`,
		`"max_vault_count"`,
		`"create_limit_ip_minute"`,
		`"create_limit_ip_hour"`,
		`"trusted_proxy_count"`,
	} {
		if strings.Contains(rec.Body.String(), forbidden) {
			t.Fatalf("info body exposes %s: %s", forbidden, rec.Body.String())
		}
	}
}

func BenchmarkClientIPExtraction(b *testing.B) {
	h := &Handler{
		trustedProxies:  parseTrustedProxyCIDRs([]string{"192.0.2.10/32"}, nil),
		clientIPHeaders: []string{"X-Forwarded-For"},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/vaults/vault_bench1234567890abcdefghijklmn", nil)
	req.RemoteAddr = "192.0.2.10:12345"
	req.Header.Set("X-Forwarded-For", "198.51.100.7, 192.0.2.10")
	for i := 0; i < b.N; i++ {
		if got := h.clientIP(req); got != "198.51.100.7" {
			b.Fatal(fmt.Sprintf("unexpected client IP %s", got))
		}
	}
}
