import type { Env } from "./env";
import type { WatchListMatch } from "./sheets";
import type { WatchlistGroup } from "./config";
import { TIME_ZONE } from "./config";

interface TelegramSendMessageResponse {
  ok: boolean;
  description?: string;
}

/** One group's matches, already decided by the caller to be worth rendering. */
export interface WatchlistGroupSection {
  group: WatchlistGroup;
  matches: WatchListMatch[];
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Renders one group's matches as a `<b>` sub-heading + monospace `<pre>` table. */
function formatGroupSection(section: WatchlistGroupSection): string {
  const sorted = [...section.matches].sort((a, b) => {
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

  return `<b>${escapeHtml(section.group)}</b>\n<pre>${escapeHtml(table)}</pre>`;
}

/**
 * Formats a fixed-order list of already-decided-to-render group sections
 * into a single monospace HTML message for `parse_mode: "HTML"` -- one
 * overall heading/timestamp, then one sub-heading + `<pre>` table per
 * section, stacked in the order the caller passed them in (Core ->
 * Opportunities -> Speculative -> Other, per `GROUP_ORDER`).
 *
 * The "nothing to report" fallback only fires when `sections` is empty --
 * unlike the previous single-list behavior, an empty render set today
 * means "send nothing at all" (the caller skips calling this), but this
 * fallback stays as a safety net for direct callers.
 */
export function formatTelegramMessage(
  sections: WatchlistGroupSection[],
  now: Date = new Date()
): string {
  const timestamp = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(now);

  const heading = `\u{1F4CA} <b>Watch-List Alert</b> (${timestamp})`;

  if (sections.length === 0) {
    return `${heading}\nNo stocks currently have Target &gt; PV $.`;
  }

  const body = sections.map(formatGroupSection).join("\n\n");
  return `${heading}\n\n${body}`;
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
