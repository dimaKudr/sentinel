import { describe, expect, it } from "vitest";
import { decideGroupsToPublish, recordGroupsPublished } from "../src/state";
import type { WatchListMatch } from "../src/sheets";
import type { CanonicalWatchlistGroup } from "../src/config";

/** Minimal in-memory stand-in for the KVNamespace binding. */
function fakeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: (async (key: string, type?: string) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    }) as KVNamespace["get"],
    put: (async (key: string, value: string) => {
      store.set(key, value);
    }) as KVNamespace["put"],
  } as KVNamespace;
}

function match(ticker: string, pv: number, group: CanonicalWatchlistGroup = "Core"): WatchListMatch {
  return { ticker, pv, target: pv + 1, group };
}

/** Builds the per-canonical-group matches map `decideGroupsToPublish` expects. */
function matchesByGroup(
  overrides: Partial<Record<CanonicalWatchlistGroup, WatchListMatch[]>> = {}
): Record<CanonicalWatchlistGroup, WatchListMatch[]> {
  return {
    Core: [],
    Opportunities: [],
    Speculative: [],
    ...overrides,
  };
}

describe("decideGroupsToPublish", () => {
  const day1 = new Date("2026-09-01T17:00:00Z"); // 19:00 Europe/Prague (CEST)
  const day1Later = new Date("2026-09-01T19:00:00Z");
  const day2 = new Date("2026-09-02T17:00:00Z");

  it("shows nothing when every group is empty", async () => {
    const kv = fakeKv();
    expect(await decideGroupsToPublish(kv, matchesByGroup(), day1)).toEqual([]);
  });

  it("always shows the first time a ticker is seen in a group", async () => {
    const kv = fakeKv();
    const result = await decideGroupsToPublish(
      kv,
      matchesByGroup({ Core: [match("AAA", 10)] }),
      day1
    );
    expect(result).toEqual(["Core"]);
  });

  it("always shows the first run of a new calendar day for a group, even with no change", async () => {
    const kv = fakeKv();
    await decideGroupsToPublish(kv, matchesByGroup({ Core: [match("AAA", 10)] }), day1);

    const result = await decideGroupsToPublish(
      kv,
      matchesByGroup({ Core: [match("AAA", 10)] }),
      day2
    );
    expect(result).toEqual(["Core"]);
  });

  it("suppresses a same-day republish for a group when PV moved less than 1%", async () => {
    const kv = fakeKv();
    await decideGroupsToPublish(kv, matchesByGroup({ Core: [match("AAA", 10)] }), day1);

    const result = await decideGroupsToPublish(
      kv,
      matchesByGroup({ Core: [match("AAA", 10.05)] }),
      day1Later
    );
    expect(result).toEqual([]);
  });

  it("shows a same-day republish for a group when any of its tickers' PV moved more than 1%", async () => {
    const kv = fakeKv();
    await decideGroupsToPublish(
      kv,
      matchesByGroup({ Core: [match("AAA", 10), match("BBB", 20)] }),
      day1
    );

    const result = await decideGroupsToPublish(
      kv,
      matchesByGroup({ Core: [match("AAA", 10.2), match("BBB", 20)] }),
      day1Later
    );
    expect(result).toEqual(["Core"]);
  });

  it("omits an empty group and does not touch its stored state", async () => {
    const kv = fakeKv();
    await decideGroupsToPublish(kv, matchesByGroup({ Core: [match("AAA", 10)] }), day1);

    // Core goes empty this run -- shouldn't show, and its prior anchor stays put.
    const result = await decideGroupsToPublish(kv, matchesByGroup(), day1Later);
    expect(result).toEqual([]);

    // Confirmed by re-introducing the same PV later the same day: still suppressed,
    // proving Core's anchor is untouched (10, not cleared).
    const laterResult = await decideGroupsToPublish(
      kv,
      matchesByGroup({ Core: [match("AAA", 10.05)] }),
      day1Later
    );
    expect(laterResult).toEqual([]);
  });

  it("does not update a group's stored state on a suppressed run", async () => {
    const kv = fakeKv();
    await decideGroupsToPublish(kv, matchesByGroup({ Core: [match("AAA", 10)] }), day1);
    await decideGroupsToPublish(kv, matchesByGroup({ Core: [match("AAA", 10.05)] }), day1Later); // suppressed

    // A tiny additional move on top of the still-unchanged baseline stays under 1% total,
    // so it should still be suppressed -- proving the anchor didn't drift to 10.05.
    const result = await decideGroupsToPublish(
      kv,
      matchesByGroup({ Core: [match("AAA", 10.09)] }),
      day1Later
    );
    expect(result).toEqual([]);
  });

  it("decides each canonical group independently", async () => {
    const kv = fakeKv();
    await decideGroupsToPublish(
      kv,
      matchesByGroup({
        Core: [match("AAA", 10)],
        Opportunities: [match("BBB", 20)],
        Speculative: [match("CCC", 30)],
      }),
      day1
    );

    // Only Opportunities moves past 1% this run; Core and Speculative are unchanged.
    const result = await decideGroupsToPublish(
      kv,
      matchesByGroup({
        Core: [match("AAA", 10.05)],
        Opportunities: [match("BBB", 20.5)],
        Speculative: [match("CCC", 30.05)],
      }),
      day1Later
    );

    expect(result).toEqual(["Opportunities"]);
  });
});

describe("recordGroupsPublished", () => {
  const day1 = new Date("2026-09-01T17:00:00Z");
  const day1Later = new Date("2026-09-01T19:00:00Z");

  it("re-anchors a group's stored PV so a later decision compares against the recorded value", async () => {
    const kv = fakeKv();
    await decideGroupsToPublish(kv, matchesByGroup({ Core: [match("AAA", 10)] }), day1);

    // Simulates a forced publish at an unchanged PV -- state should still move to 10.
    await recordGroupsPublished(kv, matchesByGroup({ Core: [match("AAA", 10)] }), day1Later);

    // A move that's >1% from the re-anchored value shows...
    const result = await decideGroupsToPublish(
      kv,
      matchesByGroup({ Core: [match("AAA", 10.2)] }),
      day1Later
    );
    expect(result).toEqual(["Core"]);
  });

  it("returns only the currently non-empty groups, and leaves empty groups' state untouched", async () => {
    const kv = fakeKv();
    const result = await recordGroupsPublished(
      kv,
      matchesByGroup({ Core: [match("AAA", 10)] }),
      day1
    );
    expect(result).toEqual(["Core"]);
  });

  it("returns an empty list and writes nothing when every group is empty", async () => {
    const kv = fakeKv();
    const result = await recordGroupsPublished(kv, matchesByGroup(), day1);
    expect(result).toEqual([]);

    // A brand new ticker after an empty forced publish still counts as new.
    const decide = await decideGroupsToPublish(
      kv,
      matchesByGroup({ Core: [match("AAA", 10)] }),
      day1
    );
    expect(decide).toEqual(["Core"]);
  });
});
