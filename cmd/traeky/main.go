package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/pandabytelabs/traeky/internal/buildinfo"
	"github.com/pandabytelabs/traeky/internal/cloud"
	"github.com/pandabytelabs/traeky/internal/web"
)

var (
	version = ""
	commit  = "dev"
)

func defaultVersion() string {
	if strings.TrimSpace(version) != "" {
		return version
	}
	return buildinfo.Version()
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(runHealthcheck())
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	addr := env("TRAEKY_ADDR", ":8080")
	mode := strings.ToLower(env("TRAEKY_MODE", "all"))
	dataDir := env("TRAEKY_DATA_DIR", "./data")
	storeBackend := strings.ToLower(env("TRAEKY_CLOUD_STORE", env("TRAEKY_STORE", "file")))
	retentionDays := int(envInt64("TRAEKY_INACTIVE_RETENTION_DAYS", envInt64("TRAEKY_CLOUD_RETENTION_DAYS", 0)))
	allowAnonymousVaults := envBool("TRAEKY_ALLOW_ANONYMOUS_VAULTS", false) || !envBool("TRAEKY_REQUIRE_VAULT_AUTH", true)
	allowWildcardCORS := envBool("TRAEKY_ALLOW_WILDCARD_CORS", false)
	allowMissingPreconditions := envBool("TRAEKY_ALLOW_MISSING_PRECONDITIONS", false)
	tlsCertFile := env("TRAEKY_TLS_CERT_FILE", "")
	tlsKeyFile := env("TRAEKY_TLS_KEY_FILE", "")
	trustedProxyCIDRs := splitCSV(os.Getenv("TRAEKY_TRUSTED_PROXIES"))
	trustedProxies := parseTrustedProxyCIDRs(trustedProxyCIDRs, logger)
	appVersion := env("TRAEKY_VERSION", defaultVersion())
	appCommit := env("TRAEKY_COMMIT", env("TRAEKY_COMMIT_SHORT", commit))
	cloudTerms := cloud.NormalizeTerms(cloud.Terms{
		Version:          env("TRAEKY_CLOUD_TERMS_VERSION", ""),
		Title:            env("TRAEKY_CLOUD_TERMS_TITLE", ""),
		Body:             env("TRAEKY_CLOUD_DISCLAIMER", env("TRAEKY_CLOUD_TERMS", "")),
		PrivacyPolicyURL: env("TRAEKY_CLOUD_PRIVACY_POLICY_URL", env("TRAEKY_PRIVACY_POLICY_URL", "")),
		ImprintURL:       env("TRAEKY_CLOUD_IMPRINT_URL", env("TRAEKY_IMPRINT_URL", "")),
	})

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })

	switch mode {
	case "all", "app", "web", "dashboard":
		web.RegisterWithConfig(mux, logger, web.Config{
			Version:          appVersion,
			Commit:           appCommit,
			PrivacyPolicyURL: env("TRAEKY_DASHBOARD_PRIVACY_POLICY_URL", env("TRAEKY_APP_PRIVACY_POLICY_URL", env("TRAEKY_PRIVACY_POLICY_URL", ""))),
			ImprintURL:       env("TRAEKY_DASHBOARD_IMPRINT_URL", env("TRAEKY_APP_IMPRINT_URL", env("TRAEKY_IMPRINT_URL", ""))),
		})
	case "cloud":
		// Cloud-only mode registers only the health endpoint plus the Cloud API below.
	default:
		logger.Error("invalid TRAEKY_MODE", "mode", mode)
		os.Exit(2)
	}

	var closeStore func()
	var stopRetention func()
	if mode == "all" || mode == "cloud" {
		store, cleanup, err := initCloudStore(storeBackend, dataDir)
		if err != nil {
			logger.Error("failed to initialize cloud store", "backend", storeBackend, "err", err)
			os.Exit(1)
		}
		closeStore = cleanup
		defer closeStore()
		if retentionDays > 0 {
			stopRetention = startRetentionPurge(store, time.Duration(retentionDays)*24*time.Hour, logger)
			defer stopRetention()
		}
		if allowAnonymousVaults {
			logger.Warn("anonymous cloud vaults enabled; use only for isolated development")
		}
		if allowWildcardCORS {
			logger.Warn("wildcard CORS enabled; use only for isolated development")
		}
		if allowMissingPreconditions {
			logger.Warn("missing revision preconditions allowed; this weakens conflict and delete safety")
		}
		cloud.Register(mux, cloud.Config{
			Store:                     store,
			Logger:                    logger,
			Version:                   appVersion,
			Commit:                    appCommit,
			StrictClientCommit:        envBool("TRAEKY_CLOUD_STRICT_COMMIT", envBool("TRAEKY_STRICT_COMMIT_MATCH", false)),
			MaxPayloadBytes:           envInt64("TRAEKY_MAX_PAYLOAD_BYTES", 1024*1024),
			MaxTotalStoredBytes:       envInt64("TRAEKY_MAX_TOTAL_STORED_BYTES", 256*1024*1024),
			MaxVaultCount:             envInt64("TRAEKY_MAX_VAULT_COUNT", 10000),
			CORSOrigins:               splitCSV(os.Getenv("TRAEKY_CORS_ORIGINS")),
			StorageBackend:            storeBackend,
			RetentionDays:             retentionDays,
			Terms:                     cloudTerms,
			AllowAnonymousVaults:      allowAnonymousVaults,
			AllowWildcardCORS:         allowWildcardCORS,
			AllowMissingPreconditions: allowMissingPreconditions,
			RateLimitPerIPMinute:      int(envInt64("TRAEKY_RATE_LIMIT_PER_IP_MINUTE", 300)),
			RateLimitPerVaultMinute:   int(envInt64("TRAEKY_RATE_LIMIT_PER_VAULT_MINUTE", 90)),
			CreateLimitPerIPMinute:    int(envInt64("TRAEKY_CREATE_LIMIT_PER_IP_MINUTE", 20)),
			CreateLimitPerIPHour:      int(envInt64("TRAEKY_CREATE_LIMIT_PER_IP_HOUR", 100)),
			TrustedProxyCIDRs:         trustedProxyCIDRs,
			ClientIPHeaders:           splitCSV(os.Getenv("TRAEKY_CLIENT_IP_HEADERS")),
		})
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           securityHeaders(mux, trustedProxies),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       20 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelError),
	}

	go func() {
		logger.Info("traeky listening", "addr", addr, "mode", mode, "cloud_store", storeBackend, "data_dir", dataDir)
		var err error
		switch {
		case tlsCertFile != "" && tlsKeyFile != "":
			err = srv.ListenAndServeTLS(tlsCertFile, tlsKeyFile)
		case tlsCertFile != "" || tlsKeyFile != "":
			err = fmt.Errorf("both TRAEKY_TLS_CERT_FILE and TRAEKY_TLS_KEY_FILE must be set")
		default:
			err = srv.ListenAndServe()
		}
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server stopped unexpectedly", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("graceful shutdown failed", "err", err)
		os.Exit(1)
	}
	logger.Info("server stopped")
}

func runHealthcheck() int {
	endpoint := strings.TrimSpace(os.Getenv("TRAEKY_HEALTHCHECK_URL"))
	if endpoint == "" {
		addr := env("TRAEKY_ADDR", ":8080")
		addr = strings.TrimPrefix(addr, "http://")
		addr = strings.TrimPrefix(addr, "https://")
		switch {
		case strings.HasPrefix(addr, ":"):
			addr = "127.0.0.1" + addr
		case strings.HasPrefix(addr, "0.0.0.0:"):
			addr = "127.0.0.1:" + strings.TrimPrefix(addr, "0.0.0.0:")
		case strings.HasPrefix(addr, "[::]:"):
			addr = "127.0.0.1:" + strings.TrimPrefix(addr, "[::]:")
		}
		endpoint = "http://" + addr + "/health"
	}
	client := &http.Client{Timeout: 4 * time.Second}
	res, err := client.Get(endpoint)
	if err != nil {
		fmt.Fprintf(os.Stderr, "healthcheck request failed: %v\n", err)
		return 1
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		fmt.Fprintf(os.Stderr, "healthcheck returned status %d\n", res.StatusCode)
		return 1
	}
	return 0
}

func startRetentionPurge(store cloud.Store, retention time.Duration, logger *slog.Logger) func() {
	ctx, cancel := context.WithCancel(context.Background())
	run := func() {
		cutoff := time.Now().UTC().Add(-retention)
		deleted, err := store.PurgeInactive(cutoff)
		if err != nil {
			logger.Error("inactive vault purge failed", "err", err)
			return
		}
		if deleted > 0 {
			logger.Info("inactive vaults purged", "count", deleted, "cutoff", cutoff.Format(time.RFC3339))
		}
	}
	go func() {
		run()
		ticker := time.NewTicker(6 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				run()
			}
		}
	}()
	return cancel
}

func initCloudStore(backend, dataDir string) (cloud.Store, func(), error) {
	switch backend {
	case "", "file", "filesystem", "fs":
		store, err := cloud.NewFileStore(dataDir)
		if err != nil {
			return nil, nil, err
		}
		return store, func() {}, nil
	case "postgres", "postgresql", "pg":
		databaseURL := env("TRAEKY_DATABASE_URL", "")
		if databaseURL == "" {
			return nil, nil, fmt.Errorf("TRAEKY_DATABASE_URL is required when TRAEKY_CLOUD_STORE=postgres")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		store, err := cloud.NewPostgresStoreWithOptions(ctx, databaseURL, cloud.PostgresOptions{
			AutoMigrate: envBool("TRAEKY_DB_AUTO_MIGRATE", true),
		})
		if err != nil {
			return nil, nil, err
		}
		return store, store.Close, nil
	default:
		return nil, nil, fmt.Errorf("unsupported TRAEKY_CLOUD_STORE %q", backend)
	}
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envInt64(key string, fallback int64) int64 {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	var n int64
	_, err := fmt.Sscanf(value, "%d", &n)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

func envBool(key string, fallback bool) bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	switch value {
	case "1", "true", "yes", "y", "on":
		return true
	case "0", "false", "no", "n", "off":
		return false
	case "":
		return fallback
	default:
		return fallback
	}
}

func splitCSV(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func securityHeaders(next http.Handler, trustedProxies []netip.Prefix) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), xr-spatial-tracking=()")
		h.Set("X-Frame-Options", "DENY")
		secureTransport := r.TLS != nil || (requestFromTrustedProxy(r, trustedProxies) && strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"))
		// connect-src allows any https: origin because Cloud Connect points the
		// dashboard at self-hosted servers whose hostnames are unknown at build
		// time. The localhost entries mirror normalizeCloudURL(), which permits
		// plain HTTP for loopback only. Code execution stays pinned to 'self'.
		csp := "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'"
		if secureTransport {
			csp += "; upgrade-insecure-requests"
		}
		h.Set("Content-Security-Policy", csp)
		if secureTransport {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload")
		}
		next.ServeHTTP(w, r)
	})
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
			logger.Warn("ignoring invalid trusted proxy CIDR", "cidr", value)
			continue
		}
		prefixes = append(prefixes, prefix.Masked())
	}
	return prefixes
}

func requestFromTrustedProxy(r *http.Request, trusted []netip.Prefix) bool {
	if len(trusted) == 0 {
		return false
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || host == "" {
		host = r.RemoteAddr
	}
	addr, err := netip.ParseAddr(strings.Trim(host, "[]"))
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
