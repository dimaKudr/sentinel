import type { Env } from "./env";
import type { WatchListMatch } from "./sheets";
import { TIME_ZONE } from "./config";

interface TelegramSendMessageResponse {
  ok: boolean;
  description?: string;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Formats matches as a monospace HTML `<pre>` table for `parse_mode: "HTML"`. */
export function formatTelegramMessage(matches: WatchListMatch[], now: Date = new Date()): string {
  const timestamp = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(now);

  const heading = `\u{1F4CA} <b>Watch-List Alert</b> (${timestamp})`;

  if (matches.length === 0) {
    return `${heading}\nNo stocks currently have Target &gt; PV $.`;
  }

  const sorted = [...matches].sort((a, b) => {
    const upsideA = (a.target - a.pv) / a.pv;
    const upsideB = (b.target - b.pv) / b.pv;
    return upsideB - upsideA;
  });

  const header = "Ticker    PV $      Target    Upside%";
  const separator = "------------------------------------";
  const lines = sorted.map((m) => {
    const upside = ((m.target - m.pv) / m.pv) * 100;
    return `${String(m.ticker).padEnd(9)} ${m.pv.toFixed(2).padEnd(9)} ${m.target.toFixed(2).padEnd(9)} ${upside.toFixed(1)}%`;
  });
  const table = [header, separator, ...lines].join("\n");

  return `${heading}\n<pre>${escapeHtml(table)}</pre>`;
}

/** Posts a message to the configured Telegram chat via the Bot API. */
export async function sendTelegram(env: Env, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
    }),
  });
  const data = (await resp.json()) as TelegramSendMessageResponse;

  if (!data.ok) {
    throw new Error(`Telegram send failed: ${JSON.stringify(data)}`);
  }
}
