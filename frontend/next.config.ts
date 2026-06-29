import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Build standalone para rodar em container (Fly.io). O Dockerfile copia
  // .next/standalone; sem este output, esse COPY falha. A Vercel ignora.
  output: "standalone",
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
    optimizePackageImports: ["recharts", "lucide-react", "framer-motion"],
  },
};

export default nextConfig;
