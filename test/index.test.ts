import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { WatchListMatch } from "../src/sheets";

vi.mock("../src/google-auth", () => ({
  getGoogleAccessToken: vi.fn(),
}));
vi.mock("../src/drive", () => ({
  findFileIdByName: vi.fn(),
}));
vi.mock("../src/sheets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sheets")>();
  return {
    ...actual,
    getSheetValues: vi.fn(),
    filterRows: vi.fn(),
  };
});
vi.mock("../src/telegram", () => ({
  formatTelegramMessage: vi.fn(),
  sendTelegram: vi.fn(),
}));
vi.mock("../src/schedule", () => ({
  isWithinRunWindow: vi.fn(),
}));
vi.mock("../src/state", () => ({
  decideGroupsToPublish: vi.fn(),
  recordGroupsPublished: vi.fn(),
}));

import worker from "../src/index";
import { getGoogleAccessToken } from "../src/google-auth";
import { findFileIdByName } from "../src/drive";
import { getSheetValues, filterRows } from "../src/sheets";
import { formatTelegramMessage, sendTelegram } from "../src/telegram";
import { isWithinRunWindow } from "../src/schedule";
import { decideGroupsToPublish, recordGroupsPublished } from "../src/state";

const env: Env = {
  GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_CHAT_ID: "test-chat-id",
  RUN_SECRET: "test-run-secret",
  SENTINEL_STATE: {} as KVNamespace,
};

function match(ticker: string, group: WatchListMatch["group"]): WatchListMatch {
  return { ticker, target: 2, pv: 1, group };
}

function stubHappyPathPipeline(): void {
  vi.mocked(getGoogleAccessToken).mockResolvedValue("token");
  vi.mocked(findFileIdByName).mockResolvedValue("file-id");
  vi.mocked(getSheetValues).mockResolvedValue([["Ticker", "Target", "PV $"]]);
  vi.mocked(filterRows).mockReturnValue([]);
  vi.mocked(decideGroupsToPublish).mockResolvedValue([]);
  vi.mocked(recordGroupsPublished).mockResolvedValue([]);
  vi.mocked(formatTelegramMessage).mockReturnValue("message");
  vi.mocked(sendTelegram).mockResolvedValue(undefined);
}

function makeExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
}

async function runManual(query = ""): Promise<Response> {
  const request = new Request(`https://worker.example/run${query}`, {
    method: "GET",
    headers: { "X-Run-Secret": "test-run-secret" },
  });
  return worker.fetch(request, env);
}

describe("fetch", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("GET / returns the informational response, not the job route", async () => {
    stubHappyPathPipeline();
    const request = new Request("https://worker.example/", { method: "GET" });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Watch-List Telegram worker.");
    expect(getGoogleAccessToken).not.toHaveBeenCalled();
  });

  it("GET /run runs the job pipeline but sends nothing when no group has anything to show", async () => {
    stubHappyPathPipeline();

    const response = await runManual();

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("OK - job ran, check Telegram.");
    expect(getGoogleAccessToken).toHaveBeenCalledWith(env);
    expect(findFileIdByName).toHaveBeenCalledWith("token", "Watch-List");
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("POST /run runs the job pipeline and returns 200 on success", async () => {
    stubHappyPathPipeline();
    vi.mocked(filterRows).mockReturnValue([match("AAA", "Core")]);
    vi.mocked(decideGroupsToPublish).mockResolvedValue(["Core"]);
    const request = new Request("https://worker.example/run", {
      method: "POST",
      headers: { "X-Run-Secret": "test-run-secret" },
    });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("OK - job ran, check Telegram.");
    expect(sendTelegram).toHaveBeenCalledTimes(1);
  });

  it("/run returns 500 with the error message when the job pipeline throws", async () => {
    stubHappyPathPipeline();
    vi.mocked(getGoogleAccessToken).mockRejectedValue(new Error("token exchange failed"));

    const response = await runManual();

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("ERROR: token exchange failed");
  });

  it("sends only the group(s) decideGroupsToPublish marks to show", async () => {
    stubHappyPathPipeline();
    vi.mocked(filterRows).mockReturnValue([
      match("AAA", "Core"),
      match("BBB", "Opportunities"),
      match("CCC", "Speculative"),
    ]);
    vi.mocked(decideGroupsToPublish).mockResolvedValue(["Opportunities"]);

    const response = await runManual();

    expect(response.status).toBe(200);
    expect(formatTelegramMessage).toHaveBeenCalledWith([
      { group: "Opportunities", matches: [match("BBB", "Opportunities")] },
    ]);
    expect(sendTelegram).toHaveBeenCalledWith(env, "message");
  });

  it("does not publish to Telegram when every group is empty or suppressed (all-quiet)", async () => {
    stubHappyPathPipeline();
    vi.mocked(filterRows).mockReturnValue([match("AAA", "Core")]);
    vi.mocked(decideGroupsToPublish).mockResolvedValue([]);

    const response = await runManual();

    expect(response.status).toBe(200);
    expect(formatTelegramMessage).not.toHaveBeenCalled();
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("always shows Other when it has matches, even though no group changed", async () => {
    stubHappyPathPipeline();
    vi.mocked(filterRows).mockReturnValue([match("ZZZ", "Other")]);
    vi.mocked(decideGroupsToPublish).mockResolvedValue([]);

    const response = await runManual();

    expect(response.status).toBe(200);
    expect(formatTelegramMessage).toHaveBeenCalledWith([
      { group: "Other", matches: [match("ZZZ", "Other")] },
    ]);
    expect(sendTelegram).toHaveBeenCalledWith(env, "message");
  });

  it("orders sections Core -> Opportunities -> Speculative -> Other regardless of sheet order", async () => {
    stubHappyPathPipeline();
    vi.mocked(filterRows).mockReturnValue([
      match("DDD", "Other"),
      match("CCC", "Speculative"),
      match("BBB", "Opportunities"),
      match("AAA", "Core"),
    ]);
    vi.mocked(decideGroupsToPublish).mockResolvedValue(["Core", "Opportunities", "Speculative"]);

    await runManual();

    expect(formatTelegramMessage).toHaveBeenCalledWith([
      { group: "Core", matches: [match("AAA", "Core")] },
      { group: "Opportunities", matches: [match("BBB", "Opportunities")] },
      { group: "Speculative", matches: [match("CCC", "Speculative")] },
      { group: "Other", matches: [match("DDD", "Other")] },
    ]);
  });

  it("/run?force=true publishes every non-empty canonical group plus Other, bypassing suppression", async () => {
    stubHappyPathPipeline();
    vi.mocked(filterRows).mockReturnValue([match("AAA", "Core"), match("ZZZ", "Other")]);
    vi.mocked(recordGroupsPublished).mockResolvedValue(["Core"]);

    const response = await runManual("?force=true");

    expect(response.status).toBe(200);
    expect(decideGroupsToPublish).not.toHaveBeenCalled();
    expect(recordGroupsPublished).toHaveBeenCalledWith(env.SENTINEL_STATE, {
      Core: [match("AAA", "Core")],
      Opportunities: [],
      Speculative: [],
    });
    expect(formatTelegramMessage).toHaveBeenCalledWith([
      { group: "Core", matches: [match("AAA", "Core")] },
      { group: "Other", matches: [match("ZZZ", "Other")] },
    ]);
    expect(sendTelegram).toHaveBeenCalledWith(env, "message");
  });

  it("/run without force still applies the unchanged-PV suppression", async () => {
    stubHappyPathPipeline();
    vi.mocked(filterRows).mockReturnValue([match("AAA", "Core")]);
    vi.mocked(decideGroupsToPublish).mockResolvedValue([]);

    const response = await runManual();

    expect(response.status).toBe(200);
    expect(recordGroupsPublished).not.toHaveBeenCalled();
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("/run returns 401 and does not run the job when the X-Run-Secret header is missing", async () => {
    stubHappyPathPipeline();
    const request = new Request("https://worker.example/run", { method: "GET" });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain("ERROR: unauthorized");
    expect(getGoogleAccessToken).not.toHaveBeenCalled();
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("/run returns 401 and does not run the job when the X-Run-Secret header is wrong", async () => {
    stubHappyPathPipeline();
    const request = new Request("https://worker.example/run", {
      method: "GET",
      headers: { "X-Run-Secret": "not-the-right-secret" },
    });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain("ERROR: unauthorized");
    expect(getGoogleAccessToken).not.toHaveBeenCalled();
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("/run returns 401 when env.RUN_SECRET is unset, even if the request sends a matching empty string", async () => {
    stubHappyPathPipeline();
    const envWithoutRunSecret: Env = { ...env, RUN_SECRET: "" };
    const request = new Request("https://worker.example/run", {
      method: "GET",
      headers: { "X-Run-Secret": "" },
    });

    const response = await worker.fetch(request, envWithoutRunSecret);

    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain("ERROR: unauthorized");
    expect(getGoogleAccessToken).not.toHaveBeenCalled();
    expect(sendTelegram).not.toHaveBeenCalled();
  });
});

describe("scheduled", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not invoke the job pipeline when outside the run window", async () => {
    stubHappyPathPipeline();
    vi.mocked(isWithinRunWindow).mockReturnValue(false);
    const ctx = makeExecutionContext();

    await worker.scheduled({} as ScheduledController, env, ctx);

    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(getGoogleAccessToken).not.toHaveBeenCalled();
  });

  it("invokes the job pipeline via ctx.waitUntil when inside the run window", async () => {
    stubHappyPathPipeline();
    vi.mocked(isWithinRunWindow).mockReturnValue(true);
    vi.mocked(filterRows).mockReturnValue([match("AAA", "Core")]);
    vi.mocked(decideGroupsToPublish).mockResolvedValue(["Core"]);
    const ctx = makeExecutionContext();

    await worker.scheduled({} as ScheduledController, env, ctx);

    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    // The job pipeline is passed to waitUntil as a Promise; await it to
    // confirm the underlying runJob() actually executed the pipeline.
    const waitUntilArg = vi.mocked(ctx.waitUntil).mock.calls[0]![0];
    await waitUntilArg;
    expect(getGoogleAccessToken).toHaveBeenCalledWith(env);
    expect(sendTelegram).toHaveBeenCalledWith(env, "message");
  });
});
