package cloud

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestFileStorePutGetWithAnonymousVaultKey(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	vaultKey := "vault_1234567890abcdefghijklmnopqrstuv"
	body := json.RawMessage(`{"format":"traeky-vault","ciphertext":"opaque"}`)
	created, err := store.Put(vaultKey, nil, true, body, "client", "device", "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if created.Revision != 1 {
		t.Fatalf("revision = %d, want 1", created.Revision)
	}

	got, err := store.Get(vaultKey, "", false)
	if err != nil {
		t.Fatal(err)
	}
	var gotMap map[string]string
	if err := json.Unmarshal(got.Body, &gotMap); err != nil {
		t.Fatal(err)
	}
	if gotMap["ciphertext"] != "opaque" {
		t.Fatalf("ciphertext = %q, want opaque", gotMap["ciphertext"])
	}

	if _, err := store.Put(vaultKey, nil, true, body, "", "", "", "", false); !errors.Is(err, ErrOccupied) {
		t.Fatalf("collision err = %v, want ErrOccupied", err)
	}
}

func TestFileStoreRevisionConflict(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	vaultKey := "vault_abcdef1234567890abcdefghijklmnop"
	body := json.RawMessage(`{"ciphertext":"a"}`)
	if _, err := store.Put(vaultKey, nil, true, body, "", "", "", "", false); err != nil {
		t.Fatal(err)
	}
	expected := int64(99)
	if _, err := store.Put(vaultKey, &expected, false, body, "", "", "", "", false); !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v, want ErrConflict", err)
	}
	expected = 1
	updated, err := store.Put(vaultKey, &expected, false, json.RawMessage(`{"ciphertext":"b"}`), "", "", "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Revision != 2 {
		t.Fatalf("revision = %d, want 2", updated.Revision)
	}
}

func TestFileStoreRejectsInvalidVaultID(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Put("../bad", nil, true, json.RawMessage(`{"x":1}`), "", "", "", "", false); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("err = %v, want ErrInvalidID", err)
	}
}

func TestFileStoreVaultAuthProtectsReadAndWrite(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	vaultKey := "vault_auth1234567890abcdefghijklmnop"
	body := json.RawMessage(`{"ciphertext":"a"}`)
	created, err := store.Put(vaultKey, nil, true, body, "", "", testAuthProof("primary"), "", true)
	if err != nil {
		t.Fatal(err)
	}
	if !created.AuthRequired {
		t.Fatal("created vault should require auth")
	}
	if _, err := store.Get(vaultKey, "", false); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("unauthenticated get err = %v, want ErrUnauthorized", err)
	}
	if _, err := store.Get(vaultKey, testAuthProof("wrong"), true); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("wrong auth get err = %v, want ErrUnauthorized", err)
	}
	if _, err := store.Get(vaultKey, testAuthProof("primary"), true); err != nil {
		t.Fatalf("authenticated get err = %v", err)
	}
	expected := int64(1)
	if _, err := store.Put(vaultKey, &expected, false, body, "", "", testAuthProof("wrong"), "", true); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("wrong auth update err = %v, want ErrUnauthorized", err)
	}
}

func TestFileStoreCanRotateVaultAuth(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	vaultKey := "vault_rotate1234567890abcdefghijklmn"
	body := json.RawMessage(`{"ciphertext":"a"}`)
	if _, err := store.Put(vaultKey, nil, true, body, "", "", testAuthProof("old"), "", true); err != nil {
		t.Fatal(err)
	}
	expected := int64(1)
	if _, err := store.Put(vaultKey, &expected, false, json.RawMessage(`{"ciphertext":"b"}`), "", "", testAuthProof("old"), testAuthProof("new"), true); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(vaultKey, testAuthProof("old"), true); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("old auth err = %v, want ErrUnauthorized", err)
	}
	if _, err := store.Get(vaultKey, testAuthProof("new"), true); err != nil {
		t.Fatalf("new auth err = %v", err)
	}
}

func TestFileStorePurgeInactive(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	vaultKey := "vault_purge1234567890abcdefghijklmn"
	if _, err := store.Put(vaultKey, nil, true, json.RawMessage(`{"ciphertext":"a"}`), "", "", "", "", false); err != nil {
		t.Fatal(err)
	}
	v, err := store.read(vaultKey)
	if err != nil {
		t.Fatal(err)
	}
	v.UpdatedAt = time.Now().UTC().Add(-48 * time.Hour)
	if err := store.write(v); err != nil {
		t.Fatal(err)
	}
	deleted, err := store.PurgeInactive(time.Now().UTC().Add(-24 * time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if deleted != 1 {
		t.Fatalf("deleted = %d, want 1", deleted)
	}
	if _, err := store.Get(vaultKey, "", false); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get after purge err = %v, want ErrNotFound", err)
	}
}

func TestFileStoreDeleteRequiresAuthProtectedVault(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	vaultKey := "vault_delete_auth1234567890abcdefghijkl"
	body := json.RawMessage(`{"ciphertext":"a"}`)
	if _, err := store.Put(vaultKey, nil, true, body, "", "", testAuthProof("delete"), "", true); err != nil {
		t.Fatal(err)
	}
	rev := int64(1)
	if err := store.Delete(vaultKey, &rev, "", true, true); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("unauthenticated delete err = %v, want ErrUnauthorized", err)
	}
	if err := store.Delete(vaultKey, &rev, testAuthProof("wrong"), true, true); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("wrong auth delete err = %v, want ErrUnauthorized", err)
	}
	if err := store.Delete(vaultKey, &rev, testAuthProof("delete"), true, true); err != nil {
		t.Fatalf("authenticated delete err = %v", err)
	}
}

func TestFileStoreDeleteRejectsUnprotectedVault(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	vaultKey := "vault_delete_plain1234567890abcdefghij"
	body := json.RawMessage(`{"ciphertext":"a"}`)
	if _, err := store.Put(vaultKey, nil, true, body, "", "", "", "", false); err != nil {
		t.Fatal(err)
	}
	rev := int64(1)
	if err := store.Delete(vaultKey, &rev, "", false, true); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("unprotected delete err = %v, want ErrUnauthorized", err)
	}
	if _, err := store.Get(vaultKey, "", false); err != nil {
		t.Fatalf("vault should remain readable after rejected delete, got %v", err)
	}
}

func TestValidateStoredVaultAuthMetadataRejectsIterationTampering(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	vaultKey := "vault_iterations1234567890abcdefghijkl"
	body := json.RawMessage(`{"ciphertext":"a"}`)
	if _, err := store.Put(vaultKey, nil, true, body, "", "", testAuthProof("iteration"), "", true); err != nil {
		t.Fatal(err)
	}
	v, err := store.read(vaultKey)
	if err != nil {
		t.Fatal(err)
	}
	v.AuthIterations = authIterations + 1
	if err := store.write(v); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(vaultKey, testAuthProof("iteration"), true); err == nil || !strings.Contains(err.Error(), "auth metadata") {
		t.Fatalf("tampered auth iterations err = %v, want corrupt auth metadata", err)
	}
}

func TestValidateStoredVaultAuthMetadataRejectsOversizedHash(t *testing.T) {
	v := storedVault{
		AuthRequired:   true,
		AuthSalt:       base64.RawStdEncoding.EncodeToString(make([]byte, authSaltBytes)),
		AuthHash:       base64.RawStdEncoding.EncodeToString(make([]byte, authHashBytes+1)),
		AuthIterations: authIterations,
	}
	if err := validateStoredVaultAuthMetadata(v); err == nil || !strings.Contains(err.Error(), "auth metadata") {
		t.Fatalf("oversized hash err = %v, want corrupt auth metadata", err)
	}
}
