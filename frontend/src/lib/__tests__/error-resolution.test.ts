import { describe, expect, it } from "vitest";
import { effectiveErrorResolution, type ErrorResolutionRow, type ErrorResolutionContext } from "@/lib/error-resolution";

const context: ErrorResolutionContext = {
  project_id: "p", document_id: "d", field_name: "q", round_id: "round",
  automation_mode: "compare_llm", field_definition: { name: "q", type: "text" },
  llm_response_id: "llm", human_response_id: "human",
  llm_value: { present: true, value: "máquina" },
  human_value: { present: true, value: "humano" },
  source: { kind: "comparacao", id: "review", verdict: "humano" },
};
function row(decision: ErrorResolutionRow["decision"]): ErrorResolutionRow {
  return { id: "resolution", project_id: "p", document_id: "d", field_name: "q",
    resolved_at: "2026-09-14T12:00:00Z", resolved_by: "user", note: null,
    decision, context: structuredClone(context), current_context: structuredClone(context) };
}

describe("resolução explícita de divergência", () => {
  it("aprova o valor LLM sem interpretar texto formatado", () => {
    expect(effectiveErrorResolution(row("llm_correct"))).toMatchObject({ status: "approved", value: "máquina", isLlmError: false });
  });
  it("confirmar humanos continua sendo erro do LLM", () => {
    expect(effectiveErrorResolution(row("researchers_correct"))).toMatchObject({ status: "approved", value: "humano", isLlmError: true });
  });
  it("discussão bloqueia aprovação, em vez de representar ausência de decisão", () => {
    expect(effectiveErrorResolution(row("discussion"))).toEqual({ status: "discussion" });
  });
  it("legado não inventa vencedor e ausência de registro não é legado", () => {
    expect(effectiveErrorResolution({ ...row(null), context: null, current_context: null })).toEqual({ status: "legacy" });
    expect(effectiveErrorResolution(undefined)).toEqual({ status: "open" });
  });
  it.each([null, "", false, 0, [], ["a", "b"]])("preserva o valor tipado %j", (value) => {
    const r = row("llm_correct");
    r.context!.llm_value.value = value;
    r.current_context = structuredClone(r.context);
    expect(effectiveErrorResolution(r)).toMatchObject({ status: "approved", value });
  });
  it("ausência de chave não é valor null aprovado", () => {
    const r = row("llm_correct");
    r.context!.llm_value = { present: false, value: null };
    r.current_context = structuredClone(r.context);
    expect(effectiveErrorResolution(r)).toEqual({ status: "stale" });
  });
  it("ignora ordem de chaves de JSONB, mas não alteração de valor", () => {
    const r = row("llm_correct");
    r.current_context!.source = { verdict: "humano", id: "review", kind: "comparacao" };
    expect(effectiveErrorResolution(r).status).toBe("approved");
    r.current_context!.human_value.value = "alterado";
    expect(effectiveErrorResolution(r)).toEqual({ status: "stale" });
  });
  it.each(["round_id", "llm_response_id", "human_response_id"] as const)("recusa contexto alterado em %s", (key) => {
    const r = row("discussion");
    r.current_context![key] = "novo";
    expect(effectiveErrorResolution(r)).toEqual({ status: "stale" });
  });
  it("fonte removida, campo alterado ou review editado invalida a resolução", () => {
    const r = row("llm_correct");
    expect(effectiveErrorResolution({ ...r, current_context: null })).toEqual({ status: "stale" });
    r.current_context!.field_definition = { name: "q", type: "single" };
    expect(effectiveErrorResolution(r)).toEqual({ status: "stale" });
    r.current_context = structuredClone(r.context);
    r.current_context!.source.verdict = "outro";
    expect(effectiveErrorResolution(r)).toEqual({ status: "stale" });
  });
});
