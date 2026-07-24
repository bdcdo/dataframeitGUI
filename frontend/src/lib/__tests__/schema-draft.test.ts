import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  SCHEMA_DRAFT_FORMAT_VERSION,
  convertSchemaDraftV4,
  parseSchemaDraft,
  readSchemaDraft,
  type SchemaDraftEnvelopeV4,
} from "@/lib/schema-draft";
import { PYDANTIC_FIELD_PROPERTY_KEYS } from "@/lib/pydantic-field";
import { snapshotOf } from "@/lib/schema-utils";
import type { FieldCondition, PydanticField } from "@/lib/types";

const trigger: PydanticField = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "gatilho",
  type: "single",
  options: ["Sim", "Não"],
  description: "Gatilho",
};

const complete: PydanticField = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "completo",
  type: "text",
  options: ["Não consta"],
  description: "Campo completo",
  help_text: "Ajuda",
  target: "human_only",
  required: false,
  hash: "hash-derivado",
  subfields: [{ key: "parte", label: "Parte", required: true }],
  subfield_rule: "at_least_one",
  allow_other: true,
  condition: { field: "gatilho", equals: "Sim" },
  justification_prompt: "Cite o trecho",
};

// Deriva a forma v4 (sem `id`) das fixtures acima em vez de redeclará-la: o
// envelope antigo é exatamente o campo atual menos a identidade.
function stripId(field: PydanticField): Omit<PydanticField, "id"> {
  const rest: Partial<PydanticField> = { ...field };
  delete rest.id;
  return rest as Omit<PydanticField, "id">;
}

const REMOTE_TRIGGER_ID = "00000000-0000-4000-8000-0000000000a1";
const REMOTE_COMPLETE_ID = "00000000-0000-4000-8000-0000000000a2";

function rawDraft(fields: PydanticField[] = [trigger, complete]) {
  return JSON.stringify({
    formatVersion: SCHEMA_DRAFT_FORMAT_VERSION,
    writeToken: "write-1",
    base: { fields: [trigger], version: "0.1.0", revision: 4 },
    fields,
  });
}

describe("readSchemaDraft", () => {
  it("reconhece o envelope legível", () => {
    expect(readSchemaDraft(rawDraft()).kind).toBe("draft");
  });

  it("distingue envelope de formato anterior de slot vazio", () => {
    // A distinção é o que permite avisar em vez de apagar calado: os dois casos
    // liberam o slot, mas só um deles perdeu trabalho do usuário.
    const base = JSON.parse(rawDraft()) as Record<string, unknown>;
    expect(
      readSchemaDraft(JSON.stringify({ ...base, formatVersion: 3 })),
    ).toEqual({ kind: "stale-format", formatVersion: 3 });

    expect(readSchemaDraft(null)).toEqual({ kind: "empty" });
    expect(readSchemaDraft("{")).toEqual({ kind: "empty" });
    // Sem marcador de formato não é envelope nosso: nada foi perdido.
    expect(readSchemaDraft(JSON.stringify({ foo: 1 }))).toEqual({ kind: "empty" });
  });

  // O v4 (campos sem `id`) é o único formato anterior legível: diferente dos
  // bumps que viram `stale-format`, ele volta como `convertible` para
  // `convertSchemaDraftV4` reconstruir a identidade no mount.
  it("devolve envelope v4 legível como convertible", () => {
    const v4 = {
      formatVersion: 4,
      writeToken: "write-1",
      base: { fields: [stripId(trigger)], version: "0.1.0", revision: 4 },
      fields: [stripId(trigger), stripId(complete)],
    };
    const read = readSchemaDraft(JSON.stringify(v4));
    expect(read.kind).toBe("convertible");
    if (read.kind === "convertible") {
      expect(read.draft).toEqual(v4);
    }
  });

  // Um envelope marcado como v4 cujos campos JÁ têm id não é um v4 de verdade:
  // não casa com nenhum dos dois contratos e cai no marcador — slot assumível,
  // mas com aviso.
  it("trata v4 malformado (campos com id) como stale-format", () => {
    const base = JSON.parse(rawDraft()) as Record<string, unknown>;
    expect(readSchemaDraft(JSON.stringify({ ...base, formatVersion: 4 }))).toEqual({
      kind: "stale-format",
      formatVersion: 4,
    });
  });

  it("trata envelope do formato corrente porém corrompido como ilegível, não como vazio", () => {
    const base = JSON.parse(rawDraft()) as Record<string, unknown>;
    expect(readSchemaDraft(JSON.stringify({ ...base, writeToken: "" }))).toEqual({
      kind: "stale-format",
      formatVersion: SCHEMA_DRAFT_FORMAT_VERSION,
    });
  });

  it("cede o slot a um envelope de formato mais novo", () => {
    const base = JSON.parse(rawDraft()) as Record<string, unknown>;
    expect(
      readSchemaDraft(
        JSON.stringify({ ...base, formatVersion: SCHEMA_DRAFT_FORMAT_VERSION + 1 }),
      ),
    ).toEqual({
      kind: "newer-format",
      formatVersion: SCHEMA_DRAFT_FORMAT_VERSION + 1,
    });
  });
});

describe("parseSchemaDraft", () => {
  // Esta equivalência é o que sustenta `mergeFieldProperties` comparar indexando
  // `snapshotOf(field)[property]`: ele itera as chaves do Zod menos `name`/`hash`,
  // e precisa que todas existam no snapshot. Uma propriedade nova só no Zod faria
  // o merge comparar `undefined` contra `undefined` nos três lados e nunca
  // enxergar a divergência — conflito silenciosamente perdido, em vez de
  // fabricado. Por isso a asserção vale pelos dois lados e não é redundante com o
  // round-trip abaixo.
  it("mantém o schema Zod alinhado ao snapshot canônico mais hash e id derivados", () => {
    // `id` fica fora do snapshot como o `hash`: é identidade, não conteúdo.
    expect(PYDANTIC_FIELD_PROPERTY_KEYS).toEqual(
      [...Object.keys(snapshotOf(complete)), "hash", "id"].sort(),
    );
  });

  it("aceita envelope v5 com baseline completo e todas as propriedades", () => {
    expect(parseSchemaDraft(rawDraft())).toEqual({
      formatVersion: SCHEMA_DRAFT_FORMAT_VERSION,
      writeToken: "write-1",
      base: { fields: [trigger], version: "0.1.0", revision: 4 },
      fields: [trigger, complete],
    });
  });

  it.each<FieldCondition>([
    { field: "gatilho", equals: "Sim" },
    { field: "gatilho", not_equals: "Não" },
    { field: "gatilho", in: ["Sim", "Não"] },
    { field: "gatilho", not_in: ["Não"] },
    { field: "gatilho", exists: true },
  ])("aceita a condição %#", (condition) => {
    const field = { ...complete, condition };
    expect(parseSchemaDraft(rawDraft([trigger, field]))?.fields[1].condition).toEqual(
      condition,
    );
  });

  it.each([
    ["envelope", { extra: true }],
    ["campo", { fields: [{ ...trigger, extra: true }, complete] }],
    [
      "subcampo",
      {
        fields: [
          trigger,
          {
            ...complete,
            subfields: [{ ...complete.subfields![0], extra: true }],
          },
        ],
      },
    ],
    [
      "condição",
      {
        fields: [
          trigger,
          {
            ...complete,
            condition: { field: "gatilho", equals: "Sim", extra: true },
          },
        ],
      },
    ],
    ["baseline", { base: { fields: [trigger], version: "0.1.0", revision: 4, extra: true } }],
  ])("rejeita chave desconhecida no %s", (_label, override) => {
    const base = JSON.parse(rawDraft()) as Record<string, unknown>;
    expect(parseSchemaDraft(JSON.stringify({ ...base, ...override }))).toBeNull();
  });

  it("preserva estado intermediário estruturalmente válido", () => {
    const intermediate = [{ ...trigger, description: "" }];
    expect(parseSchemaDraft(rawDraft(intermediate))?.fields).toEqual(intermediate);
  });

  // A fronteira dos campos do rascunho é a EDITÁVEL: id duplicado é invariante
  // dura, mas nome duplicado é estado transitório legítimo (barrado só no save
  // e na base persistida).
  it("rejeita id duplicado no rascunho, mas aceita nome duplicado", () => {
    expect(
      parseSchemaDraft(
        rawDraft([trigger, { ...trigger, description: "Duplicado" }]),
      ),
    ).toBeNull();

    const homonimo = {
      ...trigger,
      id: "00000000-0000-4000-8000-000000000003",
      description: "Mesmo nome, outro id",
    };
    expect(parseSchemaDraft(rawDraft([trigger, homonimo]))?.fields).toEqual([
      trigger,
      homonimo,
    ]);
  });

  it("rejeita nome duplicado na base persistida", () => {
    const base = JSON.parse(rawDraft()) as Record<string, unknown>;
    const homonimo = {
      ...trigger,
      id: "00000000-0000-4000-8000-000000000003",
    };
    expect(
      parseSchemaDraft(
        JSON.stringify({
          ...base,
          base: { fields: [trigger, homonimo], version: "0.1.0", revision: 4 },
        }),
      ),
    ).toBeNull();
  });

  it("rejeita JSON corrompido, formato antigo, token vazio e revisão inválida", () => {
    expect(parseSchemaDraft("{")).toBeNull();
    const base = JSON.parse(rawDraft()) as Record<string, unknown>;
    expect(
      parseSchemaDraft(JSON.stringify({ ...base, formatVersion: 2 })),
    ).toBeNull();
    expect(parseSchemaDraft(JSON.stringify({ ...base, writeToken: "" }))).toBeNull();
    expect(
      parseSchemaDraft(
        JSON.stringify({
          ...base,
          base: { fields: [trigger], version: "0.1.0", revision: -1 },
        }),
      ),
    ).toBeNull();
  });
});

// A conversão v4→v5 é o que impede que o deploy da #473 descarte o rascunho de
// quem estava editando: o envelope antigo não tem `id`, e a identidade é
// reconstruída casando por NOME contra o snapshot remoto (que já vem do banco
// com os ids do backfill).
describe("convertSchemaDraftV4", () => {
  const remoteTrigger: PydanticField = { ...trigger, id: REMOTE_TRIGGER_ID };
  const remoteComplete: PydanticField = { ...complete, id: REMOTE_COMPLETE_ID };

  function draftV4(overrides?: {
    baseFields?: Array<Omit<PydanticField, "id">>;
    fields?: Array<Omit<PydanticField, "id">>;
  }): SchemaDraftEnvelopeV4 {
    return {
      formatVersion: 4,
      writeToken: "write-v4",
      base: {
        fields: overrides?.baseFields ?? [stripId(trigger)],
        version: "0.1.0",
        revision: 4,
      },
      fields: overrides?.fields ?? [stripId(trigger), stripId(complete)],
    } as SchemaDraftEnvelopeV4;
  }

  it("reusa o id remoto para o campo de mesmo nome na baseline", () => {
    const converted = convertSchemaDraftV4(draftV4(), [
      remoteTrigger,
      remoteComplete,
    ]);

    expect(converted.base.fields[0].id).toBe(REMOTE_TRIGGER_ID);
    // O campo do rascunho herda o id da baseline convertida, não um id novo:
    // é o mesmo campo, e o merge precisa reconhecê-lo como tal.
    expect(converted.fields[0].id).toBe(REMOTE_TRIGGER_ID);
  });

  it("gera id novo para campo que só existe localmente", () => {
    const converted = convertSchemaDraftV4(draftV4(), [remoteTrigger]);

    const added = converted.fields[1];
    expect(added.name).toBe("completo");
    expect(added.id).not.toBe(REMOTE_TRIGGER_ID);
    // Para o merge isso é uma adição local legítima — que é exatamente o que um
    // campo criado durante a janela do deploy significa.
    expect(converted.base.fields.map(({ id }) => id)).not.toContain(added.id);
  });

  it("gera id novo para campo da baseline que sumiu do remoto", () => {
    const converted = convertSchemaDraftV4(draftV4(), []);

    // Canônico, não "36 caracteres do alfabeto certo": o id nascido aqui vai
    // parar na CHECK do banco, que exige a forma exata.
    expect(
      z.uuid().safeParse(converted.base.fields[0].id).success,
    ).toBe(true);
    expect(converted.fields[0].id).toBe(converted.base.fields[0].id);
  });

  // Nome que entrou dos DOIS lados durante a janela do deploy é o mesmo campo:
  // o rascunho v4 foi escrito quando nome era identidade, e fabricar dois
  // campos homônimos travaria o save numa duplicata que ninguém criou.
  it("casa campo local com o remoto de mesmo nome fora da baseline", () => {
    const converted = convertSchemaDraftV4(draftV4(), [
      remoteTrigger,
      remoteComplete,
    ]);

    expect(converted.fields[1].id).toBe(REMOTE_COMPLETE_ID);
    expect(new Set(converted.fields.map(({ id }) => id)).size).toBe(2);
  });

  it("preserva o writeToken e produz envelope legível como v5", () => {
    const converted = convertSchemaDraftV4(draftV4(), [
      remoteTrigger,
      remoteComplete,
    ]);

    expect(converted.writeToken).toBe("write-v4");
    expect(converted.formatVersion).toBe(SCHEMA_DRAFT_FORMAT_VERSION);
    // O slot continua sendo da mesma aba, e o envelope convertido tem que
    // passar pelo contrato atual — senão a conversão só adiaria o descarte.
    expect(readSchemaDraft(JSON.stringify(converted)).kind).toBe("draft");
  });

  it("mantém todas as demais propriedades do campo intactas", () => {
    const converted = convertSchemaDraftV4(draftV4(), [
      remoteTrigger,
      remoteComplete,
    ]);

    expect(converted.fields[1]).toEqual({ ...complete, id: REMOTE_COMPLETE_ID });
  });
});
