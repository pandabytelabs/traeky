# Security model

Traeky is local-first. Decryptable portfolio data exists only in the browser while a profile is unlocked. Persistent local profile data, local snapshots and cloud backups are encrypted before they are stored.

## Encryption

- Encryption: AES-GCM 256 via the browser Web Crypto API
- New profiles use a BIP39-compatible 24-word recovery phrase generated with the browser Web Crypto API.
- The recovery phrase is shown once during setup and is not stored in plaintext.
- Vault encryption keys, hidden cloud vault IDs and cloud access secrets are derived from the recovery secret with HKDF-SHA-256 and separate context strings.
- The local login passphrase wraps the recovery secret locally with PBKDF2-HMAC-SHA-256 and AES-GCM.
- Legacy passphrase-only vaults remain supported for migration and existing users.
- IV: random 96-bit IV per stored vault version.
- Each profile has its own encrypted vault.
- The local profile index contains only display names and timestamps.
- The profile passphrase, recovery phrase and decryptable portfolio data are not sent to the cloud service.

## Local snapshots

Local recovery snapshots are encrypted inside the local browser vault and are not uploaded as snapshot history to cloud servers. Cloud backups contain only the current vault state. If a user restores a local snapshot, the restored current state can be synced like any other local change.

Balance snapshots, manual prices, asset aliases, tags, importer logs and tax-report metadata are encrypted as part of the current vault payload and are included in cloud backups because they are part of the active portfolio state. The cloud server treats the entire payload as opaque encrypted JSON.


## Event and report integrity

Traeky normalizes imported portfolio activity into its own event model in the browser. Import previews, duplicate checks, tax/PnL reports and cost-basis calculations run locally against decrypted data only while the profile is unlocked. Generated reports are informational and do not replace professional tax or legal advice.

Importer logic is implemented independently in this repository. Traeky does not embed third-party portfolio application code.

## Accountless cloud backup

Traeky does not use cloud accounts. The cloud API is exposed only under `/api/v1/`. For new profiles, a deterministic hidden vault ID derived from the recovery phrase maps an encrypted backup to a profile. The dashboard does not expose this value to users. The first upload uses `If-None-Match: *`. If the vault ID is already claimed, the cloud API returns `409 Conflict` and leaves the existing data unchanged.

Updates use `If-Match` with the last known revision. Deletes also require a numeric `If-Match` revision. These preconditions reduce accidental overwrites and protect against stale clients deleting newer remote state.

## Cloud access secret

A profile can use an additional cloud access secret. This secret is not the profile passphrase and cannot decrypt backup data.

Client behavior:

- Traeky derives a strong cloud access secret from the recovery phrase for new profiles.
- Before sending it, the client computes a domain-separated SHA-256 proof: `SHA-256("traeky-cloud-auth-v1:" + secret)`.
- The proof is sent with `X-Traeky-Vault-Auth` in the `ta1_` base64url format.
- During rotation, the new proof is sent with `X-Traeky-New-Vault-Auth`.

Server behavior:

- The server stores only a salt, iteration count and `PBKDF2-HMAC-SHA-256(proof, salt, 210000 iterations)`.
- Cloud backups require authenticated vault access by default. Protected backups require a syntactically valid `ta1_` proof for reads, writes and deletion; malformed auth headers are rejected before verification.
- Verifier comparisons are constant-time.
- The server still cannot decrypt the backup body.

The cloud access secret is derived separately from the hidden vault ID. A party that only learns the hidden vault ID cannot read, overwrite or delete a protected backup. The encrypted backup remains unreadable without the recovery phrase or legacy profile passphrase. The auth proof is still a bearer credential on the wire, so HTTPS is mandatory outside localhost development.

## Remote rollback resistance

Remote vault payloads include an encrypted client sync counter and encrypted client timestamp. During pull, the dashboard decrypts all reachable candidates before choosing a remote state. A cloud server cannot win conflict selection merely by changing its own `updated_at` metadata, and the client rejects a lower encrypted sync counter when the local profile has already observed a newer one.

## Remote deletion

The dashboard supports complete deletion of remote cloud backups across all configured cloud servers. Before sending delete requests, the client requires the configured confirmation word, verifies the current profile passphrase locally and sends `If-Match` with the last known remote revision. The profile passphrase is not sent to the cloud service.

## Inactive backup retention

The cloud service can be configured with `TRAEKY_INACTIVE_RETENTION_DAYS`. When set to a positive number, encrypted backups whose last update is older than that value are permanently deleted. The value is exposed through `/api/v1/info` so the dashboard can inform users before they rely on the service.

## Zero-Knowledge abuse limits

Because cloud backups are end-to-end encrypted, the cloud server cannot determine whether an encrypted payload contains lawful or unlawful material. Traeky therefore uses a Model-A mitigation strategy: the server remains Zero-Knowledge and reduces abuse with strict metadata controls instead of content scanning.

Recommended public-cloud controls:

- Keep `TRAEKY_MAX_PAYLOAD_BYTES` low. The secure default is `1048576` bytes.
- Set `TRAEKY_MAX_TOTAL_STORED_BYTES` to the maximum encrypted storage budget for the cloud instance. The secure default is `268435456` bytes.
- Keep `TRAEKY_MAX_VAULT_COUNT` enabled to prevent unbounded namespace/storage growth.
- Keep `TRAEKY_CREATE_LIMIT_PER_IP_MINUTE` and `TRAEKY_CREATE_LIMIT_PER_IP_HOUR` enabled to block mass vault creation from a single real client IP.
- Keep reverse-proxy request body limits at or below Traeky's payload limit.
- Configure `TRAEKY_INACTIVE_RETENTION_DAYS` for automatic cleanup if your operating policy allows it.

These controls do not prove that encrypted content is legal; they make the cloud API a poor target for bulk illegal-content storage while preserving Zero-Knowledge.

## Reverse-proxy client IP handling

Rate limits are only useful when Traeky sees the real client IP. If Traeky runs behind a reverse proxy, set `TRAEKY_TRUSTED_PROXIES` to the exact proxy IPs or CIDR ranges. Forwarded client-IP headers are ignored unless the direct TCP peer is trusted.

Safe examples:

```env
# Single proxy on the same host
TRAEKY_TRUSTED_PROXIES=127.0.0.1/32,::1/128

# Docker bridge / private proxy subnet
TRAEKY_TRUSTED_PROXIES=172.16.0.0/12,10.0.0.0/8,192.168.0.0/16

# Use only headers your proxy overwrites
TRAEKY_CLIENT_IP_HEADERS=X-Forwarded-For,X-Real-IP,Forwarded
```

Do not set broad trusted-proxy ranges if untrusted clients can connect from those ranges. Your reverse proxy must overwrite user-supplied `X-Forwarded-For`, `Forwarded`, `X-Real-IP`, `CF-Connecting-IP` and related headers before forwarding.

## Operational guidance

- Use HTTPS in production. The dashboard rejects non-HTTPS cloud URLs except for localhost, and the server can run direct TLS with `TRAEKY_TLS_CERT_FILE` and `TRAEKY_TLS_KEY_FILE` or behind a trusted TLS reverse proxy.
- Use a strong and unique local login passphrase. Store the recovery phrase offline and never in a password field, URL, log or support ticket.
- Back up PostgreSQL regularly and test restore procedures.
- Configure reverse-proxy logs so vault IDs and auth headers are not stored.
- Do not log `X-Traeky-Vault-Auth` or `X-Traeky-New-Vault-Auth`.
- Set request-size limits and rate limiting at the reverse proxy. Traeky also includes in-process per-IP and per-vault rate limits as a defensive backstop.
- Keep the dashboard and cloud origins explicit in `TRAEKY_CORS_ORIGINS`; wildcard CORS is ignored unless explicitly enabled for isolated development.

## Container separation

Traeky publishes two application images:

- `traeky-dashboard`: serves only the browser dashboard
- `traeky-cloud`: exposes only the cloud-backup API

For cloud persistence, `docker-compose.yml` uses a separate official `postgres:18-alpine` image.
