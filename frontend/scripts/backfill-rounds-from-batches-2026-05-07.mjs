// Backfill: cria uma rodada (rounds) por lote (assignment_batches) e
// associa as respostas humanas existentes a essas rodadas via join com
// assignments (assignment.batch_id -> rounds.source_batch_id).
//
// Idempotente via rounds.source_batch_id (UNIQUE partial index): rodar
// duas vezes nao duplica rodadas nem reescreve responses.
//
// Uso:
//   node frontend/scripts/backfill-rounds-from-batches-2026-05-07.mjs <PROJECT_ID>           # dry-run
//   node frontend/scripts/backfill-rounds-from-batches-2026-05-07.mjs <PROJECT_ID> --apply   # escreve

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const PROJECT_ID = argv.find((a) => !a.startsWith("--"));
if (!PROJECT_ID) {
  console.error("Uso: node ... <PROJECT_ID> [--apply]");
  process.exit(1);
}

// --- env --------------------------------------------------------------------
const envPath = resolve(__dirname, "..", ".env.local");
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
    }),
);
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) throw new Error("URL/KEY nao encontrados em .env.local");

// --- helpers ----------------------------------------------------------------
async function rest(path, init = {}) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      Prefer: init.method === "POST" || init.method === "PATCH" ? "return=representation" : "",
      ...(init.headers || {}),
    },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`${r.status} ${path}: ${body}`);
  }
  return r.json();
}

function formatBR(iso) {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}`;
}

function buildLabel(batch) {
  const date = formatBR(batch.created_at);
  return batch.label
    ? `Rodada de ${date} (${batch.label})`
    : `Rodada de ${date}`;
}

// --- fetch ------------------------------------------------------------------
const project = await rest(
  `projects?select=id,round_strategy,current_round_id&id=eq.${PROJECT_ID}`,
);
if (project.length === 0) throw new Error(`Projeto ${PROJECT_ID} nao encontrado`);
console.log(`Projeto: ${PROJECT_ID}`);
console.log(`  strategy atual: ${project[0].round_strategy}`);
console.log(`  current_round_id: ${project[0].current_round_id ?? "(nenhum)"}`);

const batches = await rest(
  `assignment_batches?select=id,label,created_at&project_id=eq.${PROJECT_ID}&order=created_at.asc&limit=500`,
);
console.log(`\nLotes encontrados: ${batches.length}`);

// Rodadas existentes ja vinculadas a batches (idempotencia).
const existingRounds = await rest(
  `rounds?select=id,label,source_batch_id&project_id=eq.${PROJECT_ID}&source_batch_id=not.is.null&limit=500`,
);
const batchToExistingRound = new Map(
  existingRounds.map((r) => [r.source_batch_id, r]),
);
console.log(`Rodadas ja vinculadas a lotes: ${existingRounds.length}`);

// --- preview ----------------------------------------------------------------
const toCreate = [];
for (const b of batches) {
  if (batchToExistingRound.has(b.id)) continue;
  toCreate.push({
    project_id: PROJECT_ID,
    label: buildLabel(b),
    source_batch_id: b.id,
    created_at: b.created_at,
  });
}

console.log(`\nA criar (rodadas novas): ${toCreate.length}`);
for (const r of toCreate) {
  console.log(`  + "${r.label}" <- batch ${r.source_batch_id.slice(0, 8)}`);
}

// Responses humanas sem round_id por batch (preview).
// Paralelizado via Promise.all: cada batch faz 2 fetches independentes
// (assignments + responses candidatas).
const pairKey = (d, u) => `${d}|${u}`;
const perBatchPlan = await Promise.all(
  batches.map(async (b) => {
    const assigns = await rest(
      `assignments?select=document_id,user_id&project_id=eq.${PROJECT_ID}&batch_id=eq.${b.id}&limit=1000`,
    );
    const existing = batchToExistingRound.get(b.id);
    if (assigns.length === 0) {
      return { batchId: b.id, roundId: existing?.id ?? null, pairs: [], count: 0 };
    }
    // Conta responses humanas sem round_id que casam (document_id,user_id).
    // Como nao da pra fazer IN tuple no PostgREST, busca por
    // (document_id IN ...) AND (respondent_id IN ...) e refina depois
    // intersectando com os pares exatos de assignments. Evita pegar
    // responses de quem nao foi assigned (e.g. browse mode com mesmo doc).
    const docIds = [...new Set(assigns.map((a) => a.document_id))];
    const userIds = [...new Set(assigns.map((a) => a.user_id))];
    const docFilter = `document_id=in.(${docIds.join(",")})`;
    const userFilter = `respondent_id=in.(${userIds.join(",")})`;
    const candidates = await rest(
      `responses?select=document_id,respondent_id&project_id=eq.${PROJECT_ID}&respondent_type=eq.humano&round_id=is.null&${docFilter}&${userFilter}&limit=2000`,
    );
    const validPairs = new Set(assigns.map((a) => pairKey(a.document_id, a.user_id)));
    const matches = candidates.filter((r) =>
      validPairs.has(pairKey(r.document_id, r.respondent_id)),
    );
    return {
      batchId: b.id,
      roundId: existing?.id ?? null,
      pairs: matches, // (document_id, respondent_id) pares a setar round_id
      count: matches.length,
    };
  }),
);
const totalToUpdate = perBatchPlan.reduce((acc, p) => acc + p.count, 0);
console.log(`\nResponses humanas sem round_id a atualizar: ${totalToUpdate}`);

if (!APPLY) {
  console.log("\n[DRY-RUN] Nada foi escrito. Rode com --apply para aplicar.");
  process.exit(0);
}

// --- apply ------------------------------------------------------------------
console.log("\n--apply: gravando...");

// 1) garantir strategy=manual
if (project[0].round_strategy !== "manual") {
  await rest(`projects?id=eq.${PROJECT_ID}`, {
    method: "PATCH",
    body: JSON.stringify({ round_strategy: "manual" }),
  });
  console.log("  round_strategy = manual");
}

// 2) inserir rodadas novas (chunked)
const newRoundsByBatch = new Map();
if (toCreate.length > 0) {
  const inserted = await rest("rounds", {
    method: "POST",
    body: JSON.stringify(toCreate),
  });
  for (const r of inserted) newRoundsByBatch.set(r.source_batch_id, r);
  console.log(`  +${inserted.length} rodadas`);
}

// 3) atualizar responses por par (document_id, respondent_id)
let updated = 0;
for (const plan of perBatchPlan) {
  const roundId = plan.roundId ?? newRoundsByBatch.get(plan.batchId)?.id;
  if (!roundId) continue;
  for (const p of plan.pairs) {
    const path =
      `responses?project_id=eq.${PROJECT_ID}` +
      `&document_id=eq.${p.document_id}` +
      `&respondent_id=eq.${p.respondent_id}` +
      `&respondent_type=eq.humano` +
      `&round_id=is.null`;
    const res = await rest(path, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ round_id: roundId }),
    });
    updated += res.length;
  }
  if (plan.pairs.length > 0) {
    console.log(`  batch ${plan.batchId.slice(0, 8)} -> ${plan.pairs.length} responses`);
  }
}
console.log(`  responses atualizadas: ${updated}`);

// 4) marcar a rodada do lote mais recente como current_round_id —
// SO se ainda nao houver um current_round_id setado. Evita pisar em
// configuracao manual feita em /config/rounds.
const lastBatch = batches.at(-1);
if (lastBatch) {
  const target =
    batchToExistingRound.get(lastBatch.id)?.id ??
    newRoundsByBatch.get(lastBatch.id)?.id;
  if (target) {
    if (project[0].current_round_id == null) {
      await rest(`projects?id=eq.${PROJECT_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ current_round_id: target }),
      });
      console.log(`  current_round_id = ${target} (lote mais recente)`);
    } else if (project[0].current_round_id !== target) {
      console.log(
        `  current_round_id ja setado (${project[0].current_round_id}) — preservado.`,
      );
      console.log(
        `  Para apontar para a rodada do lote mais recente (${target}), atualize manualmente em /config/rounds.`,
      );
    }
  }
}

console.log("\nFeito.");
