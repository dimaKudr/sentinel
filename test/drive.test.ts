import { afterEach, describe, expect, it, vi } from "vitest";
import { findFileIdByName } from "../src/drive";

describe("findFileIdByName", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the id of the most recently modified match", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          files: [
            { id: "newest-id", name: "Watch-List", modifiedTime: "2026-08-31T00:00:00Z" },
            { id: "older-id", name: "Watch-List", modifiedTime: "2026-08-24T00:00:00Z" },
          ],
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const id = await findFileIdByName("token", "Watch-List");

    expect(id).toBe("newest-id");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("q=name");
    expect(url).toContain("orderBy=modifiedTime");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token");
  });

  it("throws when no file matches the name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ files: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(findFileIdByName("token", "Missing-Sheet")).rejects.toThrowError(
      /No Drive file found named "Missing-Sheet"/
    );
  });
});
