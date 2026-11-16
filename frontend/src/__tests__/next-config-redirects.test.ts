import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

// As rotas antigas /projects/[id]/{assignments,code,compare} viraram
// redirects do next.config. Sem páginas próprias, o redirect é o único
// caminho que leva o link antigo à aba de "Analisar".
describe("next.config redirects", () => {
  it("leva cada aba antiga a analyze/<aba>, sem cache permanente", async () => {
    const redirects = await nextConfig.redirects!();
    expect(redirects).toEqual([
      {
        source: "/projects/:id/assignments",
        destination: "/projects/:id/analyze/assignments",
        permanent: false,
      },
      {
        source: "/projects/:id/code",
        destination: "/projects/:id/analyze/code",
        permanent: false,
      },
      {
        source: "/projects/:id/compare",
        destination: "/projects/:id/analyze/compare",
        permanent: false,
      },
    ]);
  });
});
