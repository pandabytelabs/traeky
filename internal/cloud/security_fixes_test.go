package cloud

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

// testOriginBoundProof mirrors the client's v2 proof: HMAC-SHA-256 over the
// target origin, keyed with the cloud access secret.
func testOriginBoundProof(secret, origin string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("traeky-cloud-auth-v2|" + origin))
	return "ta2_" + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func TestAuthProofPatternAcceptsLegacyAndOriginBoundProofs(t *testing.T) {
	legacy := testAuthProof("primary")
	bound := testOriginBoundProof("secret", "https://cloud.example")

	for _, proof := range []string{legacy, bound} {
		if !authProofPattern.MatchString(proof) {
			t.Fatalf("proof %q rejected by authProofPattern", proof)
		}
		if err := validateAuthHeader(proof); err != nil {
			t.Fatalf("validateAuthHeader(%q) = %v, want nil", proof, err)
		}
	}

	for _, proof := range []string{"ta0_" + base64.RawURLEncoding.EncodeToString(make([]byte, 32)), "ta3_short", "not-a-proof", "ta1_short"} {
		if err := validateAuthHeader(proof); err == nil {
			t.Fatalf("validateAuthHeader(%q) = nil, want rejection", proof)
		}
	}
}

// A vault protected by the legacy proof must be able to rotate to the
// origin-bound proof, and the legacy proof must stop working afterwards.
func TestVaultRotatesFromLegacyToOriginBoundProof(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	vaultID := "vault_rotate1234567890abcdefghijklmn"
	body := json.RawMessage(`{"format":"traeky-remote-vault","ciphertext":"opaque"}`)
	legacy := testAuthProof("rotate")
	bound := testOriginBoundProof("rotate", "https://cloud.example")

	created, err := store.Put(vaultID, nil, true, body, "client", "device", legacy, "", true)
	if err != nil {
		t.Fatal(err)
	}
	if !created.AuthRequired {
		t.Fatal("created vault is not auth protected")
	}

	revision := created.Revision
	if _, err := store.Put(vaultID, &revision, false, body, "client", "device", legacy, bound, true); err != nil {
		t.Fatalf("rotation to origin-bound proof failed: %v", err)
	}

	if _, err := store.Get(vaultID, bound, true); err != nil {
		t.Fatalf("Get with rotated proof = %v, want nil", err)
	}
	if _, err := store.Get(vaultID, legacy, true); err == nil {
		t.Fatal("Get with the superseded legacy proof succeeded, want rejection")
	}
}

// A proof bound to one origin must not authenticate against a vault protected
// by a proof bound to a different origin. This is the property that stops a
// hostile cloud server from replaying a credential to another server.
func TestOriginBoundProofDoesNotAuthenticateAcrossOrigins(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	vaultID := "vault_origin1234567890abcdefghijklmn"
	body := json.RawMessage(`{"format":"traeky-remote-vault","ciphertext":"opaque"}`)
	proofA := testOriginBoundProof("shared-secret", "https://a.example")
	proofB := testOriginBoundProof("shared-secret", "https://b.example")

	if proofA == proofB {
		t.Fatal("proofs for different origins are identical")
	}
	if _, err := store.Put(vaultID, nil, true, body, "client", "device", proofA, "", true); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(vaultID, proofB, true); err == nil {
		t.Fatal("proof for a different origin was accepted")
	}
}

// The cached quota counters must stay identical to a full recount, otherwise the
// abuse limits silently drift.
func TestFileStoreUsageStaysExactAcrossWrites(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	proof := testAuthProof("usage")

	assertUsageMatchesScan := func(step string) StorageUsage {
		t.Helper()
		cached, err := store.Usage()
		if err != nil {
			t.Fatalf("%s: Usage() = %v", step, err)
		}
		fresh, err := NewFileStore(dir)
		if err != nil {
			t.Fatalf("%s: %v", step, err)
		}
		scanned, err := fresh.Usage()
		if err != nil {
			t.Fatalf("%s: rescan = %v", step, err)
		}
		if cached != scanned {
			t.Fatalf("%s: cached usage %+v != scanned usage %+v", step, cached, scanned)
		}
		return cached
	}

	assertUsageMatchesScan("empty")

	small := json.RawMessage(`{"a":"1"}`)
	large := json.RawMessage(`{"a":"1111111111111111111111111111111111"}`)

	first, err := store.Put("vault_usage_one1234567890abcdefghijk", nil, true, small, "c", "d", proof, "", true)
	if err != nil {
		t.Fatal(err)
	}
	usage := assertUsageMatchesScan("after create")
	if usage.VaultCount != 1 || usage.BodyBytes != int64(len(small)) {
		t.Fatalf("after create: usage = %+v", usage)
	}

	revision := first.Revision
	if _, err := store.Put("vault_usage_one1234567890abcdefghijk", &revision, false, large, "c", "d", proof, "", true); err != nil {
		t.Fatal(err)
	}
	usage = assertUsageMatchesScan("after grow")
	if usage.VaultCount != 1 || usage.BodyBytes != int64(len(large)) {
		t.Fatalf("after grow: usage = %+v", usage)
	}

	if _, err := store.Put("vault_usage_two1234567890abcdefghijk", nil, true, small, "c", "d", proof, "", true); err != nil {
		t.Fatal(err)
	}
	usage = assertUsageMatchesScan("after second create")
	if usage.VaultCount != 2 {
		t.Fatalf("after second create: usage = %+v", usage)
	}

	two := int64(1)
	if err := store.Delete("vault_usage_two1234567890abcdefghijk", &two, proof, true, true); err != nil {
		t.Fatal(err)
	}
	usage = assertUsageMatchesScan("after delete")
	if usage.VaultCount != 1 || usage.BodyBytes != int64(len(large)) {
		t.Fatalf("after delete: usage = %+v", usage)
	}

	if _, err := store.PurgeInactive(time.Now().UTC().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	usage = assertUsageMatchesScan("after purge")
	if usage.VaultCount != 0 || usage.BodyBytes != 0 {
		t.Fatalf("after purge: usage = %+v", usage)
	}
}

// A failed write must not move the cached counters.
func TestFileStoreUsageIgnoresRejectedWrites(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	proof := testAuthProof("rejected")
	body := json.RawMessage(`{"a":"1"}`)
	vaultID := "vault_reject1234567890abcdefghijklmn"

	if _, err := store.Put(vaultID, nil, true, body, "c", "d", proof, "", true); err != nil {
		t.Fatal(err)
	}
	before, err := store.Usage()
	if err != nil {
		t.Fatal(err)
	}

	if _, err := store.Put(vaultID, nil, true, body, "c", "d", proof, "", true); err == nil {
		t.Fatal("create on an occupied vault succeeded, want ErrOccupied")
	}
	stale := int64(99)
	if _, err := store.Put(vaultID, &stale, false, body, "c", "d", proof, "", true); err == nil {
		t.Fatal("write with a stale revision succeeded, want ErrConflict")
	}
	if _, err := store.Put(vaultID, &stale, false, body, "c", "d", testAuthProof("wrong"), "", true); err == nil {
		t.Fatal("write with a wrong proof succeeded, want ErrUnauthorized")
	}

	after, err := store.Usage()
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatalf("usage changed after rejected writes: %+v -> %+v", before, after)
	}
}
