import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Seed employee avatars are served from pravatar.
    remotePatterns: [
      { protocol: "https", hostname: "i.pravatar.cc" },
      { protocol: "https", hostname: "api.dicebear.com" },
    ],
  },
};

export default nextConfig;
