import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Tira do worker o GIT_DIR e afins que o hook de pre-push exporta
    // (src/test-utils/git-env.setup.ts) e reprova o teste que gasta mais CPU do
    // que cabe nos 5 s de timeout com a suíte disputando a CPU
    // (src/test-utils/cpu-budget.ts).
    setupFiles: ["src/test-utils/git-env.setup.ts", "src/test-utils/cpu-budget.setup.ts"],
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
