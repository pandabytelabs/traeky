# Traeky

**Local-first crypto portfolio tracking with optional end-to-end encrypted Cloud Connect.**

Traeky is a browser-based portfolio dashboard for tracking crypto activity, holdings, reports and encrypted backups. The application is designed around a simple rule: portfolio data is decrypted only in the browser. Local profiles, recovery snapshots and optional Cloud Connect backups are encrypted before they are stored or synced.

> [!IMPORTANT]
> Traeky can calculate reports and cost-basis views, but it is not tax, legal or financial advice. Always verify exported data before using it for filings or accounting.

## Highlights

- Local-first portfolio dashboard served by a small Go binary
- Multiple encrypted browser profiles
- 24-word BIP39-compatible recovery phrase for profile recovery
- Optional accountless Cloud Connect sync with encrypted remote vaults
- Multi-server Cloud Connect restore and conflict-aware sync
- Trade, transfer, reward, staking, fee, airdrop, mint, burn, loss and informational events
- Holdings, allocation, KPIs, value timeline and holding-period overview
- FIFO, LIFO, HIFO and average-cost Tax & PnL reports
- CSV import preview with duplicate detection and warnings
- CSV/PDF exports generated locally in the browser
- Self-hostable dashboard and cloud service images
- PostgreSQL or local file storage for Cloud Connect

## How it works

```text
Browser dashboard
  ├─ decrypts profile data locally
  ├─ stores encrypted local profiles and recovery snapshots
  ├─ optionally fetches prices after user opt-in
  └─ syncs encrypted Cloud Connect vaults

Cloud service
  ├─ stores opaque encrypted vault bodies
  ├─ enforces revisions, quotas, authentication and retention
  └─ never receives the passphrase, recovery phrase or vault decryption key
```

Cloud Connect is accountless. Traeky derives a hidden vault ID and a separate cloud access secret from the recovery phrase using domain-separated key derivation. The server can store and serve encrypted backups, but it cannot decrypt portfolio data.

## Quick start

Run the combined development server:

```bash
go run ./cmd/traeky
```

Open:

```text
http://localhost:8080
```

The default `TRAEKY_MODE=all` starts the dashboard and cloud API in one process. For production, prefer the separate dashboard and cloud images.

## Docker Compose

```bash
docker compose up --build
```

The compose stack starts:

| Service | URL |
| --- | --- |
| Dashboard | `http://localhost:8080` |
| Cloud API | `http://localhost:8081` |
| PostgreSQL | internal `postgres:18-alpine` service |

For local development, add this Cloud Connect URL in the dashboard:

```text
http://localhost:8081
```

For production, serve the dashboard and cloud API over HTTPS. The browser client rejects non-HTTPS cloud URLs except for loopback addresses.

## Container images

Traeky has separate runtime images for the dashboard and cloud service:

| Image | Dockerfile | Purpose |
| --- | --- | --- |
| `traeky-dashboard` | `Dockerfile.dashboard` | Serves the browser dashboard |
| `traeky-cloud` | `Dockerfile.cloud` | Stores encrypted Cloud Connect vaults |

Build locally:

```bash
docker build -f Dockerfile.dashboard -t traeky-dashboard:local .
docker build -f Dockerfile.cloud -t traeky-cloud:local .
```

Published image tags are branch-based:

| Branch / PR base | Tags |
| --- | --- |
| `main` | `latest`, `stable`, `sha-*` |
| `develop` | `dev`, `sha-*` |

## Configuration

Common settings:

| Variable | Default | Description |
| --- | --- | --- |
| `TRAEKY_ADDR` | `:8080` | Bind address |
| `TRAEKY_MODE` | `all` | `dashboard`, `cloud` or `all` |
| `TRAEKY_VERSION` | `internal/buildinfo/version.txt` | Optional version override |
| `TRAEKY_COMMIT` / `TRAEKY_COMMIT_SHORT` | `dev` | Optional commit metadata override |
| `TRAEKY_TLS_CERT_FILE` / `TRAEKY_TLS_KEY_FILE` | empty | Direct HTTPS certificate and key |

Dashboard settings:

| Variable | Default | Description |
| --- | --- | --- |
| `TRAEKY_DASHBOARD_PRIVACY_POLICY_URL` / `TRAEKY_APP_PRIVACY_POLICY_URL` | empty | Privacy Policy URL shown by the dashboard |
| `TRAEKY_DASHBOARD_IMPRINT_URL` / `TRAEKY_APP_IMPRINT_URL` | empty | Imprint URL shown by the dashboard |

Cloud settings:

| Variable | Default | Description |
| --- | --- | --- |
| `TRAEKY_CLOUD_STORE` | `file` | `postgres` or `file` |
| `TRAEKY_DATABASE_URL` | empty | PostgreSQL connection string |
| `TRAEKY_DATA_DIR` | `./data` | File-store directory |
| `TRAEKY_CORS_ORIGINS` | empty | Allowed dashboard origins for split hosting |
| `TRAEKY_REQUIRE_VAULT_AUTH` | `true` | Require authenticated Cloud Connect vault access |
| `TRAEKY_CLOUD_STRICT_COMMIT` / `TRAEKY_STRICT_COMMIT_MATCH` | `false` | Require exact dashboard/cloud commit match |
| `TRAEKY_INACTIVE_RETENTION_DAYS` | `0` | Delete inactive Cloud Connect data after N days; `0` disables deletion |
| `TRAEKY_CLOUD_RETENTION_DAYS` | `0` | Backward-compatible retention alias |

Cloud abuse-control settings:

| Variable | Default | Description |
| --- | --- | --- |
| `TRAEKY_MAX_PAYLOAD_BYTES` | `1048576` | Maximum encrypted vault payload size |
| `TRAEKY_MAX_TOTAL_STORED_BYTES` | `268435456` | Total encrypted payload storage cap |
| `TRAEKY_MAX_VAULT_COUNT` | `10000` | Maximum stored vault count |
| `TRAEKY_RATE_LIMIT_PER_IP_MINUTE` | `300` | Per-IP request limit |
| `TRAEKY_RATE_LIMIT_PER_VAULT_MINUTE` | `90` | Per-IP/per-vault request limit |
| `TRAEKY_CREATE_LIMIT_PER_IP_MINUTE` | `20` | Per-IP vault creation burst limit |
| `TRAEKY_CREATE_LIMIT_PER_IP_HOUR` | `100` | Per-IP hourly vault creation limit |
| `TRAEKY_TRUSTED_PROXIES` | empty | CIDRs/IPs whose forwarded client IP headers are trusted |
| `TRAEKY_CLIENT_IP_HEADERS` | `CF-Connecting-IP,True-Client-IP,X-Forwarded-For,X-Real-IP,Forwarded` | Header priority for client IP extraction |

Cloud terms and legal links:

| Variable | Default | Description |
| --- | --- | --- |
| `TRAEKY_CLOUD_TERMS_VERSION` | built-in | Version for the Cloud Connect terms shown in the dashboard |
| `TRAEKY_CLOUD_TERMS_TITLE` | built-in | Cloud Connect terms title |
| `TRAEKY_CLOUD_DISCLAIMER` / `TRAEKY_CLOUD_TERMS` | built-in | Cloud Connect terms/disclaimer text |
| `TRAEKY_CLOUD_PRIVACY_POLICY_URL` / `TRAEKY_PRIVACY_POLICY_URL` | empty | Cloud Privacy Policy URL |
| `TRAEKY_CLOUD_IMPRINT_URL` / `TRAEKY_IMPRINT_URL` | empty | Cloud Imprint URL |

Development compatibility switches:

| Variable | Default | Description |
| --- | --- | --- |
| `TRAEKY_ALLOW_ANONYMOUS_VAULTS` | `false` | Allow legacy anonymous vault access |
| `TRAEKY_ALLOW_WILDCARD_CORS` | `false` | Allow wildcard CORS |
| `TRAEKY_ALLOW_MISSING_PRECONDITIONS` | `false` | Allow legacy writes without revision preconditions |

Keep the compatibility switches disabled in production.

## Production cloud deployment

Use PostgreSQL for public or multi-user Cloud Connect deployments:

```bash
TRAEKY_MODE=cloud \
TRAEKY_CLOUD_STORE=postgres \
TRAEKY_DATABASE_URL='postgres://traeky:change-me@postgres:5432/traeky?sslmode=require' \
TRAEKY_CORS_ORIGINS='https://dashboard.example.org' \
TRAEKY_INACTIVE_RETENTION_DAYS=365 \
./traeky
```

The `traeky_vaults` table is created automatically at startup.

For small local installations, the file store remains available:

```bash
TRAEKY_MODE=cloud TRAEKY_CLOUD_STORE=file TRAEKY_DATA_DIR=./data ./traeky
```

Recommended public cloud hardening:

```env
TRAEKY_REQUIRE_VAULT_AUTH=true
TRAEKY_MAX_PAYLOAD_BYTES=1048576
TRAEKY_MAX_TOTAL_STORED_BYTES=268435456
TRAEKY_MAX_VAULT_COUNT=10000
TRAEKY_CREATE_LIMIT_PER_IP_MINUTE=20
TRAEKY_CREATE_LIMIT_PER_IP_HOUR=100
TRAEKY_RATE_LIMIT_PER_IP_MINUTE=300
TRAEKY_RATE_LIMIT_PER_VAULT_MINUTE=90
TRAEKY_TRUSTED_PROXIES=172.16.0.0/12,127.0.0.1/32,::1/128
TRAEKY_CLIENT_IP_HEADERS=X-Forwarded-For,X-Real-IP,Forwarded
```

If Traeky runs behind a reverse proxy, configure `TRAEKY_TRUSTED_PROXIES` to the exact proxy IPs or private subnet. Forwarded client IP headers are ignored unless the direct peer is trusted.

## Portfolio model

Traeky stores activity as normalized events. Events can include type, subtype, group ID, sequence number, fee details, location, counterparty, tags and an ignored flag.

Assets are managed separately from display symbols. The asset registry supports aliases for exchange-specific or legacy symbols such as `XBT`, `BETH` or stablecoin labels. Manual historical prices live inside the encrypted profile and are used by reports before falling back to transaction-derived prices.

The Tax & PnL view calculates realized disposals locally with FIFO, LIFO, HIFO or average-cost basis. Reports include proceeds, cost basis, fees, realized gain and warnings for missing prices or missing acquisition history.

## Import and export

CSV imports use a preview-first workflow. Traeky parses the file, normalizes rows, detects duplicates and displays warnings before writing anything to the encrypted profile.

Supported import modes:

- Generic Traeky CSV
- Binance-style CSV
- Cointracking/Blockpit-style CSV
- StakeBook reward history and activity ledger CSV

Exports are generated in the browser:

- Portfolio CSV
- Tax CSV
- PDF report

## Recovery and snapshots

New profiles generate a BIP39-compatible 24-word English recovery phrase in the browser. The phrase is shown during setup and is not stored in plaintext. The local passphrase unlocks the profile on the current device; the recovery phrase is the long-term recovery secret.

A restored profile derives the same vault encryption key, hidden cloud vault ID and cloud access secret from the recovery phrase. When Cloud Connect URLs are provided during restore, Traeky can locate and decrypt the matching encrypted backup without a user account or a stored cloud identifier.

Traeky also stores encrypted recovery snapshots inside the profile vault. Snapshots can be restored from **Profile & Security** and sync through Cloud Connect like the rest of the encrypted profile data.

## Cloud API

The public cloud API base path is `/api/v1/`. Configure the dashboard with the cloud origin, for example `https://cloud.example.org`; the dashboard appends `/api/v1` itself.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/info` | Version, commit, retention and cloud terms metadata |
| `GET` | `/api/v1/health` | Minimal health status |
| `GET` | `/api/v1/vaults/{vaultID}` | Download encrypted vault |
| `PUT` | `/api/v1/vaults/{vaultID}` | Create or update encrypted vault |
| `DELETE` | `/api/v1/vaults/{vaultID}` | Delete encrypted vault |

Writes use `If-None-Match: *` for initial creation and `If-Match: <revision>` for updates/deletes. Authenticated Cloud Connect requests include `X-Traeky-Vault-Auth`; rotation can include `X-Traeky-New-Vault-Auth`. The auth proof is bound to the origin of the server it is sent to, so a credential learned by one cloud server cannot be replayed against another.

Manual examples use placeholders only. Do not paste real cloud-auth proofs into logs, tickets or documentation.

## Build and test

```bash
make fmt
make test
make vet
make build
make docker
```

The frontend has no npm dependency chain. Static files are embedded into the Go binary.

## Release archives

Create source archives without Git metadata:

```bash
make source-archive
```

The target uses `git archive`, so `.git`, local history and repository metadata are not included.

## Security

Security notes and the supported disclosure process live in [`SECURITY.md`](SECURITY.md).

Important defaults for public deployments:

- Keep `TRAEKY_REQUIRE_VAULT_AUTH=true`
- Use HTTPS for dashboard and cloud origins
- Set explicit `TRAEKY_CORS_ORIGINS`
- Configure reverse-proxy trust with `TRAEKY_TRUSTED_PROXIES`
- Keep payload, vault-count and create-rate limits enabled
- Communicate the configured inactive retention period to users

## Versioning

The committed application version is stored in `internal/buildinfo/version.txt`. Go builds, Docker builds, Docker Compose and the publish workflow use that file by default.

To cut a release, update `internal/buildinfo/version.txt`. Build metadata can still be overridden with `TRAEKY_VERSION`, `TRAEKY_COMMIT` and `TRAEKY_COMMIT_SHORT`.
