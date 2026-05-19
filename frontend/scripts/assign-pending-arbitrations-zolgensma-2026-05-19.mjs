// Atribui arbitro aos field_reviews do projeto Zolgensma que estao em
// arbitragem mas sem arbitro (arbitrator_id IS NULL) — tipicamente documentos
// de calibracao codificados por toda a equipe elegivel, onde nao ha terceiro
// totalmente neutro.
//
// Regra (mesma de assignArbitrator): prefere arbitro que NAO codificou o
// documento; quando isso e impossivel, cai para qualquer elegivel que nao
// seja o auto-revisor — esse nunca arbitra, pois julgaria a propria resposta.
//
// One-off, mesmo padrao dos demais scripts reassign/fix de arbitragem.
//
// Uso:
//   node frontend/scripts/assign-pending-arbitrations-zolgensma-2026-05-19.mjs           # dry-run
//   node frontend/scripts/assign-pending-arbitrations-zolgensma-2026-05-19.mjs --apply   # escreve

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
  return p ? p.first_name || p.email || id.slice(0, 8) : id.slice(0, 8);
};

const pending = await rest(
  `field_reviews?select=id,document_id,field_name,self_reviewer_id` +
    `&project_id=eq.${PROJECT_ID}&self_verdict=eq.contesta_llm` +
    `&final_verdict=is.null&arbitrator_id=is.null`,
);

console.log("=== Arbitragens pendentes sem arbitro — Zolgensma ===");
console.log(`field_reviews em arbitragem sem arbitro: ${pending.length}`);

if (pending.length === 0) {
  console.log("\nNada a atribuir.");
  process.exit(0);
}
if (eligible.length === 0) {
  console.log("\nABORTADO: nenhum membro elegivel para arbitrar.");
  process.exit(1);
}

const docIds = [...new Set(pending.map((f) => f.document_id))];
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

// Agrupa por (document_id, self_reviewer_id) — 1 arbitro por grupo.
const groups = new Map();
for (const f of pending) {
  const key = `${f.document_id}|${f.self_reviewer_id}`;
  const g = groups.get(key) ?? {
    documentId: f.document_id,
    selfReviewerId: f.self_reviewer_id,
    ids: [],
  };
  g.ids.push(f.id);
  groups.set(key, g);
}
console.log(`Grupos (document_id, self_reviewer_id): ${groups.size}`);

if (!APPLY) {
  console.log("\n[DRY-RUN] Nada foi escrito. Rode com --apply para atribuir.");
  for (const g of groups.values()) {
    const coders = codersByDoc.get(g.documentId) ?? new Set();
    const neutral = eligible.filter(
      (m) => m.user_id !== g.selfReviewerId && !coders.has(m.user_id),
    );
    const mode = neutral.length > 0 ? "neutro" : "fallback (codificou o doc)";
    console.log(
      `  doc=${g.documentId.slice(0, 8)}  auto-revisor=${nameOf(g.selfReviewerId)}  ` +
        `${g.ids.length} campo(s)  -> pool: ${mode}`,
    );
  }
  process.exit(0);
}

// --- apply ------------------------------------------------------------------
console.log("\n--apply: atribuindo arbitros...");

const openAssignments = await rest(
  `assignments?select=user_id&project_id=eq.${PROJECT_ID}` +
    `&type=eq.arbitragem&status=neq.concluido`,
);
const loadByUser = new Map();
for (const a of openAssignments) {
  loadByUser.set(a.user_id, (loadByUser.get(a.user_id) ?? 0) + 1);
}

let assigned = 0;
let noPool = 0;
const summary = [];
for (const g of groups.values()) {
  const coders = codersByDoc.get(g.documentId) ?? new Set();
  const elegOk = eligible.filter((m) => m.user_id !== g.selfReviewerId);
  const neutral = elegOk.filter((m) => !coders.has(m.user_id));
  const pool = neutral.length > 0 ? neutral : elegOk;
  if (pool.length === 0) {
    noPool++;
    summary.push({ doc: g.documentId, to: "(sem pool)", mode: "-", n: g.ids.length });
    continue;
  }
  const mode = neutral.length > 0 ? "neutro" : "fallback";
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
    to: nameOf(arbitratorId),
    mode,
    n: g.ids.length,
  });
}

console.log("\nResumo da atribuicao:");
for (const s of summary) {
  console.log(
    `  ${s.doc.slice(0, 8)}  ->  ${s.to.padEnd(24)} [${s.mode}] ${s.n} campo(s)`,
  );
}
console.log(
  `\nFeito: ${assigned} field_review(s) atribuido(s); ${noPool} grupo(s) sem pool.`,
);
