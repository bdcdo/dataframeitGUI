// Deduplica documentos do projeto Zolgensma que foram duplicados por
// re-importacoes (INSERT puro, sem UNIQUE(project_id, external_id)).
//
// Para cada par de documentos com o mesmo external_id, escolhe a copia
// SOBREVIVENTE (a com mais trabalho humano), MOVE todos os registros filhos
// da copia perdedora para a sobrevivente (responses, field_reviews,
// assignments, reviews, response_equivalences, error/difficulty_resolutions,
// project_comments) e faz SOFT-DELETE (excluded_at) da perdedora. A
// sobrevivente e reativada se estiver excluida.
//
// GARANTIA "nao perder responses": responses nao tem UNIQUE constraint, entao
// TODAS as responses da perdedora sao movidas para a sobrevivente (zero perda).
// Conflitos de UNIQUE em field_reviews(document_id, field_name) e
// assignments(document_id, user_id, type) sao detectados: a linha conflitante
// da perdedora NAO e movida (fica na copia soft-deletada + no backup JSON),
// nunca deletada.
//
// SEGURANCA:
//   - dry-run e o default; --apply para escrever.
//   - recomputa o manifesto AO VIVO (o snapshot do DEDUP_ZOLGENSMA report pode
//     estar velho — a equipe codifica as copias ativas em tempo real).
//   - guard de atividade: recusa --apply se houver responses/field_reviews
//     criados/editados nos ultimos --quiet-min minutos (default 30). Use
//     --force para sobrepor (NAO recomendado fora de janela de freeze).
//   - backup JSON de cada par antes de mutar (em ./dedup-backups/, gitignored).
//   - soft-delete reversivel; o backup permite restaurar.
//
// Diagnostico completo e plano: docs/DEDUP_ZOLGENSMA_2026-06.md
//
// Uso:
//   node frontend/scripts/dedup-merge-zolgensma-2026-06-18.mjs                # dry-run, todos os pares
//   node frontend/scripts/dedup-merge-zolgensma-2026-06-18.mjs --only NATJUS-FEDERAL-0803-2019
//   node frontend/scripts/dedup-merge-zolgensma-2026-06-18.mjs --apply        # executa (em janela de freeze)
//   node frontend/scripts/dedup-merge-zolgensma-2026-06-18.mjs --apply --reconcile-latest
//   node frontend/scripts/dedup-merge-zolgensma-2026-06-18.mjs --apply --quiet-min 60

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const FORCE = argv.includes("--force");
const RECONCILE_LATEST = argv.includes("--reconcile-latest");
const ONLY = (() => {
  const i = argv.indexOf("--only");
  return i >= 0 ? argv[i + 1] : null;
})();
const QUIET_MIN = (() => {
  const i = argv.indexOf("--quiet-min");
  return i >= 0 ? Number(argv[i + 1]) : 30;
})();

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

const PROJECT_ID = "0c6394da-dd2e-4ac0-af83-a107fae37ad4"; // Zolgensma
const CHANGED_BY = "234c08f3-b4eb-41fc-8b99-5b1419f4f7b0"; // bruno (coordenador)
const BACKUP_DIR = resolve(__dirname, "dedup-backups");

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
};

async function rest(method, path, body, extraHeaders) {
  const res = await fetch(`${URL}/rest/v1${path}`, {
    method,
    headers: { ...headers, ...(extraHeaders || {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

// Tabelas filhas com FK document_id. conflict = chave do UNIQUE por documento.
const CHILD_TABLES = [
  { name: "responses", conflict: null },
  { name: "field_reviews", conflict: ["field_name"] },
  { name: "assignments", conflict: ["user_id", "type"] },
  { name: "reviews", conflict: null, optional: true },
  { name: "response_equivalences", conflict: null },
  { name: "error_resolutions", conflict: null },
  { name: "difficulty_resolutions", conflict: null },
  { name: "project_comments", conflict: null },
];

async function tableExists(name) {
  try {
    await rest("GET", `/${name}?limit=1&select=id`);
    return true;
  } catch {
    return false;
  }
}

async function childRows(table, docId) {
  return rest("GET", `/${table}?document_id=eq.${docId}&select=*`);
}

function hscore(p) {
  return (
    p.frev * 100 +
    p.H * 10 +
    p.equiv * 5 +
    p.errRes * 3 +
    p.assign * 2 +
    p.comm * 1
  );
}

async function profile(docId, available) {
  const resp = await childRows("responses", docId);
  const H = resp.filter((r) => r.respondent_type === "humano");
  const L = resp.filter((r) => r.respondent_type === "llm");
  const frev = await childRows("field_reviews", docId);
  const assign = await childRows("assignments", docId);
  const equiv = available.response_equivalences
    ? await childRows("response_equivalences", docId)
    : [];
  const errRes = available.error_resolutions
    ? await childRows("error_resolutions", docId)
    : [];
  const comm = available.project_comments
    ? await childRows("project_comments", docId)
    : [];
  return {
    H: H.length,
    L: L.length,
    responses: resp,
    frev: frev.length,
    fields: new Set(frev.map((x) => x.field_name)),
    assign: assign.length,
    aset: new Set(assign.map((x) => `${x.user_id}|${x.type}`)),
    equiv: equiv.length,
    errRes: errRes.length,
    comm: comm.length,
    coders: [...new Set(H.map((r) => r.respondent_id).filter(Boolean))],
  };
}

// --- guard de atividade ao vivo --------------------------------------------
async function latestActivity() {
  const [fr] = await rest(
    "GET",
    `/field_reviews?project_id=eq.${PROJECT_ID}&select=created_at&order=created_at.desc&limit=1`,
  );
  const [ru] = await rest(
    "GET",
    `/responses?project_id=eq.${PROJECT_ID}&select=updated_at&order=updated_at.desc&limit=1`,
  );
  const ts = [fr?.created_at, ru?.updated_at]
    .filter(Boolean)
    .map((t) => new Date(t).getTime());
  return ts.length ? Math.max(...ts) : 0;
}

// --- manifesto --------------------------------------------------------------
async function buildManifest(available) {
  const docs = await rest(
    "GET",
    `/documents?project_id=eq.${PROJECT_ID}&select=id,external_id,created_at,excluded_at&order=external_id.asc,created_at.asc`,
  );
  const by = new Map();
  for (const d of docs) {
    if (!d.external_id) continue;
    if (!by.has(d.external_id)) by.set(d.external_id, []);
    by.get(d.external_id).push(d);
  }

  const pairs = [];
  for (const [eid, copies] of by) {
    if (copies.length !== 2) continue; // casos de 1 ou 3+ tratados a parte
    if (ONLY && eid !== ONLY) continue;
    const [a, b] = copies;
    const pa = await profile(a.id, available);
    const pb = await profile(b.id, available);
    const sa = hscore(pa);
    const sb = hscore(pb);

    let surv, lose, ps, pl;
    if (sa !== sb) [surv, lose, ps, pl] = sa > sb ? [a, b, pa, pb] : [b, a, pb, pa];
    else if (!!a.excluded_at !== !!b.excluded_at)
      [surv, lose, ps, pl] = !a.excluded_at ? [a, b, pa, pb] : [b, a, pb, pa];
    else [surv, lose, ps, pl] = [a, b, pa, pb];

    const loserHasHuman =
      pl.frev > 0 || pl.H > 0 || pl.equiv > 0 || pl.errRes > 0 || pl.comm > 0;
    let kind;
    if (sa === 0 && sb === 0) kind = "NOOP";
    else if (!loserHasHuman && lose.excluded_at) kind = "NOOP";
    else kind = "MERGE";

    const confFields = [...pl.fields].filter((f) => ps.fields.has(f));
    const confAssign = [...pl.aset].filter((k) => ps.aset.has(k));
    pairs.push({ eid, surv, lose, ps, pl, kind, confFields, confAssign });
  }
  return pairs;
}

// --- execucao de um par MERGE ----------------------------------------------
async function mergePair(pair, available) {
  const { eid, surv, lose, ps, pl, confFields, confAssign } = pair;
  const log = [];
  const survFields = ps.fields;
  const survAset = ps.aset;

  // backup do estado atual das duas copias (todas as tabelas filhas)
  const backup = { external_id: eid, survivor: surv, loser: lose, tables: {} };
  for (const t of CHILD_TABLES) {
    if (t.optional && !available[t.name]) continue;
    backup.tables[t.name] = {
      survivor: await childRows(t.name, surv.id),
      loser: await childRows(t.name, lose.id),
    };
  }
  if (APPLY) {
    mkdirSync(BACKUP_DIR, { recursive: true });
    writeFileSync(
      resolve(BACKUP_DIR, `${eid}.json`),
      JSON.stringify(backup, null, 2),
    );
    log.push(`backup -> dedup-backups/${eid}.json`);
  }

  const respBefore = ps.H + ps.L + pl.H + pl.L;

  // mover filhos
  for (const t of CHILD_TABLES) {
    if (t.optional && !available[t.name]) continue;
    const rows = backup.tables[t.name].loser;
    if (rows.length === 0) continue;

    if (!t.conflict) {
      // sem conflito possivel por documento -> bulk move
      if (APPLY)
        await rest(
          "PATCH",
          `/${t.name}?document_id=eq.${lose.id}`,
          { document_id: surv.id },
        );
      log.push(`${t.name}: mover ${rows.length}`);
      continue;
    }

    // tabela com UNIQUE por documento -> mover por id, pulando conflitos
    const existing = t.name === "field_reviews" ? survFields : survAset;
    const keyOf = (r) =>
      t.name === "field_reviews" ? r.field_name : `${r.user_id}|${r.type}`;
    let moved = 0;
    const skipped = [];
    for (const r of rows) {
      if (existing.has(keyOf(r))) {
        skipped.push(keyOf(r));
        continue;
      }
      if (APPLY)
        await rest("PATCH", `/${t.name}?id=eq.${r.id}`, {
          document_id: surv.id,
        });
      moved++;
    }
    log.push(
      `${t.name}: mover ${moved}` +
        (skipped.length ? `, PULAR ${skipped.length} (conflito: ${skipped.join(", ")})` : ""),
    );
  }

  // reconciliar is_latest (opcional)
  if (RECONCILE_LATEST) {
    const all = [...backup.tables.responses.survivor, ...backup.tables.responses.loser];
    for (const type of ["humano", "llm"]) {
      const ofType = all
        .filter((r) => r.respondent_type === type)
        .sort(
          (x, y) =>
            new Date(y.updated_at || y.created_at) -
            new Date(x.updated_at || x.created_at),
        );
      ofType.forEach((r, idx) => {
        const wantLatest = idx === 0;
        if (!!r.is_latest !== wantLatest && APPLY) {
          rest("PATCH", `/responses?id=eq.${r.id}`, { is_latest: wantLatest });
        }
      });
      if (ofType.length > 1)
        log.push(`is_latest(${type}): 1 latest de ${ofType.length}`);
    }
  } else if (ps.H > 0 && pl.H > 0) {
    log.push(
      `ATENCAO: 2 codificacoes humanas na sobrevivente apos merge ` +
        `(coders ${pl.coders.some((c) => ps.coders.includes(c)) ? "iguais" : "distintos"}) ` +
        `-- considere --reconcile-latest`,
    );
  }

  // reativar sobrevivente (se excluida) e soft-delete perdedora
  if (surv.excluded_at) {
    if (APPLY)
      await rest("PATCH", `/documents?id=eq.${surv.id}`, {
        excluded_at: null,
        excluded_reason: null,
        excluded_by: null,
      });
    log.push("reativar sobrevivente (excluded_at=null)");
  }
  if (!lose.excluded_at || true) {
    const reason = `Duplicata fundida em ${surv.id} (dedup import 2026-06)`;
    if (APPLY)
      await rest("PATCH", `/documents?id=eq.${lose.id}`, {
        excluded_at: new Date().toISOString(),
        excluded_reason: reason,
        excluded_by: CHANGED_BY,
      });
    log.push("soft-delete perdedora");
  }

  // verificar (so no apply): responses na sobrevivente == soma das duas antes
  let verify = "";
  if (APPLY) {
    const after = await childRows("responses", surv.id);
    verify =
      after.length === respBefore
        ? `OK responses ${respBefore}->${after.length}`
        : `!! responses esperado ${respBefore}, obtido ${after.length}`;
  }

  return { log, verify };
}

// --- main -------------------------------------------------------------------
console.log(`Projeto Zolgensma ${PROJECT_ID}`);
console.log(`Modo: ${APPLY ? "APPLY (grava)" : "DRY-RUN (so relata)"}`);
if (ONLY) console.log(`Filtro: --only ${ONLY}`);

const available = {};
for (const t of CHILD_TABLES) available[t.name] = await tableExists(t.name);
const missing = CHILD_TABLES.filter((t) => !available[t.name]).map((t) => t.name);
if (missing.length) console.log(`Tabelas ausentes (ignoradas): ${missing.join(", ")}`);

// guard de atividade ao vivo
const last = await latestActivity();
const ageMin = last ? (Date.now() - last) / 60000 : Infinity;
console.log(
  `Ultima atividade (responses/field_reviews): ` +
    `${last ? new Date(last).toISOString() : "—"} (${ageMin.toFixed(0)} min atras)`,
);
if (APPLY && ageMin < QUIET_MIN && !FORCE) {
  console.error(
    `\nABORTADO: atividade ha ${ageMin.toFixed(0)} min (< ${QUIET_MIN}). ` +
      `O projeto parece em uso ao vivo. Rode numa janela de freeze ou use --force.`,
  );
  process.exit(1);
}

const pairs = await buildManifest(available);
const merges = pairs.filter((p) => p.kind === "MERGE");
const noops = pairs.filter((p) => p.kind === "NOOP");

console.log(`\nPares duplicados analisados: ${pairs.length}  |  MERGE=${merges.length}  NOOP=${noops.length}\n`);

for (const p of merges) {
  console.log(`### ${p.eid}  [MERGE]`);
  console.log(
    `   SURV ${p.surv.id.slice(0, 8)} (${String(p.surv.created_at).slice(0, 10)}, ${p.surv.excluded_at ? "excluida->reativar" : "ativa"}) ` +
      `H${p.ps.H} L${p.ps.L} frev${p.ps.frev} assign${p.ps.assign} equiv${p.ps.equiv}`,
  );
  console.log(
    `   LOSE ${p.lose.id.slice(0, 8)} (${String(p.lose.created_at).slice(0, 10)}, ${p.lose.excluded_at ? "excluida" : "ativa->soft-delete"}) ` +
      `H${p.pl.H} L${p.pl.L} frev${p.pl.frev} assign${p.pl.assign} equiv${p.pl.equiv}`,
  );
  if (p.confFields.length) console.log(`   conflito field_reviews: ${p.confFields.join(", ")}`);
  if (p.confAssign.length) console.log(`   conflito assignments: ${p.confAssign.join(", ")}`);
  const { log, verify } = await mergePair(p, available);
  for (const l of log) console.log(`     - ${l}`);
  if (verify) console.log(`     => ${verify}`);
  console.log("");
}

console.log("=== NOOP (sem acao) ===");
for (const p of noops) console.log(`   ${p.eid}`);

if (!APPLY) console.log("\nDRY-RUN. Rode com --apply (em janela de freeze) para persistir.");
else console.log("\nOK. Backups em dedup-backups/. Soft-delete reversivel.");
