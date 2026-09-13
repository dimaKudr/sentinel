/**
 * Sentinel -- Watch-List -> Telegram alert worker
 *
 * Reads a Google Sheet (by FILE NAME, not file ID, since the source file
 * gets deleted/recreated weekly), finds rows where Target > PV $, and
 * posts a formatted table to a Telegram channel.
 *
 * Runs every hour (cron), but only actually does work when the current
 * time in Europe/Prague falls inside RUN_WINDOW on a weekday. This makes
 * the schedule immune to daylight-saving changeovers -- no need to touch
 * the cron expression twice a year.
 */
import { CANONICAL_WATCHLIST_GROUPS, CONFIG, GROUP_ORDER } from "./config";
import type { Env } from "./env";
import { isWithinRunWindow } from "./schedule";
import { getGoogleAccessToken } from "./google-auth";
import { findFileIdByName } from "./drive";
import { getSheetValues, filterRows, groupMatchesByWatchlist } from "./sheets";
import type { WatchlistGroupSection } from "./telegram";
import { formatTelegramMessage, sendTelegram } from "./telegram";
import { decideGroupsToPublish, recordGroupsPublished } from "./state";

/**
 * Guards the manual `/run` route behind the `RUN_SECRET` shared secret,
 * sent by the caller via the `X-Run-Secret` header. Fails closed: if
 * `env.RUN_SECRET` is unset or empty, the route is treated as inaccessible
 * rather than open.
 */
function isAuthorizedRunRequest(request: Request, env: Env): boolean {
  if (!env.RUN_SECRET) return false;
  return request.headers.get("X-Run-Secret") === env.RUN_SECRET;
}

/**
 * Builds the final render set: the 3 canonical groups marked "to show" by
 * the state module, plus `Other` unconditionally whenever it has any
 * current matches (it's never gated by suppression -- see src/state.ts).
 * Order follows `GROUP_ORDER` (Core -> Opportunities -> Speculative ->
 * Other) regardless of the order `groupsToShow` was computed in.
 */
function buildRenderSet(
  matchesByGroup: ReturnType<typeof groupMatchesByWatchlist>,
  groupsToShow: readonly string[]
): WatchlistGroupSection[] {
  const toShow = new Set<string>(groupsToShow);
  const sections: WatchlistGroupSection[] = [];
  for (const group of GROUP_ORDER) {
    const matches = matchesByGroup[group];
    if (matches.length === 0) continue;
    if (group !== "Other" && !toShow.has(group)) continue;
    sections.push({ group, matches });
  }
  return sections;
}

async function runJob(env: Env, options: { force?: boolean } = {}): Promise<void> {
  const token = await getGoogleAccessToken(env);
  const fileId = await findFileIdByName(token, CONFIG.FILE_NAME);
  const rows = await getSheetValues(token, fileId, CONFIG.SHEET_TAB);
  const matches = filterRows(rows, CONFIG);
  const matchesByGroup = groupMatchesByWatchlist(matches);
  const canonicalMatches = Object.fromEntries(
    CANONICAL_WATCHLIST_GROUPS.map((g) => [g, matchesByGroup[g]])
  ) as Record<(typeof CANONICAL_WATCHLIST_GROUPS)[number], typeof matches>;

  const groupsToShow = options.force
    ? await recordGroupsPublished(env.SENTINEL_STATE, canonicalMatches)
    : await decideGroupsToPublish(env.SENTINEL_STATE, canonicalMatches);

  const sections = buildRenderSet(matchesByGroup, groupsToShow);
  if (sections.length === 0) return;

  const message = formatTelegramMessage(sections);
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
      if (!isAuthorizedRunRequest(request, env)) {
        return new Response("ERROR: unauthorized\n", { status: 401 });
      }
      const force = url.searchParams.get("force") === "true";
      try {
        await runJob(env, { force });
        return new Response("OK - job ran, check Telegram.\n");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(`ERROR: ${message}\n`, { status: 500 });
      }
    }
    return new Response(
      "Watch-List Telegram worker.\nGET/POST /run to trigger manually (add ?force=true to bypass the unchanged-PV suppression).\n"
    );
  },
} satisfies ExportedHandler<Env>;
