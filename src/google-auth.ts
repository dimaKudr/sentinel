import type { Env } from "./env";

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
].join(" ");
const JWT_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlEncodeJson(obj: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

function pemToBinaryKey(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/** Builds the unsigned `<header>.<claimSet>` portion of a service-account JWT. */
export function buildUnsignedJwt(key: ServiceAccountKey, now: number): string {
  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: key.client_email,
    scope: SCOPES,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  return `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(claimSet)}`;
}

async function signJwt(env: Env): Promise<string> {
  const key: ServiceAccountKey = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = buildUnsignedJwt(key, now);

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToBinaryKey(key.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsigned)
  );

  return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Exchanges the service account's JSON key for a short-lived OAuth2 access
 * token via the JWT-bearer grant. Uses a service account (not the OAuth
 * user flow) because this Worker runs unattended with no human to click
 * "allow".
 */
export async function getGoogleAccessToken(env: Env): Promise<string> {
  const jwt = await signJwt(env);

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent(JWT_GRANT_TYPE)}&assertion=${encodeURIComponent(jwt)}`,
  });
  const data = (await resp.json()) as GoogleTokenResponse;

  if (!data.access_token) {
    throw new Error(`Google auth failed: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}
