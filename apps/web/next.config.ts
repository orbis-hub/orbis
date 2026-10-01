import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // fully static: served by the Orbis hub and wrapped by Capacitor
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  transpilePackages: ["@orbis/ui", "@orbis/sdk"],
  allowedDevOrigins: ["127.0.0.1", "192.168.*.*", "*.local"],
};

export default nextConfig;
