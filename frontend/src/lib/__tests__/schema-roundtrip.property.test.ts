import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PYDANTIC_FIELD_PROPERTY_KEYS,
  parsePydanticFields,
  parseSaveablePydanticFields,
} from "@/lib/pydantic-field";
import {
  fieldHashOf,
  generatePydanticCode,
  snapshotOf,
  stableStringify,
} from "@/lib/schema-utils";
import type { PydanticField } from "@/lib/types";
import {
  buildField,
  fieldSpec,
  schemaArbitrary,
  type FieldSpec,
} from "./pydantic-field-arbitrary";

// Round-trip do schema como propriedade (issue #525): para todo schema
// salvável, `compile_pydantic(generatePydanticCode(schema)) ≡ schema`. É a
// regra (a)–(e) do CLAUDE.md — Pydantic como fonte de verdade reconstruível —
// executada, em vez de lembrada a cada propriedade nova.
//
// Os dois lados vivem em linguagens diferentes, então o contrato passa por um
// arquivo, como `field_hash_parity_cases.json`: schemas sorteados pelo
// fast-check, o código que o gerador real emite para eles e os campos que o
// compilador real devolve desse código. Cada suíte prende o seu lado:
//
//   - aqui, o código emitido tem de ser o gravado (gerador mudou → regenerar),
//     e o que o compilador devolveu tem de ser o schema original pela
//     normalização canônica (`snapshotOf`, mais `id` e `hash`);
//   - em `backend/tests/test_schema_roundtrip.py`, o compilador tem de devolver
//     exatamente os campos gravados (compilador mudou → regenerar).
//
// Regenerar, depois de mudar o gerador, o compilador ou o gerador de casos
// (precisa do backend instalado, `uv sync`):
//
//   UPDATE_SCHEMA_ROUNDTRIP=1 npx vitest run schema-roundtrip
//
// A regeneração não conserta nada sozinha: se uma propriedade só vai (ou só
// volta), o caso regenerado reprova a equivalência abaixo.
const FIXTURE_URL = new URL(
  "../../../../backend/tests/schema_roundtrip_cases.json",
  import.meta.url,
);
const BACKEND_DIR = fileURLToPath(new URL("../../../../backend/", import.meta.url));
const FIXTURE_SEED = 525;
const FIXTURE_CASES = 60;

interface RoundTripCase {
  case: number;
  fields: PydanticField[];
  code: string;
  // Os campos que `compile_pydantic` devolveu, ou `{ errors }` quando o código
  // não compilou (o que reprova nas duas suítes).
  compiled: unknown;
}

// Compila todos os códigos numa só chamada ao Python, pelo `compile_pydantic`
// de verdade.
const COMPILE_ALL = `
import json, sys
from services.pydantic_compiler import compile_pydantic
out = []
for code in json.load(sys.stdin):
    result = compile_pydantic(code)
    out.append(result["fields"] if result["valid"] else {"errors": result["errors"]})
json.dump(out, sys.stdout, ensure_ascii=False)
`;

function regenerateFixture(): void {
  const schemas = fc.sample(schemaArbitrary(), { seed: FIXTURE_SEED, numRuns: FIXTURE_CASES });
  const codes = schemas.map((fields) => generatePydanticCode(fields));
  const compiled = JSON.parse(
    execFileSync("uv", ["run", "--quiet", "python", "-c", COMPILE_ALL], {
      cwd: BACKEND_DIR,
      input: JSON.stringify(codes),
      encoding: "utf8",
    }),
  ) as unknown[];
  const cases: RoundTripCase[] = schemas.map((fields, index) => ({
    case: index,
    fields,
    code: codes[index],
    compiled: compiled[index],
  }));
  writeFileSync(FIXTURE_URL, JSON.stringify(cases, null, 2) + "\n");
}

if (process.env.UPDATE_SCHEMA_ROUNDTRIP) regenerateFixture();

const CASES = JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as RoundTripCase[];

// O que "mesmo campo" quer dizer no app: a serialização canônica de
// `snapshotOf` (default implícito resolvido) mais a identidade, que o snapshot
// deixa de fora de propósito.
const canonical = (field: PydanticField) => ({ id: field.id, ...snapshotOf(field) });

describe("round-trip generatePydanticCode → compile_pydantic (casos gravados)", () => {
  it("os casos gravados são schemas salváveis", () => {
    for (const c of CASES) {
      expect(parseSaveablePydanticFields(c.fields).errors, `caso ${c.case}`).toEqual([]);
    }
  });

  it("o gerador de casos sorteia toda propriedade de PydanticField fora do default", () => {
    // Propriedade nova no schema Zod sem entrada no gerador de casos reprova
    // aqui: sem ela no sorteio, o round-trip não a testaria. Não basta a chave
    // aparecer: tirá-la de algum campo tem de mudar o campo canônico, senão
    // ela só foi sorteada no default (ou falta em `snapshotOf`, regra (c) do
    // CLAUDE.md) e o caminho que a emite e a lê de volta nunca roda. `hash`
    // fica de fora do snapshot por ser derivado, e é conferido à parte, abaixo.
    const exercised = (key: string) =>
      CASES.some((c) =>
        c.fields.some((field) => {
          if (!(key in field)) return false;
          if (key === "hash") return true;
          const without = Object.fromEntries(
            Object.entries(field).filter(([k]) => k !== key),
          ) as PydanticField;
          return stableStringify(canonical(field)) !== stableStringify(canonical(without));
        }),
      );
    expect(PYDANTIC_FIELD_PROPERTY_KEYS.filter((key) => !exercised(key))).toEqual([]);
  });

  it("o código gravado é o que o gerador emite hoje", () => {
    for (const c of CASES) {
      expect(generatePydanticCode(c.fields), `caso ${c.case}: regenere o arquivo`).toBe(c.code);
    }
  });

  it("o compilador devolve o schema original", () => {
    for (const c of CASES) {
      const compiled = parsePydanticFields(c.compiled);
      expect(compiled, `caso ${c.case}: ${JSON.stringify(c.compiled)}`).not.toBeNull();
      expect(compiled!.map(canonical), `caso ${c.case}`).toEqual(c.fields.map(canonical));
      // O hash que a recuperação recalcula é o que o save grava.
      expect(compiled!.map((f) => f.hash), `caso ${c.case}`).toEqual(c.fields.map(fieldHashOf));
    }
  });
});

// Propriedade só do frontend, sem depender do arquivo: dois campos que o app
// trata como diferentes não podem virar o mesmo código. É o que reprova na
// hora a propriedade que o gerador deixa de emitir — o compilador não teria
// como recuperar o que não está no texto.
const TRIGGER: PydanticField = {
  id: "00000000-0000-4000-8000-000000000525",
  name: "gatilho",
  type: "single",
  options: ["Sim", "Não"],
  description: "Gatilho",
};

describe("generatePydanticCode (propriedade)", () => {
  it("campos que o snapshot distingue geram códigos distintos", () => {
    const spec = fieldSpec([TRIGGER]).filter((s) => s.name !== TRIGGER.name);
    fc.assert(
      // A chave mutada sai do próprio spec sorteado (`fc.record` emite toda
      // chave, mesmo as `undefined`), então chave nova em `FieldSpec` entra
      // sozinha na mutação.
      fc.property(spec, spec, fc.nat(), (a, b, index) => {
        const keys = Object.keys(a) as Array<keyof FieldSpec>;
        const key = keys[index % keys.length];
        const before = buildField(a);
        const after = buildField({ ...a, [key]: b[key] });
        fc.pre(stableStringify(canonical(before)) !== stableStringify(canonical(after)));
        expect(generatePydanticCode([TRIGGER, after])).not.toBe(
          generatePydanticCode([TRIGGER, before]),
        );
      }),
      { numRuns: 100 },
    );
  });
});
