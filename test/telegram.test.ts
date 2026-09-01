import { afterEach, describe, expect, it, vi } from "vitest";
import { formatTelegramMessage, sendTelegram } from "../src/telegram";
import type { Env } from "../src/env";

describe("formatTelegramMessage", () => {
  const fixedNow = new Date("2026-08-31T18:00:00Z");

  it("produces a 'no matches' message when there are zero matches", () => {
    const message = formatTelegramMessage([], fixedNow);

    expect(message).toContain("No stocks currently have Target &gt; PV $.");
    expect(message).toContain("Watch-List Alert");
    expect(message).not.toContain("<pre>");
  });

  it("formats a table with matches inside a <pre> block", () => {
    const message = formatTelegramMessage(
      [
        { ticker: "AAA", target: 15, pv: 10 },
        { ticker: "BBB", target: 12, pv: 10 },
      ],
      fixedNow
    );

    expect(message).toContain("<pre>");
    expect(message).toContain("Ticker    PV $      Target    Upside%");
    expect(message).toContain("AAA");
    expect(message).toContain("10.00");
    expect(message).toContain("15.00");
    expect(message).toContain("50.0%");
    expect(message).toContain("BBB");
    expect(message).toContain("12.00");
    expect(message).toContain("20.0%");
  });

  it("sorts rows by descending upside percentage", () => {
    const message = formatTelegramMessage(
      [
        { ticker: "LOW", target: 11, pv: 10 },
        { ticker: "HIGH", target: 20, pv: 10 },
      ],
      fixedNow
    );

    expect(message.indexOf("HIGH")).toBeLessThan(message.indexOf("LOW"));
  });

  it("HTML-escapes ticker values", () => {
    const message = formatTelegramMessage(
      [{ ticker: "<script>&", target: 1, pv: 2 }],
      fixedNow
    );

    expect(message).toContain("&lt;script&gt;&amp;");
    expect(message).not.toContain("<script>");
  });
});

describe("sendTelegram", () => {
  const env: Env = {
    GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "test-chat-id",
    RUN_SECRET: "test-run-secret",
    SENTINEL_STATE: {} as KVNamespace,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to the Telegram Bot API and resolves on ok:true", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendTelegram(env, "hello");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bottest-token/sendMessage");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ chat_id: "test-chat-id", text: "hello", parse_mode: "HTML" });
  });

  it("throws with the API's error description on ok:false", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: false, description: "bad chat id" }), { status: 400 })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendTelegram(env, "hello")).rejects.toThrowError(/bad chat id/);
  });
});
