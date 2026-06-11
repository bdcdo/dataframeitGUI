// Primitivas puras do sorteio de atribuições (spec 001), compartilhadas
// entre o client (contagem ao vivo no LotteryDialog) e o server
// (computeLottery) — fonte única de verdade da elegibilidade, no padrão
// anti-drift de schema-utils.ts (cf. #63).

export type LotteryMode = "append" | "replace";
export type LotteryBalancing = "round" | "history";
export type AssignmentFilter = "any" | "noActiveOfType" | "neverAssigned";

export interface LotteryFilters {
  /** undefined = todos; 0 = sem nenhuma codificação; N = no máximo N */
  maxHumanCodings?: number;
  /** default "any" */
  assignmentFilter?: AssignmentFilter;
  batchFilter?: { exclude?: string[]; only?: string };
  manualDocIds?: string[];
}

export interface LotteryDocStats {
  id: string;
  externalId: string | null;
  title: string | null;
  /** respondentes humanos distintos com resposta is_latest */
  humanCodingCount: number;
  /** pendente + em_andamento, por tipo */
  activeAssignments: { codificacao: number; comparacao: number };
  hasAnyAssignmentEver: boolean;
  batchIds: string[];
}

export interface LotteryParticipant {
  id: string;
  /** atribuições do tipo no conjunto preservado do modo */
  accumulatedLoad: number;
  /** docsPerResearcher - accumulatedLoad, ou Infinity */
  capacity: number;
}

/**
 * Pipeline de elegibilidade — interseção em ordem fixa (data-model.md):
 * ativos (garantido no fetch) → manual → codificações → status de
 * atribuição → lote. A exigência mínima de respostas para comparação é
 * aplicada antes, no server, e compõe com estes filtros (FR-011).
 */
export function filterEligibleDocs(
  docs: LotteryDocStats[],
  type: "codificacao" | "comparacao",
  filters: LotteryFilters,
): LotteryDocStats[] {
  let result = docs;

  if (filters.manualDocIds) {
    const manual = new Set(filters.manualDocIds);
    result = result.filter((d) => manual.has(d.id));
  }

  if (filters.maxHumanCodings !== undefined) {
    result = result.filter((d) => d.humanCodingCount <= filters.maxHumanCodings!);
  }

  const assignmentFilter = filters.assignmentFilter ?? "any";
  if (assignmentFilter === "noActiveOfType") {
    result = result.filter((d) => d.activeAssignments[type] === 0);
  } else if (assignmentFilter === "neverAssigned") {
    result = result.filter((d) => !d.hasAnyAssignmentEver);
  }

  if (filters.batchFilter?.only) {
    const only = filters.batchFilter.only;
    result = result.filter((d) => d.batchIds.includes(only));
  } else if (filters.batchFilter?.exclude?.length) {
    const excluded = new Set(filters.batchFilter.exclude);
    result = result.filter((d) => !d.batchIds.some((b) => excluded.has(b)));
  }

  return result;
}

/**
 * PRNG seedado (mulberry32) — toda a aleatoriedade do sorteio deriva dele,
 * permitindo que a prévia e a execução compartilhem a semente e produzam
 * o mesmo resultado (research D13, FR-013/SC-005).
 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates com RNG injetável; não muta o array de entrada. */
export function shuffleWithRng<T>(arr: T[], rng: () => number): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
