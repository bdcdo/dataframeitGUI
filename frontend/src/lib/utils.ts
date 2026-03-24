import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function normalizeForComparison(answer: unknown): string {
  if (typeof answer === "string") return JSON.stringify(answer.trim());
  if (Array.isArray(answer))
    return JSON.stringify(answer.map((v) => (typeof v === "string" ? v.trim() : v)));
  return JSON.stringify(answer);
}
