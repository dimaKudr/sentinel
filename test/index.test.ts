import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

vi.mock("../src/google-auth", () => ({
  getGoogleAccessToken: vi.fn(),
}));
vi.mock("../src/drive", () => ({
  findFileIdByName: vi.fn(),
}));
vi.mock("../src/sheets", () => ({
  getSheetValues: vi.fn(),
  filterRows: vi.fn(),
}));
vi.mock("../src/telegram", () => ({
  formatTelegramMessage: vi.fn(),
  sendTelegram: vi.fn(),
}));
vi.mock("../src/schedule", () => ({
  isWithinRunWindow: vi.fn(),
}));

import worker from "../src/index";
import { getGoogleAccessToken } from "../src/google-auth";
import { findFileIdByName } from "../src/drive";
import { getSheetValues, filterRows } from "../src/sheets";
import { formatTelegramMessage, sendTelegram } from "../src/telegram";
import { isWithinRunWindow } from "../src/schedule";

const env: Env = {
  GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_CHAT_ID: "test-chat-id",
};

function stubHappyPathPipeline(): void {
  vi.mocked(getGoogleAccessToken).mockResolvedValue("token");
  vi.mocked(findFileIdByName).mockResolvedValue("file-id");
  vi.mocked(getSheetValues).mockResolvedValue([["Ticker", "Target", "PV $"]]);
  vi.mocked(filterRows).mockReturnValue([]);
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

  it("GET /run runs the job pipeline and returns 200 on success", async () => {
    stubHappyPathPipeline();
    const request = new Request("https://worker.example/run", { method: "GET" });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("OK - job ran, check Telegram.");
    expect(getGoogleAccessToken).toHaveBeenCalledWith(env);
    expect(findFileIdByName).toHaveBeenCalledWith("token", "Watch-List");
    expect(sendTelegram).toHaveBeenCalledWith(env, "message");
  });

  it("POST /run runs the job pipeline and returns 200 on success", async () => {
    stubHappyPathPipeline();
    const request = new Request("https://worker.example/run", { method: "POST" });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("OK - job ran, check Telegram.");
    expect(sendTelegram).toHaveBeenCalledTimes(1);
  });

  it("/run returns 500 with the error message when the job pipeline throws", async () => {
    stubHappyPathPipeline();
    vi.mocked(getGoogleAccessToken).mockRejectedValue(new Error("token exchange failed"));
    const request = new Request("https://worker.example/run", { method: "GET" });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("ERROR: token exchange failed");
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
