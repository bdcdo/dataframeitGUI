#!/usr/bin/env -S npx tsx
/**
 * apply-decisions.ts
 *
 * Lê um arquivo JSON com a lista estruturada de decisões (produzido pelo Claude
 * a partir do .md anotado pelo usuário) e aplica:
 *   1. Mudanças no schema Pydantic (replicando primitivas de saveSchemaFromGUI):
 *      - update projects.{pydantic_code, pydantic_hash, pydantic_fields, schema_version_*}
 *      - insert schema_change_log entries
 *      - invalidar responses LLM com hash antigo
 *   2. Resolução dos comentários via INSERT/UPDATE nas tabelas corretas.
 *
 * Uso:
 *   cd frontend
 *   npx tsx scripts/comentarios-relatorio/apply-decisions.ts <decisions.json> [--dry-run] [--yes]
 *
 * Formato esperado do JSON: ver references/decisions-format.md
 *
 * Observação: `generatePydanticCode` é importado diretamente de
 * `src/lib/schema-utils` (pure, client-safe) para manter paridade com a UI
 * e evitar drift. A lógica de classificação de versão e persistência duplica
 * `saveSchemaFromGUI` de `src/actions/schema.ts` porque server actions não
 * são chamáveis fora do Next runtime.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { generatePydanticCode } from "../../src/lib/schema-utils";
import type { FieldCondition, PydanticField as LibPydanticField } from "../../src/lib/types";

// ----------------------- Env loading -----------------------

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
    "Faltam NEXT_PUBLIC_SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY no .env.local",
  );
  process.exit(1);
}

// ----------------------- Tipos -----------------------

type PydanticField = LibPydanticField;

// Formato do JSON de entrada. O Claude gera esse arquivo parseando o .md anotado.
interface DecisionsFile {
  projectId: string;
  // ID do usuário a registrar como changed_by / resolved_by.
  // Se omitido, tenta pegar o created_by do projeto.
  changedBy?: string;
  // Nova lista completa de fields a persistir (já com add/remove/edit aplicados).
  newFields: PydanticField[];
  // Lista de comentários a resolver.
  resolutions: Array<
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
  >;
  // Opcional: nota resumo a registrar num project_comment "meta" após aplicação.
  summaryNote?: string;
}

// ----------------------- Funções puras -----------------------
// `generatePydanticCode` vem de `src/lib/schema-utils` (mesma função usada pela UI).
// Apenas utilitários específicos do script ficam aqui.

function pythonListRepr(arr: string[]): string {
  return "[" + arr.map((s) => `'${s}'`).join(", ") + "]";
}

function computeFieldHash(
  name: string,
  type: string,
  options: string[] | null,
  description: string,
): string {
  const optionsPart = options ? pythonListRepr([...options].sort()) : "";
  const content = `${name}|${type}|${optionsPart}|${description}`;
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
}

type ChangeType = "major" | "minor" | "patch";

function classifyChange(
  oldFields: PydanticField[],
  newFields: PydanticField[],
): ChangeType | null {
  const oldNames = new Set(oldFields.map((f) => f.name));
  const newNames = new Set(newFields.map((f) => f.name));

  const addedOrRemoved =
    newFields.some((f) => !oldNames.has(f.name)) ||
    oldFields.some((f) => !newNames.has(f.name));

  if (addedOrRemoved) return "minor";

  let hasStructural = false;
  let hasTextual = false;
  const oldMap = new Map(oldFields.map((f) => [f.name, f]));

  for (const n of newFields) {
    const o = oldMap.get(n.name);
    if (!o) continue;

    if (o.type !== n.type) hasStructural = true;
    if ((o.target ?? "all") !== (n.target ?? "all")) hasStructural = true;
    if ((o.required ?? true) !== (n.required ?? true)) hasStructural = true;
    if ((o.subfield_rule ?? null) !== (n.subfield_rule ?? null)) hasStructural = true;
    if ((o.allow_other ?? false) !== (n.allow_other ?? false)) hasStructural = true;
    if (JSON.stringify(o.subfields ?? null) !== JSON.stringify(n.subfields ?? null)) {
      hasStructural = true;
    }

    const optsOld = o.options ?? [];
    const optsNew = n.options ?? [];
    const setOld = new Set(optsOld);
    const setNew = new Set(optsNew);
    const sameSet =
      setOld.size === setNew.size && [...setOld].every((x) => setNew.has(x));
    if (!sameSet) {
      hasStructural = true;
    } else if (optsOld.length !== optsNew.length) {
      hasStructural = true;
    } else {
      for (let i = 0; i < optsOld.length; i++) {
        if (optsOld[i] !== optsNew[i]) {
          hasTextual = true;
          break;
        }
      }
    }

    if (o.description !== n.description) hasTextual = true;
    if ((o.help_text || "") !== (n.help_text || "")) hasTextual = true;
  }

  if (!hasStructural && !hasTextual) {
    for (let i = 0; i < newFields.length; i++) {
      if (newFields[i].name !== oldFields[i]?.name) {
        hasTextual = true;
        break;
      }
    }
  }

  if (hasStructural) return "minor";
  if (hasTextual) return "patch";
  return null;
}

function bumpVersion(
  current: { major: number; minor: number; patch: number },
  type: ChangeType,
): { major: number; minor: number; patch: number } {
  if (type === "major") return { major: current.major + 1, minor: 0, patch: 0 };
  if (type === "minor")
    return { major: current.major, minor: current.minor + 1, patch: 0 };
  return { major: current.major, minor: current.minor, patch: current.patch + 1 };
}

function snapshotOf(field: PydanticField): Record<string, unknown> {
  return {
    name: field.name,
    type: field.type,
    description: field.description,
    help_text: field.help_text ?? null,
    options: field.options ?? null,
    target: field.target ?? null,
    required: field.required ?? null,
    subfields: field.subfields ?? null,
    subfield_rule: field.subfield_rule ?? null,
    allow_other: field.allow_other ?? null,
  };
}

// ----------------------- Schema apply -----------------------

async function applySchemaChanges(
  supabase: SupabaseClient,
  projectId: string,
  newFields: PydanticField[],
  changedBy: string,
  dryRun: boolean,
) {
  const { data: project, error: projErr } = await supabase
    .from("projects")
    .select(
      "pydantic_fields, pydantic_hash, schema_version_major, schema_version_minor, schema_version_patch",
    )
    .eq("id", projectId)
    .single();
  if (projErr) throw new Error(`projects select: ${projErr.message}`);

  const oldFields = (project?.pydantic_fields as PydanticField[]) ?? [];
  const oldMap = new Map(oldFields.map((f) => [f.name, f]));
  const newMap = new Map(newFields.map((f) => [f.name, f]));

  const current = {
    major: project?.schema_version_major ?? 0,
    minor: project?.schema_version_minor ?? 1,
    patch: project?.schema_version_patch ?? 0,
  };

  const changeType = classifyChange(oldFields, newFields);
  const bumped = changeType ? bumpVersion(current, changeType) : current;

  // Audit entries
  const logEntries: Array<{
    field_name: string;
    change_summary: string;
    before_value: Record<string, unknown>;
    after_value: Record<string, unknown>;
  }> = [];

  for (const f of newFields) {
    if (oldMap.has(f.name)) continue;
    logEntries.push({
      field_name: f.name,
      change_summary: "campo adicionado",
      before_value: {},
      after_value: snapshotOf(f),
    });
  }
  for (const o of oldFields) {
    if (newMap.has(o.name)) continue;
    logEntries.push({
      field_name: o.name,
      change_summary: "campo removido",
      before_value: snapshotOf(o),
      after_value: {},
    });
  }
  for (const f of newFields) {
    const old = oldMap.get(f.name);
    if (!old) continue;
    const diffs: string[] = [];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (old.description !== f.description) {
      diffs.push("descrição");
      before.description = old.description;
      after.description = f.description;
    }
    if ((old.help_text || "") !== (f.help_text || "")) {
      diffs.push("instruções");
      before.help_text = old.help_text || null;
      after.help_text = f.help_text || null;
    }
    const oldOpts = JSON.stringify(old.options ?? null);
    const newOpts = JSON.stringify(f.options ?? null);
    if (oldOpts !== newOpts) {
      diffs.push(f.type === "text" ? "respostas padronizadas" : "opções");
      before.options = old.options;
      after.options = f.options;
    }
    if (old.type !== f.type) {
      diffs.push("tipo");
      before.type = old.type;
      after.type = f.type;
    }
    if ((old.target ?? "all") !== (f.target ?? "all")) {
      diffs.push("alvo");
      before.target = old.target ?? null;
      after.target = f.target ?? null;
    }
    if ((old.required ?? true) !== (f.required ?? true)) {
      diffs.push("obrigatório");
      before.required = old.required ?? null;
      after.required = f.required ?? null;
    }
    if ((old.subfield_rule ?? null) !== (f.subfield_rule ?? null)) {
      diffs.push("regra de subcampos");
      before.subfield_rule = old.subfield_rule ?? null;
      after.subfield_rule = f.subfield_rule ?? null;
    }
    if ((old.allow_other ?? false) !== (f.allow_other ?? false)) {
      diffs.push("permite outro");
      before.allow_other = old.allow_other ?? false;
      after.allow_other = f.allow_other ?? false;
    }
    const oldSubs = JSON.stringify(old.subfields ?? null);
    const newSubs = JSON.stringify(f.subfields ?? null);
    if (oldSubs !== newSubs) {
      diffs.push("subcampos");
      before.subfields = old.subfields ?? null;
      after.subfields = f.subfields ?? null;
    }
    if (diffs.length > 0) {
      logEntries.push({
        field_name: f.name,
        change_summary: diffs.join(", "),
        before_value: before,
        after_value: after,
      });
    }
  }

  const code = generatePydanticCode(newFields);
  const hash = crypto.createHash("sha256").update(code).digest("hex").slice(0, 16);
  const fieldsWithHash = newFields.map((f) => ({
    ...f,
    hash: computeFieldHash(f.name, f.type, f.options, f.description),
  }));

  const summary = {
    changeType,
    currentVersion: `${current.major}.${current.minor}.${current.patch}`,
    newVersion: `${bumped.major}.${bumped.minor}.${bumped.patch}`,
    hashChanged: project?.pydantic_hash !== hash,
    logEntryCount: logEntries.length,
    logEntries,
    pydanticCodePreview: code.split("\n").slice(0, 10).join("\n") + "\n...",
  };

  if (dryRun) {
    return { dryRun: true, summary };
  }

  if (!changeType && logEntries.length === 0) {
    return { dryRun: false, summary, applied: false, reason: "sem mudanças" };
  }

  // Update projects
  const updatePayload: Record<string, unknown> = {
    pydantic_code: code,
    pydantic_hash: hash,
    pydantic_fields: fieldsWithHash,
  };
  if (changeType) {
    updatePayload.schema_version_major = bumped.major;
    updatePayload.schema_version_minor = bumped.minor;
    updatePayload.schema_version_patch = bumped.patch;
  }
  const { error: updErr } = await supabase
    .from("projects")
    .update(updatePayload)
    .eq("id", projectId);
  if (updErr) throw new Error(`projects update: ${updErr.message}`);

  // Invalidate LLM responses if hash changed
  if (project?.pydantic_hash && project.pydantic_hash !== hash) {
    const { error: respErr } = await supabase
      .from("responses")
      .update({ is_current: false })
      .eq("project_id", projectId)
      .eq("respondent_type", "llm")
      .neq("pydantic_hash", hash);
    if (respErr) throw new Error(`responses update: ${respErr.message}`);
  }

  // Audit log
  if (logEntries.length > 0) {
    const { error: logErr } = await supabase.from("schema_change_log").insert(
      logEntries.map((e) => ({
        project_id: projectId,
        changed_by: changedBy,
        change_type: changeType ?? "patch",
        version_major: bumped.major,
        version_minor: bumped.minor,
        version_patch: bumped.patch,
        ...e,
      })),
    );
    if (logErr) throw new Error(`schema_change_log insert: ${logErr.message}`);
  }

  return { dryRun: false, summary, applied: true };
}

// ----------------------- Comment resolution -----------------------

async function resolveComment(
  supabase: SupabaseClient,
  projectId: string,
  changedBy: string,
  r: DecisionsFile["resolutions"][number],
  dryRun: boolean,
): Promise<{ success: boolean; error?: string; detail?: string }> {
  if (dryRun) {
    return { success: true, detail: `DRY RUN: would resolve ${r.source} ${JSON.stringify(r)}` };
  }
  const nowIso = new Date().toISOString();
  try {
    if (r.source === "anotacao") {
      const { data, error } = await supabase
        .from("project_comments")
        .update({ resolved_at: nowIso, resolved_by: changedBy })
        .eq("id", r.rawId)
        .eq("project_id", projectId)
        .select("id");
      if (error) return { success: false, error: error.message };
      if (!data || data.length === 0) return { success: false, error: "not found" };
      return { success: true };
    }
    if (r.source === "review") {
      const { error } = await supabase
        .from("reviews")
        .update({ resolved_at: nowIso, resolved_by: changedBy })
        .eq("id", r.rawId);
      if (error) return { success: false, error: error.message };
      return { success: true };
    }
    if (r.source === "nota") {
      const { error } = await supabase.from("note_resolutions").insert({
        project_id: projectId,
        response_id: r.rawId,
        resolved_by: changedBy,
        note: r.note || null,
      });
      if (error) return { success: false, error: error.message };
      return { success: true };
    }
    if (r.source === "dificuldade") {
      const { error } = await supabase.from("difficulty_resolutions").insert({
        project_id: projectId,
        response_id: r.rawId,
        document_id: r.documentId,
        resolved_by: changedBy,
        note: r.note || null,
      });
      if (error) return { success: false, error: error.message };
      return { success: true };
    }
    if (r.source === "duvida") {
      const { data, error } = await supabase
        .from("verdict_acknowledgments")
        .update({ resolved_at: nowIso, resolved_by: changedBy })
        .eq("review_id", r.reviewId)
        .eq("respondent_id", r.respondentId)
        .select("review_id");
      if (error) return { success: false, error: error.message };
      if (!data || data.length === 0) return { success: false, error: "not found" };
      return { success: true };
    }
    if (r.source === "sugestao") {
      const payload: Record<string, unknown> = {
        status: r.action,
        resolved_by: changedBy,
        resolved_at: nowIso,
      };
      if (r.action === "rejected" && r.rejectionReason) {
        payload.rejection_reason = r.rejectionReason;
      }
      const { error } = await supabase
        .from("schema_suggestions")
        .update(payload)
        .eq("id", r.rawId);
      if (error) return { success: false, error: error.message };
      return { success: true };
    }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { success: false, error: "unknown source" };
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
    console.error("Não foi possível resolver changedBy. Forneça decisions.changedBy.");
    process.exit(1);
  }

  console.log(
    `Projeto: ${decisions.projectId}\nchangedBy: ${changedBy}\nNovos fields: ${decisions.newFields.length}\nResoluções: ${decisions.resolutions.length}\ndry-run: ${args.dryRun}\n`,
  );

  // Step 1: schema
  const schemaResult = await applySchemaChanges(
    supabase,
    decisions.projectId,
    decisions.newFields,
    changedBy,
    args.dryRun,
  );
  console.log("---- SCHEMA ----");
  console.log(JSON.stringify(schemaResult, null, 2));

  // Step 2: confirmação antes de resolver comentários (se não dry-run e não --yes)
  if (!args.dryRun && !args.yes) {
    console.log(
      "\n[info] Para prosseguir com a resolução dos comentários, rode novamente com --yes.",
    );
    return;
  }

  // Step 3: resolutions
  console.log("\n---- RESOLUÇÕES ----");
  const results: Array<{ item: unknown; result: unknown }> = [];
  for (const r of decisions.resolutions) {
    const res = await resolveComment(
      supabase,
      decisions.projectId,
      changedBy,
      r,
      args.dryRun,
    );
    results.push({ item: r, result: res });
  }
  console.log(JSON.stringify(results, null, 2));

  // Step 4: summaryNote (opcional)
  if (decisions.summaryNote && !args.dryRun) {
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
}

main().catch((err) => {
  console.error(`ERRO: ${err?.message ?? err}`);
  process.exit(1);
});
