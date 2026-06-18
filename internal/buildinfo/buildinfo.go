package buildinfo

import (
	_ "embed"
	"strings"
)

//go:embed version.txt
var defaultVersion string

// Version returns Traeky's canonical source version without a leading v.
func Version() string {
	version := strings.TrimSpace(defaultVersion)
	version = strings.TrimPrefix(version, "v")
	if version == "" {
		return "dev"
	}
	return version
}
