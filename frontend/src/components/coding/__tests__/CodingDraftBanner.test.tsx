// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { warmUpJsdom } from "@/test-utils/jsdom-warm-up";
import { render, screen, cleanup, within } from "@testing-library/react";
import { CodingDraftBanner } from "@/components/coding/CodingDraftBanner";
import type { CodingDraftRecovery } from "@/lib/coding-draft";
import type { PydanticField } from "@/lib/types";

// Exigido pela regra test-jsdom-warm-up (eslint-rules/test-jsdom-warm-up.mjs).
beforeAll(() => warmUpJsdom(), 30_000);

afterEach(cleanup);

const FIELDS: PydanticField[] = [
  { id: "00000000-0000-4000-8000-000000000001", name: "q1", type: "text", options: null, description: "Diagnóstico" },
];

const DRAFT = { answers: { q1: "do rascunho" }, notes: "" };

// `changedFields` é o que retomar mudaria; `overwrittenFields` é a interseção
// com o que o servidor andou. A faixa só renderiza o segundo, mas ambos fazem
// parte do veredito — montar o literal completo é o que mantém o teste falando
// do mesmo objeto que a classificação produz.
const diverged: CodingDraftRecovery = {
  kind: "diverged",
  updatedAt: Date.now(),
  draft: DRAFT,
  changedFields: ["q1"],
  overwrittenFields: ["q1"],
};

const resumable: CodingDraftRecovery = {
  kind: "resumable",
  updatedAt: Date.now(),
  draft: DRAFT,
  changedFields: ["q1"],
};

function show(recovery: CodingDraftRecovery) {
  render(
    <CodingDraftBanner
      recovery={recovery}
      fields={FIELDS}
      onRestore={() => {}}
      onDiscard={() => {}}
      now={Date.now()}
    />,
  );
  return screen.getByRole("status");
}

// A faixa é uma live region: o leitor de tela reanuncia o que estiver dentro
// dela sempre que muda. O que precisa estar lá é o FATO (há rascunho, e retomar
// sobrescreve tais respostas); o que não pode estar são os controles, que o
// leitor já alcança pela navegação normal e que, dentro da região, viram ruído
// repetido a cada anúncio.
describe("CodingDraftBanner — o que a região live anuncia", () => {
  // Mutação vermelha: devolver o `role="status"` ao container externo. Os dois
  // botões voltam para dentro da região e este teste cai.
  it("não contém os controles", () => {
    expect(within(show(diverged)).queryAllByRole("button")).toEqual([]);
  });

  it("anuncia que há rascunho não enviado", () => {
    expect(within(show(resumable)).getByText(/alterações não enviadas/)).toBeTruthy();
  });

  // Mutação vermelha: deixar o bloco de sobrescrita FORA do wrapper (era onde
  // ele estava). O aviso mais consequente da faixa — quais respostas retomar
  // substitui — deixaria de ser anunciado.
  it("anuncia também o que retomar vai sobrescrever", () => {
    const live = within(show(diverged));
    expect(live.getByText(/foi salvo depois que o rascunho foi criado/)).toBeTruthy();
    expect(live.getByText("Diagnóstico")).toBeTruthy();
  });

  // Os botões continuam na tela e alcançáveis — o que mudou é onde a fronteira
  // da região live passa, não o que a faixa oferece.
  it("os botões seguem presentes fora da região", () => {
    show(diverged);
    expect(screen.getByRole("button", { name: "Retomar rascunho" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Descartar" })).toBeTruthy();
  });
});

// O leitor de tela anuncia o que MUDA numa região live que já existia; uma
// região inserida já populada costuma ser lida como conteúdo estático (#635).
// Afirmar só que a região contém a frase não discrimina nada — isso já valia
// quando a faixa devolvia `null` sem oferta. O que separa os dois mundos é a
// região existir, vazia, ANTES de a oferta chegar, e ser o MESMO nó depois.
describe("CodingDraftBanner — a chegada da oferta é anunciada", () => {
  const NONE: CodingDraftRecovery = { kind: "none" };

  function mount(recovery: CodingDraftRecovery) {
    const props = { fields: FIELDS, onRestore: () => {}, onDiscard: () => {}, now: Date.now() };
    const { rerender } = render(<CodingDraftBanner recovery={recovery} {...props} />);
    return (next: CodingDraftRecovery) =>
      rerender(<CodingDraftBanner recovery={next} {...props} />);
  }

  // Mutação vermelha: voltar a devolver `null` sem oferta. A região deixa de
  // existir antes da chegada e este teste cai.
  it("a região já está montada, vazia, quando ainda não há oferta", () => {
    mount(NONE);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("na transição none → resumable, a região que se preenche é a que já existia", () => {
    const update = mount(NONE);
    const before = screen.getByRole("status");
    update(resumable);
    const after = screen.getByRole("status");
    expect(after).toBe(before);
    expect(after.textContent).toMatch(/alterações não enviadas/);
  });

  // O texto visível da faixa não é uma segunda região: duas regiões com a
  // mesma frase seriam dois anúncios.
  it("a faixa visível não é região live", () => {
    show(diverged);
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("descartada a oferta, a região esvazia e continua montada", () => {
    const update = mount(diverged);
    const live = screen.getByRole("status");
    update(NONE);
    expect(screen.getByRole("status")).toBe(live);
    expect(live.textContent).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
