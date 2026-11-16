// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import type { PendingAutoReviewsResult } from "@/lib/auto-review-pending";
import { PendingAutoReviewsBanner } from "../PendingAutoReviewsBanner";
import type { MemberRow } from "../member-list-utils";

// #681: o coordenador não via quantas auto-revisões estavam pendentes nem com
// quem.

function member(
  userId: string,
  firstName: string,
  lastName: string | null = null,
): MemberRow {
  return {
    id: `member-${userId}`,
    project_id: "project-1",
    user_id: userId,
    role: "pesquisador",
    can_arbitrate: false,
    can_resolve: false,
    can_compare: false,
    accessState: "ready",
    isClaimable: false,
    profiles: {
      id: userId,
      email: `${userId}@example.com`,
      first_name: firstName,
      last_name: lastName,
      created_at: "2026-01-01T00:00:00Z",
      activated_at: "2026-01-02T00:00:00Z",
    },
  };
}

const members = [
  member("ana", "Ana", "Silva"),
  member("ana2", "Ana", "Souza"),
  member("bia", "Bia"),
];

// O componente é um Server Component assíncrono: o teste o resolve e renderiza
// o que ele devolve.
async function renderResult(result: PendingAutoReviewsResult) {
  return render(
    await PendingAutoReviewsBanner({
      projectId: "project-1",
      pending: Promise.resolve(result),
      members,
    }),
  );
}

// [revisor, campos, documentos]
function renderBanner(loads: Array<[string, number, number]>) {
  return renderResult({
    data: {
      fields: loads.reduce((sum, [, fields]) => sum + fields, 0),
      documents: loads.reduce((sum, [, , documents]) => sum + documents, 0),
      byReviewer: new Map(
        loads.map(([userId, fields, documents]) => [
          userId,
          { fields, documents },
        ]),
      ),
    },
    error: null,
  });
}

const items = () =>
  screen.getAllByRole("listitem").map((item) => item.textContent);

// Exigido pela regra test-jsdom-warm-up (eslint-rules/test-jsdom-warm-up.mjs).
beforeAll(() => warmUpJsdom(), 30_000);
afterEach(cleanup);

describe("PendingAutoReviewsBanner", () => {
  it("mostra o total do projeto e a carga de cada revisor, da maior para a menor", async () => {
    await renderBanner([
      ["ana", 96, 20],
      ["bia", 439, 87],
    ]);

    expect(
      screen.getByText(
        "535 campo(s) com auto-revisão pendente, em 107 documento(s).",
      ),
    ).toBeTruthy();
    expect(items()).toEqual([
      "Bia: 439 em 87 doc(s)",
      "Ana Silva: 96 em 20 doc(s)",
    ]);
  });

  it("cada nome abre a fila daquele revisor, e homônimos se distinguem pelo sobrenome", async () => {
    await renderBanner([
      ["ana", 2, 1],
      ["ana2", 1, 1],
    ]);

    expect(
      screen.getByRole("link", { name: "Ana Silva" }).getAttribute("href"),
    ).toBe("/projects/project-1/analyze/auto-revisao?viewAs=ana");
    expect(
      screen.getByRole("link", { name: "Ana Souza" }).getAttribute("href"),
    ).toBe("/projects/project-1/analyze/auto-revisao?viewAs=ana2");
  });

  it("conta à parte a pendência de quem não está na lista de membros, sem link", async () => {
    await renderBanner([
      ["bia", 1, 1],
      ["saiu", 7, 3],
    ]);

    expect(items()).toEqual([
      "Bia: 1 em 1 doc(s)",
      "Fora da lista de membros: 7",
    ]);
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("some quando não há pendência", async () => {
    const { container } = await renderBanner([]);

    expect(container.innerHTML).toBe("");
  });

  it("falha da contagem vira aviso, e não zero pendências", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await renderResult({ data: null, error: { message: "boom" } });

    expect(screen.getByRole("alert").textContent).toContain(
      "Não foi possível contar as auto-revisões pendentes.",
    );
    expect(logged).toHaveBeenCalledWith(expect.any(String), "boom");
    logged.mockRestore();
  });
});
