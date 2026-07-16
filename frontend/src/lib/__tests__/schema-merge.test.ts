import { describe, expect, it } from "vitest";
import { mergeSchemas, unresolvedSchemaConflicts } from "@/lib/schema-merge";
import type { PydanticField } from "@/lib/types";

const q1: PydanticField = {
  name: "q1",
  type: "text",
  options: null,
  description: "Pergunta 1",
};
const q2: PydanticField = {
  name: "q2",
  type: "single",
  options: ["Sim", "Não"],
  description: "Pergunta 2",
};
const q3: PydanticField = {
  name: "q3",
  type: "date",
  options: null,
  description: "Pergunta 3",
};
const q4: PydanticField = {
  ...q1,
  name: "q4",
  description: "Pergunta 4",
};

describe("mergeSchemas", () => {
  it("mescla automaticamente propriedades alteradas em lados diferentes", () => {
    const result = mergeSchemas(
      [q1],
      [{ ...q1, description: "Descrição local" }],
      [{ ...q1, help_text: "Ajuda remota" }],
    );

    expect(result.conflicts).toEqual([]);
    expect(result.fields).toEqual([
      { ...q1, description: "Descrição local", help_text: "Ajuda remota" },
    ]);
  });

  it("expõe colisão na mesma propriedade e usa remoto apenas no preview", () => {
    const initial = mergeSchemas(
      [q1],
      [{ ...q1, description: "Local" }],
      [{ ...q1, description: "Remota" }],
    );
    const conflict = initial.conflicts[0];

    expect(conflict).toMatchObject({
      kind: "property",
      fieldName: "q1",
      property: "description",
      resolution: null,
    });
    expect(initial.fields[0].description).toBe("Remota");
    expect(unresolvedSchemaConflicts(initial).map(({ id }) => id)).toEqual([
      conflict.id,
    ]);

    const resolved = mergeSchemas(
      [q1],
      [{ ...q1, description: "Local" }],
      [{ ...q1, description: "Remota" }],
      { [conflict.id]: "local" },
    );
    expect(resolved.fields[0].description).toBe("Local");
    expect(unresolvedSchemaConflicts(resolved)).toEqual([]);
  });

  it("mescla adições independentes e mantém as locais na ordem local", () => {
    const localA = { ...q2, name: "local-a" };
    const localB = { ...q3, name: "local-b" };
    const remoteOnly = { ...q2, name: "remote" };
    const result = mergeSchemas(
      [q1],
      [q1, localB, localA],
      [q1, remoteOnly],
    );

    expect(result.conflicts).toEqual([]);
    expect(result.fields.map(({ name }) => name)).toEqual([
      "q1",
      "remote",
      "local-b",
      "local-a",
    ]);
  });

  it("preserva simultaneamente a posição de adições locais e remotas", () => {
    const a = { ...q1, name: "a" };
    const b = { ...q2, name: "b" };
    const x = { ...q3, name: "x" };
    const y = { ...q3, name: "y" };

    const result = mergeSchemas([a, b], [x, a, b], [a, b, y]);

    expect(result.conflicts).toEqual([]);
    expect(result.fields.map(({ name }) => name)).toEqual(["x", "a", "b", "y"]);
  });

  it("expõe adição concorrente do mesmo nome", () => {
    const result = mergeSchemas(
      [q1],
      [q1, { ...q2, description: "Local" }],
      [q1, { ...q2, description: "Remota" }],
    );

    expect(result.conflicts).toContainEqual(
      expect.objectContaining({ kind: "field", reason: "add-add", fieldName: "q2" }),
    );
    expect(result.fields.find(({ name }) => name === "q2")?.description).toBe("Remota");
  });

  it.each([
    {
      label: "exclusão local contra edição remota",
      local: [] as PydanticField[],
      remote: [{ ...q1, description: "Remota" }],
      reason: "delete-edit",
    },
    {
      label: "edição local contra exclusão remota",
      local: [{ ...q1, description: "Local" }],
      remote: [] as PydanticField[],
      reason: "edit-delete",
    },
  ])("expõe $label", ({ local, remote, reason }) => {
    const result = mergeSchemas([q1], local, remote);
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({ kind: "field", reason, fieldName: "q1" }),
    );
  });

  it("interpreta rename como exclusão e adição, sem identidade implícita", () => {
    const renamed = { ...q1, name: "renamed" };
    const remote = { ...q1, description: "Remota" };
    const result = mergeSchemas([q1], [renamed], [remote]);

    expect(result.fields.map(({ name }) => name)).toContain("renamed");
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({ kind: "field", reason: "delete-edit", fieldName: "q1" }),
    );
  });

  it("aplica reorder unilateral automaticamente", () => {
    const result = mergeSchemas([q1, q2, q3], [q3, q1, q2], [q1, q2, q3]);
    expect(result.conflicts).toEqual([]);
    expect(result.fields.map(({ name }) => name)).toEqual(["q3", "q1", "q2"]);
  });

  it("combina reorders independentes sem criar falso conflito", () => {
    const result = mergeSchemas(
      [q1, q2, q3, q4],
      [q2, q1, q3, q4],
      [q1, q2, q4, q3],
    );

    expect(result.conflicts).toEqual([]);
    expect(result.fields.map(({ name }) => name)).toEqual(["q2", "q1", "q4", "q3"]);
  });

  it("expõe reorder incompatível e permite escolher a ordem local", () => {
    const initial = mergeSchemas([q1, q2, q3], [q2, q1, q3], [q1, q3, q2]);
    expect(initial.conflicts).toContainEqual(
      expect.objectContaining({ id: "order", kind: "order", resolution: null }),
    );
    expect(initial.fields.map(({ name }) => name)).toEqual(["q1", "q3", "q2"]);

    const resolved = mergeSchemas(
      [q1, q2, q3],
      [q2, q1, q3],
      [q1, q3, q2],
      { order: "local" },
    );
    expect(resolved.fields.map(({ name }) => name)).toEqual(["q2", "q1", "q3"]);
  });
});

// `hash` é metadado derivado que só o servidor escreve. Um projeto legado tem
// campos sem hash (é por isso que o backfill existe); o primeiro save remoto
// injeta hash em todos eles. Se o merge comparasse o objeto inteiro, essa
// injeção viraria "edição remota" e fabricaria conflitos que ninguém causou.
describe("mergeSchemas — hash não é conteúdo do campo", () => {
  const semHash: PydanticField = { ...q1, hash: undefined };
  const comHash: PydanticField = { ...q1, hash: "hash-do-servidor" };

  it("remoto ganhar hash não conflita com deleção local", () => {
    const merge = mergeSchemas([semHash], [], [comHash]);
    expect(merge.conflicts).toEqual([]);
    expect(merge.fields).toEqual([]);
  });

  it("local sem hash não conflita com deleção remota", () => {
    const merge = mergeSchemas([comHash], [semHash], []);
    expect(merge.conflicts).toEqual([]);
    expect(merge.fields).toEqual([]);
  });

  it("add-add que difere só no hash não é conflito", () => {
    const merge = mergeSchemas([], [semHash], [comHash]);
    expect(merge.conflicts).toEqual([]);
    expect(merge.fields).toEqual([comHash]);
  });

  it("hash divergente nunca vira conflito de propriedade", () => {
    const merge = mergeSchemas(
      [semHash],
      [{ ...semHash, description: "Editada localmente" }],
      [comHash],
    );
    expect(unresolvedSchemaConflicts(merge)).toEqual([]);
    expect(merge.fields[0].description).toBe("Editada localmente");
  });

  it("uma edição de conteúdo real ainda conflita, mesmo com hash igual", () => {
    const merge = mergeSchemas(
      [comHash],
      [{ ...comHash, description: "Local" }],
      [{ ...comHash, description: "Remota" }],
    );
    expect(unresolvedSchemaConflicts(merge)).toHaveLength(1);
  });
});

// Mesma classe do bloco acima: uma propriedade que o usuário não editou não
// pode virar conflito. Aqui o gatilho é o default implícito — um campo legado
// tem `target` ausente, e `compile_pydantic` sempre reconstrói o campo com
// `target: "all"` explícito. Os dois descrevem o mesmo campo.
describe("mergeSchemas — default implícito não é edição", () => {
  const semTarget: PydanticField = { ...q1, target: undefined };
  const comTargetAll: PydanticField = { ...q1, target: "all" };

  it("remoto ganhar target explícito não conflita com deleção local", () => {
    const merge = mergeSchemas([semTarget], [], [comTargetAll]);
    expect(merge.conflicts).toEqual([]);
    expect(merge.fields).toEqual([]);
  });

  it("add-add que difere só no target implícito não é conflito", () => {
    const merge = mergeSchemas([], [semTarget], [comTargetAll]);
    expect(merge.conflicts).toEqual([]);
  });

  it("target implícito não vira conflito enquanto há edição local real", () => {
    const merge = mergeSchemas(
      [semTarget],
      [{ ...semTarget, description: "Editada localmente" }],
      [comTargetAll],
    );
    expect(unresolvedSchemaConflicts(merge)).toEqual([]);
    expect(merge.fields[0].description).toBe("Editada localmente");
  });

  // O caso acima passa mesmo comparando valor cru, porque o local permanece
  // igual ao base e o atalho `local === base` resolve antes de olhar o remoto.
  // Aqui os dois lados divergem do base ao mesmo tempo: o local muda o alvo de
  // verdade, e o remoto só ganha a forma explícita do MESMO default. É o ramo
  // `remoto === base → local vence` que precisa enxergar `undefined` e `"all"`
  // como o mesmo valor; sem resolver, o usuário resolve um conflito inventado
  // entre `llm_only` e `all` num campo cujo alvo só mudou de um lado.
  it("edição local do target não conflita com remoto que só explicitou o default", () => {
    const merge = mergeSchemas(
      [semTarget],
      [{ ...semTarget, target: "llm_only" }],
      [comTargetAll],
    );
    expect(merge.conflicts).toEqual([]);
    expect(merge.fields[0].target).toBe("llm_only");
  });

  it("required e allow_other implícitos também não conflitam", () => {
    const implicito: PydanticField = { ...q2, required: undefined, allow_other: undefined };
    const explicito: PydanticField = { ...q2, required: true, allow_other: false };
    expect(mergeSchemas([], [implicito], [explicito]).conflicts).toEqual([]);
  });

  // A quarta propriedade com default implícito, e a que faltava. Os produtores do
  // `"all"` explícito são dois — `compile_pydantic`, que grava `subfield_rule or
  // "all"` sempre que há subcampos, e o EditFieldDialog, que promove o default ao
  // salvar qualquer edição do campo. Este é o ramo `remoto === base → local vence`:
  // o local muda a regra de verdade enquanto o remoto só explicitou o default.
  const semRegra: PydanticField = {
    ...q1,
    subfields: [{ key: "a", label: "A" }],
    subfield_rule: undefined,
  };
  const comRegraAll: PydanticField = { ...semRegra, subfield_rule: "all" };

  it("edição local da regra não conflita com remoto que só explicitou o default", () => {
    const merge = mergeSchemas(
      [semRegra],
      [{ ...semRegra, subfield_rule: "at_least_one" }],
      [comRegraAll],
    );
    expect(merge.conflicts).toEqual([]);
    expect(merge.fields[0].subfield_rule).toBe("at_least_one");
  });

  it("add-add que difere só na regra implícita não é conflito", () => {
    expect(mergeSchemas([], [semRegra], [comRegraAll]).conflicts).toEqual([]);
  });

  // A regra tem só dois valores, então ela nunca chega a conflitar sozinha: se o
  // local diverge do remoto E do base, o remoto só pode ser igual ao base, e o
  // ramo "remoto não mudou, local vence" resolve. O que o resolvedor conserta não
  // é a escolha do usuário — é a de `equal(remote, base)` enxergar `undefined` e
  // `"all"` como o mesmo valor para chegar nesse ramo. Sem ele, os três divergiam
  // e o merge inventava um conflito que este caso prova não existir.
  it("a regra local sobrevive a uma edição remota de outra propriedade", () => {
    const merge = mergeSchemas(
      [semRegra],
      [{ ...semRegra, subfield_rule: "at_least_one" }],
      [{ ...comRegraAll, description: "Corrigida na aba Comentários" }],
    );
    expect(unresolvedSchemaConflicts(merge)).toEqual([]);
    expect(merge.fields[0].subfield_rule).toBe("at_least_one");
    expect(merge.fields[0].description).toBe("Corrigida na aba Comentários");
  });

  it("mudar o target de verdade continua conflitando", () => {
    const merge = mergeSchemas(
      [semTarget],
      [{ ...semTarget, target: "human_only" }],
      [{ ...semTarget, target: "llm_only" }],
    );
    expect(unresolvedSchemaConflicts(merge)).toHaveLength(1);
  });
});
