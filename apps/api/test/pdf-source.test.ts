import { describe, expect, test } from "vitest";
import { decodePdfBase64, downloadPdf } from "../src/pdf-source";

const pdf = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
const dnsResponse = (address = "93.184.216.34") =>
  new Response(JSON.stringify({ Answer: [{ data: address, type: 1 }] }));

describe("outbound PDF source validation", () => {
  test("decodes only bounded PDF bytes with a version signature", () => {
    expect(decodePdfBase64("JVBERi0xLjcKJSVFT0YK")).toEqual(pdf);
    expect(decodePdfBase64("JVBERi0xLjcKWB==")).toEqual(
      new TextEncoder().encode("%PDF-1.7\nX"),
    );
    expect(() => decodePdfBase64(btoa("not a pdf"))).toThrow();
  });

  test("validates DNS and each manual HTTPS redirect before bounded download", async () => {
    const calls: string[] = [];
    const fetcher: NonNullable<Parameters<typeof downloadPdf>[1]> = async (
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
          headers: { location: "https://cdn.normalcdn.com/report.pdf" },
        });
      }
      return new Response(pdf, {
        headers: { "content-length": String(pdf.byteLength) },
      });
    };

    await expect(
      downloadPdf("https://files.normalcdn.com/start", fetcher),
    ).resolves.toEqual(pdf);
    expect(calls).toContain("https://cdn.normalcdn.com/report.pdf");
  });

  test.each([
    "http://example.com/report.pdf",
    "https://user@example.com/report.pdf",
    "https://127.0.0.1/report.pdf",
    "https://169.254.169.254/report.pdf",
    "https://localhost/report.pdf",
    "https://example.com/report.pdf",
  ])("rejects unsafe URL %s", async (url) => {
    const fetcher: NonNullable<
      Parameters<typeof downloadPdf>[1]
    > = async () => {
      throw new Error("network must not be reached");
    };
    await expect(downloadPdf(url, fetcher)).rejects.toThrow();
  });

  test("rejects DNS answers containing a non-global address", async () => {
    const fetcher: NonNullable<Parameters<typeof downloadPdf>[1]> = async (
      input,
    ) => {
      const type = new URL(String(input)).searchParams.get("type");
      return type === "A" ? dnsResponse("10.0.0.1") : new Response("{}");
    };
    await expect(
      downloadPdf("https://files.normalcdn.com/report.pdf", fetcher),
    ).rejects.toThrow();
  });
});
