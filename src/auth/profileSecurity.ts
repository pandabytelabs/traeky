import { encryptJsonWithPassphrase, decryptJsonWithPassphrase, type EncryptedPayload } from "../crypto/cryptoService";

const ENV_SALT =
  (import.meta.env.VITE_PROFILE_PIN_SALT as string | undefined) ??
  (import.meta.env.TRAEKY_PROFILE_PIN_SALT as string | undefined) ??
  "";

function getPinSalt(): string {
  if (ENV_SALT && typeof ENV_SALT === "string") {
    return ENV_SALT;
  }
  // Fallback salt to avoid storing the PIN in cleartext even if no env var is configured.
  return "traeky-profile-pin-default-salt";
}

function getWebCrypto(): Crypto {
  if (typeof window !== "undefined" && window.crypto) {
    return window.crypto;
  }
  throw new Error("Web Crypto API is not available in this environment.");
}

function toHex(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    const b = view[i].toString(16).padStart(2, "0");
    hex += b;
  }
  return hex;
}

export async function hashPin(pin: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = getPinSalt();
  const data = encoder.encode(`${salt}:${pin}`);
  const digest = await getWebCrypto().subtle.digest("SHA-256", data);
  return toHex(digest);
}

export async function encryptProfilePayload<T>(pinHash: string, payload: T): Promise<EncryptedPayload> {
  return encryptJsonWithPassphrase(pinHash, payload);
}

export async function decryptProfilePayload<T>(pinHash: string, encrypted: EncryptedPayload): Promise<T> {
  return decryptJsonWithPassphrase<T>(pinHash, encrypted);
}
