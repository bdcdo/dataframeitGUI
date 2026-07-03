import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Extrai a message de um erro desconhecido (Error ou string); "" caso contrário.
// Fonte única compartilhada pelo hook de upload e pelas actions de schema.
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : "";
}

// Alterna a presença de um id num Set, sempre copiando (nunca muta o Set
// recebido). `on` explícito serve para uso controlado (ex: checkbox que já
// emite o novo estado); omitido, alterna com base na presença atual.
export function toggleInSet<T>(
  set: Set<T>,
  id: T,
  on: boolean = !set.has(id),
): Set<T> {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

// Normalizacao agressiva para comparar respostas de texto livre que sao
// "iguais" para um humano mas diferem em bytes: acentos decompostos
// (NFD vs NFC, comum em texto colado de PDF), maiusculas e espacos internos
// duplicados. Diacriticos sao removidos — "Adalimumabe" e "adalimumabé"
// passam a comparar igual. Usada por computeDivergentFieldNames (Comparar,
// auto-revisao) e isAnswerCorrect (Gabarito).
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Título de exibição de um documento na fila: título > id externo > 8
// primeiros chars do id interno. Compartilhado por ArbitrationDocList,
// AutoReviewDocList e CompareDocList.
export function resolveDocTitle(
  title: string | null,
  externalId: string | null,
  id: string,
): string {
  return title || externalId || id.slice(0, 8);
}

export function normalizeForComparison(answer: unknown): string {
  if (typeof answer === "string") return JSON.stringify(normalizeText(answer));
  if (Array.isArray(answer))
    return JSON.stringify(
      answer.map((v) => (typeof v === "string" ? normalizeText(v) : v)),
    );
  return JSON.stringify(answer);
}
