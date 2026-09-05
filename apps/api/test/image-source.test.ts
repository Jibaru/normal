import { describe, expect, test } from "vitest";
import { decodeImageBase64, downloadImage } from "../src/image-source";

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const dnsResponse = (address = "93.184.216.34") =>
  new Response(JSON.stringify({ Answer: [{ data: address, type: 1 }] }));

describe("outbound image source validation", () => {
  test("snapshots JPEG and PNG signatures with their normalized MIME types", () => {
    const decodedJpeg = decodeImageBase64("/9j/4A==");
    const decodedPng = decodeImageBase64("iVBORw0KGgo=");

    expect(decodedJpeg).toEqual(jpeg);
    expect(decodedJpeg.mimeType).toBe("image/jpeg");
    expect(decodedPng).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(decodedPng.mimeType).toBe("image/png");
  });

  test.each([
    "/9j/4A",
    "/9j/4A==\n",
    "data:image/jpeg;base64,/9j/4A==",
    "_9j_4A==",
    "/9j/4A===",
  ])("rejects non-canonical standard Base64 %s", (value) => {
    expect(() => decodeImageBase64(value)).toThrow("invalid image base64");
  });

  test("enforces the exact 5,000,000-byte decoded limit", () => {
    const exact = `/9j/${"AAAA".repeat(1_666_665)}AAA=`;
    const oversized = `/9j/${"AAAA".repeat(1_666_666)}`;

    expect(decodeImageBase64(exact).byteLength).toBe(5_000_000);
    expect(() => decodeImageBase64(oversized)).toThrow(RangeError);
  });

  test("uses guarded public DNS, validates redirects, and caps actual response bytes", async () => {
    const calls: string[] = [];
    const oversized = new Uint8Array(5_000_001);
    oversized.set(jpeg);
    const fetcher: NonNullable<Parameters<typeof downloadImage>[1]> = async (
      input,
    ) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://cloudflare-dns.com/")) {
        const type = new URL(url).searchParams.get("type");
        return type === "A" ? dnsResponse() : new Response("{}");
      }
      if (url === "https://files.normalcdn.com/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.normalcdn.com/image.jpg" },
        });
      }
      if (url === "https://files.normalcdn.com/oversized") {
        return new Response(oversized, {
          headers: { "content-length": "1" },
        });
      }
      return new Response(jpeg);
    };

    const downloaded = await downloadImage(
      "https://files.normalcdn.com/start",
      fetcher,
    );
    expect(downloaded).toEqual(jpeg);
    expect(downloaded.mimeType).toBe("image/jpeg");
    expect(calls).toContain("https://cdn.normalcdn.com/image.jpg");
    await expect(
      downloadImage("https://files.normalcdn.com/oversized", fetcher),
    ).rejects.toThrow("response exceeded byte limit");
  });
});
