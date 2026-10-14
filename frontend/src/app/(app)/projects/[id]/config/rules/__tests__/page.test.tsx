import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseMock, type TableResult } from "@/actions/__tests__/supabase-mock";

// A página só monta o RulesForm com a linha real do projeto: o form grava os
// seis campos juntos, e um valor inventado viraria escrita no primeiro "Salvar".

const state = vi.hoisted(() => ({
  projects: null as unknown as TableResult,
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () =>
    makeSupabaseMock({ tableResults: { projects: state.projects } }),
}));

vi.mock("../RulesForm", () => ({ RulesForm: () => null }));

import RulesPage from "../page";
import { RulesForm } from "../RulesForm";

const renderPage = () => RulesPage({ params: Promise.resolve({ id: "project-1" }) });

beforeEach(() => {
  state.projects = { data: null, error: null };
});

describe("RulesPage", () => {
  it("projeto ausente → notFound, sem modo inventado", async () => {
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("falha na leitura → erro, sem formulário com valores padrão", async () => {
    state.projects = { data: null, error: { message: "timeout" } };
    await expect(renderPage()).rejects.toThrow(
      "Não foi possível carregar as regras do projeto.",
    );
  });

  it("passa ao formulário o modo gravado no projeto", async () => {
    state.projects = {
      data: {
        resolution_rule: "majority",
        min_responses_for_comparison: 2,
        allow_researcher_review: false,
        automation_mode: "none",
        comparison_includes_llm: true,
        out_of_scope_enabled: true,
      },
    };
    const element = await renderPage();
    const form = element.props.children;
    expect(form.type).toBe(RulesForm);
    expect(form.props.automationMode).toBe("none");
  });
});
