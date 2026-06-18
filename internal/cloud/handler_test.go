package cloud

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pandabytelabs/traeky/internal/buildinfo"
)

func testAuthProof(label string) string {
	sum := sha256.Sum256([]byte("traeky-cloud-auth-test-v1:" + label))
	return "ta1_" + base64.RawURLEncoding.EncodeToString(sum[:])
}

func testCloudVersion() string {
	return buildinfo.Version()
}

func testMismatchedCloudVersion() string {
	version := testCloudVersion()
	if version == "" || version == "dev" {
		return "test-mismatch"
	}
	return version + "-mismatch"
}

func TestHandlerLifecycleAllowsAnonymousWhenExplicitlyEnabled(t *testing.T) {
	mux := http.NewServeMux()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	Register(mux, Config{Store: store, AllowAnonymousVaults: true})

	vaultKey := "vault_1234567890abcdefghijklmnopqrstuv"
	body := `{"body":{"format":"traeky-vault","ciphertext":"opaque"},"client_id":"test"}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/vaults/"+vaultKey, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-None-Match", "*")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("PUT status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("ETag") == "" {
		t.Fatal("missing ETag")
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/vaults/"+vaultKey, nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "opaque") {
		t.Fatalf("GET body = %s, want encrypted payload", rec.Body.String())
	}
}

func TestHandlerReportsOccupiedVaultKey(t *testing.T) {
	mux := http.NewServeMux()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	Register(mux, Config{Store: store, AllowAnonymousVaults: true})

	vaultKey := "vault_occupied1234567890abcdefghijklmn"
	body := `{"body":{"ciphertext":"opaque"}}`
	for i, want := range []int{http.StatusCreated, http.StatusConflict} {
		req := httptest.NewRequest(http.MethodPut, "/api/v1/vaults/"+vaultKey, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("If-None-Match", "*")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Fatalf("request %d status = %d, want %d, body=%s", i+1, rec.Code, want, rec.Body.String())
		}
	}
}

func TestHandlerVaultAuthProtectsCiphertext(t *testing.T) {
	mux := http.NewServeMux()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	Register(mux, Config{Store: store})

	vaultKey := "vault_auth_handler1234567890abcdefghij"
	body := `{"body":{"format":"traeky-vault","ciphertext":"opaque"}}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/vaults/"+vaultKey, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-None-Match", "*")
	req.Header.Set("X-Traeky-Vault-Auth", testAuthProof("primary"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("PUT status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"auth_required":true`) {
		t.Fatalf("PUT response = %s, want auth_required", rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/vaults/"+vaultKey, nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET status = %d, body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/vaults/"+vaultKey, nil)
	req.Header.Set("X-Traeky-Vault-Auth", testAuthProof("primary"))
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("authenticated GET status = %d, body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandlerCanRotateVaultAuth(t *testing.T) {
	mux := http.NewServeMux()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	Register(mux, Config{Store: store})

	vaultKey := "vault_auth_rotate1234567890abcdefghij"
	body := `{"body":{"ciphertext":"a"}}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/vaults/"+vaultKey, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-None-Match", "*")
	req.Header.Set("X-Traeky-Vault-Auth", testAuthProof("old"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPut, "/api/v1/vaults/"+vaultKey, strings.NewReader(`{"body":{"ciphertext":"b"}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-Match", "1")
	req.Header.Set("X-Traeky-Vault-Auth", testAuthProof("old"))
	req.Header.Set("X-Traeky-New-Vault-Auth", testAuthProof("new"))
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("rotate status = %d, body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/vaults/"+vaultKey, nil)
	req.Header.Set("X-Traeky-Vault-Auth", testAuthProof("old"))
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("old auth GET status = %d, want 401", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/vaults/"+vaultKey, nil)
	req.Header.Set("X-Traeky-Vault-Auth", testAuthProof("new"))
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("new auth GET status = %d, body=%s", rec.Code, rec.Body.String())
	}
}
func TestHandlerUsesAPIV1Only(t *testing.T) {
	mux := http.NewServeMux()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	Register(mux, Config{Store: store})

	req := httptest.NewRequest(http.MethodGet, "/traeky/info", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("/traeky/info status = %d, want 404", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/info", nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("/api/v1/info status = %d, want 200", rec.Code)
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", rec.Header().Get("Cache-Control"))
	}
	var info struct {
		Terms Terms `json:"terms"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &info); err != nil {
		t.Fatalf("info json: %v", err)
	}
	if info.Terms.Body == "" || !info.Terms.Required {
		t.Fatalf("terms = %+v, want required default terms", info.Terms)
	}
}

func TestHandlerInfoExposesOnlyDashboardRequiredFields(t *testing.T) {
	mux := http.NewServeMux()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	Register(mux, Config{Store: store, Version: testCloudVersion(), Commit: "abcdef123456", StrictClientCommit: true, RetentionDays: 90, Terms: Terms{
		Version:          "legal-1",
		Title:            "Custom legal text",
		Body:             "Operator disclaimer",
		PrivacyPolicyURL: "https://example.org/privacy",
		ImprintURL:       "https://example.org/imprint",
	}})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/info", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("/api/v1/info status = %d, want 200", rec.Code)
	}
	var info struct {
		Version               string `json:"version"`
		Terms                 Terms  `json:"terms"`
		TraekyVersion         string `json:"traeky_version"`
		Commit                string `json:"commit"`
		StrictClientCommit    bool   `json:"strict_client_commit"`
		InactiveRetentionDays int    `json:"inactive_retention_days"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &info); err != nil {
		t.Fatalf("info json: %v", err)
	}
	if info.Version != "5" || info.TraekyVersion != testCloudVersion() || info.Commit != "abcdef123456" || !info.StrictClientCommit {
		t.Fatalf("compatibility info not exposed correctly: %+v", info)
	}
	if info.Terms.PrivacyPolicyURL != "https://example.org/privacy" || info.Terms.ImprintURL != "https://example.org/imprint" {
		t.Fatalf("legal links not exposed through terms: %+v", info.Terms)
	}
	if info.InactiveRetentionDays != 90 {
		t.Fatalf("inactive_retention_days = %d, want 90", info.InactiveRetentionDays)
	}

	var raw map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatalf("info raw json: %v", err)
	}
	for _, forbidden := range []string{
		"app_version",
		"commit_short",
		"client_version_required",
		"e2e",
		"auth_required",
		"auth_mode",
		"anonymous_key_model",
		"preconditions_required",
		"storage_backend",
		"max_payload_bytes",
		"max_total_stored_bytes",
		"max_vault_count",
		"create_limit_ip_minute",
		"create_limit_ip_hour",
		"trusted_proxy_count",
		"disclaimer",
		"privacy_policy_url",
		"imprint_url",
	} {
		if _, ok := raw[forbidden]; ok {
			t.Fatalf("info exposes forbidden field %q in %s", forbidden, rec.Body.String())
		}
	}
}

func TestHandlerRejectsMalformedAuthProof(t *testing.T) {
	mux := http.NewServeMux()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	Register(mux, Config{Store: store})

	vaultKey := "vault_bad_auth1234567890abcdefghijklm"
	req := httptest.NewRequest(http.MethodPut, "/api/v1/vaults/"+vaultKey, strings.NewReader(`{"body":{"ciphertext":"opaque"}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-None-Match", "*")
	req.Header.Set("X-Traeky-Vault-Auth", "not-a-valid-proof")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401, body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandlerRejectsTrailingJSON(t *testing.T) {
	mux := http.NewServeMux()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	Register(mux, Config{Store: store})

	vaultKey := "vault_trailing1234567890abcdefghijk"
	req := httptest.NewRequest(http.MethodPut, "/api/v1/vaults/"+vaultKey, strings.NewReader(`{"body":{"ciphertext":"opaque"}} {}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-None-Match", "*")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandlerHealthEndpoint(t *testing.T) {
	mux := http.NewServeMux()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	Register(mux, Config{Store: store, StorageBackend: "file", RetentionDays: 365})

	for _, path := range []string{"/health", "/api/v1/health"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d, body=%s", path, rec.Code, rec.Body.String())
		}
		var body map[string]string
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s json: %v", path, err)
		}
		if body["status"] != "ok" {
			t.Fatalf("%s body = %+v", path, body)
		}
		if len(body) != 1 {
			t.Fatalf("%s health exposes extra fields: %+v", path, body)
		}
	}
}

func TestHandlerRequiresMatchingClientVersionForVaultSync(t *testing.T) {
	mux := http.NewServeMux()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	Register(mux, Config{Store: store, Version: testCloudVersion(), AllowAnonymousVaults: true})

	vaultKey := "vault_version_gate1234567890abcdefgh"
	body := `{"body":{"ciphertext":"opaque"}}`

	for name, tc := range map[string]struct {
		version string
		want    int
	}{
		"missing":  {version: "", want: http.StatusUpgradeRequired},
		"mismatch": {version: testMismatchedCloudVersion(), want: http.StatusUpgradeRequired},
		"matching": {version: testCloudVersion(), want: http.StatusCreated},
	} {
		req := httptest.NewRequest(http.MethodPut, "/api/v1/vaults/"+vaultKey, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("If-None-Match", "*")
		if tc.version != "" {
			req.Header.Set("X-Traeky-Client-Version", tc.version)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Fatalf("%s status = %d, want %d, body=%s", name, rec.Code, tc.want, rec.Body.String())
		}
	}
}

func TestHandlerStrictCommitMatchingForVaultSync(t *testing.T) {
	mux := http.NewServeMux()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	Register(mux, Config{Store: store, Version: testCloudVersion(), Commit: "abcdef123456", StrictClientCommit: true, AllowAnonymousVaults: true})

	vaultKey := "vault_commit_gate1234567890abcdefghi"
	body := `{"body":{"ciphertext":"opaque"}}`

	for name, tc := range map[string]struct {
		commit string
		want   int
	}{
		"missing":  {commit: "", want: http.StatusUpgradeRequired},
		"mismatch": {commit: "abcdef9", want: http.StatusUpgradeRequired},
		"matching": {commit: "abcdef123456", want: http.StatusCreated},
	} {
		req := httptest.NewRequest(http.MethodPut, "/api/v1/vaults/"+vaultKey, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("If-None-Match", "*")
		req.Header.Set("X-Traeky-Client-Version", testCloudVersion())
		if tc.commit != "" {
			req.Header.Set("X-Traeky-Client-Commit", tc.commit)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Fatalf("%s status = %d, want %d, body=%s", name, rec.Code, tc.want, rec.Body.String())
		}
	}
}

func TestRateLimiterBoundsBucketCardinality(t *testing.T) {
	limiter := &rateLimiter{buckets: map[string]rateBucket{}, maxBuckets: 2}
	if !limiter.allow("first", 10, time.Minute) {
		t.Fatal("first key should be allowed")
	}
	if !limiter.allow("second", 10, time.Minute) {
		t.Fatal("second key should be allowed")
	}
	if !limiter.allow("third", 10, time.Minute) {
		t.Fatal("third key should be allowed after evicting an older bucket")
	}
	if got := len(limiter.buckets); got > 2 {
		t.Fatalf("bucket count = %d, want <= 2", got)
	}
}

func TestRateLimiterPrunesExpiredBucketsBeforeEvicting(t *testing.T) {
	limiter := &rateLimiter{buckets: map[string]rateBucket{
		"expired": {reset: time.Now().Add(-time.Minute), count: 1},
		"active":  {reset: time.Now().Add(time.Minute), count: 1},
	}, maxBuckets: 2}
	if !limiter.allow("new", 10, time.Minute) {
		t.Fatal("new key should be allowed")
	}
	if _, ok := limiter.buckets["expired"]; ok {
		t.Fatal("expired bucket was not pruned")
	}
	if got := len(limiter.buckets); got > 2 {
		t.Fatalf("bucket count = %d, want <= 2", got)
	}
}
