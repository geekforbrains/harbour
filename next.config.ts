import { readFileSync } from "fs";
import type { NextConfig } from "next";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: process.cwd(),
  outputFileTracingExcludes: {
    "/*": [
      ".next/**",
      "data/**",
      "deer-flow/**",
      "graphify-out/**",
      "terraform/**",
      "*.db",
      "*.db-*",
      "harbour.db",
      "harbour.db-*",
    ],
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
};

export default nextConfig;
