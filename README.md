# Sentinel

A Cloudflare Worker that reads a Google Sheet watch-list from Google
Drive (found **by file name**, not file ID, since the source file is
deleted and recreated weekly), filters rows where `Target > PV $` and
`WallSt > PV $`, groups the matches by their `Watchlist` column value
(`Core`, `Opportunities`, `Speculative`, or the catch-all `Other` for
anything blank/unrecognized), formats each group as its own table, and
posts them all in a single Telegram message.

It runs hourly via a Cloudflare Cron Trigger but self-gates to a local
time window (Mon-Fri, 16:00-21:00 Europe/Prague by default) computed at
runtime from the current wall-clock time, so it stays correct across
daylight-saving changeovers without ever needing the cron schedule
edited. A manual `GET/POST /run` HTTP route runs the same job on
demand, independent of the cron, for testing.

## How it works

```
Cron (hourly, every day)
  -> isWithinRunWindow()          [Europe/Prague local time check]
       -> runJob()
            -> getGoogleAccessToken()       [service-account JWT -> OAuth token]
            -> findFileIdByName()           [Drive files.list, newest match by name]
            -> getSheetValues()             [Sheets values.get for the configured tab]
            -> filterRows()                 [Target > PV $ and WallSt > PV $, tagged with Watchlist group]
            -> groupMatchesByWatchlist()    [buckets into Core/Opportunities/Speculative/Other]
            -> decideGroupsToPublish()      [per-group 1%-change suppression, Core/Opportunities/Speculative only]
            -> formatTelegramMessage()      [one HTML message, one <pre> table per shown group]
            -> sendTelegram()               [Telegram Bot API sendMessage -- skipped if nothing to show]
```

Config (spreadsheet name, tab name, header row, column names including
`WATCHLIST_COL`, and the run window) lives in `src/config.ts`.

Each run's Telegram message stacks up to 4 tables, always in the order
**Core -> Opportunities -> Speculative -> Other**:

- The 3 canonical groups (`Core`, `Opportunities`, `Speculative`) each
  get their own independent 1%-PV-change/new-ticker/first-publish-of-day
  suppression (see `src/state.ts`) -- one group changing doesn't affect
  another's suppression state. An empty group is silently omitted.
- `Other` catches any row whose `Watchlist` cell doesn't match one of
  the 3 canonical names (blank, typo, etc.) and is **always shown when
  non-empty**, regardless of whether anything changed -- it's meant to
  surface a likely data-entry problem, not to be suppressed.
- If nothing across all 4 groups is worth showing, no Telegram message
  is sent at all for that run.

## Source layout

- `src/config.ts` -- editable config surface (file/tab names, columns, run window)
- `src/env.ts` -- typed `Env` interface for the four runtime secrets
- `src/schedule.ts` -- DST-safe `isWithinRunWindow` check
- `src/google-auth.ts` -- service-account JWT signing + OAuth2 token exchange
- `src/drive.ts` -- Drive `files.list` lookup by name
- `src/sheets.ts` -- Sheets `values.get`, number parsing, row filtering, Watchlist grouping
- `src/telegram.ts` -- HTML table formatting (per group) + Telegram `sendMessage`
- `src/index.ts` -- Worker entry points (`scheduled`, `fetch`)

## One-time external setup

These steps happen outside this repo; the resulting values become the
four Cloudflare secrets below. Nothing here should ever be committed
to source control.

### 1. Google Cloud service account

1. Create (or reuse) a GCP project, then enable the **Google Drive
   API** and **Google Sheets API** for it.
2. Create a service account, then generate and download a JSON key for
   it (IAM & Admin -> Service Accounts -> Keys -> Add Key -> JSON).
3. In Google Drive, share the folder or file containing the watch-list
   spreadsheet with the service account's `client_email` (found in the
   downloaded JSON) as **Viewer**.
4. The full contents of the downloaded JSON file become the
   `GOOGLE_SERVICE_ACCOUNT_JSON` secret.

### 2. Telegram bot + channel

1. Talk to [`@BotFather`](https://t.me/BotFather) on Telegram, run
   `/newbot`, and follow the prompts. You'll get a bot token -- this
   becomes `TELEGRAM_BOT_TOKEN`.
2. Create (or reuse) a Telegram channel, then add the bot as an admin
   with permission to post messages.
3. Post any message to the channel, then call
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser to
   find the channel's `chat.id` (channel IDs are usually negative,
   e.g. `-1001234567890`). This becomes `TELEGRAM_CHAT_ID`.

### 3. Run secret

Generate a random value yourself (no external service involved), e.g.:

```sh
openssl rand -hex 32
```

This becomes `RUN_SECRET`, the shared secret required to hit the
manual `/run` route.

### 4. Cloudflare account

You'll need `wrangler` authenticated against your Cloudflare account:

```sh
npx wrangler login
```

Then set each secret (you'll be prompted to paste the value; nothing
is written to the repo):

```sh
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put RUN_SECRET
```

`RUN_SECRET` is a shared secret you generate yourself (e.g. `openssl rand
-hex 32`) -- it authenticates requests to the manual `/run` route so that
anyone who finds the deployed `*.workers.dev` URL can't trigger a real
Telegram send and burn Google/Telegram API quota.

The Worker also needs a `SENTINEL_STATE` KV namespace binding (see
`wrangler.jsonc`), used to remember each ticker's last-published PV, per
`Watchlist` group (`Core`/`Opportunities`/`Speculative`), so same-day
re-alerts can be suppressed independently per group when nothing in that
group moved more than 1% -- see `src/state.ts`. The catch-all `Other`
group has no stored state since it's never suppressed. Create the KV
namespace once with:

```sh
npx wrangler kv namespace create SENTINEL_STATE
```

and add the printed `id` to the `kv_namespaces` entry in `wrangler.jsonc`.

## Local development

Copy `.dev.vars.example` to `.dev.vars` and fill in real values (this
file is gitignored and never committed):

```sh
cp .dev.vars.example .dev.vars
```

Install dependencies and start a local dev server:

```sh
npm install
npm run dev
```

Then hit the manual trigger route to run the job immediately and
verify a message arrives in Telegram, passing the `RUN_SECRET` from
`.dev.vars` as the `X-Run-Secret` header:

```sh
curl -H "X-Run-Secret: $RUN_SECRET" http://localhost:8787/run
```

## Testing

```sh
npm run typecheck
npm test
```

Unit tests (Vitest, via `@cloudflare/vitest-pool-workers`) cover the
run-window boundary logic, number parsing, row filtering and Watchlist
grouping (including the missing-column error, header-row offset, and
case/whitespace-tolerant group matching), per-group publish suppression
independence, multi-table Telegram message formatting/ordering, and
end-to-end `runJob` scenarios (mixed per-group changes, all-quiet/no-send,
forced runs, and `Other`-only runs). All outbound `fetch` calls to
Google/Telegram are mocked -- no live network calls or real secrets are
used in tests.

## Deployment

Deployment is manual only -- there is no CI/CD workflow in this repo.
Once secrets are set (see above):

```sh
npm run deploy
```

This deploys the Worker and registers the hourly cron trigger defined
in `wrangler.jsonc`. After deploying, hit `/run` on the deployed Worker
URL once, passing the `RUN_SECRET` you set with `wrangler secret put`,
to confirm everything is wired correctly end-to-end before trusting
the schedule:

```sh
curl -H "X-Run-Secret: $RUN_SECRET" https://sentinel.<your-subdomain>.workers.dev/run
```

Add `?force=true` to publish every non-empty canonical group (`Core`,
`Opportunities`, `Speculative`) plus `Other` (if present), bypassing the
per-group PV-unchanged suppression (see `src/state.ts`):

```sh
curl -H "X-Run-Secret: $RUN_SECRET" "https://sentinel.<your-subdomain>.workers.dev/run?force=true"
```

## Manual testing checklist

- [ ] Hit `/run` manually and confirm a Telegram message arrives with
      one table per group that has matches, in the order Core ->
      Opportunities -> Speculative -> Other
- [ ] Temporarily rename the Drive file, confirm the job still finds
      it by name
- [ ] Point the config at a wrong header name (including
      `WATCHLIST_COL`), confirm the error message lists the actual
      headers found
- [ ] Confirm a fully-quiet run (all 4 groups empty or suppressed)
      sends no Telegram message at all, rather than a "no matches"
      notice
- [ ] Give a row a blank or mistyped `Watchlist` value and confirm it
      always appears under `Other`, even on a run where nothing else
      changed
- [ ] Confirm a PV move past 1% in one canonical group shows only that
      group's table, leaving unrelated groups suppressed
- [ ] Hit `/run?force=true` and confirm every non-empty canonical group
      plus `Other` (if present) is shown, regardless of suppression
- [ ] Confirm the hourly cron does nothing outside the configured
      window (check the Cloudflare dashboard invocation logs)
- [ ] Verify number parsing against currency-formatted cells (e.g.
      `$123.45`, `1,234.56`)
