package cloud

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const postgresMigrationSQL = `
CREATE TABLE IF NOT EXISTS traeky_vaults (
    vault_id text PRIMARY KEY,
    revision bigint NOT NULL CHECK (revision > 0),
    updated_at timestamptz NOT NULL,
    client_id text NOT NULL DEFAULT '',
    device_name text NOT NULL DEFAULT '',
    auth_required boolean NOT NULL DEFAULT false,
    auth_salt text NOT NULL DEFAULT '',
    auth_hash text NOT NULL DEFAULT '',
    auth_iterations integer NOT NULL DEFAULT 0,
    body jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS traeky_vaults_updated_at_idx ON traeky_vaults (updated_at DESC);
`

// postgresUsageTTL bounds how long cached quota counters are trusted before they
// are recounted. It is short because other replicas may write concurrently and
// jsonb normalizes the stored body, so the byte deltas are an estimate between
// resyncs. That is sufficient for an abuse quota and avoids a full table
// aggregate on every write.
const postgresUsageTTL = 30 * time.Second

// PostgresStore stores encrypted vault envelopes in PostgreSQL. It stores only
// opaque encrypted JSON bodies plus remote-access metadata; it never receives or
// derives the vault encryption key.
type PostgresStore struct {
	pool  *pgxpool.Pool
	usage *usageCache
}

// PostgresOptions configures optional PostgresStore behavior.
type PostgresOptions struct {
	// AutoMigrate creates the vault table and index on startup. Disable it to
	// run the cloud API with a least-privilege database role that holds no DDL
	// rights, and apply postgresMigrationSQL out of band instead.
	AutoMigrate bool
}

// NewPostgresStore opens the store and applies the schema migration.
func NewPostgresStore(ctx context.Context, databaseURL string) (*PostgresStore, error) {
	return NewPostgresStoreWithOptions(ctx, databaseURL, PostgresOptions{AutoMigrate: true})
}

// MigrationSQL returns the schema statements the cloud API expects, so that
// operators running with AutoMigrate disabled can apply them manually.
func MigrationSQL() string {
	return postgresMigrationSQL
}

func NewPostgresStoreWithOptions(ctx context.Context, databaseURL string, opts PostgresOptions) (*PostgresStore, error) {
	if strings.TrimSpace(databaseURL) == "" {
		return nil, fmt.Errorf("database url must not be empty")
	}

	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 10
	cfg.MinConns = 0
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.HealthCheckPeriod = time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	store := &PostgresStore{pool: pool, usage: newUsageCache(postgresUsageTTL)}
	if opts.AutoMigrate {
		if err := store.migrate(ctx); err != nil {
			pool.Close()
			return nil, err
		}
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return store, nil
}

func (s *PostgresStore) Close() {
	if s != nil && s.pool != nil {
		s.pool.Close()
	}
}

func (s *PostgresStore) HealthCheck(ctx context.Context) error {
	if s == nil || s.pool == nil {
		return fmt.Errorf("postgres pool is not initialized")
	}
	return s.pool.Ping(ctx)
}

func (s *PostgresStore) migrate(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, postgresMigrationSQL)
	return err
}

func (s *PostgresStore) Get(vaultID, authSecret string, requireAuth bool) (EncryptedVault, error) {
	if !validVaultID(vaultID) {
		return EncryptedVault{}, ErrInvalidID
	}
	ctx, cancel := storeContext()
	defer cancel()

	v, err := s.read(ctx, vaultID)
	if err != nil {
		return EncryptedVault{}, err
	}
	if err := authorizeVault(v, authSecret, requireAuth); err != nil {
		return EncryptedVault{}, err
	}
	return externalVault(v), nil
}

func (s *PostgresStore) Put(vaultID string, expectedRevision *int64, createOnly bool, body json.RawMessage, clientID, deviceName, authSecret, nextAuthSecret string, requireAuth bool) (EncryptedVault, error) {
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
	storedBody, err := compactRaw(body)
	if err != nil {
		return EncryptedVault{}, fmt.Errorf("encrypted body must be valid json")
	}

	ctx, cancel := storeContext()
	defer cancel()

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return EncryptedVault{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	current, err := s.readTx(ctx, tx, vaultID, true)
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
			Body:      storedBody,
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
		if err := s.insertTx(ctx, tx, created); err != nil {
			if isUniqueViolation(err) {
				return EncryptedVault{}, ErrOccupied
			}
			return EncryptedVault{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return EncryptedVault{}, err
		}
		s.usage.add(1, int64(len(created.Body)))
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

	previousBodyBytes := int64(len(current.Body))
	current.Revision++
	current.UpdatedAt = time.Now().UTC()
	current.ClientID = trimMax(clientID, 96)
	current.Device = trimMax(deviceName, 160)
	current.Body = storedBody

	if strings.TrimSpace(nextAuthSecret) != "" {
		if err := setVaultAuth(&current, nextAuthSecret); err != nil {
			return EncryptedVault{}, err
		}
	} else if !current.AuthRequired && strings.TrimSpace(authSecret) != "" {
		if err := setVaultAuth(&current, authSecret); err != nil {
			return EncryptedVault{}, err
		}
	}

	if err := s.updateTx(ctx, tx, current); err != nil {
		return EncryptedVault{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return EncryptedVault{}, err
	}
	s.usage.add(0, int64(len(current.Body))-previousBodyBytes)
	return externalVault(current), nil
}

func (s *PostgresStore) Delete(vaultID string, expectedRevision *int64, authSecret string, requireAuth bool, requirePrecondition bool) error {
	if !validVaultID(vaultID) {
		return ErrInvalidID
	}
	ctx, cancel := storeContext()
	defer cancel()

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	v, err := s.readTx(ctx, tx, vaultID, true)
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
	if expectedRevision == nil {
		_, err = tx.Exec(ctx, `DELETE FROM traeky_vaults WHERE vault_id = $1`, vaultID)
	} else {
		_, err = tx.Exec(ctx, `DELETE FROM traeky_vaults WHERE vault_id = $1 AND revision = $2`, vaultID, *expectedRevision)
	}
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.usage.add(-1, -int64(len(v.Body)))
	return nil
}

func (s *PostgresStore) PurgeInactive(cutoff time.Time) (int64, error) {
	ctx, cancel := storeContext()
	defer cancel()
	defer s.usage.invalidate()
	commandTag, err := s.pool.Exec(ctx, `DELETE FROM traeky_vaults WHERE updated_at < $1`, cutoff.UTC())
	if err != nil {
		return 0, err
	}
	return commandTag.RowsAffected(), nil
}

// Usage reports cached storage usage. The aggregate scan runs at most once per
// postgresUsageTTL; in between, committed writes keep the counters current.
func (s *PostgresStore) Usage() (StorageUsage, error) {
	return s.usage.value(s.queryUsage)
}

func (s *PostgresStore) queryUsage() (StorageUsage, error) {
	ctx, cancel := storeContext()
	defer cancel()

	var usage StorageUsage
	err := s.pool.QueryRow(ctx, `
SELECT COUNT(*), COALESCE(SUM(octet_length(body::text)), 0)
FROM traeky_vaults`).Scan(&usage.VaultCount, &usage.BodyBytes)
	if err != nil {
		return StorageUsage{}, err
	}
	return usage, nil
}

func (s *PostgresStore) read(ctx context.Context, vaultID string) (storedVault, error) {
	return scanStoredVault(s.pool.QueryRow(ctx, selectVaultSQL(false), vaultID), vaultID)
}

func (s *PostgresStore) readTx(ctx context.Context, tx pgx.Tx, vaultID string, forUpdate bool) (storedVault, error) {
	return scanStoredVault(tx.QueryRow(ctx, selectVaultSQL(forUpdate), vaultID), vaultID)
}

func (s *PostgresStore) insertTx(ctx context.Context, tx pgx.Tx, v storedVault) error {
	_, err := tx.Exec(ctx, `
INSERT INTO traeky_vaults (
    vault_id, revision, updated_at, client_id, device_name,
    auth_required, auth_salt, auth_hash, auth_iterations, body
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
		v.VaultID, v.Revision, v.UpdatedAt, v.ClientID, v.Device,
		v.AuthRequired, v.AuthSalt, v.AuthHash, v.AuthIterations, string(v.Body),
	)
	return err
}

func (s *PostgresStore) updateTx(ctx context.Context, tx pgx.Tx, v storedVault) error {
	commandTag, err := tx.Exec(ctx, `
UPDATE traeky_vaults
SET revision = $2,
    updated_at = $3,
    client_id = $4,
    device_name = $5,
    auth_required = $6,
    auth_salt = $7,
    auth_hash = $8,
    auth_iterations = $9,
    body = $10::jsonb
WHERE vault_id = $1`,
		v.VaultID, v.Revision, v.UpdatedAt, v.ClientID, v.Device,
		v.AuthRequired, v.AuthSalt, v.AuthHash, v.AuthIterations, string(v.Body),
	)
	if err != nil {
		return err
	}
	if commandTag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return nil
}

func selectVaultSQL(forUpdate bool) string {
	query := `
SELECT vault_id,
       revision,
       updated_at,
       client_id,
       device_name,
       auth_required,
       auth_salt,
       auth_hash,
       auth_iterations,
       body::text
FROM traeky_vaults
WHERE vault_id = $1`
	if forUpdate {
		query += ` FOR UPDATE`
	}
	return query
}

func scanStoredVault(row pgx.Row, requestedVaultID string) (storedVault, error) {
	var v storedVault
	var body string
	if err := row.Scan(
		&v.VaultID,
		&v.Revision,
		&v.UpdatedAt,
		&v.ClientID,
		&v.Device,
		&v.AuthRequired,
		&v.AuthSalt,
		&v.AuthHash,
		&v.AuthIterations,
		&body,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return storedVault{}, ErrNotFound
		}
		return storedVault{}, err
	}
	v.Body = json.RawMessage(body)
	if v.VaultID != requestedVaultID || v.Revision <= 0 || !json.Valid(v.Body) {
		return storedVault{}, fmt.Errorf("stored vault is corrupt")
	}
	if err := validateStoredVaultAuthMetadata(v); err != nil {
		return storedVault{}, err
	}
	return v, nil
}

func storeContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 8*time.Second)
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
