import path from "node:path";
import type { NextConfig } from "next";

const bareHttpsOrigin = (value: string | undefined): string | null => {
  if (value === undefined || value.trim().length === 0) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    // Local Playwright builds use http://127.0.0.1 origins.
    if (url.protocol === "http:" && url.hostname !== "127.0.0.1") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
};

const apiOrigin = bareHttpsOrigin(process.env.NEXT_PUBLIC_API_ORIGIN);
const posthogOrigin = bareHttpsOrigin(process.env.NEXT_PUBLIC_POSTHOG_HOST);

const clerkOriginFromPublishableKey = (
  value: string | undefined,
): string | null => {
  if (value === undefined || !/^pk_(?:test|live)_/u.test(value)) return null;
  try {
    const encoded = value.replace(/^pk_(?:test|live)_/u, "");
    const frontendHost = Buffer.from(encoded, "base64url")
      .toString("utf8")
      .replace(/\$$/u, "");
    return bareHttpsOrigin(`https://${frontendHost}`);
  } catch {
    return null;
  }
};

const clerkOrigin = clerkOriginFromPublishableKey(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
);

const connectSrc = ["'self'", apiOrigin, posthogOrigin]
  .filter((value): value is string => typeof value === "string")
  .join(" ");

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' data: blob: https://img.clerk.com",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  // Clerk supplies the signed-in browser identity UI; keep inline bootstrap scripts allowed.
  `script-src 'self' 'unsafe-inline' https://*.clerk.accounts.dev https://*.clerk.com${clerkOrigin === null ? "" : ` ${clerkOrigin}`}`,
  `frame-src 'self' https://*.clerk.accounts.dev https://*.clerk.com${clerkOrigin === null ? "" : ` ${clerkOrigin}`}`,
  "worker-src 'self' blob:",
  `connect-src ${connectSrc} https://*.clerk.accounts.dev https://api.clerk.com https://*.clerk.com${clerkOrigin === null ? "" : ` ${clerkOrigin}`}`,
].join("; ");

const nextConfig: NextConfig = {
  allowedDevOrigins: ["web.cueva.io"],
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: contentSecurityPolicy,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
