package cloud

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const authIterations = 210_000
const authSaltBytes = 16
const authHashBytes = 32

var vaultIDPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{31,191}$`)
var authProofPattern = regexp.MustCompile(`^ta1_[a-zA-Z0-9_-]{43}$`)

var (
	ErrNotFound             = errors.New("vault not found")
	ErrOccupied             = errors.New("vault key already occupied")
	ErrConflict             = errors.New("revision conflict")
	ErrInvalidID            = errors.New("invalid vault id")
	ErrUnauthorized         = errors.New("vault auth secret missing or invalid")
	ErrPreconditionRequired = errors.New("revision precondition required")
	ErrQuotaExceeded        = errors.New("cloud storage quota exceeded")
)

type EncryptedVault struct {
	VaultID      string          `json:"vault_id"`
	Revision     int64           `json:"revision"`
	UpdatedAt    time.Time       `json:"updated_at"`
	ClientID     string          `json:"client_id,omitempty"`
	DeviceName   string          `json:"device_name,omitempty"`
	AuthRequired bool            `json:"auth_required"`
	Body         json.RawMessage `json:"body"`
}

// StorageUsage describes opaque encrypted storage usage. BodyBytes counts only
// encrypted JSON payload bytes, not filesystem/database overhead.
type StorageUsage struct {
	VaultCount int64 `json:"vault_count"`
	BodyBytes  int64 `json:"body_bytes"`
}

type storedVault struct {
	VaultID        string          `json:"vault_id"`
	Revision       int64           `json:"revision"`
	UpdatedAt      time.Time       `json:"updated_at"`
	ClientID       string          `json:"client_id,omitempty"`
	Device         string          `json:"device_name,omitempty"`
	AuthRequired   bool            `json:"auth_required,omitempty"`
	AuthSalt       string          `json:"auth_salt,omitempty"`
	AuthHash       string          `json:"auth_hash,omitempty"`
	AuthIterations int             `json:"auth_iterations,omitempty"`
	Body           json.RawMessage `json:"body"`
}

type Store interface {
	Get(vaultID, authSecret string, requireAuth bool) (EncryptedVault, error)
	Put(vaultID string, expectedRevision *int64, createOnly bool, body json.RawMessage, clientID, deviceName, authSecret, nextAuthSecret string, requireAuth bool) (EncryptedVault, error)
	Delete(vaultID string, expectedRevision *int64, authSecret string, requireAuth bool, requirePrecondition bool) error
	PurgeInactive(cutoff time.Time) (int64, error)
	Usage() (StorageUsage, error)
}

type FileStore struct {
	dir string
	mu  sync.Mutex
}

func NewFileStore(dir string) (*FileStore, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, fmt.Errorf("data directory must not be empty")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &FileStore{dir: dir}, nil
}

func (s *FileStore) HealthCheck(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	info, err := os.Stat(s.dir)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("data path is not a directory")
	}
	tmp, err := os.CreateTemp(s.dir, ".traeky-health-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer func() { _ = os.Remove(name) }()
	if _, err := tmp.Write([]byte("ok")); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return nil
	}
}

func (s *FileStore) Get(vaultID, authSecret string, requireAuth bool) (EncryptedVault, error) {
	if !validVaultID(vaultID) {
		return EncryptedVault{}, ErrInvalidID
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	v, err := s.read(vaultID)
	if err != nil {
		return EncryptedVault{}, err
	}
	if err := authorizeVault(v, authSecret, requireAuth); err != nil {
		return EncryptedVault{}, err
	}
	return externalVault(v), nil
}

func (s *FileStore) Put(vaultID string, expectedRevision *int64, createOnly bool, body json.RawMessage, clientID, deviceName, authSecret, nextAuthSecret string, requireAuth bool) (EncryptedVault, error) {
	if !validVaultID(vaultID) {
		return EncryptedVault{}, ErrInvalidID
	}
	if !json.Valid(body) || len(body) == 0 {
		return EncryptedVault{}, fmt.Errorf("encrypted body must be valid json")
	}
	if err := validateAuthHeader(authSecret); err != nil {
		return EncryptedVault{}, err
	}
	if err := validateAuthHeader(nextAuthSecret); err != nil {
		return EncryptedVault{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	current, err := s.read(vaultID)
	switch {
	case errors.Is(err, ErrNotFound):
		if expectedRevision != nil && *expectedRevision != 0 {
			return EncryptedVault{}, ErrConflict
		}
		now := time.Now().UTC()
		created := storedVault{
			VaultID:   vaultID,
			Revision:  1,
			UpdatedAt: now,
			ClientID:  trimMax(clientID, 96),
			Device:    trimMax(deviceName, 160),
			Body:      cloneRaw(body),
		}
		initialAuth := strings.TrimSpace(authSecret)
		if initialAuth == "" {
			initialAuth = strings.TrimSpace(nextAuthSecret)
		}
		if requireAuth && initialAuth == "" {
			return EncryptedVault{}, ErrUnauthorized
		}
		if initialAuth != "" {
			if err := setVaultAuth(&created, initialAuth); err != nil {
				return EncryptedVault{}, err
			}
		}
		if err := s.write(created); err != nil {
			return EncryptedVault{}, err
		}
		return externalVault(created), nil
	case err != nil:
		return EncryptedVault{}, err
	}

	if createOnly || expectedRevision == nil {
		return EncryptedVault{}, ErrOccupied
	}
	if err := authorizeVault(current, authSecret, requireAuth); err != nil {
		return EncryptedVault{}, err
	}
	if *expectedRevision != current.Revision {
		return EncryptedVault{}, ErrConflict
	}
	current.Revision++
	current.UpdatedAt = time.Now().UTC()
	current.ClientID = trimMax(clientID, 96)
	current.Device = trimMax(deviceName, 160)
	current.Body = cloneRaw(body)

	// A previously unprotected vault can be upgraded by sending an auth secret.
	// A protected vault can rotate to a new auth secret only after proving the current one.
	if strings.TrimSpace(nextAuthSecret) != "" {
		if err := setVaultAuth(&current, nextAuthSecret); err != nil {
			return EncryptedVault{}, err
		}
	} else if !current.AuthRequired && strings.TrimSpace(authSecret) != "" {
		if err := setVaultAuth(&current, authSecret); err != nil {
			return EncryptedVault{}, err
		}
	}

	if err := s.write(current); err != nil {
		return EncryptedVault{}, err
	}
	return externalVault(current), nil
}

func (s *FileStore) Delete(vaultID string, expectedRevision *int64, authSecret string, requireAuth bool, requirePrecondition bool) error {
	if !validVaultID(vaultID) {
		return ErrInvalidID
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	v, err := s.read(vaultID)
	if err != nil {
		return err
	}
	if err := authorizeVaultDelete(v, authSecret, requireAuth); err != nil {
		return err
	}
	if expectedRevision == nil {
		if requirePrecondition {
			return ErrPreconditionRequired
		}
	} else if *expectedRevision != v.Revision {
		return ErrConflict
	}
	return os.Remove(s.path(vaultID))
}

func (s *FileStore) PurgeInactive(cutoff time.Time) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return 0, err
	}
	var deleted int64
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		vaultID := strings.TrimSuffix(entry.Name(), ".json")
		v, err := s.read(vaultID)
		if err != nil {
			continue
		}
		if v.UpdatedAt.Before(cutoff) {
			if err := os.Remove(s.path(vaultID)); err != nil && !errors.Is(err, os.ErrNotExist) {
				return deleted, err
			}
			deleted++
		}
	}
	return deleted, nil
}

func (s *FileStore) Usage() (StorageUsage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return StorageUsage{}, err
	}
	var usage StorageUsage
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		vaultID := strings.TrimSuffix(entry.Name(), ".json")
		v, err := s.read(vaultID)
		if err != nil {
			continue
		}
		usage.VaultCount++
		usage.BodyBytes += int64(len(v.Body))
	}
	return usage, nil
}

func (s *FileStore) path(vaultID string) string {
	return filepath.Join(s.dir, vaultID+".json")
}

func (s *FileStore) read(vaultID string) (storedVault, error) {
	b, err := os.ReadFile(s.path(vaultID))
	if errors.Is(err, os.ErrNotExist) {
		return storedVault{}, ErrNotFound
	}
	if err != nil {
		return storedVault{}, err
	}
	var v storedVault
	if err := json.Unmarshal(b, &v); err != nil {
		return storedVault{}, err
	}
	if v.VaultID != vaultID || v.Revision <= 0 || !json.Valid(v.Body) {
		return storedVault{}, fmt.Errorf("stored vault is corrupt")
	}
	if err := validateStoredVaultAuthMetadata(v); err != nil {
		return storedVault{}, err
	}
	return v, nil
}

func (s *FileStore) write(v storedVault) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.dir, v.VaultID+"-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, s.path(v.VaultID))
}

func externalVault(v storedVault) EncryptedVault {
	return EncryptedVault{
		VaultID:      v.VaultID,
		Revision:     v.Revision,
		UpdatedAt:    v.UpdatedAt,
		ClientID:     v.ClientID,
		DeviceName:   v.Device,
		AuthRequired: v.AuthRequired,
		Body:         cloneRaw(v.Body),
	}
}

func validVaultID(vaultID string) bool {
	return vaultIDPattern.MatchString(vaultID)
}

func cloneRaw(in json.RawMessage) json.RawMessage {
	out := make([]byte, len(in))
	copy(out, in)
	return out
}

func trimMax(value string, max int) string {
	value = strings.TrimSpace(value)
	if len(value) <= max {
		return value
	}
	return value[:max]
}

func validateAuthHeader(value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	if len(value) > 512 || !authProofPattern.MatchString(value) {
		return ErrUnauthorized
	}
	return nil
}

func setVaultAuth(v *storedVault, authSecret string) error {
	authSecret = strings.TrimSpace(authSecret)
	if authSecret == "" {
		return nil
	}
	if err := validateAuthHeader(authSecret); err != nil {
		return err
	}
	salt := make([]byte, authSaltBytes)
	if _, err := rand.Read(salt); err != nil {
		return err
	}
	hash := pbkdf2SHA256([]byte(authSecret), salt, authIterations, authHashBytes)
	v.AuthRequired = true
	v.AuthSalt = base64.RawStdEncoding.EncodeToString(salt)
	v.AuthHash = base64.RawStdEncoding.EncodeToString(hash)
	v.AuthIterations = authIterations
	return nil
}

func authorizeVault(v storedVault, authSecret string, requireAuth bool) error {
	if !v.AuthRequired {
		if requireAuth {
			return ErrUnauthorized
		}
		return nil
	}
	return verifyVaultAuth(v, authSecret)
}

func authorizeVaultDelete(v storedVault, authSecret string, requireAuth bool) error {
	if !v.AuthRequired {
		return ErrUnauthorized
	}
	return verifyVaultAuth(v, authSecret)
}

func verifyVaultAuth(v storedVault, authSecret string) error {
	authSecret = strings.TrimSpace(authSecret)
	if authSecret == "" {
		return ErrUnauthorized
	}
	if err := validateAuthHeader(authSecret); err != nil {
		return err
	}
	if err := validateStoredVaultAuthMetadata(v); err != nil {
		return err
	}
	salt, err := base64.RawStdEncoding.DecodeString(v.AuthSalt)
	if err != nil {
		return fmt.Errorf("stored vault auth salt is corrupt")
	}
	expected, err := base64.RawStdEncoding.DecodeString(v.AuthHash)
	if err != nil {
		return fmt.Errorf("stored vault auth hash is corrupt")
	}
	candidate := pbkdf2SHA256([]byte(authSecret), salt, authIterations, authHashBytes)
	if subtle.ConstantTimeCompare(candidate, expected) != 1 {
		return ErrUnauthorized
	}
	return nil
}

func validateStoredVaultAuthMetadata(v storedVault) error {
	if !v.AuthRequired {
		return nil
	}
	if v.AuthSalt == "" || v.AuthHash == "" || v.AuthIterations != authIterations {
		return fmt.Errorf("stored vault auth metadata is corrupt")
	}
	if len(v.AuthSalt) != base64.RawStdEncoding.EncodedLen(authSaltBytes) || len(v.AuthHash) != base64.RawStdEncoding.EncodedLen(authHashBytes) {
		return fmt.Errorf("stored vault auth metadata is corrupt")
	}
	salt, err := base64.RawStdEncoding.DecodeString(v.AuthSalt)
	if err != nil || len(salt) != authSaltBytes {
		return fmt.Errorf("stored vault auth salt is corrupt")
	}
	hash, err := base64.RawStdEncoding.DecodeString(v.AuthHash)
	if err != nil || len(hash) != authHashBytes {
		return fmt.Errorf("stored vault auth hash is corrupt")
	}
	return nil
}

func pbkdf2SHA256(password, salt []byte, iterations, keyLen int) []byte {
	if iterations <= 0 || keyLen <= 0 {
		return nil
	}
	const hLen = 32
	numBlocks := (keyLen + hLen - 1) / hLen
	out := make([]byte, 0, numBlocks*hLen)
	var blockIndex [4]byte
	for block := 1; block <= numBlocks; block++ {
		binary.BigEndian.PutUint32(blockIndex[:], uint32(block))
		mac := hmac.New(sha256.New, password)
		mac.Write(salt)
		mac.Write(blockIndex[:])
		u := mac.Sum(nil)
		t := make([]byte, len(u))
		copy(t, u)
		for i := 1; i < iterations; i++ {
			mac = hmac.New(sha256.New, password)
			mac.Write(u)
			u = mac.Sum(nil)
			for j := range t {
				t[j] ^= u[j]
			}
		}
		out = append(out, t...)
	}
	return out[:keyLen]
}
