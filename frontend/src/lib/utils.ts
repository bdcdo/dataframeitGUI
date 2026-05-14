import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
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

export function normalizeForComparison(answer: unknown): string {
  if (typeof answer === "string") return JSON.stringify(normalizeText(answer));
  if (Array.isArray(answer))
    return JSON.stringify(
      answer.map((v) => (typeof v === "string" ? normalizeText(v) : v)),
    );
  return JSON.stringify(answer);
}
