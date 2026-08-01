import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  serverExternalPackages: ["pdf-parse", "@napi-rs/canvas"],
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/api/bridge/monitor/:libraryId/:action(start|pause|resume)",
          destination: "/api/bridge/cloud-monitor/:libraryId/:action",
        },
      ],
    };
  },
};

export default nextConfig;
