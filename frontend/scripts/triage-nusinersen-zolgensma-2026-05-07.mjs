// Triagem de pareceres de Nusinersena no projeto Zolgensma.
//
// Como pareceres do NATJUS sobre AME mencionam multiplos medicamentos
// (Zolgensma, Nusinersena, Risdiplam), regex em keyword nao basta — usa Haiku
// via Claude Agent SDK para classificar o medicamento PRINCIPAL do caso.
//
// Fluxos:
//   1) dry-run (gera CSV para revisao):
//        node frontend/scripts/triage-nusinersen-zolgensma-2026-05-07.mjs --since=2026-04-25
//        node frontend/scripts/triage-nusinersen-zolgensma-2026-05-07.mjs --limit=50
//   2) aplicar exclusoes a partir do CSV revisado (preencha coluna decision):
//        node frontend/scripts/triage-nusinersen-zolgensma-2026-05-07.mjs --from-csv=triage-...csv --apply
//
// Pre-requisitos:
//   - .env.local com NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY
//   - Claude Code logado localmente (usa creditos da subscription via SDK)
//   - Migration de soft delete aplicada (20260508030508_documents_soft_delete.sql)

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const FROM_CSV = args.find((a) => a.startsWith("--from-csv="))?.split("=")[1];
const SINCE = args.find((a) => a.startsWith("--since="))?.split("=")[1];
const LIMIT = parseInt(
  args.find((a) => a.startsWith("--limit="))?.split("=")[1] || "0",
);

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
const BRUNO_USER_ID = "234c08f3-b4eb-41fc-8b99-5b1419f4f7b0";
const HAIKU_MODEL = "claude-haiku-4-5";
const TEXT_TRUNCATE = 10_000;
const CONCURRENCY = 3;
const EXCLUDE_REASON =
  "Triagem 2026-05-07: parecer fora do escopo do projeto Zolgensma (medicamento principal != onasemnogeno)";

// --- supabase rest ----------------------------------------------------------
async function rest(path, init = {}) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      Prefer: init.method === "POST" ? "return=representation" : "",
      ...(init.headers || {}),
    },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`${r.status} ${path}: ${body}`);
  }
  if (r.status === 204) return null;
  return r.json();
}

// --- classificacao via Claude Agent SDK -------------------------------------
const SYSTEM_PROMPT = [
  "Voce e especialista em direito sanitario brasileiro.",
  "Pareceres do NATJUS sobre AME (atrofia muscular espinhal) frequentemente mencionam multiplos medicamentos (Zolgensma, Nusinersena, Risdiplam) porque sao alternativas terapeuticas.",
  "Mas o caso clinico analisado tem UM medicamento pedido/prescrito.",
  "Sua tarefa: identificar o medicamento PRINCIPAL do caso, ignorando mencoes apenas comparativas.",
  "Responda SOMENTE com JSON valido (sem fencing, sem texto antes/depois).",
].join(" ");

async function classifyDocument(title, text) {
  const truncated =
    text.length > TEXT_TRUNCATE
      ? text.slice(0, TEXT_TRUNCATE) + "\n\n[... TEXTO TRUNCADO ...]"
      : text;

  const prompt = `Titulo: ${title || "(sem titulo)"}\n\nTexto do parecer:\n${truncated}\n\nResponda em JSON:\n{\n  "drug": "zolgensma" | "nusinersena" | "risdiplam" | "ambos" | "outro",\n  "confidence": numero entre 0 e 1,\n  "justification": "uma frase em portugues explicando"\n}`;

  let resultText = "";
  for await (const message of query({
    prompt,
    options: {
      model: HAIKU_MODEL,
      systemPrompt: SYSTEM_PROMPT,
      allowedTools: [],
      permissionMode: "bypassPermissions",
      settingSources: [],
      maxTurns: 1,
      includePartialMessages: false,
    },
  })) {
    if (message.type === "result") {
      if (message.subtype === "success") {
        resultText = message.result;
      } else {
        throw new Error(
          `SDK result subtype=${message.subtype}: ${JSON.stringify(message)}`,
        );
      }
    }
  }

  if (!resultText) throw new Error("SDK nao retornou result");
  const match = resultText.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Resposta sem JSON: ${resultText.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

// --- semaforo ---------------------------------------------------------------
async function runWithConcurrency(items, fn, concurrency = CONCURRENCY) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  const total = items.length;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = { error: e.message };
      }
      done++;
      process.stderr.write(`\r  classificados: ${done}/${total}`);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    worker,
  );
  await Promise.all(workers);
  process.stderr.write("\n");
  return results;
}

// --- csv helpers ------------------------------------------------------------
function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
    return `"${s.replace(/"/g, "\"\"")}"`;
  }
  return s;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === "\"" && text[i + 1] === "\"") {
        cell += "\"";
        i++;
      } else if (c === "\"") {
        inQuotes = false;
      } else {
        cell += c;
      }
    } else {
      if (c === "\"") {
        inQuotes = true;
      } else if (c === ",") {
        row.push(cell);
        cell = "";
      } else if (c === "\n") {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else if (c === "\r") {
        // ignora
      } else {
        cell += c;
      }
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ============================================================================
// MODO 1: --from-csv --apply
// ============================================================================
if (FROM_CSV) {
  if (!APPLY) {
    console.log("--from-csv requer --apply (proteção)");
    process.exit(1);
  }
  const csvPath = resolve(process.cwd(), FROM_CSV);
  const text = readFileSync(csvPath, "utf8");
  const rows = parseCsv(text);
  const header = rows[0];
  const body = rows.slice(1).filter((r) => r.length >= header.length);
  const colIdx = Object.fromEntries(header.map((h, i) => [h, i]));
  const need = ["id", "decision"];
  for (const k of need) {
    if (colIdx[k] === undefined) throw new Error(`CSV sem coluna ${k}`);
  }

  const toExclude = body
    .filter((r) => (r[colIdx.decision] || "").trim().toLowerCase() === "excluir")
    .map((r) => r[colIdx.id]);

  console.log(
    `CSV: ${body.length} linhas; marcadas para exclusao: ${toExclude.length}`,
  );
  if (toExclude.length === 0) {
    console.log("Nada a fazer.");
    process.exit(0);
  }

  console.log("\nIDs a excluir (soft delete):");
  for (const id of toExclude.slice(0, 10)) console.log(`  ${id}`);
  if (toExclude.length > 10) console.log(`  ... +${toExclude.length - 10}`);

  const CHUNK = 50;
  let updated = 0;
  for (let i = 0; i < toExclude.length; i += CHUNK) {
    const chunk = toExclude.slice(i, i + CHUNK);
    const filter = `id=in.(${chunk.join(",")})`;
    await rest(`documents?${filter}&project_id=eq.${PROJECT_ID}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        excluded_at: new Date().toISOString(),
        excluded_reason: EXCLUDE_REASON,
        excluded_by: BRUNO_USER_ID,
      }),
    });
    updated += chunk.length;
    process.stderr.write(`\r  excluidos: ${updated}/${toExclude.length}`);
  }
  process.stderr.write("\n");

  console.log(`\nFeito: ${updated} documentos marcados como excluidos.`);
  console.log("\nRollback (se necessario):");
  console.log(
    `  UPDATE documents SET excluded_at = NULL, excluded_reason = NULL, excluded_by = NULL`,
  );
  console.log(
    `  WHERE id IN (${toExclude.map((id) => `'${id}'`).join(", ")});`,
  );
  process.exit(0);
}

// ============================================================================
// MODO 2: dry-run (classifica e gera CSV)
// ============================================================================

let queryParams = `select=id,external_id,title,text,created_at&project_id=eq.${PROJECT_ID}&excluded_at=is.null`;
if (SINCE) queryParams += `&created_at=gte.${SINCE}`;
queryParams += `&order=created_at.desc`;
if (LIMIT > 0) queryParams += `&limit=${LIMIT}`;

console.log("Buscando documentos do projeto Zolgensma...");
console.log(
  `  filtros: since=${SINCE || "(nenhum)"}  limit=${LIMIT || "(nenhum)"}`,
);

const docs = await rest(`documents?${queryParams}`);
console.log(`  encontrados: ${docs.length}`);

if (docs.length === 0) {
  console.log("Nada a classificar.");
  process.exit(0);
}

console.log(
  `\nClassificando com ${HAIKU_MODEL} via Claude Agent SDK (concorrencia ${CONCURRENCY})...`,
);
console.log(
  "  (usa creditos da subscription Claude Code — sem ANTHROPIC_API_KEY)",
);

const classifications = await runWithConcurrency(docs, async (doc) => {
  return await classifyDocument(doc.title, doc.text);
});

const summary = {
  zolgensma: 0,
  nusinersena: 0,
  risdiplam: 0,
  ambos: 0,
  outro: 0,
  erro: 0,
};
for (const c of classifications) {
  if (c?.error) summary.erro++;
  else summary[c?.drug] = (summary[c?.drug] || 0) + 1;
}
console.log("\nResumo:");
for (const [k, v] of Object.entries(summary)) {
  if (v > 0) console.log(`  ${k.padEnd(12)} ${v}`);
}

const today = new Date().toISOString().slice(0, 10);
const outPath = resolve(process.cwd(), `triage-nusinersen-${today}.csv`);
const header = [
  "id",
  "external_id",
  "title",
  "created_at",
  "drug",
  "confidence",
  "justification",
  "decision",
];
const lines = [header.map(csvEscape).join(",")];
for (let i = 0; i < docs.length; i++) {
  const d = docs[i];
  const c = classifications[i] || {};
  const isError = !!c.error;
  const drug = isError ? "erro" : c.drug || "";
  const conf = isError ? "" : (c.confidence ?? "");
  const just = isError ? c.error : c.justification || "";
  // sugestao default: tudo que nao for zolgensma/ambos com alta confianca = excluir
  const isOffScope =
    !isError &&
    drug !== "zolgensma" &&
    drug !== "ambos" &&
    Number(conf) >= 0.8;
  const suggestedDecision = isOffScope ? "excluir" : "";
  lines.push(
    [
      d.id,
      d.external_id || "",
      d.title || "",
      d.created_at,
      drug,
      conf,
      just,
      suggestedDecision,
    ]
      .map(csvEscape)
      .join(","),
  );
}
writeFileSync(outPath, lines.join("\n") + "\n", "utf8");

console.log(`\nCSV gerado: ${outPath}`);
console.log("\nProximos passos:");
console.log(
  "  1. Revisar manualmente o CSV — preencha 'decision' com 'excluir' ou 'manter'",
);
console.log(
  "     (linhas com drug != zolgensma/ambos e confidence >= 0.8 ja vem sugeridas como 'excluir')",
);
console.log(
  "  2. Aplicar: node frontend/scripts/triage-nusinersen-zolgensma-2026-05-07.mjs \\",
);
console.log(`     --from-csv=${outPath.split("/").pop()} --apply`);
