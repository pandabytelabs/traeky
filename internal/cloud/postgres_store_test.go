package cloud

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"
)

func TestPostgresStoreLifecycle(t *testing.T) {
	databaseURL := os.Getenv("TRAEKY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TRAEKY_TEST_DATABASE_URL is not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	store, err := NewPostgresStore(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	vaultKey := "vault_pg1234567890abcdefghijklmnopqr"
	_, _ = store.pool.Exec(context.Background(), `DELETE FROM traeky_vaults WHERE vault_id = $1`, vaultKey)

	body := json.RawMessage(`{"format":"traeky-vault","ciphertext":"opaque"}`)
	created, err := store.Put(vaultKey, nil, true, body, "client", "device", testAuthProof("primary"), "", true)
	if err != nil {
		t.Fatal(err)
	}
	if created.Revision != 1 || !created.AuthRequired {
		t.Fatalf("created = %+v, want revision 1 and auth", created)
	}

	if _, err := store.Get(vaultKey, testAuthProof("wrong"), true); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("wrong auth err = %v, want ErrUnauthorized", err)
	}
	got, err := store.Get(vaultKey, testAuthProof("primary"), true)
	if err != nil {
		t.Fatal(err)
	}
	if string(got.Body) == "" || got.DeviceName != "device" {
		t.Fatalf("got = %+v", got)
	}

	rev := got.Revision
	updated, err := store.Put(vaultKey, &rev, false, json.RawMessage(`{"ciphertext":"opaque-v2"}`), "client2", "device2", testAuthProof("primary"), testAuthProof("new"), true)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Revision != 2 || updated.DeviceName != "device2" {
		t.Fatalf("updated = %+v", updated)
	}
	if _, err := store.Get(vaultKey, testAuthProof("primary"), true); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("old auth err = %v, want ErrUnauthorized", err)
	}
	if err := store.Delete(vaultKey, &updated.Revision, testAuthProof("new"), true, true); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(vaultKey, testAuthProof("new"), true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted get err = %v, want ErrNotFound", err)
	}
}
