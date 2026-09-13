## Implementation Plan: Split Telegram Report into Per-Watchlist Tables

### Research Summary

Sentinel is a small Cloudflare Worker (`src/*.ts`, Vitest tests in `test/*.ts`)
that runs hourly inside a Europe/Prague time window:

```
Cron -> isWithinRunWindow() -> runJob()
  -> getGoogleAccessToken()        [src/google-auth.ts]
  -> findFileIdByName()            [src/drive.ts]
  -> getSheetValues()               [src/sheets.ts]
  -> filterRows()                   [src/sheets.ts]  -> WatchListMatch[]
  -> shouldPublish()/recordPublished() [src/state.ts] -> gate on KV state
  -> formatTelegramMessage()        [src/telegram.ts]
  -> sendTelegram()                 [src/telegram.ts]
```

Key existing pieces and how this feature touches each:

- **`src/sheets.ts`**: `filterRows()` resolves columns by header name
  (case-insensitive, trimmed), applies `Target > PV $` and `WallSt > PV $`,
  and returns a flat `WatchListMatch[]` (`{ ticker, target, pv }`). It throws
  if a configured column isn't found. This is where the new `Watchlist`
  column gets read and each match gets tagged with its group.
- **`src/config.ts`**: `SentinelConfig` holds column names as strings
  (`TICKER_COL`, `TARGET_COL`, `PV_COL`, `WALLST_COL`). This is where the new
  `WATCHLIST_COL` and the canonical group name list belong.
- **`src/state.ts`**: `shouldPublish()`/`recordPublished()` currently keep a
  single KV record (`{ date, pv: Record<ticker, pv> }`) and make one
  all-or-nothing publish decision for the whole list. This becomes
  per-group: one record and one decision per watchlist group.
- **`src/telegram.ts`**: `formatTelegramMessage()` currently renders one
  heading + one `<pre>` table (or a "no matches" line) for the whole
  `WatchListMatch[]`. This becomes: one heading, followed by one
  sub-heading + `<pre>` table per *shown* group, in a fixed order.
- **`src/index.ts`**: `runJob()` wires all of the above together and also
  implements `force=true` (bypass suppression, still record state).

All existing behavior for the underlying comparison logic (`Target > PV $`,
`WallSt > PV $`, currency parsing, upside-% sort, HTML escaping, DST-safe run
window, Drive-by-name lookup, force override) stays as-is per the user's
request — only routing/grouping, the publish decision, and the message
layout change.

### Decisions Locked In (from clarifying Q&A)

1. **Column**: sheet has a `Watchlist` header (matched case-insensitively/
   trimmed, like the other columns) with exact values `Core`,
   `Opportunities`, `Speculative`.
2. **Unknown/blank bucket**: any row whose `Watchlist` value isn't exactly
   one of the three canonical names (including blank/typo'd) goes into a 4th
   catch-all group, e.g. internally named `Other`.
3. **Per-group significance**: reuse the existing 1% PV-change threshold,
   but evaluate and store it independently per group (Core, Opportunities,
   Speculative, Other) — separate KV state per group, separate publish
   decision per group.
4. **Empty group behavior**: a group with zero current matches is *silently
   omitted* from the message, whether or not it just became empty (no
   "cleared" notice, unlike today's global "no matches" message). No state
   write is needed for an empty group either (there's nothing to anchor).
5. **Other/catch-all exception**: unlike the 3 canonical groups, `Other` is
   **always shown when it has any rows**, regardless of whether its
   contents changed — it's meant to surface a likely data-entry problem
   (missing/mistyped `Watchlist` value), not to be suppressed.
6. **All-quiet case**: if no group has anything to show (all suppressed or
   all empty), send nothing — same spirit as today, just decided per group
   first.
7. **Message layout**: still a single `sendTelegram()` call; each shown
   group renders as its own sub-heading + `<pre>` table, stacked in fixed
   order **Core → Opportunities → Speculative → Other**, under one overall
   heading/timestamp.
8. **Force override**: `/run?force=true` stays global — it bypasses
   suppression for all 3 canonical groups (making every non-empty canonical
   group show) and re-anchors state for all of them. `Other` is unaffected
   by force since it's never suppressed anyway.
9. **Filters**: no change to the `Target > PV $` / `WallSt > PV $` filter
   logic itself — the only filter-side change is resolving the new
   `Watchlist` column and tagging each match with its group.

### Scope & Affected Areas

- `src/config.ts` — add `WATCHLIST_COL` and canonical group name constants.
- `src/sheets.ts` — `WatchListMatch` gains a `watchlist` field (or a
  computed `group`); `filterRows()` resolves the new column and tags each
  match; a new grouping helper (e.g. `groupMatchesByWatchlist()`).
- `src/state.ts` — restructure KV state to be keyed per group; new/changed
  function signatures for `shouldPublish`/`recordPublished` operating on a
  map of group → matches, returning per-group show/hide decisions.
- `src/telegram.ts` — `formatTelegramMessage()` takes a per-group structure
  (only the groups to actually render) and stacks multiple sub-tables in one
  message; "no matches" case becomes "nothing to report" only when literally
  every group is omitted.
- `src/index.ts` — `runJob()` updated to: filter+group matches, ask
  state module which groups are significant, build the render set (adding
  `Other` unconditionally if non-empty), skip sending if the render set is
  empty, and send one message otherwise. `force=true` path updated for the
  per-group re-anchoring.
- `test/sheets.test.ts`, `test/state.test.ts`, `test/telegram.test.ts`,
  `test/index.test.ts` — updated/new coverage for grouping, per-group
  suppression, multi-table rendering, and the end-to-end job.
- `README.md` — update the pipeline diagram, config section, and manual
  testing checklist to describe the 4-table behavior.
- **External**: the Watch-List Google Sheet needs the `Watchlist` column
  populated for all rows (already done by the user per the request).

### Implementation Phases

- **Phase 1: Config & data model** (Complexity: Low)
  - Objective: Introduce the `Watchlist` column and canonical group names
    into config/types without changing behavior yet.
  - Key Tasks:
    - Add `WATCHLIST_COL: "Watchlist"` to `SentinelConfig` / `CONFIG`.
    - Define a `WatchlistGroup` union type: `"Core" | "Opportunities" |
      "Speculative" | "Other"`, plus an ordered array `GROUP_ORDER` for
      fixed rendering order.
    - Extend `WatchListMatch` with `group: WatchlistGroup`.
  - Testing approach: type-check only; no runtime logic yet.
  - Success Criteria: project builds; no behavior change.
  - Dependencies: none.

- **Phase 2: Grouping in `filterRows`** (Complexity: Medium)
  - Objective: Resolve the `Watchlist` column and tag every match with its
    group, bucketing unrecognized/blank values into `"Other"`.
  - Key Tasks:
    - Add `watchlistIdx` resolution alongside the existing column lookups;
      **do not** throw if the column is missing from config validation the
      same way as required columns — decide: the column itself must exist
      (throw if `Watchlist` header is absent, consistent with existing
      "configured column not found" behavior), but individual *cell values*
      that don't match a canonical name fall back to `"Other"` rather than
      throwing.
    - Normalize the cell value the same way headers are normalized (trim,
      but preserve case for exact match against `Core`/`Opportunities`/
      `Speculative`) — decide exact-match casing rules explicitly (see Edge
      Cases).
    - Add `group` to each pushed `WatchListMatch`.
  - Testing approach: unit tests in `test/sheets.test.ts` — one match per
    canonical group, a blank cell, a typo'd cell, and a missing-column error
    case.
  - Success Criteria: `filterRows()` returns correctly tagged matches for a
    fixture sheet covering all 4 buckets.
  - Dependencies: Phase 1.

- **Phase 3: Per-group state & publish decisions** (Complexity: High)
  - Objective: Replace the single global KV record with one per group, and
    make an independent significance decision per canonical group.
  - Key Tasks:
    - Redesign `StoredState`: either one KV key per group
      (`last-published:core`, `last-published:opportunities`,
      `last-published:speculative`) or one KV key holding a
      `Record<WatchlistGroup, GroupState>` blob (simpler: one `get`/`put`,
      atomic-ish within a single run). Recommend the single-blob approach
      to avoid partial-write races across multiple KV keys.
    - New function shape, e.g.:
      `decideGroupsToPublish(kv, matchesByGroup, now) -> { toShow: WatchlistGroup[], toPersist: Partial<Record<...>> }`
      reusing the existing 1%-threshold/new-ticker/first-publish-of-day logic
      **per group**, applied only to the 3 canonical groups (`Other` is
      handled separately in Phase 4/5 and never gates on this).
    - Preserve existing semantics per group: first publish of the day for
      *that group* always shows it; a brand-new ticker in that group always
      shows it; empty group is omitted and does not write state (per
      decision #4).
    - Keep `recordPublished`-equivalent for the forced path: force
      re-anchors all 3 canonical groups' state to current values and marks
      them all as "to show" (if non-empty).
  - Testing approach: port every existing `state.test.ts` case to operate
    per-group (e.g. "Core republish suppressed under 1%, Opportunities still
    publishes because it moved") plus new cross-group independence tests
    (one group's change doesn't affect another's suppression/state).
  - Success Criteria: for a run with mixed per-group changes, only the
    changed groups are marked to show, and only their KV state advances;
    unaffected groups' stored state and decision are untouched.
  - Dependencies: Phase 2.

- **Phase 4: Multi-table Telegram rendering** (Complexity: Medium)
  - Objective: Render one message with a `<pre>` table per group that is in
    the render set, in fixed order, reusing the existing per-row formatting.
  - Key Tasks:
    - Change `formatTelegramMessage()` signature to accept something like
      `Array<{ group: WatchlistGroup; matches: WatchListMatch[] }>` — already
      filtered down to exactly what should render (state decisions +
      always-include-`Other`-if-non-empty happen in `index.ts`, not here).
    - Keep the existing per-row line format, sort-by-upside-desc, and
      HTML-escaping logic unchanged, just applied once per group section.
    - Add a group sub-heading per table (e.g. `<b>Core</b>`), stacked with
      blank-line separation between groups.
    - "Nothing to report" message (equivalent of today's zero-matches copy)
      only fires when the caller passes an empty array of sections.
  - Testing approach: unit tests in `test/telegram.test.ts` — one group only,
    multiple groups stacked (order preserved), zero-sections case, HTML
    escaping still applied within each section.
  - Success Criteria: multi-group message renders with correct order,
    headings, and per-row content; existing single-group formatting tests
    adapted and passing.
  - Dependencies: Phase 1 (types only — can be built in parallel with Phase 3).

- **Phase 5: Wire up `runJob` end-to-end** (Complexity: Medium)
  - Objective: Combine grouping, per-group state decisions, and the
    always-show-`Other`-if-non-empty rule into the final render set, and
    skip sending entirely when it's empty.
  - Key Tasks:
    - In `runJob()`: `filterRows()` → group matches by `group` →
      `decideGroupsToPublish()` for the 3 canonical groups → build render set
      = (canonical groups marked "to show", each with its current matches)
      + (`Other` group if it has any current matches, unconditionally).
    - If render set is empty, return without calling `sendTelegram`
      (mirrors current behavior for a global no-op, just recomputed per
      group).
    - Force path (`force=true`): render set = all 4 groups that currently
      have any matches; persist/re-anchor state for the 3 canonical groups
      (same as today's `recordPublished`, now per group).
  - Testing approach: extend `test/index.test.ts` (or add integration-style
    tests) covering: only-Core-changed run, all-quiet run (no send), forced
    run showing everything non-empty, and an Other-only run (data-entry
    typo case) sending even though nothing "changed".
  - Success Criteria: end-to-end behavior matches all 9 locked-in decisions
    above, verified by tests hitting `runJob` (or the composed functions it
    calls) rather than just the unit-level pieces.
  - Dependencies: Phases 2, 3, 4.

- **Phase 6: Docs & manual verification** (Complexity: Low)
  - Objective: Bring `README.md` in line with the new behavior and manually
    verify against the real sheet/Telegram channel.
  - Key Tasks:
    - Update the pipeline diagram, config section (mention `WATCHLIST_COL`),
      and manual testing checklist in `README.md`.
    - Run `npm run typecheck && npm test`.
    - Hit `/run` against the real (or a staging) sheet and confirm the
      Telegram message renders as expected with real data across at least 2
      of the 4 buckets.
    - Hit `/run?force=true` and confirm all non-empty canonical groups show
      plus `Other` if present.
  - Testing approach: manual, per README's existing "Manual testing
    checklist" pattern — add new checklist items for per-group suppression
    and the Other bucket.
  - Success Criteria: real Telegram message matches expectations; checklist
    updated and checked off.
  - Dependencies: Phase 5.

### Edge Cases & Considerations

- **Casing/whitespace of `Watchlist` cell values**: headers are matched
  case-insensitively/trimmed elsewhere in the codebase, but the *values*
  `Core`/`Opportunities`/`Speculative` haven't been given that treatment
  anywhere yet. Recommend trimming whitespace and doing a case-insensitive
  compare against the 3 canonical names (to tolerate `"core"` or `" Core "`
  in the sheet) while still bucketing anything else into `Other`. **This
  needs an explicit decision before Phase 2** if the user wants strict exact
  match instead (typos would then correctly fall into `Other`, which is
  probably desirable — but same-case-different-spacing shouldn't be treated
  as a typo).
- **A ticker appears twice in the sheet with different groups**: shouldn't
  happen given the sheet is the source of truth per ticker, but `filterRows`
  doesn't currently dedupe by ticker at all — out of scope to add dedupe
  logic; document as a pre-existing assumption.
- **`Other` bucket state is never written**: since `Other` always shows when
  non-empty, there's no need to track its PV history at all — confirm no
  code path accidentally tries to 1%-gate it.
- **KV migration**: the existing stored key (`last-published`, single blob)
  is not forward-compatible with the new per-group shape. On first deploy
  after this change, the old key will simply be ignored (a new key/shape is
  read as absent) — every group's first run will look like "first publish of
  the day," which is correct and harmless (matches today's day-1 behavior).
  Consider whether to explicitly delete the old KV key or just let it go
  stale; recommend leaving it (no read path references it once the code
  changes) rather than adding migration code for a single stale key.
- **Force + `Other`**: force is documented as not affecting `Other` since
  `Other` isn't gated by suppression in the first place — confirm this
  doesn't cause confusion in the force-path implementation (i.e. don't
  accidentally require `Other` to be in the "toShow" list produced by the
  state module).
- **All 4 groups empty (zero matches sheet-wide)**: falls out naturally as
  "render set empty → send nothing," a change from today's behavior where
  zero total matches *always* sends a "no stocks" message. This is an
  intentional consequence of decision #4/#6 — confirm this is acceptable
  (today's "the list went clear" signal is lost). Flagged as a decision
  point below since it wasn't asked explicitly.
- **Long messages / Telegram limits**: stacking up to 4 tables in one
  message increases length; Telegram's message limit is 4096 UTF-16 code
  units for text messages. Unlikely to be hit given typical watch-list
  sizes, but worth a sanity check with the real sheet's current row counts
  during Phase 6 manual verification.

### Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Per-group KV state redesign introduces a subtle suppression bug (e.g. one group's write clobbers another's) | High | Medium | Use a single KV blob keyed by group (one atomic `get`/`put` per run) instead of separate keys per group; port every existing `state.test.ts` case per group plus new cross-group isolation tests |
| Value-matching for `Watchlist` cells (case/whitespace) misclassifies real rows into `Other`, causing noisy always-shown tables | Medium | Medium | Decide and document exact normalization rule in Phase 2 before writing code; add explicit test fixtures for trimmed/mis-cased values |
| Losing the "list went fully clear" signal (no message when all 4 groups are empty) surprises the user later | Low | Low | Explicitly flagged as a decision point (see below) so the user can confirm before Phase 5 ships |
| Telegram message length grows past comfortable limits with 4 stacked tables on a big watch-list | Low | Low | Manual check against real sheet size in Phase 6; if needed later, split into multiple `sendTelegram` calls (already compatible with the per-group data structure) |
| README/manual checklist drifts from actual behavior after the change | Low | Medium | Fold README updates into Phase 6 as a required step, not an afterthought |

### Decision Points

1. **Watchlist value normalization** — RESOLVED: case-insensitive + trimmed
   match against `Core`/`Opportunities`/`Speculative`. Anything else
   (including blank) buckets into `Other`.
2. **All-4-groups-empty behavior** — RESOLVED: accepted as-is. Unlike today,
   a fully-clear watch-list sends nothing (no explicit "no stocks"/"nothing
   to report" message). No fallback message needed.
3. **KV state shape**: single blob (`Record<group, GroupState>`) vs. one KV
   key per group. Plan recommends the single-blob approach for atomicity;
   confirm before Phase 3.

### Verification Strategy

- `npm run typecheck` and `npm test` after each phase, not just at the end.
- Unit tests updated/added per phase as described above, covering: grouping
  correctness (Phase 2), per-group suppression independence (Phase 3),
  multi-table rendering and ordering (Phase 4), and full `runJob` scenarios —
  mixed changes, all-quiet, forced, Other-only (Phase 5).
- Manual end-to-end check against the real Watch-List sheet and Telegram
  channel (Phase 6), using both `/run` and `/run?force=true`, confirming:
  - Only groups with real changes appear on a normal run.
  - `Other` appears whenever any row has a blank/unrecognized `Watchlist`
    value, even with no PV movement.
  - Table order is always Core → Opportunities → Speculative → Other.
  - A fully-quiet run sends nothing (per decision #6).
