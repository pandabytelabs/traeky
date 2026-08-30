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
- The secret itself never leaves the browser. Only a proof derived from it is sent.
- The proof is bound to the origin of the server it is sent to: `HMAC-SHA-256(secret, "traeky-cloud-auth-v2|" + origin)`, transmitted with `X-Traeky-Vault-Auth` in the `ta2_` base64url format.
- The origin is scheme, host and port. Path, query and casing do not affect the proof.
- During rotation, the new proof is sent with `X-Traeky-New-Vault-Auth`.

Server behavior:

- The server stores only a salt, iteration count and `PBKDF2-HMAC-SHA-256(proof, salt, 210000 iterations)`.
- Cloud backups require authenticated vault access by default. Protected backups require a syntactically valid `ta1_`/`ta2_` proof for reads, writes and deletion; malformed auth headers are rejected before verification.
- Verifier comparisons are constant-time.
- The server treats the proof as an opaque bearer string; it never derives or verifies the origin binding itself.
- The server still cannot decrypt the backup body.

The cloud access secret is derived separately from the hidden vault ID. A party that only learns the hidden vault ID cannot read, overwrite or delete a protected backup. The encrypted backup remains unreadable without the recovery phrase or legacy profile passphrase. The auth proof is still a bearer credential on the wire, so HTTPS is mandatory outside localhost development.

### Multi-server isolation

Because the proof is bound to the target origin, a hostile or compromised cloud server learns only a credential that is valid on itself. It cannot replay that credential against another Traeky cloud server that holds the same vault, because deriving another origin's proof requires the cloud access secret, which stays in the browser. This matters for Cloud Connect's multi-server mode, where the same vault ID is stored on several independent servers.

### Legacy proof migration

Vaults created before origin binding are protected by the previous origin-independent proof `SHA-256("traeky-cloud-auth-v1:" + secret)` in the `ta1_` format. The dashboard keeps using that proof for such a vault until the next successful upload, which rotates it to the `ta2_` proof through `X-Traeky-New-Vault-Auth`. Reads and deletes fall back to the legacy proof once if the recorded state turns out to be stale, so a vault stays reachable while devices migrate at different times. A `ta1_` proof that has been rotated away stops being accepted.

## Remote rollback resistance

Remote vault payloads include an encrypted client sync counter and encrypted client timestamp. During pull, the dashboard decrypts all reachable candidates before choosing a remote state. A cloud server cannot win conflict selection merely by changing its own `updated_at` metadata.

Once the local profile has uploaded at least once, any remote state carrying a lower sync counter is rejected. A payload without a counter is treated as counter `0` and is rejected as well, so replaying a pre-counter backup is not a way around the check.

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

## Dashboard content security

The dashboard is served with a Content Security Policy that pins code execution to the application's own origin: `script-src 'self'` and `style-src 'self'`, both without `unsafe-inline`, plus `object-src 'none'`, `base-uri 'none'` and `frame-ancestors 'none'`. The bundle contains no inline scripts and loads no third-party code.

`connect-src` is deliberately broader: it allows `'self'`, any `https:` origin and loopback HTTP. Cloud Connect lets users point the dashboard at self-hosted cloud servers whose hostnames are unknown at build time, so no fixed allowlist can express the set of legitimate destinations. This widens the set of reachable data endpoints, not the set of executable code, and the dashboard only ever contacts CoinGecko (after explicit opt-in) and the cloud servers the user configured.

## Untrusted input handling

Two classes of input reach the dashboard from outside the encrypted vault, and both are treated as untrusted:

- **Cloud server responses.** Error messages, terms text and version banners returned by a cloud server are normalized when they are received (control characters and HTML-significant characters removed, length capped) and HTML-escaped again at every render site. Terms text is rendered with `textContent`. A hostile server can therefore neither inject markup into the dashboard nor bloat a vault with an oversized reply.
- **CSV imports.** A Traeky CSV may carry back local report settings (`holding_period_days`, `upcoming_holding_window_days`, `base_currency`) and the import preview lists every setting it would change before the user applies it. `price_fetch_enabled` and `coingecko_api_key` are explicitly **not** importable: a CSV must never be able to enable outbound price requests or redirect them to a third-party API key. Those two remain under the explicit control of the settings form.

Encrypted vault envelopes are validated before use as well: the PBKDF2 iteration count carried in an envelope must fall in a plausible range, and the HKDF context string must be one Traeky itself writes. This blocks both a KDF downgrade and a crafted envelope that would otherwise freeze the browser tab with an unbounded iteration count.

## Vault existence disclosure

`GET /api/v1/vaults/{id}` answers `404` for an unknown vault and `401` for a vault that exists but was addressed without a valid proof. This distinction is intentional: the dashboard needs it to decide between creating and updating a backup, and the restore flow needs it to probe the current and legacy vault-ID derivations. It means an attacker who already knows a vault ID can confirm that the vault exists on a given server, but not read, modify or delete it. Vault IDs are derived from 256-bit entropy, so they cannot be enumerated, and the per-IP and per-vault rate limits apply to these requests.

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
- The cloud API creates its table and index on startup. To run it with a database role that holds no DDL rights, apply the schema once out of band and set `TRAEKY_DB_AUTO_MIGRATE=false`.
- Configure reverse-proxy logs so vault IDs and auth headers are not stored.
- Do not log `X-Traeky-Vault-Auth` or `X-Traeky-New-Vault-Auth`.
- Set request-size limits and rate limiting at the reverse proxy. Traeky also includes in-process per-IP and per-vault rate limits as a defensive backstop.
- Keep the dashboard and cloud origins explicit in `TRAEKY_CORS_ORIGINS`; wildcard CORS is ignored unless explicitly enabled for isolated development.

## Release integrity

Container images are published only from pushes to `main` (`latest`, `stable`) and `develop` (`dev`), or from an explicit manual dispatch. Pull requests never publish: the publish workflow runs with repository secrets, so building a pull-request head there would put unreviewed code behind the release tags. Untrusted workflow inputs such as branch and tag names are passed to shell steps through the environment rather than interpolated into the script body.

## Container separation

Traeky publishes two application images:

- `traeky-dashboard`: serves only the browser dashboard
- `traeky-cloud`: exposes only the cloud-backup API

For cloud persistence, `docker-compose.yml` uses a separate official `postgres:18-alpine` image.
