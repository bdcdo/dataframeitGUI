#!/usr/bin/env -S npx tsx
/**
 * apply-decisions.ts
 *
 * Lê um arquivo JSON com a lista estruturada de decisões (produzido pelo Claude
 * a partir do .md anotado pelo usuário) e aplica:
 *   1. Mudanças no schema Pydantic (mesmas primitivas de saveSchemaFromGUI):
 *      - update projects.{pydantic_code, pydantic_hash, pydantic_fields, schema_version_*}
 *      - insert schema_change_log entries
 *      (sem invalidar responses: is_latest não é flipado na troca de schema —
 *       staleness é por pydantic_hash/answer_field_hashes; ver issue #349)
 *   2. Resolução dos comentários via INSERT/UPDATE nas tabelas corretas.
 *
 * Uso:
 *   cd frontend
 *   npx tsx scripts/comentarios-relatorio/apply-decisions.ts <decisions.json> [--dry-run] [--yes]
 *
 * Sem --yes, TUDO roda como preview (schema incluído) — nenhum write acontece.
 * --dry-run é o alias explícito do mesmo comportamento.
 *
 * Formato esperado do JSON: ver references/decisions-format.md (neste diretório).
 *
 * O cálculo (classificação, versão, log de auditoria, código Pydantic e
 * hash) usa `planSchemaPersistence` de `src/lib/schema-utils` (pura,
 * client-safe — extração da issue #63/PR #352), a mesma função usada por
 * saveSchemaFromGUI. A escrita usa a mesma RPC transacional da aplicação, de
 * modo que projeto, revisão concorrente e histórico sejam confirmados ou
 * revertidos juntos. Só a revalidação de cache fica fora deste script.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { planSchemaPersistence } from "../../src/lib/schema-utils";
import { parseSaveablePydanticFields } from "../../src/lib/pydantic-field";
import type { PydanticField } from "../../src/lib/types";
import { loadEnv } from "./load-env";

loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Faltam NEXT_PUBLIC_SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY no .env.local",
  );
  process.exit(1);
}

// ----------------------- Tipos -----------------------

// Formato do JSON de entrada. O Claude gera esse arquivo parseando o .md
// anotado. Documentação completa: references/decisions-format.md
type Resolution =
  | { source: "anotacao"; rawId: string }
  | { source: "review"; rawId: string }
  | { source: "nota"; rawId: string; note?: string } // rawId = response_id
  | {
      source: "dificuldade";
      rawId: string; // response_id
      documentId: string;
      note?: string;
    }
  | {
      source: "duvida";
      reviewId: string;
      respondentId: string;
    }
  | {
      source: "sugestao";
      rawId: string; // suggestion_id
      action: "approved" | "rejected";
      rejectionReason?: string;
    }
  // Pedidos de exclusão de documento NÃO são resolvíveis por aqui: a aprovação
  // exige excludeDocuments (soft delete + auditoria) — fluxo da plataforma.
  | { source: "exclusao"; rawId: string };

interface DecisionsFile {
  projectId: string;
  // ID do usuário a registrar como changed_by / resolved_by.
  // Se omitido, tenta pegar o created_by do projeto.
  changedBy?: string;
  // Nova lista completa de fields a persistir (já com add/remove/edit aplicados).
  newFields: PydanticField[];
  // Lista de comentários a resolver.
  resolutions: Resolution[];
  // Opcional: nota resumo a registrar num project_comment "meta" após aplicação.
  summaryNote?: string;
}

interface ResolutionResult {
  success: boolean;
  error?: string;
  detail?: string;
}

interface SchemaCommitRow {
  status: "saved" | "conflict" | "forbidden" | "not_found";
  schema_revision: number | null;
}

// review_id/respondent_id de "duvida" entram num filtro .or() construído por
// template string (verdict_acknowledgments tem chave composta, sem coluna
// `id` única — batchResolveUpdate/.in() não se aplicam). .in() escapa valores
// com vírgula/parênteses automaticamente; .or() com string crua não escapa
// nada. reviewId chega implicitamente validado por já ter passado pelo guard
// de posse (buildOwnershipMaps via .in(), só combina com uma review real),
// mas respondentId nunca é comparado contra o banco — sem este check, um
// respondentId malformado (decisions.json malformado ou mal extraído por LLM)
// quebraria a sintaxe do filtro ou ampliaria o UPDATE para pares fora do
// validado pelo guard.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ----------------------- Schema apply -----------------------

async function applySchemaChanges(
  supabase: SupabaseClient,
  projectId: string,
  newFields: PydanticField[],
  changedBy: string,
  write: boolean,
) {
  const validatedFields = parseSaveablePydanticFields(newFields);
  if (!validatedFields) {
    throw new Error("newFields não corresponde ao contrato canônico de PydanticField");
  }

  const { data: project, error: projErr } = await supabase
    .from("projects")
    .select(
      "pydantic_fields, pydantic_code, pydantic_hash, schema_version_major, schema_version_minor, schema_version_patch, schema_revision",
    )
    .eq("id", projectId)
    .single();
  if (projErr) throw new Error(`projects select: ${projErr.message}`);

  const oldFields = (project?.pydantic_fields as PydanticField[]) ?? [];

  // Guarda anti-wipe — espelha saveSchemaFromGUI (src/actions/schema.ts):
  // nunca gravar 0 campos por cima de um schema existente. Um decisions.json
  // malformado (newFields vazio/parcial) apagaria o schema inteiro com a
  // service role key.
  const hasExistingSchema = oldFields.length > 0 || !!project?.pydantic_code;
  if (validatedFields.length === 0 && hasExistingSchema) {
    throw new Error(
      "guarda anti-wipe: newFields está vazio mas o projeto já tem schema. " +
        "Se a intenção é remover todos os campos, faça pela UI.",
    );
  }

  const current = {
    major: project?.schema_version_major ?? 0,
    minor: project?.schema_version_minor ?? 1,
    patch: project?.schema_version_patch ?? 0,
  };

  const { changeType, bumped, logEntries, code, hash, fieldsWithHash } =
    planSchemaPersistence(oldFields, validatedFields, current);

  const summary = {
    changeType,
    currentVersion: `${current.major}.${current.minor}.${current.patch}`,
    newVersion: `${bumped.major}.${bumped.minor}.${bumped.patch}`,
    hashChanged: project?.pydantic_hash !== hash,
    logEntryCount: logEntries.length,
    logEntries,
    pydanticCodePreview: code.split("\n").slice(0, 10).join("\n") + "\n...",
  };

  if (!write) {
    return { preview: true, summary };
  }

  if (!changeType && logEntries.length === 0) {
    return { preview: false, summary, applied: false, reason: "sem mudanças" };
  }

  // Sem invalidação de responses na troca de schema: is_latest significa
  // "última resposta ativa por respondente", não "compatível com o schema
  // vigente" (rename + semântica em 20260514190000; saveSchema também não
  // flipa — src/actions/schema.ts). Staleness é detectada por
  // pydantic_hash/answer_field_hashes. Flipar aqui reintroduziria o bug de
  // respostas LLM órfãs revivido pela migration 20260505000001 (issue #349).

  const { data: commitData, error: commitError } = await supabase
    .rpc("commit_project_schema", {
      p_project_id: projectId,
      p_expected_revision: project?.schema_revision ?? 0,
      p_pydantic_fields: fieldsWithHash,
      p_pydantic_code: code,
      p_version_major: bumped.major,
      p_version_minor: bumped.minor,
      p_version_patch: bumped.patch,
      p_change_type: changeType ?? "patch",
      p_log_entries: logEntries,
      p_changed_by: changedBy,
    })
    .single();
  const committed = commitData as SchemaCommitRow | null;
  if (commitError) {
    throw new Error(`commit_project_schema: ${commitError.message}`);
  }
  if (committed?.status !== "saved") {
    throw new Error(
      committed?.status === "conflict"
        ? `schema concorrente: revisão esperada ${project?.schema_revision ?? 0}, revisão atual ${committed.schema_revision}`
        : `commit_project_schema recusou a escrita (${committed?.status ?? "sem retorno"})`,
    );
  }

  return {
    preview: false,
    summary,
    applied: true,
    schemaRevision: committed.schema_revision,
  };
}

// ----------------------- Comment resolution -----------------------

// Valida em lote a que projeto pertencem as responses (nota/dificuldade) e os
// reviews (duvida) referenciados: note_resolutions/difficulty_resolutions não
// têm constraint amarrando o project_id da linha ao da response, e
// verdict_acknowledgments só tem review_id — sem o guard, um rawId de outro
// projeto viraria linha órfã "resolvida" com sucesso aparente.
async function buildOwnershipMaps(supabase: SupabaseClient, resolutions: Resolution[]) {
  const responseIds = [
    ...new Set(
      resolutions
        .filter((r) => r.source === "nota" || r.source === "dificuldade")
        .map((r) => (r as { rawId: string }).rawId),
    ),
  ];
  const reviewIds = [
    ...new Set(
      resolutions
        .filter((r) => r.source === "duvida")
        .map((r) => (r as { reviewId: string }).reviewId),
    ),
  ];

  const [responsesRes, reviewsRes] = await Promise.all([
    responseIds.length > 0
      ? supabase.from("responses").select("id, project_id").in("id", responseIds)
      : Promise.resolve({ data: [], error: null }),
    reviewIds.length > 0
      ? supabase.from("reviews").select("id, project_id").in("id", reviewIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (responsesRes.error) {
    throw new Error(`responses select (guard): ${responsesRes.error.message}`);
  }
  if (reviewsRes.error) {
    throw new Error(`reviews select (guard): ${reviewsRes.error.message}`);
  }

  return {
    responseProject: new Map(
      (responsesRes.data ?? []).map((r) => [r.id as string, r.project_id as string]),
    ),
    reviewProject: new Map(
      (reviewsRes.data ?? []).map((r) => [r.id as string, r.project_id as string]),
    ),
  };
}

// UPDATE em lote restrito ao projeto; devolve, por id pedido, sucesso ou
// "not found" (id inexistente ou de outro projeto). Em preview (`write=false`),
// faz o SELECT equivalente em vez do UPDATE — reporta o mesmo resultado
// (existe e pertence ao projeto vs. não encontrado) sem gravar nada, para que
// o preview não afirme sucesso para ids que na verdade falhariam em --yes.
async function batchResolveUpdate(
  supabase: SupabaseClient,
  table: string,
  projectId: string,
  ids: string[],
  payload: Record<string, unknown>,
  write: boolean,
): Promise<Map<string, ResolutionResult>> {
  const results = new Map<string, ResolutionResult>();
  if (ids.length === 0) return results;
  const { data, error } = write
    ? await supabase.from(table).update(payload).in("id", ids).eq("project_id", projectId).select("id")
    : await supabase.from(table).select("id").in("id", ids).eq("project_id", projectId);
  if (error) {
    for (const id of ids) results.set(id, { success: false, error: error.message });
    return results;
  }
  const matched = new Set((data ?? []).map((d) => d.id as string));
  for (const id of ids) {
    results.set(
      id,
      matched.has(id)
        ? {
            success: true,
            ...(write ? {} : { detail: "PREVIEW: encontrado no projeto — seria resolvido" }),
          }
        : { success: false, error: "not found" },
    );
  }
  return results;
}

// Roda os mesmos guards de posse e checagens de existência em preview
// (write=false) e em --yes: só as chamadas que gravam (UPDATE/INSERT/UPSERT)
// são puladas em preview, substituídas por SELECTs equivalentes. Antes, o
// preview retornava `success: true` cego para toda resolução — inclusive
// `exclusao` (que SEMPRE falha em --yes, ver mapeamento final) e rawIds de
// outro projeto (que o guard de posse sempre rejeitaria) — fazendo o preview
// prometer sucesso que o `--yes` seguinte não entregava.
async function resolveComments(
  supabase: SupabaseClient,
  projectId: string,
  changedBy: string,
  resolutions: Resolution[],
  write: boolean,
): Promise<Array<{ item: Resolution; result: ResolutionResult }>> {
  const nowIso = new Date().toISOString();
  const { responseProject, reviewProject } = await buildOwnershipMaps(
    supabase,
    resolutions,
  );
  const resolvedPayload = { resolved_at: nowIso, resolved_by: changedBy };
  const resultFor = new Map<Resolution, ResolutionResult>();

  const guardResponse = (rawId: string): ResolutionResult | null => {
    const owner = responseProject.get(rawId);
    if (!owner) return { success: false, error: "response não encontrada" };
    if (owner !== projectId) {
      return { success: false, error: "response pertence a outro projeto" };
    }
    return null;
  };

  // --- nota / dificuldade: guard + INSERT em lote (upsert ignora par já resolvido) ---
  const notas = resolutions.filter((r) => r.source === "nota") as Array<
    Extract<Resolution, { source: "nota" }>
  >;
  const dificuldades = resolutions.filter((r) => r.source === "dificuldade") as Array<
    Extract<Resolution, { source: "dificuldade" }>
  >;

  const notaRows: Record<string, unknown>[] = [];
  for (const r of notas) {
    const guardErr = guardResponse(r.rawId);
    if (guardErr) {
      resultFor.set(r, guardErr);
      continue;
    }
    resultFor.set(r, { success: true });
    notaRows.push({
      project_id: projectId,
      response_id: r.rawId,
      resolved_by: changedBy,
      note: r.note || null,
    });
  }
  const difRows: Record<string, unknown>[] = [];
  for (const r of dificuldades) {
    const guardErr = guardResponse(r.rawId);
    if (guardErr) {
      resultFor.set(r, guardErr);
      continue;
    }
    resultFor.set(r, { success: true });
    difRows.push({
      project_id: projectId,
      response_id: r.rawId,
      document_id: r.documentId,
      resolved_by: changedBy,
      note: r.note || null,
    });
  }

  // Checagem prévia de quais pares (project_id, response_id) já existem em
  // note_resolutions/difficulty_resolutions: o upsert abaixo usa
  // ignoreDuplicates (idempotente — pares já resolvidos ficam como estão,
  // ver references/decisions-format.md), então sem esta checagem o relato
  // final diria "success" mesmo quando uma nota nova em decisions.json foi
  // silenciosamente descartada por já existir a linha.
  const [existingNotaRes, existingDifRes] = await Promise.all([
    notaRows.length > 0
      ? supabase
          .from("note_resolutions")
          .select("response_id")
          .eq("project_id", projectId)
          .in("response_id", notaRows.map((r) => r.response_id as string))
      : Promise.resolve({ data: [], error: null }),
    difRows.length > 0
      ? supabase
          .from("difficulty_resolutions")
          .select("response_id")
          .eq("project_id", projectId)
          .in("response_id", difRows.map((r) => r.response_id as string))
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (existingNotaRes.error) {
    throw new Error(`note_resolutions select (guard): ${existingNotaRes.error.message}`);
  }
  if (existingDifRes.error) {
    throw new Error(
      `difficulty_resolutions select (guard): ${existingDifRes.error.message}`,
    );
  }
  const existingNotaIds = new Set(
    (existingNotaRes.data ?? []).map((d) => d.response_id as string),
  );
  const existingDifIds = new Set(
    (existingDifRes.data ?? []).map((d) => d.response_id as string),
  );

  // --- sugestao: approved em lote; rejected agrupado por motivo ---
  const sugestoes = resolutions.filter((r) => r.source === "sugestao") as Array<
    Extract<Resolution, { source: "sugestao" }>
  >;
  const approvedIds = sugestoes
    .filter((s) => s.action === "approved")
    .map((s) => s.rawId);
  const rejectedByReason = new Map<string | null, string[]>();
  for (const s of sugestoes.filter((s) => s.action === "rejected")) {
    const key = s.rejectionReason ?? null;
    rejectedByReason.set(key, [...(rejectedByReason.get(key) ?? []), s.rawId]);
  }

  const anotacaoIds = resolutions
    .filter((r) => r.source === "anotacao")
    .map((r) => (r as { rawId: string }).rawId);
  const reviewIds = resolutions
    .filter((r) => r.source === "review")
    .map((r) => (r as { rawId: string }).rawId);

  const [anotacaoResults, reviewResults, approvedResults, notaInsert, difInsert, ...rejectedMaps] =
    await Promise.all([
      batchResolveUpdate(
        supabase,
        "project_comments",
        projectId,
        anotacaoIds,
        resolvedPayload,
        write,
      ),
      batchResolveUpdate(supabase, "reviews", projectId, reviewIds, resolvedPayload, write),
      batchResolveUpdate(supabase, "schema_suggestions", projectId, approvedIds, {
        status: "approved",
        ...resolvedPayload,
      }, write),
      notaRows.length > 0 && write
        ? supabase
            .from("note_resolutions")
            .upsert(notaRows, {
              onConflict: "project_id,response_id",
              ignoreDuplicates: true,
            })
        : Promise.resolve({ error: null }),
      difRows.length > 0 && write
        ? supabase
            .from("difficulty_resolutions")
            .upsert(difRows, {
              onConflict: "project_id,response_id",
              ignoreDuplicates: true,
            })
        : Promise.resolve({ error: null }),
      ...[...rejectedByReason.entries()].map(([reason, ids]) =>
        batchResolveUpdate(supabase, "schema_suggestions", projectId, ids, {
          status: "rejected",
          ...resolvedPayload,
          ...(reason ? { rejection_reason: reason } : {}),
        }, write),
      ),
    ]);

  const rejectedResults = new Map<string, ResolutionResult>();
  for (const m of rejectedMaps as Map<string, ResolutionResult>[]) {
    for (const [k, v] of m) rejectedResults.set(k, v);
  }
  if ((notaInsert as { error: { message: string } | null }).error) {
    const msg = (notaInsert as { error: { message: string } }).error.message;
    for (const r of notas) {
      if (resultFor.get(r)?.success) resultFor.set(r, { success: false, error: msg });
    }
  } else {
    // upsert com ignoreDuplicates é idempotente: um par já resolvido não é
    // sobrescrito. Sinalizar isso explicitamente em vez de "success" cego,
    // para não sugerir que uma nota nova em decisions.json foi persistida.
    for (const r of notas) {
      if (resultFor.get(r)?.success && existingNotaIds.has(r.rawId)) {
        resultFor.set(r, {
          success: true,
          detail:
            "já resolvido anteriormente — nota não foi alterada (upsert idempotente ignora conflitos)",
        });
      }
    }
  }
  if ((difInsert as { error: { message: string } | null }).error) {
    const msg = (difInsert as { error: { message: string } }).error.message;
    for (const r of dificuldades) {
      if (resultFor.get(r)?.success) resultFor.set(r, { success: false, error: msg });
    }
  } else {
    for (const r of dificuldades) {
      if (resultFor.get(r)?.success && existingDifIds.has(r.rawId)) {
        resultFor.set(r, {
          success: true,
          detail:
            "já resolvido anteriormente — nota não foi alterada (upsert idempotente ignora conflitos)",
        });
      }
    }
  }

  // --- duvida: guard batched acima; 1 único UPDATE (ou SELECT em preview) em
  // lote via .or(), não 1 por par. verdict_acknowledgments tem chave composta
  // (review_id, respondent_id) sem coluna `id` única, então batchResolveUpdate
  // (.in("id", ids)) não se aplica direto — o filtro .or() combina os pares
  // já validados numa única query. reviewId chega implicitamente validado por
  // só passar no guard quando bate com uma review real (buildOwnershipMaps
  // via .in(), que escapa vírgula/parênteses); respondentId nunca é
  // comparado contra o banco, então precisa do check de formato explícito
  // (UUID_RE) antes de entrar cru no filtro .or() — sem isso, um
  // respondentId malformado quebraria a sintaxe do filtro ou ampliaria o
  // UPDATE para pares fora do validado.
  const duvidas = resolutions.filter((r) => r.source === "duvida") as Array<
    Extract<Resolution, { source: "duvida" }>
  >;
  const eligibleDuvidas: Array<Extract<Resolution, { source: "duvida" }>> = [];
  for (const r of duvidas) {
    const owner = reviewProject.get(r.reviewId);
    if (!owner) {
      resultFor.set(r, { success: false, error: "review não encontrado" });
      continue;
    }
    if (owner !== projectId) {
      resultFor.set(r, { success: false, error: "review pertence a outro projeto" });
      continue;
    }
    if (!UUID_RE.test(r.respondentId)) {
      resultFor.set(r, { success: false, error: "respondentId com formato inválido" });
      continue;
    }
    eligibleDuvidas.push(r);
  }
  if (eligibleDuvidas.length > 0) {
    const orFilter = eligibleDuvidas
      .map((r) => `and(review_id.eq.${r.reviewId},respondent_id.eq.${r.respondentId})`)
      .join(",");
    const { data, error } = write
      ? await supabase
          .from("verdict_acknowledgments")
          .update(resolvedPayload)
          .or(orFilter)
          .select("review_id, respondent_id")
      : await supabase
          .from("verdict_acknowledgments")
          .select("review_id, respondent_id")
          .or(orFilter);
    if (error) {
      for (const r of eligibleDuvidas) {
        resultFor.set(r, { success: false, error: error.message });
      }
    } else {
      const matched = new Set(
        (data ?? []).map(
          (d) => `${d.review_id as string}|${d.respondent_id as string}`,
        ),
      );
      for (const r of eligibleDuvidas) {
        resultFor.set(
          r,
          matched.has(`${r.reviewId}|${r.respondentId}`)
            ? {
                success: true,
                ...(write ? {} : { detail: "PREVIEW: encontrado — seria resolvido" }),
              }
            : { success: false, error: "not found" },
        );
      }
    }
  }

  // --- montar resultados na ordem original ---
  return resolutions.map((r) => {
    if (r.source === "anotacao") {
      return {
        item: r,
        result: anotacaoResults.get(r.rawId) ?? { success: false, error: "not found" },
      };
    }
    if (r.source === "review") {
      return {
        item: r,
        result: reviewResults.get(r.rawId) ?? { success: false, error: "not found" },
      };
    }
    if (r.source === "sugestao") {
      const m = r.action === "approved" ? approvedResults : rejectedResults;
      return {
        item: r,
        result: m.get(r.rawId) ?? { success: false, error: "not found" },
      };
    }
    if (r.source === "exclusao") {
      return {
        item: r,
        result: {
          success: false,
          error:
            "pedido de exclusão de documento: resolver pela plataforma " +
            "(aprovação exige excludeDocuments — soft delete + auditoria)",
        },
      };
    }
    return {
      item: r,
      result: resultFor.get(r) ?? { success: false, error: "unknown source" },
    };
  });
}

// ----------------------- Main -----------------------

function parseArgs(argv: string[]) {
  const out: { file?: string; dryRun: boolean; yes: boolean } = {
    dryRun: false,
    yes: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (!a.startsWith("-")) out.file = a;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.file) {
    console.error(
      "Uso: npx tsx apply-decisions.ts <decisions.json> [--dry-run] [--yes]",
    );
    process.exit(1);
  }
  const decisionsPath = resolve(process.cwd(), args.file);
  const raw = readFileSync(decisionsPath, "utf-8");
  const decisions = JSON.parse(raw) as DecisionsFile;

  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve changedBy
  let changedBy = decisions.changedBy;
  if (!changedBy) {
    const { data: proj } = await supabase
      .from("projects")
      .select("created_by")
      .eq("id", decisions.projectId)
      .single();
    changedBy = proj?.created_by as string;
  }
  if (!changedBy) {
    console.error(
      "Não foi possível resolver changedBy. Forneça decisions.changedBy.",
    );
    process.exit(1);
  }

  // Sem --yes, nada é gravado: schema E resoluções rodam como preview.
  const write = args.yes && !args.dryRun;

  console.log(
    `Projeto: ${decisions.projectId}\nchangedBy: ${changedBy}\nNovos fields: ${decisions.newFields.length}\nResoluções: ${decisions.resolutions.length}\nmodo: ${write ? "APLICAR" : "preview (use --yes para gravar)"}\n`,
  );

  // Step 1: schema
  const schemaResult = await applySchemaChanges(
    supabase,
    decisions.projectId,
    decisions.newFields,
    changedBy,
    write,
  );
  console.log("---- SCHEMA ----");
  console.log(JSON.stringify(schemaResult, null, 2));

  // Step 2: resolutions
  console.log("\n---- RESOLUÇÕES ----");
  const results = await resolveComments(
    supabase,
    decisions.projectId,
    changedBy,
    decisions.resolutions,
    write,
  );
  console.log(JSON.stringify(results, null, 2));

  // Step 3: summaryNote (opcional)
  if (decisions.summaryNote && write) {
    const { error } = await supabase.from("project_comments").insert({
      project_id: decisions.projectId,
      author_id: changedBy,
      body: decisions.summaryNote,
      resolved_at: new Date().toISOString(),
      resolved_by: changedBy,
    });
    if (error) {
      console.error(`summary note insert: ${error.message}`);
    } else {
      console.log("\n[info] summaryNote registrada em project_comments.");
    }
  }

  // Este script roda fora do runtime Next, então não pode chamar
  // revalidatePath/revalidateTag como saveSchemaFromGUI faz — o cache da GUI
  // (revalidateTag com expire:60) pode continuar servindo o schema/versão
  // antigos por até ~60s após um --yes que aplicou mudança de schema.
  if (write && (schemaResult as { applied?: boolean }).applied) {
    console.log(
      "\n[aviso] Schema atualizado no banco. A GUI pode levar até ~60s para " +
        "refletir a mudança (cache do Next) — se precisar ver o resultado " +
        "imediatamente, recarregue a página específica com Ctrl+Shift+R.",
    );
  }
}

main().catch((err) => {
  console.error(`ERRO: ${err?.message ?? err}`);
  process.exit(1);
});
