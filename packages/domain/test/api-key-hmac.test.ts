import { describe, expect, test } from "bun:test";
import { digestApiKeyCredential } from "../src/api-key-hmac";

describe("API Key HMAC", () => {
  test("derives one digest generation from the current secret", async () => {
    const credential = "normal_apk_example.secret";
    const predecessor = await digestApiKeyCredential(
      "ab".repeat(32),
      credential,
    );
    const replacement = await digestApiKeyCredential(
      "cd".repeat(32),
      credential,
    );

    expect(predecessor).toHaveLength(32);
    expect(replacement).toHaveLength(32);
    expect(replacement).not.toEqual(predecessor);
  });

  test("rejects malformed secret material", async () => {
    await expect(
      digestApiKeyCredential("too-short", "credential"),
    ).rejects.toThrow("API Key HMAC secret must be a 32-byte hex value");
  });
});
