#!/usr/bin/env -S npx tsx
/**
 * fetch-open-comments.ts
 *
 * Lê comentários ABERTOS de um projeto dataframeitGUI e imprime JSON estruturado
 * no stdout para ser consumido pela skill comentarios-relatorio.
 *
 * Uso:
 *   cd frontend
 *   npx tsx ../.claude/skills/comentarios-relatorio/scripts/fetch-open-comments.ts \
 *     [--project-id <uuid>] [--project-name <fragmento>] [--list]
 *
 * Sem argumentos: imprime lista de projetos disponíveis (JSON).
 * Com --project-id ou --project-name (match case-insensitive contém): busca os comentários.
 *
 * Espelha a lógica de frontend/src/app/(app)/projects/[id]/reviews/comments/page.tsx
 * mas filtrando apenas abertos. Requer SUPABASE_SERVICE_ROLE_KEY no .env.local.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv() {
  // Carrega frontend/.env.local se variáveis não vierem do ambiente
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
    JSON.stringify({
      error:
        "Faltam NEXT_PUBLIC_SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY. Rode de dentro de frontend/ ou defina as vars manualmente.",
    }),
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ----------------------- Tipos -----------------------

interface PydanticField {
  name: string;
  type: "single" | "multi" | "text" | "date";
  options: string[] | null;
  description: string;
  help_text?: string;
  target?: "all" | "llm_only" | "human_only";
  required?: boolean;
  hash?: string;
  subfields?: Array<{ key: string; label: string; required?: boolean }>;
  subfield_rule?: "all" | "at_least_one";
  allow_other?: boolean;
}

interface OpenComment {
  id: string;
  source: "review" | "nota" | "sugestao" | "dificuldade" | "duvida" | "anotacao";
  rawId: string;
  fieldName: string;
  documentId: string | null;
  documentTitle: string | null;
  text: string;
  author: string;
  createdAt: string;
  extra: Record<string, unknown>;
}

// ----------------------- CLI parsing -----------------------

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") {
      out.list = true;
    } else if (a === "--project-id" || a === "--id") {
      out.projectId = argv[++i];
    } else if (a === "--project-name" || a === "--name") {
      out.projectName = argv[++i];
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    }
  }
  return out;
}

async function listProjects() {
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, created_at, schema_version_major, schema_version_minor, schema_version_patch")
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

// ----------------------- Fetching -----------------------

async function fetchOpenComments(projectId: string, fields: PydanticField[]) {
  const [
    { data: reviews },
    { data: documents },
    { data: responsesWithNotes },
    { data: suggestions },
    { data: llmResponses },
    { data: difficultyResolutions },
    { data: projectComments },
    { data: verdictQuestions },
    { data: noteResolutions },
  ] = await Promise.all([
    // Reviews abertos (com comentário e não resolvidos)
    supabase
      .from("reviews")
      .select(
        "id, document_id, field_name, verdict, comment, chosen_response_id, resolved_at, reviewer_id, created_at, response_snapshot",
      )
      .eq("project_id", projectId)
      .not("comment", "is", null)
      .is("resolved_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("documents")
      .select("id, title, external_id")
      .eq("project_id", projectId),
    // Notas de pesquisador (humano)
    supabase
      .from("responses")
      .select("id, document_id, respondent_id, respondent_name, justifications, created_at")
      .eq("project_id", projectId)
      .eq("respondent_type", "humano")
      .not("justifications", "is", null),
    // Sugestões pendentes
    supabase
      .from("schema_suggestions")
      .select(
        "id, field_name, suggested_changes, reason, status, resolved_at, created_at, suggested_by, profiles!suggested_by(email)",
      )
      .eq("project_id", projectId)
      .eq("status", "pending")
      .order("created_at", { ascending: false }),
    // Respostas LLM ativas (para extrair llm_ambiguidades)
    supabase
      .from("responses")
      .select("id, document_id, answers, respondent_name, created_at")
      .eq("project_id", projectId)
      .eq("respondent_type", "llm")
      .eq("is_current", true),
    // Dificuldades já resolvidas → filtrar fora
    supabase
      .from("difficulty_resolutions")
      .select("response_id")
      .eq("project_id", projectId),
    // project_comments abertos (root, não resolvidos)
    supabase
      .from("project_comments")
      .select(
        "id, document_id, field_name, author_id, body, parent_id, resolved_at, created_at, profiles!author_id(email)",
      )
      .eq("project_id", projectId)
      .is("parent_id", null)
      .is("resolved_at", null)
      .order("created_at", { ascending: false }),
    // Dúvidas abertas
    supabase
      .from("verdict_acknowledgments")
      .select(
        "review_id, respondent_id, comment, resolved_at, created_at, reviews!inner(id, project_id, document_id, field_name, verdict)",
      )
      .eq("status", "questioned")
      .is("resolved_at", null)
      .not("comment", "is", null)
      .eq("reviews.project_id", projectId)
      .order("created_at", { ascending: false }),
    // Notas já resolvidas → filtrar fora
    supabase
      .from("note_resolutions")
      .select("response_id")
      .eq("project_id", projectId),
  ]);

  const fieldMap = new Map(fields.map((f) => [f.name, f]));
  const docMap = new Map(
    (documents ?? []).map((d) => [d.id, d.title || d.external_id || d.id]),
  );
  const resolvedNoteIds = new Set(
    (noteResolutions ?? []).map((n) => n.response_id),
  );
  const resolvedDiffIds = new Set(
    (difficultyResolutions ?? []).map((d) => d.response_id),
  );

  // Coletar ids de profiles para resolver nomes
  const profileIds = new Set<string>();
  (reviews ?? []).forEach((r) => r.reviewer_id && profileIds.add(r.reviewer_id));
  (responsesWithNotes ?? []).forEach(
    (r) => r.respondent_id && profileIds.add(r.respondent_id),
  );
  (verdictQuestions ?? []).forEach(
    (q) => q.respondent_id && profileIds.add(q.respondent_id),
  );

  const profileMap = new Map<string, string>();
  if (profileIds.size > 0) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, email, first_name, last_name")
      .in("id", Array.from(profileIds));
    (profiles ?? []).forEach((p) => {
      const name =
        [p.first_name, p.last_name].filter(Boolean).join(" ") ||
        p.email?.split("@")[0] ||
        "Anônimo";
      profileMap.set(p.id as string, name);
    });
  }

  const comments: OpenComment[] = [];

  // review
  for (const r of reviews ?? []) {
    const field = fieldMap.get(r.field_name as string);
    comments.push({
      id: `review-${r.id}`,
      source: "review",
      rawId: r.id as string,
      fieldName: r.field_name as string,
      documentId: r.document_id as string,
      documentTitle: docMap.get(r.document_id as string) ?? null,
      text: (r.comment as string) ?? "",
      author: r.reviewer_id
        ? profileMap.get(r.reviewer_id as string) ?? "Anônimo"
        : "Anônimo",
      createdAt: r.created_at as string,
      extra: {
        verdict: r.verdict,
        chosenResponseId: r.chosen_response_id,
        responseSnapshot: r.response_snapshot,
        fieldType: field?.type,
        fieldOptions: field?.options,
      },
    });
  }

  // nota (humano, não resolvida)
  for (const r of responsesWithNotes ?? []) {
    if (resolvedNoteIds.has(r.id as string)) continue;
    const j = r.justifications as Record<string, string> | null;
    const note = j && typeof j._notes === "string" ? j._notes.trim() : "";
    if (!note) continue;
    comments.push({
      id: `nota-${r.id}`,
      source: "nota",
      rawId: r.id as string,
      fieldName: "(geral)",
      documentId: r.document_id as string,
      documentTitle: docMap.get(r.document_id as string) ?? null,
      text: note,
      author:
        (r.respondent_id &&
          (profileMap.get(r.respondent_id as string) ||
            (r.respondent_name as string))) ||
        (r.respondent_name as string) ||
        "Anônimo",
      createdAt: r.created_at as string,
      extra: {
        responseId: r.id,
        respondentId: r.respondent_id,
      },
    });
  }

  // sugestao (pending)
  for (const s of suggestions ?? []) {
    const changes = s.suggested_changes as Record<string, unknown>;
    const changedKeys = Object.keys(changes);
    const p = s.profiles as unknown as { email: string | null } | null;
    const field = fieldMap.get(s.field_name as string);
    comments.push({
      id: `sugestao-${s.id}`,
      source: "sugestao",
      rawId: s.id as string,
      fieldName: s.field_name as string,
      documentId: null,
      documentTitle: null,
      text: (s.reason as string) || "Sem motivo",
      author: p?.email?.split("@")[0] ?? "Anônimo",
      createdAt: s.created_at as string,
      extra: {
        suggestedChanges: changes,
        changedKeys,
        status: s.status,
        currentField: field
          ? {
              description: field.description,
              help_text: field.help_text,
              options: field.options,
              type: field.type,
            }
          : null,
      },
    });
  }

  // dificuldade (LLM, não resolvida)
  for (const r of llmResponses ?? []) {
    if (resolvedDiffIds.has(r.id as string)) continue;
    const ambiguidades = (r.answers as Record<string, unknown>)
      ?.llm_ambiguidades;
    const txt =
      typeof ambiguidades === "string" ? ambiguidades.trim() : "";
    if (!txt) continue;
    comments.push({
      id: `dificuldade-${r.id}`,
      source: "dificuldade",
      rawId: r.id as string,
      fieldName: "(geral)",
      documentId: r.document_id as string,
      documentTitle: docMap.get(r.document_id as string) ?? null,
      text: txt,
      author: (r.respondent_name as string) || "LLM",
      createdAt: r.created_at as string,
      extra: {
        responseId: r.id,
        documentId: r.document_id,
      },
    });
  }

  // duvida (verdict_acknowledgments abertas).
  // O join !inner em many-to-one retorna um único objeto em runtime, mas os
  // tipos gerados pelo Supabase o inferem como array. Usar `as unknown as`
  // pelo mesmo motivo que o cast de `c.profiles` abaixo.
  for (const q of (verdictQuestions ?? []) as unknown as Array<{
    review_id: string;
    respondent_id: string;
    comment: string;
    resolved_at: string | null;
    created_at: string;
    reviews: {
      id: string;
      document_id: string;
      field_name: string;
      verdict: string;
    };
  }>) {
    const r = q.reviews;
    const field = fieldMap.get(r.field_name);
    comments.push({
      id: `duvida-${q.review_id}-${q.respondent_id}`,
      source: "duvida",
      rawId: `${q.review_id}|${q.respondent_id}`,
      fieldName: r.field_name,
      documentId: r.document_id,
      documentTitle: docMap.get(r.document_id) ?? null,
      text: q.comment,
      author: profileMap.get(q.respondent_id) ?? "Anônimo",
      createdAt: q.created_at,
      extra: {
        reviewId: q.review_id,
        respondentId: q.respondent_id,
        verdict: r.verdict,
        fieldType: field?.type,
        fieldOptions: field?.options,
      },
    });
  }

  // anotacao (project_comments root, não resolvidos)
  for (const c of projectComments ?? []) {
    const p = c.profiles as unknown as { email: string | null } | null;
    const field = c.field_name
      ? fieldMap.get(c.field_name as string)
      : undefined;
    comments.push({
      id: `anotacao-${c.id}`,
      source: "anotacao",
      rawId: c.id as string,
      fieldName: (c.field_name as string | null) ?? "(geral)",
      documentId: (c.document_id as string | null) ?? null,
      documentTitle: c.document_id
        ? docMap.get(c.document_id as string) ?? null
        : null,
      text: c.body as string,
      author: p?.email?.split("@")[0] ?? "Anônimo",
      createdAt: c.created_at as string,
      extra: {
        fieldType: field?.type,
        fieldOptions: field?.options,
      },
    });
  }

  comments.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return comments;
}

// ----------------------- Main -----------------------

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      `fetch-open-comments.ts\n\nUso:\n  npx tsx fetch-open-comments.ts [--project-id <uuid>] [--project-name <fragmento>] [--list]\n\nImprime JSON estruturado com os comentários abertos do projeto.\n`,
    );
    return;
  }

  if (args.list) {
    const projects = await listProjects();
    console.log(JSON.stringify({ projects }, null, 2));
    return;
  }

  const project = await resolveProject(args);
  if (!project) {
    // Sem id nem name → lista projetos para escolher
    const projects = await listProjects();
    console.log(
      JSON.stringify(
        {
          message:
            "Nenhum projeto identificado. Use --project-id ou --project-name.",
          projects,
        },
        null,
        2,
      ),
    );
    return;
  }

  const fields = (project.pydantic_fields as PydanticField[]) ?? [];
  const comments = await fetchOpenComments(project.id as string, fields);

  const version = {
    major: project.schema_version_major ?? 0,
    minor: project.schema_version_minor ?? 1,
    patch: project.schema_version_patch ?? 0,
  };

  console.log(
    JSON.stringify(
      {
        project: {
          id: project.id,
          name: project.name,
          version: `${version.major}.${version.minor}.${version.patch}`,
        },
        fields,
        stats: {
          totalOpen: comments.length,
          bySource: comments.reduce<Record<string, number>>((acc, c) => {
            acc[c.source] = (acc[c.source] ?? 0) + 1;
            return acc;
          }, {}),
        },
        comments,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err?.message ?? String(err) }));
  process.exit(1);
});
