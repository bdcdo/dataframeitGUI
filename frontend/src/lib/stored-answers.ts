// Sanitização das respostas ARMAZENADAS antes de semearem o formulário de
// codificação. Fronteira de leitura, espelho do `dropHiddenConditionals` que o
// `saveResponse` aplica na escrita.
//
// Existia duplicada, verbatim, nos dois modos da aba Codificar: `Explorar` lê
// doc-a-doc via `getDocumentForCoding` (actions/documents.ts) e `Atribuídos` lê
// tudo de uma vez no server (analyze/code/page.tsx). O #252 centralizou a
// metade de condicionais numa primitiva só justamente para as duas fronteiras
// não divergirem; a metade de opções ficou de fora e divergiu (ver o fallback
// de schema ausente abaixo). O par leitura-descarta / escrita-sobrescreve é o
// que produziu a #484.
import { dropHiddenConditionals } from "@/lib/conditional";
import type { PydanticField } from "@/lib/types";

// Campos que o formulário humano exibe. `llm_only`/`none` nunca são semeados:
// não há widget para eles, e devolvê-los ao submit os faria trafegar como se o
// humano os tivesse respondido.
function humanFields(fields: PydanticField[]): PydanticField[] {
  return fields.filter((f) => f.target !== "llm_only" && f.target !== "none");
}

// Valor que ainda pertence às opções atuais do campo, ou `undefined` quando
// nada resta. `single` fora das opções vira `undefined` (o radio não marcaria
// nada); `multi` é filtrado membro a membro e some quando esvazia. Campo sem
// `options` (text/date, ou single/multi ainda sem opções) passa cru.
//
// O que este filtro descarta NÃO é apagado do banco: `saveResponse` remescla o
// valor armazenado no que o formulário devolve (ver `mergeSubmittedAnswers`),
// justamente porque a chave descartada aqui nunca chega ao submit.
function keepIfStillValid(field: PydanticField, value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (!field.options) return value;
  if (field.type === "single") {
    return field.options.includes(value as string) ? value : undefined;
  }
  if (field.type === "multi") {
    const allowed = new Set(field.options);
    const kept = Array.isArray(value)
      ? value.filter((v: unknown): v is string => typeof v === "string" && allowed.has(v))
      : [];
    return kept.length > 0 ? kept : undefined;
  }
  return value;
}

// Respostas prontas para semear o formulário: só campos visíveis ao humano, só
// valores que ainda pertencem às opções atuais, sem condicionais órfãs.
//
// Schema ausente/vazio devolve as respostas cruas (normalizadas para `{}` se
// nulas), em vez de `{}`: sem campos não há como saber o que é válido, e
// fabricar um conjunto vazio seria apagar da tela um dado que existe. Antes da
// extração as duas fronteiras faziam o OPOSTO uma da outra aqui — Explorar
// passava tudo, Atribuídos apagava tudo.
export function sanitizeStoredAnswers(
  allFields: PydanticField[],
  answers: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!answers) return {};
  if (allFields.length === 0) return answers;

  const clean: Record<string, unknown> = {};
  for (const field of humanFields(allFields)) {
    const kept = keepIfStillValid(field, answers[field.name]);
    if (kept !== undefined) clean[field.name] = kept;
  }
  // Avalia a visibilidade sobre o conjunto COMPLETO de campos: uma condição
  // pode referenciar qualquer campo, inclusive um que não semeamos.
  return dropHiddenConditionals(allFields, clean);
}
