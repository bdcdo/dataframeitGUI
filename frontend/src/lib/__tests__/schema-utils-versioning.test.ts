import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import {
  computeFieldHash,
  classifyChange,
  bumpVersion,
  snapshotOf,
  diffFields,
  fieldDiffIsStructural,
  generatePydanticCode,
  isProjectScopedLogEntry,
  ORDER_LOG_FIELD_NAME,
  planSchemaPersistence,
  PROJECT_LOG_FIELD_NAME,
  stableStringify,
} from "@/lib/schema-utils";
import { pydanticFieldNameIssue } from "@/lib/pydantic-field";
import type { FieldCondition, PydanticField } from "@/lib/types";

const baseField = (over: Partial<PydanticField>): PydanticField => ({
  name: "x",
  type: "single",
  description: "x",
  options: null,
  ...over,
});

// Reproduz a fórmula de content do computeFieldHash (e do _field_hash do
// backend) para validar a implementação de SHA-256 em TS puro contra o
// crypto do Node.
function expectedHash(
  name: string,
  type: string,
  options: string[] | null,
  description: string,
): string {
  const optionsPart = options
    ? "[" +
      options
        .toSorted()
        .map((s) => `'${s}'`)
        .join(", ") +
      "]"
    : "";
  const content = `${name}|${type}|${optionsPart}|${description}`;
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

describe("computeFieldHash", () => {
  it("matches Node crypto SHA-256 for a plain field", () => {
    expect(computeFieldHash("topic", "single", ["a", "b"], "Desc")).toBe(
      expectedHash("topic", "single", ["a", "b"], "Desc"),
    );
  });

  it("matches for null options", () => {
    expect(computeFieldHash("note", "text", null, "Free text")).toBe(
      expectedHash("note", "text", null, "Free text"),
    );
  });

  it("matches for unicode descriptions and option ordering", () => {
    expect(
      computeFieldHash("q", "multi", ["Não", "Sim"], "Houve provimento? ção"),
    ).toBe(expectedHash("q", "multi", ["Não", "Sim"], "Houve provimento? ção"));
    // options são ordenados antes do hash — ordem de entrada não importa
    expect(computeFieldHash("q", "multi", ["Sim", "Não"], "d")).toBe(
      computeFieldHash("q", "multi", ["Não", "Sim"], "d"),
    );
  });

  it("excludes target/condition/help_text from the hash", () => {
    const h1 = computeFieldHash("q", "single", ["a"], "d");
    // mesmo name/type/options/description -> mesmo hash
    expect(computeFieldHash("q", "single", ["a"], "d")).toBe(h1);
  });
});

describe("classifyChange", () => {
  it("returns null when nothing changed", () => {
    const f = [baseField({ name: "q1", options: ["A"] })];
    expect(classifyChange(f, f)).toBeNull();
  });

  it("returns minor on add/remove field", () => {
    const oldF = [baseField({ name: "q1", options: ["A"] })];
    const newF = [
      baseField({ name: "q1", options: ["A"] }),
      baseField({ name: "q2", type: "text" }),
    ];
    expect(classifyChange(oldF, newF)).toBe("minor");
  });

  it("returns minor on target change", () => {
    const oldF = [baseField({ name: "q1", options: ["A"] })];
    const newF = [baseField({ name: "q1", options: ["A"], target: "llm_only" })];
    expect(classifyChange(oldF, newF)).toBe("minor");
  });

  it("returns patch on description change", () => {
    const oldF = [baseField({ name: "q1", options: ["A"], description: "a" })];
    const newF = [baseField({ name: "q1", options: ["A"], description: "b" })];
    expect(classifyChange(oldF, newF)).toBe("patch");
  });

  it("returns patch on justification_prompt change", () => {
    const oldF = [baseField({ name: "q1", options: ["A"] })];
    const newF = [
      baseField({ name: "q1", options: ["A"], justification_prompt: "cite o trecho" }),
    ];
    expect(classifyChange(oldF, newF)).toBe("patch");
  });
});

// O jsonb do Postgres normaliza a ordem das chaves; condition/subfields lidos
// do banco voltam com chaves reordenadas em relação ao objeto autorado no
// cliente. As comparações precisam ser insensíveis a isso.
describe("stableStringify (round-trip jsonb)", () => {
  // Mesma condição com as chaves em ordens opostas, como o jsonb devolveria.
  const condA = { field: "q0", equals: "Sim" } as FieldCondition;
  const condB = JSON.parse('{"equals":"Sim","field":"q0"}') as FieldCondition;

  it("é insensível à ordem das chaves, inclusive aninhadas", () => {
    expect(stableStringify(condA)).toBe(stableStringify(condB));
    expect(
      stableStringify([{ key: "a", label: "A" }, { label: "B", key: "b" }]),
    ).toBe(stableStringify([{ label: "A", key: "a" }, { key: "b", label: "B" }]));
  });

  it("distingue valores realmente diferentes e omite undefined", () => {
    expect(stableStringify({ field: "q0", equals: "Sim" })).not.toBe(
      stableStringify({ field: "q0", equals: "Não" }),
    );
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it("classifyChange retorna null para condition idêntica com chaves reordenadas", () => {
    const oldF = [baseField({ name: "q1", options: ["A"], condition: condB })];
    const newF = [baseField({ name: "q1", options: ["A"], condition: condA })];
    expect(classifyChange(oldF, newF)).toBeNull();
    expect(diffFields(oldF, newF)).toHaveLength(0);
  });

  it("classifyChange segue minor para mudança real de condition", () => {
    const oldF = [baseField({ name: "q1", options: ["A"], condition: condA })];
    const newF = [
      baseField({
        name: "q1",
        options: ["A"],
        condition: { field: "q0", equals: "Não" },
      }),
    ];
    expect(classifyChange(oldF, newF)).toBe("minor");
    const entries = diffFields(oldF, newF);
    expect(entries).toHaveLength(1);
    expect(entries[0].change_summary).toContain("condição");
  });

  it("fieldDiffIsStructural ignora reordenação de chaves em condition", () => {
    expect(fieldDiffIsStructural({ condition: condA }, { condition: condB })).toBe(
      false,
    );
  });
});

describe("bumpVersion", () => {
  it("bumps each level and resets lower ones", () => {
    expect(bumpVersion({ major: 1, minor: 2, patch: 3 }, "major")).toEqual({
      major: 2,
      minor: 0,
      patch: 0,
    });
    expect(bumpVersion({ major: 1, minor: 2, patch: 3 }, "minor")).toEqual({
      major: 1,
      minor: 3,
      patch: 0,
    });
    expect(bumpVersion({ major: 1, minor: 2, patch: 3 }, "patch")).toEqual({
      major: 1,
      minor: 2,
      patch: 4,
    });
  });
});

describe("snapshotOf", () => {
  it("includes justification_prompt and all properties", () => {
    const snap = snapshotOf(
      baseField({
        name: "q1",
        options: ["A"],
        justification_prompt: "cite o trecho",
        target: "llm_only",
      }),
    );
    expect(snap.justification_prompt).toBe("cite o trecho");
    expect(snap.target).toBe("llm_only");
    expect(snap).toHaveProperty("condition");
    expect(snap).toHaveProperty("subfields");
  });

  // snapshotOf define "campo igual" para o merge (sameFieldContent). Se ele
  // resolvesse os defaults diferente de classifyChange, um campo sem `target` e
  // um com `target: "all"` seriam o mesmo campo para o versionamento e campos
  // diferentes para o merge — conflito fabricado sem edição.
  it("resolve os defaults implícitos em vez de gravar null", () => {
    const snap = snapshotOf(baseField({ name: "q1", options: ["A"] }));
    expect(snap.target).toBe("all");
    expect(snap.required).toBe(true);
    expect(snap.allow_other).toBe(false);
  });

  it("um campo sem default explícito serializa igual a um com", () => {
    const implicito = baseField({ name: "q1", options: ["A"] });
    const explicito = baseField({
      name: "q1",
      options: ["A"],
      target: "all",
      required: true,
      allow_other: false,
    });
    expect(snapshotOf(implicito)).toEqual(snapshotOf(explicito));
  });
});

// classifyChange é derivado de diffFields + fieldDiffIsStructural. Estes casos
// travam a concordância entre os três: uma tabela de propriedades que voltasse a
// existir em classifyChange divergiria aqui.
describe("classifyChange — concordância com diffFields", () => {
  const derive = (o: PydanticField[], n: PydanticField[]) => {
    const entries = diffFields(o, n);
    if (entries.length === 0) return null;
    return entries.some((e) => fieldDiffIsStructural(e.before_value, e.after_value))
      ? "minor"
      : "patch";
  };

  const q = (over: Partial<PydanticField> = {}) =>
    baseField({ name: "q1", options: ["A", "B"], ...over });

  const casos: Array<[string, PydanticField[], PydanticField[]]> = [
    ["nada muda", [q()], [q()]],
    ["descrição", [q()], [q({ description: "outra" })]],
    ["tipo", [q()], [q({ type: "multi" })]],
    ["alvo", [q()], [q({ target: "llm_only" })]],
    ["obrigatoriedade", [q()], [q({ required: false })]],
    ["permite outro", [q()], [q({ allow_other: true })]],
    ["opções reordenadas", [q()], [q({ options: ["B", "A"] })]],
    ["opção adicionada", [q()], [q({ options: ["A", "B", "C"] })]],
    ["instruções", [q()], [q({ help_text: "ajuda" })]],
    ["prompt de justificativa", [q()], [q({ justification_prompt: "cite" })]],
    ["campo adicionado", [q()], [q(), baseField({ name: "q2", type: "text" })]],
    ["campo removido", [q(), baseField({ name: "q2", type: "text" })], [q()]],
    [
      "reordenação pura",
      [q(), baseField({ name: "q2", type: "text" })],
      [baseField({ name: "q2", type: "text" }), q()],
    ],
    ["default implícito virou explícito", [q()], [q({ target: "all", required: true })]],
  ];

  for (const [nome, oldFields, newFields] of casos) {
    it(`concorda com a derivação: ${nome}`, () => {
      expect(classifyChange(oldFields, newFields)).toBe(derive(oldFields, newFields));
    });
  }

  it("tornar o default explícito não é mudança alguma", () => {
    expect(classifyChange([q()], [q({ target: "all", required: true, allow_other: false })])).toBeNull();
  });

  // A invariante que o save depende: a RPC recusa `p_log_entries` vazio, então
  // toda mudança classificada precisa render pelo menos uma entrada.
  it("classifyChange != null ⇒ diffFields != []", () => {
    for (const [nome, oldFields, newFields] of casos) {
      if (classifyChange(oldFields, newFields) !== null) {
        expect(diffFields(oldFields, newFields), nome).not.toHaveLength(0);
      }
    }
  });
});

describe("fieldDiffIsStructural — multiconjunto de opções", () => {
  // Mesmo Set, contagens diferentes: some uma opção duplicada. Muda o que o
  // respondente pode escolher, então é estrutural — e precisa bater com o que
  // classifyChange decide, senão o backfill reclassifica o histórico divergindo
  // do save que o gravou.
  it("perder uma opção duplicada é estrutural", () => {
    expect(
      fieldDiffIsStructural(
        { options: ["A", "A", "B"] },
        { options: ["A", "B"] },
      ),
    ).toBe(true);
  });

  it("reordenar dentro do mesmo multiconjunto segue textual", () => {
    expect(
      fieldDiffIsStructural({ options: ["A", "B"] }, { options: ["B", "A"] }),
    ).toBe(false);
  });
});

describe("diffFields", () => {
  it("emits added / removed entries", () => {
    const oldF = [baseField({ name: "q1", options: ["A"] })];
    const newF = [baseField({ name: "q2", type: "text" })];
    const entries = diffFields(oldF, newF);
    const summaries = entries.map((e) => `${e.field_name}:${e.change_summary}`);
    expect(summaries).toContain("q2:campo adicionado");
    expect(summaries).toContain("q1:campo removido");
  });

  it("emits a justification_prompt diff entry", () => {
    const oldF = [baseField({ name: "q1", options: ["A"] })];
    const newF = [
      baseField({ name: "q1", options: ["A"], justification_prompt: "novo" }),
    ];
    const entries = diffFields(oldF, newF);
    expect(entries).toHaveLength(1);
    expect(entries[0].change_summary).toContain("prompt de justificativa");
    expect(entries[0].after_value.justification_prompt).toBe("novo");
  });
});

describe("sentinelas de entrada de escopo do projeto", () => {
  // A segurança do sentinel vem de os parênteses serem rejeitados como
  // identificador Python: nenhum campo real pode se chamar "(ordem)", então o
  // replay do backfill nunca confunde a entrada com um campo.
  it.each([PROJECT_LOG_FIELD_NAME, ORDER_LOG_FIELD_NAME])(
    "%s não é um nome de campo válido",
    (sentinel) => {
      expect(pydanticFieldNameIssue(sentinel)).toBe("invalid");
      expect(isProjectScopedLogEntry(sentinel)).toBe(true);
    },
  );

  it("um nome de campo real não é tratado como escopo de projeto", () => {
    expect(isProjectScopedLogEntry("ordem")).toBe(false);
  });
});

describe("diffFields — reordenação", () => {
  const a = baseField({ name: "a", options: ["A"] });
  const b = baseField({ name: "b", options: ["A"] });
  const c = baseField({ name: "c", options: ["A"] });

  it("emite entrada (ordem) quando só a ordem muda", () => {
    const entries = diffFields([a, b, c], [c, a, b]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      field_name: ORDER_LOG_FIELD_NAME,
      change_summary: "ordem dos campos alterada",
      before_value: { order: ["a", "b", "c"] },
      after_value: { order: ["c", "a", "b"] },
    });
  });

  it("não relata reordenação ao inserir um campo no meio", () => {
    const entries = diffFields([a, c], [a, b, c]);
    expect(entries.map((e) => e.field_name)).toEqual(["b"]);
  });

  it("não relata reordenação ao remover um campo do meio", () => {
    const entries = diffFields([a, b, c], [a, c]);
    expect(entries.map((e) => e.field_name)).toEqual(["b"]);
  });

  it("relata reordenação e adição quando as duas coisas acontecem", () => {
    const entries = diffFields([a, c], [b, c, a]);
    expect(entries.map((e) => e.field_name).sort()).toEqual([
      ORDER_LOG_FIELD_NAME,
      "b",
    ]);
  });
});

// A RPC `commit_project_schema` recusa uma mudança de versão sem histórico
// (`p_log_entries must be a non-empty JSON array`). Antes da entrada (ordem),
// reordenar campos produzia changeType="patch" com logEntries=[] e o save
// quebrava com o erro cru do Postgres.
describe("planSchemaPersistence — invariante de auditoria", () => {
  const v = { major: 0, minor: 1, patch: 0 };
  const q1 = baseField({ name: "q1", options: ["A", "B"] });
  const q2 = baseField({ name: "q2", options: ["A"] });

  const cases: Array<[string, PydanticField[], PydanticField[]]> = [
    ["reordenação pura", [q1, q2], [q2, q1]],
    ["campo adicionado", [q1], [q1, q2]],
    ["campo removido", [q1, q2], [q1]],
    ["descrição alterada", [q1], [{ ...q1, description: "outra" }]],
    ["tipo alterado", [q1], [{ ...q1, type: "text", options: null }]],
    ["opções reordenadas", [q1], [{ ...q1, options: ["B", "A"] }]],
    ["alvo alterado", [q1], [{ ...q1, target: "llm_only" }]],
    ["rename", [q1], [{ ...q1, name: "q9" }]],
    ["reordenação + edição", [q1, q2], [{ ...q2, description: "x" }, q1]],
  ];

  it.each(cases)("%s: mudança classificada tem log", (_label, oldF, newF) => {
    const plan = planSchemaPersistence(oldF, newF, v);
    expect(plan.changeType).not.toBeNull();
    expect(plan.logEntries.length).toBeGreaterThan(0);
  });

  it("sem mudança: nem classificação nem log", () => {
    const plan = planSchemaPersistence([q1, q2], [q1, q2], v);
    expect(plan.changeType).toBeNull();
    expect(plan.logEntries).toEqual([]);
  });
});

describe("fieldDiffIsStructural", () => {
  it("treats target change as structural", () => {
    expect(
      fieldDiffIsStructural({ target: "all" }, { target: "llm_only" }),
    ).toBe(true);
  });

  it("treats justification_prompt change as textual (patch)", () => {
    expect(
      fieldDiffIsStructural(
        { justification_prompt: "a" },
        { justification_prompt: "b" },
      ),
    ).toBe(false);
  });
});

describe("generatePydanticCode round-trip surface", () => {
  it("emits justification_prompt in json_schema_extra", () => {
    const code = generatePydanticCode([
      baseField({
        name: "q1",
        options: ["A", "B"],
        justification_prompt: "Cite o trecho do parecer.",
      }),
    ]);
    expect(code).toContain(
      '"justification_prompt": "Cite o trecho do parecer."',
    );
  });

  it("emits required in json_schema_extra when the field is optional", () => {
    const code = generatePydanticCode([
      baseField({ name: "q1", options: ["A", "B"], required: false }),
    ]);
    expect(code).toContain('"required": False');
  });

  // `pydantic_hash` é sha256 do texto do código. Emitir a chave no caso default
  // mudaria o texto de todo projeto no próximo save, e respostas LLM legadas
  // (sem answer_field_hashes e sem semver) sairiam da fila de Comparação porque
  // o hash é o único vínculo delas com o schema. O texto tem que ficar
  // byte-idêntico para quem não usa campo opcional.
  it("never emits required for the implicit default", () => {
    const implicito = generatePydanticCode([
      baseField({ name: "q1", options: ["A", "B"] }),
    ]);
    const explicito = generatePydanticCode([
      baseField({ name: "q1", options: ["A", "B"], required: true }),
    ]);
    expect(implicito).not.toContain('"required"');
    expect(explicito).not.toContain('"required"');
    expect(explicito).toBe(implicito);
  });
});
