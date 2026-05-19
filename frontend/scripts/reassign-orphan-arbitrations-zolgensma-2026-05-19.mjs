// Realoca arbitragens orfas do projeto Zolgensma.
//
// Contexto: ao desmarcar can_arbitrate de varios membros, as arbitragens que
// ja estavam atribuidas a eles ficaram presas — atribuidas a quem nao pode
// mais arbitrar, sem realocacao e sem aparecer no banner de pendencias (que
// so conta arbitrator_id IS NULL). Este script corrige a base de dados,
// replicando o comportamento que setCanArbitrate passou a ter (release +
// re-sorteio). One-off, autonomo, sem runtime Next — mesmo padrao de
// allocate-zolgensma-2026-05-05.mjs.
//
// Alvo: field_reviews com self_verdict='contesta_llm' AND final_verdict IS NULL
// cujo arbitrator_id e um membro com can_arbitrate=false OU um nao-membro.
// Reatribui do zero: limpa arbitrator_id/blind_verdict/blind_decided_at e
// re-sorteia entre os membros elegiveis (can_arbitrate=true), excluindo o
// auto-revisor original, balanceando por carga.
//
// Uso:
//   node frontend/scripts/reassign-orphan-arbitrations-zolgensma-2026-05-19.mjs           # dry-run
//   node frontend/scripts/reassign-orphan-arbitrations-zolgensma-2026-05-19.mjs --apply   # escreve

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");

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

// --- constantes -------------------------------------------------------------
const PROJECT_ID = "0c6394da-dd2e-4ac0-af83-a107fae37ad4"; // Zolgensma
const SEED = 20260519;

// --- helpers ----------------------------------------------------------------
async function rest(path, init = {}) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`${r.status} ${path}: ${body}`);
  }
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

// Mulberry32: PRNG deterministico — dry-run preve exatamente o --apply.
function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);

// Replica a selecao de assignArbitrator (field-reviews.ts): menor carga,
// pesquisador tem prioridade sobre coordenador, sorteio entre empatados.
function pickArbitrator(pool, loadByUser) {
  let minLoad = Infinity;
  for (const m of pool) {
    const l = loadByUser.get(m.user_id) ?? 0;
    if (l < minLoad) minLoad = l;
  }
  const atMin = pool.filter((m) => (loadByUser.get(m.user_id) ?? 0) === minLoad);
  const researchers = atMin.filter((m) => m.role === "pesquisador");
  const finalPool = researchers.length > 0 ? researchers : atMin;
  return finalPool[Math.floor(rand() * finalPool.length)].user_id;
}

// --- fetch ------------------------------------------------------------------
const members = await rest(
  `project_members?select=user_id,role,can_arbitrate&project_id=eq.${PROJECT_ID}`,
);
const eligible = members
  .filter((m) => m.can_arbitrate)
  .map((m) => ({ user_id: m.user_id, role: m.role }));
const eligibleIds = new Set(eligible.map((m) => m.user_id));

const profiles = await rest(
  `profiles?select=id,first_name,email&id=in.(${members.map((m) => m.user_id).join(",")})`,
);
const nameOf = (id) => {
  const p = profiles.find((x) => x.id === id);
  return p ? p.first_name || p.email || id : `(nao-membro ${id.slice(0, 8)})`;
};

const stuck = await rest(
  `field_reviews?select=id,document_id,field_name,self_reviewer_id,arbitrator_id,blind_verdict` +
    `&project_id=eq.${PROJECT_ID}` +
    `&self_verdict=eq.contesta_llm` +
    `&final_verdict=is.null` +
    `&arbitrator_id=not.is.null`,
);
const orphans = stuck.filter((fr) => !eligibleIds.has(fr.arbitrator_id));

console.log("=== Arbitragens orfas no projeto Zolgensma ===");
console.log(`Membros elegiveis (can_arbitrate=true): ${eligible.length}`);
console.log(`field_reviews em arbitragem nao concluida: ${stuck.length}`);
console.log(`  presos em ex-arbitros / nao-membros: ${orphans.length}`);

if (orphans.length === 0) {
  console.log("\nNada a corrigir.");
  process.exit(0);
}

// Agrupa por ex-arbitro (diagnostico)
const byArbiter = new Map();
for (const fr of orphans) {
  byArbiter.set(fr.arbitrator_id, (byArbiter.get(fr.arbitrator_id) ?? 0) + 1);
}
console.log("\nPor ex-arbitro:");
for (const [id, n] of byArbiter) {
  console.log(`  ${nameOf(id).padEnd(24)} ${n} caso(s)`);
}

// Agrupa por (document_id, self_reviewer_id) — mesma regra de retryPendingArbitrations:
// todos os campos contestados do mesmo doc/auto-revisor recebem o MESMO arbitro.
const groups = new Map();
for (const fr of orphans) {
  const key = `${fr.document_id}|${fr.self_reviewer_id}`;
  const g = groups.get(key) ?? {
    documentId: fr.document_id,
    selfReviewerId: fr.self_reviewer_id,
    ids: [],
  };
  g.ids.push(fr.id);
  groups.set(key, g);
}
console.log(`\nGrupos (document_id, self_reviewer_id): ${groups.size}`);

if (eligible.length === 0) {
  console.log(
    "\nABORTADO: nenhum membro elegivel para arbitrar. Marque ao menos um " +
      "membro como Arbitra antes de rodar a realocacao.",
  );
  process.exit(1);
}

if (!APPLY) {
  console.log("\n[DRY-RUN] Nada foi escrito. Rode com --apply para corrigir.");
  process.exit(0);
}

// --- apply ------------------------------------------------------------------
console.log("\n--apply: corrigindo a base...");

const orphanIds = orphans.map((fr) => fr.id);
const docIds = [...new Set(orphans.map((fr) => fr.document_id))];
const exArbiterIds = [...byArbiter.keys()];

// a) Deleta os assignments de arbitragem nao concluidos dos ex-arbitros nos
//    docs afetados — senao ficariam pendentes para sempre e contariam como
//    carga deles no balanceamento.
await rest(
  `assignments?project_id=eq.${PROJECT_ID}` +
    `&type=eq.arbitragem` +
    `&status=neq.concluido` +
    `&user_id=in.(${exArbiterIds.join(",")})` +
    `&document_id=in.(${docIds.join(",")})`,
  { method: "DELETE" },
);
console.log("  assignments orfaos deletados");

// b) Limpa arbitrator_id/blind_verdict/blind_decided_at de todos os afetados.
//    Grupos que ficarem sem pool permanecem com arbitrator_id IS NULL — caem
//    no banner de "sem arbitro elegivel".
for (let i = 0; i < orphanIds.length; i += 100) {
  const chunk = orphanIds.slice(i, i + 100);
  await rest(`field_reviews?id=in.(${chunk.join(",")})`, {
    method: "PATCH",
    body: JSON.stringify({
      arbitrator_id: null,
      blind_verdict: null,
      blind_decided_at: null,
    }),
  });
}
console.log(`  ${orphanIds.length} field_reviews limpos`);

// c) Carga inicial: assignments de arbitragem abertos por usuario (apos o
//    delete em (a)).
const openAssignments = await rest(
  `assignments?select=user_id&project_id=eq.${PROJECT_ID}` +
    `&type=eq.arbitragem&status=neq.concluido`,
);
const loadByUser = new Map();
for (const a of openAssignments) {
  loadByUser.set(a.user_id, (loadByUser.get(a.user_id) ?? 0) + 1);
}

// d) Re-sorteio sequencial — cada grupo recalcula a carga, preservando o
//    balanceamento (mesma razao do loop sequencial em retryPendingArbitrations).
let assigned = 0;
let noPool = 0;
const summary = [];
for (const g of groups.values()) {
  const pool = eligible.filter((m) => m.user_id !== g.selfReviewerId);
  if (pool.length === 0) {
    noPool++;
    summary.push({ doc: g.documentId, arbiter: "(sem pool)", n: g.ids.length });
    continue;
  }
  const arbitratorId = pickArbitrator(pool, loadByUser);
  loadByUser.set(arbitratorId, (loadByUser.get(arbitratorId) ?? 0) + 1);

  await rest(`field_reviews?id=in.(${g.ids.join(",")})`, {
    method: "PATCH",
    body: JSON.stringify({ arbitrator_id: arbitratorId }),
  });
  await rest(
    `assignments?on_conflict=document_id,user_id,type`,
    {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({
        project_id: PROJECT_ID,
        document_id: g.documentId,
        user_id: arbitratorId,
        type: "arbitragem",
        status: "pendente",
      }),
    },
  );
  assigned += g.ids.length;
  summary.push({
    doc: g.documentId,
    arbiter: nameOf(arbitratorId),
    n: g.ids.length,
  });
}

console.log("\nResumo da realocacao:");
for (const s of summary) {
  console.log(`  ${s.doc.slice(0, 8)}  ->  ${s.arbiter.padEnd(24)} ${s.n} campo(s)`);
}
console.log(
  `\nFeito: ${assigned} field_review(s) realocado(s); ` +
    `${noPool} grupo(s) sem pool (ficam no banner de pendencias).`,
);
console.log(
  `Rollback nao trivial (arbitrator_id antigo foi sobrescrito) — ` +
    `os ids afetados: ${orphanIds.length} linhas em field_reviews.`,
);
