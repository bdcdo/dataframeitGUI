// Funcoes puras de classificacao de respostas LLM. Separadas de
// LlmResponseRow.tsx (que e "use client" e importa React) para serem
// testaveis em vitest com environment: "node".
//
// IMPORTANTE: a regra de classificacao espelha _answers_have_content no
// backend (services/llm_runner.py). Divergencia aqui deixa counters live
// inconsistentes com badges. Mudou aqui? Atualize o backend tambem.

import type { LlmResponseRecord } from "@/actions/llm";

export type ResponseStatus = "complete" | "partial" | "empty";

export function classifyResponse(r: LlmResponseRecord): ResponseStatus {
  const entries = Object.entries(r.answers ?? {});
  const hasValue = entries.some(([, v]) => {
    if (v == null) return false;
    if (typeof v === "string") return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v).length > 0;
    return true;
  });
  if (!hasValue) return "empty";
  return r.is_partial ? "partial" : "complete";
}
