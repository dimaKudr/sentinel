import { describe, expect, it } from "vitest";
import { shouldPublish, recordPublished } from "../src/state";
import type { WatchListMatch } from "../src/sheets";

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

function match(ticker: string, pv: number): WatchListMatch {
  return { ticker, pv, target: pv + 1 };
}

describe("shouldPublish", () => {
  const day1 = new Date("2026-09-01T17:00:00Z"); // 19:00 Europe/Prague (CEST)
  const day1Later = new Date("2026-09-01T19:00:00Z");
  const day2 = new Date("2026-09-02T17:00:00Z");

  it("always publishes when there are no matches", async () => {
    const kv = fakeKv();
    expect(await shouldPublish(kv, [], day1)).toBe(true);
  });

  it("always publishes the first time a ticker is seen", async () => {
    const kv = fakeKv();
    expect(await shouldPublish(kv, [match("AAA", 10)], day1)).toBe(true);
  });

  it("always publishes the first run of a new calendar day, even with no change", async () => {
    const kv = fakeKv();
    await shouldPublish(kv, [match("AAA", 10)], day1);

    expect(await shouldPublish(kv, [match("AAA", 10)], day2)).toBe(true);
  });

  it("suppresses a same-day republish when PV moved less than 1%", async () => {
    const kv = fakeKv();
    await shouldPublish(kv, [match("AAA", 10)], day1);

    expect(await shouldPublish(kv, [match("AAA", 10.05)], day1Later)).toBe(false);
  });

  it("publishes a same-day republish when any ticker's PV moved more than 1%", async () => {
    const kv = fakeKv();
    await shouldPublish(kv, [match("AAA", 10), match("BBB", 20)], day1);

    expect(
      await shouldPublish(kv, [match("AAA", 10.2), match("BBB", 20)], day1Later)
    ).toBe(true);
  });

  it("publishes a same-day republish when a new ticker appears alongside unchanged ones", async () => {
    const kv = fakeKv();
    await shouldPublish(kv, [match("AAA", 10)], day1);

    expect(await shouldPublish(kv, [match("AAA", 10), match("BBB", 20)], day1Later)).toBe(true);
  });

  it("does not update stored state on a suppressed run", async () => {
    const kv = fakeKv();
    await shouldPublish(kv, [match("AAA", 10)], day1);
    await shouldPublish(kv, [match("AAA", 10.05)], day1Later); // suppressed, no state update

    // A tiny additional move on top of the still-unchanged baseline stays under 1% total,
    // so it should still be suppressed -- proving the anchor didn't drift to 10.05.
    expect(await shouldPublish(kv, [match("AAA", 10.09)], day1Later)).toBe(false);
  });
});

describe("recordPublished", () => {
  const day1 = new Date("2026-09-01T17:00:00Z");
  const day1Later = new Date("2026-09-01T19:00:00Z");

  it("re-anchors the stored PV so a later shouldPublish compares against the recorded value", async () => {
    const kv = fakeKv();
    await shouldPublish(kv, [match("AAA", 10)], day1);

    // Simulates a forced publish at an unchanged PV -- state should still move to 10.
    await recordPublished(kv, [match("AAA", 10)], day1Later);

    // A move that's >1% from the re-anchored value publishes...
    expect(await shouldPublish(kv, [match("AAA", 10.2)], day1Later)).toBe(true);
  });

  it("records an empty PV map when there are no matches", async () => {
    const kv = fakeKv();
    await recordPublished(kv, [], day1);

    // A brand new ticker after an empty forced publish still counts as new.
    expect(await shouldPublish(kv, [match("AAA", 10)], day1)).toBe(true);
  });
});
