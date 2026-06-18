package cloud

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const apiBasePath = "/api/v1/"

const defaultTermsVersion = "2026-05-02-default-no-warranty"
const defaultTermsTitle = "Traeky Cloud Server Disclaimer"
const defaultTermsBody = "This Traeky Cloud server stores client-side encrypted vault payloads only. The server operator cannot decrypt, recover, validate, tax-review, or guarantee the contents of any vault. Use is at your own risk. To the maximum extent permitted by applicable law, the server operator provides the service as is and as available, without warranties or guarantees of availability, durability, correctness, fitness for a particular purpose, non-infringement, data retention, support, or compatibility. The server operator is not liable for direct, indirect, incidental, consequential, special, punitive, business, tax, accounting, regulatory, data-loss, profit-loss, service-interruption, or security damages arising from use or inability to use the service. Users remain solely responsible for backups, recovery phrases, legal and tax compliance, security of endpoints and devices, and evaluating whether the service is suitable for private, commercial, corporate, or other use."

func NormalizeTerms(terms Terms) Terms {
	version := strings.TrimSpace(terms.Version)
	if version == "" {
		version = defaultTermsVersion
	}
	title := strings.TrimSpace(terms.Title)
	if title == "" {
		title = defaultTermsTitle
	}
	body := strings.TrimSpace(terms.Body)
	if body == "" {
		body = defaultTermsBody
	}
	return Terms{
		Version:          version,
		Title:            title,
		Body:             body,
		Required:         true,
		PrivacyPolicyURL: normalizePublicURL(terms.PrivacyPolicyURL),
		ImprintURL:       normalizePublicURL(terms.ImprintURL),
	}
}

func normalizePublicURL(value string) string {
	raw := strings.TrimSpace(value)
	if raw == "" {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "https" && scheme != "http" {
		return ""
	}
	parsed.User = nil
	parsed.Fragment = ""
	return parsed.String()
}

type Config struct {
	Store           Store
	Logger          *slog.Logger
	Version         string
	Commit          string
	MaxPayloadBytes int64
	// MaxTotalStoredBytes caps the total encrypted vault payload bytes stored by
	// this cloud instance. This is a Zero-Knowledge abuse-control quota; it does
	// not inspect vault contents. A value <= 0 disables the cap.
	MaxTotalStoredBytes int64
	// MaxVaultCount caps the total number of vaults stored by this cloud instance.
	// A value <= 0 disables the cap.
	MaxVaultCount  int64
	CORSOrigins    []string
	StorageBackend string
	RetentionDays  int
	Terms          Terms

	// Security defaults are intentionally strict for public cloud deployments.
	AllowAnonymousVaults      bool
	AllowWildcardCORS         bool
	AllowMissingPreconditions bool
	RateLimitPerIPMinute      int
	RateLimitPerVaultMinute   int
	CreateLimitPerIPMinute    int
	CreateLimitPerIPHour      int
	TrustedProxyCIDRs         []string
	ClientIPHeaders           []string
	StrictClientCommit        bool
}

type Terms struct {
	Version          string `json:"version"`
	Title            string `json:"title"`
	Body             string `json:"body"`
	Required         bool   `json:"required"`
	PrivacyPolicyURL string `json:"privacy_policy_url,omitempty"`
	ImprintURL       string `json:"imprint_url,omitempty"`
}

type Handler struct {
	store                   Store
	logger                  *slog.Logger
	maxPayloadBytes         int64
	corsOrigins             map[string]struct{}
	storageBackend          string
	retentionDays           int
	version                 string
	commit                  string
	strictClientCommit      bool
	terms                   Terms
	requireVaultAuth        bool
	requirePreconditions    bool
	rateLimitPerIPMinute    int
	rateLimitPerVaultMinute int
	createLimitPerIPMinute  int
	createLimitPerIPHour    int
	maxTotalStoredBytes     int64
	maxVaultCount           int64
	trustedProxies          []netip.Prefix
	clientIPHeaders         []string
	limiter                 *rateLimiter
	writeMu                 sync.Mutex
}

type healthCheckStore interface {
	HealthCheck(context.Context) error
}

type putRequest struct {
	Body       json.RawMessage `json:"body"`
	ClientID   string          `json:"client_id,omitempty"`
	DeviceName string          `json:"device_name,omitempty"`
}

type response struct {
	VaultID      string          `json:"vault_id"`
	Revision     int64           `json:"revision"`
	UpdatedAt    string          `json:"updated_at"`
	ClientID     string          `json:"client_id,omitempty"`
	DeviceName   string          `json:"device_name,omitempty"`
	AuthRequired bool            `json:"auth_required"`
	Body         json.RawMessage `json:"body,omitempty"`
}

func Register(mux *http.ServeMux, cfg Config) {
	if cfg.Store == nil {
		panic("cloud.Register: Store is required")
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	maxPayload := cfg.MaxPayloadBytes
	if maxPayload <= 0 {
		maxPayload = 25 * 1024 * 1024
	}
	storageBackend := strings.TrimSpace(cfg.StorageBackend)
	if storageBackend == "" {
		storageBackend = "unknown"
	}
	requirePreconditions := !cfg.AllowMissingPreconditions
	rateLimitPerIP := cfg.RateLimitPerIPMinute
	if rateLimitPerIP <= 0 {
		rateLimitPerIP = 300
	}
	rateLimitPerVault := cfg.RateLimitPerVaultMinute
	if rateLimitPerVault <= 0 {
		rateLimitPerVault = 90
	}
	createLimitPerIPMinute := cfg.CreateLimitPerIPMinute
	if createLimitPerIPMinute <= 0 {
		createLimitPerIPMinute = 20
	}
	createLimitPerIPHour := cfg.CreateLimitPerIPHour
	if createLimitPerIPHour <= 0 {
		createLimitPerIPHour = 100
	}
	trustedProxies := parseTrustedProxyCIDRs(cfg.TrustedProxyCIDRs, logger)
	clientIPHeaders := normalizeClientIPHeaders(cfg.ClientIPHeaders)
	version := normalizeVersion(cfg.Version)
	commit := normalizeCommit(cfg.Commit)
	h := &Handler{
		store:                   cfg.Store,
		logger:                  logger,
		maxPayloadBytes:         maxPayload,
		corsOrigins:             map[string]struct{}{},
		storageBackend:          storageBackend,
		retentionDays:           cfg.RetentionDays,
		version:                 version,
		commit:                  commit,
		strictClientCommit:      cfg.StrictClientCommit,
		terms:                   NormalizeTerms(cfg.Terms),
		requireVaultAuth:        !cfg.AllowAnonymousVaults,
		requirePreconditions:    requirePreconditions,
		rateLimitPerIPMinute:    rateLimitPerIP,
		rateLimitPerVaultMinute: rateLimitPerVault,
		createLimitPerIPMinute:  createLimitPerIPMinute,
		createLimitPerIPHour:    createLimitPerIPHour,
		maxTotalStoredBytes:     cfg.MaxTotalStoredBytes,
		maxVaultCount:           cfg.MaxVaultCount,
		trustedProxies:          trustedProxies,
		clientIPHeaders:         clientIPHeaders,
		limiter:                 newRateLimiter(),
	}
	for _, origin := range cfg.CORSOrigins {
		origin = strings.TrimRight(strings.TrimSpace(origin), "/")
		if origin == "" {
			continue
		}
		if origin == "*" && !cfg.AllowWildcardCORS {
			logger.Warn("ignoring wildcard CORS origin; set TRAEKY_ALLOW_WILDCARD_CORS=true only for isolated development")
			continue
		}
		h.corsOrigins[origin] = struct{}{}
	}
	mux.Handle(apiBasePath, h)
	mux.HandleFunc("/health", h.health)
	mux.HandleFunc(apiBasePath+"health", h.health)
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.applySecurityHeaders(w)
	h.applyCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	path := strings.TrimPrefix(r.URL.Path, apiBasePath)
	if path == "health" {
		h.health(w, r)
		return
	}
	if path == "info" && r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, map[string]any{
			// Keep this response intentionally minimal. It is fetched by the web
			// dashboard before sync configuration and should not disclose cloud
			// deployment internals such as storage backend, quotas, rate limits,
			// or proxy topology. Retention is intentionally exposed because users
			// need it to understand how long inactive Cloud Connect data is kept.
			"version":                 "5",
			"traeky_version":          h.version,
			"commit":                  h.commit,
			"strict_client_commit":    h.strictClientCommit,
			"inactive_retention_days": h.retentionDays,
			"terms":                   h.terms,
		})
		return
	}

	vaultID, ok := parseVaultPath(path)
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "resource not found")
		return
	}
	if !h.enforceClientCompatibility(w, r) {
		return
	}
	if !h.allowVaultRequest(w, r, vaultID) {
		return
	}

	switch r.Method {
	case http.MethodGet:
		h.getVault(w, r, vaultID)
	case http.MethodPut:
		h.putVault(w, r, vaultID)
	case http.MethodDelete:
		h.deleteVault(w, r, vaultID)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
	}
}

func (h *Handler) health(w http.ResponseWriter, r *http.Request) {
	h.applySecurityHeaders(w)
	h.applyCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	storeStatus := "ok"
	if checker, ok := h.store.(healthCheckStore); ok {
		if err := checker.HealthCheck(ctx); err != nil {
			storeStatus = "error"
		}
	}
	status := "ok"
	httpStatus := http.StatusOK
	if storeStatus != "ok" {
		status = "error"
		httpStatus = http.StatusServiceUnavailable
	}
	body := map[string]any{
		// Public health is intentionally terse. The HTTP status code carries the
		// detailed liveness result without exposing backend type, error strings,
		// build metadata, or retention policy to browsers and unauthenticated probes.
		"status": status,
	}
	if r.Method == http.MethodHead {
		w.WriteHeader(httpStatus)
		return
	}
	writeJSON(w, httpStatus, body)
}

func parseVaultPath(path string) (string, bool) {
	const prefix = "vaults/"
	if !strings.HasPrefix(path, prefix) {
		return "", false
	}
	rest := strings.TrimPrefix(path, prefix)
	if strings.Contains(rest, "/") || rest == "" {
		return "", false
	}
	return rest, true
}

func (h *Handler) getVault(w http.ResponseWriter, r *http.Request, vaultID string) {
	vault, err := h.store.Get(vaultID, vaultAuth(r), h.requireVaultAuth)
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	w.Header().Set("ETag", fmt.Sprintf("\"%d\"", vault.Revision))
	writeJSON(w, http.StatusOK, toResponse(vault, true))
}

func (h *Handler) putVault(w http.ResponseWriter, r *http.Request, vaultID string) {
	defer r.Body.Close()
	r.Body = http.MaxBytesReader(w, r.Body, h.maxPayloadBytes)
	var req putRequest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid encrypted vault payload")
		return
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		writeError(w, http.StatusBadRequest, "bad_request", "request body must contain exactly one json object")
		return
	}
	if len(req.Body) == 0 || !json.Valid(req.Body) {
		writeError(w, http.StatusBadRequest, "bad_request", "body must be valid encrypted json")
		return
	}

	createOnly := strings.TrimSpace(r.Header.Get("If-None-Match")) == "*"
	var expected *int64
	if match := strings.TrimSpace(r.Header.Get("If-Match")); match != "" {
		parsed, ok := parseRevisionPrecondition(w, match)
		if !ok {
			return
		}
		expected = parsed
	}
	if createOnly && expected != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "use either If-None-Match or If-Match, not both")
		return
	}
	if h.requirePreconditions && !createOnly && expected == nil {
		writeError(w, http.StatusPreconditionRequired, "precondition_required", "PUT requires If-None-Match: * for create or numeric If-Match for update")
		return
	}
	if createOnly && !h.allowVaultCreate(w, r) {
		return
	}

	h.writeMu.Lock()
	defer h.writeMu.Unlock()
	if !h.enforceStorageQuota(w, r, vaultID, req.Body, createOnly) {
		return
	}

	vault, err := h.store.Put(vaultID, expected, createOnly, req.Body, req.ClientID, req.DeviceName, vaultAuth(r), nextVaultAuth(r), h.requireVaultAuth)
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	w.Header().Set("ETag", fmt.Sprintf("\"%d\"", vault.Revision))
	status := http.StatusOK
	if vault.Revision == 1 {
		status = http.StatusCreated
	}
	writeJSON(w, status, toResponse(vault, true))
}

func (h *Handler) deleteVault(w http.ResponseWriter, r *http.Request, vaultID string) {
	expected, ok := parseDeletePrecondition(w, r.Header.Get("If-Match"), h.requirePreconditions)
	if !ok {
		return
	}
	err := h.store.Delete(vaultID, expected, vaultAuth(r), h.requireVaultAuth, h.requirePreconditions)
	if err != nil {
		h.writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func normalizeVersion(value string) string {
	version := strings.TrimSpace(value)
	version = strings.TrimPrefix(version, "v")
	version = strings.TrimPrefix(version, "V")
	return version
}

func normalizeCommit(value string) string {
	return strings.TrimSpace(value)
}

func shortCommit(value string) string {
	commit := normalizeCommit(value)
	if len(commit) > 7 {
		return commit[:7]
	}
	return commit
}

func firstHeader(r *http.Request, names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(r.Header.Get(name)); value != "" {
			return value
		}
	}
	return ""
}

func (h *Handler) enforceClientCompatibility(w http.ResponseWriter, r *http.Request) bool {
	if h.version == "" {
		return true
	}
	clientVersion := normalizeVersion(firstHeader(r, "X-Traeky-Client-Version", "X-Traeky-Version"))
	if clientVersion == "" {
		writeError(w, http.StatusUpgradeRequired, "version_required", "sync requires a Traeky dashboard version header")
		return false
	}
	if clientVersion != h.version {
		writeError(w, http.StatusUpgradeRequired, "version_mismatch", fmt.Sprintf("dashboard version %s is not compatible with cloud version %s", clientVersion, h.version))
		return false
	}
	if h.strictClientCommit {
		clientCommit := normalizeCommit(firstHeader(r, "X-Traeky-Client-Commit", "X-Traeky-Commit"))
		if h.commit == "" {
			writeError(w, http.StatusUpgradeRequired, "commit_required", "cloud commit is not configured for strict commit matching")
			return false
		}
		if clientCommit == "" {
			writeError(w, http.StatusUpgradeRequired, "commit_required", "sync requires a Traeky dashboard commit header")
			return false
		}
		if clientCommit != h.commit {
			writeError(w, http.StatusUpgradeRequired, "commit_mismatch", "dashboard commit is not compatible with this cloud server")
			return false
		}
	}
	return true
}

func (h *Handler) writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalidID):
		writeError(w, http.StatusBadRequest, "invalid_vault_id", "invalid vault id")
	case errors.Is(err, ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "vault not found")
	case errors.Is(err, ErrOccupied):
		writeError(w, http.StatusConflict, "vault_occupied", "vault key is already occupied")
	case errors.Is(err, ErrConflict):
		writeError(w, http.StatusConflict, "conflict", "revision conflict")
	case errors.Is(err, ErrPreconditionRequired):
		writeError(w, http.StatusPreconditionRequired, "precondition_required", "numeric If-Match revision is required")
	case errors.Is(err, ErrUnauthorized):
		writeError(w, http.StatusUnauthorized, "unauthorized", "vault auth secret is missing or invalid")
	case errors.Is(err, ErrQuotaExceeded):
		writeError(w, http.StatusInsufficientStorage, "quota_exceeded", "cloud storage quota exceeded")
	default:
		h.logger.Error("cloud error", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "internal server error")
	}
}

func (h *Handler) applySecurityHeaders(w http.ResponseWriter) {
	header := w.Header()
	header.Set("Cache-Control", "no-store")
	header.Set("Pragma", "no-cache")
	header.Set("X-Robots-Tag", "noindex, nofollow")
}

func (h *Handler) applyCORS(w http.ResponseWriter, r *http.Request) {
	if len(h.corsOrigins) == 0 {
		return
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return
	}
	if _, ok := h.corsOrigins[origin]; !ok {
		if _, wildcard := h.corsOrigins["*"]; !wildcard {
			return
		}
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, PUT, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, If-Match, If-None-Match, X-Traeky-Vault-Auth, X-Traeky-New-Vault-Auth, X-Traeky-Client-Version, X-Traeky-Version, X-Traeky-Client-Commit, X-Traeky-Commit")
	w.Header().Set("Access-Control-Expose-Headers", "ETag")
}

func toResponse(v EncryptedVault, includeBody bool) response {
	res := response{
		VaultID:      v.VaultID,
		Revision:     v.Revision,
		UpdatedAt:    v.UpdatedAt.Format("2006-01-02T15:04:05Z07:00"),
		ClientID:     v.ClientID,
		DeviceName:   v.DeviceName,
		AuthRequired: v.AuthRequired,
	}
	if includeBody {
		res.Body = v.Body
	}
	return res
}

func vaultAuth(r *http.Request) string {
	return strings.TrimSpace(r.Header.Get("X-Traeky-Vault-Auth"))
}

func nextVaultAuth(r *http.Request) string {
	return strings.TrimSpace(r.Header.Get("X-Traeky-New-Vault-Auth"))
}

func authMode(requireAuth bool) string {
	if requireAuth {
		return "required_vault_secret"
	}
	return "optional_vault_secret"
}

func parseRevisionPrecondition(w http.ResponseWriter, value string) (*int64, bool) {
	match := strings.Trim(strings.TrimSpace(value), "\"")
	if match == "" || match == "*" {
		writeError(w, http.StatusBadRequest, "bad_request", "If-Match must be a numeric revision")
		return nil, false
	}
	n, err := strconv.ParseInt(match, 10, 64)
	if err != nil || n <= 0 {
		writeError(w, http.StatusBadRequest, "bad_request", "If-Match must be a positive numeric revision")
		return nil, false
	}
	return &n, true
}

func parseDeletePrecondition(w http.ResponseWriter, value string, required bool) (*int64, bool) {
	if strings.TrimSpace(value) == "" {
		if required {
			writeError(w, http.StatusPreconditionRequired, "precondition_required", "DELETE requires numeric If-Match")
			return nil, false
		}
		return nil, true
	}
	return parseRevisionPrecondition(w, value)
}

func (h *Handler) enforceStorageQuota(w http.ResponseWriter, r *http.Request, vaultID string, body json.RawMessage, createOnly bool) bool {
	if h.maxTotalStoredBytes <= 0 && h.maxVaultCount <= 0 {
		return true
	}
	usage, err := h.store.Usage()
	if err != nil {
		h.logger.Error("cloud quota usage check failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "internal server error")
		return false
	}

	oldSize := int64(0)
	exists := false
	if existing, err := h.store.Get(vaultID, vaultAuth(r), h.requireVaultAuth); err == nil {
		oldSize = int64(len(existing.Body))
		exists = true
	} else if err != nil && !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrUnauthorized) {
		h.writeStoreError(w, err)
		return false
	}

	projectedVaultCount := usage.VaultCount
	if createOnly && !exists {
		projectedVaultCount++
	}
	if h.maxVaultCount > 0 && projectedVaultCount > h.maxVaultCount {
		writeError(w, http.StatusInsufficientStorage, "quota_exceeded", "cloud vault quota exceeded")
		return false
	}

	projectedBytes := usage.BodyBytes - oldSize + int64(len(body))
	// If the existing vault could not be read because auth failed, do not subtract
	// its old size. The subsequent write will still be rejected by Store.Put; this
	// conservative quota calculation avoids leaking whether a protected vault exists.
	if projectedBytes < 0 {
		projectedBytes = int64(len(body))
	}
	if h.maxTotalStoredBytes > 0 && projectedBytes > h.maxTotalStoredBytes {
		writeError(w, http.StatusInsufficientStorage, "quota_exceeded", "cloud storage quota exceeded")
		return false
	}
	return true
}

func (h *Handler) allowVaultCreate(w http.ResponseWriter, r *http.Request) bool {
	if h.limiter == nil {
		return true
	}
	ip := h.clientIP(r)
	if !h.limiter.allow("create_minute:"+ip, h.createLimitPerIPMinute, time.Minute) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "too many vault create attempts")
		return false
	}
	if !h.limiter.allow("create_hour:"+ip, h.createLimitPerIPHour, time.Hour) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "too many vault create attempts")
		return false
	}
	return true
}

func (h *Handler) allowVaultRequest(w http.ResponseWriter, r *http.Request, vaultID string) bool {
	if h.limiter == nil {
		return true
	}
	ip := h.clientIP(r)
	if !h.limiter.allow("ip:"+ip, h.rateLimitPerIPMinute, time.Minute) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "too many requests")
		return false
	}
	if !h.limiter.allow("vault:"+ip+":"+vaultID, h.rateLimitPerVaultMinute, time.Minute) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "too many requests for this vault")
		return false
	}
	return true
}

func (h *Handler) clientIP(r *http.Request) string {
	remote := remoteAddrIP(r.RemoteAddr)
	if remote == "" {
		return "unknown"
	}
	if !isTrustedProxy(remote, h.trustedProxies) {
		return remote
	}
	if headerIP, ok := forwardedHeaderIP(r, h.clientIPHeaders); ok {
		return headerIP
	}
	return remote
}

func remoteAddrIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil || host == "" {
		host = remoteAddr
	}
	addr, err := netip.ParseAddr(strings.Trim(host, "[]"))
	if err != nil {
		return strings.TrimSpace(host)
	}
	return addr.Unmap().String()
}

func isTrustedProxy(ip string, trusted []netip.Prefix) bool {
	if len(trusted) == 0 {
		return false
	}
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return false
	}
	addr = addr.Unmap()
	for _, prefix := range trusted {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

func forwardedHeaderIP(r *http.Request, names []string) (string, bool) {
	for _, name := range names {
		value := strings.TrimSpace(r.Header.Get(name))
		if value == "" {
			continue
		}
		var candidates []string
		switch strings.ToLower(name) {
		case "x-forwarded-for":
			candidates = strings.Split(value, ",")
		case "forwarded":
			candidates = forwardedForValues(value)
		default:
			candidates = []string{value}
		}
		for _, candidate := range candidates {
			if ip, ok := normalizeForwardedIP(candidate); ok {
				return ip, true
			}
		}
	}
	return "", false
}

func forwardedForValues(value string) []string {
	var out []string
	for _, entry := range strings.Split(value, ",") {
		for _, part := range strings.Split(entry, ";") {
			part = strings.TrimSpace(part)
			if strings.HasPrefix(strings.ToLower(part), "for=") {
				out = append(out, strings.TrimSpace(part[4:]))
			}
		}
	}
	return out
}

func normalizeForwardedIP(value string) (string, bool) {
	value = strings.TrimSpace(value)
	value = strings.Trim(value, "\"")
	value = strings.TrimPrefix(value, "[")
	if strings.Contains(value, "]") {
		value = strings.SplitN(value, "]", 2)[0]
	} else if host, _, err := net.SplitHostPort(value); err == nil {
		value = host
	}
	addr, err := netip.ParseAddr(strings.Trim(value, "[]"))
	if err != nil {
		return "", false
	}
	return addr.Unmap().String(), true
}

func parseTrustedProxyCIDRs(values []string, logger *slog.Logger) []netip.Prefix {
	var prefixes []netip.Prefix
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if addr, err := netip.ParseAddr(value); err == nil {
			addr = addr.Unmap()
			prefixes = append(prefixes, netip.PrefixFrom(addr, addr.BitLen()))
			continue
		}
		prefix, err := netip.ParsePrefix(value)
		if err != nil {
			if logger != nil {
				logger.Warn("ignoring invalid trusted proxy CIDR", "cidr", value)
			}
			continue
		}
		prefixes = append(prefixes, prefix.Masked())
	}
	return prefixes
}

func normalizeClientIPHeaders(values []string) []string {
	if len(values) == 0 {
		return []string{"CF-Connecting-IP", "True-Client-IP", "X-Forwarded-For", "X-Real-IP", "Forwarded"}
	}
	allowed := map[string]string{
		"cf-connecting-ip": "CF-Connecting-IP",
		"true-client-ip":   "True-Client-IP",
		"x-forwarded-for":  "X-Forwarded-For",
		"x-real-ip":        "X-Real-IP",
		"forwarded":        "Forwarded",
	}
	out := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		key := strings.ToLower(strings.TrimSpace(value))
		canonical, ok := allowed[key]
		if !ok {
			continue
		}
		if _, exists := seen[canonical]; exists {
			continue
		}
		seen[canonical] = struct{}{}
		out = append(out, canonical)
	}
	if len(out) == 0 {
		return []string{"X-Forwarded-For"}
	}
	return out
}

type rateBucket struct {
	reset time.Time
	count int
}

const maxRateLimiterBuckets = 10_000

type rateLimiter struct {
	mu         sync.Mutex
	buckets    map[string]rateBucket
	maxBuckets int
}

func newRateLimiter() *rateLimiter {
	return &rateLimiter{buckets: map[string]rateBucket{}, maxBuckets: maxRateLimiterBuckets}
}

func (l *rateLimiter) allow(key string, limit int, window time.Duration) bool {
	if l == nil || limit <= 0 || window <= 0 {
		return true
	}
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.buckets == nil {
		l.buckets = map[string]rateBucket{}
	}
	maxBuckets := l.maxBuckets
	if maxBuckets <= 0 {
		maxBuckets = maxRateLimiterBuckets
	}
	b, exists := l.buckets[key]
	if !exists && len(l.buckets) >= maxBuckets {
		l.pruneExpired(now)
		for len(l.buckets) >= maxBuckets {
			l.evictOldest()
		}
	}
	if b.reset.IsZero() || now.After(b.reset) {
		b = rateBucket{reset: now.Add(window), count: 0}
	}
	b.count++
	l.buckets[key] = b
	return b.count <= limit
}

func (l *rateLimiter) pruneExpired(now time.Time) {
	for k, v := range l.buckets {
		if now.After(v.reset) {
			delete(l.buckets, k)
		}
	}
}

func (l *rateLimiter) evictOldest() {
	var oldestKey string
	var oldestReset time.Time
	for k, v := range l.buckets {
		if oldestKey == "" || v.reset.Before(oldestReset) {
			oldestKey = k
			oldestReset = v.reset
		}
	}
	if oldestKey != "" {
		delete(l.buckets, oldestKey)
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}
