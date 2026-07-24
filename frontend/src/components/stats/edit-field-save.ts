import {
  mergeSchemas,
  unresolvedSchemaConflicts,
  type SchemaMergeConflict,
} from "@/lib/schema-merge";
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
    help_text: form.helpText.trim() || undefined,
    ...optionShapeFromForm(form),
    allow_other: allowsOther ? true : undefined,
    condition: form.condition,
    justification_prompt: form.justificationPrompt.trim() || undefined,
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
export type SaveMergedEditResult =
  | { status: "saved" }
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

  let result = await submit(merged.fields, baseline);
  if (result.status === "conflict") {
    const remerged = mergeSchemas(baseFields, localFields, result.current.fields);
    const reblocked = unresolvedSchemaConflicts(remerged);
    if (reblocked.length > 0) {
      return { status: "blocked", message: conflictBlockMessage(reblocked) };
    }
    result = await submit(remerged.fields, {
      revision: result.current.revision,
    });
  }
  if (result.status === "conflict") {
    return { status: "error", message: STALE_RETRY_FAILED_MESSAGE };
  }
  if (result.status === "error") {
    return { status: "error", message: result.message };
  }
  return { status: "saved" };
}
