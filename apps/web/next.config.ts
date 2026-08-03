import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["web.cueva.io"],
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
};

export default nextConfig;
