const APP_VERSION = "dev";
const ACCOUNT_TERMS_VERSION = "community-disclaimer-v1";
const CLOUD_API_PREFIX = "/api/v1";
// Cloud access proof versions. v1 is the legacy origin-independent proof, v2 is
// bound to the target server's origin. See cloudAuthProof().
const CLOUD_AUTH_PROOF_V1 = "v1";
const CLOUD_AUTH_PROOF_V2 = "v2";
const LOCAL_VAULT_KEY = "traeky:v2:vault";
const ACCOUNT_INDEX_KEY = "traeky:v2:accounts:index";
const ACCOUNT_VAULT_PREFIX = "traeky:v2:account:";
const CSV_SCHEMA_VERSION = 7;
const PBKDF2_ITERATIONS = 600000;
const DEVICE_ID_KEY = "traeky:v2:device-id";
const UNLOCK_SESSION_KEY = "traeky:v2:unlock-session";
const DEFAULT_AUTO_LOCK_MINUTES = 30;
const MIN_AUTO_LOCK_MINUTES = 1;
const MAX_AUTO_LOCK_MINUTES = 24 * 60;
const AUTO_LOCK_ACTIVITY_THROTTLE_MS = 15 * 1000;
const COLOR_SET = ["#69b7ff", "#d7ff72", "#70e59c", "#ffca69", "#ff6b7a", "#b692ff", "#67e8f9", "#f0abfc"];
const RECOVERY_WORD_COUNT = 24;
const RECOVERY_CONFIRM_COUNT = 4;
const AUTO_SYNC_DEBOUNCE_MS = 1800;
const SNAPSHOT_LIMIT = 20;
const PRICE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const PRICE_REFRESH_STALE_MS = 5 * 60 * 1000;
const CLOUD_HEARTBEAT_INTERVAL_MS = 60 * 1000;
const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

let bip39WordsCache = null;
let pendingSetupRecovery = null;
let pendingAccountSetup = null;
let pendingRecoveryStep = "display";
let autoSyncTimer = null;
let autoSyncInFlight = false;
let autoSyncQueued = false;
let priceRefreshTimer = null;
let priceRefreshInFlight = false;
let priceRefreshLastRun = 0;
let cloudHeartbeatTimer = null;
let cloudHeartbeatInFlight = false;
let cloudHeartbeatLastRun = 0;
let restoreCloudVerificationCache = null;
let fileSyncTimer = null;
let fileSyncInFlight = false;
const fileSyncByAccount = new Map();
let autoLockTimer = null;
let lastUnlockSessionTouch = 0;
let activityTrackingBound = false;
let pendingRender = false;

const SUPPORTED_LOCALES = ["en", "de"];
const FALLBACK_LOCALE = "en";
const browserLocale = (navigator.language || FALLBACK_LOCALE).toLowerCase().split("-")[0];
let currentLocale = localStorage.getItem("traeky:locale") || (browserLocale === "de" ? "de" : FALLBACK_LOCALE);
if (!SUPPORTED_LOCALES.includes(currentLocale)) currentLocale = FALLBACK_LOCALE;
document.documentElement.lang = currentLocale;

async function loadLocaleFile(locale) {
  const res = await fetch(`/locales/${locale}.json`, { cache: "force-cache" });
  if (!res.ok) throw new Error(`Locale ${locale} could not be loaded`);
  return res.json();
}

async function loadLocales() {
  const loaded = {};
  loaded[FALLBACK_LOCALE] = await loadLocaleFile(FALLBACK_LOCALE);
  await Promise.all(SUPPORTED_LOCALES.filter(locale => locale !== FALLBACK_LOCALE).map(async locale => {
    try { loaded[locale] = await loadLocaleFile(locale); }
    catch { /* English remains the stable fallback. */ }
  }));
  if (!loaded[currentLocale]) {
    currentLocale = FALLBACK_LOCALE;
    document.documentElement.lang = currentLocale;
  }
  return loaded;
}

const I18N = await loadLocales();

function t(key, params = {}) {
  let value = I18N[currentLocale]?.[key] ?? I18N.en[key] ?? key;
  return String(value).replace(/\{(\w+)\}/g, (_, name) => params[name] ?? "");
}

async function loadAppInfo() {
  try {
    const res = await fetch('/api/app/info', { cache: 'no-store' });
    if (!res.ok) return;
    const info = await res.json();
    appInfo = {
      version: String(info.version || APP_VERSION),
      commit: String(info.commit || '').trim(),
      commit_short: normalizeCommitShort(info.commit_short || info.commitShort || info.commit || ''),
      privacy_policy_url: normalizeExternalLegalURL(info.privacy_policy_url || info.privacyPolicyUrl || ''),
      imprint_url: normalizeExternalLegalURL(info.imprint_url || info.imprintUrl || '')
    };
  } catch {
    appInfo = { version: APP_VERSION, commit: '', commit_short: '', privacy_policy_url: '', imprint_url: '' };
  }
}

function localeTag() { return currentLocale === "de" ? "de-DE" : "en-US"; }
function txLabel(code) { return t(`tx_type_${String(code || "").toLowerCase()}`) || code || "-"; }
function confirmWord() { return currentLocale === "de" ? "JA" : "YES"; }

const ASSET_META = {
  BTC: { name: "Bitcoin", coingecko: "bitcoin" },
  ETH: { name: "Ethereum", coingecko: "ethereum" },
  BNB: { name: "BNB", coingecko: "binancecoin" },
  SOL: { name: "Solana", coingecko: "solana" },
  ADA: { name: "Cardano", coingecko: "cardano" },
  XRP: { name: "XRP", coingecko: "ripple" },
  DOT: { name: "Polkadot", coingecko: "polkadot" },
  MATIC: { name: "Polygon", coingecko: "matic-network" },
  LINK: { name: "Chainlink", coingecko: "chainlink" },
  LTC: { name: "Litecoin", coingecko: "litecoin" },
  DOGE: { name: "Dogecoin", coingecko: "dogecoin" },
  AVAX: { name: "Avalanche", coingecko: "avalanche-2" },
  IOTA: { name: "IOTA", coingecko: "iota" },
  USDT: { name: "Tether", coingecko: "tether" },
  USDC: { name: "USD Coin", coingecko: "usd-coin" },
  EUR: { name: "Euro" },
  USD: { name: "US Dollar" }
};

const TX_TYPES = ["BUY", "SELL", "DEPOSIT", "WITHDRAWAL", "TRANSFER_IN", "TRANSFER_OUT", "TRANSFER_INTERNAL", "AIRDROP", "STAKING_REWARD", "REWARD", "INTEREST", "CASHBACK", "FEE", "BRIDGE", "MINT", "BURN", "LOSS", "ADJUSTMENT", "IGNORE", "INFO"];
const ACQUISITION_TYPES = new Set(["BUY", "DEPOSIT", "TRANSFER_IN", "AIRDROP", "STAKING_REWARD", "REWARD", "INTEREST", "CASHBACK", "MINT", "ADJUSTMENT"]);
const DISPOSAL_TYPES = new Set(["SELL", "WITHDRAWAL", "TRANSFER_OUT", "FEE", "BURN", "LOSS", "BRIDGE"]);
const NEUTRAL_TYPES = new Set(["TRANSFER_INTERNAL", "IGNORE", "INFO"]);
const INCOME_TYPES = new Set(["STAKING_REWARD", "REWARD", "AIRDROP", "INTEREST", "CASHBACK"]);
const LOT_BUILDING_TYPES = new Set(["BUY", "DEPOSIT", "TRANSFER_IN", "MINT", "ADJUSTMENT"]);
const TAX_METHODS = ["FIFO", "LIFO", "HIFO", "ACB"];
const DEFAULT_ASSET_ALIASES = {
  XBT: "BTC", WBTC: "BTC", ETH2: "ETH", BETH: "ETH", MATICPOLYGON: "MATIC", POL: "MATIC",
  MIOTA: "IOTA", IOTA: "IOTA", USDC: "USDC", USDT: "USDT", BUSD: "BUSD", DAI: "DAI", EUR: "EUR", USD: "USD"
};
const DEFAULT_STABLECOINS = new Set(["USDC", "USDT", "DAI", "BUSD", "TUSD", "USDP", "FDUSD", "PYUSD", "USDE", "EURC", "EURS"]);

function createLockedSession(activeAccountID = "") {
  return {
    unlocked: false,
    passphrase: "",
    rootSecret: null,
    envelope: null,
    data: null,
    lastRemoteRevision: null,
    filter: { query: "", asset: "", type: "", profile: "active" },
    pendingImport: null,
    importResult: null,
    tax: { method: "FIFO", from: "", to: "" },
    route: "overview",
    activeAccountID,
    pagination: {}
  };
}

let session = createLockedSession();
let appInfo = { version: APP_VERSION, commit: "", commit_short: "", privacy_policy_url: "", imprint_url: "" };
function currentAppVersion() {
  return String(appInfo.version || APP_VERSION).trim().replace(/^v/i, '') || APP_VERSION;
}
function currentAppCommit() {
  return String(appInfo.commit || appInfo.commit_short || '').trim();
}
function traekyClientHeaders(extra = {}) {
  const headers = { ...extra };
  const version = currentAppVersion();
  const commit = currentAppCommit();
  if (version) headers['X-Traeky-Client-Version'] = version;
  if (commit) headers['X-Traeky-Client-Commit'] = commit;
  return headers;
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const UNSAFE_TEXT_CHARS = new Set(["<", ">", "&", '"', "'", "`"]);

// Strings that arrive from a remote cloud server (error messages, terms text,
// version banners) are rendered in the dashboard and stored inside the vault.
// Every render sink escapes them, but they are additionally normalized here so a
// hostile or compromised server cannot inject markup through a future call site
// or a plain confirm() dialog, and cannot bloat the vault with an oversized reply.
function sanitizeServerText(value, maxLength = 180) {
  let out = "";
  for (const ch of String(value ?? "")) {
    const code = ch.codePointAt(0);
    out += (code < 0x20 || code === 0x7f || UNSAFE_TEXT_CHARS.has(ch)) ? " " : ch;
  }
  return out.trim().slice(0, maxLength);
}

// Multi-line server text (cloud terms) is rendered with textContent, so markup
// is not a concern, but it is stored inside the encrypted vault and therefore
// counts against the cloud payload limit. Keep the line structure, drop other
// control characters and cap the length so a server cannot make a vault
// unsyncable by returning an oversized disclaimer.
function sanitizeMultilineServerText(value, maxLength = 20000) {
  let out = "";
  for (const ch of String(value ?? "")) {
    const code = ch.codePointAt(0);
    if (ch === "\n" || ch === "\t") { out += ch; continue; }
    out += (code < 0x20 || code === 0x7f) ? " " : ch;
  }
  return out.trim().slice(0, maxLength);
}

// Version and commit identifiers are compared and displayed verbatim; restrict
// them to the characters such identifiers can legitimately contain. Disallowed
// characters are stripped rather than blanking the value, so a manipulated
// version still fails the compatibility comparison instead of skipping it.
function sanitizeVersionString(value, maxLength = 32) {
  return String(value ?? "").trim().replace(/[^A-Za-z0-9._+-]/g, "").slice(0, maxLength);
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>'"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch]));
}

function clampAutoLockMinutes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_AUTO_LOCK_MINUTES;
  return Math.min(MAX_AUTO_LOCK_MINUTES, Math.max(MIN_AUTO_LOCK_MINUTES, Math.round(parsed)));
}

function autoLockMinutes(data = session.data) {
  return clampAutoLockMinutes(data?.config?.auto_lock_minutes ?? DEFAULT_AUTO_LOCK_MINUTES);
}

function readUnlockSession() {
  try {
    const payload = JSON.parse(sessionStorage.getItem(UNLOCK_SESSION_KEY) || "null");
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

function clearUnlockSession() {
  sessionStorage.removeItem(UNLOCK_SESSION_KEY);
  if (autoLockTimer) clearTimeout(autoLockTimer);
  autoLockTimer = null;
  lastUnlockSessionTouch = 0;
}

function unlockSessionExpired(now = Date.now()) {
  const payload = readUnlockSession();
  const expiresAt = Number(payload?.expires_at || 0);
  return Boolean(expiresAt && expiresAt <= now);
}

function saveUnlockSession(options = {}) {
  if (!session.unlocked || !session.data) return;
  const now = Date.now();
  if (!options.allowExpired && unlockSessionExpired(now)) {
    lockCurrentSession("timeout");
    return;
  }
  if (!options.force && now - lastUnlockSessionTouch < AUTO_LOCK_ACTIVITY_THROTTLE_MS) return;
  const minutes = autoLockMinutes(session.data);
  const payload = {
    version: 2,
    account_id: getActiveAccountID(),
    route: session.route || "overview",
    expires_at: now + minutes * 60 * 1000,
    auto_lock_minutes: minutes,
    updated_at: nowISO()
  };
  sessionStorage.setItem(UNLOCK_SESSION_KEY, JSON.stringify(payload));
  lastUnlockSessionTouch = now;
  scheduleAutoLock();
}

function scheduleAutoLock() {
  if (autoLockTimer) clearTimeout(autoLockTimer);
  autoLockTimer = null;
  if (!session.unlocked) return;
  const payload = readUnlockSession();
  const expiresAt = Number(payload?.expires_at || 0);
  if (!expiresAt) {
    saveUnlockSession({ force: true });
    return;
  }
  const delay = expiresAt - Date.now();
  if (delay <= 0) {
    lockCurrentSession("timeout");
    return;
  }
  autoLockTimer = setTimeout(() => lockCurrentSession("timeout"), delay);
}

function lockCurrentSession(reason = "manual") {
  const activeID = getActiveAccountID();
  clearUnlockSession();
  stopDashboardPriceRefresh();
  stopCloudHeartbeat();
  clearTimeout(autoSyncTimer);
  autoSyncTimer = null;
  autoSyncQueued = false;
  session = createLockedSession(activeID);
  render();
}

async function restoreUnlockSession() {
  // Unlock state is intentionally not restorable across page reloads: the
  // passphrase stays only in the current JavaScript heap and is never written
  // to Web Storage. Clear legacy v1 payloads that may still contain it.
  const payload = readUnlockSession();
  if (payload?.account_id) session = createLockedSession(String(payload.account_id));
  if (payload) clearUnlockSession();
  return false;
}

function bindSessionActivityTracking() {
  if (activityTrackingBound) return;
  activityTrackingBound = true;
  const touch = () => saveUnlockSession();
  ["pointerdown", "keydown", "scroll", "touchstart"].forEach(eventName => {
    window.addEventListener(eventName, touch, { passive: true, capture: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && session.unlocked) {
      saveUnlockSession({ force: true });
      requestAnimationFrame(drawCharts);
    }
  });
}

const supportedCurrencyCache = new Map();

function isSupportedCurrencyCode(currency) {
  const code = String(currency || "EUR").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return false;
  if (supportedCurrencyCache.has(code)) return supportedCurrencyCache.get(code);
  try {
    new Intl.NumberFormat(localeTag(), { style: "currency", currency: code }).format(1);
    supportedCurrencyCache.set(code, true);
    return true;
  } catch {
    supportedCurrencyCache.set(code, false);
    return false;
  }
}

function currencyParts(code) {
  try {
    const parts = new Intl.NumberFormat(localeTag(), { style: "currency", currency: code, maximumFractionDigits: 2 }).formatToParts(1);
    const symbol = parts.find(part => part.type === "currency")?.value || code;
    const currencyIndex = parts.findIndex(part => part.type === "currency");
    const numberIndex = parts.findIndex(part => ["integer", "fraction"].includes(part.type));
    return { symbol, before: currencyIndex >= 0 && numberIndex >= 0 && currencyIndex < numberIndex };
  } catch {
    return { symbol: code, before: false };
  }
}

function fmtMoney(value, currency = "EUR") {
  const n = Number(value || 0);
  const code = String(currency || "EUR").trim().toUpperCase() || "EUR";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const amount = fmtNum(abs, 2);
  if (isSupportedCurrencyCode(code)) {
    const parts = currencyParts(code);
    return parts.before ? `${parts.symbol} ${sign}${amount}` : `${sign ? `${sign} ` : ""}${amount} ${parts.symbol}`;
  }
  return `${sign ? `${sign} ` : ""}${amount} ${code}`;
}

function fmtNum(value, digits = 8) {
  const n = Number(value || 0);
  return new Intl.NumberFormat(localeTag(), { maximumFractionDigits: digits }).format(n);
}

function parseDecimal(value) {
  if (typeof value === "number") return value;
  const raw = String(value ?? "").trim();
  if (!raw) return NaN;
  let normalized = raw.replace(/[^0-9,.-]/g, "");
  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot ? normalized.replace(/\./g, "").replace(",", ".") : normalized.replace(/,/g, "");
  } else if (lastComma >= 0) {
    normalized = normalized.replace(",", ".");
  }
  return Number(normalized);
}

function fmtDate(value) {
  if (!value) return "–";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "–";
  return new Intl.DateTimeFormat(localeTag(), { dateStyle: "medium", timeStyle: "short" }).format(d);
}

function nowISO() { return new Date().toISOString(); }
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

function parseTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return nowISO();
  let d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  const m = raw.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const year = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
    d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return nowISO();
}


function canonicalAssetSymbol(value, aliases = session.data?.asset_aliases) {
  const raw = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  if (!raw) return "";
  const compact = raw.replace(/[^A-Z0-9]/g, "");
  const map = { ...DEFAULT_ASSET_ALIASES, ...(aliases || {}) };
  return String(map[raw] || map[compact] || raw).trim().toUpperCase();
}

function detectAssetType(symbol, existing = {}) {
  const code = String(symbol || '').toUpperCase();
  if (existing.type) return existing.type;
  if (['EUR', 'USD', 'CHF', 'GBP', 'JPY', 'AUD', 'CAD', 'NZD', 'SEK', 'NOK', 'DKK'].includes(code)) return 'fiat';
  if (DEFAULT_STABLECOINS.has(code)) return 'stablecoin';
  return 'crypto';
}

function normalizeAssets(value, transactions = []) {
  const src = value && typeof value === 'object' ? value : {};
  const out = {};
  const add = (symbol, meta = {}) => {
    const code = canonicalAssetSymbol(symbol, src.aliases || src.asset_aliases);
    if (!code) return;
    const known = ASSET_META[code] || {};
    const prev = out[code] || {};
    out[code] = {
      symbol: code,
      name: String(meta.name || prev.name || known.name || code),
      type: detectAssetType(code, meta.type ? meta : prev),
      coingecko: String(meta.coingecko || prev.coingecko || known.coingecko || ''),
      aliases: Array.from(new Set([...(prev.aliases || []), ...(Array.isArray(meta.aliases) ? meta.aliases : [])].map(x => String(x).trim().toUpperCase()).filter(Boolean))).sort(),
      notes: String(meta.notes || prev.notes || '')
    };
  };
  Object.entries(src).forEach(([symbol, meta]) => add(symbol, meta && typeof meta === 'object' ? meta : {}));
  Object.entries(ASSET_META).forEach(([symbol, meta]) => add(symbol, meta));
  for (const tx of Array.isArray(transactions) ? transactions : []) {
    add(tx.asset_symbol);
    if (tx.fee_asset) add(tx.fee_asset);
    if (tx.fiat_currency) add(tx.fiat_currency, { type: isSupportedCurrencyCode(tx.fiat_currency) ? 'fiat' : detectAssetType(tx.fiat_currency) });
  }
  return out;
}

function normalizeAliases(value) {
  const out = { ...DEFAULT_ASSET_ALIASES };
  if (value && typeof value === 'object') {
    for (const [alias, symbol] of Object.entries(value)) {
      const a = String(alias || '').trim().toUpperCase();
      const s = String(symbol || '').trim().toUpperCase();
      if (a && s) out[a] = s;
    }
  }
  return out;
}

function normalizePriceCache(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.map(row => {
    if (!row || typeof row !== 'object') return null;
    const asset = canonicalAssetSymbol(row.asset || row.asset_symbol);
    const quote = canonicalAssetSymbol(row.quote || row.currency || row.fiat_currency || 'EUR');
    const date = String(row.date || row.day || row.timestamp || '').slice(0, 10);
    const price = Number(row.price);
    if (!asset || !quote || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(price) || price < 0) return null;
    const key = `${asset}|${quote}|${date}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return { asset, quote, date, price, source: String(row.source || 'manual'), updated_at: row.updated_at || nowISO() };
  }).filter(Boolean).sort((a,b) => `${a.asset}${a.date}`.localeCompare(`${b.asset}${b.date}`));
}

function normalizeBalanceSnapshots(value) {
  if (!Array.isArray(value)) return [];
  return value.map(s => {
    if (!s || typeof s !== 'object') return null;
    const items = Array.isArray(s.items) ? s.items.map(i => ({ symbol: canonicalAssetSymbol(i.symbol || i.asset), amount: Number(i.amount || 0), price: Number(i.price || 0), value: Number(i.value || 0) })).filter(i => i.symbol) : [];
    return { id: String(s.id || uuid()), created_at: s.created_at || nowISO(), total: Number(s.total || items.reduce((n,i)=>n+i.value,0)) || 0, currency: String(s.currency || 'EUR').toUpperCase(), items };
  }).filter(Boolean).sort((a,b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 180);
}

function updateAssetRegistryFromTx(tx) {
  if (!session.data) return;
  session.data.assets = normalizeAssets(session.data.assets, [tx, ...(session.data.transactions || [])]);
}

function priceCacheLookup(data, symbol, currency, timestamp = nowISO()) {
  const asset = canonicalAssetSymbol(symbol, data.asset_aliases);
  const quote = canonicalAssetSymbol(currency || data.config?.base_currency || 'EUR', data.asset_aliases);
  const day = String(timestamp || nowISO()).slice(0, 10);
  const cache = normalizePriceCache(data.price_cache || []);
  const exact = cache.find(p => p.asset === asset && p.quote === quote && p.date === day);
  if (exact) return exact.price;
  const before = cache.filter(p => p.asset === asset && p.quote === quote && p.date <= day).sort((a,b) => b.date.localeCompare(a.date))[0];
  return before ? before.price : null;
}

function eventTypeFromTxType(type) {
  const tval = String(type || 'BUY').toUpperCase();
  if (ACQUISITION_TYPES.has(tval)) return 'acquisition';
  if (DISPOSAL_TYPES.has(tval)) return 'disposal';
  if (tval === 'TRANSFER_INTERNAL') return 'transfer';
  if (tval === 'IGNORE') return 'ignored';
  return 'informational';
}


function accountTermsSnapshot(acceptedAt = nowISO()) {
  return {
    version: ACCOUNT_TERMS_VERSION,
    title: t('account_terms_title'),
    body: t('account_terms_body'),
    accepted_at: acceptedAt,
    locale: currentLocale
  };
}

function normalizeAccountLegal(value = {}) {
  const src = value && typeof value === 'object' ? value : {};
  const rawTerms = src.account_terms || src.accountTerms || src.community_disclaimer || src.disclaimer || {};
  const terms = rawTerms && typeof rawTerms === 'object' ? {
    version: String(rawTerms.version || rawTerms.terms_version || ''),
    title: String(rawTerms.title || rawTerms.terms_title || ''),
    body: String(rawTerms.body || rawTerms.terms_body || ''),
    accepted_at: String(rawTerms.accepted_at || rawTerms.acceptedAt || ''),
    locale: String(rawTerms.locale || '')
  } : {};
  return { ...src, account_terms: terms };
}

function attachAccountTerms(data, acceptance = null) {
  if (!data || typeof data !== 'object') return data;
  data.legal = normalizeAccountLegal({ ...(data.legal || {}), account_terms: acceptance || accountTermsSnapshot() });
  return data;
}

function renderAccountTermsConsent() {
  return `<div class="account-terms-consent">
    <div class="terms-box account-terms-box"><b>${escapeHTML(t('account_terms_title'))}</b>\n\n${escapeHTML(t('account_terms_body'))}</div>
    <label class="check-row"><input type="checkbox" name="accept_account_terms" required /> ${t('account_terms_accept')}</label>
  </div>`;
}

function validateAccountTermsAcceptance(formData) {
  return String(formData?.get?.('accept_account_terms') || '') === 'on' ? '' : t('account_terms_required');
}

function renderCoinGeckoConsent(checked = false) {
  return `<div class="account-terms-consent">
    <label class="check-row"><input type="checkbox" name="coingecko_opt_in" ${checked ? 'checked' : ''} /> ${t('coingecko_consent_label')}</label>
    <p class="smallprint">${t('coingecko_consent_desc')}</p>
  </div>`;
}


function defaultData(name = "Default") {
  return {
    schema_version: 5,
    app_version: currentAppVersion(),
    created_at: nowISO(),
    updated_at: nowISO(),
    account: { id: uuid(), name },
    profiles: [{ id: "main", name: currentLocale === "de" ? "Standard" : "Default", created_at: nowISO(), updated_at: nowISO() }],
    active_profile_id: "main",
    config: {
      holding_period_days: 365,
      upcoming_holding_window_days: 30,
      base_currency: "EUR",
      price_fetch_enabled: false,
      auto_lock_minutes: DEFAULT_AUTO_LOCK_MINUTES,
      coingecko_api_key: "",
      cloud_url: "",
      cloud_targets: [],
      cloud_key: randomCloudKey(),
      cloud_auth_secret: randomCloudAuthSecret(),
      last_sync_at: "",
      last_remote_revision: 0,
      last_remote_auth_secret: "",
      cloud_sync_counter: 0,
      cloud_retention_days: null,
      cloud_info_checked_at: "",
      tax_method: "FIFO"
    },
    assets: {},
    asset_aliases: { ...DEFAULT_ASSET_ALIASES },
    prices: {},
    price_cache: [],
    transactions: [],
    next_transaction_id: 1,
    audit: [],
    snapshots: [],
    balance_snapshots: [],
    import_runs: [],
    address_book: {},
    legal: { account_terms: {} }
  };
}

function normalizeData(input, fallbackName = "Default") {
  const base = defaultData(fallbackName);
  const d = input && typeof input === "object" ? input : {};
  const config = { ...base.config, ...(d.config || {}) };
  config.auto_lock_minutes = clampAutoLockMinutes(config.auto_lock_minutes);
  if (!config.cloud_key && config.cloud_vault_id) config.cloud_key = String(config.cloud_vault_id);
  if (!config.cloud_key) config.cloud_key = randomCloudKey();
  if (config.cloud_auth_secret == null) config.cloud_auth_secret = randomCloudAuthSecret();
  if (config.last_remote_auth_secret == null) config.last_remote_auth_secret = "";
  setCloudTargets(config, getCloudTargets(config));
  delete config.cloud_vault_id;
  delete config.cloud_token;
  const account = { ...base.account, ...(d.account || d.profile || {}), name: d.account?.name || d.profile?.name || fallbackName };
  const txProfiles = normalizeTxProfiles(d.profiles || d.transaction_profiles, account.name);
  const activeProfileID = txProfiles.some(p => p.id === d.active_profile_id) ? String(d.active_profile_id) : txProfiles[0].id;
  const transactions = Array.isArray(d.transactions) ? d.transactions.map(tx => normalizeTx({ profile_id: activeProfileID, ...tx })).filter(Boolean) : [];
  const maxID = transactions.reduce((m, tx) => Math.max(m, Number(tx.id) || 0), 0);
  return {
    ...base,
    ...d,
    schema_version: 5,
    app_version: currentAppVersion(),
    account,
    profiles: txProfiles,
    active_profile_id: activeProfileID,
    config,
    assets: normalizeAssets(d.assets, transactions),
    asset_aliases: normalizeAliases(d.asset_aliases || d.aliases),
    prices: d.prices && typeof d.prices === "object" ? d.prices : {},
    price_cache: normalizePriceCache(d.price_cache || d.historical_prices),
    transactions,
    next_transaction_id: Math.max(Number(d.next_transaction_id ?? d.nextTransactionId ?? d.next_tx_id) || 1, maxID + 1),
    audit: Array.isArray(d.audit) ? d.audit.slice(-100) : [],
    snapshots: normalizeSnapshots(d.snapshots),
    balance_snapshots: normalizeBalanceSnapshots(d.balance_snapshots),
    import_runs: Array.isArray(d.import_runs) ? d.import_runs.slice(-50) : [],
    address_book: d.address_book && typeof d.address_book === "object" ? d.address_book : {},
    legal: normalizeAccountLegal(d.legal || d.terms || {})
  };
}

function normalizeSnapshots(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(snapshot => {
      if (!snapshot || typeof snapshot !== "object" || !snapshot.payload) return null;
      const payload = snapshot.payload && typeof snapshot.payload === "object" ? snapshot.payload : {};
      return {
        id: String(snapshot.id || uuid()),
        created_at: snapshot.created_at || nowISO(),
        reason: String(snapshot.reason || ''),
        tx_count: Number(snapshot.tx_count ?? payload.transactions?.length ?? 0) || 0,
        payload: {
          account: (payload.account || payload.profile) && typeof (payload.account || payload.profile) === 'object' ? (payload.account || payload.profile) : {},
          profiles: normalizeTxProfiles(payload.profiles || payload.transaction_profiles, payload.account?.name || payload.profile?.name || 'Default'),
          active_profile_id: String(payload.active_profile_id || 'main'),
          config: payload.config && typeof payload.config === 'object' ? payload.config : {},
          assets: normalizeAssets(payload.assets, payload.transactions || []),
          asset_aliases: normalizeAliases(payload.asset_aliases || payload.aliases),
          prices: payload.prices && typeof payload.prices === 'object' ? payload.prices : {},
          transactions: Array.isArray(payload.transactions) ? payload.transactions.map(normalizeTx).filter(Boolean) : [],
          next_transaction_id: Number(payload.next_transaction_id) || 1,
          address_book: payload.address_book && typeof payload.address_book === 'object' ? payload.address_book : {}
        }
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, SNAPSHOT_LIMIT);
}

function snapshotPayload(data) {
  const cfg = { ...(data.config || {}) };
  return {
    account: { ...(data.account || data.profile || {}) },
    profiles: normalizeTxProfiles(data.profiles || data.transaction_profiles, data.account?.name || data.profile?.name || "Default"),
    active_profile_id: activeTxProfileID(data),
    config: cfg,
    assets: JSON.parse(JSON.stringify(data.assets || {})),
    asset_aliases: JSON.parse(JSON.stringify(data.asset_aliases || {})),
    prices: JSON.parse(JSON.stringify(data.prices || {})),
    transactions: JSON.parse(JSON.stringify(data.transactions || [])),
    next_transaction_id: Number(data.next_transaction_id) || 1,
    address_book: JSON.parse(JSON.stringify(data.address_book || {}))
  };
}

function createSnapshot(data, reason) {
  data.snapshots = normalizeSnapshots(data.snapshots);
  const latest = data.snapshots[0];
  const payload = snapshotPayload(data);
  const signature = JSON.stringify({ tx: payload.transactions, profiles: payload.profiles, active_profile_id: payload.active_profile_id, cfg: payload.config, assets: payload.assets, aliases: payload.asset_aliases, prices: payload.prices, next: payload.next_transaction_id });
  const latestSignature = latest ? JSON.stringify({ tx: latest.payload.transactions, profiles: latest.payload.profiles, active_profile_id: latest.payload.active_profile_id, cfg: latest.payload.config, assets: latest.payload.assets, aliases: latest.payload.asset_aliases, prices: latest.payload.prices, next: latest.payload.next_transaction_id }) : '';
  if (signature === latestSignature) return;
  data.snapshots.unshift({
    id: uuid(),
    created_at: nowISO(),
    reason: String(reason || (currentLocale === 'de' ? 'Änderung gespeichert' : 'Change saved')),
    tx_count: payload.transactions.length,
    payload
  });
  data.snapshots = data.snapshots.slice(0, SNAPSHOT_LIMIT);
}

function applySnapshot(data, snapshot) {
  const payload = snapshot?.payload;
  if (!payload) throw new Error(t('invalid_vault'));
  const currentCloud = {
    cloud_url: data.config?.cloud_url || '',
    cloud_targets: getCloudTargets(data.config),
    cloud_key: data.config?.cloud_key || '',
    cloud_auth_secret: data.config?.cloud_auth_secret || '',
    last_sync_at: data.config?.last_sync_at || '',
    last_remote_revision: data.config?.last_remote_revision || 0,
    last_remote_auth_secret: data.config?.last_remote_auth_secret || '',
    cloud_sync_counter: Number(data.config?.cloud_sync_counter || 0) || 0,
    cloud_retention_days: data.config?.cloud_retention_days ?? null,
    cloud_info_checked_at: data.config?.cloud_info_checked_at || ''
  };
  data.account = { ...(data.account || data.profile || {}), ...(payload.account || payload.profile || {}), id: data.account?.id || data.profile?.id || payload.account?.id || payload.profile?.id || uuid() };
  data.profiles = normalizeTxProfiles(payload.profiles || payload.transaction_profiles, data.account.name);
  data.active_profile_id = data.profiles.some(p => p.id === payload.active_profile_id) ? String(payload.active_profile_id) : data.profiles[0].id;
  data.config = { ...(data.config || {}), ...(payload.config || {}), ...currentCloud };
  setCloudTargets(data.config, currentCloud.cloud_targets);
  data.assets = normalizeAssets(payload.assets, payload.transactions || []);
  data.asset_aliases = normalizeAliases(payload.asset_aliases || payload.aliases);
  data.prices = JSON.parse(JSON.stringify(payload.prices || {}));
  // price_cache, balance_snapshots und import_runs werden nicht mehr je Snapshot gespeichert
  // (Quota-Schutz). Fehlen sie im Payload, bleiben die aktuellen Daten erhalten statt geleert zu werden.
  data.price_cache = normalizePriceCache(payload.price_cache || payload.historical_prices || data.price_cache);
  data.transactions = Array.isArray(payload.transactions) ? payload.transactions.map(normalizeTx).filter(Boolean) : [];
  data.next_transaction_id = Math.max(Number(payload.next_transaction_id) || 1, data.transactions.reduce((m, tx) => Math.max(m, Number(tx.id) || 0), 0) + 1);
  data.balance_snapshots = normalizeBalanceSnapshots(payload.balance_snapshots || data.balance_snapshots);
  data.import_runs = Array.isArray(payload.import_runs) ? payload.import_runs.slice(-50) : (Array.isArray(data.import_runs) ? data.import_runs.slice(-50) : []);
  data.address_book = payload.address_book && typeof payload.address_book === 'object' ? payload.address_book : {};
  data.updated_at = nowISO();
}

function normalizeTxType(value) {
  const raw = String(value || 'BUY').trim().toUpperCase();
  const normalized = raw
    .replace(/\(([^)]+)\)/g, ' $1 ')
    .replace(/[\/+-]+/g, ' ')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const aliases = {
    TRANSFER_INCOMING: 'TRANSFER_IN', TRANSFER_IN: 'TRANSFER_IN', TRANSFER_DEPOSIT: 'TRANSFER_IN', INCOMING_TRANSFER: 'TRANSFER_IN',
    TRANSFER_OUTGOING: 'TRANSFER_OUT', TRANSFER_OUT: 'TRANSFER_OUT', TRANSFER_WITHDRAWAL: 'TRANSFER_OUT', OUTGOING_TRANSFER: 'TRANSFER_OUT',
    TRANSFER_INTERNAL: 'TRANSFER_INTERNAL', INTERNAL_TRANSFER: 'TRANSFER_INTERNAL', TRANSFER_STAKE: 'TRANSFER_INTERNAL', TRANSFER_UNSTAKE: 'TRANSFER_INTERNAL',
    STAKING_REWARDS: 'STAKING_REWARD', STAKE_REWARD: 'STAKING_REWARD', STAKING_REWARD: 'STAKING_REWARD',
    REWARDS: 'REWARD', REWARD: 'REWARD', INTEREST_INCOME: 'INTEREST', CASH_BACK: 'CASHBACK',
    WITHDRAW: 'WITHDRAWAL', WITHDRAWAL: 'WITHDRAWAL', DEPOSIT: 'DEPOSIT', BUY: 'BUY', SELL: 'SELL', FEE: 'FEE',
    IGNORE: 'IGNORE', IGNORED: 'IGNORE', INFO: 'INFO'
  };
  return aliases[normalized] || normalized;
}

function firstFiniteDecimal(...values) {
  for (const value of values) {
    if (value === '' || value == null) continue;
    const n = parseDecimal(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeTx(tx) {
  if (!tx || typeof tx !== "object") return null;
  const symbol = canonicalAssetSymbol(tx.asset_symbol || tx.asset || tx.symbol);
  const amount = parseDecimal(tx.amount);
  if (!symbol || !Number.isFinite(amount)) return null;
  const timestamp = parseTimestamp(tx.timestamp);
  const txType = normalizeTxType(tx.tx_type || tx.type || "BUY");
  const feeAmount = tx.fee_amount === "" || tx.fee_amount == null ? 0 : parseDecimal(tx.fee_amount);
  const feeAsset = canonicalAssetSymbol(tx.fee_asset || tx.fee_currency || tx.feeAsset || '') || '';
  const tags = Array.isArray(tx.tags) ? tx.tags : String(tx.tags || '').split(/[;,]/);
  const fiatCurrency = canonicalAssetSymbol(tx.fiat_currency || tx.currency || tx.quote_currency || session.data?.config?.base_currency || "EUR");
  const directPrice = tx.price_fiat ?? tx.price ?? tx.unit_price ?? tx.unit_price_fiat ?? tx.price_value ?? tx.price_per_asset ?? (fiatCurrency === 'EUR' ? tx.price_eur : fiatCurrency === 'USD' ? tx.price_usd : null);
  const valueEUR = firstFiniteDecimal(tx.value_eur, tx.eur_value, tx.total_eur, tx.market_value_eur, tx.holding_value_eur);
  const valueUSD = firstFiniteDecimal(tx.value_usd, tx.usd_value, tx.total_usd, tx.market_value_usd, tx.holding_value_usd);
  const fiatValue = firstFiniteDecimal(tx.fiat_value, tx.value_fiat, tx.total_fiat, tx.fiat_total, tx.value_in_currency, tx.market_value, tx.holding_value);
  const matchingTotal = fiatCurrency === 'USD' ? valueUSD : fiatCurrency === 'EUR' ? valueEUR : null;
  const fallbackTotal = firstFiniteDecimal(matchingTotal, fiatValue, valueEUR, valueUSD, tx.value, tx.total, tx.worth, tx.gesamtwert, tx.wert);
  let normalizedPrice = directPrice === "" || directPrice == null ? null : parseDecimal(directPrice);
  if ((normalizedPrice == null || !Number.isFinite(normalizedPrice)) && fallbackTotal != null) {
    const qty = Math.abs(amount);
    if (Number.isFinite(fallbackTotal) && Number.isFinite(qty) && qty > 0) normalizedPrice = Math.abs(fallbackTotal) / qty;
  }
  const normalized = {
    id: Number(tx.id) || 0,
    profile_id: String(tx.profile_id || tx.profile || tx.portfolio_profile || activeTxProfileID()).trim() || "main",
    group_id: String(tx.group_id || tx.event_group || tx.tx_group || tx.tx_id || uuid()),
    sequence: Number(tx.sequence || tx.row_index || 0) || 0,
    asset_symbol: symbol,
    tx_type: TX_TYPES.includes(txType) ? txType : 'INFO',
    event_type: String(tx.event_type || eventTypeFromTxType(txType)).trim().toLowerCase(),
    event_subtype: String(tx.event_subtype || tx.subtype || '').trim().toLowerCase(),
    amount,
    price_fiat: normalizedPrice == null || !Number.isFinite(normalizedPrice) ? null : normalizedPrice,
    fiat_currency: fiatCurrency,
    fiat_value: fiatValue == null || !Number.isFinite(fiatValue) ? null : fiatValue,
    value_eur: valueEUR == null || !Number.isFinite(valueEUR) ? null : valueEUR,
    value_usd: valueUSD == null || !Number.isFinite(valueUSD) ? null : valueUSD,
    timestamp,
    location: String(tx.location || tx.exchange || tx.source || '').trim(),
    source: tx.source ? String(tx.source) : String(tx.location || tx.exchange || ''),
    counterparty: String(tx.counterparty || tx.address || '').trim(),
    note: tx.note ? String(tx.note) : "",
    tx_id: tx.tx_id ? String(tx.tx_id) : String(tx.transaction_id || tx.hash || ''),
    fee_asset: feeAsset,
    fee_amount: Number.isFinite(feeAmount) ? feeAmount : 0,
    tags: tags.map(x => String(x).trim()).filter(Boolean).slice(0, 20),
    ignored: Boolean(tx.ignored || tx.ignore || normalizeTxType(tx.tx_type) === 'IGNORE'),
    linked_tx_prev_id: tx.linked_tx_prev_id ? Number(tx.linked_tx_prev_id) : null,
    linked_tx_next_id: tx.linked_tx_next_id ? Number(tx.linked_tx_next_id) : null
  };
  if (normalized.price_fiat != null && !Number.isFinite(normalized.price_fiat)) normalized.price_fiat = null;
  return normalized;
}



function normalizeTxProfiles(value, fallbackName = "Default") {
  const seen = new Set();
  const rows = (Array.isArray(value) ? value : [])
    .map(p => {
      const id = String(p?.id || p?.profile_id || '').trim();
      const name = String(p?.name || '').trim();
      if (!id) return null;
      return {
        id,
        name: name || (currentLocale === 'de' ? 'Unbenanntes Profil' : 'Unnamed profile'),
        created_at: p?.created_at || nowISO(),
        updated_at: p?.updated_at || p?.created_at || nowISO()
      };
    })
    .filter(Boolean)
    .filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  if (!rows.length) rows.push({ id: 'main', name: fallbackName || (currentLocale === 'de' ? 'Standard' : 'Default'), created_at: nowISO(), updated_at: nowISO() });
  return rows;
}

function txProfiles(data = session.data) {
  if (!data) return [];
  data.profiles = normalizeTxProfiles(data.profiles || data.transaction_profiles, data.account?.name || 'Default');
  if (!data.active_profile_id || !data.profiles.some(p => p.id === data.active_profile_id)) data.active_profile_id = data.profiles[0].id;
  return data.profiles;
}

function activeTxProfileID(data = session.data) {
  const profiles = txProfiles(data);
  return String(data?.active_profile_id || profiles[0]?.id || 'main');
}

function activeTxProfile(data = session.data) {
  const id = activeTxProfileID(data);
  return txProfiles(data).find(p => p.id === id) || txProfiles(data)[0] || { id: 'main', name: currentLocale === 'de' ? 'Standard' : 'Default' };
}

function txProfileName(id, data = session.data) {
  const profile = txProfiles(data).find(p => p.id === id);
  return profile?.name || (currentLocale === 'de' ? 'Unzugeordnet' : 'Unassigned');
}

function txProfileOptions(selected = activeTxProfileID()) {
  return txProfiles().map(p => `<option value="${escapeHTML(p.id)}" ${p.id === selected ? 'selected' : ''}>${escapeHTML(p.name)}</option>`).join('');
}

function scopedTransactions(data = session.data) {
  const all = Array.isArray(data?.transactions) ? data.transactions : [];
  if (session.filter.profile === 'all') return all;
  const selected = session.filter.profile && session.filter.profile !== 'active' ? session.filter.profile : activeTxProfileID(data);
  return all.filter(tx => String(tx.profile_id || 'main') === String(selected));
}

function selectedExportProfileIDs(formData) {
  const raw = String(formData?.get?.('export_profiles') || 'active');
  if (raw === 'all') return null;
  if (raw === 'selected') return Array.from(formData.getAll('export_profile_ids')).map(String).filter(Boolean);
  return [activeTxProfileID()];
}

function transactionsForProfileIDs(ids) {
  const all = session.data.transactions || [];
  if (ids == null) return all;
  const set = new Set(ids);
  return all.filter(tx => set.has(String(tx.profile_id || 'main')));
}

// Targets without a recorded proof version predate origin binding, so they are
// assumed to still carry the legacy v1 proof until a push migrates them.
function normalizeAuthProofVersion(value) {
  return String(value || '').trim() === CLOUD_AUTH_PROOF_V2 ? CLOUD_AUTH_PROOF_V2 : CLOUD_AUTH_PROOF_V1;
}

function normalizeCloudURL(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Cloud URL must be absolute and use HTTPS.');
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new Error('Cloud URL must use HTTPS except for localhost development.');
  }
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/api\/v1\/?$/i, '').replace(/\/+$/, '');
  return parsed.origin + parsed.pathname;
}

function parseCloudURLs(value) {
  return uniqueCloudTargets(String(value || '')
    .split(/[\n,]+/)
    .map(v => v.trim())
    .filter(Boolean)
    .map(url => ({ url })))
    .map(t => t.url);
}

function normalizeCloudTarget(target, fallback = {}) {
  const src = typeof target === 'string' ? { url: target } : (target && typeof target === 'object' ? target : {});
  const url = normalizeCloudURL(src.url || src.cloud_url || fallback.url || '');
  if (!url) return null;
  return {
    id: String(src.id || fallback.id || `cloud-${randomID(8)}`),
    label: String(src.label || fallback.label || url.replace(/^https?:\/\//, '')).trim() || url,
    url,
    enabled: src.enabled !== false,
    last_remote_revision: Number(src.last_remote_revision ?? fallback.last_remote_revision ?? 0) || 0,
    last_sync_at: String(src.last_sync_at || fallback.last_sync_at || ''),
    last_remote_auth_secret: String(src.last_remote_auth_secret || fallback.last_remote_auth_secret || ''),
    auth_proof_version: normalizeAuthProofVersion(src.auth_proof_version ?? fallback.auth_proof_version),
    cloud_retention_days: src.cloud_retention_days ?? fallback.cloud_retention_days ?? null,
    cloud_info_checked_at: String(src.cloud_info_checked_at || fallback.cloud_info_checked_at || ''),
    last_heartbeat_at: String(src.last_heartbeat_at || fallback.last_heartbeat_at || ''),
    last_status: String(src.last_status || fallback.last_status || ''),
    last_error: String(src.last_error || fallback.last_error || ''),
    updated_at: String(src.updated_at || fallback.updated_at || ''),
    terms_version: String(src.terms_version || fallback.terms_version || ''),
    terms_title: String(src.terms_title || fallback.terms_title || ''),
    terms_body: String(src.terms_body || fallback.terms_body || ''),
    terms_accepted_at: String(src.terms_accepted_at || fallback.terms_accepted_at || ''),
    privacy_policy_url: normalizeExternalLegalURL(src.privacy_policy_url || src.privacyPolicyUrl || fallback.privacy_policy_url || fallback.privacyPolicyUrl || ''),
    imprint_url: normalizeExternalLegalURL(src.imprint_url || src.imprintUrl || fallback.imprint_url || fallback.imprintUrl || ''),
    cloud_version: String(src.cloud_version || src.traeky_version || src.app_version || fallback.cloud_version || fallback.traeky_version || fallback.app_version || ''),
    cloud_commit: String(src.cloud_commit || src.commit || fallback.cloud_commit || fallback.commit || ''),
    cloud_commit_short: normalizeCommitShort(src.cloud_commit_short || src.commit_short || src.commitShort || src.cloud_commit || src.commit || fallback.cloud_commit_short || fallback.commit_short || fallback.commitShort || fallback.cloud_commit || fallback.commit || ''),
    strict_client_commit: Boolean(src.strict_client_commit ?? src.strictClientCommit ?? fallback.strict_client_commit ?? fallback.strictClientCommit ?? false)
  };
}

function uniqueCloudTargets(targets) {
  const seen = new Map();
  for (const t of targets.map(x => normalizeCloudTarget(x)).filter(Boolean)) seen.set(t.url, { ...(seen.get(t.url) || {}), ...t });
  return [...seen.values()];
}

function getCloudTargets(cfg = session.data?.config) {
  if (!cfg) return [];
  let targets = Array.isArray(cfg.cloud_targets) ? cfg.cloud_targets : [];
  if ((!targets.length) && cfg.cloud_url) targets = [{ url: cfg.cloud_url, last_remote_revision: cfg.last_remote_revision, last_sync_at: cfg.last_sync_at, last_remote_auth_secret: cfg.last_remote_auth_secret, cloud_retention_days: cfg.cloud_retention_days, cloud_info_checked_at: cfg.cloud_info_checked_at }];
  return uniqueCloudTargets(targets);
}

function setCloudTargets(cfg, targets) {
  const normalized = uniqueCloudTargets(targets);
  cfg.cloud_targets = normalized;
  const primary = normalized.find(t => t.enabled !== false) || normalized[0] || null;
  cfg.cloud_url = primary?.url || '';
  cfg.last_remote_revision = primary?.last_remote_revision || 0;
  cfg.last_sync_at = primary?.last_sync_at || '';
  cfg.last_remote_auth_secret = primary?.last_remote_auth_secret || '';
  cfg.cloud_retention_days = primary?.cloud_retention_days ?? null;
  cfg.cloud_info_checked_at = primary?.cloud_info_checked_at || '';
  return normalized;
}

function enabledCloudTargets(cfg = session.data?.config) {
  return getCloudTargets(cfg).filter(t => t.enabled !== false && t.url);
}

function cloudStatusLabel(status) {
  if (status === 'synced') return t('cloud_target_synced');
  if (status === 'conflict') return t('cloud_target_conflict');
  if (status === 'offline') return t('cloud_target_offline');
  if (status === 'disabled') return t('cloud_status_disabled');
  return t('cloud_target_unknown');
}

function randomID(bytes = 16) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes))).replace(/-/g, "").replace(/_/g, "").slice(0, Math.max(8, bytes * 2));
}

function randomCloudKey() { return `vault_${randomID(24)}`; }
function randomCloudAuthSecret() { return `auth_${randomID(32)}`; }

function b64url(bytes) {
  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesToBase64(bytes) {
  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}

function base64ToBytes(value) {
  const bin = atob(value || "");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, salt, iterations = PBKDF2_ITERATIONS) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function importRootSecret(rootSecret) {
  const bytes = rootSecret instanceof Uint8Array ? rootSecret : base64ToBytes(String(rootSecret || ""));
  if (bytes.length !== 32) throw new Error(t('invalid_recovery_phrase'));
  return crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveBits", "deriveKey"]);
}

async function deriveRootKey(rootSecret, purpose) {
  const material = await importRootSecret(rootSecret);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(purpose) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function deriveRootBytes(rootSecret, purpose, length = 32) {
  const material = await importRootSecret(rootSecret);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(purpose) },
    material,
    length * 8
  );
  return new Uint8Array(bits);
}

async function deriveRootCloudSecrets(rootSecret) {
  const vaultIDBytes = await deriveRootBytes(rootSecret, "traeky/v2/cloud-vault-id", 32);
  const auth = await deriveRootBytes(rootSecret, "traeky/v2/cloud-auth", 32);
  const legacyIDBytes = await deriveRootBytes(rootSecret, "traeky/v1/sync-key", 32);
  const legacyAuth = await deriveRootBytes(rootSecret, "traeky/v1/cloud-auth", 32);
  return {
    vaultID: `vault_${b64url(vaultIDBytes)}`,
    authSecret: `auth_${b64url(auth)}`,
    legacyVaultID: `vault_${b64url(legacyIDBytes)}`,
    legacyAuthSecret: `auth_${b64url(legacyAuth)}`
  };
}

async function applyRootDerivedConfig(data, rootSecret) {
  const derived = await deriveRootCloudSecrets(rootSecret);
  data.config.cloud_key = derived.vaultID;
  data.config.cloud_auth_secret = derived.authSecret;
  data.config.last_remote_auth_secret = data.config.cloud_auth_secret;
  data.account.recovery = { scheme: "bip39", words: RECOVERY_WORD_COUNT, created_at: nowISO(), cloud_derivation: "traeky/v2" };
  return data;
}

async function encryptVault(data, passphrase, rootSecret = session.rootSecret) {
  if (rootSecret) return encryptSeedLocalVault(data, passphrase, rootSecret);
  return encryptPassphraseVault(data, passphrase);
}

async function encryptPassphraseVault(data, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify({ ...data, updated_at: nowISO(), app_version: currentAppVersion() }));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return {
    format: "traeky-vault",
    version: 2,
    algorithm: "AES-GCM",
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: bytesToBase64(salt) },
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
    created_at: data.created_at || nowISO(),
    sealed_at: nowISO()
  };
}

async function encryptSeedLocalVault(data, passphrase, rootSecret) {
  const wrapSalt = crypto.getRandomValues(new Uint8Array(16));
  const wrapIV = crypto.getRandomValues(new Uint8Array(12));
  const vaultIV = crypto.getRandomValues(new Uint8Array(12));
  const wrapKey = await deriveKey(passphrase, wrapSalt, PBKDF2_ITERATIONS);
  const vaultKey = await deriveRootKey(rootSecret, "traeky/v2/local-vault-encryption");
  const rootBytes = rootSecret instanceof Uint8Array ? rootSecret : base64ToBytes(rootSecret);
  const wrappedSeed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapIV }, wrapKey, rootBytes));
  const plaintext = new TextEncoder().encode(JSON.stringify({ ...data, updated_at: nowISO(), app_version: currentAppVersion() }));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: vaultIV }, vaultKey, plaintext));
  return {
    format: "traeky-local-vault",
    version: 3,
    algorithm: "AES-GCM",
    recovery: { scheme: "bip39", words: RECOVERY_WORD_COUNT, wordlist: "english" },
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: bytesToBase64(wrapSalt) },
    wrapped_seed: { iv: bytesToBase64(wrapIV), ciphertext: bytesToBase64(wrappedSeed) },
    vault: { key_derivation: "HKDF-SHA-256", info: "traeky/v2/local-vault-encryption", iv: bytesToBase64(vaultIV), ciphertext: bytesToBase64(ciphertext) },
    created_at: data.created_at || nowISO(),
    sealed_at: nowISO()
  };
}

async function encryptRemoteVault(data, passphrase = session.passphrase, rootSecret = session.rootSecret) {
  const cloudData = { ...data, snapshots: [] };
  if (!rootSecret) return encryptPassphraseVault(cloudData, passphrase);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveRootKey(rootSecret, "traeky/v2/remote-vault-encryption");
  const sealedAt = nowISO();
  const counter = Number(cloudData.config?.cloud_sync_counter || 0) || 0;
  const plaintext = new TextEncoder().encode(JSON.stringify({ ...cloudData, updated_at: sealedAt, app_version: currentAppVersion(), cloud_meta: { scheme: "traeky/v2/remote-vault", counter, sealed_at: sealedAt } }));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return {
    format: "traeky-remote-vault",
    version: 3,
    algorithm: "AES-GCM",
    key_derivation: { name: "HKDF", hash: "SHA-256", info: "traeky/v2/remote-vault-encryption" },
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
    created_at: data.created_at || nowISO(),
    sealed_at: nowISO()
  };
}

const MIN_ENVELOPE_PBKDF2_ITERATIONS = 10000;
const MAX_ENVELOPE_PBKDF2_ITERATIONS = 2000000;
// HKDF context strings Traeky has ever written for each envelope kind. The first
// entry is the fallback for envelopes predating the explicit `info` field.
const LOCAL_VAULT_KEY_INFOS = ["traeky/v1/vault-encryption", "traeky/v2/local-vault-encryption"];
const REMOTE_VAULT_KEY_INFOS = ["traeky/v1/vault-encryption", "traeky/v2/remote-vault-encryption"];

// PBKDF2 parameters are read from the envelope, which can originate from an
// imported file or from a cloud server. Out-of-range values are rejected rather
// than clamped: clamping would silently derive the wrong key, while an unbounded
// iteration count lets a crafted vault freeze the browser tab.
function envelopeIterations(value) {
  if (value === undefined || value === null || value === '') return PBKDF2_ITERATIONS;
  const iterations = Number(value);
  if (!Number.isInteger(iterations) || iterations < MIN_ENVELOPE_PBKDF2_ITERATIONS || iterations > MAX_ENVELOPE_PBKDF2_ITERATIONS) {
    throw new Error(t('invalid_vault'));
  }
  return iterations;
}

// The HKDF context string also comes from the envelope. Restricting it to the
// contexts Traeky actually writes keeps the local vault key, the remote vault
// key and the cloud credentials domain-separated.
function envelopeKeyInfo(value, allowed) {
  const info = String(value || '').trim() || allowed[0];
  if (!allowed.includes(info)) throw new Error(t('unknown_vault_format'));
  return info;
}

async function decryptVault(envelope, passphrase) {
  return (await decryptVaultWithSecrets(envelope, passphrase)).data;
}

async function decryptVaultWithSecrets(envelope, passphrase) {
  if (!envelope || typeof envelope !== "object") throw new Error(t('invalid_vault'));
  if (envelope.format === "traeky-local-vault" && Number(envelope.version) === 3) {
    const salt = base64ToBytes(envelope.kdf?.salt);
    const wrapKey = await deriveKey(passphrase, salt, envelopeIterations(envelope.kdf?.iterations));
    const rootSecret = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(envelope.wrapped_seed?.iv) }, wrapKey, base64ToBytes(envelope.wrapped_seed?.ciphertext)));
    const vaultKey = await deriveRootKey(rootSecret, envelopeKeyInfo(envelope.vault?.info, LOCAL_VAULT_KEY_INFOS));
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(envelope.vault?.iv) }, vaultKey, base64ToBytes(envelope.vault?.ciphertext));
    return { data: normalizeData(JSON.parse(new TextDecoder().decode(plaintext))), rootSecret };
  }
  if (envelope.format === "traeky-vault" && Number(envelope.version) === 2) {
    const salt = base64ToBytes(envelope.kdf?.salt);
    const key = await deriveKey(passphrase, salt, envelopeIterations(envelope.kdf?.iterations));
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(envelope.iv) }, key, base64ToBytes(envelope.ciphertext));
    return { data: normalizeData(JSON.parse(new TextDecoder().decode(plaintext))), rootSecret: null };
  }
  if (Number(envelope.version) === 1 && envelope.algorithm === "AES-GCM") {
    return { data: await decryptLegacyPayload(envelope, passphrase), rootSecret: null };
  }
  throw new Error(t('unknown_vault_format'));
}

async function decryptRemoteVault(envelope, passphrase = session.passphrase, rootSecret = session.rootSecret) {
  if (envelope?.format === "traeky-remote-vault" && Number(envelope.version) === 3) {
    if (!rootSecret) throw new Error(t('invalid_recovery_phrase'));
    const key = await deriveRootKey(rootSecret, envelopeKeyInfo(envelope.key_derivation?.info, REMOTE_VAULT_KEY_INFOS));
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(envelope.iv) }, key, base64ToBytes(envelope.ciphertext));
    return normalizeData(JSON.parse(new TextDecoder().decode(plaintext)));
  }
  return decryptVault(envelope, passphrase);
}

async function loadBIP39Words() {
  if (bip39WordsCache) return bip39WordsCache;
  const res = await fetch('/bip39-en.txt', { cache: 'force-cache' });
  if (!res.ok) throw new Error(t('recovery_phrase_unavailable'));
  const words = (await res.text()).trim().split(/\s+/);
  if (words.length !== 2048) throw new Error(t('recovery_phrase_unavailable'));
  bip39WordsCache = words;
  return words;
}

function bytesToBits(bytes) {
  return Array.from(bytes, b => b.toString(2).padStart(8, '0')).join('');
}

function bitsToBytes(bits) {
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}

async function entropyToMnemonic(entropy) {
  const words = await loadBIP39Words();
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', entropy));
  const entropyBits = bytesToBits(entropy);
  const checksumBits = bytesToBits(hash).slice(0, entropy.length * 8 / 32);
  const bits = entropyBits + checksumBits;
  const out = [];
  for (let i = 0; i < bits.length; i += 11) out.push(words[parseInt(bits.slice(i, i + 11), 2)]);
  return out.join(' ');
}

async function mnemonicToEntropy(mnemonic) {
  const words = await loadBIP39Words();
  const index = new Map(words.map((w, i) => [w, i]));
  const parts = String(mnemonic || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (![12, 15, 18, 21, 24].includes(parts.length)) throw new Error(t('invalid_recovery_phrase'));
  let bits = '';
  for (const word of parts) {
    if (!index.has(word)) throw new Error(t('invalid_recovery_phrase'));
    bits += index.get(word).toString(2).padStart(11, '0');
  }
  const entropyLength = Math.floor(bits.length * 32 / 33);
  const checksumLength = bits.length - entropyLength;
  const entropyBits = bits.slice(0, entropyLength);
  const checksumBits = bits.slice(entropyLength);
  const entropy = bitsToBytes(entropyBits);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', entropy));
  if (bytesToBits(hash).slice(0, checksumLength) !== checksumBits) throw new Error(t('invalid_recovery_phrase'));
  if (parts.length !== RECOVERY_WORD_COUNT) throw new Error(t('invalid_recovery_phrase'));
  return entropy;
}

function bytesEqual(a, b) {
  const left = a instanceof Uint8Array ? a : base64ToBytes(String(a || ''));
  const right = b instanceof Uint8Array ? b : base64ToBytes(String(b || ''));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

async function verifyRecoveryPhraseForCurrentAccount(mnemonic) {
  if (!session.data?.account?.recovery) throw new Error(t('cloud_delete_requires_recovery'));
  const entropy = await mnemonicToEntropy(mnemonic);
  if (session.rootSecret && !bytesEqual(entropy, session.rootSecret)) throw new Error(t('invalid_recovery_phrase'));
  const derived = await deriveRootCloudSecrets(entropy);
  const cfg = session.data.config || {};
  const cloudKey = String(cfg.cloud_key || '').trim();
  const authSecret = String(cfg.cloud_auth_secret || '').trim();
  if (cloudKey && ![derived.vaultID, derived.legacyVaultID].includes(cloudKey)) throw new Error(t('invalid_recovery_phrase'));
  if (authSecret && ![derived.authSecret, derived.legacyAuthSecret].includes(authSecret)) throw new Error(t('invalid_recovery_phrase'));
  return { rootSecret: entropy, derived };
}

async function generateRecovery() {
  const entropy = crypto.getRandomValues(new Uint8Array(32));
  const mnemonic = await entropyToMnemonic(entropy);
  const parts = mnemonic.split(' ');
  const positions = [];
  while (positions.length < RECOVERY_CONFIRM_COUNT) {
    const idx = crypto.getRandomValues(new Uint8Array(1))[0] % RECOVERY_WORD_COUNT;
    if (!positions.includes(idx)) positions.push(idx);
  }
  positions.sort((a, b) => a - b);
  return { mnemonic, entropy, positions, words: parts };
}

async function ensureSetupRecovery() {
  const box = $('#setup-recovery-box');
  if (!box) return;
  if (!pendingSetupRecovery) {
    box.innerHTML = `<div class="notice info">${t('recovery_phrase_loading')}</div>`;
    try { pendingSetupRecovery = await generateRecovery(); }
    catch (err) { box.innerHTML = `<div class="notice danger">${t('recovery_phrase_unavailable')}: ${escapeHTML(err.message || err)}</div>`; return; }
  }
  box.innerHTML = renderRecoveryPhraseDisplay(pendingSetupRecovery, { compact: true });
}

function renderRecoveryPhraseDisplay(recovery, options = {}) {
  const words = recovery.words.map((word, i) => `<span class="mnemonic-word"><small>${i + 1}</small>${escapeHTML(word)}</span>`).join('');
  const plain = escapeHTML(recovery.mnemonic);
  return `<div class="recovery-panel">
    <h3>${t('recovery_phrase_title')}</h3>
    <p>${t('recovery_phrase_copy')}</p>
    <div class="mnemonic-grid">${words}</div>
    <div class="form-row"><label>${t('recovery_phrase_copy_plain')}</label><textarea class="mnemonic-plain" readonly spellcheck="false">${plain}</textarea></div>
    ${options.compact ? '' : `<div class="btn-row"><button class="btn secondary" id="copy-recovery-phrase" type="button">${t('copy_recovery_phrase')}</button></div>`}
  </div>`;
}

function renderRecoveryQuiz(recovery) {
  const confirms = recovery.positions.map(pos => `<div class="form-row"><label>${t('recovery_word_label', { number: pos + 1 })}</label><input name="recovery_word_${pos}" autocomplete="off" spellcheck="false" required /></div>`).join('');
  return `<div class="recovery-panel">
    <h3>${t('recovery_confirm_copy')}</h3>
    <p>${t('recovery_words_hidden')}</p>
    <div class="form-row inline">${confirms}</div>
  </div>`;
}

function openRecoveryConfirmDialog() {
  const dialog = $('#recovery-confirm-dialog');
  if (!dialog || !pendingSetupRecovery) return;
  pendingRecoveryStep = 'display';
  renderRecoveryDialogStep();
  dialog.showModal();
}

function renderRecoveryDialogStep() {
  const body = $('#recovery-dialog-body');
  if (!body || !pendingSetupRecovery) return;
  if (pendingRecoveryStep === 'confirm') {
    body.innerHTML = `
      <button class="btn ghost close-x" id="cancel-recovery-confirm" type="button">✕</button>
      <h2>${t('recovery_phrase_title')}</h2>
      <form id="recovery-confirm-form" class="form-grid">
        ${renderRecoveryQuiz(pendingSetupRecovery)}
        <div class="btn-row"><button class="btn" type="submit">${t('create_after_recovery')}</button><button class="btn secondary" id="cancel-recovery-confirm-2" type="button">${t('cancel')}</button></div>
        <div id="recovery-confirm-msg"></div>
      </form>`;
    $('#cancel-recovery-confirm')?.addEventListener('click', cancelRecoveryConfirmDialog);
    $('#cancel-recovery-confirm-2')?.addEventListener('click', cancelRecoveryConfirmDialog);
    $('#recovery-confirm-form')?.addEventListener('submit', finishAccountCreation);
    return;
  }
  body.innerHTML = `
    <button class="btn ghost close-x" id="cancel-recovery-confirm" type="button">✕</button>
    <h2>${t('recovery_phrase_title')}</h2>
    <p>${t('recovery_dialog_intro')}</p>
    <form id="recovery-display-form" class="form-grid">
      ${renderRecoveryPhraseDisplay(pendingSetupRecovery)}
      <label class="check-row"><input type="checkbox" name="understood" required /> ${t('recovery_understood')}</label>
      <p class="smallprint">${t('recovery_cancel_warning')}</p>
      <div class="btn-row"><button class="btn" type="submit">${t('recovery_continue_to_check')}</button><button class="btn secondary" id="cancel-recovery-confirm-2" type="button">${t('cancel')}</button></div>
      <div id="recovery-confirm-msg"></div>
    </form>`;
  $('#cancel-recovery-confirm')?.addEventListener('click', cancelRecoveryConfirmDialog);
  $('#cancel-recovery-confirm-2')?.addEventListener('click', cancelRecoveryConfirmDialog);
  $('#copy-recovery-phrase')?.addEventListener('click', copyRecoveryPhrase);
  $('#recovery-display-form')?.addEventListener('submit', continueRecoveryQuiz);
}

async function copyRecoveryPhrase(e) {
  if (!pendingSetupRecovery?.mnemonic) return;
  const button = e.currentTarget;
  try {
    await navigator.clipboard.writeText(pendingSetupRecovery.mnemonic);
    if (button) button.textContent = t('recovery_copied');
  } catch {
    const textarea = $('.mnemonic-plain');
    textarea?.focus();
    textarea?.select();
    try { document.execCommand('copy'); if (button) button.textContent = t('recovery_copied'); } catch {}
  }
}

function continueRecoveryQuiz(e) {
  e.preventDefault();
  pendingRecoveryStep = 'confirm';
  renderRecoveryDialogStep();
}

function cancelRecoveryConfirmDialog() {
  pendingSetupRecovery = null;
  pendingAccountSetup = null;
  pendingRecoveryStep = 'display';
  $('#recovery-confirm-dialog')?.close();
}

async function finishAccountCreation(e) {
  e.preventDefault();
  const msg = $('#recovery-confirm-msg');
  const confirmRecovery = validateRecoveryConfirmation(e.currentTarget);
  if (confirmRecovery) { msg.innerHTML = `<div class="notice danger">${escapeHTML(confirmRecovery)}</div>`; return; }
  if (!pendingAccountSetup || !pendingSetupRecovery) { msg.innerHTML = `<div class="notice danger">${t('recovery_phrase_unavailable')}</div>`; return; }
  try {
    let data = pendingAccountSetup.migratedData
      ? normalizeData(JSON.parse(JSON.stringify(pendingAccountSetup.migratedData)), pendingAccountSetup.name)
      : defaultData(pendingAccountSetup.name);
    const rootSecret = pendingSetupRecovery.entropy;
    await applyRootDerivedConfig(data, rootSecret);
    if (pendingAccountSetup.migrateLoose) data = migrateLooseLegacy(data);
    data.config.price_fetch_enabled = pendingAccountSetup.coingeckoOptIn === true;
    attachAccountTerms(data, pendingAccountSetup.accountTerms || accountTermsSnapshot());
    if (pendingAccountSetup.source === 'legacy') addAudit(data, t('legacy_import_reason'));
    const profileID = registerAccount(uuid(), data.account.name);
    session = { ...session, unlocked: true, passphrase: pendingAccountSetup.passphrase, rootSecret, data, route: 'overview', activeAccountID: profileID };
    pendingSetupRecovery = null;
    pendingAccountSetup = null;
    pendingRecoveryStep = 'display';
    $('#recovery-confirm-dialog')?.close();
    await persist(currentLocale === 'de' ? 'Account erstellt' : 'Account created');
  } catch (err) {
    msg.innerHTML = `<div class="notice danger">${escapeHTML(err.message || err)}</div>`;
  }
}

function validateRecoveryConfirmation(form) {
  if (!pendingSetupRecovery) return t('recovery_phrase_unavailable');
  for (const pos of pendingSetupRecovery.positions) {
    const value = String(form.elements.namedItem(`recovery_word_${pos}`)?.value || '').trim().toLowerCase();
    if (value !== pendingSetupRecovery.words[pos]) return t('recovery_confirm_failed');
  }
  return '';
}

async function decryptLegacyPayload(encrypted, passphrase) {
  const salt = base64ToBytes(encrypted.salt);
  const iv = base64ToBytes(encrypted.iv);
  const key = await deriveKey(passphrase, salt, 600000);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, base64ToBytes(encrypted.ciphertext));
  const legacy = JSON.parse(new TextDecoder().decode(plaintext));
  const payload = legacy?.data && typeof legacy.data === 'object' ? legacy.data : legacy;
  const migrated = normalizeData({
    account: { name: currentLocale === 'de' ? "Migrierter Traeky-Account" : "Migrated Traeky account" },
    config: payload.config || legacy.config,
    transactions: payload.transactions || legacy.transactions || [],
    next_transaction_id: payload.nextTransactionId || payload.next_transaction_id || legacy.nextTransactionId || legacy.next_transaction_id
  }, currentLocale === 'de' ? "Migrierter Traeky-Account" : "Migrated Traeky account");
  migrateLegacyPriceCaches(migrated);
  addAudit(migrated, currentLocale === 'de' ? "Legacy-Account lokal migriert" : "Legacy account migrated locally");
  return migrated;
}

function migrateLegacyPriceCaches(data) {
  const rows = [];
  try {
    const rawSpot = localStorage.getItem('traeky:price-cache-v1');
    const spot = rawSpot ? JSON.parse(rawSpot) : null;
    if (spot && typeof spot === 'object') {
      for (const [symbol, entry] of Object.entries(spot)) {
        const asset = canonicalAssetSymbol(symbol, data.asset_aliases);
        if (!asset || !entry || typeof entry !== 'object') continue;
        const fetched = Number(entry.fetched_at || 0);
        const date = Number.isFinite(fetched) && fetched > 0 ? new Date(fetched).toISOString().slice(0, 10) : nowISO().slice(0, 10);
        for (const quote of ['EUR', 'USD']) {
          const price = Number(entry[quote.toLowerCase()]);
          if (Number.isFinite(price) && price > 0) rows.push({ asset, quote, date, price, source: 'legacy-price-cache', updated_at: nowISO() });
        }
      }
    }
  } catch (err) {
    addAudit(data, currentLocale === 'de' ? `Legacy-Preiscache konnte nicht übernommen werden: ${err.message || err}` : `Legacy price cache could not be imported: ${err.message || err}`);
  }
  try {
    const rawHistorical = localStorage.getItem('traeky:price-cache-historical-v1');
    const historical = rawHistorical ? JSON.parse(rawHistorical) : null;
    if (historical && typeof historical === 'object') {
      for (const [key, entry] of Object.entries(historical)) {
        const [symbol, date] = String(key).split(':');
        const asset = canonicalAssetSymbol(symbol, data.asset_aliases);
        if (!asset || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !entry || typeof entry !== 'object') continue;
        for (const quote of ['EUR', 'USD']) {
          const price = Number(entry[quote.toLowerCase()]);
          if (Number.isFinite(price) && price > 0) rows.push({ asset, quote, date, price, source: 'legacy-historical-price-cache', updated_at: nowISO() });
        }
      }
    }
  } catch (err) {
    addAudit(data, currentLocale === 'de' ? `Legacy-Historienpreise konnten nicht übernommen werden: ${err.message || err}` : `Legacy historical prices could not be imported: ${err.message || err}`);
  }
  const txRows = priceRowsFromTransactions(data.transactions || [], 'legacy-transactions');
  const allRows = normalizePriceCache([...(data.price_cache || []), ...rows, ...txRows]);
  data.price_cache = allRows;
  data.prices = rebuildCurrentPricesFromCache(data.prices || {}, allRows);
  return data;
}

function validatePassphrase(value) {
  if (!value || value.length < 12) return currentLocale === 'de' ? 'Die Passphrase muss mindestens 12 Zeichen lang sein.' : 'The passphrase must be at least 12 characters long.';
  const low = value.trim().toLowerCase();
  if (/^\d+$/.test(low) || /^(.)\1+$/.test(low) || ["password", "passwort", "qwertzuiop", "qwertyuiop", "letmein"].includes(low)) {
    return currentLocale === 'de' ? 'Bitte eine stärkere Passphrase verwenden.' : 'Please use a stronger passphrase.';
  }
  return "";
}

function addAudit(data, message) {
  data.audit = Array.isArray(data.audit) ? data.audit : [];
  data.audit.push({ at: nowISO(), message });
  data.audit = data.audit.slice(-100);
}

// --- Vault-Speicher -------------------------------------------------------
// Die verschlüsselten Vault-Envelopes liegen in IndexedDB (Quota im GB-Bereich
// statt ~5 MB bei localStorage). Ein synchroner In-Memory-Mirror hält die
// bestehenden synchronen Aufrufstellen am Leben; Schreibvorgänge laufen als
// Write-Through (Mirror sofort, IndexedDB asynchron). Fällt IndexedDB aus
// (z. B. eingeschränkter Browser), wird transparent auf localStorage
// zurückgefallen. Kleine Metadaten (Account-Index, Locale, Device-ID) bleiben
// bewusst in localStorage.
const VAULT_DB_NAME = "traeky-vault";
const VAULT_DB_STORE = "envelopes";
const VAULT_META_STORE = "meta"; // Geräte-lokale Metadaten (z. B. Datei-Sync-Handles).
const VAULT_DB_VERSION = 2;
let vaultDB = null;
let vaultBackend = "idb";
const vaultMirror = new Map();
let lastVaultWrite = Promise.resolve();

function openVaultDB() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(VAULT_DB_NAME, VAULT_DB_VERSION); }
    catch (err) { reject(err); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VAULT_DB_STORE)) db.createObjectStore(VAULT_DB_STORE);
      if (!db.objectStoreNames.contains(VAULT_META_STORE)) db.createObjectStore(VAULT_META_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}

function metaSet(key, value) {
  return new Promise((resolve, reject) => {
    if (!vaultDB) { reject(new Error("vault db not ready")); return; }
    let tx;
    try { tx = vaultDB.transaction(VAULT_META_STORE, "readwrite"); }
    catch (err) { reject(err); return; }
    tx.objectStore(VAULT_META_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB meta write aborted"));
  });
}

function metaDelete(key) {
  return new Promise((resolve, reject) => {
    if (!vaultDB) { reject(new Error("vault db not ready")); return; }
    let tx;
    try { tx = vaultDB.transaction(VAULT_META_STORE, "readwrite"); }
    catch (err) { reject(err); return; }
    tx.objectStore(VAULT_META_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB meta delete aborted"));
  });
}

function metaLoadAll() {
  return new Promise((resolve, reject) => {
    if (!vaultDB) { resolve([]); return; }
    const out = [];
    let tx;
    try { tx = vaultDB.transaction(VAULT_META_STORE, "readonly"); }
    catch (err) { reject(err); return; }
    const req = tx.objectStore(VAULT_META_STORE).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { out.push([cursor.key, cursor.value]); cursor.continue(); }
      else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}

function idbSet(key, value) {
  return new Promise((resolve, reject) => {
    if (!vaultDB) { reject(new Error("vault db not ready")); return; }
    let tx;
    try { tx = vaultDB.transaction(VAULT_DB_STORE, "readwrite"); }
    catch (err) { reject(err); return; }
    tx.objectStore(VAULT_DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB write aborted"));
  });
}

function idbDelete(key) {
  return new Promise((resolve, reject) => {
    if (!vaultDB) { reject(new Error("vault db not ready")); return; }
    let tx;
    try { tx = vaultDB.transaction(VAULT_DB_STORE, "readwrite"); }
    catch (err) { reject(err); return; }
    tx.objectStore(VAULT_DB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB delete aborted"));
  });
}

function idbLoadAll() {
  return new Promise((resolve, reject) => {
    if (!vaultDB) { resolve([]); return; }
    const out = [];
    let tx;
    try { tx = vaultDB.transaction(VAULT_DB_STORE, "readonly"); }
    catch (err) { reject(err); return; }
    const req = tx.objectStore(VAULT_DB_STORE).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { out.push([cursor.key, cursor.value]); cursor.continue(); }
      else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}

function isVaultStorageKey(key) {
  return key === LOCAL_VAULT_KEY || key.startsWith(ACCOUNT_VAULT_PREFIX);
}

function loadVaultMirrorFromLocalStorage() {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && isVaultStorageKey(key)) {
      const value = localStorage.getItem(key);
      if (typeof value === "string") vaultMirror.set(key, value);
    }
  }
}

async function migrateLocalStorageVaultsToIDB() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && isVaultStorageKey(key)) keys.push(key);
  }
  for (const key of keys) {
    const value = localStorage.getItem(key);
    if (value == null) continue;
    if (!vaultMirror.has(key)) {
      try { await idbSet(key, value); vaultMirror.set(key, value); }
      catch { continue; } // Bei Fehler in localStorage belassen, nicht löschen.
    }
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
}

async function initVaultStore() {
  try {
    vaultDB = await openVaultDB();
    vaultBackend = "idb";
    for (const [key, value] of await idbLoadAll()) {
      if (typeof value === "string") vaultMirror.set(key, value);
    }
    await migrateLocalStorageVaultsToIDB();
    try {
      for (const [key, value] of await metaLoadAll()) {
        if (typeof key === "string" && key.startsWith("file-sync:") && value && typeof value === "object") {
          fileSyncByAccount.set(key.slice("file-sync:".length), value);
        }
      }
    } catch { /* ignore */ }
    try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch { /* ignore */ }
  } catch {
    // IndexedDB nicht verfügbar → localStorage-Fallback (weiterhin ~5-MB-limitiert).
    vaultBackend = "localStorage";
    vaultDB = null;
    loadVaultMirrorFromLocalStorage();
  }
}

function vaultGet(key) {
  return vaultMirror.has(key) ? vaultMirror.get(key) : null;
}

function vaultKeys() {
  return [...vaultMirror.keys()];
}

function vaultSet(key, value) {
  vaultMirror.set(key, value);
  if (vaultBackend === "idb") {
    lastVaultWrite = idbSet(key, value);
  } else {
    lastVaultWrite = new Promise((resolve, reject) => {
      try { localStorage.setItem(key, value); resolve(); } catch (err) { reject(err); }
    });
  }
  lastVaultWrite.catch(() => {}); // Verhindert UnhandledRejection bei Fire-and-forget-Aufrufern.
  return lastVaultWrite;
}

function vaultRemove(key) {
  vaultMirror.delete(key);
  if (vaultBackend === "idb") {
    lastVaultWrite = idbDelete(key);
  } else {
    lastVaultWrite = new Promise((resolve) => { try { localStorage.removeItem(key); } catch { /* ignore */ } resolve(); });
  }
  lastVaultWrite.catch(() => {});
  return lastVaultWrite;
}

// Wartet, bis der zuletzt angestoßene Vault-Schreibvorgang durch ist; wirft bei
// Quota-/Schreibfehlern, damit persist() darauf reagieren kann.
function flushVaultWrites() {
  return lastVaultWrite;
}

// --- Datei-Speicher -------------------------------------------------------
// Stage 1: verschlüsselter Export/Import einer Vault-Datei (alle Browser).
// Stage 2: File System Access API – eine gewählte Datei wird als Auto-Save-Ziel
// gebunden (Chromium). Das Handle ist geräte-lokal und je Account gebunden, damit
// nie der Envelope eines fremden Accounts in eine fremde Datei geschrieben wird.
function fileSaveSupported() {
  return typeof window !== "undefined" && typeof window.showSaveFilePicker === "function";
}

function fileOpenSupported() {
  return typeof window !== "undefined" && typeof window.showOpenFilePicker === "function";
}

function fileSafeName(name) {
  return String(name || "").trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function fileSyncMetaKey(accountID) {
  return `file-sync:${accountID}`;
}

function currentFileSync() {
  const id = getActiveAccountID();
  return id ? (fileSyncByAccount.get(id) || null) : null;
}

async function setFileSyncState(accountID, state) {
  if (!accountID) return;
  if (state) {
    fileSyncByAccount.set(accountID, state);
    try { await metaSet(fileSyncMetaKey(accountID), state); } catch { /* nur geräte-lokal */ }
  } else {
    fileSyncByAccount.delete(accountID);
    try { await metaDelete(fileSyncMetaKey(accountID)); } catch { /* ignore */ }
  }
}

async function fileHandlePermitted(handle, interactive) {
  if (!handle || typeof handle.queryPermission !== "function") return true;
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if (!interactive) return false;
  return (await handle.requestPermission(opts)) === "granted";
}

async function writeEnvelopeToFile(handle, envelope) {
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(envelope, null, 2));
  await writable.close();
}

async function connectSyncFile() {
  if (!fileSaveSupported()) throw new Error(t("file_sync_unsupported"));
  const accountID = getActiveAccountID();
  if (!accountID || !session.unlocked) throw new Error(t("file_connect_locked"));
  const handle = await window.showSaveFilePicker({
    suggestedName: `${fileSafeName(session.data.account?.name) || "traeky-vault"}.traeky`,
    types: [{ description: "Traeky Vault", accept: { "application/json": [".traeky", ".json"] } }]
  });
  if (!(await fileHandlePermitted(handle, true))) throw new Error(t("file_permission_needed"));
  await writeEnvelopeToFile(handle, session.envelope);
  await setFileSyncState(accountID, { handle, name: handle.name || "", enabled: true, last_saved_at: nowISO() });
}

async function disconnectSyncFile() {
  await setFileSyncState(getActiveAccountID(), null);
}

function scheduleFileSync() {
  const state = currentFileSync();
  if (!session.unlocked || !state || !state.enabled || !state.handle) return;
  clearTimeout(fileSyncTimer);
  fileSyncTimer = setTimeout(() => { fileSyncTimer = null; fileSyncNow(); }, AUTO_SYNC_DEBOUNCE_MS);
}

async function fileSyncNow(options = {}) {
  const accountID = getActiveAccountID();
  const state = fileSyncByAccount.get(accountID);
  if (!session.unlocked || !state || !state.enabled || !state.handle) return false;
  if (fileSyncInFlight) return false;
  fileSyncInFlight = true;
  try {
    if (!(await fileHandlePermitted(state.handle, Boolean(options.interactive)))) {
      state.permission_needed = true;
      fileSyncByAccount.set(accountID, state);
      return false;
    }
    await writeEnvelopeToFile(state.handle, session.envelope);
    state.permission_needed = false;
    state.last_error = "";
    state.last_saved_at = nowISO();
    await setFileSyncState(accountID, state);
    return true;
  } catch (err) {
    state.last_error = String(err?.message || err).slice(0, 180);
    fileSyncByAccount.set(accountID, state);
    return false;
  } finally {
    fileSyncInFlight = false;
  }
}

// Liest eine Vault-Datei – bevorzugt über die File System Access API (liefert ein
// Handle für späteres Auto-Save), sonst über einen klassischen <input>-Fallback.
async function readVaultFileViaPicker() {
  if (fileOpenSupported()) {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [{ description: "Traeky Vault", accept: { "application/json": [".traeky", ".json"] } }]
    });
    const file = await handle.getFile();
    return { text: await file.text(), handle: fileSaveSupported() ? handle : null };
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".traeky,.json,application/json";
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) { reject(new Error(t("file_none_selected"))); return; }
      file.text().then(text => resolve({ text, handle: null })).catch(reject);
    };
    input.click();
  });
}

function parseVaultFile(text) {
  let envelope;
  try { envelope = JSON.parse(text); } catch { throw new Error(t("invalid_vault")); }
  if (!envelope || typeof envelope !== "object") throw new Error(t("invalid_vault"));
  return envelope;
}

async function openVaultFromEnvelope(envelope, passphrase, options = {}) {
  const opened = await decryptVaultWithSecrets(envelope, passphrase);
  const data = opened.data;
  const fallback = currentLocale === "de" ? "Importierter Account" : "Imported account";
  const accountID = registerAccount(uuid(), data.account?.name || options.name || fallback, envelope);
  session = { ...session, unlocked: true, passphrase, rootSecret: opened.rootSecret, data, envelope, lastRemoteRevision: Number(data.config.last_remote_revision || 0), route: "overview", activeAccountID: accountID };
  updateCurrentAccountMeta(data, envelope);
  saveUnlockSession({ force: true, allowExpired: true });
  if (options.handle && fileSaveSupported()) {
    await setFileSyncState(accountID, { handle: options.handle, name: options.handle.name || "", enabled: true, last_saved_at: nowISO() });
  }
  render();
}

function accountVaultKey(profileID) {
  return `${ACCOUNT_VAULT_PREFIX}${encodeURIComponent(profileID)}`;
}

function normalizeAccountIndex(index) {
  const source = Array.isArray(index?.accounts) ? index.accounts : (Array.isArray(index?.profiles) ? index.profiles : []);
  const accounts = source
    .map(p => ({
      id: String(p.id || '').trim(),
      name: String(p.name || (currentLocale === 'de' ? 'Unbenannter Account' : 'Unnamed account')).trim() || (currentLocale === 'de' ? 'Unbenannter Account' : 'Unnamed account'),
      created_at: p.created_at || nowISO(),
      updated_at: p.updated_at || p.created_at || nowISO()
    }))
    .filter(p => p.id);
  const active = accounts.some(p => p.id === index?.active_id) ? String(index.active_id) : (accounts[0]?.id || '');
  return { version: 1, active_id: active, accounts };
}

function readAccountIndexRaw() {
  try { return JSON.parse(localStorage.getItem(ACCOUNT_INDEX_KEY) || 'null'); } catch { return null; }
}

function saveAccountIndex(index) {
  localStorage.setItem(ACCOUNT_INDEX_KEY, JSON.stringify(normalizeAccountIndex(index)));
}

function ensureAccountIndex() {
  let index = normalizeAccountIndex(readAccountIndexRaw());
  if (!index.accounts.length) {
    const legacyEnvelope = vaultGet(LOCAL_VAULT_KEY);
    if (legacyEnvelope) {
      const id = 'local-default';
      if (!vaultGet(accountVaultKey(id))) vaultSet(accountVaultKey(id), legacyEnvelope);
      index = normalizeAccountIndex({
        version: 1,
        active_id: id,
        accounts: [{ id, name: currentLocale === 'de' ? 'Lokaler Account' : 'Local account', created_at: nowISO(), updated_at: nowISO() }]
      });
      saveAccountIndex(index);
    }
  }
  return index;
}

function listLocalAccounts() {
  return ensureAccountIndex().accounts;
}

function getActiveAccountID() {
  const index = ensureAccountIndex();
  return session.activeAccountID || index.active_id || index.accounts[0]?.id || '';
}

function setActiveAccountID(profileID) {
  const index = ensureAccountIndex();
  if (profileID && index.accounts.some(p => p.id === profileID)) {
    index.active_id = profileID;
    saveAccountIndex(index);
    session.activeAccountID = profileID;
  }
}

function registerAccount(profileID, name, envelope = null) {
  const index = ensureAccountIndex();
  const id = profileID || uuid();
  const now = nowISO();
  const existing = index.accounts.find(p => p.id === id);
  if (existing) {
    existing.name = String(name || existing.name || (currentLocale === 'de' ? 'Unbenannter Account' : 'Unnamed account')).trim() || (currentLocale === 'de' ? 'Unbenannter Account' : 'Unnamed account');
    existing.updated_at = now;
  } else {
    index.accounts.push({ id, name: String(name || (currentLocale === 'de' ? 'Unbenannter Account' : 'Unnamed account')).trim() || (currentLocale === 'de' ? 'Unbenannter Account' : 'Unnamed account'), created_at: now, updated_at: now });
  }
  index.active_id = id;
  saveAccountIndex(index);
  if (envelope) vaultSet(accountVaultKey(id), JSON.stringify(envelope));
  session.activeAccountID = id;
  return id;
}

function updateCurrentAccountMeta(data, envelope) {
  const profileID = getActiveAccountID() || registerAccount(uuid(), data?.account?.name || 'Default');
  const index = ensureAccountIndex();
  const now = nowISO();
  let meta = index.accounts.find(p => p.id === profileID);
  if (!meta) {
    meta = { id: profileID, name: data?.account?.name || 'Default', created_at: data?.created_at || now, updated_at: now };
    index.accounts.push(meta);
  }
  meta.name = String(data?.account?.name || meta.name || 'Default').trim() || 'Default';
  meta.updated_at = now;
  index.active_id = profileID;
  saveAccountIndex(index);
  if (envelope) vaultSet(accountVaultKey(profileID), JSON.stringify(envelope));
  return profileID;
}

function removeAccount(profileID) {
  const id = profileID || getActiveAccountID();
  const index = ensureAccountIndex();
  vaultRemove(accountVaultKey(id));
  index.accounts = index.accounts.filter(p => p.id !== id);
  index.active_id = index.accounts[0]?.id || '';
  if (!index.accounts.length) {
    localStorage.removeItem(ACCOUNT_INDEX_KEY);
    vaultRemove(LOCAL_VAULT_KEY);
  } else {
    saveAccountIndex(index);
  }
  return index;
}

function isQuotaExceeded(err) {
  return !!err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22 || err.code === 1014);
}

async function persist(message = (currentLocale === 'de' ? 'Änderung gespeichert' : 'Change saved'), options = {}) {
  if (!session.unlocked) return;
  session.data.updated_at = nowISO();
  if (message) addAudit(session.data, message);
  if (options.snapshot !== false && message) createSnapshot(session.data, message);
  let envelope = await encryptVault(session.data, session.passphrase);
  try {
    session.activeAccountID = updateCurrentAccountMeta(session.data, envelope);
    await flushVaultWrites();
  } catch (err) {
    if (!isQuotaExceeded(err)) throw err;
    // Speicher voll: lokale Undo-Snapshots verwerfen, neu verschlüsseln und erneut speichern.
    if ((session.data.snapshots || []).length) {
      session.data.snapshots = [];
      envelope = await encryptVault(session.data, session.passphrase);
      try {
        session.activeAccountID = updateCurrentAccountMeta(session.data, envelope);
        await flushVaultWrites();
      } catch (err2) {
        if (!isQuotaExceeded(err2)) throw err2;
        alert(t('local_storage_full'));
        return;
      }
    } else {
      alert(t('local_storage_full'));
      return;
    }
  }
  session.envelope = envelope;
  saveUnlockSession({ force: true });
  if (options.render !== false) render();
  if (options.autosync !== false) { scheduleAutoSync(); scheduleFileSync(); }
}

function scheduleAutoSync() {
  if (!session.unlocked || !enabledCloudTargets().length) return;
  clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(() => {
    autoSyncTimer = null;
    autoSyncNow();
  }, AUTO_SYNC_DEBOUNCE_MS);
}

async function autoSyncNow() {
  if (!session.unlocked || !enabledCloudTargets().length) return;
  if (autoSyncInFlight) {
    autoSyncQueued = true;
    return;
  }
  autoSyncInFlight = true;
  try {
    do {
      autoSyncQueued = false;
      await syncPush({ auto: true });
    } while (autoSyncQueued && session.unlocked && enabledCloudTargets().length);
  } finally {
    autoSyncInFlight = false;
  }
}

function loadLocalEnvelope(profileID = getActiveAccountID()) {
  try {
    let raw = profileID ? vaultGet(accountVaultKey(profileID)) : '';
    if (!raw && !profileID) raw = vaultGet(LOCAL_VAULT_KEY);
    if (!raw && profileID === getActiveAccountID()) raw = vaultGet(LOCAL_VAULT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function localStorageKeyList() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key) keys.push(key);
  }
  return keys;
}

function collectLocalEnvelopeCandidates(preferredID = getActiveAccountID()) {
  const candidates = [];
  const seenRaw = new Set();
  const addRaw = (id, key, raw, kind = 'account') => {
    if (!raw || seenRaw.has(raw)) return;
    try {
      const envelope = JSON.parse(raw);
      if (!envelope || typeof envelope !== 'object') return;
      seenRaw.add(raw);
      candidates.push({ id: String(id || '').trim(), key, kind, envelope });
    } catch { /* Ignore malformed legacy/localStorage entries. */ }
  };

  const activeID = getActiveAccountID();
  if (preferredID) addRaw(preferredID, accountVaultKey(preferredID), vaultGet(accountVaultKey(preferredID)), 'account');
  if (activeID && activeID !== preferredID) addRaw(activeID, accountVaultKey(activeID), vaultGet(accountVaultKey(activeID)), 'account');
  addRaw(activeID || preferredID || 'local-default', LOCAL_VAULT_KEY, vaultGet(LOCAL_VAULT_KEY), 'local-vault');

  for (const account of ensureAccountIndex().accounts) {
    addRaw(account.id, accountVaultKey(account.id), vaultGet(accountVaultKey(account.id)), 'account');
  }

  // Vault-Envelopes liegen jetzt im vaultStore (IndexedDB-Mirror) …
  for (const key of vaultKeys()) {
    if (key.startsWith(ACCOUNT_VAULT_PREFIX)) {
      const encoded = key.slice(ACCOUNT_VAULT_PREFIX.length);
      let id = encoded;
      try { id = decodeURIComponent(encoded); } catch { /* keep encoded id */ }
      addRaw(id, key, vaultGet(key), 'account');
    }
  }

  // … sehr alte Profil-Vaults können noch unmigriert in localStorage liegen.
  for (const key of localStorageKeyList()) {
    const legacy = key.match(/^traeky:profile:(.+):data$/);
    if (legacy) addRaw(legacy[1], key, localStorage.getItem(key), 'legacy-profile');
  }
  return candidates;
}

async function openLocalAccountWithFallback(preferredID, passphrase) {
  const candidates = collectLocalEnvelopeCandidates(preferredID);
  let firstError = null;
  for (const candidate of candidates) {
    try {
      const opened = await decryptVaultWithSecrets(candidate.envelope, passphrase);
      const data = opened.data;
      let accountID = candidate.id;
      const index = ensureAccountIndex();
      const known = accountID && index.accounts.some(p => p.id === accountID);
      if (!known) {
        accountID = registerAccount(accountID || uuid(), data.account?.name || (currentLocale === 'de' ? 'Migrierter Account' : 'Migrated account'), candidate.envelope);
      } else {
        setActiveAccountID(accountID);
        if (candidate.key !== accountVaultKey(accountID)) vaultSet(accountVaultKey(accountID), JSON.stringify(candidate.envelope));
      }
      return { opened, envelope: candidate.envelope, activeAccountID: accountID };
    } catch (err) {
      if (!firstError) firstError = err;
    }
  }
  if (!candidates.length) throw new Error(t('account_data_missing'));
  throw firstError || new Error(t('unlock_failed'));
}

function detectLegacy() {
  const oldProfilesRaw = localStorage.getItem("traeky:profiles:index");
  let oldProfiles = [];
  try {
    const idx = oldProfilesRaw ? JSON.parse(oldProfilesRaw) : null;
    if (idx && Array.isArray(idx.profiles)) oldProfiles = idx.profiles;
  } catch {}
  const loose = Boolean(localStorage.getItem("traeky:transactions") || localStorage.getItem("traeky:app-config") || localStorage.getItem("traeky:next-tx-id"));
  return { hasLegacy: oldProfiles.length > 0 || loose, oldProfiles, loose };
}

function render() {
  const app = $("#app");
  if (session.unlocked && unlockSessionExpired()) {
    lockCurrentSession("timeout");
    return;
  }
  if (!session.unlocked) {
    stopDashboardPriceRefresh();
    stopCloudHeartbeat();
    pendingRender = false;
    app.innerHTML = renderAuth();
    bindAuth();
    return;
  }
  if (document.querySelector('dialog[open]')) {
    pendingRender = true;
    return;
  }
  pendingRender = false;
  app.innerHTML = renderDashboard();
  bindDashboard();
  manageDashboardPriceRefresh();
  manageCloudHeartbeat();
  requestAnimationFrame(drawCharts);
}

function priceFetchEnabled(data = session.data) {
  return data?.config?.price_fetch_enabled === true;
}

function latestPriceFetchTime(data = session.data) {
  let latest = 0;
  for (const item of Object.values(data?.prices || {})) {
    const time = new Date(item?.fetched_at || item?.updated_at || '').getTime();
    if (Number.isFinite(time) && time > latest) latest = time;
  }
  return latest;
}

function latestPriceFetchLabel(data = session.data) {
  const latest = latestPriceFetchTime(data);
  return latest ? fmtDate(new Date(latest).toISOString()) : t('never');
}

function shouldRefreshPrices(data = session.data, force = false) {
  // The CoinGecko opt-in is a consent gate, not a rate limit: it is enforced
  // before `force` is honored so that no call path can reach the network while
  // price fetching is switched off. `force` only skips the staleness window.
  if (!session.unlocked || !priceFetchEnabled(data)) return false;
  if (force) return true;
  if (Date.now() - priceRefreshLastRun < PRICE_REFRESH_STALE_MS) return false;
  const latest = latestPriceFetchTime(data);
  return !latest || Date.now() - latest >= PRICE_REFRESH_STALE_MS;
}

function stopDashboardPriceRefresh() {
  if (priceRefreshTimer) clearInterval(priceRefreshTimer);
  priceRefreshTimer = null;
}

function manageDashboardPriceRefresh() {
  if (!session.unlocked || session.route !== 'overview' || !priceFetchEnabled(session.data)) {
    stopDashboardPriceRefresh();
    return;
  }
  if (!priceRefreshTimer) {
    priceRefreshTimer = setInterval(() => {
      if (session.unlocked && session.route === 'overview') refreshPrices({ silent: true });
    }, PRICE_REFRESH_INTERVAL_MS);
  }
  if (shouldRefreshPrices(session.data)) refreshPrices({ silent: true });
}

function stopCloudHeartbeat() {
  if (cloudHeartbeatTimer) clearInterval(cloudHeartbeatTimer);
  cloudHeartbeatTimer = null;
}

function manageCloudHeartbeat() {
  if (!session.unlocked || !session.data || !enabledCloudTargets().length) {
    stopCloudHeartbeat();
    return;
  }
  if (!cloudHeartbeatTimer) {
    cloudHeartbeatTimer = setInterval(() => runCloudHeartbeat({ silent: true }), CLOUD_HEARTBEAT_INTERVAL_MS);
  }
  if (Date.now() - cloudHeartbeatLastRun >= CLOUD_HEARTBEAT_INTERVAL_MS) runCloudHeartbeat({ silent: true });
}

function renderAuth() {
  const accounts = listLocalAccounts();
  const hasVault = accounts.some(p => loadLocalEnvelope(p.id));
  const activeID = getActiveAccountID();
  const legacy = detectLegacy();
  const accountOptions = accounts.map(p => `<option value="${escapeHTML(p.id)}" ${p.id === activeID ? 'selected' : ''}>${escapeHTML(p.name || p.id)} · ${fmtDate(p.updated_at)}</option>`).join("");
  const oldProfileOptions = legacy.oldProfiles.map(p => `<option value="${escapeHTML(p.id)}">${escapeHTML(p.name || p.id)}</option>`).join("");
  return `
    <main class="auth-layout compact-auth">
      <section class="auth-intro">
        <div class="brand"><img src="/icon.svg" alt=""/> Traeky</div>
        <div class="hero-copy">
          <div class="eyebrow">${t('auth_eyebrow')}</div>
          <h1>${t('auth_title')}</h1>
          <p>${t('auth_subtitle')}</p>
          <p class="smallprint">${t('auth_profile_hint')}</p>
        </div>
      </section>
      <section class="auth-card auth-card-compact">
        <div class="tabs">
          <button class="tab-btn ${hasVault ? "active" : ""}" data-auth-tab="unlock">${t('tab_unlock')}</button>
          <button class="tab-btn ${!hasVault ? "active" : ""}" data-auth-tab="setup">${t('tab_setup')}</button>
          ${legacy.hasLegacy ? `<button class="tab-btn" data-auth-tab="legacy">${t('tab_legacy')}</button>` : ""}
          <button class="tab-btn" data-auth-tab="restore">${t('tab_restore')}</button>
          <button class="tab-btn" data-auth-tab="file">${t('tab_file')}</button>
        </div>
        <div id="auth-unlock" class="auth-pane ${hasVault ? "" : "hidden"}">
          <h2>${t('welcome_back')}</h2>
          <p>${t('choose_account')}</p>
          <form id="unlock-form" class="form-grid">
            <div class="form-row"><label>${t('account')}</label><select name="profile_id" ${accountOptions ? '' : 'disabled'}>${accountOptions || `<option>${t('no_account')}</option>`}</select></div>
            <div class="form-row"><label>${t('passphrase')}</label><input type="password" name="passphrase" autocomplete="current-password" required /></div>
            <button class="btn" type="submit" ${accountOptions ? '' : 'disabled'}>${t('login')}</button>
            <div id="unlock-msg"></div>
          </form>
        </div>
        <div id="auth-setup" class="auth-pane ${hasVault ? "hidden" : ""}">
          <h2>${t('setup_title')}</h2>
          <p>${t('setup_copy')}</p>
          <form id="setup-form" class="form-grid">
            <div class="form-row"><label>${t('account_name')}</label><input name="name" value="${t('my_portfolio')}" maxlength="80" required /></div>
            <div class="form-row"><label>${t('passphrase')}</label><input type="password" name="passphrase" autocomplete="new-password" minlength="12" required /></div>
            <div class="form-row"><label>${t('repeat_passphrase')}</label><input type="password" name="confirm" autocomplete="new-password" minlength="12" required /></div>
            ${renderAccountTermsConsent()}
            ${renderCoinGeckoConsent(false)}
            ${legacy.loose ? `<label><input type="checkbox" name="migrateLoose" checked /> ${t('migrate_found')}</label>` : ""}
            <button class="btn" type="submit">${t('create_account')}</button>
            <div id="setup-msg"></div>
          </form>
        </div>
        <div id="auth-legacy" class="auth-pane hidden">
          <h2>${t('legacy_title')}</h2>
          ${legacy.hasLegacy ? `<p>${t('legacy_found')}</p>` : `<p>${t('legacy_none')}</p>`}
          <form id="legacy-form" class="form-grid">
            <div class="form-row"><label>${t('existing_account')}</label><select name="profileId" ${oldProfileOptions ? "" : "disabled"}>${oldProfileOptions || `<option>${t('account_not_found')}</option>`}</select></div>
            <div class="form-row"><label>${t('old_passphrase')}</label><input type="password" name="oldPassphrase" ${oldProfileOptions ? "required" : "disabled"}/></div>
            <div class="form-row"><label>${t('new_passphrase')}</label><input type="password" name="newPassphrase" autocomplete="new-password" minlength="12" ${oldProfileOptions ? "required" : "disabled"}/></div>
            <div class="form-row"><label>${t('repeat_new_passphrase')}</label><input type="password" name="confirmNewPassphrase" autocomplete="new-password" minlength="12" ${oldProfileOptions ? "required" : "disabled"}/></div>
            ${oldProfileOptions ? renderAccountTermsConsent() : ""}
            ${oldProfileOptions ? renderCoinGeckoConsent(false) : ""}
            <button class="btn" type="submit" ${oldProfileOptions ? "" : "disabled"}>${t('migrate_to_new')}</button>
            <div id="legacy-msg"></div>
          </form>
        </div>
        <div id="auth-restore" class="auth-pane hidden">
          <h2>${t('recovery_restore_title')}</h2>
          <p>${t('recovery_restore_copy')}</p>
          <form id="restore-form" class="form-grid">
            <div class="form-row"><label>${t('account_name')}</label><input name="name" value="${t('my_portfolio')}" maxlength="80" required /></div>
            <div class="form-row"><label>${t('recovery_phrase_input')}</label><textarea name="mnemonic" autocomplete="off" spellcheck="false" required></textarea></div>
            <div class="form-row"><label>${t('new_passphrase')}</label><input type="password" name="passphrase" autocomplete="new-password" minlength="12" required /></div>
            <div class="form-row"><label>${t('repeat_passphrase')}</label><input type="password" name="confirm" autocomplete="new-password" minlength="12" required /></div>
            <div class="form-row"><label>${t('cloud_urls')}</label><textarea name="cloud_urls" rows="3" placeholder="https://cloud-a.example.org&#10;https://cloud-b.example.org" required></textarea><p class="smallprint">${t('restore_cloud_urls_hint')}</p></div>
            ${renderAccountTermsConsent()}
            ${renderCoinGeckoConsent(false)}
            <div class="btn-row"><button class="btn secondary" id="restore-check-cloud" type="button">${t('restore_check_cloud')}</button><button class="btn" type="submit">${t('restore_account')}</button></div>
            <div id="restore-msg"></div>
          </form>
        </div>
        <div id="auth-file" class="auth-pane hidden">
          <h2>${t('file_import_title')}</h2>
          <p>${t('file_import_copy')}</p>
          <form id="file-open-form" class="form-grid">
            <div class="form-row"><label>${t('passphrase')}</label><input type="password" name="passphrase" autocomplete="current-password" required /></div>
            <button class="btn" type="submit">${t('file_choose_open')}</button>
            <div id="file-open-msg"></div>
          </form>
        </div>
      </section>
      ${renderRecoveryConfirmDialog()}
      ${renderCloudTermsDialog()}
    </main>`;
}

function renderRecoveryConfirmDialog() {
  return `<dialog class="dialog recovery-dialog" id="recovery-confirm-dialog"><div class="dialog-body" id="recovery-dialog-body"></div></dialog>`;
}

function restoreCloudVerificationKey(rawURLs) {
  return parseCloudURLs(rawURLs || '').join('\n');
}

function rememberRestoreCloudVerification(rawURLs, result) {
  restoreCloudVerificationCache = { key: restoreCloudVerificationKey(rawURLs), checked_at: Date.now(), result };
  return result;
}

function getRememberedRestoreCloudVerification(rawURLs) {
  if (!restoreCloudVerificationCache) return null;
  if (restoreCloudVerificationCache.key !== restoreCloudVerificationKey(rawURLs)) return null;
  if (Date.now() - restoreCloudVerificationCache.checked_at > 15 * 60 * 1000) return null;
  return restoreCloudVerificationCache.result;
}

function clearRestoreCloudVerification() {
  restoreCloudVerificationCache = null;
}

async function verifyRestoreCloudServers(rawURLs, msg = null) {
  const urls = parseCloudURLs(rawURLs || '');
  if (!urls.length) throw new Error(t('restore_cloud_required'));
  const checked = [];
  const errors = [];
  for (const url of urls) {
    let target = normalizeCloudTarget({ url, enabled: true });
    try {
      if (msg) msg.innerHTML = `<div class="notice info">${t('restore_checking_cloud', { url: escapeHTML(url) })}</div>`;
      await fetchCloudServerHealth(url);
      target = normalizeCloudTarget({
        ...target,
        last_heartbeat_at: nowISO(),
        last_status: 'synced',
        last_error: '',
        cloud_retention_days: target.cloud_retention_days ?? null
      });
      const info = await fetchCloudServerInfo(url);
      const terms = normalizeCloudTerms(info);
      const confirmation = await confirmCloudTerms(url, info);
      if (!confirmation.accepted) throw new Error(t('cloud_terms_required'));
      target = mergeCloudTargetInfo(target, info, terms);
      checked.push(target);
    } catch (err) {
      target = normalizeCloudTarget({ ...target, last_heartbeat_at: nowISO(), last_status: 'offline', last_error: sanitizeServerText(err.message || err) });
      checked.push(target);
      errors.push(`${url}: ${target.last_error}`);
    }
  }
  if (errors.length === urls.length) throw new Error(errors.join(' · '));
  return { targets: checked, errors };
}

function bindAuth() {
  $$('[data-page-action]').forEach(btn => btn.addEventListener('click', () => {
    const key = btn.dataset.pageKey;
    const state = paginationState(key);
    if (btn.dataset.pageAction === 'first') state.page = 1;
    if (btn.dataset.pageAction === 'prev') state.page = Math.max(1, state.page - 1);
    if (btn.dataset.pageAction === 'next') state.page += 1;
    if (btn.dataset.pageAction === 'last') state.page = Number.MAX_SAFE_INTEGER;
    render();
  }));
  $$('[data-page-size]').forEach(select => select.addEventListener('change', () => {
    const key = select.dataset.pageSize;
    const state = paginationState(key);
    state.size = Number(select.value) || DEFAULT_PAGE_SIZE;
    state.page = 1;
    render();
  }));
  $$('[data-auth-tab]').forEach(btn => btn.addEventListener('click', () => {
    $$('[data-auth-tab]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $$('.auth-pane').forEach(p => p.classList.add('hidden'));
    $(`#auth-${btn.dataset.authTab}`).classList.remove('hidden');
  }));

  $('#unlock-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('#unlock-msg');
    msg.innerHTML = `<div class="notice info">${t('opening_account')}</div>`;
    try {
      const fd = new FormData(e.currentTarget);
      const profileID = String(fd.get('profile_id') || getActiveAccountID());
      const passphrase = String(fd.get('passphrase') || '');
      const result = await openLocalAccountWithFallback(profileID, passphrase);
      const opened = result.opened;
      const envelope = result.envelope;
      const data = opened.data;
      session = { ...session, unlocked: true, passphrase, rootSecret: opened.rootSecret, data, envelope, lastRemoteRevision: Number(data.config.last_remote_revision || 0), route: 'overview', activeAccountID: result.activeAccountID };
      updateCurrentAccountMeta(data, envelope);
      saveUnlockSession({ force: true, allowExpired: true });
      render();
    } catch (err) {
      msg.innerHTML = `<div class="notice danger">${t('unlock_failed')}: ${escapeHTML(err.message || err)}</div>`;
    }
  });

  $('#setup-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const passphrase = String(fd.get('passphrase') || '');
    const confirm = String(fd.get('confirm') || '');
    const err = validatePassphrase(passphrase) || (passphrase !== confirm ? t('passphrase_mismatch') : '') || validateAccountTermsAcceptance(fd);
    if (err) { $('#setup-msg').innerHTML = `<div class="notice danger">${escapeHTML(err)}</div>`; return; }
    $('#setup-msg').innerHTML = `<div class="notice info">${t('recovery_phrase_loading')}</div>`;
    try {
      pendingSetupRecovery = await generateRecovery();
      pendingAccountSetup = { name: String(fd.get('name') || 'Default'), passphrase, migrateLoose: Boolean(fd.get('migrateLoose')), coingeckoOptIn: String(fd.get('coingecko_opt_in') || '') === 'on', accountTerms: accountTermsSnapshot() };
      $('#setup-msg').innerHTML = '';
      openRecoveryConfirmDialog();
    } catch (err) {
      pendingSetupRecovery = null;
      pendingAccountSetup = null;
      $('#setup-msg').innerHTML = `<div class="notice danger">${t('recovery_phrase_unavailable')}: ${escapeHTML(err.message || err)}</div>`;
    }
  });


  $('#restore-check-cloud')?.addEventListener('click', async () => {
    const msg = $('#restore-msg');
    const form = $('#restore-form');
    try {
      const fd = new FormData(form);
      const result = rememberRestoreCloudVerification(fd.get('cloud_urls'), await verifyRestoreCloudServers(fd.get('cloud_urls'), msg));
      if (msg) msg.innerHTML = `<div class="notice ${result.errors.length ? 'info' : 'success'}">${t('restore_cloud_check_ok', { ok: result.targets.length - result.errors.length, total: result.targets.length })}${result.errors.length ? `<br/><span class="smallprint">${escapeHTML(result.errors.join(' · '))}</span>` : ''}</div>`;
    } catch (err) {
      clearRestoreCloudVerification();
      if (msg) msg.innerHTML = `<div class="notice danger">${t('cloud_test_failed')}: ${escapeHTML(err.message || err)}</div>`;
    }
  });

  $('#file-open-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('#file-open-msg');
    const passphrase = String(new FormData(e.currentTarget).get('passphrase') || '');
    if (!passphrase) { msg.innerHTML = `<div class="notice danger">${t('file_passphrase_required')}</div>`; return; }
    let picked;
    try {
      picked = await readVaultFileViaPicker();
    } catch (err) {
      if (err?.name === 'AbortError') return; // Auswahl abgebrochen
      msg.innerHTML = `<div class="notice danger">${escapeHTML(err.message || err)}</div>`;
      return;
    }
    msg.innerHTML = `<div class="notice info">${t('opening_account')}</div>`;
    try {
      const envelope = parseVaultFile(picked.text);
      await openVaultFromEnvelope(envelope, passphrase, { handle: picked.handle });
    } catch (err) {
      msg.innerHTML = `<div class="notice danger">${t('file_import_failed')}: ${escapeHTML(err.message || err)}</div>`;
    }
  });

  $('#restore-form textarea[name="cloud_urls"]')?.addEventListener('input', clearRestoreCloudVerification);

  $('#restore-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const msg = $('#restore-msg');
    msg.innerHTML = `<div class="notice info">${t('opening_account')}</div>`;
    try {
      const passphrase = String(fd.get('passphrase') || '');
      const confirm = String(fd.get('confirm') || '');
      const err = validatePassphrase(passphrase) || (passphrase !== confirm ? t('passphrase_mismatch') : '') || validateAccountTermsAcceptance(fd);
      if (err) throw new Error(err);
      const rootSecret = await mnemonicToEntropy(String(fd.get('mnemonic') || ''));
      const coingeckoOptIn = String(fd.get('coingecko_opt_in') || '') === 'on';
      let data = defaultData(String(fd.get('name') || 'Default'));
      await applyRootDerivedConfig(data, rootSecret);
      const derived = await deriveRootCloudSecrets(rootSecret);
      const rawCloudURLs = fd.get('cloud_urls') || '';
      const cloudURLs = parseCloudURLs(rawCloudURLs);
      const restoreCheck = getRememberedRestoreCloudVerification(rawCloudURLs) || rememberRestoreCloudVerification(rawCloudURLs, await verifyRestoreCloudServers(rawCloudURLs, msg));
      if (cloudURLs.length) {
        const attempts = [
          { vaultID: derived.vaultID, authSecret: derived.authSecret, legacy: false },
          { vaultID: derived.legacyVaultID, authSecret: derived.legacyAuthSecret, legacy: true }
        ];
        const candidates = [];
        const targetState = new Map(restoreCheck.targets.map(target => [target.url, target]));
        const failures = [...(restoreCheck.errors || [])];
        // A fresh restore knows nothing about the vaults on these servers, so
        // each vault-ID candidate is probed with the origin-bound proof first
        // and with the legacy proof as a fallback for vaults not yet migrated.
        const proofVersions = [CLOUD_AUTH_PROOF_V2, CLOUD_AUTH_PROOF_V1];
        for (const url of cloudURLs) {
          let settled = false;
          for (const attempt of attempts) {
            if (settled) break;
            try {
              const endpoint = `${url}${CLOUD_API_PREFIX}/vaults/${encodeURIComponent(attempt.vaultID)}`;
              let res = null;
              let proofVersion = proofVersions[0];
              for (const version of proofVersions) {
                proofVersion = version;
                res = await fetch(endpoint, { headers: traekyClientHeaders({ 'X-Traeky-Vault-Auth': await cloudAuthProof(attempt.authSecret, url, version) }) });
                if (res.status !== 401) break;
              }
              if (res.ok) {
                const payload = await safeJSON(res);
                const state = normalizeCloudTarget({ ...(targetState.get(url) || {}), url, last_sync_at: nowISO(), last_remote_revision: Number(payload.revision || 0), last_remote_auth_secret: attempt.authSecret, auth_proof_version: proofVersion, updated_at: payload.updated_at || payload.body?.sealed_at || nowISO(), last_status: 'synced', last_error: '' });
                targetState.set(url, state);
                candidates.push({ url, attempt, payload, target: state });
                settled = true;
                break;
              }
              if (res.status !== 404) {
                const payload = await safeJSON(res);
                const state = normalizeCloudTarget({ ...(targetState.get(url) || {}), url, last_status: res.status === 401 ? 'conflict' : 'offline', last_error: serverErrorMessage(payload, res) });
                targetState.set(url, state);
                failures.push(`${url}: ${state.last_error}`);
                settled = true;
                break;
              }
            } catch (err) {
              const state = normalizeCloudTarget({ ...(targetState.get(url) || {}), url, last_status: 'offline', last_error: sanitizeServerText(err.message || err) });
              targetState.set(url, state);
              failures.push(`${url}: ${state.last_error}`);
              settled = true;
              break;
            }
          }
        }
        if (candidates.length) {
          candidates.sort((a, b) => remoteTimestamp(b.payload) - remoteTimestamp(a.payload));
          const selected = candidates[0];
          data = await decryptRemoteVault(selected.payload.body, passphrase, rootSecret);
          data.config = { ...data.config, cloud_key: derived.vaultID, cloud_auth_secret: derived.authSecret, last_remote_auth_secret: derived.authSecret };
        } else if (failures.length >= cloudURLs.length) {
          throw new Error(failures.join(' · '));
        }
        setCloudTargets(data.config, [...targetState.values()]);
      }
      data.config.price_fetch_enabled = coingeckoOptIn;
      attachAccountTerms(data, accountTermsSnapshot());
      const profileID = registerAccount(uuid(), data.account.name);
      session = { ...session, unlocked: true, passphrase, rootSecret, data, route: 'overview', activeAccountID: profileID };
      await persist(cloudURLs.length ? (currentLocale === 'de' ? 'Account aus Recovery-Phrase wiederhergestellt' : 'Account restored from recovery phrase') : t('restore_empty_created'));
    } catch (err) {
      msg.innerHTML = `<div class="notice danger">${t('restore_failed')}: ${escapeHTML(err.message || err)}</div>`;
    }
  });

  $('#legacy-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const msg = $('#legacy-msg');
    msg.innerHTML = `<div class="notice info">${t('importing_data')}</div>`;
    try {
      const newPass = String(fd.get('newPassphrase') || '');
      const confirmNewPass = String(fd.get('confirmNewPassphrase') || '');
      const err = validatePassphrase(newPass) || (newPass !== confirmNewPass ? t('passphrase_mismatch') : '') || validateAccountTermsAcceptance(fd);
      if (err) throw new Error(err);
      const oldProfileID = String(fd.get('profileId'));
      const raw = localStorage.getItem(`traeky:profile:${oldProfileID}:data`);
      if (!raw) throw new Error(t('account_data_missing'));
      const data = await decryptLegacyPayload(JSON.parse(raw), String(fd.get('oldPassphrase') || ''));
      const idx = JSON.parse(localStorage.getItem('traeky:profiles:index') || '{}');
      const meta = (idx.profiles || []).find(p => p.id === oldProfileID);
      if (meta?.name) data.account.name = `${meta.name} (${t('migrated_suffix')})`;
      pendingSetupRecovery = await generateRecovery();
      pendingAccountSetup = { name: data.account.name, passphrase: newPass, migratedData: data, source: 'legacy', coingeckoOptIn: String(fd.get('coingecko_opt_in') || '') === 'on', accountTerms: accountTermsSnapshot() };
      msg.innerHTML = `<div class="notice success">${t('legacy_ready_for_recovery')}</div>`;
      openRecoveryConfirmDialog();
    } catch (err) {
      pendingSetupRecovery = null;
      pendingAccountSetup = null;
      msg.innerHTML = `<div class="notice danger">${t('migration_failed')}: ${escapeHTML(err.message || err)}</div>`;
    }
  });
}

function migrateLooseLegacy(data) {
  try {
    const tx = JSON.parse(localStorage.getItem('traeky:transactions') || '[]');
    const cfg = JSON.parse(localStorage.getItem('traeky:app-config') || '{}');
    const nextTransactionId = Number(localStorage.getItem('traeky:next-tx-id') || 0) || undefined;
    data = normalizeData({ ...data, transactions: tx, config: { ...data.config, ...cfg }, nextTransactionId }, data.account.name);
    migrateLegacyPriceCaches(data);
    addAudit(data, currentLocale === 'de' ? 'Vorhandene lokale Daten übernommen' : 'Existing local data imported');
  } catch (err) {
    addAudit(data, currentLocale === 'de' ? `Übernahme vorhandener lokaler Daten fehlgeschlagen: ${err.message || err}` : `Existing local data import failed: ${err.message || err}`);
  }
  return data;
}

function cloudOverviewStatus(cfg = session.data?.config) {
  const enabled = enabledCloudTargets(cfg);
  if (!enabled.length) return { state: 'disabled', label: t('cloud_status_disabled'), detail: t('not_configured'), lastSync: '' };
  const problems = enabled.filter(x => ['offline', 'conflict'].includes(String(x.last_status || '').toLowerCase()) || String(x.last_error || '').trim());
  if (problems.length) return { state: 'warning', label: t('cloud_status_warning'), detail: `${problems.length}/${enabled.length} ${t('cloud_targets')}`, lastSync: latestSyncLabel(enabled) };
  return { state: 'enabled', label: t('cloud_status_enabled'), detail: `${enabled.length} ${t('cloud_targets')}`, lastSync: latestSyncLabel(enabled) };
}

function renderCloudAccountStatus(cfg, profileCount) {
  const status = cloudOverviewStatus(cfg);
  const syncLine = status.state !== 'disabled' ? `<span>${t('last_sync')}: ${escapeHTML(status.lastSync || t('never'))}</span>` : '';
  return `<span class="cloud-chip-line"><b>${t('cloud_prefix')}:</b> <span class="cloud-pill ${status.state}">${escapeHTML(status.label)}</span></span>${syncLine}`;
}

function renderDashboard() {
  const d = session.data;
  const summary = computeSummary(d);
  const profileCount = listLocalAccounts().length;
  return `
    <div class="dashboard">
      <aside class="sidebar">
        <div class="brand"><img src="/icon.svg" alt=""/> Traeky</div>
        <nav>
          ${navButton('overview', '◆', t('nav_dashboard'))}
          ${navButton('transactions', '↕', t('nav_transactions'))}
          ${navButton('tax', 'ƒ', t('nav_tax'))}
          ${navButton('assets', '◌', t('nav_assets'))}
          ${navButton('import', '⇩', t('nav_import'))}
          ${navButton('sync', '☁', t('nav_sync'))}
          ${navButton('settings', '⚙', t('nav_settings'))}
        </nav>
        <div class="profile-chip"><b>${escapeHTML(d.account.name)}</b>${renderCloudAccountStatus(d.config, profileCount)}</div>
        ${renderSidebarLegalFooter()}
      </aside>
      <main class="main">
        <div class="topbar">
          <div><h2>${sectionTitle(session.route)}</h2><p>${t('last_change')}: ${fmtDate(d.updated_at)} · ${t('active_profile')}: ${escapeHTML(activeTxProfile(d).name)}</p></div>
          <div class="btn-row topbar-actions">
            <select id="active-profile-switch" class="inline-select account-profile-select" title="${t('active_profile')}">${txProfileOptions(activeTxProfileID(d))}</select>
            <button class="btn secondary" id="lock-btn">${t('lock')}</button>
            <button class="btn" id="add-tx-btn">${t('add_tx')}</button>
          </div>
        </div>
        ${renderOverview(summary)}
        ${renderTransactions(summary)}
        ${renderTaxReport(summary)}
        ${renderAssetsPrices(summary)}
        ${renderImportExport()}
        ${renderSync()}
        ${renderSettings()}
      </main>
      ${renderTxDialog()}
      ${renderCloudTermsDialog()}
      ${renderCloudTargetDeleteDialog()}
      ${renderCloudDeleteDialog()}
      ${renderLocalDeleteDialog()}
    </div>`;
}

function URLSafe(value) {
  try { return new URL(value).origin; } catch { return value || ''; }
}

function normalizeExternalLegalURL(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['https:', 'http:'].includes(parsed.protocol)) return '';
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function cloudLegalLinksFromSource(source = {}) {
  const privacyPolicyURL = normalizeExternalLegalURL(source.privacy_policy_url || source.privacyPolicyUrl || '');
  const imprintURL = normalizeExternalLegalURL(source.imprint_url || source.imprintUrl || '');
  const links = [];
  if (privacyPolicyURL) links.push({ label: t('privacy_policy'), url: privacyPolicyURL, kind: 'privacy' });
  if (imprintURL) links.push({ label: t('imprint'), url: imprintURL, kind: 'imprint' });
  return links;
}

function renderCloudLegalLinks(source = {}, options = {}) {
  const links = cloudLegalLinksFromSource(source);
  if (!links.length) return '';
  const classes = options.compact ? 'cloud-legal-links compact' : 'cloud-legal-links';
  const title = options.title === false ? '' : `<span class="cloud-legal-title">${escapeHTML(t('cloud_legal_links'))}</span>`;
  return `<div class="${classes}">${title}${links.map(link => `<a href="${escapeHTML(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(link.label)}</a>`).join('')}</div>`;
}

function normalizeCommitShort(value) {
  const commit = sanitizeVersionString(value, 64);
  return commit.length > 7 ? commit.slice(0, 7) : commit;
}

function appVersionLabel() {
  const version = currentAppVersion();
  const commit = normalizeCommitShort(appInfo.commit_short || appInfo.commitShort || appInfo.commit || '');
  return `v${version}${commit ? ` (${commit})` : ''}`;
}

function renderSidebarLegalFooter() {
  const links = cloudLegalLinksFromSource(appInfo);
  const linkHTML = links.map(link => `<a href="${escapeHTML(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(link.label)}</a>`).join('<span class="legal-separator">·</span>');
  return `<div class="sidebar-legal-card"><div class="sidebar-version">${escapeHTML(appVersionLabel())}</div>${linkHTML ? `<div class="sidebar-legal-links">${linkHTML}</div>` : ''}</div>`;
}

function navButton(route, icon, label) {
  return `<button class="nav-btn ${session.route === route ? 'active' : ''}" data-route="${route}"><span>${icon}</span>${label}</button>`;
}

function sectionTitle(route) {
  return ({ overview: t('nav_dashboard'), transactions: t('nav_transactions'), tax: t('nav_tax'), assets: t('nav_assets'), import: t('nav_import'), sync: t('nav_sync'), settings: t('nav_settings') })[route] || t('nav_dashboard');
}

function computeSummary(data, txOverride = null) {
  const sourceTransactions = Array.isArray(txOverride) ? txOverride : scopedTransactions(data);
  const holdings = new Map();
  let invested = 0;
  let realized = 0;
  for (const tx of sourceTransactions) {
    if (tx.ignored) continue;
    const sign = txSign(tx.tx_type);
    const price = Number(txUnitPriceInCurrency(tx, data.config.base_currency, true) ?? priceCacheLookup(data, tx.asset_symbol, data.config.base_currency, tx.timestamp) ?? crossCurrencyPrice(data, tx.price_fiat, tx.fiat_currency, data.config.base_currency, tx.asset_symbol, tx.timestamp) ?? 0);
    if (sign !== 0) holdings.set(tx.asset_symbol, (holdings.get(tx.asset_symbol) || 0) + sign * Number(tx.amount || 0));
    if (tx.fee_asset) holdings.set(tx.fee_asset, (holdings.get(tx.fee_asset) || 0) - Number(tx.fee_amount || 0));
    const value = Math.abs(Number(tx.amount || 0) * price);
    if (ACQUISITION_TYPES.has(tx.tx_type)) invested += value;
    if (DISPOSAL_TYPES.has(tx.tx_type)) realized += value;
  }
  const items = Array.from(holdings.entries())
    .filter(([, amount]) => Math.abs(amount) > 1e-12)
    .map(([symbol, amount]) => {
      const current = currentPrice(data, symbol, sourceTransactions);
      return { symbol, amount, price: current, value: amount * current };
    })
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const unrealized = total + realized - invested;
  const expiring = computeExpiring(data, sourceTransactions);
  return { items, total, invested, realized, unrealized, expiring, txCount: sourceTransactions.length };
}

function txSign(type) {
  const tval = String(type || '').toUpperCase();
  if (ACQUISITION_TYPES.has(tval)) return 1;
  if (DISPOSAL_TYPES.has(tval)) return -1;
  return 0;
}

function txUnitPriceInCurrency(tx, currency = 'EUR') {
  const quote = canonicalAssetSymbol(currency || 'EUR');
  const qty = Math.abs(Number(tx.amount || 0));
  const totalForQuote = quote === 'EUR' ? tx.value_eur : quote === 'USD' ? tx.value_usd : null;
  if (totalForQuote != null && Number.isFinite(Number(totalForQuote)) && qty > 0) return Math.abs(Number(totalForQuote)) / qty;
  if (String(tx.fiat_currency || '').toUpperCase() === quote) {
    if (tx.price_fiat != null && Number.isFinite(Number(tx.price_fiat))) return Number(tx.price_fiat);
    if (tx.fiat_value != null && Number.isFinite(Number(tx.fiat_value)) && qty > 0) return Math.abs(Number(tx.fiat_value)) / qty;
  }
  return null;
}

// Converts a price from one fiat currency to another using the asset's own
// CoinGecko prices in both currencies as the implied exchange rate.
// E.g. IOTA at EUR 0.0553 and USD 0.0625 implies USD→EUR = 0.0553/0.0625.
function crossCurrencyPrice(data, priceInFrom, fromCurrency, toCurrency, asset, timestamp) {
  const from = String(fromCurrency || '').toUpperCase();
  const to = String(toCurrency || '').toUpperCase();
  if (!from || !to || from === to) return null;
  if (priceInFrom == null || !Number.isFinite(Number(priceInFrom))) return null;
  const sym = canonicalAssetSymbol(asset, data?.asset_aliases);
  const assetInFrom = priceCacheLookup(data, sym, from, timestamp) ?? (Number(data?.prices?.[sym]?.[from.toLowerCase()]) || null);
  const assetInTo   = priceCacheLookup(data, sym, to,   timestamp) ?? (Number(data?.prices?.[sym]?.[to.toLowerCase()])   || null);
  if (!Number.isFinite(Number(assetInFrom)) || Number(assetInFrom) <= 0) return null;
  if (!Number.isFinite(Number(assetInTo))) return null;
  return Number(priceInFrom) * (Number(assetInTo) / Number(assetInFrom));
}

function currentPrice(data, symbol, txOverride = null) {
  const asset = canonicalAssetSymbol(symbol, data.asset_aliases);
  const quote = String(data.config.base_currency || 'EUR').toLowerCase();
  const cached = data.prices?.[asset]?.[quote];
  if (Number.isFinite(Number(cached))) return Number(cached);
  const manual = priceCacheLookup(data, asset, data.config.base_currency, nowISO());
  if (Number.isFinite(Number(manual))) return Number(manual);
  const sourceTransactions = Array.isArray(txOverride) ? txOverride : scopedTransactions(data);
  const txs = [...sourceTransactions].filter(tx => tx.asset_symbol === asset).sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
  for (const tx of txs) {
    const exact = txUnitPriceInCurrency(tx, data.config.base_currency);
    if (Number.isFinite(Number(exact)) && Number(exact) > 0) return Number(exact);
  }
  for (const tx of txs) {
    const converted = crossCurrencyPrice(data, tx.price_fiat, tx.fiat_currency, data.config.base_currency, tx.asset_symbol, tx.timestamp);
    if (Number.isFinite(Number(converted)) && Number(converted) > 0) return Number(converted);
  }
  return 0;
}

function computeExpiring(data, txOverride = null) {
  const days = Number(data.config.holding_period_days || 365);
  const windowDays = Number(data.config.upcoming_holding_window_days || 30);
  const now = Date.now();
  const sourceTransactions = Array.isArray(txOverride) ? txOverride : scopedTransactions(data);
  return sourceTransactions
    .filter(tx => !tx.ignored && ACQUISITION_TYPES.has(tx.tx_type))
    .map(tx => {
      const end = new Date(new Date(tx.timestamp).getTime() + days * 86400000);
      return { tx, end, days_remaining: Math.ceil((end.getTime() - now) / 86400000) };
    })
    .filter(x => x.days_remaining >= 0 && x.days_remaining <= windowDays)
    .sort((a, b) => a.days_remaining - b.days_remaining);
}

function renderOverview(summary) {
  const c = session.data.config.base_currency;
  const priceStatus = priceFetchEnabled(session.data) ? `${t('price_auto_refresh_hint')} · ${t('last_price_update')}: ${latestPriceFetchLabel(session.data)}` : t('price_auto_refresh_disabled');
  return `<section class="section ${session.route === 'overview' ? 'active' : ''}" id="section-overview">
    <div class="kpi-grid">
      ${kpi('Portfolio', fmtMoney(summary.total, c), t('overview_portfolio_delta', { count: summary.items.length }))}
      ${kpi(t('invested'), fmtMoney(summary.invested, c), t('invested_delta'))}
      ${kpi(t('realized'), fmtMoney(summary.realized, c), t('realized_delta'))}
      ${kpi(t('pnl'), fmtMoney(summary.unrealized, c), t('pnl_delta'))}
    </div>
    <div class="grid-2">
      <div class="panel"><div class="panel-head"><div><h3>${t('allocation_title')}</h3><p>${t('allocation_desc')}</p></div></div><div class="chart-box"><canvas id="allocation-chart" height="260"></canvas></div></div>
      <div class="panel"><div class="panel-head"><div><h3>${t('timeline_title')}</h3><p>${t('timeline_desc')}</p></div></div><div class="chart-box"><canvas id="timeline-chart" height="260"></canvas></div></div>
    </div>
    <div class="grid-2 mt-16">
      <div class="panel"><div class="panel-head"><div><h3>${t('holding_period_title')}</h3><p>${t('holding_period_desc')}</p></div></div>${renderExpiring(summary.expiring)}</div>
      <div class="panel"><div class="panel-head"><div><h3>${t('holdings_title')}</h3><p>${t('holdings_desc')}<br/><span class="smallprint">${escapeHTML(priceStatus)}</span></p></div><button class="btn secondary small" id="refresh-prices" ${priceFetchEnabled(session.data) ? '' : 'disabled'}>${t('refresh_prices')}</button></div>${renderHoldingsTable(summary)}</div>
    </div>
  </section>`;
}

function kpi(label, value, delta) {
  return `<div class="tile"><span class="label">${escapeHTML(label)}</span><span class="value">${escapeHTML(value)}</span><div class="delta">${escapeHTML(delta)}</div></div>`;
}

function paginationState(key, preferredSize = DEFAULT_PAGE_SIZE) {
  if (!session.pagination || typeof session.pagination !== 'object') session.pagination = {};
  const current = session.pagination[key] || {};
  const size = PAGE_SIZE_OPTIONS.includes(Number(current.size)) ? Number(current.size) : preferredSize;
  const page = Math.max(1, Number(current.page) || 1);
  session.pagination[key] = { page, size };
  return session.pagination[key];
}

function resetPagination(key) {
  if (!session.pagination || typeof session.pagination !== 'object') session.pagination = {};
  if (key) session.pagination[key] = { ...(session.pagination[key] || {}), page: 1 };
}

function paginatedItems(key, items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const state = paginationState(key, options.size || DEFAULT_PAGE_SIZE);
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / state.size));
  state.page = Math.min(Math.max(1, state.page), pages);
  const start = (state.page - 1) * state.size;
  const end = Math.min(total, start + state.size);
  return { rows: list.slice(start, end), total, page: state.page, pages, pageSize: state.size, start, end };
}

function renderPagination(key, meta) {
  if (!meta || meta.total <= meta.pageSize) return '';
  const options = PAGE_SIZE_OPTIONS.map(size => `<option value="${size}" ${size === meta.pageSize ? 'selected' : ''}>${size}</option>`).join('');
  return `<div class="pagination" data-pagination-key="${escapeHTML(key)}">
    <div class="pagination-summary">${t('pagination_showing', { from: meta.start + 1, to: meta.end, total: meta.total })}</div>
    <div class="pagination-controls">
      <button class="btn secondary small" type="button" data-page-action="first" data-page-key="${escapeHTML(key)}" ${meta.page <= 1 ? 'disabled' : ''}>«</button>
      <button class="btn secondary small" type="button" data-page-action="prev" data-page-key="${escapeHTML(key)}" ${meta.page <= 1 ? 'disabled' : ''}>${t('previous')}</button>
      <span class="pagination-page">${t('pagination_page_of', { page: meta.page, pages: meta.pages })}</span>
      <button class="btn secondary small" type="button" data-page-action="next" data-page-key="${escapeHTML(key)}" ${meta.page >= meta.pages ? 'disabled' : ''}>${t('next')}</button>
      <button class="btn secondary small" type="button" data-page-action="last" data-page-key="${escapeHTML(key)}" ${meta.page >= meta.pages ? 'disabled' : ''}>»</button>
      <label class="pagination-size"><span>${t('rows_per_page')}</span><select data-page-size="${escapeHTML(key)}">${options}</select></label>
    </div>
  </div>`;
}

function renderPaginatedTable(key, items, tableFactory, emptyHTML, options = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return emptyHTML;
  const meta = paginatedItems(key, list, options);
  return `${tableFactory(meta.rows)}${renderPagination(key, meta)}`;
}

function renderExpiring(items) {
  return renderPaginatedTable('overview-expiring', items, rows =>
    `<div class="table-wrap"><table><thead><tr><th>${t('asset')}</th><th>${t('amount')}</th><th>${t('end')}</th><th>${t('days_left')}</th></tr></thead><tbody>${rows.map(x => `<tr><td>${escapeHTML(x.tx.asset_symbol)}</td><td>${fmtNum(x.tx.amount)}</td><td>${fmtDate(x.end)}</td><td>${x.days_remaining}</td></tr>`).join('')}</tbody></table></div>`,
    `<div class="empty">${t('no_expiring')}</div>`,
    { size: 10 }
  );
}

function renderHoldingsTable(summary) {
  const c = session.data.config.base_currency;
  return renderPaginatedTable('overview-holdings', summary.items, rows =>
    `<div class="table-wrap"><table><thead><tr><th>${t('asset')}</th><th>${t('amount')}</th><th>${t('price')}</th><th>${t('value')}</th></tr></thead><tbody>${rows.map(i => `<tr><td><b>${escapeHTML(i.symbol)}</b><br/><span class="smallprint">${escapeHTML(ASSET_META[i.symbol]?.name || '')}</span></td><td>${fmtNum(i.amount)}</td><td>${fmtMoney(i.price, c)}</td><td>${fmtMoney(i.value, c)}</td></tr>`).join('')}</tbody></table></div>`,
    `<div class="empty">${t('no_holdings')}</div>`
  );
}

function renderTransactions() {
  const assets = Array.from(new Set(scopedTransactions().map(t => t.asset_symbol))).sort();
  const filtered = filteredTransactions();
  return `<section class="section ${session.route === 'transactions' ? 'active' : ''}" id="section-transactions">
    <div class="panel">
      <div class="panel-head"><div><h3>${t('tx_book')}</h3><p>${t('tx_book_desc')}</p></div><button class="btn secondary" id="export-filtered">${t('filtered_csv')}</button></div>
      <div class="filters">
        <input id="filter-query" placeholder="${t('search_placeholder')}" value="${escapeHTML(session.filter.query)}" />
        <select id="filter-asset"><option value="">${t('all_assets')}</option>${assets.map(a => `<option ${a === session.filter.asset ? 'selected' : ''}>${escapeHTML(a)}</option>`).join('')}</select>
        <select id="filter-type"><option value="">${t('all_types')}</option>${TX_TYPES.map(v => `<option value="${v}" ${v === session.filter.type ? 'selected' : ''}>${txLabel(v)}</option>`).join('')}</select>
        <select id="filter-profile"><option value="active" ${session.filter.profile === 'active' ? 'selected' : ''}>${t('active_profile')}</option><option value="all" ${session.filter.profile === 'all' ? 'selected' : ''}>${t('all_profiles')}</option>${txProfiles().map(p => `<option value="${escapeHTML(p.id)}" ${session.filter.profile === p.id ? 'selected' : ''}>${escapeHTML(p.name)}</option>`).join('')}</select>
        <button class="btn secondary" id="clear-filters">${t('reset')}</button>
      </div>
      ${renderTxTable(filtered)}
    </div>
  </section>`;
}

function filteredTransactions() {
  const q = session.filter.query.trim().toLowerCase();
  return [...scopedTransactions()]
    .filter(tx => !session.filter.asset || tx.asset_symbol === session.filter.asset)
    .filter(tx => !session.filter.type || tx.tx_type === session.filter.type)
    .filter(tx => !q || [tx.asset_symbol, tx.source, tx.location, tx.counterparty, tx.note, tx.tx_id, tx.fiat_currency, (tx.tags || []).join(' '), txProfileName(tx.profile_id)].some(v => String(v || '').toLowerCase().includes(q)))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function renderTxTable(items) {
  const data = session.data;
  const base = data?.config?.base_currency;
  return renderPaginatedTable('transactions', items, rows =>
    `<div class="table-wrap"><table class="tx-table"><thead><tr><th>${t('time')}</th><th>${t('type')}</th><th>${t('asset')}</th><th>${t('amount')}</th><th>${t('price')}</th><th>${t('value')}</th><th>${t('profile')}</th><th>${t('source')}</th><th>${t('action')}</th></tr></thead><tbody>${rows.map(tx => {
      const unitPrice = txUnitPriceInCurrency(tx, base) ?? (base ? priceCacheLookup(data, tx.asset_symbol, base, tx.timestamp) : null) ?? (base ? crossCurrencyPrice(data, tx.price_fiat, tx.fiat_currency, base, tx.asset_symbol, tx.timestamp) : null);
      const txVal = unitPrice != null ? Math.abs(Number(tx.amount || 0) * unitPrice) : null;
      return `
      <tr>
        <td>${fmtDate(tx.timestamp)}<br/><span class="smallprint">#${tx.id}</span></td>
        <td><span class="badge ${tx.tx_type.toLowerCase()}">${escapeHTML(txLabel(tx.tx_type))}</span></td>
        <td><b>${escapeHTML(tx.asset_symbol)}</b><br/><span class="smallprint">${escapeHTML(tx.note || tx.tx_id || '')}</span></td>
        <td>${fmtNum(tx.amount)}</td>
        <td>${tx.price_fiat == null ? '–' : fmtMoney(tx.price_fiat, tx.fiat_currency)}</td>
        <td>${txVal != null ? fmtMoney(txVal, base) : '–'}</td>
        <td>${escapeHTML(txProfileName(tx.profile_id))}</td>
        <td class="tx-source-cell">${escapeHTML(tx.source || '–')}</td>
        <td class="tx-actions-cell"><div class="tx-action-buttons"><button class="btn secondary small" data-edit-tx="${tx.id}">${t('edit')}</button><button class="btn danger small" data-delete-tx="${tx.id}">${t('delete')}</button></div></td>
      </tr>`;
    }).join('')}</tbody></table></div>`,
    `<div class="empty">${t('no_txs_selection')}</div>`
  );
}



function txUnitPrice(data, tx) {
  const price = tx.price_fiat == null ? priceCacheLookup(data, tx.asset_symbol, tx.fiat_currency || data.config.base_currency, tx.timestamp) : tx.price_fiat;
  const num = parseDecimal(price);
  return Number.isFinite(num) ? num : null;
}

function txPriceMissing(data, tx) {
  return txUnitPrice(data, tx) == null;
}

function txValue(data, tx) {
  const base = data?.config?.base_currency;
  if (base) {
    const priceInBase = txUnitPriceInCurrency(tx, base);
    if (priceInBase != null) return Math.abs(parseDecimal(tx.amount || 0) * priceInBase);
    const cachedInBase = priceCacheLookup(data, tx.asset_symbol, base, tx.timestamp);
    if (cachedInBase != null && Number.isFinite(Number(cachedInBase))) return Math.abs(parseDecimal(tx.amount || 0) * Number(cachedInBase));
    const converted = crossCurrencyPrice(data, tx.price_fiat, tx.fiat_currency, base, tx.asset_symbol, tx.timestamp);
    if (converted != null) return Math.abs(parseDecimal(tx.amount || 0) * converted);
  }
  const price = txUnitPrice(data, tx);
  return price == null ? 0 : Math.abs(parseDecimal(tx.amount || 0) * price);
}

function feeValue(data, tx) {
  if (!tx.fee_amount) return 0;
  if (!tx.fee_asset || tx.fee_asset === tx.fiat_currency) return Math.abs(parseDecimal(tx.fee_amount || 0));
  const price = priceCacheLookup(data, tx.fee_asset, tx.fiat_currency || data.config.base_currency, tx.timestamp) || currentPrice(data, tx.fee_asset) || null;
  if (price == null) return null;
  return Math.abs(parseDecimal(tx.fee_amount || 0) * Number(price));
}

function computeTaxReport(data, opts = {}) {
  const method = TAX_METHODS.includes(String(opts.method || data.config?.tax_method || 'FIFO').toUpperCase()) ? String(opts.method || data.config?.tax_method || 'FIFO').toUpperCase() : 'FIFO';
  const from = opts.from ? new Date(`${opts.from}T00:00:00Z`).getTime() : -Infinity;
  const to = opts.to ? new Date(`${opts.to}T23:59:59Z`).getTime() : Infinity;
  const lots = new Map();
  const warnings = [];
  const events = [];
  const incomeEvents = [];
  const acquisitionEvents = [];
  let proceeds = 0, costBasis = 0, fees = 0, incomeTotal = 0, acquisitionTotal = 0;
  const inRange = (tx) => {
    const ts = new Date(tx.timestamp).getTime();
    return ts >= from && ts <= to;
  };
  const addWarning = (msg) => { if (msg) warnings.push(msg); };
  const addLot = (asset, amount, unitCost, timestamp, id) => {
    if (!Number.isFinite(amount) || amount <= 0) return;
    if (!lots.has(asset)) lots.set(asset, []);
    lots.get(asset).push({ amount, unitCost: Number(unitCost || 0), timestamp, id });
  };
  const takeLots = (asset, amount) => {
    const book = lots.get(asset) || [];
    let remaining = Math.abs(amount);
    let cost = 0;
    let acquisitionTs = null;
    while (remaining > 1e-12 && book.length) {
      let idx = 0;
      if (method === 'LIFO') idx = book.length - 1;
      if (method === 'HIFO') idx = book.reduce((best, lot, i) => lot.unitCost > book[best].unitCost ? i : best, 0);
      const lot = book[idx];
      if (acquisitionTs === null) acquisitionTs = lot.timestamp;
      const used = Math.min(lot.amount, remaining);
      cost += used * lot.unitCost;
      lot.amount -= used;
      remaining -= used;
      if (lot.amount <= 1e-12) book.splice(idx, 1);
    }
    if (remaining > 1e-8) addWarning(t('missing_acquisition', { asset, amount: fmtNum(remaining, 8) }));
    return { cost, acquisitionTs };
  };
  const sorted = [...scopedTransactions(data)].map(normalizeTx).filter(Boolean).sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp) || a.sequence - b.sequence || a.id - b.id);
  const noteAcquisitionOrIncome = (tx, value, fee) => {
    const asset = tx.asset_symbol;
    const amount = Math.abs(Number(tx.amount || 0));
    if (!inRange(tx)) return;
    if (INCOME_TYPES.has(tx.tx_type)) {
      const event = { id: tx.id, timestamp: tx.timestamp, type: tx.tx_type, asset, amount, value, fees: fee, profile_id: tx.profile_id };
      incomeEvents.push(event);
      incomeTotal += value;
    } else if (LOT_BUILDING_TYPES.has(tx.tx_type)) {
      const event = { id: tx.id, timestamp: tx.timestamp, type: tx.tx_type, asset, amount, value, fees: fee, profile_id: tx.profile_id };
      acquisitionEvents.push(event);
      acquisitionTotal += value + fee;
    }
  };
  const processACB = (sortedTxs) => {
    const acb = new Map();
    const holdingDays = Number(data.config?.holding_period_days || 365);
    for (const tx of sortedTxs) {
      if (tx.ignored) continue;
      const asset = tx.asset_symbol;
      const amount = Math.abs(Number(tx.amount || 0));
      const value = txValue(data, tx);
      const rawFee = feeValue(data, tx);
      if (rawFee === null) addWarning(t('missing_fee_price_warning', { asset: tx.fee_asset, id: tx.id, currency: data.config.base_currency || 'EUR' }));
      const fee = rawFee ?? 0;
      if ((ACQUISITION_TYPES.has(tx.tx_type) || DISPOSAL_TYPES.has(tx.tx_type)) && txPriceMissing(data, tx)) addWarning(t('missing_price_warning', { asset, id: tx.id }));
      if (ACQUISITION_TYPES.has(tx.tx_type)) {
        noteAcquisitionOrIncome(tx, value, fee);
        const prev = acb.get(asset) || { amount: 0, cost: 0, firstAcquiredAt: tx.timestamp };
        prev.amount += amount;
        prev.cost += value + fee;
        acb.set(asset, prev);
      } else if (DISPOSAL_TYPES.has(tx.tx_type)) {
        const prev = acb.get(asset) || { amount: 0, cost: 0, firstAcquiredAt: null };
        const available = prev.amount;
        const unit = available > 0 ? prev.cost / available : 0;
        const matched = Math.min(amount, available);
        const cost = matched * unit;
        prev.amount = Math.max(0, prev.amount - matched);
        prev.cost = Math.max(0, prev.cost - cost);
        acb.set(asset, prev);
        if (amount - available > 1e-8) addWarning(t('missing_acquisition', { asset, amount: fmtNum(amount - available, 8) }));
        if (inRange(tx)) {
          const held_days = prev.firstAcquiredAt ? Math.floor((new Date(tx.timestamp) - new Date(prev.firstAcquiredAt)) / 86400000) : null;
          const long_term = held_days != null ? held_days >= holdingDays : null;
          const event = { id: tx.id, timestamp: tx.timestamp, type: tx.tx_type, asset, amount, proceeds: value, costBasis: cost, fees: fee, gain: value - cost - fee, profile_id: tx.profile_id, held_days, long_term };
          events.push(event); proceeds += value; costBasis += cost; fees += fee;
        }
      }
    }
  };
  if (method === 'ACB') processACB(sorted);
  else {
    const holdingDays = Number(data.config?.holding_period_days || 365);
    for (const tx of sorted) {
      if (tx.ignored) continue;
      const asset = tx.asset_symbol;
      const amount = Math.abs(Number(tx.amount || 0));
      const value = txValue(data, tx);
      const rawFee = feeValue(data, tx);
      if (rawFee === null) addWarning(t('missing_fee_price_warning', { asset: tx.fee_asset, id: tx.id, currency: data.config.base_currency || 'EUR' }));
      const fee = rawFee ?? 0;
      if ((ACQUISITION_TYPES.has(tx.tx_type) || DISPOSAL_TYPES.has(tx.tx_type)) && txPriceMissing(data, tx)) addWarning(t('missing_price_warning', { asset, id: tx.id }));
      if (ACQUISITION_TYPES.has(tx.tx_type)) {
        noteAcquisitionOrIncome(tx, value, fee);
        addLot(asset, amount, amount ? (value + fee) / amount : 0, tx.timestamp, tx.id);
      } else if (DISPOSAL_TYPES.has(tx.tx_type)) {
        const { cost, acquisitionTs } = takeLots(asset, amount);
        if (inRange(tx)) {
          const held_days = acquisitionTs ? Math.floor((new Date(tx.timestamp) - new Date(acquisitionTs)) / 86400000) : null;
          const long_term = held_days != null ? held_days >= holdingDays : null;
          const event = { id: tx.id, timestamp: tx.timestamp, type: tx.tx_type, asset, amount, proceeds: value, costBasis: cost, fees: fee, gain: value - cost - fee, profile_id: tx.profile_id, held_days, long_term };
          events.push(event); proceeds += value; costBasis += cost; fees += fee;
        }
      }
    }
  }
  const incomeByType = incomeEvents.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + e.value; return acc; }, {});
  return { method, currency: data.config.base_currency || 'EUR', events, incomeEvents, acquisitionEvents, incomeByType, proceeds, costBasis, fees, realizedGain: proceeds - costBasis - fees, incomeTotal, acquisitionTotal, warnings: Array.from(new Set(warnings)) };
}

function exportTaxCSV() {
  const report = computeTaxReport(session.data, session.tax || {});
  const header = ['category','method','id','timestamp','type','profile','asset','amount','proceeds','cost_basis','fees','realized_gain','income_value','acquisition_value','currency','held_days','long_term'];
  const lines = [header.join(',')];
  for (const e of report.events) lines.push(['disposal', report.method, e.id, e.timestamp, e.type, txProfileName(e.profile_id), e.asset, e.amount, e.proceeds, e.costBasis, e.fees, e.gain, '', '', report.currency, e.held_days ?? '', e.long_term != null ? e.long_term : ''].map(csvCell).join(','));
  for (const e of report.incomeEvents) lines.push(['income', report.method, e.id, e.timestamp, e.type, txProfileName(e.profile_id), e.asset, e.amount, '', '', e.fees, '', e.value, '', report.currency].map(csvCell).join(','));
  for (const e of report.acquisitionEvents) lines.push(['acquisition', report.method, e.id, e.timestamp, e.type, txProfileName(e.profile_id), e.asset, e.amount, '', '', e.fees, '', '', e.value + e.fees, report.currency].map(csvCell).join(','));
  downloadBlob(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }), makeExportFilename('tax.csv'));
}

function captureBalanceSnapshot() {
  const summary = computeSummary(session.data);
  const snap = { id: uuid(), created_at: nowISO(), currency: session.data.config.base_currency || 'EUR', total: summary.total, items: summary.items.map(i => ({ symbol: i.symbol, amount: i.amount, price: i.price, value: i.value })) };
  session.data.balance_snapshots = normalizeBalanceSnapshots([snap, ...(session.data.balance_snapshots || [])]);
  return snap;
}

function renderTaxReport() {
  const report = computeTaxReport(session.data, session.tax || {});
  const c = session.data.config.base_currency;
  return `<section class="section ${session.route === 'tax' ? 'active' : ''}" id="section-tax">
    <div class="panel">
      <div class="panel-head"><div><h3>${t('tax_report_title')}</h3><p>${t('tax_report_desc')}</p></div><button class="btn secondary" id="export-tax-csv">${t('export_tax_csv')}</button></div>
      <form id="tax-filter-form" class="filters">
        <select name="method">${TAX_METHODS.map(m => `<option value="${m}" ${report.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
        <input name="from" type="date" value="${escapeHTML(session.tax?.from || '')}" aria-label="${t('tax_from')}" />
        <input name="to" type="date" value="${escapeHTML(session.tax?.to || '')}" aria-label="${t('tax_to')}" />
        <button class="btn secondary" type="submit">${t('save')}</button>
      </form>
      <div class="kpi-grid mt-14">
        ${kpi(t('realized_gain'), fmtMoney(report.realizedGain, c), report.method)}
        ${kpi(t('income_rewards'), fmtMoney(report.incomeTotal, c), `${report.incomeEvents.length} ${t('tx')}`)}
        ${kpi(t('acquisitions'), fmtMoney(report.acquisitionTotal, c), `${report.acquisitionEvents.length} ${t('tx')}`)}
        ${kpi(t('fees'), fmtMoney(report.fees, c), `${report.warnings.length} ${t('warnings')}`)}
      </div>
      ${renderTaxEvents(report)}
      ${renderTaxIncomeEvents(report)}
      ${renderTaxAcquisitionEvents(report)}
      ${renderTaxWarnings(report)}
    </div>
  </section>`;
}

function renderTaxEvents(report) {
  const header = `<div class="panel-subhead"><div><h4>${t('taxable_disposals')}</h4><p>${t('taxable_disposals_desc')}</p></div><span class="badge">${report.events.length}</span></div>`;
  return `${header}${renderPaginatedTable('tax-disposals', report.events, rows =>
    `<div class="table-wrap"><table><thead><tr><th>${t('time')}</th><th>${t('type')}</th><th>${t('asset')}</th><th>${t('amount')}</th><th>${t('proceeds')}</th><th>${t('cost_basis')}</th><th>${t('realized_gain')}</th><th>${t('holding_days')}</th></tr></thead><tbody>${rows.map(e => `<tr><td>${fmtDate(e.timestamp)}<br/><span class="smallprint">#${e.id} · ${escapeHTML(txProfileName(e.profile_id))}</span></td><td>${escapeHTML(txLabel(e.type))}</td><td>${escapeHTML(e.asset)}</td><td>${fmtNum(e.amount)}</td><td>${fmtMoney(e.proceeds, report.currency)}</td><td>${fmtMoney(e.costBasis, report.currency)}</td><td>${fmtMoney(e.gain, report.currency)}</td><td>${e.held_days != null ? `${e.held_days}d<br/><span class="badge ${e.long_term ? 'buy' : 'sell'}">${t(e.long_term ? 'long_term' : 'short_term')}</span>` : '–'}</td></tr>`).join('')}</tbody></table></div>`,
    `<div class="empty compact">${t('no_tax_events')}</div>`
  )}`;
}

function renderTaxIncomeEvents(report) {
  const breakdown = Object.entries(report.incomeByType || {}).filter(([, value]) => Math.abs(value) > 1e-12).map(([type, value]) => `${txLabel(type)}: ${fmtMoney(value, report.currency)}`).join(' · ');
  const header = `<div class="panel-subhead"><div><h4>${t('income_rewards')}</h4><p>${t('income_rewards_desc')}</p>${breakdown ? `<p class="smallprint">${escapeHTML(breakdown)}</p>` : ''}</div><span class="badge">${report.incomeEvents.length}</span></div>`;
  return `${header}${renderPaginatedTable('tax-income', report.incomeEvents, rows =>
    `<div class="table-wrap"><table><thead><tr><th>${t('time')}</th><th>${t('type')}</th><th>${t('asset')}</th><th>${t('amount')}</th><th>${t('income_value')}</th></tr></thead><tbody>${rows.map(e => `<tr><td>${fmtDate(e.timestamp)}<br/><span class="smallprint">#${e.id} · ${escapeHTML(txProfileName(e.profile_id))}</span></td><td>${escapeHTML(txLabel(e.type))}</td><td>${escapeHTML(e.asset)}</td><td>${fmtNum(e.amount)}</td><td>${fmtMoney(e.value, report.currency)}</td></tr>`).join('')}</tbody></table></div>`,
    `<div class="empty compact">${t('no_income_events')}</div>`
  )}`;
}

function renderTaxAcquisitionEvents(report) {
  const header = `<div class="panel-subhead"><div><h4>${t('acquisitions')}</h4><p>${t('acquisitions_desc')}</p></div><span class="badge">${report.acquisitionEvents.length}</span></div>`;
  return `${header}${renderPaginatedTable('tax-acquisitions', report.acquisitionEvents, rows =>
    `<div class="table-wrap"><table><thead><tr><th>${t('time')}</th><th>${t('type')}</th><th>${t('asset')}</th><th>${t('amount')}</th><th>${t('cost_basis')}</th></tr></thead><tbody>${rows.map(e => `<tr><td>${fmtDate(e.timestamp)}<br/><span class="smallprint">#${e.id} · ${escapeHTML(txProfileName(e.profile_id))}</span></td><td>${escapeHTML(txLabel(e.type))}</td><td>${escapeHTML(e.asset)}</td><td>${fmtNum(e.amount)}</td><td>${fmtMoney(e.value + e.fees, report.currency)}</td></tr>`).join('')}</tbody></table></div>`,
    `<div class="empty compact">${t('no_acquisition_events')}</div>`
  )}`;
}

function renderTaxWarnings(report) {
  if (!report.warnings.length) return '';
  const meta = paginatedItems('tax-warnings', report.warnings, { size: 10 });
  return `<div class="notice danger mt-14"><b>${t('warnings')}</b><ul>${meta.rows.map(w => `<li>${escapeHTML(w)}</li>`).join('')}</ul>${renderPagination('tax-warnings', meta)}</div>`;
}

function renderAssetsPrices() {
  const data = session.data;
  const assets = normalizeAssets(data.assets, data.transactions);
  const priceRows = normalizePriceCache(data.price_cache || []).slice(-80).reverse();
  return `<section class="section ${session.route === 'assets' ? 'active' : ''}" id="section-assets">
    <div class="grid-2">
      <div class="panel"><div class="panel-head"><div><h3>${t('assets_prices_title')}</h3><p>${t('assets_prices_desc')}</p></div></div>
        <form id="asset-form" class="form-grid">
          <div class="form-row inline"><div><label>${t('asset')}</label><input name="symbol" placeholder="BTC" required /></div><div><label>${t('asset_type')}</label><select name="type"><option value="crypto">${t('crypto')}</option><option value="stablecoin">${t('stablecoin')}</option><option value="fiat">${t('fiat_asset')}</option><option value="custom">${t('custom')}</option><option value="nft">${t('nft_asset')}</option></select></div></div>
          <div class="form-row"><label>${t('name')}</label><input name="name" placeholder="Bitcoin" /></div>
          <div class="form-row"><label>${t('aliases')}</label><input name="aliases" placeholder="XBT, WBTC" /></div>
          <button class="btn" type="submit">${t('add_asset')}</button>
        </form>
        ${renderAssetsTable(assets)}
      </div>
      <div class="panel"><div class="panel-head"><div><h3>${t('price_cache')}</h3><p>${t('manual_price')}</p></div></div>
        <form id="price-form" class="form-grid">
          <div class="form-row inline"><div><label>${t('asset')}</label><input name="asset" placeholder="BTC" required /></div><div><label>${t('base_currency')}</label><input name="quote" value="${escapeHTML(data.config.base_currency || 'EUR')}" required /></div></div>
          <div class="form-row inline"><div><label>${t('price_date')}</label><input name="date" type="date" value="${new Date().toISOString().slice(0,10)}" required /></div><div><label>${t('price')}</label><input name="price" type="number" step="any" min="0" required /></div></div>
          <button class="btn" type="submit">${t('add_price')}</button>
        </form>
        ${renderPriceCacheTable(priceRows)}
      </div>
    </div>
    <div class="panel mt-16"><div class="panel-head"><div><h3>${t('address_book')}</h3><p>${t('address_book_desc')}</p></div></div>${renderAddressBook()}</div>
    <div class="panel mt-16"><div class="panel-head"><div><h3>${t('balance_snapshots')}</h3><p>${t('balance_snapshots_desc')}</p></div><button class="btn secondary" id="capture-balance-snapshot">${t('capture_balance_snapshot')}</button></div>${renderBalanceSnapshots()}</div>
  </section>`;
}

function renderAssetsTable(assets) {
  const rows = Object.values(assets).sort((a,b)=>a.symbol.localeCompare(b.symbol));
  return renderPaginatedTable('assets-list', rows, pageRows =>
    `<div class="table-wrap mt-16"><table><thead><tr><th>${t('asset')}</th><th>${t('asset_type')}</th><th>${t('aliases')}</th></tr></thead><tbody>${pageRows.map(a => `<tr><td><b>${escapeHTML(a.symbol)}</b><br/><span class="smallprint">${escapeHTML(a.name || '')}</span></td><td>${escapeHTML(a.type || 'crypto')}</td><td>${escapeHTML((a.aliases || []).join(', '))}</td></tr>`).join('')}</tbody></table></div>`,
    `<div class="empty">${t('no_entries')}</div>`
  );
}

function renderPriceCacheTable(rows) {
  return renderPaginatedTable('price-cache', rows, pageRows =>
    `<div class="table-wrap mt-16"><table><thead><tr><th>${t('asset')}</th><th>${t('base_currency')}</th><th>${t('price_date')}</th><th>${t('price')}</th><th>${t('source')}</th></tr></thead><tbody>${pageRows.map(r => `<tr><td>${escapeHTML(r.asset)}</td><td>${escapeHTML(r.quote)}</td><td>${escapeHTML(r.date)}</td><td>${fmtMoney(r.price, r.quote)}</td><td>${escapeHTML(r.source || '')}</td></tr>`).join('')}</tbody></table></div>`,
    `<div class="empty mt-16">${t('no_entries')}</div>`
  );
}


function renderAddressBook() {
  const rows = Object.entries(session.data.address_book || {}).sort(([a],[b]) => a.localeCompare(b));
  const table = renderPaginatedTable('address-book', rows, pageRows =>
    `<div class="table-wrap mt-14"><table><thead><tr><th>${t('address_value')}</th><th>${t('address_label')}</th></tr></thead><tbody>${pageRows.map(([address, label]) => `<tr><td>${escapeHTML(address)}</td><td>${escapeHTML(label)}</td></tr>`).join('')}</tbody></table></div>`,
    `<div class="empty mt-14">${t('no_entries')}</div>`
  );
  return `<form id="address-form" class="form-grid address-book-form"><div class="form-row inline"><div><label>${t('address_value')}</label><input name="address" required /></div><div><label>${t('address_label')}</label><input name="label" required /></div></div><div class="btn-row"><button class="btn secondary" type="submit">${t('add_address')}</button></div></form>${table}`;
}

async function saveAddressBookEntry(e) {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  const address = String(fd.get('address') || '').trim();
  const label = String(fd.get('label') || '').trim();
  if (!address || !label) return;
  session.data.address_book = { ...(session.data.address_book || {}), [address]: label };
  await persist(currentLocale === 'de' ? 'Adressbuch gespeichert' : 'Address book saved');
}

function renderBalanceSnapshots() {
  const snaps = normalizeBalanceSnapshots(session.data.balance_snapshots);
  return renderPaginatedTable('balance-snapshots', snaps, pageRows =>
    `<div class="table-wrap"><table><thead><tr><th>${t('time')}</th><th>${t('value')}</th><th>${t('assets_prices_title')}</th></tr></thead><tbody>${pageRows.map(s => `<tr><td>${fmtDate(s.created_at)}</td><td>${fmtMoney(s.total, s.currency)}</td><td>${escapeHTML(s.items.slice(0, 6).map(i => `${i.symbol} ${fmtNum(i.amount,4)}`).join(' · '))}</td></tr>`).join('')}</tbody></table></div>`,
    `<div class="empty">${t('balance_snapshot_none')}</div>`
  );
}

function renderImportExport() {
  const preview = session.pendingImport;
  const result = session.importResult;
  return `<section class="section ${session.route === 'import' ? 'active' : ''}" id="section-import">
    <div class="grid-2">
      <div class="panel"><div class="panel-head"><div><h3>${t('csv_import')}</h3><p>${t('csv_import_desc')}</p></div></div>
        <form id="import-form" class="form-grid import-box">
          <div class="form-row"><label>${t('import_target_profile')}</label><select name="target_profile_id">${txProfileOptions(activeTxProfileID())}</select></div>
          <div class="form-row"><label>${t('import_source')}</label><select name="source"><option value="auto">${t('import_autodetect')}</option><option value="generic">${t('importer_generic')}</option><option value="traeky">${t('importer_traeky')}</option><option value="binance">${t('importer_binance')}</option><option value="cointracking">${t('importer_cointracking')}</option><option value="stakebook">${t('importer_stakebook')}</option></select></div>
          <input type="file" id="csv-file" name="csv" accept=".csv,text/csv" required />
          <p class="smallprint">${t('supported_columns')}: <span class="code">asset_symbol, tx_type, amount, price_fiat, fiat_currency, fiat_value, value_eur, value_usd, timestamp, source, note, tx_id, fee_asset, fee_amount, tags, event_subtype, location, counterparty</span></p>
          <div class="btn-row"><button class="btn" type="submit">${t('import_preview_btn')}</button><button class="btn secondary" id="apply-import" type="button" ${preview?.transactions?.length ? '' : 'disabled'}>${t('import_apply_btn')}</button></div>
          <div id="import-msg">${preview ? renderImportPreview(preview) : renderImportResult(result)}</div>
        </form>
      </div>
      <div class="panel"><div class="panel-head"><div><h3>${t('export_report')}</h3><p>${t('export_report_desc')}</p></div></div>
        <form id="export-form" class="form-grid"><div class="form-row"><label>${t('export_profiles')}</label><select name="export_profiles" id="export-profile-mode"><option value="active">${t('active_profile')}</option><option value="all">${t('all_profiles')}</option><option value="selected">${t('selected_profiles')}</option></select></div><div class="profile-checkbox-grid">${txProfiles().map(p => `<label class="check-row"><input type="checkbox" name="export_profile_ids" value="${escapeHTML(p.id)}" ${p.id === activeTxProfileID() ? 'checked' : ''} /> ${escapeHTML(p.name)}</label>`).join('')}</div><div class="btn-row"><button class="btn" id="export-csv" type="button">${t('export_csv')}</button><button class="btn secondary" id="export-pdf" type="button">${t('download_pdf')}</button><button class="btn secondary" id="print-report" type="button">${t('print')}</button></div></form>
        <p class="smallprint">${t('export_note')}</p>
      </div>
    </div>
    <div class="panel mt-16"><h3>${t('existing_data')}</h3><p>${t('existing_data_desc')}</p></div>
  </section>`;
}

function renderImportPreview(preview) {
  if (!preview) return '';
  const warnings = preview.warnings || [];
  const rows = preview.transactions || [];
  const warningsMeta = paginatedItems('import-warnings', warnings, { size: 10 });
  const warningBlock = warnings.length ? `<div class="notice info"><b>${t('import_warnings')}</b><ul>${warningsMeta.rows.map(w => `<li>${escapeHTML(w)}</li>`).join('')}</ul>${renderPagination('import-warnings', warningsMeta)}</div>` : '';
  const configChanges = importConfigChanges(preview.config);
  const configBlock = configChanges.length
    ? `<div class="notice info"><b>${t('import_config_changes')}</b><ul>${configChanges.map(change => `<li>${escapeHTML(t(`config_label_${change.key}`))}: ${escapeHTML(String(change.from))} &rarr; ${escapeHTML(String(change.to))}</li>`).join('')}</ul></div>`
    : '';
  const table = renderPaginatedTable('import-preview', rows, pageRows =>
    `<div class="table-wrap"><table><thead><tr><th>${t('time')}</th><th>${t('type')}</th><th>${t('asset')}</th><th>${t('amount')}</th><th>${t('price')}</th><th>${t('profile')}</th></tr></thead><tbody>${pageRows.map(tx => { const price = importPreviewPrice(tx); return `<tr><td>${fmtDate(tx.timestamp)}</td><td>${escapeHTML(txLabel(tx.tx_type))}</td><td>${escapeHTML(tx.asset_symbol)}</td><td>${fmtNum(tx.amount)}</td><td>${price ? fmtMoney(price.price, price.currency) : '-'}</td><td>${escapeHTML(txProfileName(tx.profile_id))}</td></tr>`; }).join('')}</tbody></table></div>`,
    ''
  );
  return `<div class="import-preview-block"><div class="notice ${warnings.length ? 'info' : 'success'}">${t(rows.length ? 'import_ready' : 'import_no_rows', { count: rows.length, warnings: warnings.length })}</div>${configBlock}${warningBlock}${table}</div>`;
}

function renderImportResult(result) {
  if (!result) return '';
  return `<div class="notice success">${t('csv_imported_notice', { imported: result.imported || 0, skipped: result.skipped || 0 })}</div>`;
}

function cloudRetentionSummary(cfg) {
  const raw = cfg.cloud_retention_days;
  if (raw === 0) return { value: t('cloud_retention_disabled'), detail: t('cloud_retention_explain') };
  const days = Number(raw);
  if (Number.isFinite(days) && days > 0) return { value: `${days} d`, detail: t('cloud_retention_days', { days }) };
  return { value: t('cloud_retention_unknown'), detail: cfg.cloud_url ? t('test_connection') : t('not_configured') };
}

function cloudRetentionSummaryForTarget(target) {
  return cloudRetentionSummary({ cloud_retention_days: target?.cloud_retention_days ?? null, cloud_url: target?.url || '' });
}

function renderSync() {
  const cfg = session.data.config;
  const targets = getCloudTargets(cfg);
  const enabled = targets.filter(t => t.enabled !== false && t.url);
  const configured = enabled.length > 0 && cfg.cloud_key;
  const authConfigured = Boolean(String(cfg.cloud_auth_secret || cfg.last_remote_auth_secret || '').trim() || enabled.some(t => String(t.last_remote_auth_secret || '').trim()));
  const retention = cloudRetentionSummary(cfg);
  const seedDerived = Boolean(session.data.account.recovery);
  return `<section class="section ${session.route === 'sync' ? 'active' : ''}" id="section-sync">
    <div class="panel cloud-connect-panel">
      <div class="panel-head"><div><h3>${t('cloud_backup')}</h3><p>${t('cloud_desc')}</p></div></div>
      <div class="cloud-connect-layout">
        <form id="sync-form" class="form-grid cloud-connect-add">
          <div class="form-row"><label>${t('cloud_url')}</label><div class="input-action-row"><input name="cloud_url" placeholder="https://cloud.example.org" autocomplete="off" /><button class="btn" type="submit">${t('cloud_add_server')}</button></div><p class="smallprint">${t('cloud_urls_hint')}</p></div>
          <div class="notice info compact-notice"><b>${t('cloud_account')}</b><br/>${t('cloud_account_managed')}</div>
          <p class="smallprint">${t('cloud_explain')} ${seedDerived ? t('seed_derived_cloud') : ''}</p>
        </form>
        <div class="cloud-connect-sync">
          <div class="kpi-grid cloud-sync-kpis">${kpi(t('cloud_revision'), String(Math.max(0, ...enabled.map(x => Number(x.last_remote_revision || 0)))), `${enabled.length} ${t('cloud_targets')}`)}${kpi(t('last_sync'), latestSyncLabel(enabled), configured ? t('ready') : t('not_configured'))}${kpi(t('protection_status'), authConfigured ? t('protected') : t('basic_protection'), authConfigured ? t('protection_active') : t('add_protection'))}${kpi(t('cloud_retention'), retention.value, retention.detail)}</div>
          <div class="btn-row"><button class="btn" id="sync-push" ${configured ? '' : 'disabled'}>${t('sync_all')}</button><button class="btn secondary" id="sync-pull" ${configured ? '' : 'disabled'}>${t('restore_latest')}</button></div>
        </div>
      </div>
      ${renderCloudTargets(targets)}
      <div id="sync-msg" class="mt-12"></div>
    </div>
    <div class="panel cloud-danger-panel mt-16"><div class="panel-head"><div><h3>${t('delete_cloud_title')}</h3><p>${t('delete_cloud_desc')}</p></div></div><button class="btn danger" id="delete-cloud-open" ${configured ? '' : 'disabled'}>${t('delete_cloud_btn')}</button></div>
  </section>`;
}

function latestSyncLabel(targets) {
  const dates = targets.map(t => t.last_sync_at).filter(Boolean).map(v => new Date(v)).filter(d => !Number.isNaN(d.getTime()));
  if (!dates.length) return t('never');
  return fmtDate(new Date(Math.max(...dates.map(d => d.getTime()))).toISOString());
}

function renderCloudTargets(targets) {
  return renderPaginatedTable('cloud-targets', targets, pageTargets =>
    `<div class="table-wrap cloud-target-table mt-14"><table><thead><tr><th>${t('cloud_target')}</th><th>${t('cloud_server_mode')}</th><th>${t('cloud_target_status')}</th><th>${t('cloud_version')}</th><th>${t('cloud_heartbeat')}</th><th>${t('last_sync')}</th><th>${t('cloud_retention')}</th><th>${t('action')}</th></tr></thead><tbody>${pageTargets.map(target => {
      const retention = cloudRetentionSummaryForTarget(target);
      const enabled = target.enabled !== false;
      const mode = enabled ? t('cloud_status_enabled') : t('cloud_status_disabled');
      const status = enabled ? cloudStatusLabel(target.last_status) : t('cloud_status_disabled');
      const heartbeat = target.last_heartbeat_at ? fmtDate(target.last_heartbeat_at) : t('never');
      return `<tr class="${enabled ? '' : 'cloud-target-disabled'}"><td><b>${escapeHTML(target.label || target.url)}</b><br/><span class="smallprint">${escapeHTML(target.url)}</span></td><td><span class="cloud-pill ${enabled ? 'enabled' : 'disabled'}">${escapeHTML(mode)}</span></td><td>${escapeHTML(status)}${target.last_error ? `<br/><span class="smallprint">${escapeHTML(target.last_error)}</span>` : ''}</td><td>${escapeHTML(target.cloud_version ? `v${target.cloud_version}${target.cloud_commit_short ? ` (${target.cloud_commit_short})` : ''}` : '-')}</td><td>${heartbeat}</td><td>${target.last_sync_at ? fmtDate(target.last_sync_at) : t('never')}</td><td><b>${escapeHTML(retention.value)}</b><br/><span class="smallprint">${escapeHTML(retention.detail)}</span></td><td><div class="btn-row cloud-target-actions"><button class="btn secondary small" data-test-cloud-target="${escapeHTML(target.id)}">${t('test_connection')}</button><button class="btn secondary small" data-toggle-cloud-target="${escapeHTML(target.id)}">${enabled ? t('cloud_disable_server') : t('cloud_enable_server')}</button><button class="btn secondary small" data-edit-cloud-target="${escapeHTML(target.id)}">${t('edit')}</button><button class="btn danger small" data-delete-cloud-target="${escapeHTML(target.id)}">${t('delete')}</button></div></td></tr>`;
    }).join('')}</tbody></table></div>`,
    `<div class="empty compact cloud-target-empty">${t('not_configured')}</div>`
  );
}

function renderSettings() {
  const cfg = session.data.config;
  return `<section class="section ${session.route === 'settings' ? 'active' : ''}" id="section-settings">
    <div class="grid-2">
      <div class="panel"><div class="panel-head"><div><h3>${t('settings_portfolio')}</h3><p>${t('settings_portfolio_desc')}</p></div></div>
        <form id="settings-form" class="form-grid">
          <div class="form-row inline"><div><label>${t('account_name')}</label><input name="account_name" value="${escapeHTML(session.data.account.name)}" /><p class="smallprint">${t('account_name_desc')}</p></div><div><label>${t('language')}</label><select name="language"><option value="en" ${currentLocale === 'en' ? 'selected' : ''}>${t('language_en')}</option><option value="de" ${currentLocale === 'de' ? 'selected' : ''}>${t('language_de')}</option></select><p class="smallprint">${t('language_desc')}</p></div></div>
          <div class="form-row inline"><div><label>${t('base_currency')}</label><select name="base_currency"><option ${cfg.base_currency === 'EUR' ? 'selected' : ''}>EUR</option><option ${cfg.base_currency === 'USD' ? 'selected' : ''}>USD</option></select><p class="smallprint">${t('base_currency_desc')}</p></div><div><label>${t('auto_lock_minutes')}</label><input name="auto_lock_minutes" type="number" min="${MIN_AUTO_LOCK_MINUTES}" max="${MAX_AUTO_LOCK_MINUTES}" step="1" value="${escapeHTML(autoLockMinutes(session.data))}" /><p class="smallprint">${t('auto_lock_minutes_desc')}</p></div></div>
          <div class="form-row inline"><div><label>${t('holding_days')}</label><input name="holding_period_days" type="number" min="1" value="${escapeHTML(cfg.holding_period_days)}" /><p class="smallprint">${t('holding_days_desc')}</p></div><div><label>${t('upcoming_window')}</label><input name="upcoming_holding_window_days" type="number" min="1" value="${escapeHTML(cfg.upcoming_holding_window_days)}" /><p class="smallprint">${t('upcoming_window_desc')}</p></div></div>
          <div class="form-row inline"><div><label class="check-row"><input type="checkbox" name="price_fetch_enabled" ${priceFetchEnabled(session.data) ? 'checked' : ''} /> ${t('price_fetch_enabled')}</label><p class="smallprint">${t('price_fetch_enabled_desc')}</p></div><div><label>${t('coingecko_key')}</label><input name="coingecko_api_key" value="${escapeHTML(cfg.coingecko_api_key || '')}" /><p class="smallprint">${t('coingecko_key_desc')}</p></div></div>
          <button class="btn" type="submit">${t('save')}</button>
        </form>
      </div>
      <div class="panel"><div class="panel-head"><div><h3>${t('vault')}</h3><p>${t('vault_desc')}</p></div></div>
        ${session.data.account.recovery ? `<div class="notice info"><b>${t('recovery_enabled')}</b><br/>${t('recovery_enabled_desc')}</div><hr class="section-divider"/>` : ''}
        <form id="pass-form" class="form-grid">
          <div class="form-row"><label>${t('current_passphrase')}</label><input name="current_passphrase" type="password" autocomplete="current-password" required /></div>
          <div class="form-row"><label>${t('new_passphrase')}</label><input name="new_passphrase" type="password" autocomplete="new-password" minlength="12" required /></div>
          <div class="form-row"><label>${t('repeat_new_passphrase')}</label><input name="confirm_new_passphrase" type="password" autocomplete="new-password" minlength="12" required /></div>
          <button class="btn secondary" type="submit">${t('change_passphrase')}</button>
        </form>
        <hr class="section-divider"/>
        <div class="btn-row"><button class="btn secondary" id="export-vault">${t('encrypted_backup_export')}</button><button class="btn danger" id="delete-local">${t('delete_local')}</button></div>
      </div>
    </div>
    <div class="panel settings-section-spaced"><div class="panel-head"><div><h3>${t('file_storage')}</h3><p>${t('file_storage_desc')}</p></div></div>${renderFileStorage()}</div>
    <div class="panel settings-section-spaced"><div class="panel-head"><div><h3>${t('local_snapshots')}</h3><p>${t('local_snapshots_desc')}</p></div></div>${renderSnapshots()}</div>
    <div class="panel settings-section-spaced"><div class="panel-head"><div><h3>${t('profiles')}</h3><p>${t('profiles_desc')}</p></div></div>${renderTxProfileManager()}</div>
    <div class="panel settings-section-spaced"><h3 class="subsection-title">${t('local_accounts')}</h3>${renderAccountManager()}</div>
    <div class="panel settings-section-spaced"><h3 class="subsection-title">${t('activity')}</h3>${renderAudit()}</div>
  </section>`;
}

function renderFileStorage() {
  if (!fileSaveSupported()) {
    return `<p class="smallprint">${t('file_sync_unsupported')}</p>`;
  }
  const state = currentFileSync();
  if (state && state.enabled && state.handle) {
    const last = state.last_saved_at ? fmtDate(state.last_saved_at) : t('never');
    const warn = state.permission_needed ? `<div class="notice info">${t('file_permission_needed')}</div>` : '';
    const errBox = state.last_error ? `<div class="notice danger"><span class="smallprint">${escapeHTML(state.last_error)}</span></div>` : '';
    return `${warn}${errBox}<div class="notice success"><b>${t('file_connected')}</b><br/><span class="smallprint">${escapeHTML(state.name || '')} · ${t('file_last_saved')}: ${escapeHTML(last)}</span></div>
      <div class="btn-row"><button class="btn secondary" id="file-save-now">${t('file_save_now')}</button><button class="btn danger" id="file-disconnect">${t('file_disconnect')}</button></div>`;
  }
  return `<p class="smallprint">${t('file_not_connected')}</p><div class="btn-row"><button class="btn" id="file-connect">${t('file_connect')}</button></div>`;
}

function renderSnapshots() {
  const snapshots = normalizeSnapshots(session.data.snapshots);
  const table = renderPaginatedTable('local-snapshots', snapshots, pageRows =>
    `<div class="table-wrap snapshot-table"><table><thead><tr><th>${t('time')}</th><th>${t('snapshot_reason')}</th><th>${t('snapshot_count')}</th><th>${t('action')}</th></tr></thead><tbody>${pageRows.map(s => `<tr><td>${fmtDate(s.created_at)}<br/><span class="smallprint">${escapeHTML(s.id)}</span></td><td>${escapeHTML(s.reason || '-')}</td><td>${escapeHTML(s.tx_count || 0)}</td><td><button class="btn secondary small" data-restore-snapshot="${escapeHTML(s.id)}">${t('snapshot_restore')}</button> <button class="btn danger small" data-delete-snapshot="${escapeHTML(s.id)}">${t('snapshot_delete')}</button></td></tr>`).join('')}</tbody></table></div>`,
    `<div class="empty">${t('snapshot_none')}</div>`
  );
  return `${table}<p class="smallprint">${t('snapshots_pruned', { count: SNAPSHOT_LIMIT })}</p>`;
}

function renderAccountManager() {
  const accounts = listLocalAccounts();
  const table = renderPaginatedTable('local-accounts', accounts, pageRows =>
    `<div class="table-wrap profile-table"><table><thead><tr><th>${t('account')}</th><th>${t('updated_at')}</th><th>${t('status')}</th></tr></thead><tbody>${pageRows.map(p => `<tr><td><b>${escapeHTML(p.name)}</b><br/><span class="smallprint">${escapeHTML(p.id)}</span></td><td>${fmtDate(p.updated_at)}</td><td>${p.id === getActiveAccountID() ? `<span class="badge transfer_internal">${t('active')}</span>` : t('locked')}</td></tr>`).join('')}</tbody></table></div>`,
    `<div class="empty">${t('account_not_found')}</div>`
  );
  return `${table}<p class="smallprint">${t('account_manager_note')}</p>`;
}


function renderTxProfileManager() {
  const profiles = txProfiles();
  const table = renderPaginatedTable('tx-profiles', profiles, pageRows =>
    `<div class="table-wrap profile-table"><table><thead><tr><th>${t('profile')}</th><th>${t('transactions')}</th><th>${t('status')}</th><th>${t('action')}</th></tr></thead><tbody>${pageRows.map(p => {
      const count = (session.data.transactions || []).filter(tx => String(tx.profile_id || 'main') === p.id).length;
      const isActive = p.id === activeTxProfileID();
      const canDelete = profiles.length > 1 && count === 0;
      return `<tr><td><b>${escapeHTML(p.name)}</b><br/><span class="smallprint">${escapeHTML(p.id)}</span></td><td>${count}</td><td>${isActive ? `<span class="badge transfer_internal">${t('active')}</span>` : ''}</td><td><div class="btn-row"><button class="btn secondary small" data-rename-tx-profile="${escapeHTML(p.id)}">${t('edit')}</button><button class="btn secondary small" data-set-active-tx-profile="${escapeHTML(p.id)}" ${isActive ? 'disabled' : ''}>${t('switch')}</button><button class="btn danger small" data-delete-tx-profile="${escapeHTML(p.id)}" ${canDelete ? '' : 'disabled'}>${t('delete')}</button></div></td></tr>`;
    }).join('')}</tbody></table></div>`,
    `<div class="empty">${t('no_entries')}</div>`
  );
  return `<div class="profile-manager-grid">
    <form id="tx-profile-form" class="form-grid profile-create-form">
      <div class="form-row"><label>${t('profile_name')}</label><input name="profile_name" maxlength="80" placeholder="${t('profile_name_placeholder')}" required /></div>
      <button class="btn" type="submit">${t('add_profile')}</button>
    </form>
    ${table}
    <p class="smallprint">${t('profiles_manager_note')}</p>
  </div>`;
}

function renderAudit() {
  const audit = [...(session.data.audit || [])].reverse();
  return renderPaginatedTable('activity-log', audit, pageRows =>
    `<div class="table-wrap"><table><thead><tr><th>${t('time')}</th><th>${t('event')}</th></tr></thead><tbody>${pageRows.map(a => `<tr><td>${fmtDate(a.at)}</td><td>${escapeHTML(a.message)}</td></tr>`).join('')}</tbody></table></div>`,
    `<div class="empty">${t('no_entries')}</div>`
  );
}

function renderTxDialog() {
  return `<dialog class="dialog" id="tx-dialog"><div class="dialog-body"><button class="btn ghost close-x" id="close-tx-dialog" type="button">✕</button><h2 id="tx-dialog-title">${t('tx')}</h2><p>${t('tx_saved_note')}</p>
    <form id="tx-form" class="form-grid">
      <input type="hidden" name="id" />
      <div class="form-row"><label>${t('profile')}</label><select name="profile_id">${txProfileOptions(activeTxProfileID())}</select></div>
      <div class="form-row inline"><div><label>${t('asset')}</label><input name="asset_symbol" placeholder="${t('asset_placeholder')}" required /></div><div><label>${t('type')}</label><select name="tx_type">${TX_TYPES.map(v => `<option value="${v}">${txLabel(v)}</option>`).join('')}</select></div></div>
      <div class="form-row inline"><div><label>${t('amount')}</label><input name="amount" type="number" step="any" required /></div><div><label>${t('timestamp')}</label><input name="timestamp" type="datetime-local" required /></div></div>
      <div class="form-row inline"><div><label>${t('price_per_asset')}</label><input name="price_fiat" type="number" step="any" /></div><div><label>${t('fiat')}</label><select name="fiat_currency"><option>EUR</option><option>USD</option><option>CHF</option><option>GBP</option><option>USDT</option><option>USDC</option></select></div></div>
      <div class="form-row inline"><div><label>${t('exchange_source')}</label><input name="source" placeholder="Binance, Bitpanda …" /></div><div><label>Tx-ID</label><input name="tx_id" /></div></div>
      <div class="form-row"><label>${t('note')}</label><textarea name="note"></textarea></div>
      <details class="advanced-box"><summary>${t('event_details')}</summary>
        <div class="form-row inline"><div><label>${t('subtype')}</label><input name="event_subtype" placeholder="staking, bridge, governance" /></div><div><label>${t('location')}</label><input name="location" placeholder="Kraken, Wallet" /></div></div>
        <div class="form-row"><label>${t('counterparty')}</label><input name="counterparty" /></div>
        <div class="form-row inline"><div><label>${t('fee_asset')}</label><input name="fee_asset" placeholder="ETH" /></div><div><label>${t('fee_amount')}</label><input name="fee_amount" type="number" step="any" /></div></div>
        <div class="form-row"><label>${t('tags')}</label><input name="tags" placeholder="tax, defi, review" /></div>
        <label class="check-row"><input name="ignored" type="checkbox" /> ${t('ignored')}</label>
      </details>
      <div class="btn-row"><button class="btn" type="submit">${t('save')}</button><button class="btn secondary" id="cancel-tx" type="button">${t('cancel')}</button></div>
    </form></div></dialog>`;
}

function renderCloudTermsDialog() {
  return `<dialog class="dialog" id="cloud-terms-dialog"><div class="dialog-body"><h2>${t('cloud_terms_title')}</h2><p>${t('cloud_terms_intro')} <b id="cloud-terms-server"></b></p>
    <div class="terms-box" id="cloud-terms-content"></div>
    <div id="cloud-terms-links"></div>
    <form id="cloud-terms-form" class="form-grid">
      <label class="check-row"><input id="cloud-terms-accept" type="checkbox" autocomplete="off" data-bwignore="true" /> <span>${t('cloud_terms_accept')}</span></label>
      <div class="btn-row"><button class="btn" type="submit">${t('accept')}</button><button class="btn secondary" id="cancel-cloud-terms" type="button">${t('cancel')}</button></div>
      <div id="cloud-terms-msg"></div>
    </form></div></dialog>`;
}


function renderCloudTargetDeleteDialog() {
  return `<dialog class="dialog" id="cloud-target-delete-dialog"><div class="dialog-body"><button class="btn ghost close-x" id="close-cloud-target-delete" type="button">✕</button><h2>${t('delete_cloud_server_title')}</h2><p id="cloud-target-delete-copy">${t('delete_cloud_server_copy')}</p>
    <form id="cloud-target-delete-form" class="form-grid" autocomplete="off" data-bwignore="true" data-lpignore="true" data-1p-ignore="true">
      <input type="hidden" name="cloud_target_id" />
      <div class="notice info" id="cloud-target-delete-server"></div>
      <label class="check-row"><input name="delete_remote_data" type="checkbox" autocomplete="off" data-bwignore="true" data-lpignore="true" data-1p-ignore="true" /> <span>${t('delete_cloud_server_remote')}</span></label>
      <p class="smallprint">${t('delete_cloud_server_remote_hint')}</p>
      <div class="form-row"><label>${t('confirm_word_label')}</label><input name="delete_confirm_word" autocomplete="off" autocapitalize="none" data-bwignore="true" data-lpignore="true" data-1p-ignore="true" placeholder="${t('confirm_word_placeholder')}" required /></div>
      <div class="form-row"><label>${t('passphrase')}</label><input type="password" name="delete_profile_passphrase" autocomplete="off" data-bwignore="true" data-lpignore="true" data-1p-ignore="true" /></div>
      <div class="form-row"><label>${t('recovery_phrase_input')}</label><textarea name="delete_recovery_phrase" autocomplete="off" autocapitalize="none" spellcheck="false" data-bwignore="true" data-lpignore="true" data-1p-ignore="true"></textarea><p class="smallprint">${t('cloud_delete_recovery_required')}</p></div>
      <div class="btn-row"><button class="btn danger" type="submit">${t('delete')}</button><button class="btn secondary" id="cancel-cloud-target-delete" type="button">${t('cancel')}</button></div>
      <div id="cloud-target-delete-msg"></div>
    </form></div></dialog>`;
}

function renderCloudDeleteDialog() {
  return `<dialog class="dialog" id="cloud-delete-dialog"><div class="dialog-body"><button class="btn ghost close-x" id="close-cloud-delete" type="button">✕</button><h2>${t('delete_cloud_confirm_title')}</h2><p>${t('delete_cloud_confirm_copy')}</p>
    <form id="cloud-delete-form" class="form-grid" autocomplete="off" data-bwignore="true" data-lpignore="true" data-1p-ignore="true">
      <div class="form-row"><label>${t('confirm_word_label')}</label><input name="delete_confirm_word" autocomplete="off" autocapitalize="none" data-bwignore="true" data-lpignore="true" data-1p-ignore="true" placeholder="${t('confirm_word_placeholder')}" required /></div>
      <div class="form-row"><label>${t('passphrase')}</label><input type="password" name="delete_profile_passphrase" autocomplete="off" data-bwignore="true" data-lpignore="true" data-1p-ignore="true" required /></div>
      <div class="form-row"><label>${t('recovery_phrase_input')}</label><textarea name="delete_recovery_phrase" autocomplete="off" autocapitalize="none" spellcheck="false" data-bwignore="true" data-lpignore="true" data-1p-ignore="true" required></textarea><p class="smallprint">${t('cloud_delete_recovery_required')}</p></div>
      <div class="btn-row"><button class="btn danger" type="submit">${t('delete_permanently')}</button><button class="btn secondary" id="cancel-cloud-delete" type="button">${t('cancel')}</button></div>
      <div id="cloud-delete-msg"></div>
    </form></div></dialog>`;
}

function renderLocalDeleteDialog() {
  return `<dialog class="dialog" id="local-delete-dialog"><div class="dialog-body"><button class="btn ghost close-x" id="close-local-delete" type="button">✕</button><h2>${t('delete_local_confirm_title')}</h2><p>${t('delete_local_confirm_copy')}</p>
    <form id="local-delete-form" class="form-grid" autocomplete="off" data-bwignore="true" data-lpignore="true" data-1p-ignore="true">
      <div class="form-row"><label>${t('confirm_word_label')}</label><input name="delete_confirm_word" autocomplete="off" autocapitalize="none" data-bwignore="true" data-lpignore="true" data-1p-ignore="true" placeholder="${t('confirm_word_placeholder')}" required /></div>
      <div class="form-row"><label>${t('passphrase')}</label><input type="password" name="delete_profile_passphrase" autocomplete="off" data-bwignore="true" data-lpignore="true" data-1p-ignore="true" required /></div>
      <div class="btn-row"><button class="btn danger" type="submit">${t('delete_permanently')}</button><button class="btn secondary" id="cancel-local-delete" type="button">${t('cancel')}</button></div>
      <div id="local-delete-msg"></div>
    </form></div></dialog>`;
}

function bindDashboard() {
  $$('dialog').forEach(dlg => dlg.addEventListener('close', () => { if (pendingRender) render(); }));
  $$('[data-page-action]').forEach(btn => btn.addEventListener('click', () => {
    const key = btn.dataset.pageKey;
    const state = paginationState(key);
    if (btn.dataset.pageAction === 'first') state.page = 1;
    if (btn.dataset.pageAction === 'prev') state.page = Math.max(1, state.page - 1);
    if (btn.dataset.pageAction === 'next') state.page += 1;
    if (btn.dataset.pageAction === 'last') state.page = Number.MAX_SAFE_INTEGER;
    render();
  }));
  $$('[data-page-size]').forEach(select => select.addEventListener('change', () => {
    const key = select.dataset.pageSize;
    const state = paginationState(key);
    state.size = Number(select.value) || DEFAULT_PAGE_SIZE;
    state.page = 1;
    render();
  }));
  $$('[data-route]').forEach(btn => btn.addEventListener('click', () => { session.route = btn.dataset.route; saveUnlockSession({ force: true }); render(); }));
  $('#lock-btn')?.addEventListener('click', () => lockCurrentSession('manual'));
  $('#add-tx-btn')?.addEventListener('click', () => openTxDialog());
  $('#close-tx-dialog')?.addEventListener('click', closeTxDialog);
  $('#cancel-tx')?.addEventListener('click', closeTxDialog);
  $('#tx-form')?.addEventListener('submit', saveTxFromForm);
  const _txAutoFillForm = $('#tx-form');
  if (_txAutoFillForm) {
    const _autoFillTxPrice = () => {
      const priceField = field(_txAutoFillForm, 'price_fiat');
      if (priceField.value !== '') return;
      const assetRaw = (field(_txAutoFillForm, 'asset_symbol').value || '').trim().toUpperCase();
      if (!assetRaw) return;
      const asset = canonicalAssetSymbol(assetRaw, session.data?.asset_aliases);
      const currency = (field(_txAutoFillForm, 'fiat_currency').value || session.data?.config?.base_currency || 'EUR').toUpperCase();
      const tsInput = field(_txAutoFillForm, 'timestamp').value;
      const timestamp = tsInput ? new Date(tsInput).toISOString() : nowISO();
      const cached = priceCacheLookup(session.data, asset, currency, timestamp);
      if (cached != null) { priceField.value = cached; return; }
      const live = session.data?.prices?.[asset]?.[currency.toLowerCase()];
      if (Number.isFinite(Number(live))) priceField.value = live;
    };
    field(_txAutoFillForm, 'asset_symbol')?.addEventListener('change', _autoFillTxPrice);
    field(_txAutoFillForm, 'fiat_currency')?.addEventListener('change', _autoFillTxPrice);
    field(_txAutoFillForm, 'timestamp')?.addEventListener('change', _autoFillTxPrice);
  }
  $$('[data-edit-tx]').forEach(btn => btn.addEventListener('click', () => openTxDialog(Number(btn.dataset.editTx))));
  $$('[data-delete-tx]').forEach(btn => btn.addEventListener('click', async () => deleteTx(Number(btn.dataset.deleteTx))));
  $('#filter-query')?.addEventListener('input', e => { session.filter.query = e.target.value; resetPagination('transactions'); render(); });
  $('#filter-asset')?.addEventListener('change', e => { session.filter.asset = e.target.value; resetPagination('transactions'); render(); });
  $('#filter-type')?.addEventListener('change', e => { session.filter.type = e.target.value; resetPagination('transactions'); render(); });
  $('#filter-profile')?.addEventListener('change', e => { session.filter.profile = e.target.value; resetPagination('transactions'); render(); });
  $('#active-profile-switch')?.addEventListener('change', async e => { const id = String(e.target.value || ''); if (txProfiles().some(p => p.id === id)) { session.data.active_profile_id = id; session.filter.profile = 'active'; await persist(t('active_profile_changed'), { snapshot: false }); render(); } });
  $('#clear-filters')?.addEventListener('click', () => { session.filter = { query: '', asset: '', type: '', profile: 'active' }; resetPagination('transactions'); render(); });
  $('#export-csv')?.addEventListener('click', () => exportCSV(transactionsForProfileIDs(selectedExportProfileIDs(new FormData($('#export-form')))), 'traeky-export.csv'));
  $('#export-filtered')?.addEventListener('click', () => exportCSV(filteredTransactions(), 'traeky-filtered.csv'));
  $('#export-pdf')?.addEventListener('click', () => exportPDFReport(transactionsForProfileIDs(selectedExportProfileIDs(new FormData($('#export-form')))), makeExportFilename('pdf')));
  $('#print-report')?.addEventListener('click', () => window.print());
  $('#import-form')?.addEventListener('submit', importCSVFile);
  $('#apply-import')?.addEventListener('click', applyImportPreview);
  $('#tax-filter-form')?.addEventListener('submit', e => { e.preventDefault(); const fd = new FormData(e.currentTarget); session.tax = { method: String(fd.get('method') || 'FIFO'), from: String(fd.get('from') || ''), to: String(fd.get('to') || '') }; session.data.config.tax_method = session.tax.method; render(); });
  $('#export-tax-csv')?.addEventListener('click', exportTaxCSV);
  $('#asset-form')?.addEventListener('submit', saveAssetFromForm);
  $('#price-form')?.addEventListener('submit', saveManualPrice);
  $('#capture-balance-snapshot')?.addEventListener('click', async () => { captureBalanceSnapshot(); await persist(t('balance_snapshot_saved')); });
  $('#address-form')?.addEventListener('submit', saveAddressBookEntry);
  $('#refresh-prices')?.addEventListener('click', () => refreshPrices({ manual: true, force: true }));
  $('#sync-form')?.addEventListener('submit', saveSyncConfig);
  $('#sync-push')?.addEventListener('click', syncPush);
  $('#sync-pull')?.addEventListener('click', syncPull);
  $$('[data-test-cloud-target]').forEach(btn => btn.addEventListener('click', () => syncTestTarget(btn.dataset.testCloudTarget)));
  $$('[data-toggle-cloud-target]').forEach(btn => btn.addEventListener('click', () => toggleCloudTarget(btn.dataset.toggleCloudTarget)));
  $$('[data-edit-cloud-target]').forEach(btn => btn.addEventListener('click', () => editCloudTarget(btn.dataset.editCloudTarget)));
  $$('[data-delete-cloud-target]').forEach(btn => btn.addEventListener('click', () => openCloudTargetDeleteDialog(btn.dataset.deleteCloudTarget)));
  $('#close-cloud-target-delete')?.addEventListener('click', closeCloudTargetDeleteDialog);
  $('#cancel-cloud-target-delete')?.addEventListener('click', closeCloudTargetDeleteDialog);
  $('#cloud-target-delete-form')?.addEventListener('submit', deleteCloudTarget);
  $('#delete-cloud-open')?.addEventListener('click', openCloudDeleteDialog);
  $('#close-cloud-delete')?.addEventListener('click', closeCloudDeleteDialog);
  $('#cancel-cloud-delete')?.addEventListener('click', closeCloudDeleteDialog);
  $('#cloud-delete-form')?.addEventListener('submit', deleteCloudBackup);
  $('#close-local-delete')?.addEventListener('click', closeLocalDeleteDialog);
  $('#cancel-local-delete')?.addEventListener('click', closeLocalDeleteDialog);
  $('#local-delete-form')?.addEventListener('submit', deleteLocalVault);
  $('#settings-form')?.addEventListener('submit', saveSettings);
  $('#tx-profile-form')?.addEventListener('submit', createTxProfile);
  $$('[data-set-active-tx-profile]').forEach(btn => btn.addEventListener('click', async () => { session.data.active_profile_id = btn.dataset.setActiveTxProfile; session.filter.profile = 'active'; await persist(t('active_profile_changed'), { snapshot: false }); render(); }));
  $$('[data-rename-tx-profile]').forEach(btn => btn.addEventListener('click', () => renameTxProfile(btn.dataset.renameTxProfile)));
  $$('[data-delete-tx-profile]').forEach(btn => btn.addEventListener('click', () => deleteTxProfile(btn.dataset.deleteTxProfile)));
  $('#pass-form')?.addEventListener('submit', changePassphrase);
  $('#export-vault')?.addEventListener('click', () => downloadJSON(session.envelope, 'traeky-vault.encrypted.json'));
  $('#file-connect')?.addEventListener('click', async () => {
    try { await connectSyncFile(); render(); }
    catch (err) { if (err?.name !== 'AbortError') alert(`${t('file_connect_failed')}: ${err.message || err}`); }
  });
  $('#file-disconnect')?.addEventListener('click', async () => { await disconnectSyncFile(); render(); });
  $('#file-save-now')?.addEventListener('click', async () => {
    const ok = await fileSyncNow({ interactive: true });
    alert(ok ? t('file_saved') : t('file_save_failed'));
    render();
  });
  $('#delete-local')?.addEventListener('click', openLocalDeleteDialog);
  $$('[data-restore-snapshot]').forEach(btn => btn.addEventListener('click', () => restoreSnapshot(btn.dataset.restoreSnapshot)));
  $$('[data-delete-snapshot]').forEach(btn => btn.addEventListener('click', () => deleteSnapshot(btn.dataset.deleteSnapshot)));
}

async function restoreSnapshot(id) {
  const snapshot = normalizeSnapshots(session.data.snapshots).find(s => s.id === id);
  if (!snapshot) return;
  if (!confirm(t('snapshot_restore_confirm'))) return;
  createSnapshot(session.data, currentLocale === 'de' ? 'Stand vor Snapshot-Wiederherstellung' : 'State before snapshot restore');
  applySnapshot(session.data, snapshot);
  await persist(t('snapshot_restored'));
}

async function deleteSnapshot(id) {
  if (!confirm(t('snapshot_delete_confirm'))) return;
  session.data.snapshots = normalizeSnapshots(session.data.snapshots).filter(s => s.id !== id);
  await persist(t('snapshot_deleted'), { snapshot: false });
}

function openTxDialog(id = null) {
  const dialog = $('#tx-dialog');
  const form = $('#tx-form');
  form.reset();
  const tx = id ? session.data.transactions.find(t => t.id === id) : null;
  $('#tx-dialog-title').textContent = tx ? t('tx_edit') : t('tx_new');
  field(form, 'id').value = tx?.id || '';
  field(form, 'profile_id').value = tx?.profile_id || activeTxProfileID();
  field(form, 'asset_symbol').value = tx?.asset_symbol || '';
  field(form, 'tx_type').value = tx?.tx_type || 'BUY';
  field(form, 'amount').value = tx?.amount ?? '';
  field(form, 'timestamp').value = toLocalInput(tx?.timestamp || nowISO());
  field(form, 'price_fiat').value = tx?.price_fiat ?? '';
  field(form, 'fiat_currency').value = tx?.fiat_currency || session.data.config.base_currency || 'EUR';
  field(form, 'source').value = tx?.source || '';
  field(form, 'tx_id').value = tx?.tx_id || '';
  field(form, 'note').value = tx?.note || '';
  field(form, 'event_subtype').value = tx?.event_subtype || '';
  field(form, 'location').value = tx?.location || '';
  field(form, 'counterparty').value = tx?.counterparty || '';
  field(form, 'fee_asset').value = tx?.fee_asset || '';
  field(form, 'fee_amount').value = tx?.fee_amount || '';
  field(form, 'tags').value = (tx?.tags || []).join(', ');
  field(form, 'ignored').checked = Boolean(tx?.ignored);
  dialog.showModal();
}

function closeTxDialog() { $('#tx-dialog')?.close(); }
function field(form, name) { return form.elements.namedItem(name); }
function toLocalInput(iso) { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0,16); }

async function saveTxFromForm(e) {
  e.preventDefault();
  const f = e.currentTarget;
  const id = Number(field(f, 'id').value || 0);
  const tx = normalizeTx({
    id: id || session.data.next_transaction_id++,
    profile_id: field(f, 'profile_id').value || activeTxProfileID(),
    asset_symbol: field(f, 'asset_symbol').value,
    tx_type: field(f, 'tx_type').value,
    amount: field(f, 'amount').value,
    price_fiat: field(f, 'price_fiat').value || null,
    fiat_currency: field(f, 'fiat_currency').value,
    timestamp: new Date(field(f, 'timestamp').value).toISOString(),
    source: field(f, 'source').value,
    tx_id: field(f, 'tx_id').value,
    note: field(f, 'note').value,
    event_subtype: field(f, 'event_subtype').value,
    location: field(f, 'location').value,
    counterparty: field(f, 'counterparty').value,
    fee_asset: field(f, 'fee_asset').value,
    fee_amount: field(f, 'fee_amount').value,
    tags: field(f, 'tags').value,
    ignored: field(f, 'ignored').checked
  });
  if (!tx) return;
  const existingIndex = session.data.transactions.findIndex(t => t.id === id);
  if (existingIndex >= 0) session.data.transactions[existingIndex] = tx; else session.data.transactions.push(tx);
  updateAssetRegistryFromTx(tx);
  closeTxDialog();
  await persist(id ? (currentLocale === 'de' ? 'Transaktion bearbeitet' : 'Transaction edited') : (currentLocale === 'de' ? 'Transaktion erfasst' : 'Transaction added'));
}

async function deleteTx(id) {
  if (!confirm(t('confirm_delete_tx'))) return;
  session.data.transactions = session.data.transactions.filter(t => t.id !== id);
  await persist(currentLocale === 'de' ? 'Transaktion gelöscht' : 'Transaction deleted');
}

function detectCSVDelimiter(text) {
  const firstLine = String(text || '').split(/\r?\n/, 1)[0] || '';
  const candidates = [',', ';', '\t'];
  let best = ',', bestCount = -1;
  for (const delimiter of candidates) {
    let count = 0, quoted = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') {
        if (quoted && firstLine[i + 1] === '"') i++; else quoted = !quoted;
      } else if (ch === delimiter && !quoted) count++;
    }
    if (count > bestCount) { best = delimiter; bestCount = count; }
  }
  return best;
}

function parseCSV(text) {
  const delimiter = detectCSVDelimiter(text);
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i+1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (ch === delimiter && !quoted) { row.push(cell); cell = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i+1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

async function importCSVFile(e) {
  e.preventDefault?.();
  const form = e.currentTarget;
  const file = form?.elements?.csv?.files?.[0] || $('#csv-file')?.files?.[0];
  if (!file) return;
  const msg = $('#import-msg');
  try {
    const rows = parseCSV(await file.text());
    const source = String(new FormData(form).get('source') || 'auto');
    const targetProfileID = String(new FormData(form).get('target_profile_id') || activeTxProfileID());
    const preview = buildImportPreview(rows, source, file.name, targetProfileID);
    session.pendingImport = preview;
    session.importResult = null;
    if (msg) msg.innerHTML = renderImportPreview(preview);
    render();
  } catch (err) {
    if (msg) msg.innerHTML = `<div class="notice danger">${t('csv_import_failed')}: ${escapeHTML(err.message || err)}</div>`;
  }
}

function rebuildCurrentPricesFromCache(existingPrices = {}, rows = []) {
  const prices = { ...(existingPrices || {}) };
  for (const row of normalizePriceCache(rows)) {
    const asset = canonicalAssetSymbol(row.asset);
    const quote = canonicalAssetSymbol(row.quote).toLowerCase();
    if (!asset || !quote) continue;
    const currentDate = prices[asset]?.[`${quote}_date`] || '';
    if (!prices[asset] || !currentDate || row.date >= currentDate) {
      prices[asset] = { ...(prices[asset] || {}), [quote]: Number(row.price), [`${quote}_date`]: row.date, fetched_at: row.updated_at || nowISO() };
    }
  }
  return prices;
}

function priceRowsFromTransactions(transactions = [], source = 'import') {
  const rows = [];
  for (const tx of transactions || []) {
    if (!tx || tx.ignored) continue;
    const asset = canonicalAssetSymbol(tx.asset_symbol || tx.asset || tx.symbol);
    const qty = Math.abs(parseDecimal(tx.amount));
    const date = String(tx.timestamp || nowISO()).slice(0, 10);
    if (!asset || !Number.isFinite(qty) || qty <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const add = (quote, price) => {
      const q = canonicalAssetSymbol(quote || 'EUR');
      const p = Number(price);
      if (q && Number.isFinite(p) && p > 0) rows.push({ asset, quote: q, date, price: p, source, updated_at: nowISO() });
    };
    if (tx.price_fiat != null && Number.isFinite(Number(tx.price_fiat))) add(tx.fiat_currency || session.data?.config?.base_currency || 'EUR', Number(tx.price_fiat));
    if (tx.fiat_value != null && Number.isFinite(Number(tx.fiat_value))) add(tx.fiat_currency || session.data?.config?.base_currency || 'EUR', Math.abs(Number(tx.fiat_value)) / qty);
    if (tx.value_eur != null && Number.isFinite(Number(tx.value_eur))) add('EUR', Math.abs(Number(tx.value_eur)) / qty);
    if (tx.value_usd != null && Number.isFinite(Number(tx.value_usd))) add('USD', Math.abs(Number(tx.value_usd)) / qty);
  }
  return normalizePriceCache(rows);
}

function importPreviewPrice(tx) {
  const base = session.data?.config?.base_currency || 'EUR';
  const exact = txUnitPriceInCurrency(tx, base, false);
  if (Number.isFinite(Number(exact)) && Number(exact) > 0) return { price: Number(exact), currency: base };
  const fallbackCurrency = tx.fiat_currency || base;
  const fallback = txUnitPriceInCurrency(tx, fallbackCurrency, true);
  if (Number.isFinite(Number(fallback)) && Number(fallback) > 0) return { price: Number(fallback), currency: fallbackCurrency };
  return null;
}

function buildImportPreview(rows, source = 'auto', filename = '', targetProfileID = activeTxProfileID()) {
  if (!rows.length) return { source, filename, transactions: [], warnings: [t('import_no_rows')] };
  const header = rows.shift().map(h => String(h || '').replace(/^\uFEFF/, '').trim());
  const detected = source === 'auto' ? detectImporter(header, filename) : source;
  const existing = new Set(session.data.transactions.map(dedupeKey));
  const warnings = [];
  const transactions = [];
  const importedConfig = {};
  let skipped = 0;
  rows.forEach((r, idx) => {
    const obj = Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']));
    if (detected === 'traeky') collectTraekyImportConfig(obj, importedConfig);
    const candidate = mapImportRow(obj, detected, idx + 2);
    if (candidate.warning) warnings.push(candidate.warning);
    const tx = normalizeTx({ ...candidate.tx, profile_id: targetProfileID, id: session.data.next_transaction_id + transactions.length });
    if (!tx) { skipped++; return; }
    if (tx.price_fiat == null && DISPOSAL_TYPES.has(tx.tx_type)) warnings.push(t('missing_price_import_warning', { asset: tx.asset_symbol, line: idx + 2 }));
    if (existing.has(dedupeKey(tx))) { skipped++; return; }
    existing.add(dedupeKey(tx));
    transactions.push(tx);
  });
  if (skipped) warnings.push(`${skipped} ${currentLocale === 'de' ? 'Zeilen übersprungen oder Duplikate' : 'rows skipped or duplicates'}`);
  const price_cache = priceRowsFromTransactions(transactions, `${detected}-csv`);
  return { source: detected, filename, target_profile_id: targetProfileID, transactions, warnings, config: Object.keys(importedConfig).length ? importedConfig : null, price_cache, created_at: nowISO() };
}

// Settings a Traeky CSV export may carry back into the profile. Deliberately
// limited to local report settings: `price_fetch_enabled` and
// `coingecko_api_key` are NOT importable, because a CSV is untrusted input and
// must never be able to switch on outbound price requests or redirect them to a
// third-party API key without the user knowing. Those two stay under the
// explicit control of the settings form.
const IMPORTABLE_CONFIG_KEYS = ['holding_period_days', 'upcoming_holding_window_days', 'base_currency'];

function collectTraekyImportConfig(obj, target) {
  const lower = Object.fromEntries(Object.entries(obj).map(([k, v]) => [String(k).toLowerCase(), v]));
  const get = (key) => obj[key] ?? lower[String(key).toLowerCase()] ?? '';
  const holding = Number(get('holding_period_days'));
  const upcoming = Number(get('upcoming_holding_window_days'));
  const base = String(get('base_currency') || '').trim().toUpperCase();
  if (Number.isFinite(holding) && holding > 0) target.holding_period_days = holding;
  if (Number.isFinite(upcoming) && upcoming > 0) target.upcoming_holding_window_days = upcoming;
  if (['EUR', 'USD'].includes(base)) target.base_currency = base;
}

// Describes the settings an import would change, so the preview can show them
// before the user applies it.
function importConfigChanges(config) {
  if (!config || typeof config !== 'object') return [];
  const current = session.data?.config || {};
  return IMPORTABLE_CONFIG_KEYS
    .filter(key => config[key] !== undefined && String(config[key]) !== String(current[key] ?? ''))
    .map(key => ({ key, from: current[key] ?? '-', to: config[key] }));
}

function detectImporter(header, filename) {
  const h = header.map(x => x.toLowerCase()).join('|');
  const name = String(filename || '').toLowerCase();
  if (h.includes('traeky_exported_at') || h.includes('value_eur') || h.includes('value_usd') || h.includes('fiat_value') || h.includes('csv_schema_version')) return 'traeky';
  if (name.includes('stakebook') || (h.includes('reward_iota') && h.includes('epoch_end_time')) || (h.includes('event_type') && h.includes('amount_iota') && h.includes('stake_object_id'))) return 'stakebook';
  if (h.includes('utc_time') || h.includes('operation') || name.includes('binance')) return 'binance';
  if (h.includes('buy amount') || h.includes('sell amount') || h.includes('exchange') || name.includes('cointracking') || name.includes('blockpit')) return 'cointracking';
  return 'generic';
}

function mapImportRow(obj, source, line) {
  const keyVariants = (key) => {
    const raw = String(key || '').replace(/^\uFEFF/, '').trim().toLowerCase();
    const snake = raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const compact = raw.replace(/[^a-z0-9]+/g, '');
    return [raw, snake, compact];
  };
  const lower = {};
  for (const [k, v] of Object.entries(obj)) for (const variant of keyVariants(k)) lower[variant] = v;
  const get = (...keys) => keys.map(k => obj[k] ?? keyVariants(k).map(variant => lower[variant]).find(v => v != null && String(v).trim() !== '')).find(v => v != null && String(v).trim() !== '') ?? '';
  const deriveUnitPrice = (amountValue) => {
    const direct = get('price_fiat', 'price', 'unit_price', 'unit_price_fiat', 'price_value', 'price_per_asset', 'kurs', 'einstandskurs', 'preis', 'asset_price', 'price_eur', 'price_usd');
    if (String(direct).trim() !== '') return direct;
    const total = get('value_fiat', 'total_fiat', 'fiat_value', 'fiat_total', 'value_in_currency', 'value_eur', 'value_usd', 'value', 'total', 'worth', 'market_value', 'portfolio_value', 'holding_value', 'gesamtwert', 'wert');
    const totalNum = parseDecimal(total);
    const amountNum = Math.abs(parseDecimal(amountValue));
    if (Number.isFinite(totalNum) && Number.isFinite(amountNum) && amountNum > 0) return String(Math.abs(totalNum) / amountNum);
    return '';
  };
  if (source === 'traeky') {
    const amountRaw = get('amount', 'menge', 'quantity', 'total_amount', 'holding_amount', 'balance');
    const asset = get('asset_symbol', 'asset', 'symbol', 'asset_name', 'coin');
    return { tx: {
      ...obj,
      asset_symbol: asset,
      tx_type: get('tx_type', 'type') || 'BUY',
      amount: amountRaw,
      price_fiat: deriveUnitPrice(amountRaw) || get('price_fiat', 'price') || null,
      fiat_currency: get('fiat_currency', 'currency', 'quote_currency', 'base_currency') || session.data.config.base_currency,
      fiat_value: get('fiat_value', 'value_fiat', 'total_fiat', 'fiat_total', 'value_in_currency'),
      value_eur: get('value_eur', 'eur_value', 'total_eur', 'market_value_eur', 'holding_value_eur'),
      value_usd: get('value_usd', 'usd_value', 'total_usd', 'market_value_usd', 'holding_value_usd'),
      timestamp: get('timestamp', 'date', 'time') || nowISO(),
      source: get('source') || 'Traeky CSV',
      note: get('note', 'description'),
      tx_id: get('tx_id', 'txid', 'hash'),
      linked_tx_prev_id: get('linked_tx_prev_id'),
      linked_tx_next_id: get('linked_tx_next_id'),
      profile_id: get('profile_id', 'profile')
    }, warning: !asset || !Number.isFinite(parseDecimal(amountRaw)) ? `Line ${line}: invalid Traeky CSV row` : '' };
  }
  if (source === 'binance') {
    const op = String(get('Operation', 'operation', 'Type', 'type')).toUpperCase();
    const coin = get('Coin', 'Asset', 'asset');
    const change = get('Change', 'Amount', 'amount');
    const amount = parseDecimal(change);
    const type = op.includes('SELL') ? 'SELL' : op.includes('BUY') ? 'BUY' : op.includes('WITHDRAW') ? 'WITHDRAWAL' : op.includes('DEPOSIT') ? 'DEPOSIT' : op.includes('FEE') ? 'FEE' : op.includes('EARN') || op.includes('REWARD') ? 'REWARD' : 'INFO';
    return { tx: { asset_symbol: coin, tx_type: type, amount: Math.abs(amount), price_fiat: deriveUnitPrice(change) || null, fiat_currency: get('fiat_currency', 'Currency', 'currency') || session.data.config.base_currency, timestamp: get('UTC_Time', 'Date', 'timestamp') || nowISO(), source: 'Binance', note: op, tx_id: get('Transaction_ID', 'TxID', 'tx_id') }, warning: !coin || !Number.isFinite(amount) ? `Line ${line}: invalid Binance row` : '' };
  }
  if (source === 'stakebook') {
    const event = String(get('event_type', 'reward_type', 'type') || '').toLowerCase();
    const amountRaw = get('amount_iota', 'reward_iota', 'amount', 'quantity');
    const amount = parseDecimal(amountRaw);
    const txType = event.includes('unstake') ? 'TRANSFER_INTERNAL'
      : event.includes('stake') && !event.includes('reward') ? 'TRANSFER_INTERNAL'
      : event.includes('reward') || event.includes('commission') ? 'STAKING_REWARD'
      : 'INFO';
    const timestamp = get('effective_time', 'event_time', 'epoch_end_time', 'created_at', 'price_reference_time') || nowISO();
    const label = get('label', 'validator_name');
    const address = get('address', 'validator_address');
    const notes = [get('notes'), get('reward_type')].filter(Boolean).join(' · ');
    return { tx: {
      asset_symbol: 'IOTA',
      tx_type: txType,
      event_subtype: event || 'stakebook',
      amount: Math.abs(amount),
      price_fiat: deriveUnitPrice(amountRaw) || null,
      fiat_currency: String(get('currency') || session.data.config.base_currency).toUpperCase(),
      timestamp,
      source: 'StakeBook CSV',
      location: 'StakeBook CSV',
      counterparty: address,
      tx_id: get('tx_digest', 'stake_object_id'),
      tags: ['stakebook', event].filter(Boolean).join(';'),
      note: [label, notes].filter(Boolean).join(' · ')
    }, warning: !Number.isFinite(amount) || !amountRaw ? `Line ${line}: invalid StakeBook CSV row` : '' };
  }
  if (source === 'cointracking') {
    const buyAsset = get('Buy Cur.', 'Buy Currency', 'buy_asset', 'asset');
    const sellAsset = get('Sell Cur.', 'Sell Currency', 'sell_asset');
    const type = String(get('Type', 'type')).toUpperCase();
    const asset = buyAsset || sellAsset || get('asset_symbol', 'asset');
    const amountRaw = get('Buy Amount', 'buy_amount', 'amount') || get('Sell Amount', 'sell_amount');
    const amount = parseDecimal(amountRaw);
    return { tx: { asset_symbol: asset, tx_type: type.includes('SELL') || sellAsset ? 'SELL' : type.includes('WITHDRAW') ? 'WITHDRAWAL' : type.includes('DEPOSIT') ? 'DEPOSIT' : 'BUY', amount: Math.abs(amount), price_fiat: deriveUnitPrice(amountRaw) || null, fiat_currency: get('Currency', 'fiat_currency') || session.data.config.base_currency, timestamp: get('Date', 'timestamp') || nowISO(), source: get('Exchange', 'source') || 'Import', fee_asset: get('Fee Cur.', 'fee_asset'), fee_amount: get('Fee', 'fee_amount'), note: type }, warning: !asset || !Number.isFinite(amount) ? `Line ${line}: invalid import row` : '' };
  }
  const amountRaw = get('amount', 'menge', 'quantity', 'amount_iota', 'reward_iota');
  return { tx: { ...obj, asset_symbol: get('asset_symbol', 'asset', 'symbol'), tx_type: get('tx_type', 'type') || 'BUY', amount: amountRaw, price_fiat: deriveUnitPrice(amountRaw) || null, fiat_currency: get('fiat_currency', 'currency', 'fiat', 'währung', 'waehrung') || session.data.config.base_currency, timestamp: get('timestamp', 'date', 'time', 'zeitpunkt') || nowISO(), source: get('source', 'exchange', 'location'), note: get('note', 'description', 'notiz'), tx_id: get('tx_id', 'txid', 'hash'), fee_asset: get('fee_asset', 'fee_currency'), fee_amount: get('fee_amount', 'fee'), tags: get('tags'), event_subtype: get('event_subtype', 'subtype'), location: get('location'), counterparty: get('counterparty', 'address'), profile_id: get('profile_id', 'profile') }, warning: '' };
}

async function applyImportPreview() {
  const preview = session.pendingImport;
  const msg = $('#import-msg');
  if (!preview?.transactions?.length) return;
  let imported = 0, skipped = 0;
  const importedTxs = [];
  const existing = new Set(session.data.transactions.map(dedupeKey));
  for (const item of preview.transactions) {
    const tx = normalizeTx({ ...item, profile_id: preview.target_profile_id || item.profile_id || activeTxProfileID(), id: session.data.next_transaction_id++ });
    if (!tx || existing.has(dedupeKey(tx))) { skipped++; continue; }
    existing.add(dedupeKey(tx));
    session.data.transactions.push(tx);
    importedTxs.push(tx);
    updateAssetRegistryFromTx(tx);
    imported++;
  }
  const importedPriceRows = normalizePriceCache([...(preview.price_cache || []), ...priceRowsFromTransactions(importedTxs, `${preview.source || 'import'}-csv`)]);
  if (importedPriceRows.length) {
    session.data.price_cache = normalizePriceCache([...(session.data.price_cache || []), ...importedPriceRows]);
    session.data.prices = rebuildCurrentPricesFromCache(session.data.prices || {}, session.data.price_cache);
  }
  if (preview.config && typeof preview.config === 'object') {
    // Re-apply the whitelist here as well: a preview object could have been
    // produced by an older build or a restored session.
    const allowed = Object.fromEntries(IMPORTABLE_CONFIG_KEYS
      .filter(key => preview.config[key] !== undefined)
      .map(key => [key, preview.config[key]]));
    session.data.config = { ...session.data.config, ...allowed };
  }
  session.data.import_runs = [...(session.data.import_runs || []), { id: uuid(), source: preview.source, filename: preview.filename, imported, skipped, warnings: preview.warnings || [], created_at: nowISO() }].slice(-50);
  session.pendingImport = null;
  session.importResult = { imported, skipped, source: preview.source, filename: preview.filename, created_at: nowISO() };
  await persist(currentLocale === 'de' ? `CSV importiert: ${imported} neu, ${skipped} übersprungen` : `CSV imported: ${imported} new, ${skipped} skipped`);
  const freshMsg = $('#import-msg') || msg;
  if (freshMsg) freshMsg.innerHTML = renderImportResult(session.importResult);
}

function dedupeKey(tx) { return [tx.profile_id || 'main', tx.asset_symbol, tx.tx_type, Number(tx.amount).toFixed(12), tx.timestamp, tx.location || tx.source || '', tx.tx_id || '', tx.fee_asset || '', Number(tx.fee_amount || 0).toFixed(12)].join('|'); }

function exportCSV(items, filename) {
  const header = ['csv_schema_version','id','profile_id','profile_name','group_id','sequence','asset_symbol','tx_type','event_type','event_subtype','amount','price_fiat','fiat_currency','fiat_value','value_eur','value_usd','timestamp','location','source','counterparty','fee_asset','fee_amount','tags','ignored','note','tx_id','linked_tx_prev_id','linked_tx_next_id'];
  const lines = [header.join(',')];
  for (const tx of items) lines.push(header.map(h => csvCell(h === 'csv_schema_version' ? CSV_SCHEMA_VERSION : (h === 'tags' ? (tx.tags || []).join(';') : (h === 'profile_name' ? txProfileName(tx.profile_id) : (tx[h] ?? ''))))).join(','));
  downloadBlob(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }), filename);
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function makeExportFilename(ext) {
  const date = new Date().toISOString().slice(0, 10);
  const account = String(session.data?.account?.name || 'default').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default';
  return `traeky-${account}-${date}.${ext}`;
}

function exportPDFReport(items, filename) {
  const blob = buildPDFReport(session.data, Array.isArray(items) ? items : session.data.transactions);
  downloadBlob(blob, filename || makeExportFilename('pdf'));
}

function buildPDFReport(data, transactions) {
  const pageW = 842;
  const pageH = 595;
  const margin = 32;
  const font = 'F1';
  const pages = [];
  let ops = [];
  let y = pageH - margin;

  const line = (x1, y1, x2, y2, width = 0.6) => ops.push(`${width} w ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`);
  const text = (value, x, yy, size = 9) => ops.push(`BT /${font} ${num(size)} Tf 1 0 0 1 ${num(x)} ${num(yy)} Tm ${pdfLiteral(value)} Tj ET`);
  const addPage = () => {
    pages.push(ops.join('\n'));
    ops = [];
    y = pageH - margin;
  };
  const ensure = (needed) => { if (y - needed < margin + 16) { footer(); addPage(); header(false); } };
  const footer = () => {
    line(margin, margin + 16, pageW - margin, margin + 16, 0.4);
    text(currentLocale === 'de' ? 'Traeky Report - keine steuerliche oder rechtliche Beratung' : 'Traeky report - no tax or legal advice', margin, margin, 7);
    text(`${currentLocale === 'de' ? 'Seite' : 'Page'} ${pages.length + 1}`, pageW - margin - 42, margin, 7);
  };
  const header = (first) => {
    if (!first) {
      text('Traeky: Report', margin, y, 15);
      text(`${t('account')}: ${data.account?.name || 'Default'}`, pageW - 230, y, 9);
      y -= 22;
      line(margin, y + 8, pageW - margin, y + 8, 0.5);
    }
  };

  const txs = [...(transactions || [])].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const summary = computeSummary(data, txs);
  const currency = data.config?.base_currency || 'EUR';
  const generated = new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date());

  text('Traeky: Report', margin, y, 22); y -= 20;
  text(`${currentLocale === 'de' ? 'Erstellt am' : 'Generated'}: ${generated}`, margin, y, 10); y -= 14;
  text(`${t('account')}: ${data.account?.name || 'Default'} | ${t('nav_transactions')}: ${txs.length} | ${currentLocale === 'de' ? 'Basiswaehrung' : 'Base currency'}: ${currency}`, margin, y, 10); y -= 18;
  line(margin, y, pageW - margin, y, 0.7); y -= 22;

  text(currentLocale === 'de' ? 'Uebersicht' : 'Overview', margin, y, 14); y -= 16;
  text(`${currentLocale === 'de' ? 'Portfoliowert' : 'Portfolio value'}: ${moneyPlain(summary.total, currency)}`, margin, y, 10); y -= 12;
  text(`Assets: ${summary.items.length}`, margin, y, 10); y -= 12;
  text(`${currentLocale === 'de' ? 'Auslaufende Haltefrist' : 'Expiring holding periods'}: ${summary.expiring.length}`, margin, y, 10); y -= 20;

  if (summary.items.length) {
    text('Holdings', margin, y, 13); y -= 12;
    line(margin, y, pageW - margin, y, 0.5); y -= 11;
    text(t('asset'), margin, y, 8); text(t('amount'), margin + 72, y, 8); text(t('price'), margin + 190, y, 8); text(t('value'), margin + 300, y, 8); text(currentLocale === 'de' ? 'Anteil' : 'Share', margin + 415, y, 8); y -= 8;
    line(margin, y, pageW - margin, y, 0.3); y -= 11;
    for (const item of summary.items.slice(0, 18)) {
      ensure(16);
      text(item.symbol, margin, y, 8);
      text(numPlain(item.amount, 8), margin + 72, y, 8);
      text(moneyPlain(item.price, currency), margin + 190, y, 8);
      text(moneyPlain(item.value, currency), margin + 300, y, 8);
      text(`${Math.round((summary.total ? item.value / summary.total : 0) * 1000) / 10}%`, margin + 415, y, 8);
      y -= 12;
    }
    y -= 10;
  }

  ensure(80);
  text(t('tx_book'), margin, y, 14); y -= 13;
  const cols = [
    { title: 'ID', x: margin, w: 28 },
    { title: 'Chain', x: margin + 30, w: 58 },
    { title: t('time'), x: margin + 90, w: 78 },
    { title: 'Asset', x: margin + 170, w: 38 },
    { title: t('type'), x: margin + 210, w: 76 },
    { title: t('amount'), x: margin + 288, w: 66 },
    { title: t('price'), x: margin + 356, w: 66 },
    { title: t('value'), x: margin + 424, w: 66 },
    { title: currentLocale === 'de' ? 'Waehr.' : 'Curr.', x: margin + 492, w: 36 },
    { title: t('source'), x: margin + 530, w: 70 },
    { title: `TX-ID / ${t('note')}`, x: margin + 602, w: 205 }
  ];
  const tableHeader = () => {
    line(margin, y, pageW - margin, y, 0.5); y -= 10;
    cols.forEach(c => text(c.title, c.x, y, 7.5));
    y -= 7;
    line(margin, y, pageW - margin, y, 0.3); y -= 10;
  };
  tableHeader();
  if (!txs.length) {
    text(currentLocale === 'de' ? 'Keine Transaktionen vorhanden.' : 'No transactions available.', margin, y, 9); y -= 14;
  }
  for (const tx of txs) {
    ensure(22);
    if (y > pageH - margin - 42) tableHeader();
    const value = Number(tx.amount || 0) * Number(tx.price_fiat || 0);
    const row = [
      String(tx.id || ''),
      `N:${tx.linked_tx_next_id || '-'} P:${tx.linked_tx_prev_id || '-'}`,
      shortDate(tx.timestamp),
      tx.asset_symbol,
      formatTxType(tx.tx_type),
      numPlain(tx.amount, 8),
      tx.price_fiat == null ? '-' : numPlain(tx.price_fiat, 2),
      tx.price_fiat == null ? '-' : numPlain(value, 2),
      tx.fiat_currency || currency,
      tx.source || '-',
      tx.tx_id || tx.note || '-'
    ];
    row.forEach((value, i) => text(clip(value, cols[i].w), cols[i].x, y, 7));
    y -= 11;
  }

  y -= 8;
  ensure(44);
  line(margin, y, pageW - margin, y, 0.5); y -= 14;
  text(currentLocale === 'de' ? 'Hinweis: Dieser Report stellt keine steuerliche oder rechtliche Beratung dar. Die Berechnungen basieren ausschliesslich auf den in Traeky erfassten Daten und koennen unvollstaendig oder fehlerhaft sein.' : 'Notice: This report is not tax or legal advice. Calculations are based only on data entered in Traeky and may be incomplete or incorrect.', margin, y, 7.5);
  y -= 10;
  text(currentLocale === 'de' ? 'Bitte pruefe alle Angaben sorgfaeltig und wende dich bei Bedarf an eine Steuerberaterin oder einen Steuerberater.' : 'Please review all information carefully and consult a tax professional if needed.', margin, y, 7.5);
  footer();
  addPage();

  return new Blob([makePDF(pages, pageW, pageH)], { type: 'application/pdf' });
}

function makePDF(pageStreams, pageW, pageH) {
  const encoder = new TextEncoder();
  const objects = [];
  const pageRefs = [];
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  for (let i = 0; i < pageStreams.length; i++) {
    const pageObj = 4 + i * 2;
    const contentObj = pageObj + 1;
    pageRefs.push(`${pageObj} 0 R`);
    objects[pageObj - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`;
    const stream = pageStreams[i];
    objects[contentObj - 1] = `<< /Length ${encoder.encode(stream).length} >>\nstream\n${stream}\nendstream`;
  }
  objects[1] = `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageStreams.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(encoder.encode(pdf).length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = encoder.encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return encoder.encode(pdf);
}

function pdfLiteral(value) {
  return `(${asciiPDF(value).replace(/[\\()]/g, '\\$&')})`;
}

function asciiPDF(value) {
  return String(value ?? '')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss').replace(/€/g, 'EUR')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x20-\x7E]/g, '?');
}

function clip(value, width) {
  const max = Math.max(4, Math.floor(width / 3.8));
  const s = asciiPDF(value).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, Math.max(1, max - 3))}...` : s;
}

function shortDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function moneyPlain(value, currency = 'EUR') {
  return `${numPlain(value, 2)} ${currency}`;
}

function numPlain(value, digits = 2) {
  const n = Number(value || 0);
  return new Intl.NumberFormat(localeTag(), { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(n);
}

function formatTxType(value) {
  return txLabel(value) || value || '-';
}

function num(value) {
  return Number(value).toFixed(2).replace(/\.00$/, '');
}

async function refreshPrices(options = {}) {
  const { manual = false, force = false, silent = false } = options;
  if (!session.unlocked || !session.data || !priceFetchEnabled(session.data)) return false;
  if (!shouldRefreshPrices(session.data, force)) return false;
  if (priceRefreshInFlight) return false;
  const btn = $('#refresh-prices');
  if (btn) btn.disabled = true;
  priceRefreshInFlight = true;
  priceRefreshLastRun = Date.now();
  try {
    const assets = normalizeAssets(session.data.assets, session.data.transactions);
    const symbols = computeSummary(session.data).items.map(i => i.symbol).filter(s => (assets[s]?.coingecko || ASSET_META[s]?.coingecko));
    const ids = [...new Set(symbols.map(s => assets[s]?.coingecko || ASSET_META[s]?.coingecko))];
    if (!ids.length) return false;
    const params = new URLSearchParams({ ids: ids.join(','), vs_currencies: 'eur,usd' });
    if (session.data.config.coingecko_api_key) params.set('x_cg_demo_api_key', session.data.config.coingecko_api_key);
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?${params}`);
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const prices = await res.json();
    session.data.prices = session.data.prices || {};
    const rows = [];
    const fetchedAt = nowISO();
    const day = fetchedAt.slice(0,10);
    let changed = false;
    for (const sym of symbols) {
      const coinID = assets[sym]?.coingecko || ASSET_META[sym]?.coingecko;
      const p = prices[coinID];
      if (p) {
        const next = { ...(session.data.prices[sym] || {}), fetched_at: fetchedAt };
        if (Number.isFinite(Number(p.eur))) {
          next.eur = Number(p.eur);
          next.eur_date = day;
          rows.push({ asset: sym, quote: 'EUR', date: day, price: Number(p.eur), source: 'coingecko', updated_at: fetchedAt });
        }
        if (Number.isFinite(Number(p.usd))) {
          next.usd = Number(p.usd);
          next.usd_date = day;
          rows.push({ asset: sym, quote: 'USD', date: day, price: Number(p.usd), source: 'coingecko', updated_at: fetchedAt });
        }
        session.data.prices[sym] = next;
        changed = true;
      }
    }
    if (rows.length) session.data.price_cache = normalizePriceCache([...(session.data.price_cache || []), ...rows]);
    if (changed) await persist(manual ? t('prices_updated') : '', { snapshot: false, autosync: false });
    return changed;
  } catch (err) {
    if (!silent) alert(`${t('price_update_failed')}: ${err.message || err}`);
    return false;
  } finally {
    priceRefreshInFlight = false;
    if (btn) btn.disabled = false;
  }
}

function normalizeCloudTerms(payload = {}) {
  const rawTerms = payload.terms && typeof payload.terms === 'object' ? payload.terms : {};
  const body = sanitizeMultilineServerText(rawTerms.body || rawTerms.text || payload.disclaimer || payload.terms_text || '');
  return {
    required: rawTerms.required !== false,
    version: sanitizeServerText(rawTerms.version || payload.terms_version || '', 64) || 'default',
    title: sanitizeServerText(rawTerms.title || payload.terms_title || '', 200) || t('cloud_terms_title'),
    body: body || t('cloud_terms_missing'),
    privacy_policy_url: normalizeExternalLegalURL(rawTerms.privacy_policy_url || rawTerms.privacyPolicyUrl || rawTerms.privacy_url || payload.privacy_policy_url || payload.privacyPolicyUrl || payload.privacy_url || ''),
    imprint_url: normalizeExternalLegalURL(rawTerms.imprint_url || rawTerms.imprintUrl || rawTerms.legal_notice_url || payload.imprint_url || payload.imprintUrl || payload.legal_notice_url || '')
  };
}

function cloudTermsAccepted(target, terms) {
  if (!terms?.required) return true;
  if (!target?.terms_accepted_at) return false;
  return String(target.terms_version || '') === String(terms.version || '')
    && String(target.terms_body || '') === String(terms.body || '')
    && String(target.privacy_policy_url || '') === String(terms.privacy_policy_url || '')
    && String(target.imprint_url || '') === String(terms.imprint_url || '');
}

async function fetchCloudServerInfo(url) {
  const res = await fetch(`${normalizeCloudURL(url)}${CLOUD_API_PREFIX}/info`, { cache: 'no-store', headers: traekyClientHeaders() });
  const payload = await safeJSON(res);
  if (!res.ok) throw new Error(serverErrorMessage(payload, res));
  validateCloudCompatibility(payload);
  return payload;
}

function cloudInfoVersion(info = {}) {
  return sanitizeVersionString(String(info.traeky_version || info.app_version || '').trim().replace(/^v/i, ''));
}

function cloudInfoCommit(info = {}) {
  return sanitizeVersionString(info.commit || info.cloud_commit || '', 64);
}

function cloudInfoRetentionDays(info = {}) {
  const raw = info.inactive_retention_days ?? info.inactiveRetentionDays ?? info.cloud_retention_days ?? info.cloudRetentionDays ?? null;
  if (raw === null || raw === undefined || raw === '') return null;
  const days = Number(raw);
  return Number.isFinite(days) && days >= 0 ? days : null;
}

function validateCloudCompatibility(info = {}) {
  const cloudVersion = cloudInfoVersion(info);
  const dashboardVersion = currentAppVersion();
  if (cloudVersion && dashboardVersion && cloudVersion !== dashboardVersion) {
    throw new Error(t('cloud_version_mismatch', { dashboard: dashboardVersion, cloud: cloudVersion }));
  }
  if (info.strict_client_commit === true) {
    const dashboardCommit = currentAppCommit();
    const cloudCommit = cloudInfoCommit(info);
    if (!dashboardCommit || !cloudCommit || dashboardCommit !== cloudCommit) {
      throw new Error(t('cloud_commit_mismatch'));
    }
  }
}

function mergeCloudTargetCompatibility(target, info, terms) {
  return normalizeCloudTarget({
    ...(target || {}),
    cloud_retention_days: cloudInfoRetentionDays(info),
    cloud_info_checked_at: nowISO(),
    terms_version: terms.version,
    terms_title: terms.title,
    terms_body: terms.body,
    terms_accepted_at: target?.terms_accepted_at || '',
    privacy_policy_url: terms.privacy_policy_url,
    imprint_url: terms.imprint_url,
    cloud_version: cloudInfoVersion(info),
    cloud_commit: cloudInfoCommit(info),
    cloud_commit_short: normalizeCommitShort(info.commit_short || info.commitShort || cloudInfoCommit(info)),
    strict_client_commit: Boolean(info.strict_client_commit),
    last_status: 'synced',
    last_error: ''
  });
}

async function ensureCloudTargetCompatible(target) {
  const tcopy = normalizeCloudTarget(target);
  const info = await fetchCloudServerInfo(tcopy.url);
  const terms = normalizeCloudTerms(info);
  if (!cloudTermsAccepted(tcopy, terms)) throw new Error(t('cloud_terms_reaccept_required'));
  return mergeCloudTargetCompatibility(tcopy, info, terms);
}

async function fetchCloudServerHealth(url) {
  const res = await fetch(`${normalizeCloudURL(url)}/health`, { cache: 'no-store' });
  const payload = await safeJSON(res);
  if (!res.ok) throw new Error(serverErrorMessage(payload, res));
  if (payload.status && payload.status !== 'ok') throw new Error(sanitizeServerText(payload.message || payload.status) || `HTTP ${res.status}`);
  return payload;
}

async function confirmCloudTerms(url, info) {
  const terms = normalizeCloudTerms(info);
  if (!terms.required) return { accepted: true, terms };
  const dialog = $('#cloud-terms-dialog');
  if (!dialog) return { accepted: window.confirm(`${terms.title}\n\n${terms.body}`), terms };
  const server = $('#cloud-terms-server');
  const content = $('#cloud-terms-content');
  const links = $('#cloud-terms-links');
  const accept = $('#cloud-terms-accept');
  const msg = $('#cloud-terms-msg');
  if (server) server.textContent = url;
  if (content) content.textContent = terms.body;
  if (links) links.innerHTML = renderCloudLegalLinks(terms);
  if (accept) accept.checked = false;
  if (msg) msg.innerHTML = '';
  return new Promise(resolve => {
    let settled = false;
    const form = $('#cloud-terms-form');
    const cancel = $('#cancel-cloud-terms');
    const cleanup = (accepted) => {
      if (settled) return;
      settled = true;
      if (form) form.onsubmit = null;
      if (cancel) cancel.onclick = null;
      dialog.removeEventListener('cancel', onCancel);
      if (dialog.open) dialog.close();
      resolve({ accepted, terms });
    };
    const onCancel = (event) => { event.preventDefault(); cleanup(false); };
    if (form) form.onsubmit = (event) => {
      event.preventDefault();
      if (!accept?.checked) {
        if (msg) msg.innerHTML = `<div class="notice danger">${t('cloud_terms_required')}</div>`;
        return;
      }
      cleanup(true);
    };
    if (cancel) cancel.onclick = () => cleanup(false);
    dialog.addEventListener('cancel', onCancel);
    dialog.showModal();
  });
}

function mergeCloudTargetInfo(target, info, terms) {
  return normalizeCloudTarget({
    ...(target || {}),
    cloud_retention_days: cloudInfoRetentionDays(info),
    cloud_info_checked_at: nowISO(),
    terms_version: terms.version,
    terms_title: terms.title,
    terms_body: terms.body,
    terms_accepted_at: nowISO(),
    privacy_policy_url: terms.privacy_policy_url,
    imprint_url: terms.imprint_url,
    cloud_version: cloudInfoVersion(info),
    cloud_commit: cloudInfoCommit(info),
    cloud_commit_short: normalizeCommitShort(info.commit_short || info.commitShort || cloudInfoCommit(info)),
    strict_client_commit: Boolean(info.strict_client_commit),
    last_status: 'synced',
    last_error: ''
  });
}

async function saveSyncConfig(e) {
  e.preventDefault();
  const cfg = session.data.config;
  const form = e.currentTarget;
  const msg = $('#sync-msg');
  const fd = new FormData(form);
  const urls = parseCloudURLs(fd.get('cloud_url') || fd.get('cloud_urls') || '');
  if (!urls.length) return;
  const existing = new Map(getCloudTargets(cfg).map(t => [t.url, t]));
  const nextTargets = getCloudTargets(cfg);
  try {
    if (msg) msg.innerHTML = `<div class="notice info">${t('cloud_fetching_terms')}</div>`;
    for (const url of urls) {
      const current = normalizeCloudTarget({ ...(existing.get(url) || {}), url, enabled: true });
      const info = await fetchCloudServerInfo(url);
      const terms = normalizeCloudTerms(info);
      if (!cloudTermsAccepted(current, terms)) {
        const confirmation = await confirmCloudTerms(url, info);
        if (!confirmation.accepted) throw new Error(t('cloud_terms_required'));
      }
      const merged = mergeCloudTargetInfo(current, info, terms);
      const idx = nextTargets.findIndex(t => t.url === url);
      if (idx >= 0) nextTargets[idx] = merged; else nextTargets.push(merged);
    }
    setCloudTargets(cfg, nextTargets);
    delete cfg.cloud_vault_id;
    delete cfg.cloud_token;
    if (form) form.reset();
    await persist(currentLocale === 'de' ? 'Cloud-Server hinzugefügt' : 'Cloud server added', { autosync: false });
    const syncResult = await syncPush({ auto: true });
    const freshMsg = $('#sync-msg');
    if (freshMsg) {
      const failed = syncResult?.failed || [];
      freshMsg.innerHTML = failed.length
        ? `<div class="notice danger">${t('cloud_add_failed')}: ${escapeHTML(failed.map(r => `${r.target.label || r.target.url}: ${r.error}`).join(' · '))}</div>`
        : `<div class="notice success">${t('cloud_server_added')}</div>`;
    }
  } catch (err) {
    if (msg) msg.innerHTML = `<div class="notice danger">${t('cloud_add_failed')}: ${escapeHTML(err.message || err)}</div>`;
  }
}


function findCloudTargetIndex(id) {
  const targets = getCloudTargets(session.data.config);
  const key = String(id || '');
  return { targets, index: targets.findIndex(t => String(t.id) === key || String(t.url) === key) };
}

async function editCloudTarget(id) {
  const msg = $('#sync-msg');
  const found = findCloudTargetIndex(id);
  if (found.index < 0) return;
  const target = found.targets[found.index];
  const input = window.prompt(t('cloud_edit_url_prompt'), target.url);
  if (input == null) return;
  const nextURL = normalizeCloudURL(input);
  if (!nextURL) { if (msg) msg.innerHTML = `<div class="notice danger">${t('cloud_add_failed')}: ${escapeHTML(t('cloud_url'))}</div>`; return; }
  if (nextURL === target.url) return;
  if (found.targets.some((tgt, idx) => idx !== found.index && tgt.url === nextURL)) {
    if (msg) msg.innerHTML = `<div class="notice danger">${t('cloud_server_duplicate')}</div>`;
    return;
  }
  try {
    if (msg) msg.innerHTML = `<div class="notice info">${t('cloud_fetching_terms')}</div>`;
    const info = await fetchCloudServerInfo(nextURL);
    const candidate = normalizeCloudTarget({
      ...target,
      url: nextURL,
      label: nextURL.replace(/^https?:\/\//, ''),
      last_remote_revision: 0,
      last_sync_at: '',
      last_remote_auth_secret: '',
      updated_at: '',
      terms_version: '',
      terms_title: '',
      terms_body: '',
      terms_accepted_at: ''
    });
    const terms = normalizeCloudTerms(info);
    const confirmation = await confirmCloudTerms(nextURL, info);
    if (!confirmation.accepted) throw new Error(t('cloud_terms_required'));
    found.targets[found.index] = mergeCloudTargetInfo(candidate, info, terms);
    setCloudTargets(session.data.config, found.targets);
    await persist(currentLocale === 'de' ? 'Cloud-Server aktualisiert' : 'Cloud server updated', { autosync: false });
    const syncResult = await syncPush({ auto: true });
    const freshMsg = $('#sync-msg');
    if (freshMsg) {
      const failed = syncResult?.failed || [];
      freshMsg.innerHTML = failed.length
        ? `<div class="notice danger">${t('cloud_server_update_failed')}: ${escapeHTML(failed.map(r => `${r.target.label || r.target.url}: ${r.error}`).join(' · '))}</div>`
        : `<div class="notice success">${t('cloud_server_updated')}</div>`;
    }
  } catch (err) {
    if (msg) msg.innerHTML = `<div class="notice danger">${t('cloud_server_update_failed')}: ${escapeHTML(err.message || err)}</div>`;
  }
}

function openCloudTargetDeleteDialog(id) {
  const found = findCloudTargetIndex(id);
  if (found.index < 0) return;
  const target = found.targets[found.index];
  const dialog = $('#cloud-target-delete-dialog');
  if (!dialog) return;
  const form = $('#cloud-target-delete-form');
  form?.reset();
  if (form?.elements?.cloud_target_id) form.elements.cloud_target_id.value = target.id;
  const server = $('#cloud-target-delete-server');
  if (server) server.innerHTML = `<b>${escapeHTML(target.label || target.url)}</b><br/><span class="smallprint">${escapeHTML(target.url)}</span>`;
  const msg = $('#cloud-target-delete-msg');
  if (msg) msg.innerHTML = '';
  dialog.showModal();
}

function closeCloudTargetDeleteDialog() { $('#cloud-target-delete-dialog')?.close(); }

async function deleteCloudTarget(e) {
  e.preventDefault();
  const msg = $('#cloud-target-delete-msg');
  try {
    const fd = new FormData(e.currentTarget);
    const word = String(fd.get('delete_confirm_word') || '').trim();
    if (word !== confirmWord()) throw new Error(t('cloud_delete_bad_confirm'));
    const found = findCloudTargetIndex(fd.get('cloud_target_id'));
    if (found.index < 0) throw new Error(t('cloud_delete_need_config'));
    let target = found.targets[found.index];
    const deleteRemote = Boolean(fd.get('delete_remote_data'));
    if (deleteRemote) {
      target = await ensureCloudTargetCompatible(target);
      found.targets[found.index] = target;
      setCloudTargets(session.data.config, found.targets);
      const passphrase = String(fd.get('delete_profile_passphrase') || '');
      try {
        await decryptVault(session.envelope, passphrase);
      } catch {
        throw new Error(t('cloud_delete_bad_pass'));
      }
      const recoveryCheck = await verifyRecoveryPhraseForCurrentAccount(String(fd.get('delete_recovery_phrase') || ''));
      const deleteAuthSecret = String(session.data.config.cloud_key || '') === recoveryCheck.derived.legacyVaultID ? recoveryCheck.derived.legacyAuthSecret : recoveryCheck.derived.authSecret;
      const revision = Number(target.last_remote_revision || 0);
      if (!revision) throw new Error(t('remote_conflict'));
      if (msg) msg.innerHTML = `<div class="notice info">${t('cloud_deleting')}</div>`;
      const res = await cloudAuthedDelete(cloudEndpoint(target), target, deleteAuthSecret, { 'If-Match': String(revision) });
      if (!(res.status === 204 || res.status === 404)) {
        const payload = await safeJSON(res);
        throw new Error(serverErrorMessage(payload, res));
      }
    }
    const nextTargets = found.targets.filter((_, idx) => idx !== found.index);
    setCloudTargets(session.data.config, nextTargets);
    closeCloudTargetDeleteDialog();
    await persist(deleteRemote ? t('cloud_server_removed_remote') : t('cloud_server_removed'));
    const syncMsg = $('#sync-msg');
    if (syncMsg) syncMsg.innerHTML = `<div class="notice success">${deleteRemote ? t('cloud_server_removed_remote') : t('cloud_server_removed')}</div>`;
  } catch (err) {
    if (msg) msg.innerHTML = `<div class="notice danger">${t('cloud_delete_failed')}: ${escapeHTML(err.message || err)}</div>`;
  }
}

function cloudEndpoint(target = null, vaultID = null) {
  const cfg = session.data.config;
  const base = normalizeCloudURL(target?.url || cfg.cloud_url || '');
  const id = vaultID || cfg.cloud_key;
  if (!base || !id) throw new Error(t('cloud_delete_need_config'));
  return `${base}${CLOUD_API_PREFIX}/vaults/${encodeURIComponent(id)}`;
}

function cloudAuthOrigin(url) {
  try { return new URL(String(url || '')).origin.toLowerCase(); } catch { return ''; }
}

// Cloud access proof.
//
// v2 binds the proof to the origin of the server it is sent to, using the cloud
// access secret as an HMAC key. A hostile or compromised cloud server therefore
// only ever learns a credential that is valid on itself and cannot replay it
// against another Traeky cloud server holding the same vault. Deriving another
// origin's proof requires the secret, which never leaves the browser.
//
// v1 is the previous origin-independent proof. It is kept only to authenticate
// vaults that have not been migrated yet; every successful push rotates such a
// vault to a v2 proof via X-Traeky-New-Vault-Auth.
async function cloudAuthProof(secret, url = '', version = CLOUD_AUTH_PROOF_V2) {
  const value = String(secret || '').trim();
  if (!value) return '';
  if (version === CLOUD_AUTH_PROOF_V1) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`traeky-cloud-auth-v1:${value}`));
    return `ta1_${b64url(new Uint8Array(digest))}`;
  }
  const origin = cloudAuthOrigin(url);
  if (!origin) throw new Error(t('cloud_delete_need_config'));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(value), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`traeky-cloud-auth-v2|${origin}`));
  return `ta2_${b64url(new Uint8Array(mac))}`;
}

async function cloudAuthHeaders(target = null, options = {}) {
  const cfg = session.data.config;
  const url = target?.url || cfg.cloud_url || '';
  const currentSecret = String(cfg.cloud_auth_secret || '').trim();
  const remoteSecret = String(target?.last_remote_auth_secret || cfg.last_remote_auth_secret || currentSecret).trim();
  const revision = Number(target?.last_remote_revision || cfg.last_remote_revision || 0) || 0;
  // Without a known remote revision the vault is about to be created, so protect
  // it with the origin-bound proof straight away. An existing vault is addressed
  // with the proof version it is actually known to carry.
  const proofVersion = options.proofVersion || (revision ? normalizeAuthProofVersion(target?.auth_proof_version) : CLOUD_AUTH_PROOF_V2);
  const headers = {};
  if (remoteSecret) headers['X-Traeky-Vault-Auth'] = await cloudAuthProof(remoteSecret, url, proofVersion);
  const secretRotation = Boolean(revision && remoteSecret && currentSecret && remoteSecret !== currentSecret);
  const proofUpgrade = Boolean(revision && currentSecret && proofVersion !== CLOUD_AUTH_PROOF_V2);
  if (secretRotation || proofUpgrade) {
    headers['X-Traeky-New-Vault-Auth'] = await cloudAuthProof(currentSecret, url, CLOUD_AUTH_PROOF_V2);
  }
  return headers;
}

// Authenticated GET with a one-shot fallback to the other proof version. The
// recorded version can be stale - for example when another device already
// migrated the vault on a server this profile has not talked to since. Returns
// the proof version that the server actually accepted.
async function cloudAuthedGet(endpoint, target) {
  const recorded = Number(target?.last_remote_revision || 0)
    ? normalizeAuthProofVersion(target?.auth_proof_version)
    : CLOUD_AUTH_PROOF_V2;
  const order = recorded === CLOUD_AUTH_PROOF_V2
    ? [CLOUD_AUTH_PROOF_V2, CLOUD_AUTH_PROOF_V1]
    : [CLOUD_AUTH_PROOF_V1, CLOUD_AUTH_PROOF_V2];
  let res = null;
  let proofVersion = order[0];
  for (const version of order) {
    proofVersion = version;
    res = await fetch(endpoint, { headers: traekyClientHeaders(await cloudAuthHeaders(target, { proofVersion: version })) });
    if (res.status !== 401) break;
  }
  return { res, proofVersion };
}

// DELETE with the same one-shot proof-version fallback as cloudAuthedGet, so a
// vault that has not been migrated yet stays deletable.
async function cloudAuthedDelete(endpoint, target, secret, extraHeaders = {}) {
  const order = normalizeAuthProofVersion(target?.auth_proof_version) === CLOUD_AUTH_PROOF_V2
    ? [CLOUD_AUTH_PROOF_V2, CLOUD_AUTH_PROOF_V1]
    : [CLOUD_AUTH_PROOF_V1, CLOUD_AUTH_PROOF_V2];
  let res = null;
  for (const version of order) {
    const headers = traekyClientHeaders({ ...extraHeaders, 'X-Traeky-Vault-Auth': await cloudAuthProof(secret, target?.url || '', version) });
    res = await fetch(endpoint, { method: 'DELETE', headers });
    if (res.status !== 401) break;
  }
  return res;
}

async function syncPush(options = {}) {
  const auto = Boolean(options.auto);
  const msg = $('#sync-msg');
  if (!auto && msg) msg.innerHTML = `<div class="notice info">${t('syncing_encrypt_upload')}</div>`;
  const allTargets = getCloudTargets();
  const targets = allTargets.filter(t => t.enabled !== false && t.url);
  if (!targets.length) {
    if (msg) msg.innerHTML = `<div class="notice danger">${t('cloud_delete_need_config')}</div>`;
    return { successful: 0, total: 0, failed: [] };
  }
  const previousCounter = Number(session.data.config.cloud_sync_counter || 0) || 0;
  const nextCounter = previousCounter + 1;
  const cloudData = { ...session.data, config: { ...session.data.config, cloud_sync_counter: nextCounter } };
  const envelope = await encryptRemoteVault(cloudData, session.passphrase, session.rootSecret);
  const results = [];
  for (const target of targets) {
    results.push(await syncPushTarget(target, envelope));
  }
  const resultMap = new Map(results.map(r => [r.target.id, r.target]));
  setCloudTargets(session.data.config, allTargets.map(t => resultMap.get(t.id) || t));
  const successful = results.filter(r => r.ok).length;
  if (successful > 0) session.data.config.cloud_sync_counter = Math.max(previousCounter, nextCounter);
  await persist(auto ? '' : (currentLocale === 'de' ? 'Cloud Connect Push abgeschlossen' : 'Cloud Connect push completed'), { autosync: false, snapshot: false });
  const nextMsg = $('#sync-msg');
  const failed = results.filter(r => !r.ok);
  if (!auto && nextMsg) {
    const detail = failed.length ? ` ${failed.map(r => `${r.target.label || r.target.url}: ${r.error}`).join(' · ')}` : '';
    nextMsg.innerHTML = `<div class="notice ${failed.length ? 'danger' : 'success'}">${successful}/${results.length} ${currentLocale === 'de' ? 'Cloud-Server synchronisiert' : 'cloud servers synced'}.${escapeHTML(detail)}</div>`;
  }
  return { successful, total: results.length, failed };
}

async function refreshRemoteRevisionForPush(target) {
  const tcopy = normalizeCloudTarget(target);
  const { res, proofVersion } = await cloudAuthedGet(cloudEndpoint(tcopy), tcopy);
  const payload = await safeJSON(res);
  if (res.status === 404) return { exists: false, target: tcopy, payload: null };
  if (!res.ok) {
    if (res.status === 401) throw new Error(t('access_wrong'));
    throw new Error(serverErrorMessage(payload, res));
  }
  tcopy.auth_proof_version = proofVersion;
  tcopy.last_remote_revision = Number(payload.revision || 0);
  tcopy.last_remote_auth_secret = String(tcopy.last_remote_auth_secret || session.data.config.cloud_auth_secret || '').trim();
  tcopy.updated_at = payload.updated_at || payload.body?.sealed_at || nowISO();
  tcopy.last_status = 'synced';
  tcopy.last_error = '';
  return { exists: true, target: tcopy, payload };
}

async function syncPushTarget(target, envelope) {
  let tcopy = normalizeCloudTarget(target);
  try {
    tcopy = await ensureCloudTargetCompatible(tcopy);
    if (!tcopy.last_remote_revision) {
      const remote = await refreshRemoteRevisionForPush(tcopy);
      tcopy = remote.target;
    }
    const headers = traekyClientHeaders({ 'Content-Type': 'application/json', ...(await cloudAuthHeaders(tcopy)) });
    if (tcopy.last_remote_revision) headers['If-Match'] = String(tcopy.last_remote_revision);
    else headers['If-None-Match'] = '*';
    let res = await fetch(cloudEndpoint(tcopy), { method: 'PUT', headers, body: JSON.stringify({ client_id: deviceID(), device_name: navigator.userAgent.slice(0, 120), body: envelope }) });
    let payload = await safeJSON(res);
    if (!res.ok && res.status === 409 && !target.last_remote_revision) {
      const remote = await refreshRemoteRevisionForPush(tcopy);
      tcopy = remote.target;
      if (tcopy.last_remote_revision) {
        const retryHeaders = traekyClientHeaders({ 'Content-Type': 'application/json', ...(await cloudAuthHeaders(tcopy)), 'If-Match': String(tcopy.last_remote_revision) });
        res = await fetch(cloudEndpoint(tcopy), { method: 'PUT', headers: retryHeaders, body: JSON.stringify({ client_id: deviceID(), device_name: navigator.userAgent.slice(0, 120), body: envelope }) });
        payload = await safeJSON(res);
      }
    }
    if (!res.ok) {
      if (res.status === 401) throw new Error(t('access_wrong'));
      if (res.status === 409) throw new Error(payload.error === 'vault_occupied' ? t('occupied_key') : t('remote_conflict'));
      throw new Error(serverErrorMessage(payload, res));
    }
    tcopy.last_sync_at = nowISO();
    tcopy.last_remote_revision = Number(payload.revision || 0);
    tcopy.last_remote_auth_secret = String(session.data.config.cloud_auth_secret || '').trim();
    // The write succeeded, so the server accepted the current proof and applied
    // any X-Traeky-New-Vault-Auth rotation: the vault is now protected by the
    // origin-bound proof.
    tcopy.auth_proof_version = CLOUD_AUTH_PROOF_V2;
    tcopy.updated_at = payload.updated_at || nowISO();
    tcopy.last_status = 'synced';
    tcopy.last_error = '';
    return { ok: true, target: tcopy, payload };
  } catch (err) {
    tcopy.last_status = String(err.message || err).includes(t('remote_conflict')) ? 'conflict' : 'offline';
    tcopy.last_error = sanitizeServerText(err.message || err);
    return { ok: false, target: tcopy, error: tcopy.last_error };
  }
}

async function syncPull() {
  const msg = $('#sync-msg');
  if (!confirm(t('confirm_pull'))) return;
  if (msg) msg.innerHTML = `<div class="notice info">${t('loading_cloud')}</div>`;
  try {
    const allTargets = getCloudTargets();
    const targets = allTargets.filter(t => t.enabled !== false && t.url);
    if (!targets.length) throw new Error(t('cloud_delete_need_config'));
    const results = [];
    for (const target of targets) results.push(await fetchRemoteTarget(target));
    const resultMap = new Map(results.map(r => [r.target.id, r.target]));
    setCloudTargets(session.data.config, allTargets.map(t => resultMap.get(t.id) || t));
    const candidates = results.filter(r => r.ok && r.payload?.body);
    if (!candidates.length) throw new Error(results.map(r => r.error).filter(Boolean).join(' · ') || t('restore_failed'));
    for (const candidate of candidates) {
      candidate.decrypted = await decryptRemoteVault(candidate.payload.body, session.passphrase, session.rootSecret);
      candidate.clientCounter = Number(candidate.decrypted?.cloud_meta?.counter || candidate.decrypted?.config?.cloud_sync_counter || 0) || 0;
      candidate.clientTimestamp = remoteClientTimestamp(candidate.decrypted, candidate.payload);
    }
    candidates.sort((a, b) => (b.clientCounter - a.clientCounter) || (b.clientTimestamp - a.clientTimestamp));
    const selected = candidates[0];
    const cfg = session.data.config;
    const localCounter = Number(cfg.cloud_sync_counter || 0) || 0;
    // Rollback protection: once this profile has pushed with a sync counter, any
    // remote state carrying a lower counter is rejected. A missing counter reads
    // as 0 and is rejected too, so a server cannot bypass the check by replaying
    // a pre-counter payload.
    if (localCounter && selected.clientCounter < localCounter) throw new Error(t('cloud_rollback_detected'));
    const localSnapshots = normalizeSnapshots(session.data.snapshots);
    let data = selected.decrypted;
    data.snapshots = localSnapshots;
    data.config = { ...data.config, cloud_key: cfg.cloud_key, cloud_auth_secret: String(cfg.cloud_auth_secret || '').trim() };
    const mergedTargets = getCloudTargets(cfg).map(tg => tg.url === selected.target.url ? { ...selected.target, last_sync_at: nowISO(), last_remote_revision: Number(selected.payload.revision || 0), last_status: 'synced', last_error: '', updated_at: selected.payload.updated_at || selected.payload.body?.sealed_at || nowISO() } : tg);
    setCloudTargets(data.config, mergedTargets);
    delete data.config.cloud_vault_id;
    delete data.config.cloud_token;
    session.data = data;
    await persist(currentLocale === 'de' ? 'Cloud Connect Pull abgeschlossen' : 'Cloud Connect pull completed', { autosync: false, snapshot: false });
    const nextMsg = $('#sync-msg');
    if (nextMsg) nextMsg.innerHTML = `<div class="notice success">${t('cloud_restored')} ${escapeHTML(selected.target.label || selected.target.url)}</div>`;
  } catch (err) { if (msg) msg.innerHTML = `<div class="notice danger">${t('restore_failed')}: ${escapeHTML(err.message || err)}</div>`; }
}

async function fetchRemoteTarget(target) {
  let tcopy = normalizeCloudTarget(target);
  try {
    tcopy = await ensureCloudTargetCompatible(tcopy);
    const { res, proofVersion } = await cloudAuthedGet(cloudEndpoint(tcopy), tcopy);
    const payload = await safeJSON(res);
    if (!res.ok) {
      if (res.status === 401) throw new Error(t('access_wrong'));
      throw new Error(serverErrorMessage(payload, res));
    }
    tcopy.auth_proof_version = proofVersion;
    tcopy.last_status = 'synced';
    tcopy.last_error = '';
    tcopy.last_remote_revision = Number(payload.revision || tcopy.last_remote_revision || 0);
    tcopy.updated_at = payload.updated_at || payload.body?.sealed_at || '';
    return { ok: true, target: tcopy, payload };
  } catch (err) {
    tcopy.last_status = 'offline';
    tcopy.last_error = sanitizeServerText(err.message || err);
    return { ok: false, target: tcopy, error: tcopy.last_error };
  }
}

function remoteTimestamp(payload) {
  const value = payload?.updated_at || payload?.body?.sealed_at || payload?.body?.created_at || '';
  const tvalue = new Date(value).getTime();
  return Number.isFinite(tvalue) ? tvalue : 0;
}

function remoteClientTimestamp(data, payload) {
  const value = data?.cloud_meta?.sealed_at || data?.updated_at || payload?.body?.sealed_at || payload?.updated_at || '';
  const tvalue = new Date(value).getTime();
  return Number.isFinite(tvalue) ? tvalue : 0;
}

async function syncTest() {
  const msg = $('#sync-msg');
  try {
    const targets = enabledCloudTargets();
    if (!targets.length) throw new Error(t('cloud_delete_need_config'));
    const tested = [];
    for (const target of targets) {
      const tcopy = normalizeCloudTarget(target);
      try {
        const payload = await fetchCloudServerInfo(tcopy.url);
        const terms = normalizeCloudTerms(payload);
        const acceptedAt = cloudTermsAccepted(tcopy, terms) ? tcopy.terms_accepted_at : '';
        tcopy.cloud_retention_days = cloudInfoRetentionDays(payload);
        tcopy.cloud_info_checked_at = nowISO();
        tcopy.terms_version = terms.version;
        tcopy.terms_title = terms.title;
        tcopy.terms_body = terms.body;
        tcopy.terms_accepted_at = acceptedAt;
        tcopy.privacy_policy_url = terms.privacy_policy_url;
        tcopy.imprint_url = terms.imprint_url;
        tcopy.cloud_version = cloudInfoVersion(payload);
        tcopy.cloud_commit = cloudInfoCommit(payload);
        tcopy.cloud_commit_short = normalizeCommitShort(payload.commit_short || payload.commitShort || cloudInfoCommit(payload));
        tcopy.strict_client_commit = Boolean(payload.strict_client_commit);
        tcopy.last_status = 'synced';
        tcopy.last_error = '';
        tested.push(tcopy);
      } catch (err) {
        tcopy.last_status = 'offline';
        tcopy.last_error = sanitizeServerText(err.message || err);
        tested.push(tcopy);
      }
    }
    setCloudTargets(session.data.config, tested);
    await persist(currentLocale === 'de' ? 'Cloud-Information aktualisiert' : 'Cloud information refreshed', { autosync: false, snapshot: false });
    const ok = tested.filter(t => t.last_status === 'synced').length;
    const retention = cloudRetentionSummary(session.data.config);
    const nextMsg = $('#sync-msg');
    if (nextMsg) nextMsg.innerHTML = `<div class="notice ${ok === tested.length ? 'success' : 'danger'}">${t('cloud_reachable')}: ${ok}/${tested.length} · ${escapeHTML(retention.detail)}</div>`;
  } catch (err) { if (msg) msg.innerHTML = `<div class="notice danger">${t('cloud_test_failed')}: ${escapeHTML(err.message || err)}</div>`; }
}

async function probeCloudTarget(target) {
  const tcopy = normalizeCloudTarget(target);
  try {
    const health = await fetchCloudServerHealth(tcopy.url);
    tcopy.last_heartbeat_at = nowISO();
    tcopy.cloud_retention_days = tcopy.cloud_retention_days ?? null;
    tcopy.last_status = 'synced';
    tcopy.last_error = '';

    try {
      const info = await fetchCloudServerInfo(tcopy.url);
      const terms = normalizeCloudTerms(info);
      const acceptedAt = cloudTermsAccepted(tcopy, terms) ? tcopy.terms_accepted_at : '';
      tcopy.cloud_retention_days = cloudInfoRetentionDays(info);
      tcopy.cloud_info_checked_at = nowISO();
      tcopy.terms_version = terms.version;
      tcopy.terms_title = terms.title;
      tcopy.terms_body = terms.body;
      tcopy.terms_accepted_at = acceptedAt;
      tcopy.privacy_policy_url = terms.privacy_policy_url;
      tcopy.imprint_url = terms.imprint_url;
      tcopy.cloud_version = cloudInfoVersion(info);
      tcopy.cloud_commit = cloudInfoCommit(info);
      tcopy.cloud_commit_short = normalizeCommitShort(info.commit_short || info.commitShort || cloudInfoCommit(info));
      tcopy.strict_client_commit = Boolean(info.strict_client_commit);
    } catch (infoErr) {
      tcopy.last_status = 'offline';
      tcopy.last_error = `Info: ${sanitizeServerText(infoErr.message || infoErr, 160)}`;
      return { ok: false, target: tcopy, error: tcopy.last_error, payload: health };
    }
    return { ok: true, target: tcopy, payload: health };
  } catch (err) {
    tcopy.last_heartbeat_at = nowISO();
    tcopy.last_status = 'offline';
    tcopy.last_error = sanitizeServerText(err.message || err);
    return { ok: false, target: tcopy, error: tcopy.last_error };
  }
}

async function runCloudHeartbeat(options = {}) {
  if (!session.unlocked || !session.data || cloudHeartbeatInFlight) return { checked: 0, ok: 0 };
  const allTargets = getCloudTargets();
  const targets = allTargets.filter(t => t.enabled !== false && t.url);
  if (!targets.length) return { checked: 0, ok: 0 };
  cloudHeartbeatInFlight = true;
  cloudHeartbeatLastRun = Date.now();
  try {
    const results = [];
    for (const target of targets) results.push(await probeCloudTarget(target));
    const resultMap = new Map(results.map(r => [r.target.id, r.target]));
    let changed = false;
    const merged = allTargets.map(tg => {
      const next = resultMap.get(tg.id) || tg;
      if (next.last_status !== tg.last_status || next.last_error !== tg.last_error || next.last_heartbeat_at !== tg.last_heartbeat_at || next.cloud_retention_days !== tg.cloud_retention_days || next.privacy_policy_url !== tg.privacy_policy_url || next.imprint_url !== tg.imprint_url || next.terms_accepted_at !== tg.terms_accepted_at) changed = true;
      return next;
    });
    if (changed) {
      setCloudTargets(session.data.config, merged);
      render();
    }
    return { checked: results.length, ok: results.filter(r => r.ok).length };
  } finally {
    cloudHeartbeatInFlight = false;
  }
}

async function syncTestTarget(id) {
  const msg = $('#sync-msg');
  const found = findCloudTargetIndex(id);
  if (found.index < 0) return;
  if (msg) msg.innerHTML = `<div class="notice info">${t('cloud_testing_server')}</div>`;
  const result = await probeCloudTarget(found.targets[found.index]);
  found.targets[found.index] = result.target;
  setCloudTargets(session.data.config, found.targets);
  render();
  const freshMsg = $('#sync-msg');
  if (freshMsg) freshMsg.innerHTML = `<div class="notice ${result.ok ? 'success' : 'danger'}">${escapeHTML(result.target.label || result.target.url)}: ${result.ok ? t('cloud_reachable') : `${t('cloud_test_failed')}: ${escapeHTML(result.error)}`}</div>`;
}

async function toggleCloudTarget(id) {
  const found = findCloudTargetIndex(id);
  if (found.index < 0) return;
  const target = found.targets[found.index];
  const enabled = target.enabled === false;
  found.targets[found.index] = normalizeCloudTarget({ ...target, enabled, last_error: enabled ? target.last_error : '', last_status: enabled ? target.last_status : 'disabled' });
  setCloudTargets(session.data.config, found.targets);
  await persist(enabled ? t('cloud_server_enabled') : t('cloud_server_disabled'), { autosync: false, snapshot: false });
  if (enabled) syncTestTarget(found.targets[found.index].id);
}

async function safeJSON(res) { try { return await res.json(); } catch { return {}; } }

// Extracts the error text of a cloud server response. The message is attacker
// controlled whenever the server is hostile or compromised, so it is sanitized
// here at the source rather than only at the point where it is displayed.
function serverErrorMessage(payload, res) {
  return sanitizeServerText(payload?.message || payload?.error || '') || `HTTP ${res?.status ?? 0}`;
}
function deviceID() { let id = localStorage.getItem(DEVICE_ID_KEY); if (!id) { id = uuid(); localStorage.setItem(DEVICE_ID_KEY, id); } return id; }


async function saveAssetFromForm(e) {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  const symbol = canonicalAssetSymbol(fd.get('symbol'));
  if (!symbol) return;
  const aliases = String(fd.get('aliases') || '').split(/[;,]/).map(x => canonicalAssetSymbol(x)).filter(Boolean);
  session.data.assets = normalizeAssets({ ...(session.data.assets || {}), [symbol]: { ...(session.data.assets?.[symbol] || {}), symbol, name: String(fd.get('name') || symbol).trim(), type: String(fd.get('type') || detectAssetType(symbol)), aliases } }, session.data.transactions);
  session.data.asset_aliases = normalizeAliases(session.data.asset_aliases);
  for (const alias of aliases) session.data.asset_aliases[alias] = symbol;
  await persist(currentLocale === 'de' ? 'Asset gespeichert' : 'Asset saved');
}

async function saveManualPrice(e) {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  const row = { asset: canonicalAssetSymbol(fd.get('asset')), quote: canonicalAssetSymbol(fd.get('quote') || session.data.config.base_currency), date: String(fd.get('date') || '').slice(0,10), price: Number(fd.get('price')), source: 'manual', updated_at: nowISO() };
  if (!row.asset || !row.quote || !row.date || !Number.isFinite(row.price)) return;
  const cache = normalizePriceCache([...(session.data.price_cache || []).filter(p => !(p.asset === row.asset && p.quote === row.quote && p.date === row.date)), row]);
  session.data.price_cache = cache;
  session.data.prices[row.asset] = { ...(session.data.prices[row.asset] || {}), [row.quote.toLowerCase()]: row.price };
  await persist(currentLocale === 'de' ? 'Preis gespeichert' : 'Price saved');
}


async function createTxProfile(e) {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  const name = String(fd.get('profile_name') || '').trim();
  if (!name) return;
  const profile = { id: uuid(), name, created_at: nowISO(), updated_at: nowISO() };
  session.data.profiles = [...txProfiles(), profile];
  session.data.active_profile_id = profile.id;
  session.filter.profile = 'active';
  await persist(t('profile_created'));
  render();
}

async function renameTxProfile(id) {
  const profile = txProfiles().find(p => p.id === id);
  if (!profile) return;
  const next = window.prompt(t('profile_rename_prompt'), profile.name);
  if (next == null) return;
  const name = String(next || '').trim();
  if (!name) return;
  profile.name = name;
  profile.updated_at = nowISO();
  await persist(t('profile_updated'));
  render();
}

async function deleteTxProfile(id) {
  const profiles = txProfiles();
  const profile = profiles.find(p => p.id === id);
  if (!profile || profiles.length <= 1) return;
  const count = (session.data.transactions || []).filter(tx => String(tx.profile_id || 'main') === id).length;
  if (count > 0) { alert(t('profile_delete_has_transactions')); return; }
  if (!confirm(t('profile_delete_confirm', { name: profile.name }))) return;
  session.data.profiles = profiles.filter(p => p.id !== id);
  if (session.data.active_profile_id === id) session.data.active_profile_id = session.data.profiles[0]?.id || 'main';
  await persist(t('profile_deleted'));
  render();
}

async function saveSettings(e) {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  const nextLocale = String(fd.get('language') || currentLocale).toLowerCase();
  session.data.account.name = String(fd.get('account_name') || session.data.account.name).trim() || 'Default';
  session.data.config.base_currency = String(fd.get('base_currency') || 'EUR');
  session.data.config.auto_lock_minutes = clampAutoLockMinutes(fd.get('auto_lock_minutes'));
  session.data.config.holding_period_days = Math.max(1, Number(fd.get('holding_period_days') || 365));
  session.data.config.upcoming_holding_window_days = Math.max(1, Number(fd.get('upcoming_holding_window_days') || 30));
  session.data.config.price_fetch_enabled = String(fd.get('price_fetch_enabled') || '') === 'on';
  session.data.config.coingecko_api_key = String(fd.get('coingecko_api_key') || '').trim();
  if (SUPPORTED_LOCALES.includes(nextLocale) && nextLocale !== currentLocale) {
    currentLocale = nextLocale;
    localStorage.setItem('traeky:locale', currentLocale);
    document.documentElement.lang = currentLocale;
  }
  await persist(t('settings_saved'));
  render();
}

async function changePassphrase(e) {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  const currentPassphrase = String(fd.get('current_passphrase') || '');
  const nextPassphrase = String(fd.get('new_passphrase') || '');
  const confirmNextPassphrase = String(fd.get('confirm_new_passphrase') || '');
  const err = validatePassphrase(nextPassphrase) || (nextPassphrase !== confirmNextPassphrase ? t('passphrase_mismatch') : '');
  if (err) { alert(err); return; }
  if (nextPassphrase === currentPassphrase) { alert(t('passphrase_change_same')); return; }
  try {
    await decryptVault(session.envelope, currentPassphrase);
  } catch {
    alert(t('passphrase_change_bad_current'));
    return;
  }
  session.passphrase = nextPassphrase;
  await persist(currentLocale === 'de' ? 'Passphrase geändert' : 'Passphrase changed');
  e.currentTarget.reset();
  alert(t('passphrase_changed'));
}

function openLocalDeleteDialog() {
  const dialog = $('#local-delete-dialog');
  if (!dialog) return;
  const form = $('#local-delete-form');
  form?.reset();
  $('#local-delete-msg').innerHTML = '';
  dialog.showModal();
}

function closeLocalDeleteDialog() { $('#local-delete-dialog')?.close(); }

async function deleteLocalVault(e) {
  e.preventDefault();
  const msg = $('#local-delete-msg');
  try {
    const fd = new FormData(e.currentTarget);
    const word = String(fd.get('delete_confirm_word') || fd.get('confirm') || '').trim();
    if (word !== confirmWord()) throw new Error(t('delete_local_bad_confirm'));
    const passphrase = String(fd.get('delete_profile_passphrase') || fd.get('passphrase') || '');
    try {
      await decryptVault(session.envelope, passphrase);
    } catch {
      throw new Error(t('delete_local_bad_pass'));
    }
    const remaining = removeAccount(getActiveAccountID());
    clearUnlockSession();
    session = createLockedSession(remaining.active_id || '');
    closeLocalDeleteDialog();
    alert(t('delete_local_done'));
    render();
  } catch (err) {
    if (msg) msg.innerHTML = `<div class="notice danger">${escapeHTML(err.message || err)}</div>`;
  }
}


function openCloudDeleteDialog() {
  const dialog = $('#cloud-delete-dialog');
  if (!dialog) return;
  const form = $('#cloud-delete-form');
  form?.reset();
  $('#cloud-delete-msg').innerHTML = '';
  dialog.showModal();
}

function closeCloudDeleteDialog() { $('#cloud-delete-dialog')?.close(); }

async function deleteCloudBackup(e) {
  e.preventDefault();
  const msg = $('#cloud-delete-msg');
  try {
    const targets = enabledCloudTargets();
    if (!targets.length) throw new Error(t('cloud_delete_need_config'));
    const fd = new FormData(e.currentTarget);
    const word = String(fd.get('delete_confirm_word') || fd.get('confirm') || '').trim();
    if (word !== confirmWord()) throw new Error(t('cloud_delete_bad_confirm'));
    const passphrase = String(fd.get('delete_profile_passphrase') || fd.get('passphrase') || '');
    try {
      await decryptVault(session.envelope, passphrase);
    } catch {
      throw new Error(t('cloud_delete_bad_pass'));
    }
    const recoveryCheck = await verifyRecoveryPhraseForCurrentAccount(String(fd.get('delete_recovery_phrase') || fd.get('mnemonic') || ''));
    const deleteAuthSecret = String(session.data.config.cloud_key || '') === recoveryCheck.derived.legacyVaultID ? recoveryCheck.derived.legacyAuthSecret : recoveryCheck.derived.authSecret;
    msg.innerHTML = `<div class="notice info">${t('cloud_deleting')}</div>`;
    const updated = [];
    const errors = [];
    for (const target of targets) {
      const tcopy = normalizeCloudTarget(target);
      const revision = Number(tcopy.last_remote_revision || 0);
      if (!revision) throw new Error(t('remote_conflict'));
      const res = await cloudAuthedDelete(cloudEndpoint(tcopy), tcopy, deleteAuthSecret, { 'If-Match': String(revision) });
      if (res.status === 204 || res.status === 404) {
        tcopy.last_remote_revision = 0;
        tcopy.last_sync_at = '';
        tcopy.last_remote_auth_secret = '';
        tcopy.last_status = res.status === 204 ? 'synced' : 'unknown';
        tcopy.last_error = '';
      } else {
        const payload = await safeJSON(res);
        tcopy.last_status = res.status === 401 ? 'conflict' : 'offline';
        tcopy.last_error = serverErrorMessage(payload, res);
        errors.push(`${tcopy.label || tcopy.url}: ${tcopy.last_error}`);
      }
      updated.push(tcopy);
    }
    setCloudTargets(session.data.config, updated);
    await persist(currentLocale === 'de' ? 'Cloud Connect gelöscht' : 'Cloud Connect deleted', { autosync: false, snapshot: false });
    if (errors.length) throw new Error(errors.join(' · '));
    closeCloudDeleteDialog();
    const syncMsg = $('#sync-msg');
    if (syncMsg) syncMsg.innerHTML = `<div class="notice success">${t('cloud_delete_done')}</div>`;
  } catch (err) {
    msg.innerHTML = `<div class="notice danger">${t('cloud_delete_failed')}: ${escapeHTML(err.message || err)}</div>`;
  }
}

function downloadJSON(value, filename) { downloadBlob(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }), filename); }
function downloadBlob(blob, filename) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }

function drawCharts() {
  if (!session.unlocked || !session.data || session.route !== 'overview' || document.hidden) return;
  const summary = computeSummary(session.data);
  drawAllocation($('#allocation-chart'), summary.items);
  drawTimeline($('#timeline-chart'), session.data, scopedTransactions(session.data));
}

function setupCanvas(canvas) {
  if (!canvas || !canvas.isConnected) return null;
  const rect = canvas.getBoundingClientRect();
  const width = Math.floor(rect.width);
  const logicalHeight = Math.max(1, Number(canvas.dataset.chartHeight || canvas.getAttribute('height') || 260));
  if (width <= 1) return null;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.dataset.chartHeight = String(logicalHeight);
  canvas.style.height = `${logicalHeight}px`;
  const targetWidth = Math.max(1, Math.floor(width * dpr));
  const targetHeight = Math.max(1, Math.floor(logicalHeight * dpr));
  if (canvas.width !== targetWidth) canvas.width = targetWidth;
  if (canvas.height !== targetHeight) canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, targetWidth, targetHeight);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: width, h: logicalHeight };
}

function drawAllocation(canvas, items) {
  const setup = setupCanvas(canvas); if (!setup) return;
  const { ctx, w, h } = setup;
  const cx = w * .34, cy = h * .52, r = Math.min(w, h) * .34;
  const total = items.reduce((s, i) => s + Math.max(0, i.value), 0);
  if (!total) { drawEmptyChart(ctx, w, h, 'Keine Werte'); return; }
  let start = -Math.PI / 2;
  items.slice(0, 8).forEach((item, i) => {
    const angle = (Math.max(0, item.value) / total) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, start, start + angle); ctx.closePath(); ctx.fillStyle = COLOR_SET[i % COLOR_SET.length]; ctx.fill();
    start += angle;
  });
  ctx.globalCompositeOperation = 'destination-out'; ctx.beginPath(); ctx.arc(cx, cy, r * .58, 0, Math.PI*2); ctx.fill(); ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#e7edf7'; ctx.font = '800 18px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(fmtMoney(total, session.data.config.base_currency), cx, cy);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  items.slice(0, 6).forEach((item, i) => {
    const y = 42 + i * 30, x = w * .62;
    ctx.fillStyle = COLOR_SET[i % COLOR_SET.length]; ctx.fillRect(x, y - 10, 14, 14);
    ctx.fillStyle = '#dbe5f5'; ctx.font = '700 13px Inter, sans-serif'; ctx.fillText(item.symbol, x + 22, y);
    ctx.fillStyle = '#97a4ba'; ctx.font = '12px Inter, sans-serif'; ctx.fillText(`${Math.round((item.value/total)*100)}%`, x + 78, y);
  });
}

function drawTimeline(canvas, data, transactions) {
  const setup = setupCanvas(canvas); if (!setup) return;
  const { ctx, w, h } = setup;
  const points = buildTimeline(data, transactions);
  if (points.length < 2) { drawEmptyChart(ctx, w, h, t('not_enough_data')); return; }
  const pad = 28;
  const max = Math.max(...points.map(p => p.value), 1);
  const minTime = points[0].time, maxTime = points[points.length - 1].time;
  ctx.strokeStyle = 'rgba(148,163,184,.24)'; ctx.lineWidth = 1;
  for (let i=0;i<4;i++){ const y = pad + i*(h-pad*2)/3; ctx.beginPath(); ctx.moveTo(pad,y); ctx.lineTo(w-pad,y); ctx.stroke(); }
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = pad + ((p.time - minTime) / Math.max(1, maxTime - minTime)) * (w - pad*2);
    const y = h - pad - (p.value / max) * (h - pad*2);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#69b7ff'; ctx.lineWidth = 3; ctx.stroke();
  ctx.lineTo(w-pad, h-pad); ctx.lineTo(pad, h-pad); ctx.closePath(); ctx.fillStyle = 'rgba(105,183,255,.10)'; ctx.fill();
  ctx.fillStyle = '#97a4ba'; ctx.font = '12px Inter, sans-serif'; ctx.fillText(fmtMoney(max, data.config.base_currency), pad, 18);
}

function timelineUnitPrice(data, tx, asset, date) {
  const base = data.config.base_currency || 'EUR';
  const exact = tx ? txUnitPriceInCurrency(tx, base, false) : null;
  if (Number.isFinite(Number(exact)) && Number(exact) > 0) return Number(exact);
  const cached = priceCacheLookup(data, asset, base, date);
  if (Number.isFinite(Number(cached)) && Number(cached) > 0) return Number(cached);
  const fallback = currentPrice(data, asset, scopedTransactions(data));
  return Number.isFinite(Number(fallback)) && Number(fallback) > 0 ? Number(fallback) : 0;
}

function buildTimeline(data, transactions) {
  const sorted = [...(transactions || [])].map(normalizeTx).filter(Boolean).sort((a,b) => new Date(a.timestamp)-new Date(b.timestamp) || a.sequence - b.sequence || a.id - b.id);
  const balances = new Map();
  const prices = new Map();
  const points = [];
  for (const tx of sorted) {
    const time = new Date(tx.timestamp).getTime();
    if (!Number.isFinite(time)) continue;
    const asset = tx.asset_symbol;
    const date = String(tx.timestamp || nowISO()).slice(0, 10);
    if (!tx.ignored && !NEUTRAL_TYPES.has(tx.tx_type)) {
      const sign = txSign(tx.tx_type);
      if (sign !== 0) {
        const nextAmount = Math.max(0, (balances.get(asset) || 0) + sign * Math.abs(Number(tx.amount || 0)));
        balances.set(asset, nextAmount);
        const price = timelineUnitPrice(data, tx, asset, date);
        if (price > 0) prices.set(asset, price);
      }
    }
    let value = 0;
    for (const [symbol, amount] of balances.entries()) {
      if (amount <= 1e-12) continue;
      const price = prices.get(symbol) || timelineUnitPrice(data, null, symbol, date);
      value += amount * price;
    }
    points.push({ time, value: Math.max(0, value) });
  }
  return points;
}

function drawEmptyChart(ctx, w, h, text) { ctx.fillStyle = '#97a4ba'; ctx.font = '700 15px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(text, w/2, h/2); ctx.textAlign = 'left'; }

window.addEventListener('resize', () => requestAnimationFrame(drawCharts));
bindSessionActivityTracking();
await initVaultStore();
await loadAppInfo();
await restoreUnlockSession();
render();
