import {
  mergeSchemas,
  unresolvedSchemaConflicts,
  type SchemaMergeConflict,
} from "@/lib/schema-merge";
import { stripLikePython } from "@/lib/pydantic-field";
import { stripOptionFromConditions } from "@/lib/schema-utils";
import { propertyLabel } from "@/lib/schema-change-format";
import type {
  FieldCondition,
  PydanticField,
  SchemaBaselineIdentity,
  SchemaSnapshot,
  SubfieldDef,
} from "@/lib/types";

export interface EditFieldFormValues {
  description: string;
  helpText: string;
  options: string[];
  allowOther: boolean;
  subfields?: SubfieldDef[];
  subfieldRule: PydanticField["subfield_rule"];
  condition?: FieldCondition;
  justificationPrompt: string;
}

// Subcampos e opções são mutuamente exclusivos no form: com subcampos
// presentes, as opções gravadas são as deles (via SubfieldsEditor), não uma
// lista própria do campo.
function optionShapeFromForm(
  form: EditFieldFormValues,
): Pick<PydanticField, "options" | "subfields" | "subfield_rule"> {
  const hasSubfields = (form.subfields?.length ?? 0) > 0;
  if (hasSubfields) {
    return {
      options: null,
      subfields: form.subfields,
      subfield_rule: form.subfieldRule,
    };
  }
  return {
    options: form.options.length > 0 ? form.options : null,
    subfields: undefined,
    subfield_rule: undefined,
  };
}

function editedFieldFromForm(
  baseField: PydanticField,
  form: EditFieldFormValues,
): PydanticField {
  const allowsOther =
    (baseField.type === "single" || baseField.type === "multi") &&
    form.allowOther;
  return {
    ...baseField,
    description: form.description,
    help_text: stripLikePython(form.helpText) || undefined,
    ...optionShapeFromForm(form),
    allow_other: allowsOther ? true : undefined,
    condition: form.condition,
    justification_prompt: stripLikePython(form.justificationPrompt) || undefined,
  };
}

// O diff local é form × BASE capturado na abertura do diálogo — o que o
// usuário de fato mudou. Aplicá-lo direto sobre o `allFields` vivo
// reescreveria as propriedades geridas pelo form com valores congelados,
// revertendo em silêncio a edição concorrente que um refresh trouxe (#501).
export function applyFormEdits(
  baseFields: PydanticField[],
  fieldName: string,
  form: EditFieldFormValues,
): PydanticField[] {
  const baseField = baseFields.find((f) => f.name === fieldName);
  if (!baseField) return baseFields;
  const edited = editedFieldFromForm(baseField, form);
  let fields = baseFields.map((f) => (f.name === fieldName ? edited : f));
  const kept = new Set(form.options);
  const removedOpts = (baseField.options ?? []).filter((o) => !kept.has(o));
  for (const removed of removedOpts) {
    fields = stripOptionFromConditions(fields, fieldName, removed);
  }
  return fields;
}

// O strip de `applyFormEdits` só alcança as condições do base. Este passo roda
// sobre o resultado do merge e alcança as que outra sessão criou com o diálogo
// aberto, que só o remoto traz (#599). Entra só a opção que a edição local tirou
// (base × local, casados por id) e que o campo do merge também não tem: uma
// removida no remoto já teve as suas condições tratadas lá. Campo do merge sem
// lista de opções fica de fora, porque a validação do save não cobra valor dele.
// Devolve também os nomes dos campos cuja condição mudou: como as condições
// locais já saíram limpas, toda mudança aqui é sobre condição de outra sessão,
// que o usuário pode não ter visto na guarda de remoção — e precisa saber.
function stripLocallyRemovedOptions(
  baseFields: PydanticField[],
  localFields: PydanticField[],
  mergedFields: PydanticField[],
): { fields: PydanticField[]; strippedFieldNames: string[] } {
  const baseById = new Map(baseFields.map((f) => [f.id, f]));
  const mergedById = new Map(mergedFields.map((f) => [f.id, f]));
  let fields = mergedFields;
  for (const local of localFields) {
    const baseOptions = baseById.get(local.id)?.options;
    const trigger = mergedById.get(local.id);
    if (!baseOptions || !trigger?.options) continue;
    const kept = new Set([...(local.options ?? []), ...trigger.options]);
    for (const removed of baseOptions) {
      if (!kept.has(removed)) {
        fields = stripOptionFromConditions(fields, trigger.name, removed);
      }
    }
  }
  const strippedFieldNames = fields
    .filter((f) => f !== mergedById.get(f.id))
    .map((f) => f.name);
  return { fields, strippedFieldNames };
}

export function strippedConditionsNotice(fieldNames: string[]): string {
  const names = fieldNames.map((name) => `"${name}"`).join(", ");
  return fieldNames.length === 1
    ? `A condição de ${names}, criada em outra sessão, dependia da opção removida e foi limpa.`
    : `As condições de ${names}, criadas em outra sessão, dependiam da opção removida e foram limpas.`;
}

// Um conflito aqui é colisão real: a mesma propriedade editada no diálogo e em
// outra sessão. A UX mínima é bloquear sem perder a digitação — reconstruir o
// diálogo de resoluções do SchemaEditor neste fluxo seria um segundo mecanismo
// de conflito completo para um caso raro.
function conflictBlockMessage(conflicts: SchemaMergeConflict[]): string {
  const disputed = conflicts.map((conflict) => {
    if (conflict.kind === "property") {
      return `${propertyLabel(conflict.property)} de "${conflict.fieldName}"`;
    }
    if (conflict.kind === "field") return `o campo "${conflict.fieldName}"`;
    if (conflict.kind === "name") return `o nome "${conflict.name}"`;
    return "a ordem dos campos";
  });
  return `Outra sessão editou ao mesmo tempo: ${[...new Set(disputed)].join(", ")}. Recarregue a página para rever a versão atual antes de salvar.`;
}

export type SubmitOutcome =
  | { status: "saved" }
  | { status: "conflict"; current: SchemaSnapshot }
  | { status: "error"; message: string };

// Toda parada tem uma mensagem e sai pelo mesmo canal. `blocked` e `error` são
// distintos porque só o primeiro preserva a digitação por design (a colisão é
// resolúvel recarregando), mas nenhum dos dois é exceção: fazer a falha de save
// sair por `throw` obrigava o `try/catch` do chamador a servir a erro de domínio
// e a queda de rede ao mesmo tempo.
// `strippedFieldNames`: campos de outra sessão cuja condição dependia de uma
// opção removida no diálogo e foi limpa no save (#599).
export type SaveMergedEditResult =
  | { status: "saved"; strippedFieldNames: string[] }
  | { status: "blocked"; message: string }
  | { status: "error"; message: string };

const STALE_RETRY_FAILED_MESSAGE =
  "O schema mudou em outra sessão. Recarregue a página e reaplique esta edição sobre a versão atual.";

// Merge de três vias (base capturado × edição do form × remoto vivo) antes de
// submeter: edições concorrentes em outras propriedades entram no payload;
// colisão na mesma propriedade bloqueia com a digitação intacta. Um conflito
// de CAS re-mescla sobre o snapshot devolvido e reenvia UMA vez, em vez de
// descartar a edição com "recarregue a página".
export async function saveMergedEdit(
  baseFields: PydanticField[],
  localFields: PydanticField[],
  allFields: PydanticField[],
  baseline: SchemaBaselineIdentity,
  submit: (
    fields: PydanticField[],
    baseline: SchemaBaselineIdentity,
  ) => Promise<SubmitOutcome>,
): Promise<SaveMergedEditResult> {
  const merged = mergeSchemas(baseFields, localFields, allFields);
  const blocked = unresolvedSchemaConflicts(merged);
  if (blocked.length > 0) {
    return { status: "blocked", message: conflictBlockMessage(blocked) };
  }

  // Remover a opção torna inválida toda condição sobre ela, venha de onde vier;
  // deixar a remota passar só trocava a limpeza por uma recusa do save que
  // culpa o campo, e não a concorrência (#599).
  let payload = stripLocallyRemovedOptions(baseFields, localFields, merged.fields);
  let result = await submit(payload.fields, baseline);
  if (result.status === "conflict") {
    const remerged = mergeSchemas(baseFields, localFields, result.current.fields);
    const reblocked = unresolvedSchemaConflicts(remerged);
    if (reblocked.length > 0) {
      return { status: "blocked", message: conflictBlockMessage(reblocked) };
    }
    payload = stripLocallyRemovedOptions(baseFields, localFields, remerged.fields);
    result = await submit(payload.fields, {
      revision: result.current.revision,
    });
  }
  if (result.status === "conflict") {
    return { status: "error", message: STALE_RETRY_FAILED_MESSAGE };
  }
  if (result.status === "error") {
    return { status: "error", message: result.message };
  }
  return { status: "saved", strippedFieldNames: payload.strippedFieldNames };
}
