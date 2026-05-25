// Extrai a lista de numeros de processo (CNJ) do projeto Zolgensma a partir
// dos gabaritos (view final_answers, campo q3_numero_processo_judicial),
// normaliza os CNJs, classifica por tribunal e emite:
//
//   data/zolgensma/processos.csv         lista completa com classificacao
//   data/zolgensma/processos-tjsp.txt    apenas CNJs do TJSP (input do scraper)
//   data/zolgensma/extraction-report.md  relatorio em pt-BR
//
// Uso:
//   node scripts/zolgensma/extract-processos.mjs            # dry-run
//   node scripts/zolgensma/extract-processos.mjs --apply    # grava arquivos

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const APPLY = process.argv.includes("--apply");

const envPath = resolve(REPO_ROOT, "frontend", ".env.local");
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

const PROJECT_ID = "0c6394da-dd2e-4ac0-af83-a107fae37ad4";
const FIELD = "q3_numero_processo_judicial";
const PROVENANCE_OK = ["consenso", "auto_corrigido", "equivalente", "arbitrado"];

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
};

async function rest(path) {
  const res = await fetch(`${URL}/rest/v1${path}`, { headers });
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// --- normalizacao CNJ -------------------------------------------------------

// Captura sequencia de 20 digitos com mascaras opcionais.
const CNJ_RE = /\d{7}-?\d{2}\.?\d{4}\.?\d\.?\d{2}\.?\d{4}/g;

function normalizeCnj(raw) {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 20) return null;
  return [
    digits.slice(0, 7),
    "-",
    digits.slice(7, 9),
    ".",
    digits.slice(9, 13),
    ".",
    digits.slice(13, 14),
    ".",
    digits.slice(14, 16),
    ".",
    digits.slice(16, 20),
  ].join("");
}

// Tabela parcial de segmentos (J) e tribunais (TT) — cobre o que pode aparecer
// em relatorios NATJUS (Estaduais + Federais).
const SEGMENT = {
  1: "STF", 2: "CNJ", 3: "STJ", 4: "Justica Federal",
  5: "Justica do Trabalho", 6: "Justica Eleitoral", 7: "Justica Militar Uniao",
  8: "Justica Estadual", 9: "Justica Militar Estadual",
};

const TJ_ESTADUAL = {
  "01": "TJAC", "02": "TJAL", "03": "TJAP", "04": "TJAM", "05": "TJBA",
  "06": "TJCE", "07": "TJDFT", "08": "TJES", "09": "TJGO", "10": "TJMA",
  "11": "TJMT", "12": "TJMS", "13": "TJMG", "14": "TJPA", "15": "TJPB",
  "16": "TJPR", "17": "TJPE", "18": "TJPI", "19": "TJRJ", "20": "TJRN",
  "21": "TJRS", "22": "TJRO", "23": "TJRR", "24": "TJSC", "25": "TJSE",
  "26": "TJSP", "27": "TJTO",
};

function tribunalSigla(cnj) {
  if (!cnj) return null;
  const digits = cnj.replace(/\D/g, "");
  const j = digits.slice(13, 14);
  const tt = digits.slice(14, 16);
  if (j === "8") return TJ_ESTADUAL[tt] ?? `J8-${tt}`;
  if (j === "4") return `TRF${parseInt(tt, 10)}`;
  return `${SEGMENT[j] ?? `J${j}`}-${tt}`;
}

function isTjsp(cnj) {
  if (!cnj) return false;
  const digits = cnj.replace(/\D/g, "");
  return digits.slice(13, 16) === "826";
}

// --- main -------------------------------------------------------------------

console.log(`Projeto: ${PROJECT_ID}`);
console.log(`Campo: ${FIELD}`);
console.log(`Provenance aceitas: ${PROVENANCE_OK.join(", ")}\n`);

const provenanceFilter = `provenance=in.(${PROVENANCE_OK.join(",")})`;
const rows = await rest(
  `/final_answers?project_id=eq.${PROJECT_ID}&field_name=eq.${FIELD}&${provenanceFilter}&select=document_id,answer,provenance,changed_after_justification`,
);
console.log(`Gabaritos com answer nao-nulo: ${rows.filter((r) => r.answer != null).length} / ${rows.length}`);

const docIds = [...new Set(rows.map((r) => r.document_id))];
const docs = await rest(
  `/documents?id=in.(${docIds.join(",")})&select=id,external_id`,
);
const docMap = new Map(docs.map((d) => [d.id, d.external_id]));

const records = []; // {document_id, external_id, cnj_raw, cnj_normalized, tribunal_sigla, provenance, changed_after_justification}
const issues = []; // {document_id, external_id, motivo, answer}

for (const row of rows) {
  const external_id = docMap.get(row.document_id) ?? null;
  // answer eh JSONB cru — para campo text, vem string com aspas no JSON,
  // PostgREST devolve ja parseado: string ou null.
  const answer = row.answer;
  if (answer == null) {
    issues.push({
      document_id: row.document_id,
      external_id,
      motivo: "answer NULL",
      answer: null,
    });
    continue;
  }
  if (typeof answer !== "string") {
    issues.push({
      document_id: row.document_id,
      external_id,
      motivo: `answer tipo inesperado: ${typeof answer}`,
      answer: JSON.stringify(answer).slice(0, 120),
    });
    continue;
  }
  const matches = answer.match(CNJ_RE) ?? [];
  if (matches.length === 0) {
    issues.push({
      document_id: row.document_id,
      external_id,
      motivo: "sem CNJ valido (20 digitos)",
      answer: answer.slice(0, 120),
    });
    continue;
  }
  for (const m of matches) {
    const norm = normalizeCnj(m);
    if (!norm) continue;
    records.push({
      document_id: row.document_id,
      external_id,
      cnj_raw: m,
      cnj_normalized: norm,
      tribunal_sigla: tribunalSigla(norm),
      provenance: row.provenance,
      changed_after_justification: row.changed_after_justification ?? false,
    });
  }
}

// Deduplicar por CNJ normalizado, mantendo a primeira ocorrencia.
const seen = new Set();
const unique = [];
for (const r of records) {
  if (seen.has(r.cnj_normalized)) continue;
  seen.add(r.cnj_normalized);
  unique.push(r);
}

const byTrib = {};
for (const r of unique) {
  byTrib[r.tribunal_sigla] = (byTrib[r.tribunal_sigla] ?? 0) + 1;
}
const tjspList = unique.filter((r) => isTjsp(r.cnj_normalized));

console.log(`\nCNJs extraidos (com duplicatas): ${records.length}`);
console.log(`CNJs unicos: ${unique.length}`);
console.log(`Issues (sem CNJ ou answer invalido): ${issues.length}`);
console.log(`\nDistribuicao por tribunal:`);
for (const [t, n] of Object.entries(byTrib).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t.padEnd(10)} ${n}`);
}
console.log(`\nTJSP (foco da raspagem): ${tjspList.length}`);

if (!APPLY) {
  console.log("\n[DRY-RUN] Nada foi escrito. Rode com --apply para gravar.");
  process.exit(0);
}

// --- escrever artefatos -----------------------------------------------------

const outDir = resolve(REPO_ROOT, "data", "zolgensma");
mkdirSync(outDir, { recursive: true });

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// processos.csv (todos os CNJs unicos)
const csvHeader = [
  "document_id",
  "external_id",
  "cnj_raw",
  "cnj_normalized",
  "tribunal_sigla",
  "provenance",
  "changed_after_justification",
].join(",");
const csvLines = [csvHeader];
for (const r of unique) {
  csvLines.push(
    [
      r.document_id,
      r.external_id,
      r.cnj_raw,
      r.cnj_normalized,
      r.tribunal_sigla,
      r.provenance,
      r.changed_after_justification ? "true" : "false",
    ]
      .map(csvEscape)
      .join(","),
  );
}
writeFileSync(resolve(outDir, "processos.csv"), csvLines.join("\n") + "\n");

// processos-tjsp.txt (uma linha por CNJ TJSP)
writeFileSync(
  resolve(outDir, "processos-tjsp.txt"),
  tjspList.map((r) => r.cnj_normalized).join("\n") + "\n",
);

// extraction-report.md
const lines = [];
lines.push("# Extracao de processos do projeto Zolgensma");
lines.push("");
lines.push(`Gerado em: ${new Date().toISOString()}`);
lines.push("");
lines.push("## Fonte");
lines.push("");
lines.push(`- Projeto: \`${PROJECT_ID}\``);
lines.push(`- Campo: \`${FIELD}\``);
lines.push(`- View: \`final_answers\` (gabarito resolvido por auto-revisao + arbitragem)`);
lines.push(`- Provenance aceitas: ${PROVENANCE_OK.map((p) => `\`${p}\``).join(", ")}`);
lines.push("");
lines.push("## Numeros");
lines.push("");
lines.push(`- Gabaritos lidos: ${rows.length}`);
lines.push(`- Gabaritos com \`answer\` nao-nulo: ${rows.filter((r) => r.answer != null).length}`);
lines.push(`- Extracoes brutas de CNJ (com duplicatas): ${records.length}`);
lines.push(`- CNJs unicos apos deduplicacao: ${unique.length}`);
lines.push(`- Issues (answer nulo, tipo inesperado ou sem CNJ valido): ${issues.length}`);
lines.push(`- CNJs do TJSP (foco da raspagem): ${tjspList.length}`);
lines.push("");
lines.push("## Distribuicao por tribunal");
lines.push("");
lines.push("| Tribunal | CNJs unicos |");
lines.push("|----------|-------------|");
for (const [t, n] of Object.entries(byTrib).sort((a, b) => b[1] - a[1])) {
  lines.push(`| ${t} | ${n} |`);
}
lines.push("");
lines.push("## Issues");
lines.push("");
if (issues.length === 0) {
  lines.push("Nenhuma.");
} else {
  lines.push("| document_id | external_id | motivo | answer (trecho) |");
  lines.push("|-------------|-------------|--------|-----------------|");
  for (const i of issues) {
    lines.push(
      `| ${i.document_id} | ${i.external_id ?? ""} | ${i.motivo} | ${(i.answer ?? "").toString().replace(/\|/g, "\\|").slice(0, 80)} |`,
    );
  }
}
lines.push("");
lines.push("## Artefatos");
lines.push("");
lines.push("- `processos.csv` — todos os CNJs unicos com classificacao por tribunal");
lines.push("- `processos-tjsp.txt` — apenas TJSP (input do scraper)");
lines.push("- `extraction-report.md` — este relatorio");
writeFileSync(resolve(outDir, "extraction-report.md"), lines.join("\n") + "\n");

console.log(`\nGravado em: ${outDir}`);
console.log(`  processos.csv           (${unique.length} linhas)`);
console.log(`  processos-tjsp.txt      (${tjspList.length} CNJs)`);
console.log(`  extraction-report.md`);
