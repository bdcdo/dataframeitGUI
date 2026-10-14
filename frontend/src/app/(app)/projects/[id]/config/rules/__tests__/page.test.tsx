import { beforeEach, describe, expect, it, vi } from "vitest";

// A página só monta o RulesForm com a linha real do projeto: o form grava os
// seis campos juntos, e um valor inventado viraria escrita no primeiro "Salvar".

type Result = { data: unknown; error: { message: string; code?: string } | null };

const state = vi.hoisted(() => ({
  result: { data: null, error: null } as Result,
}));

// Dublê com a semântica do PostgREST para zero linhas: maybeSingle devolve
// data null sem erro, e single responde PGRST116. Sem essa diferença, voltar
// a página para .single() trocaria o 404 por erro sem nenhum teste notar.
function makeClient() {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => state.result,
    single: async () =>
      state.result.data === null && state.result.error === null
        ? {
            data: null,
            error: { message: "0 rows", code: "PGRST116" },
          }
        : state.result,
  };
  return { from: () => builder };
}

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => makeClient(),
}));

vi.mock("../RulesForm", () => ({ RulesForm: () => null }));

import RulesPage from "../page";
import { RulesForm } from "../RulesForm";

const renderPage = () => RulesPage({ params: Promise.resolve({ id: "project-1" }) });

beforeEach(() => {
  state.result = { data: null, error: null };
});

describe("RulesPage", () => {
  it("projeto ausente → notFound, sem modo inventado", async () => {
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("falha na leitura → erro, sem formulário com valores padrão", async () => {
    state.result = { data: null, error: { message: "timeout" } };
    await expect(renderPage()).rejects.toThrow(
      "Não foi possível carregar as regras do projeto.",
    );
  });

  it("passa ao formulário o modo gravado no projeto", async () => {
    state.result = {
      data: {
        resolution_rule: "majority",
        min_responses_for_comparison: 2,
        allow_researcher_review: false,
        automation_mode: "none",
        comparison_includes_llm: true,
        out_of_scope_enabled: true,
      },
      error: null,
    };
    const element = await renderPage();
    const form = element.props.children;
    expect(form.type).toBe(RulesForm);
    expect(form.props.automationMode).toBe("none");
  });
});
