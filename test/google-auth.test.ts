import { describe, expect, it } from "vitest";
import { buildUnsignedJwt } from "../src/google-auth";

function decodeBase64Url(segment: string): unknown {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const normalized = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  return JSON.parse(atob(normalized));
}

describe("buildUnsignedJwt", () => {
  it("builds a base64url header.claimSet pair with the expected shape", () => {
    const now = 1_700_000_000;
    const unsigned = buildUnsignedJwt(
      { client_email: "sa@example.iam.gserviceaccount.com", private_key: "unused-here" },
      now
    );

    const [headerPart, claimPart, extra] = unsigned.split(".");
    expect(extra).toBeUndefined();

    expect(decodeBase64Url(headerPart!)).toEqual({ alg: "RS256", typ: "JWT" });

    const claimSet = decodeBase64Url(claimPart!) as Record<string, unknown>;
    expect(claimSet.iss).toBe("sa@example.iam.gserviceaccount.com");
    expect(claimSet.aud).toBe("https://oauth2.googleapis.com/token");
    expect(claimSet.iat).toBe(now);
    expect(claimSet.exp).toBe(now + 3600);
    expect(claimSet.scope).toContain("drive.readonly");
    expect(claimSet.scope).toContain("spreadsheets.readonly");
  });

  it("does not include unsafe base64 characters (uses base64url, not base64)", () => {
    const unsigned = buildUnsignedJwt(
      { client_email: "sa@example.iam.gserviceaccount.com", private_key: "unused-here" },
      1_700_000_000
    );

    expect(unsigned).not.toMatch(/[+/=]/);
  });
});
