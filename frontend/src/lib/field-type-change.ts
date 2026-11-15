import type { PydanticField } from "@/lib/types";

/**
 * O patch que troca o tipo de um campo no editor de schema (FieldCard).
 *
 * Limpa o que só vale para o tipo antigo: `allow_other` é de escolha, e
 * `subfields`/`subfield_rule` são de texto. Uma propriedade que sobrevive à
 * troca não volta no round-trip do schema e, no caso dos subcampos, ainda
 * muda a anotação gerada — um campo de data com subcampos sai como composto
 * (`baseAnnotation` em schema-utils.ts). As `options` mudam de papel com o
 * tipo (escolhas, sentinelas de data, respostas padronizadas de texto) e
 * seguem a regra anterior. Clicar no tipo atual não muda nada.
 */
export function fieldTypeChangePatch(
  field: PydanticField,
  type: PydanticField["type"],
): Partial<PydanticField> {
  if (type === field.type) return {};
  if (type === "text") return { type, options: null, allow_other: undefined };
  const patch: Partial<PydanticField> = {
    type,
    subfields: undefined,
    subfield_rule: undefined,
  };
  if (type === "date") return { ...patch, allow_other: undefined };
  return field.options?.length ? patch : { ...patch, options: ["Opção 1"] };
}
