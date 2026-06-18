package web

import (
	"embed"
	"encoding/json"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"strings"

	"github.com/pandabytelabs/traeky/internal/buildinfo"
)

// cacheKey returns a short string used for cache-busting app.js.
// It prefers the commit hash (changes every deploy), falls back to the
// version string (changes every release), and falls back to empty string
// (no cache-busting, development mode without version info).
func cacheKey(version, commit string) string {
	if c := shortCommit(commit); c != "" {
		return c
	}
	return appVersion(version)
}

//go:embed static/*
var staticFiles embed.FS

type Config struct {
	Version          string
	Commit           string
	PrivacyPolicyURL string
	ImprintURL       string
}

type appInfoResponse struct {
	Version          string `json:"version"`
	Commit           string `json:"commit,omitempty"`
	CommitShort      string `json:"commit_short,omitempty"`
	PrivacyPolicyURL string `json:"privacy_policy_url,omitempty"`
	ImprintURL       string `json:"imprint_url,omitempty"`
}

func Register(mux *http.ServeMux, logger *slog.Logger) {
	RegisterWithConfig(mux, logger, Config{})
}

func RegisterWithConfig(mux *http.ServeMux, logger *slog.Logger, cfg Config) {
	sub, err := fs.Sub(staticFiles, "static")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(sub))
	ck := cacheKey(cfg.Version, cfg.Commit)

	mux.HandleFunc("/api/app/info", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(appInfoResponse{
			Version:          appVersion(cfg.Version),
			Commit:           strings.TrimSpace(cfg.Commit),
			CommitShort:      shortCommit(cfg.Commit),
			PrivacyPolicyURL: normalizePublicURL(cfg.PrivacyPolicyURL),
			ImprintURL:       normalizePublicURL(cfg.ImprintURL),
		})
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		requested := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if requested == "." || requested == "" {
			serveIndex(w, r, sub, ck)
			return
		}
		if _, err := fs.Stat(sub, requested); err == nil {
			setCachePolicy(w, requested)
			fileServer.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		logger.Debug("serving SPA fallback", "path", r.URL.Path)
		serveIndex(w, r, sub, ck)
	})
}

func appVersion(value string) string {
	version := strings.TrimSpace(value)
	if version == "" {
		return buildinfo.Version()
	}
	return strings.TrimPrefix(version, "v")
}

func shortCommit(value string) string {
	commit := strings.TrimSpace(value)
	if len(commit) > 7 {
		commit = commit[:7]
	}
	return commit
}

func serveIndex(w http.ResponseWriter, r *http.Request, sub fs.FS, ck string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if ck == "" {
		http.ServeFileFS(w, r, sub, "index.html")
		return
	}
	data, err := fs.ReadFile(sub, "index.html")
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	html := strings.ReplaceAll(string(data), `src="/app.js"`, `src="/app.js?v=`+ck+`"`)
	_, _ = w.Write([]byte(html))
}

func setCachePolicy(w http.ResponseWriter, requested string) {
	if requested == "index.html" || strings.HasSuffix(requested, ".html") {
		w.Header().Set("Cache-Control", "no-store")
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=3600")
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
