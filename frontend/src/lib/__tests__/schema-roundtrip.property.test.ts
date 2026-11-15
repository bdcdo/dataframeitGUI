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
  compiled: unknown[];
}

// Compila todos os códigos numa só chamada ao Python, pelo `compile_pydantic`
// de verdade. Código que não compila grava `compiled: null` e reprova abaixo.
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
  ) as unknown[][];
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
      expect(parseSaveablePydanticFields(c.fields), `caso ${c.case}`).not.toBeNull();
    }
  });

  it("o gerador de casos sorteia toda propriedade de PydanticField", () => {
    // Propriedade nova no schema Zod sem entrada no gerador de casos reprova
    // aqui: sem ela no sorteio, o round-trip não a testaria.
    const seen = new Set(CASES.flatMap((c) => c.fields.flatMap(Object.keys)));
    expect([...PYDANTIC_FIELD_PROPERTY_KEYS].filter((key) => !seen.has(key))).toEqual([]);
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
const TRIGGER = buildField({
  id: "00000000-0000-4000-8000-000000000525",
  name: "gatilho",
  type: "single",
  choiceOptions: ["Sim", "Não"],
  dateOptions: undefined,
  description: "Gatilho",
  help_text: undefined,
  target: undefined,
  required: undefined,
  allow_other: undefined,
  subfields: undefined,
  subfield_rule: undefined,
  condition: undefined,
  justification_prompt: undefined,
  question_revision: undefined,
});
// Toda escolha do gerador de casos; o `satisfies` faz o typecheck reprovar
// quando `FieldSpec` ganha uma chave que a propriedade não mutaria.
const SPEC_KEYS = Object.keys({
  id: true, name: true, type: true, choiceOptions: true, dateOptions: true,
  description: true, help_text: true, target: true, required: true,
  allow_other: true, subfields: true, subfield_rule: true, condition: true,
  justification_prompt: true, question_revision: true,
} satisfies Record<keyof FieldSpec, true>) as Array<keyof FieldSpec>;

describe("generatePydanticCode (propriedade)", () => {
  it("campos que o snapshot distingue geram códigos distintos", () => {
    const spec = fieldSpec([TRIGGER]).filter((s) => s.name !== TRIGGER.name);
    fc.assert(
      fc.property(spec, spec, fc.constantFrom(...SPEC_KEYS), (a, b, key) => {
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
