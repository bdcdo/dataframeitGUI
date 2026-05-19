// Corrige arbitragens do projeto Zolgensma em que o arbitro codificou o
// proprio documento — juiz em causa propria.
//
// Contexto: assignArbitrator so excluia do pool o auto-revisor original
// (self_reviewer). Quando um documento tem N codificadores humanos, qualquer
// outro deles podia ser sorteado como arbitro do mesmo doc. Este script
// reatribui esses casos com o pool correto (elegiveis que NAO codificaram o
// doc). One-off, mesmo padrao de reassign-orphan-arbitrations-zolgensma.
//
// Uso:
//   node frontend/scripts/fix-self-coded-arbitrations-zolgensma-2026-05-19.mjs           # dry-run
//   node frontend/scripts/fix-self-coded-arbitrations-zolgensma-2026-05-19.mjs --apply   # escreve

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

const profiles = await rest(
  `profiles?select=id,first_name,email&id=in.(${members.map((m) => m.user_id).join(",")})`,
);
const nameOf = (id) => {
  const p = profiles.find((x) => x.id === id);
  return p ? p.first_name || p.email || id : id.slice(0, 8);
};

const frs = await rest(
  `field_reviews?select=id,document_id,field_name,self_reviewer_id,arbitrator_id` +
    `&project_id=eq.${PROJECT_ID}&self_verdict=eq.contesta_llm` +
    `&final_verdict=is.null&arbitrator_id=not.is.null`,
);

const docIds = [...new Set(frs.map((f) => f.document_id))];
const codersByDoc = new Map();
for (let i = 0; i < docIds.length; i += 50) {
  const chunk = docIds.slice(i, i + 50);
  const resp = await rest(
    `responses?select=document_id,respondent_id&project_id=eq.${PROJECT_ID}` +
      `&respondent_type=eq.humano&document_id=in.(${chunk.join(",")})`,
  );
  for (const r of resp) {
    if (!codersByDoc.has(r.document_id)) codersByDoc.set(r.document_id, new Set());
    codersByDoc.get(r.document_id).add(r.respondent_id);
  }
}

// "Caso proprio": o arbitro deu resposta humana no documento que arbitra.
const selfCoded = frs.filter((f) =>
  codersByDoc.get(f.document_id)?.has(f.arbitrator_id),
);

console.log("=== Arbitragens 'caso proprio' no projeto Zolgensma ===");
console.log(`field_reviews em arbitragem nao concluida: ${frs.length}`);
console.log(`  com arbitro que codificou o doc: ${selfCoded.length}`);

if (selfCoded.length === 0) {
  console.log("\nNada a corrigir.");
  process.exit(0);
}

// Agrupa por (document_id, self_reviewer_id) — 1 arbitro por grupo no destino.
// oldArbitrators e um Set: um grupo inconsistente pode ter campos com arbitros
// distintos hoje, e todos precisam ter o assignment orfao limpo no passo 4.
const groups = new Map();
for (const f of selfCoded) {
  const key = `${f.document_id}|${f.self_reviewer_id}`;
  const g = groups.get(key) ?? {
    documentId: f.document_id,
    selfReviewerId: f.self_reviewer_id,
    oldArbitrators: new Set(),
    ids: [],
  };
  g.ids.push(f.id);
  g.oldArbitrators.add(f.arbitrator_id);
  groups.set(key, g);
}

console.log(`\nGrupos a reatribuir: ${groups.size}`);
for (const g of groups.values()) {
  const old = [...g.oldArbitrators].map(nameOf).join(", ");
  console.log(
    `  doc=${g.documentId.slice(0, 8)}  arbitro(s) atual=${old}  ` +
      `(${g.ids.length} campo(s))`,
  );
}

if (!APPLY) {
  console.log("\n[DRY-RUN] Nada foi escrito. Rode com --apply para corrigir.");
  process.exit(0);
}

// --- apply ------------------------------------------------------------------
console.log("\n--apply: corrigindo a base...");

const allIds = selfCoded.map((f) => f.id);

// 1) Limpa arbitrator_id/blind_verdict/blind_decided_at dos afetados.
await rest(`field_reviews?id=in.(${allIds.join(",")})`, {
  method: "PATCH",
  body: JSON.stringify({
    arbitrator_id: null,
    blind_verdict: null,
    blind_decided_at: null,
  }),
});
console.log(`  ${allIds.length} field_reviews limpos`);

// 2) Carga inicial: assignments de arbitragem abertos por usuario.
const openAssignments = await rest(
  `assignments?select=user_id&project_id=eq.${PROJECT_ID}` +
    `&type=eq.arbitragem&status=neq.concluido`,
);
const loadByUser = new Map();
for (const a of openAssignments) {
  loadByUser.set(a.user_id, (loadByUser.get(a.user_id) ?? 0) + 1);
}

// 3) Re-sorteio sequencial — pool exclui o auto-revisor E todos os
//    codificadores do documento.
let assigned = 0;
let noPool = 0;
const summary = [];
for (const g of groups.values()) {
  const coders = codersByDoc.get(g.documentId) ?? new Set();
  const pool = eligible.filter(
    (m) => m.user_id !== g.selfReviewerId && !coders.has(m.user_id),
  );
  const oldNames = [...g.oldArbitrators].map(nameOf).join(", ");
  if (pool.length === 0) {
    noPool++;
    summary.push({ doc: g.documentId, from: oldNames, to: "(sem pool)", n: g.ids.length });
    continue;
  }
  const arbitratorId = pickArbitrator(pool, loadByUser);
  loadByUser.set(arbitratorId, (loadByUser.get(arbitratorId) ?? 0) + 1);

  await rest(`field_reviews?id=in.(${g.ids.join(",")})`, {
    method: "PATCH",
    body: JSON.stringify({ arbitrator_id: arbitratorId }),
  });
  await rest(`assignments?on_conflict=document_id,user_id,type`, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({
      project_id: PROJECT_ID,
      document_id: g.documentId,
      user_id: arbitratorId,
      type: "arbitragem",
      status: "pendente",
    }),
  });
  assigned += g.ids.length;
  summary.push({
    doc: g.documentId,
    from: oldNames,
    to: nameOf(arbitratorId),
    n: g.ids.length,
  });
}

// 4) Limpa assignments de arbitragem orfaos: para cada (doc, arbitro antigo),
//    se nao restou nenhum field_review nao concluido daquele arbitro no doc,
//    deleta o assignment dele.
const pairs = new Map();
for (const f of selfCoded) {
  pairs.set(`${f.document_id}|${f.arbitrator_id}`, {
    documentId: f.document_id,
    arbitrator: f.arbitrator_id,
  });
}
let removedAssignments = 0;
for (const p of pairs.values()) {
  const remaining = await rest(
    `field_reviews?select=id&project_id=eq.${PROJECT_ID}` +
      `&document_id=eq.${p.documentId}&arbitrator_id=eq.${p.arbitrator}` +
      `&final_verdict=is.null&limit=1`,
  );
  if (remaining.length === 0) {
    await rest(
      `assignments?project_id=eq.${PROJECT_ID}&type=eq.arbitragem` +
        `&status=neq.concluido&document_id=eq.${p.documentId}` +
        `&user_id=eq.${p.arbitrator}`,
      { method: "DELETE" },
    );
    removedAssignments++;
  }
}

console.log("\nResumo da reatribuicao:");
for (const s of summary) {
  console.log(
    `  ${s.doc.slice(0, 8)}  ${s.from}  ->  ${s.to.padEnd(24)} ${s.n} campo(s)`,
  );
}
console.log(
  `\nFeito: ${assigned} field_review(s) reatribuido(s); ` +
    `${removedAssignments} assignment(s) orfao(s) removido(s); ` +
    `${noPool} grupo(s) sem pool.`,
);
