import path from "node:path";
import type { NextConfig } from "next";

/**
 * Static export for GitHub Pages: `STATIC_EXPORT=1 NEXT_PUBLIC_BASE_PATH=/Parallax npm run build` writes a
 * fully static site to `out/`. The app reads chains directly from the browser, so no server is needed.
 */
const isExport = process.env.STATIC_EXPORT === "1";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  // Pin the workspace root to web/ so a stray lockfile higher up the tree isn't picked instead.
  outputFileTracingRoot: path.join(__dirname),
  ...(isExport ? { output: "export" as const, basePath, images: { unoptimized: true }, trailingSlash: true } : {}),
};

export default nextConfig;
