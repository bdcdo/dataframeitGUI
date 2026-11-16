import { normalizeForComparison } from "@/lib/utils";
import { buildFieldHashMap, isFieldStale } from "@/lib/answer-staleness";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";
import type {
  ReviewedDocument,
  ReviewedField,
  RespondentAnswer,
} from "./types";
import { buildReviewLookupMaps } from "./lookup-maps";
import { fetchAllAfterId, rowsOrThrow, type PagedRead } from "@/lib/supabase/fetch-all-paged";
import { fetchLatestResponses } from "@/lib/supabase/fetch-latest-responses";
import { effectiveErrorResolution, errorResolutionComment, ERROR_DECISION_LABELS, isBlankAnswer, type ErrorResolutionRow, type EffectiveErrorResolution } from "@/lib/error-resolution";
import { pickValidCellReviews } from "@/lib/review-validity";
import { stableStringify } from "@/lib/schema-utils";
import { isComparedField } from "@/lib/compare-divergence";
import { fetchProfileNames, respondentDisplayName } from "@/lib/respondent-names";

/* ── Raw row shapes ── */

interface ResponseRow {
  id: string;
  document_id: string;
  respondent_id: string | null;
  respondent_type: "humano" | "llm";
  respondent_name: string | null;
  answers: Record<string, unknown>;
  justifications: Record<string, string> | null;
  pydantic_hash: string | null;
  answer_field_hashes: AnswerFieldHashes;
  created_at: string;
}

export interface ReviewRow {
  id: string;
  document_id: string;
  field_name: string;
  verdict: string;
  chosen_response_id: string | null;
  comment: string | null;
  reviewer_id: string | null;
  created_at: string;
  /** `reviews.field_hash`: o hash do campo quando a arbitragem foi feita. */
  field_hash: string | null;
  resolutionLabel?: string;
  resolution?: Extract<EffectiveErrorResolution, { status: "approved" | "discussion" | "upheld" }>;
}

/* ── Context shared across computations ── */

export interface ReviewComputationContext {
  fields: PydanticField[];
  comparableFields: PydanticField[];
  projectPydanticHash: string | null;
  currentFieldHashes: Record<string, string | null>;
  fieldMap: Map<string, PydanticField>;
  docMap: Map<string, string>;
  responsesByDoc: Map<string, ResponseRow[]>;
  uniqueReviews: ReviewRow[];
  errorResolutions?: ErrorResolutionRow[];
}

/* ── Pure helpers ── */

export function isAnswerCorrect(
  answer: unknown,
  verdict: string,
  fieldType: "single" | "multi" | "text" | "date",
): boolean {
  if (verdict === "ambiguo" || verdict === "pular") return true;
  // Votar no grupo em que a resposta está ausente grava o veredito "", e a
  // condicional não acionada chega sem a chave: as formas de vazio concordam.
  // Vale antes de `multi` porque `multi` sem opções é votado como texto, e o
  // voto grava `formatAnswer([])`, que é "".
  if (isBlankAnswer(answer) && isBlankAnswer(verdict)) return true;
  if (fieldType === "multi") return isMultiAnswerCorrect(answer, verdict);
  return normalizeForComparison(answer) === normalizeForComparison(verdict);
}

// Veredito de `multi` é o JSON `{opção: bool}`; veredito ilegível cai na
// igualdade literal.
function isMultiAnswerCorrect(answer: unknown, verdict: string): boolean {
  try {
    const verdictMap = JSON.parse(verdict) as Record<string, boolean>;
    const verdictSet = new Set(
      Object.entries(verdictMap).flatMap(([k, v]) => (v ? [k] : [])),
    );
    const answerArr = Array.isArray(answer) ? answer : [];
    const answerSet = new Set(answerArr.map(String));
    if (verdictSet.size !== answerSet.size) return false;
    for (const v of verdictSet) if (!answerSet.has(v)) return false;
    return true;
  } catch {
    return normalizeForComparison(answer) === normalizeForComparison(verdict);
  }
}

export function formatAnswer(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (Array.isArray(val)) {
    return val
      .flatMap((v) => {
        const s = formatAnswer(v);
        return s !== "" ? [s] : [];
      })
      .join(", ");
  }
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    const parts = Object.entries(obj).flatMap(([k, v]) =>
      v != null && v !== "" ? [`${k}: ${formatAnswer(v)}`] : [],
    );
    return parts.join("; ");
  }
  return String(val);
}

// Resolve o respondente cujas respostas a aba "Meu Gabarito" exibe.
// Só coordenador, criador ou master podem inspecionar as respostas de OUTRO
// respondente (via ?viewAsUser=...); qualquer outro vê as do próprio membro
// canônico do projeto.
// SEGURANÇA: a policy RLS "Members view responses" deixa qualquer membro ler
// todas as responses do projeto (não filtra por respondent_id), então esta
// checagem é a única barreira — por isso o `isCoordinator` que a alimenta é
// fail-closed. Ver reviews/my-verdicts/page.tsx.
export function resolveViewedRespondentId(opts: {
  ownMemberUserId: string;
  isCoordinator: boolean;
  viewAsUser: string | undefined;
}): string {
  const { ownMemberUserId, isCoordinator, viewAsUser } = opts;
  return isCoordinator && viewAsUser ? viewAsUser : ownMemberUserId;
}

function getRespondentKey(r: {
  respondent_id: string | null;
  respondent_name: string | null;
  respondent_type: string;
}) {
  return r.respondent_type === "humano"
    ? r.respondent_id || "unknown"
    : r.respondent_name || "llm";
}

/* ── Fetch base data ── */

/**
 * A review vigente de cada (documento, campo) do Gabarito, pela regra única de
 * `review-validity.ts`: vale o veredito enquanto a pergunta não muda, de
 * qualquer rodada, e entre os válidos da célula o de `pickCellReview`. Célula
 * cujo veredito perdeu a validade sai do Gabarito até ser rearbitrada.
 */
export function gabaritoReviews(
  reviews: ReviewRow[] | null,
  fieldMap: ReadonlyMap<string, PydanticField>,
): ReviewRow[] {
  return [...pickValidCellReviews(reviews, fieldMap).values()];
}

// Lança em vez de devolver a leitura parcial: metade das linhas renderizaria um
// Gabarito com cara de completo.
async function readAllOrThrow<T>(read: PagedRead<T>, what: string): Promise<T[]> {
  return rowsOrThrow(`Não foi possível carregar ${what}`, await read);
}

// As três tabelas são lidas inteiras, página a página: o PostgREST corta cada
// resposta em `max_rows` sem erro, e um `.limit()` acima disso não muda o corte.
export async function fetchReviewBaseData(
  supabase: SupabaseClient,
  projectId: string,
): Promise<ReviewComputationContext> {
  const [
    { data: project, error: projectError },
    responses,
    reviews,
    documents,
    errorResolutions,
    profileNames,
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("pydantic_fields, pydantic_hash, created_by")
      .eq("id", projectId)
      .single(),
    readAllOrThrow(
      fetchLatestResponses<ResponseRow>(
        supabase,
        projectId,
        "respondent_name, answers, justifications, pydantic_hash, answer_field_hashes, created_at",
      ),
      "as respostas",
    ),
    readAllOrThrow(
      fetchAllAfterId<ReviewRow>(() =>
        supabase
          .from("reviews")
          .select(
            "id, document_id, field_name, verdict, chosen_response_id, comment, reviewer_id, created_at, field_hash",
          )
          .eq("project_id", projectId),
      ),
      "as revisões",
    ),
    readAllOrThrow(
      fetchAllAfterId<{ id: string; title: string | null; external_id: string | null }>(() =>
        supabase
          .from("documents")
          .select("id, title, external_id")
          .eq("project_id", projectId)
          .is("excluded_at", null)
          .is("exclusion_pending_at", null),
      ),
      "os documentos",
    ),
    readAllOrThrow(
      fetchAllAfterId<ErrorResolutionRow>(() => supabase.rpc("read_error_resolutions", { p_project_id: projectId })),
      "as decisões",
    ),
    fetchProfileNames(supabase, projectId),
  ]);
  const fields = (project?.pydantic_fields || []) as PydanticField[];
  const projectPydanticHash = project?.pydantic_hash || null;

  const { fieldMap, docMap } = buildReviewLookupMaps(fields, documents);
  const currentFieldHashes = buildFieldHashMap(fields);

  // Sem o projeto não há schema, e todo veredito sairia como de campo removido.
  if (projectError) throw new Error(`Não foi possível carregar o projeto: ${projectError.message}`, { cause: projectError });

  const responsesByDoc = new Map<string, ResponseRow[]>();
  for (const r of responses) {
    const list = responsesByDoc.get(r.document_id) || [];
    list.push({ ...r, respondent_name: respondentDisplayName(r, profileNames) });
    responsesByDoc.set(r.document_id, list);
  }
  // O cursor devolve as respostas na ordem da PK, que é aleatória. A ordem
  // dos respondentes de cada documento na tela segue a de gravação, por
  // instante e não pelo texto do timestamp, como em `pickCellReview`.
  for (const list of responsesByDoc.values()) {
    list.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id < b.id ? -1 : 1));
  }

  const uniqueReviews = gabaritoReviews(reviews, fieldMap);

  const comparableFields = fields.filter(isComparedField);

  return {
    fields,
    comparableFields,
    projectPydanticHash,
    currentFieldHashes,
    fieldMap,
    docMap,
    responsesByDoc,
    uniqueReviews,
    errorResolutions,
  };
}

/* ── Computation: Reviewed Documents ── */

function resolutionVerdict(resolution: NonNullable<ReviewRow["resolution"]>, fieldType: PydanticField["type"]): string {
  if (resolution.status === "discussion") return "ambiguo";
  const value = resolution.status === "upheld" ? resolution.verdictValue : resolution.value;
  if (fieldType === "multi" && Array.isArray(value)) {
    return JSON.stringify(Object.fromEntries(value.map((item) => [String(item), true])));
  }
  return formatAnswer(value);
}

type AppliedResolution = NonNullable<ReviewRow["resolution"]>;

// A linha que a decisão põe no Gabarito, ou `null` quando ela não tem o que
// mostrar ali.
function resolvedReview(
  row: ErrorResolutionRow, resolution: AppliedResolution, fieldType: PydanticField["type"], current: ReviewRow | undefined,
): ReviewRow | null {
  const resolutionLabel = ERROR_DECISION_LABELS[row.decision!];
  if (resolution.status === "upheld" && current) {
    // "Ambos corretos" mantém o veredito da arbitragem como gabarito e só o anota.
    const comment = [current.comment, errorResolutionComment(row)].filter(Boolean).join("\n");
    return { ...current, comment, resolutionLabel, resolution };
  }
  // Sem review válida na célula, "Ambos corretos" só tem veredito a mostrar
  // quando o contexto o guarda (auto-revisão). Na Comparação isso não acontece
  // com a fonte válida, porque a fonte é a própria review da célula; e com a
  // fonte inválida `read_error_resolutions` já não dá contexto corrente à decisão.
  // Inventar um veredito seria pior que omitir a célula.
  if (resolution.status === "upheld" && resolution.verdictValue === undefined) return null;
  return {
    id: row.id, document_id: row.document_id, field_name: row.field_name,
    verdict: resolutionVerdict(resolution, fieldType),
    chosen_response_id: null, comment: errorResolutionComment(row), reviewer_id: row.resolved_by,
    // A linha é da decisão, não de uma review: sem hash de pergunta a conferir,
    // porque a decisão já foi validada contra a definição atual do campo.
    created_at: row.resolved_at, field_hash: null,
    resolutionLabel, resolution,
  };
}

function appliesToGabarito(resolution: EffectiveErrorResolution): resolution is AppliedResolution {
  return resolution.status === "approved" || resolution.status === "discussion" || resolution.status === "upheld";
}

function reviewsWithResolutions(ctx: ReviewComputationContext): Map<string, ReviewRow> {
  const effectiveReviews = new Map(ctx.uniqueReviews.map((r) => [`${r.document_id}:${r.field_name}`, r]));
  for (const row of ctx.errorResolutions ?? []) {
    const resolution = effectiveErrorResolution(row);
    const field = ctx.fieldMap.get(row.field_name);
    if (!field || !ctx.docMap.has(row.document_id) || !appliesToGabarito(resolution)) continue;
    const key = `${row.document_id}:${row.field_name}`;
    const review = resolvedReview(row, resolution, field.type, effectiveReviews.get(key));
    if (review) effectiveReviews.set(key, review);
  }
  return effectiveReviews;
}

function isReviewedAnswerCorrect(answer: unknown, review: ReviewRow, fieldType: PydanticField["type"]): boolean {
  const { resolution } = review;
  if (!resolution) return isAnswerCorrect(answer, review.verdict, fieldType);
  if (resolution.status === "discussion") return false;
  if (resolution.status === "upheld") {
    // `llmValue` é a própria resposta do LLM, e a decisão invalida assim que
    // essa resposta muda (`current_context`), então a igualdade literal basta
    // também em `multi`: não há ordem de array diferente a tolerar.
    return isAnswerCorrect(answer, review.verdict, fieldType) || sameAnswer(answer, resolution.llmValue);
  }
  if (fieldType === "multi") return isAnswerCorrect(answer, review.verdict, fieldType);
  const value = resolution.value;
  return sameAnswer(answer, value);
}

function sameAnswer(answer: unknown, value: unknown): boolean {
  // O branco aprovado é `""`, mas a condicional não acionada chega sem a
  // chave: as formas de vazio são a mesma resposta.
  if (isBlankAnswer(answer) && isBlankAnswer(value)) return true;
  return typeof value === "object" || typeof answer === "object"
    ? stableStringify(answer) === stableStringify(value)
    : normalizeForComparison(answer) === normalizeForComparison(value);
}

export function computeReviewedDocuments(ctx: ReviewComputationContext): ReviewedDocument[] {
  // As reviews chegam na ordem da PK, que é aleatória: os campos de cada
  // documento saem na ordem do schema.
  const fieldOrder = new Map(ctx.fields.map((field, index) => [field.name, index]));
  const reviewsByDoc = new Map<string, ReviewRow[]>();
  reviewsWithResolutions(ctx).forEach((r) => {
    const list = reviewsByDoc.get(r.document_id) || [];
    list.push(r);
    reviewsByDoc.set(r.document_id, list);
  });

  const result: ReviewedDocument[] = [];

  for (const [docId, docReviews] of reviewsByDoc) {
    const docResponses = ctx.responsesByDoc.get(docId) || [];
    const reviewedFields: ReviewedField[] = [];

    docReviews.sort((a, b) => (fieldOrder.get(a.field_name) ?? 0) - (fieldOrder.get(b.field_name) ?? 0));
    for (const review of docReviews) {
      const { resolution } = review;
      const field = ctx.fieldMap.get(review.field_name);
      if (!field) continue;

      const respondentAnswers: RespondentAnswer[] = docResponses.map((r) => {
        const answer = r.answers[review.field_name];
        const stale = isFieldStale({
          answerFieldHashes: r.answer_field_hashes,
          pydanticHash: r.pydantic_hash,
          fieldName: review.field_name,
          currentFieldHashes: ctx.currentFieldHashes,
          projectPydanticHash: ctx.projectPydanticHash,
        });
        const correct = isReviewedAnswerCorrect(answer, review, field.type);
        return {
          respondentKey: getRespondentKey(r),
          respondentName:
            r.respondent_name ||
            (r.respondent_type === "humano" ? "Pesquisador" : "LLM"),
          respondentType: r.respondent_type,
          answer,
          justification: r.justifications?.[review.field_name] || null,
          isCorrect: correct,
          isStale: stale,
        };
      });

      reviewedFields.push({
        fieldName: review.field_name,
        fieldDescription: field.description,
        fieldType: field.type,
        verdict: review.verdict,
        resolutionLabel: review.resolutionLabel,
        // Em "Ambos corretos" o veredito da arbitragem segue valendo, então a
        // tela o lê como qualquer veredito, sem status de resolução.
        resolutionStatus: resolution?.status === "upheld" ? undefined : resolution?.status,
        respondentAnswers,
      });
    }

    if (reviewedFields.length > 0) {
      result.push({
        documentId: docId,
        documentTitle: ctx.docMap.get(docId) || docId,
        fields: reviewedFields,
      });
    }
  }

  result.sort((a, b) => a.documentTitle.localeCompare(b.documentTitle));
  return result;
}
