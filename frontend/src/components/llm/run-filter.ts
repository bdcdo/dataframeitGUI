export type FilterMode =
  | "all"
  | "pending"
  | "max_responses"
  | "random_sample"
  | "specific";

export interface RunFilter {
  mode: FilterMode;
  sampleSize: number | null;
  maxResponseCount: number | null;
  selectedDocumentIds: string[];
}

export const MAX_SAMPLE_SIZE = 10_000;
export const MAX_RESPONSE_COUNT = 1_000;

export function isIntegerInRange(
  value: number | null,
  min: number,
  max: number,
): value is number {
  return (
    value !== null && Number.isInteger(value) && value >= min && value <= max
  );
}

export function getFilterValidationError({
  mode,
  sampleSize,
  maxResponseCount,
}: RunFilter): string | null {
  if (
    mode === "random_sample" &&
    !isIntegerInRange(sampleSize, 1, MAX_SAMPLE_SIZE)
  ) {
    return `Informe um número inteiro entre 1 e ${MAX_SAMPLE_SIZE.toLocaleString("pt-BR")} documentos.`;
  }
  if (
    mode === "max_responses" &&
    !isIntegerInRange(maxResponseCount, 0, MAX_RESPONSE_COUNT)
  ) {
    return `Informe um número inteiro entre 0 e ${MAX_RESPONSE_COUNT.toLocaleString("pt-BR")} respostas LLM.`;
  }
  return null;
}
