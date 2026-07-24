import { describe, expect, it } from "vitest";
import { mergeSchemas, unresolvedSchemaConflicts } from "@/lib/schema-merge";
import type { PydanticField } from "@/lib/types";

const q1: PydanticField = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "q1",
  type: "text",
  options: null,
  description: "Pergunta 1",
};
const q2: PydanticField = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "q2",
  type: "single",
  options: ["Sim", "Não"],
  description: "Pergunta 2",
};
const q3: PydanticField = {
  id: "00000000-0000-4000-8000-000000000003",
  name: "q3",
  type: "date",
  options: null,
  description: "Pergunta 3",
};
const q4: PydanticField = {
  ...q1,
  id: "00000000-0000-4000-8000-000000000004",
  name: "q4",
  description: "Pergunta 4",
};
// Ids reservados para campos NOVOS criados dentro de um teste (adds de um lado
// só). Derivar de q2/q3 via spread reusaria o id — e id repetido em lados
// diferentes é add-add, não adição independente.
const id5 = "00000000-0000-4000-8000-000000000005";
const id6 = "00000000-0000-4000-8000-000000000006";
const id7 = "00000000-0000-4000-8000-000000000007";

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

    // O endereço do conflito é o ID do campo (#473) e o sufixo é a assinatura
    // do conteúdo em disputa (#590) — por isso prefixo, não igualdade: a
    // afirmação aqui é sobre COMO o conflito é endereçado, e ela sobrevive a um
    // rename justamente por não conter o nome.
    expect(conflict.id.startsWith(`property:${q1.id}:description:`)).toBe(true);
    expect(conflict).toMatchObject({
      kind: "property",
      fieldId: q1.id,
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
    const localA = { ...q2, id: id5, name: "local-a" };
    const localB = { ...q3, id: id6, name: "local-b" };
    const remoteOnly = { ...q2, id: id7, name: "remote" };
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
    const x = { ...q3, id: id5, name: "x" };
    const y = { ...q3, id: id6, name: "y" };

    const result = mergeSchemas([a, b], [x, a, b], [a, b, y]);

    expect(result.conflicts).toEqual([]);
    expect(result.fields.map(({ name }) => name)).toEqual(["x", "a", "b", "y"]);
  });

  it("expõe adição concorrente do mesmo id", () => {
    const result = mergeSchemas(
      [q1],
      [q1, { ...q2, description: "Local" }],
      [q1, { ...q2, description: "Remota" }],
    );

    expect(result.conflicts).toContainEqual(
      expect.objectContaining({
        id: expect.stringMatching(
          new RegExp(`^field:${q2.id}:add-add:`),
        ) as unknown as string,
        kind: "field",
        reason: "add-add",
        fieldId: q2.id,
        fieldName: "q2",
      }),
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

  // A identidade é o `id` (#473): renomear é edição de conteúdo como outra
  // qualquer, não mais delete+add — a edição remota da descrição sobrevive ao
  // rename local no MESMO campo, sem conflito.
  it("mescla rename local com edição remota do mesmo campo", () => {
    const renamed = { ...q1, name: "renamed" };
    const remote = { ...q1, description: "Remota" };
    const result = mergeSchemas([q1], [renamed], [remote]);

    expect(result.conflicts).toEqual([]);
    expect(result.fields).toEqual([
      { ...q1, name: "renamed", description: "Remota" },
    ]);
  });

  it("expõe rename concorrente como conflito da propriedade name", () => {
    const result = mergeSchemas(
      [q1],
      [{ ...q1, name: "local_name" }],
      [{ ...q1, name: "remote_name" }],
    );

    const conflict = result.conflicts[0];
    // O id do conflito não muda com o rename: ele é endereçado pelo id do campo.
    expect(conflict.id.startsWith(`property:${q1.id}:name:`)).toBe(true);
    expect(conflict).toMatchObject({
      kind: "property",
      fieldId: q1.id,
      property: "name",
      localValue: "local_name",
      remoteValue: "remote_name",
      resolution: null,
    });
    // Preview usa o remoto até haver resolução.
    expect(result.fields[0].name).toBe("remote_name");
  });

  // Duas abas adicionam "duplicado" na mesma janela. Antes da #473 isto era
  // add-add (o nome era a chave); com a identidade no id, o merge junta os dois
  // sem enxergar colisão — e o estado resultante é IRRECUSÁVEL no save, contra
  // uma duplicata que nenhum dos dois usuários criou. A disputa tem que sair
  // explícita aqui.
  it("expõe disputa de nome entre campos adicionados nos dois lados", () => {
    const localAdd = { ...q2, id: id5, name: "duplicado" };
    const remoteAdd = { ...q3, id: id6, name: "duplicado" };
    const result = mergeSchemas([q1], [q1, localAdd], [q1, remoteAdd]);

    expect(result.conflicts).toEqual([
      expect.objectContaining({
        kind: "name",
        name: "duplicado",
        localField: localAdd,
        remoteField: remoteAdd,
        resolution: null,
      }),
    ]);
    // Sem resolução vale a convenção de preview do merge: fica o remoto, e o
    // resultado nunca sai com o nome duplicado.
    expect(result.fields.map(({ name }) => name)).toEqual(["q1", "duplicado"]);
    expect(result.fields.map(({ id }) => id)).toEqual([q1.id, id6]);
  });

  it("resolver a disputa de nome escolhe qual campo fica", () => {
    const localAdd = { ...q2, id: id5, name: "duplicado" };
    const remoteAdd = { ...q3, id: id6, name: "duplicado" };
    const conflict = mergeSchemas([q1], [q1, localAdd], [q1, remoteAdd])
      .conflicts[0];

    const resolved = mergeSchemas([q1], [q1, localAdd], [q1, remoteAdd], {
      [conflict.id]: "local",
    });

    expect(resolved.fields.map(({ id }) => id)).toEqual([q1.id, id5]);
    expect(unresolvedSchemaConflicts(resolved)).toEqual([]);
  });

  // Rename local para um nome que o remoto acabou de criar: mesma disputa, e o
  // campo renomeado é quem afirma o nome do lado local.
  it("expõe disputa entre rename local e adição remota do mesmo nome", () => {
    const result = mergeSchemas(
      [q1, q2],
      [q1, { ...q2, name: "novo" }],
      [q1, q2, { ...q3, id: id5, name: "novo" }],
    );

    expect(result.conflicts).toContainEqual(
      expect.objectContaining({ kind: "name", name: "novo" }),
    );
    expect(new Set(result.fields.map(({ name }) => name)).size).toBe(
      result.fields.length,
    );
  });

  // A duplicata que o próprio usuário está digitando não é disputa entre lados:
  // ela já veio no `local`, e barrá-la aqui abriria diálogo de conflito no meio
  // da digitação. Quem barra é o save.
  it("não fabrica conflito para duplicata que já vem do lado local", () => {
    const localA = { ...q2, id: id5, name: "duplicado" };
    const localB = { ...q3, id: id6, name: "duplicado" };
    const result = mergeSchemas([q1], [q1, localA, localB], [q1]);

    expect(result.conflicts).toEqual([]);
    expect(result.fields.map(({ name }) => name)).toEqual([
      "q1",
      "duplicado",
      "duplicado",
    ]);
  });

  it("fieldMap lança em id duplicado dentro do mesmo schema", () => {
    expect(() =>
      mergeSchemas([], [q1, { ...q1, name: "outro_nome" }], []),
    ).toThrow(/id duplicado/);
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
      expect.objectContaining({ kind: "order", resolution: null }),
    );
    expect(initial.fields.map(({ name }) => name)).toEqual(["q1", "q3", "q2"]);

    const resolved = mergeSchemas(
      [q1, q2, q3],
      [q2, q1, q3],
      [q1, q3, q2],
      { [initial.conflicts[0].id]: "local" },
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

// Uma resolução é a resposta a UMA disputa concreta ("Local" × "Remota"), não ao
// endereço campo+propriedade. Se o remoto avança para um terceiro valor com o
// diálogo de conflito aberto, reaplicar a escolha antiga adota um valor que o
// usuário nunca viu — o id precisa carregar os valores em disputa para que o
// re-merge deixe a resolução antiga órfã e reapresente o conflito (#501).
describe("mergeSchemas — resolução pertence à disputa, não ao endereço", () => {
  const local = [{ ...q1, description: "Local" }];
  const remote = [{ ...q1, description: "Remota" }];

  it("resolução de propriedade não se reaplica quando o valor remoto mudou", () => {
    const id = mergeSchemas([q1], local, remote).conflicts[0].id;
    const remerge = mergeSchemas(
      [q1],
      local,
      [{ ...q1, description: "Remota v2" }],
      { [id]: "remote" },
    );
    expect(unresolvedSchemaConflicts(remerge)).toHaveLength(1);
  });

  it("resolução de propriedade continua valendo enquanto a disputa é a mesma", () => {
    const id = mergeSchemas([q1], local, remote).conflicts[0].id;
    const remerge = mergeSchemas([q1], local, remote, { [id]: "local" });
    expect(unresolvedSchemaConflicts(remerge)).toEqual([]);
    expect(remerge.fields[0].description).toBe("Local");
  });

  it("resolução de add-add não se reaplica quando o campo remoto mudou", () => {
    const localAdd = [q1, { ...q2, description: "Local" }];
    const id = mergeSchemas(
      [q1],
      localAdd,
      [q1, { ...q2, description: "Remota" }],
    ).conflicts[0].id;
    const remerge = mergeSchemas(
      [q1],
      localAdd,
      [q1, { ...q2, description: "Remota v2" }],
      { [id]: "local" },
    );
    expect(unresolvedSchemaConflicts(remerge)).toHaveLength(1);
  });

  it("resolução de ordem não se reaplica quando a ordem remota mudou", () => {
    // Ambas as ordens remotas ciclam contra o local (q1<q3<q2<q1 e
    // q1<q4<q2<q1), mas são disputas diferentes — a resolução da primeira não
    // pode fechar a segunda.
    const base = [q1, q2, q3, q4];
    const local = [q2, q1, q3, q4];
    const id = mergeSchemas(base, local, [q1, q3, q2, q4]).conflicts[0].id;
    const remerge = mergeSchemas(base, local, [q1, q4, q2, q3], {
      [id]: "local",
    });
    expect(unresolvedSchemaConflicts(remerge)).toHaveLength(1);
  });
});
