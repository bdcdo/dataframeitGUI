import type { NextConfig } from "next";

// Abas que saíram da raiz do projeto para "Analisar". Os links antigos
// (favoritos, e-mails) seguem funcionando pelo redirect, que roda antes de
// qualquer rota e preserva a query string. 307, e não 308, como o redirect()
// das páginas que ele substitui: o navegador não guarda o destino.
const LEGACY_ANALYZE_TABS = ["assignments", "code", "compare"] as const;

const nextConfig: NextConfig = {
  // Build standalone para rodar em container (Fly.io). O Dockerfile copia
  // .next/standalone; sem este output, esse COPY falha. A Vercel ignora.
  output: "standalone",
  async redirects() {
    return LEGACY_ANALYZE_TABS.map((tab) => ({
      source: `/projects/:id/${tab}`,
      destination: `/projects/:id/analyze/${tab}`,
      permanent: false,
    }));
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
    optimizePackageImports: ["lucide-react", "framer-motion"],
  },
};

export default nextConfig;
