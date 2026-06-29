import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // `server-only` lanca por design quando importado fora de um Server
      // Component. Em testes (sem o transform do Next) qualquer client component
      // que importe transitivamente um Server Action — e estes agora puxam
      // `lib/api-server.ts`, que e `server-only` — quebraria no load. O proprio
      // pacote distribui `empty.js` (no-op) para este caso; aliasamos a ele.
      "server-only": path.resolve(
        __dirname,
        "node_modules/server-only/empty.js",
      ),
    },
  },
});
