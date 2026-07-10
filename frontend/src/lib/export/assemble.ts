// Montagem pura e testável dos datasets de export (feature 004), portada do RSC
// reviews/export/page.tsx. Sem I/O: recebe as linhas cruas do Supabase e devolve
// as visões Documentos/Respostas/Gabarito + o CSV unificado já como string[][].
//
// Decisões de design (ver data-model.md §3):
// - A BASE é a tabela documents (não as respostas): identidade e título de cada
//   documento vêm daí (document_id = external_id || id), de forma consistente em
//   TODAS as visões — assim o XLSX cruza abas pelo mesmo id. Respostas e reviews
//   de documentos fora da base (ex.: excluídos) são descartados (achado C1).
// - Colunas originais: união preservando a ordem do CSV, docs por created_at asc.
// - Colisão de nome de coluna original com controle/campo do schema → original_<nome>.

import type { DocumentMetadata, PydanticField } from "@/lib/types";
import { normalizeForComparison } from "@/lib/utils";
import { formatExportValue, formatVerdict } from "./format";

export interface ExportSheet {
  headers: string[];
  rows: string[][];
}

export interface ExportDataset {
  projectName: string;
  documents: ExportSheet;
  responses: ExportSheet;
  verdicts: ExportSheet;
  csv: ExportSheet;
}

export interface ExportDocument {
  id: string;
  external_id: string | null;
  title: string | null;
  created_at: string;
  metadata: DocumentMetadata | null;
}

export interface ExportResponse {
  document_id: string;
  respondent_name: string | null;
  respondent_type: string;
  answers: Record<string, unknown> | null;
}

export interface ExportReview {
  document_id: string;
  field_name: string;
  verdict: string;
  comment: string | null;
}

export interface AssembleInput {
  projectName: string;
  fields: PydanticField[];
  minResponses: number;
  documents: ExportDocument[];
  responses: ExportResponse[];
  reviews: ExportReview[];
}

// Colunas de controle do CSV unificado + reviewer_comments. Formam, junto dos
// nomes dos campos do schema, o conjunto "reservado" contra o qual as colunas
// originais podem colidir (data-model §3.5).
const CONTROL_COLUMNS = [
  "document_id",
  "document_title",
  "respondent",
  "respondent_type",
  "source",
] as const;
const REVIEWER_COMMENTS = "reviewer_comments";

// Resolve os cabeçalhos exibidos das colunas originais garantindo unicidade:
// colidiu com um nome reservado → prefixo `original_`; se o resultado ainda
// estiver tomado (ex.: já existe uma coluna literal `original_x`), acrescenta
// sufixo numérico `_2`, `_3`... O mapeamento é posicional com `rawCols`.
export function resolveOriginalHeaders(
  rawCols: string[],
  reserved: Set<string>
): string[] {
  const taken = new Set(reserved);
  return rawCols.map((col) => {
    let name = reserved.has(col) ? `original_${col}` : col;
    if (taken.has(name)) {
      let n = 2;
      while (taken.has(`${name}_${n}`)) n++;
      name = `${name}_${n}`;
    }
    taken.add(name);
    return name;
  });
}

interface DocIdentity {
  displayId: string;
  title: string;
}

interface VerdictEntry {
  fields: Map<string, string>;
  comments: string[];
}

// Identidade e título de cada documento derivam da base (document_id =
// external_id || id), consistentes em todas as visões.
function buildIdentity(baseDocs: ExportDocument[]): Map<string, DocIdentity> {
  return new Map(
    baseDocs.map((d) => [
      d.id,
      { displayId: d.external_id || d.id, title: d.title || "" },
    ])
  );
}

// União ordenada das colunas originais cruas (docs por created_at asc já
// ordenados; primeira aparição vence).
function unionOriginalColumns(baseDocs: ExportDocument[]): string[] {
  const union: string[] = [];
  const seen = new Set<string>();
  for (const d of baseDocs) {
    for (const col of d.metadata?.original_columns ?? []) {
      if (!seen.has(col)) {
        seen.add(col);
        union.push(col);
      }
    }
  }
  return union;
}

// Agrupa os veredictos do revisor por documento (valor formatado + comentários).
function buildVerdictsByDoc(reviews: ExportReview[]): Map<string, VerdictEntry> {
  const byDoc = new Map<string, VerdictEntry>();
  for (const r of reviews) {
    let entry = byDoc.get(r.document_id);
    if (!entry) {
      entry = { fields: new Map(), comments: [] };
      byDoc.set(r.document_id, entry);
    }
    entry.fields.set(r.field_name, formatVerdict(r.verdict));
    if (r.comment) entry.comments.push(`[${r.field_name}] ${r.comment}`);
  }
  return byDoc;
}

// Campo multi concorda quando todas as respostas coincidem na seleção de cada
// opção comparável (as do schema mais as efetivamente marcadas).
function multiFieldAgrees(
  docResponses: ExportResponse[],
  fieldName: string,
  options: string[]
): boolean {
  const comparableOptions = new Set(options);
  const responseSets = docResponses.map((r) => {
    const arr = r.answers?.[fieldName];
    return new Set(
      Array.isArray(arr)
        ? arr.filter((v): v is string => typeof v === "string")
        : []
    );
  });
  for (const set of responseSets) for (const v of set) comparableOptions.add(v);
  for (const opt of comparableOptions) {
    const selections = responseSets.map((s) => s.has(opt));
    if (!selections.every((s) => s === selections[0])) return false;
  }
  return true;
}

// Valor concordante de um campo entre as respostas de um documento, ou null se
// houver divergência. Multi compara conjuntos de opções; demais tipos usam
// normalizeForComparison.
function fieldAgreementValue(
  docResponses: ExportResponse[],
  fieldName: string,
  fullField: PydanticField | undefined
): string | null {
  if (fullField?.type === "multi" && fullField.options?.length) {
    return multiFieldAgrees(docResponses, fieldName, fullField.options)
      ? formatExportValue(docResponses[0].answers?.[fieldName])
      : null;
  }
  const answers = docResponses.map((r) => r.answers?.[fieldName]);
  const unique = new Set(answers.map((a) => normalizeForComparison(a)));
  return unique.size === 1 ? formatExportValue(answers[0]) : null;
}

// Campos concordantes de UM documento que o revisor não marcou explicitamente.
function docAgreements(
  docResponses: ExportResponse[],
  exportableFields: PydanticField[],
  fieldByName: Map<string, PydanticField>,
  reviewedFields: Map<string, string> | undefined
): Map<string, string> {
  const agreements = new Map<string, string>();
  for (const field of exportableFields) {
    if (reviewedFields?.has(field.name)) continue;
    const value = fieldAgreementValue(
      docResponses,
      field.name,
      fieldByName.get(field.name)
    );
    if (value !== null) agreements.set(field.name, value);
  }
  return agreements;
}

// Auto-fill: para cada documento com respostas suficientes, os campos em que
// todas as respostas concordam e que o revisor NÃO marcou explicitamente.
function buildAgreementByDoc(
  baseResponses: ExportResponse[],
  exportableFields: PydanticField[],
  fieldByName: Map<string, PydanticField>,
  verdictsByDoc: Map<string, VerdictEntry>,
  minResponses: number
): Map<string, Map<string, string>> {
  const responsesByDoc = new Map<string, ExportResponse[]>();
  for (const r of baseResponses) {
    const list = responsesByDoc.get(r.document_id);
    if (list) list.push(r);
    else responsesByDoc.set(r.document_id, [r]);
  }

  const agreementByDoc = new Map<string, Map<string, string>>();
  for (const [docId, docResponses] of responsesByDoc) {
    if (docResponses.length < minResponses) continue;
    const agreements = docAgreements(
      docResponses,
      exportableFields,
      fieldByName,
      verdictsByDoc.get(docId)?.fields
    );
    if (agreements.size > 0) agreementByDoc.set(docId, agreements);
  }
  return agreementByDoc;
}

export function assembleExport(input: AssembleInput): ExportDataset {
  const { projectName, fields, minResponses, documents, responses, reviews } =
    input;

  const exportableFields = fields.filter(
    (f) => f.target !== "llm_only" && f.target !== "none"
  );
  const fieldNames = exportableFields.map((f) => f.name);

  // Base ordenada de forma determinística (created_at asc, id como desempate).
  const baseDocs = [...documents].sort((a, b) => {
    if (a.created_at !== b.created_at)
      return a.created_at < b.created_at ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const docById = new Map(baseDocs.map((d) => [d.id, d]));
  const identity = buildIdentity(baseDocs);

  const unionRaw = unionOriginalColumns(baseDocs);
  const reserved = new Set<string>([
    ...CONTROL_COLUMNS,
    REVIEWER_COMMENTS,
    ...fieldNames,
  ]);
  const originalHeaders = resolveOriginalHeaders(unionRaw, reserved);
  const originalCells = (docId: string): string[] => {
    const row = docById.get(docId)?.metadata?.original_row ?? {};
    return unionRaw.map((col) => row[col] ?? "");
  };

  // Filtragem à base (achado C1): descarta respostas/reviews de docs fora dela.
  const baseResponses = responses.filter((r) => identity.has(r.document_id));
  const baseReviews = reviews.filter((r) => identity.has(r.document_id));

  const verdictsByDoc = buildVerdictsByDoc(baseReviews);
  const fieldByName = new Map<string, PydanticField>();
  for (const f of fields) if (!fieldByName.has(f.name)) fieldByName.set(f.name, f);
  const agreementByDoc = buildAgreementByDoc(
    baseResponses,
    exportableFields,
    fieldByName,
    verdictsByDoc,
    minResponses
  );

  // Documentos com gabarito (veredicto OU concordância), na ordem da base.
  const gabaritoIds = baseDocs
    .map((d) => d.id)
    .filter((id) => verdictsByDoc.has(id) || agreementByDoc.has(id));
  const gabaritoSet = new Set(gabaritoIds);

  // Prioridade por campo: veredicto do revisor > concordância > vazio.
  const verdictFieldValue = (docId: string, fieldName: string): string =>
    verdictsByDoc.get(docId)?.fields.get(fieldName) ??
    agreementByDoc.get(docId)?.get(fieldName) ??
    "";

  const sourceOf = (respondentType: string): string =>
    respondentType === "llm" ? "llm" : "codificacao";
  const responseFieldCells = (r: ExportResponse): string[] =>
    exportableFields.map((f) => formatExportValue(r.answers?.[f.name]));
  const verdictFieldCells = (docId: string): string[] =>
    fieldNames.map((name) => verdictFieldValue(docId, name));

  // --- Visão Documentos ---
  const documentsSheet: ExportSheet = {
    headers: ["document_id", "document_title", ...originalHeaders],
    rows: baseDocs.map((d) => {
      const info = identity.get(d.id)!;
      return [info.displayId, info.title, ...originalCells(d.id)];
    }),
  };

  // --- Visão Respostas individuais ---
  const responsesSheet: ExportSheet = {
    headers: [
      "document_id",
      "document_title",
      "respondent",
      "respondent_type",
      "source",
      ...fieldNames,
    ],
    rows: baseResponses.map((r) => {
      const info = identity.get(r.document_id)!;
      return [
        info.displayId,
        info.title,
        r.respondent_name || "",
        r.respondent_type,
        sourceOf(r.respondent_type),
        ...responseFieldCells(r),
      ];
    }),
  };

  // --- Visão Gabarito ---
  const verdictsSheet: ExportSheet = {
    headers: [
      "document_id",
      "document_title",
      "source",
      ...fieldNames,
      REVIEWER_COMMENTS,
    ],
    rows: gabaritoIds.map((docId) => {
      const info = identity.get(docId)!;
      return [
        info.displayId,
        info.title,
        "comparacao",
        ...verdictFieldCells(docId),
        (verdictsByDoc.get(docId)?.comments ?? []).join(" | "),
      ];
    }),
  };

  // --- CSV unificado: respostas + gabaritos + documentos órfãos ---
  const docsWithResponse = new Set(baseResponses.map((r) => r.document_id));
  const responseCsvRows = baseResponses.map((r) => {
    const info = identity.get(r.document_id)!;
    return [
      info.displayId,
      info.title,
      r.respondent_name || "",
      r.respondent_type,
      sourceOf(r.respondent_type),
      ...originalCells(r.document_id),
      ...responseFieldCells(r),
      "",
    ];
  });
  const verdictCsvRows = gabaritoIds.map((docId) => {
    const info = identity.get(docId)!;
    return [
      info.displayId,
      info.title,
      "",
      "",
      "comparacao",
      ...originalCells(docId),
      ...verdictFieldCells(docId),
      (verdictsByDoc.get(docId)?.comments ?? []).join(" | "),
    ];
  });
  // Linha source=documento apenas para documentos SEM resposta E SEM gabarito.
  const documentoCsvRows = baseDocs
    .filter((d) => !docsWithResponse.has(d.id) && !gabaritoSet.has(d.id))
    .map((d) => {
      const info = identity.get(d.id)!;
      return [
        info.displayId,
        info.title,
        "",
        "",
        "documento",
        ...originalCells(d.id),
        ...fieldNames.map(() => ""),
        "",
      ];
    });

  const csvSheet: ExportSheet = {
    headers: [
      ...CONTROL_COLUMNS,
      ...originalHeaders,
      ...fieldNames,
      REVIEWER_COMMENTS,
    ],
    rows: [...responseCsvRows, ...verdictCsvRows, ...documentoCsvRows],
  };

  return {
    projectName,
    documents: documentsSheet,
    responses: responsesSheet,
    verdicts: verdictsSheet,
    csv: csvSheet,
  };
}
