#!/usr/bin/env -S npx tsx
/**
 * generate.ts
 *
 * Gera um relatório Markdown dos erros LLM que continuam ABERTOS num projeto
 * dataframeitGUI, agrupados por pergunta (campo Pydantic). Para cada pergunta
 * inclui distribuição das respostas humanas, todos os comentários (abertos +
 * fechados) e detalhes de cada erro com contexto do documento.
 *
 * Uso:
 *   cd frontend
 *   npx tsx scripts/erros-llm-relatorio/generate.ts \
 *     [--project-id <uuid>] [--project-name <fragmento>] [--list] [--out <path>]
 *
 * Sem --project-id/--project-name → lista projetos (não gera nada).
 * Saída padrão: ../docs/erros-llm/{slug}-{YYYYMMDD}.md
 *
 * Requer NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (lidos de
 * frontend/.env.local).
 *
 * Espelha a lógica de
 * frontend/src/app/(app)/projects/[id]/reviews/llm-insights/page.tsx (mesmas
 * suppressões: target=none|llm_only, response_equivalences, sameContent).
 */

import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ─────────────────────────── env loader ───────────────────────────

function loadEnv() {
  const cwd = process.cwd();
  const candidates = [
    resolve(cwd, ".env.local"),
    resolve(cwd, "frontend/.env.local"),
    resolve(cwd, "../.env.local"),
  ];
  for (const path of candidates) {
    try {
      const content = readFileSync(path, "utf-8");
      for (const line of content.split("\n")) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (!m) continue;
        const key = m[1];
        if (process.env[key]) continue;
        let val = m[2].trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
      return;
    } catch {
      /* try next */
    }
  }
}

loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Faltam NEXT_PUBLIC_SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY. Rode de dentro de frontend/ ou defina as vars manualmente.",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ─────────────────────────── tipos ───────────────────────────

interface PydanticField {
  name: string;
  type: "single" | "multi" | "text" | "date";
  description: string;
  help_text?: string;
  options?: string[] | null;
  target?: "all" | "llm_only" | "human_only" | "none";
  required?: boolean;
  subfields?: Array<{ key: string; label: string }>;
}

interface LlmError {
  documentId: string;
  documentTitle: string;
  fieldName: string;
  llmAnswer: string;
  llmJustification: string | null;
  chosenVerdict: string;
  reviewerComment: string | null;
  reviewerName: string | null;
  reviewedAt: string;
  schemaVersion: string | null;
  llmResponseId: string;
  chosenResponseId: string | null;
}

interface HumanAnswerSample {
  documentId: string;
  documentTitle: string;
  respondentName: string;
  answer: unknown;
  justification: string | null;
}

interface CommentEntry {
  source: "review" | "anotacao" | "duvida";
  text: string;
  author: string;
  createdAt: string;
  resolvedAt: string | null;
  documentTitle: string | null;
  extra?: string;
}

interface FieldGroup {
  field: PydanticField;
  errors: LlmError[];
  totalReviewed: number;
  humanAnswers: HumanAnswerSample[];
  comments: CommentEntry[];
}

// ─────────────────────────── helpers ───────────────────────────

function normalizeForComparison(answer: unknown): string {
  if (typeof answer === "string") return JSON.stringify(answer.trim());
  if (Array.isArray(answer))
    return JSON.stringify(
      answer.map((v) => (typeof v === "string" ? v.trim() : v)),
    );
  return JSON.stringify(answer);
}

function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function formatAnswer(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (Array.isArray(val)) {
    return val
      .map((v) => formatAnswer(v))
      .filter((s) => s !== "")
      .join(", ");
  }
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    const parts = Object.entries(obj)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k}: ${formatAnswer(v)}`);
    return parts.join("; ");
  }
  return String(val);
}

function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function todayYYYYMMDD(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function formatDate(iso: string): string {
  // YYYY-MM-DD HH:mm
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function escapeMd(s: string | null | undefined): string {
  if (s == null) return "";
  return s.replace(/\|/g, "\\|");
}

function blockquote(text: string): string {
  // Quote multiline blocks line-by-line.
  return text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

// ─────────────────────────── CLI ───────────────────────────

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") out.list = true;
    else if (a === "--project-id" || a === "--id") out.projectId = argv[++i];
    else if (a === "--project-name" || a === "--name")
      out.projectName = argv[++i];
    else if (a === "--out" || a === "-o") out.out = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

async function listProjects() {
  const { data, error } = await supabase
    .from("projects")
    .select(
      "id, name, created_at, schema_version_major, schema_version_minor, schema_version_patch",
    )
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function resolveProject(args: Record<string, string | boolean>) {
  if (typeof args.projectId === "string") {
    const { data, error } = await supabase
      .from("projects")
      .select(
        "id, name, created_by, pydantic_fields, schema_version_major, schema_version_minor, schema_version_patch",
      )
      .eq("id", args.projectId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`Projeto ${args.projectId} não encontrado`);
    return data;
  }
  if (typeof args.projectName === "string") {
    const { data, error } = await supabase
      .from("projects")
      .select(
        "id, name, created_by, pydantic_fields, schema_version_major, schema_version_minor, schema_version_patch",
      )
      .ilike("name", `%${args.projectName}%`)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    if (!data || data.length === 0)
      throw new Error(`Nenhum projeto corresponde a "${args.projectName}"`);
    if (data.length > 1) {
      throw new Error(
        `Múltiplos projetos correspondem a "${args.projectName}": ${data
          .map((p) => `${p.name} (${p.id})`)
          .join(", ")}. Use --project-id.`,
      );
    }
    return data[0];
  }
  return null;
}

// ─────────────────────────── fetch ───────────────────────────

async function fetchAll(projectId: string) {
  const [
    llmResponses,
    humanResponses,
    reviews,
    documents,
    errorResolutions,
    equivalencePairs,
    projectComments,
    verdictQuestions,
  ] = await Promise.all([
    supabase
      .from("responses")
      .select(
        "id, document_id, answers, justifications, respondent_name, schema_version_major, schema_version_minor, schema_version_patch",
      )
      .eq("project_id", projectId)
      .eq("respondent_type", "llm")
      .eq("is_current", true),
    supabase
      .from("responses")
      .select(
        "id, document_id, respondent_id, respondent_name, answers, justifications, created_at, is_current",
      )
      .eq("project_id", projectId)
      .eq("respondent_type", "humano")
      .eq("is_current", true),
    supabase
      .from("reviews")
      .select(
        "id, document_id, field_name, verdict, chosen_response_id, comment, resolved_at, reviewer_id, created_at",
      )
      .eq("project_id", projectId)
      .not("chosen_response_id", "is", null),
    supabase
      .from("documents")
      .select("id, title, external_id")
      .eq("project_id", projectId),
    supabase
      .from("error_resolutions")
      .select("document_id, field_name, resolved_at")
      .eq("project_id", projectId),
    supabase
      .from("response_equivalences")
      .select("document_id, field_name, response_a_id, response_b_id")
      .eq("project_id", projectId),
    supabase
      .from("project_comments")
      .select(
        "id, document_id, field_name, author_id, body, parent_id, resolved_at, created_at",
      )
      .eq("project_id", projectId),
    supabase
      .from("verdict_acknowledgments")
      .select(
        "review_id, respondent_id, comment, resolved_at, status, created_at, reviews!inner(id, project_id, document_id, field_name, verdict)",
      )
      .eq("reviews.project_id", projectId)
      .not("comment", "is", null),
  ]);

  // Erros explícitos:
  for (const r of [
    llmResponses,
    humanResponses,
    reviews,
    documents,
    errorResolutions,
    equivalencePairs,
    projectComments,
    verdictQuestions,
  ]) {
    if (r.error) throw new Error(r.error.message);
  }

  // Resolver perfis (reviewer_id, respondent_id, author_id).
  const profileIds = new Set<string>();
  reviews.data?.forEach(
    (r) => r.reviewer_id && profileIds.add(r.reviewer_id as string),
  );
  humanResponses.data?.forEach(
    (r) => r.respondent_id && profileIds.add(r.respondent_id as string),
  );
  projectComments.data?.forEach(
    (c) => c.author_id && profileIds.add(c.author_id as string),
  );
  (verdictQuestions.data ?? []).forEach((q) => {
    const respondentId = (q as Record<string, unknown>).respondent_id;
    if (typeof respondentId === "string") profileIds.add(respondentId);
  });

  let profileMap = new Map<string, string>();
  if (profileIds.size > 0) {
    const { data: profiles, error: profError } = await supabase
      .from("profiles")
      .select("id, email, first_name, last_name")
      .in("id", Array.from(profileIds));
    if (profError) throw new Error(profError.message);
    profileMap = new Map(
      (profiles ?? []).map((p) => {
        const name =
          [p.first_name, p.last_name].filter(Boolean).join(" ") ||
          (p.email ? String(p.email).split("@")[0] : "Anônimo");
        return [p.id as string, name];
      }),
    );
  }

  return {
    llmResponses: llmResponses.data ?? [],
    humanResponses: humanResponses.data ?? [],
    reviews: reviews.data ?? [],
    documents: documents.data ?? [],
    errorResolutions: errorResolutions.data ?? [],
    equivalencePairs: equivalencePairs.data ?? [],
    projectComments: projectComments.data ?? [],
    verdictQuestions: verdictQuestions.data ?? [],
    profileMap,
  };
}

// ─────────────────────────── compute ───────────────────────────

interface ProjectInfo {
  id: string;
  name: string;
  schemaVersion: string;
  pydanticFields: PydanticField[];
}

function computeOpenErrors(
  data: Awaited<ReturnType<typeof fetchAll>>,
  fields: PydanticField[],
): { errors: LlmError[]; reviewedByField: Map<string, number> } {
  const fieldMap = new Map(fields.map((f) => [f.name, f]));
  const docMap = new Map(
    data.documents.map((d) => [
      d.id as string,
      (d.title || d.external_id || d.id) as string,
    ]),
  );

  const llmByDoc = new Map<
    string,
    {
      id: string;
      answers: Record<string, unknown>;
      justifications: Record<string, string> | null;
      respondent_name: string | null;
      schemaVersion: string | null;
    }
  >();
  for (const r of data.llmResponses) {
    const v =
      r.schema_version_major != null &&
      r.schema_version_minor != null &&
      r.schema_version_patch != null
        ? `${r.schema_version_major}.${r.schema_version_minor}.${r.schema_version_patch}`
        : null;
    llmByDoc.set(r.document_id as string, {
      id: r.id as string,
      answers: r.answers as Record<string, unknown>,
      justifications: r.justifications as Record<string, string> | null,
      respondent_name: r.respondent_name as string | null,
      schemaVersion: v,
    });
  }

  const errorResolvedSet = new Set(
    data.errorResolutions.map(
      (r) => `${r.document_id}:${r.field_name}` as string,
    ),
  );

  const equivPairSet = new Set<string>();
  for (const p of data.equivalencePairs) {
    const [a, b] = canonicalPair(
      p.response_a_id as string,
      p.response_b_id as string,
    );
    equivPairSet.add(`${p.document_id}:${p.field_name}:${a}|${b}`);
  }

  const errors: LlmError[] = [];
  const reviewedByField = new Map<string, number>();

  for (const review of data.reviews) {
    const docId = review.document_id as string;
    const fieldName = review.field_name as string;
    const llmResp = llmByDoc.get(docId);
    if (!llmResp) continue;

    const field = fieldMap.get(fieldName);
    if (!field || field.target === "none" || field.target === "llm_only")
      continue;

    if (review.chosen_response_id !== llmResp.id) {
      const llmAnswer = llmResp.answers?.[fieldName];
      const sameContent =
        normalizeForComparison(llmAnswer) ===
        normalizeForComparison(review.verdict);

      let markedEquivalent = false;
      if (review.chosen_response_id) {
        const [a, b] = canonicalPair(
          llmResp.id,
          review.chosen_response_id as string,
        );
        markedEquivalent = equivPairSet.has(`${docId}:${fieldName}:${a}|${b}`);
      }

      if (!sameContent && !markedEquivalent) {
        const isOpen = !errorResolvedSet.has(`${docId}:${fieldName}`);
        if (isOpen) {
          const reviewerId = review.reviewer_id as string | null;
          errors.push({
            documentId: docId,
            documentTitle: docMap.get(docId) || docId,
            fieldName,
            llmAnswer: formatAnswer(llmAnswer),
            llmJustification:
              llmResp.justifications?.[fieldName] || null,
            chosenVerdict: review.verdict as string,
            reviewerComment: (review.comment as string | null) || null,
            reviewerName: reviewerId
              ? data.profileMap.get(reviewerId) || null
              : null,
            reviewedAt: review.created_at as string,
            schemaVersion: llmResp.schemaVersion,
            llmResponseId: llmResp.id,
            chosenResponseId: review.chosen_response_id as string | null,
          });
        }
      }
    }

    reviewedByField.set(fieldName, (reviewedByField.get(fieldName) || 0) + 1);
  }

  errors.sort((a, b) => {
    if (a.fieldName !== b.fieldName)
      return a.fieldName.localeCompare(b.fieldName);
    return a.documentTitle.localeCompare(b.documentTitle);
  });
  return { errors, reviewedByField };
}

function aggregateByField(
  errors: LlmError[],
  reviewedByField: Map<string, number>,
  data: Awaited<ReturnType<typeof fetchAll>>,
  fields: PydanticField[],
): FieldGroup[] {
  const fieldMap = new Map(fields.map((f) => [f.name, f]));
  const docMap = new Map(
    data.documents.map((d) => [
      d.id as string,
      (d.title || d.external_id || d.id) as string,
    ]),
  );

  const groups = new Map<string, FieldGroup>();

  // Init groups for fields with errors.
  const fieldsWithErrors = new Set(errors.map((e) => e.fieldName));
  for (const fieldName of fieldsWithErrors) {
    const f = fieldMap.get(fieldName);
    if (!f) continue;
    groups.set(fieldName, {
      field: f,
      errors: [],
      totalReviewed: reviewedByField.get(fieldName) || 0,
      humanAnswers: [],
      comments: [],
    });
  }

  for (const e of errors) groups.get(e.fieldName)?.errors.push(e);

  // Distribuição: percorrer respostas humanas atuais.
  for (const r of data.humanResponses) {
    const answers = r.answers as Record<string, unknown> | null;
    const justifications = r.justifications as Record<string, string> | null;
    if (!answers) continue;
    for (const [fieldName, group] of groups) {
      if (!(fieldName in answers)) continue;
      const respondentName =
        (r.respondent_id &&
          data.profileMap.get(r.respondent_id as string)) ||
        (r.respondent_name as string | null) ||
        "Pesquisador";
      group.humanAnswers.push({
        documentId: r.document_id as string,
        documentTitle: docMap.get(r.document_id as string) || (r.document_id as string),
        respondentName,
        answer: answers[fieldName],
        justification: justifications?.[fieldName] || null,
      });
    }
  }

  // Comentários de review (mesmo fechados, com texto).
  for (const r of data.reviews) {
    const fieldName = r.field_name as string;
    const group = groups.get(fieldName);
    if (!group) continue;
    const text = (r.comment as string | null) || null;
    if (!text || !text.trim()) continue;
    const reviewerId = r.reviewer_id as string | null;
    group.comments.push({
      source: "review",
      text: text.trim(),
      author: reviewerId
        ? data.profileMap.get(reviewerId) || "Anônimo"
        : "Anônimo",
      createdAt: r.created_at as string,
      resolvedAt: (r.resolved_at as string | null) || null,
      documentTitle: docMap.get(r.document_id as string) || null,
      extra: `veredito: ${formatAnswer(r.verdict)}`,
    });
  }

  // project_comments — todos (root e filhos).
  for (const c of data.projectComments) {
    const fieldName = c.field_name as string | null;
    if (!fieldName) continue;
    const group = groups.get(fieldName);
    if (!group) continue;
    const text = (c.body as string | null) || null;
    if (!text || !text.trim()) continue;
    const authorId = c.author_id as string | null;
    group.comments.push({
      source: "anotacao",
      text: text.trim(),
      author: authorId
        ? data.profileMap.get(authorId) || "Anônimo"
        : "Anônimo",
      createdAt: c.created_at as string,
      resolvedAt: (c.resolved_at as string | null) || null,
      documentTitle: c.document_id
        ? docMap.get(c.document_id as string) || null
        : null,
      extra: c.parent_id ? "resposta em thread" : undefined,
    });
  }

  // verdict_acknowledgments — todos (status='questioned' com texto).
  for (const q of data.verdictQuestions as unknown as Array<{
    review_id: string;
    respondent_id: string;
    comment: string;
    resolved_at: string | null;
    status: string;
    created_at: string;
    reviews: {
      id: string;
      document_id: string;
      field_name: string;
      verdict: string;
    };
  }>) {
    const fieldName = q.reviews?.field_name;
    if (!fieldName) continue;
    const group = groups.get(fieldName);
    if (!group) continue;
    const text = q.comment?.trim();
    if (!text) continue;
    group.comments.push({
      source: "duvida",
      text,
      author: data.profileMap.get(q.respondent_id) || "Anônimo",
      createdAt: q.created_at,
      resolvedAt: q.resolved_at,
      documentTitle: docMap.get(q.reviews.document_id) || null,
      extra: `veredito disputado: ${formatAnswer(q.reviews.verdict)}`,
    });
  }

  // Ordenar comentários por data desc.
  for (const g of groups.values()) {
    g.comments.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  // Ordenar grupos por nº de erros desc, depois por nome.
  return Array.from(groups.values()).sort((a, b) => {
    if (a.errors.length !== b.errors.length)
      return b.errors.length - a.errors.length;
    return a.field.name.localeCompare(b.field.name);
  });
}

// ─────────────────────────── render Markdown ───────────────────────────

function renderDistribution(
  field: PydanticField,
  samples: HumanAnswerSample[],
): string {
  if (samples.length === 0) return "_(sem respostas humanas)_";

  if (field.type === "single") {
    const counts = new Map<string, number>();
    for (const s of samples) {
      const k = formatAnswer(s.answer) || "_(vazio)_";
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `**${escapeMd(k)}**: ${n}`)
      .join(" · ");
  }

  if (field.type === "multi") {
    // Distribuição por opção marcada.
    const counts = new Map<string, number>();
    let totalRespostas = 0;
    for (const s of samples) {
      totalRespostas++;
      const arr = Array.isArray(s.answer) ? s.answer : [];
      for (const v of arr) {
        const k = String(v);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    if (counts.size === 0) return `_(${totalRespostas} respostas, todas vazias)_`;
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `**${escapeMd(k)}**: ${n}/${totalRespostas}`)
      .join(" · ");
  }

  if (field.type === "date") {
    const counts = new Map<string, number>();
    for (const s of samples) {
      const k = formatAnswer(s.answer) || "_(vazio)_";
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k, n]) => `${escapeMd(k)} (${n})`)
      .join(" · ");
  }

  // text
  const samplesText = samples.slice(0, 5);
  return samplesText
    .map(
      (s) =>
        `- *${escapeMd(s.respondentName)}* (${escapeMd(s.documentTitle)}): ${escapeMd(
          formatAnswer(s.answer) || "_(vazio)_",
        )}`,
    )
    .join("\n");
}

function renderComment(c: CommentEntry): string {
  const sourceLabel = {
    review: "comentário de revisão",
    anotacao: "anotação",
    duvida: "dúvida",
  }[c.source];
  const status = c.resolvedAt
    ? `resolvido em ${formatDate(c.resolvedAt)}`
    : "aberto";
  const parts: string[] = [
    status,
    `criado ${formatDate(c.createdAt)}`,
    `por ${c.author}`,
  ];
  if (c.documentTitle) parts.push(`doc ${c.documentTitle}`);
  if (c.extra) parts.push(c.extra);
  return `- **${sourceLabel}** — ${parts.map((p) => escapeMd(p)).join(" · ")}\n${blockquote(c.text)}`;
}

function renderError(e: LlmError, idx: number, _field: PydanticField): string {
  const lines: string[] = [];
  lines.push(`#### Erro ${idx + 1} — ${escapeMd(e.documentTitle)}`);
  lines.push("");
  const meta: string[] = [];
  meta.push(`revisado ${formatDate(e.reviewedAt)}`);
  if (e.reviewerName) meta.push(`por ${e.reviewerName}`);
  if (e.schemaVersion) meta.push(`schema ${e.schemaVersion}`);
  lines.push(`_${meta.map((p) => escapeMd(p)).join(" · ")}_`);
  lines.push("");
  lines.push(`- **LLM respondeu:** ${escapeMd(e.llmAnswer || "_(vazio)_")}`);
  if (e.llmJustification && e.llmJustification.trim()) {
    lines.push(`- **Justificativa LLM:**`);
    lines.push(blockquote(e.llmJustification.trim()));
  }
  lines.push(
    `- **Veredito humano:** ${escapeMd(formatAnswer(e.chosenVerdict) || "_(vazio)_")}`,
  );
  if (e.reviewerComment && e.reviewerComment.trim()) {
    lines.push(`- **Comentário do revisor:**`);
    lines.push(blockquote(e.reviewerComment.trim()));
  }
  return lines.join("\n");
}

function renderOtherHumanAnswersForDoc(
  e: LlmError,
  group: FieldGroup,
): string {
  const others = group.humanAnswers.filter(
    (h) => h.documentId === e.documentId,
  );
  if (others.length === 0) return "_(nenhuma resposta humana registrada para este documento)_";
  return others
    .map((h) => {
      const ans = formatAnswer(h.answer) || "_(vazio)_";
      const just =
        h.justification && h.justification.trim()
          ? `\n  > ${escapeMd(h.justification.trim())}`
          : "";
      return `- **${escapeMd(h.respondentName)}**: ${escapeMd(ans)}${just}`;
    })
    .join("\n");
}

function renderField(group: FieldGroup): string {
  const f = group.field;
  const lines: string[] = [];
  lines.push(`## \`${f.name}\` — ${escapeMd(f.description)}`);
  lines.push("");
  lines.push(`**Pergunta:** ${escapeMd(f.description)}`);
  if (f.help_text && f.help_text.trim()) {
    lines.push(`**Orientação aos pesquisadores:** ${escapeMd(f.help_text.trim())}`);
  }
  const typeLine: string[] = [`**Tipo:** \`${f.type}\``];
  if (f.options && f.options.length > 0) {
    typeLine.push(`**Opções:** ${f.options.map((o) => escapeMd(o)).join(" · ")}`);
  }
  lines.push(typeLine.join(" · "));

  const errCount = group.errors.length;
  const reviewed = group.totalReviewed;
  const rate = reviewed > 0 ? Math.round((errCount / reviewed) * 100) : 0;
  lines.push(
    `**Erros abertos:** ${errCount} de ${reviewed} revisões (${rate}%)`,
  );
  lines.push("");

  lines.push(`**Respostas humanas (n=${group.humanAnswers.length}):**`);
  lines.push("");
  lines.push(renderDistribution(f, group.humanAnswers));
  lines.push("");

  if (group.comments.length > 0) {
    lines.push(`**Comentários sobre a pergunta (n=${group.comments.length}):**`);
    lines.push("");
    for (const c of group.comments) {
      lines.push(renderComment(c));
      lines.push("");
    }
  } else {
    lines.push(`**Comentários sobre a pergunta:** _(nenhum)_`);
    lines.push("");
  }

  lines.push(`### Erros abertos`);
  lines.push("");
  group.errors.forEach((e, i) => {
    lines.push(renderError(e, i, f));
    lines.push("");
    lines.push(`**Outras respostas humanas neste documento:**`);
    lines.push("");
    lines.push(renderOtherHumanAnswersForDoc(e, group));
    lines.push("");
  });

  return lines.join("\n");
}

function renderReport(
  project: ProjectInfo,
  groups: FieldGroup[],
  totals: {
    totalErrors: number;
    totalReviewed: number;
  },
): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`# Relatório de erros LLM em aberto — ${escapeMd(project.name)}`);
  lines.push("");
  lines.push(
    `Projeto \`${project.id}\` · versão schema \`${project.schemaVersion}\` · gerado em ${today}.`,
  );
  lines.push("");
  const ratePct = totals.totalReviewed > 0
    ? ((totals.totalErrors / totals.totalReviewed) * 100).toFixed(1)
    : "0.0";
  lines.push(
    `**Resumo:** ${totals.totalErrors} erros abertos em ${groups.length} pergunta(s). Taxa global: ${totals.totalErrors}/${totals.totalReviewed} revisões = ${ratePct}%.`,
  );
  lines.push("");

  if (groups.length === 0) {
    lines.push("_Não há erros LLM abertos. 🎉_");
    return lines.join("\n");
  }

  // Sumário.
  lines.push(`## Sumário por pergunta`);
  lines.push("");
  lines.push(`| Pergunta | Erros | Revisões | Taxa |`);
  lines.push(`|---|---:|---:|---:|`);
  for (const g of groups) {
    const reviewed = g.totalReviewed;
    const errs = g.errors.length;
    const rate = reviewed > 0 ? `${Math.round((errs / reviewed) * 100)}%` : "—";
    const desc = g.field.description.length > 60
      ? g.field.description.slice(0, 57) + "…"
      : g.field.description;
    lines.push(
      `| \`${g.field.name}\` — ${escapeMd(desc)} | ${errs} | ${reviewed} | ${rate} |`,
    );
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const g of groups) {
    lines.push(renderField(g));
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

// ─────────────────────────── main ───────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(
      `generate.ts\n\nUso:\n  npx tsx scripts/erros-llm-relatorio/generate.ts \\\n    [--project-id <uuid>] [--project-name <fragmento>] [--list] [--out <path>]\n\nGera Markdown em ../docs/erros-llm/{slug}-{YYYYMMDD}.md por padrão.`,
    );
    return;
  }

  if (args.list) {
    const projects = await listProjects();
    for (const p of projects) {
      const v = `${p.schema_version_major ?? 0}.${p.schema_version_minor ?? 0}.${p.schema_version_patch ?? 0}`;
      console.log(`${p.id}\t${v}\t${p.name}`);
    }
    return;
  }

  const project = await resolveProject(args);
  if (!project) {
    console.error(
      "Nenhum projeto identificado. Use --list, --project-id ou --project-name.",
    );
    process.exit(1);
  }

  const fields = ((project.pydantic_fields as PydanticField[]) ?? []).filter(
    Boolean,
  );
  const projectInfo: ProjectInfo = {
    id: project.id as string,
    name: project.name as string,
    schemaVersion: `${project.schema_version_major ?? 0}.${project.schema_version_minor ?? 0}.${project.schema_version_patch ?? 0}`,
    pydanticFields: fields,
  };

  console.error(`→ Projeto: ${projectInfo.name} (${projectInfo.id})`);
  console.error(`→ Carregando dados…`);
  const data = await fetchAll(projectInfo.id);

  const { errors, reviewedByField } = computeOpenErrors(data, fields);
  console.error(
    `→ ${errors.length} erros abertos em ${new Set(errors.map((e) => e.fieldName)).size} pergunta(s)`,
  );

  const groups = aggregateByField(errors, reviewedByField, data, fields);

  const totalReviewed = Array.from(reviewedByField.values()).reduce(
    (acc, n) => acc + n,
    0,
  );
  const md = renderReport(projectInfo, groups, {
    totalErrors: errors.length,
    totalReviewed,
  });

  const outPath =
    typeof args.out === "string"
      ? resolve(process.cwd(), args.out)
      : resolve(
          process.cwd(),
          `../docs/erros-llm/${slugify(projectInfo.name)}-${todayYYYYMMDD()}.md`,
        );

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md, "utf-8");
  console.error(`→ Relatório salvo em ${outPath}`);
  console.log(outPath);
}

main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});
