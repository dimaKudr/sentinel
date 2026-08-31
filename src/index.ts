/**
 * Sentinel -- Watch-List -> Telegram alert worker
 *
 * Reads a Google Sheet (by FILE NAME, not file ID, since the source file
 * gets deleted/recreated weekly), finds rows where Target < PV $, and
 * posts a formatted table to a Telegram channel.
 *
 * Runs every hour (cron), but only actually does work when the current
 * time in Europe/Prague falls inside RUN_WINDOW on a weekday. This makes
 * the schedule immune to daylight-saving changeovers -- no need to touch
 * the cron expression twice a year.
 */
import { CONFIG } from "./config";
import type { Env } from "./env";
import { isWithinRunWindow } from "./schedule";
import { getGoogleAccessToken } from "./google-auth";
import { findFileIdByName } from "./drive";
import { getSheetValues, filterRows } from "./sheets";
import { formatTelegramMessage, sendTelegram } from "./telegram";

async function runJob(env: Env): Promise<void> {
  const token = await getGoogleAccessToken(env);
  const fileId = await findFileIdByName(token, CONFIG.FILE_NAME);
  const rows = await getSheetValues(token, fileId, CONFIG.SHEET_TAB);
  const matches = filterRows(rows, CONFIG);
  const message = formatTelegramMessage(matches);
  await sendTelegram(env, message);
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!isWithinRunWindow()) return;
    ctx.waitUntil(runJob(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      try {
        await runJob(env);
        return new Response("OK - job ran, check Telegram.\n");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(`ERROR: ${message}\n`, { status: 500 });
      }
    }
    return new Response("Watch-List Telegram worker.\nGET/POST /run to trigger manually.\n");
  },
} satisfies ExportedHandler<Env>;
