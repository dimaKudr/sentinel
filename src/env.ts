/**
 * Runtime secrets bound to the Worker via `wrangler secret put`.
 * Never given real values in source -- see README.md for setup.
 */
export interface Env {
  /** Full contents of the downloaded Google service-account JSON key file. */
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  /** Shared secret required (via the `X-Run-Secret` header) to hit the manual `/run` route. */
  RUN_SECRET: string;
  /** KV namespace storing the last-published PV per ticker -- see src/state.ts. */
  SENTINEL_STATE: KVNamespace;
}
