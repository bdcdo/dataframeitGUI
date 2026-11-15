// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { stubRadixJsdomApis } from "@/test-utils/radix-jsdom";
import { ReviewCommentsView } from "@/components/stats/ReviewCommentsView";
import type { ReviewComment } from "@/components/stats/comment-card-utils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/actions/stats", () => ({}));
vi.mock("@/actions/project-comments", () => ({}));
vi.mock("@/actions/suggestions", () => ({}));
vi.mock("@/actions/schema", () => ({}));

function comment(overrides: Partial<ReviewComment>): ReviewComment {
  return {
    id: "id",
    documentId: "doc1",
    documentTitle: "Documento 1",
    fieldName: "campo1",
    fieldDescription: "Pergunta 1",
    verdict: "anotacao",
    comment: "texto",
    reviewerName: "ana",
    resolvedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    chosenResponseId: null,
    source: "anotacao",
    responseSnapshot: null,
    ...overrides,
  };
}

const comments = [
  comment({ id: "anotacao-n1", comment: "uma anotação qualquer" }),
  comment({
    id: "anotacao-a1",
    verdict: "ambiguidade",
    comment: "Campo marcado como ambíguo na revisão (aba Comparar).",
  }),
  comment({
    id: "r1",
    source: "review",
    verdict: "ambiguo",
    comment: "comentário do revisor no veredito",
  }),
];

function show() {
  render(
    <ReviewCommentsView
      projectId="p1"
      comments={comments}
      fields={[]}
      isCoordinator={false}
      schemaBaseline={{ revision: 0 }}
    />,
  );
}

async function filterByType(label: string) {
  await userEvent.click(screen.getByRole("combobox", { name: "Filtrar por tipo" }));
  await userEvent.click(await screen.findByRole("option", { name: label }));
}

beforeAll(() => warmUpJsdom({ select: true }), 30_000);
// O primeiro uso do seletor nesta tela paga o JIT dos caminhos dela; percorrê-lo
// uma vez aqui tira esse custo do orçamento de CPU dos testes.
beforeAll(async () => {
  stubRadixJsdomApis();
  show();
  await filterByType("Notas");
  cleanup();
}, 30_000);
afterEach(cleanup);

// #680: a ambiguidade do campo vinha rotulada e filtrada como anotação, e o
// filtro "Ambíguo" casava outra coisa (o comentário do veredito).
describe("filtro de tipo da aba Comentários", () => {
  it("'Campos ambíguos' isola o comentário kind='ambiguity'", async () => {
    show();
    await filterByType("Campos ambíguos");
    expect(screen.getByText("Campo ambíguo")).toBeTruthy();
    expect(screen.getByText(/marcado como ambíguo na revisão/)).toBeTruthy();
    expect(screen.queryByText("uma anotação qualquer")).toBeNull();
    expect(screen.queryByText("comentário do revisor no veredito")).toBeNull();
    expect(screen.getByText("1 comentário")).toBeTruthy();
  });

  it("'Anotações' não traz mais a ambiguidade", async () => {
    show();
    await filterByType("Anotações");
    expect(screen.getByText("uma anotação qualquer")).toBeTruthy();
    expect(screen.queryByText(/marcado como ambíguo na revisão/)).toBeNull();
  });

  it("'Veredito ambíguo' casa só o comentário do veredito da revisão", async () => {
    show();
    await filterByType("Veredito ambíguo");
    expect(screen.getByText("comentário do revisor no veredito")).toBeTruthy();
    expect(screen.queryByText(/marcado como ambíguo na revisão/)).toBeNull();
  });
});
