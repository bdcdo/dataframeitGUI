import { PYDANTIC_FIELD_PROPERTY_KEYS } from "@/lib/pydantic-field";
import { stableStringify } from "@/lib/schema-utils";
import type { PydanticField } from "@/lib/types";

export type SchemaMergeChoice = "local" | "remote";
export type SchemaMergeResolutions = Readonly<Record<string, SchemaMergeChoice>>;

interface ConflictBase {
  id: string;
  resolution: SchemaMergeChoice | null;
}

export interface SchemaPropertyConflict extends ConflictBase {
  kind: "property";
  fieldName: string;
  property: Exclude<keyof PydanticField, "name">;
  baseValue: unknown;
  localValue: unknown;
  remoteValue: unknown;
}

export interface SchemaFieldConflict extends ConflictBase {
  kind: "field";
  fieldName: string;
  reason: "add-add" | "delete-edit" | "edit-delete";
  baseField: PydanticField | null;
  localField: PydanticField | null;
  remoteField: PydanticField | null;
}

export interface SchemaOrderConflict extends ConflictBase {
  kind: "order";
  baseOrder: string[];
  localOrder: string[];
  remoteOrder: string[];
}

export type SchemaMergeConflict =
  | SchemaPropertyConflict
  | SchemaFieldConflict
  | SchemaOrderConflict;

export interface SchemaMergeResult {
  fields: PydanticField[];
  conflicts: SchemaMergeConflict[];
  unresolvedConflictIds: string[];
}

function equal(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function fieldMap(fields: PydanticField[], source: string): Map<string, PydanticField> {
  const result = new Map<string, PydanticField>();
  for (const field of fields) {
    if (result.has(field.name)) {
      throw new Error(`O schema ${source} contém o campo duplicado "${field.name}".`);
    }
    result.set(field.name, field);
  }
  return result;
}

function conflictId(...parts: string[]): string {
  return parts.map(encodeURIComponent).join(":");
}

function resolutionFor(
  id: string,
  resolutions: SchemaMergeResolutions,
): SchemaMergeChoice | null {
  return resolutions[id] ?? null;
}

function assignProperty(
  field: PydanticField,
  property: Exclude<keyof PydanticField, "name">,
  value: unknown,
): void {
  const target = field as unknown as Record<string, unknown>;
  if (value === undefined) delete target[property];
  else target[property] = clone(value);
}

interface FieldMergeOutcome {
  field: PydanticField | null;
  conflicts: SchemaMergeConflict[];
}

function mergeAddedField(
  name: string,
  localField: PydanticField | undefined,
  remoteField: PydanticField | undefined,
  resolutions: SchemaMergeResolutions,
): FieldMergeOutcome {
  if (!localField) return { field: clone(remoteField ?? null), conflicts: [] };
  if (!remoteField || equal(localField, remoteField)) {
    return { field: clone(remoteField ?? localField), conflicts: [] };
  }

  const id = conflictId("field", name, "add-add");
  const resolution = resolutionFor(id, resolutions);
  return {
    field: clone(resolution === "local" ? localField : remoteField),
    conflicts: [{
      id,
      kind: "field",
      fieldName: name,
      reason: "add-add",
      baseField: null,
      localField: clone(localField),
      remoteField: clone(remoteField),
      resolution,
    }],
  };
}

function mergeFieldProperties(
  name: string,
  baseField: PydanticField,
  localField: PydanticField,
  remoteField: PydanticField,
  resolutions: SchemaMergeResolutions,
): FieldMergeOutcome {
  const field = clone(remoteField);
  const conflicts: SchemaMergeConflict[] = [];
  for (const rawProperty of PYDANTIC_FIELD_PROPERTY_KEYS) {
    if (rawProperty === "name") continue;
    const property = rawProperty as Exclude<keyof PydanticField, "name">;
    const baseValue = baseField[property];
    const localValue = localField[property];
    const remoteValue = remoteField[property];
    if (equal(localValue, remoteValue) || equal(localValue, baseValue)) continue;
    if (equal(remoteValue, baseValue)) {
      assignProperty(field, property, localValue);
      continue;
    }

    const id = conflictId("property", name, String(property));
    const resolution = resolutionFor(id, resolutions);
    conflicts.push({
      id,
      kind: "property",
      fieldName: name,
      property,
      baseValue: clone(baseValue),
      localValue: clone(localValue),
      remoteValue: clone(remoteValue),
      resolution,
    });
    if (resolution === "local") assignProperty(field, property, localValue);
  }
  return { field, conflicts };
}

function mergeLocalDeletion(
  name: string,
  baseField: PydanticField,
  remoteField: PydanticField,
  resolutions: SchemaMergeResolutions,
): FieldMergeOutcome {
  if (equal(remoteField, baseField)) return { field: null, conflicts: [] };
  const id = conflictId("field", name, "delete-edit");
  const resolution = resolutionFor(id, resolutions);
  return {
    field: resolution === "local" ? null : clone(remoteField),
    conflicts: [{
      id,
      kind: "field",
      fieldName: name,
      reason: "delete-edit",
      baseField: clone(baseField),
      localField: null,
      remoteField: clone(remoteField),
      resolution,
    }],
  };
}

function mergeRemoteDeletion(
  name: string,
  baseField: PydanticField,
  localField: PydanticField,
  resolutions: SchemaMergeResolutions,
): FieldMergeOutcome {
  if (equal(localField, baseField)) return { field: null, conflicts: [] };
  const id = conflictId("field", name, "edit-delete");
  const resolution = resolutionFor(id, resolutions);
  return {
    field: resolution === "local" ? clone(localField) : null,
    conflicts: [{
      id,
      kind: "field",
      fieldName: name,
      reason: "edit-delete",
      baseField: clone(baseField),
      localField: clone(localField),
      remoteField: null,
      resolution,
    }],
  };
}

function mergeExistingField(
  name: string,
  baseField: PydanticField,
  localField: PydanticField | undefined,
  remoteField: PydanticField | undefined,
  resolutions: SchemaMergeResolutions,
): FieldMergeOutcome {
  if (!localField && !remoteField) return { field: null, conflicts: [] };
  if (!localField) return mergeLocalDeletion(name, baseField, remoteField!, resolutions);
  if (!remoteField) return mergeRemoteDeletion(name, baseField, localField, resolutions);
  return mergeFieldProperties(
    name,
    baseField,
    localField,
    remoteField,
    resolutions,
  );
}

function sameOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function projectOrder(order: string[], names: Set<string>): string[] {
  return order.filter((name) => names.has(name));
}

function completeOrder(primary: string[], secondary: string[], names: Set<string>): string[] {
  const result = projectOrder(primary, names);
  const included = new Set(result);
  for (const name of secondary) {
    if (names.has(name) && !included.has(name)) {
      result.push(name);
      included.add(name);
    }
  }
  return result;
}

function mergeOrderByPrecedence({
  baseOrder,
  localOrder,
  remoteOrder,
  names,
  localReorderedBase,
  remoteReorderedBase,
}: {
  baseOrder: string[];
  localOrder: string[];
  remoteOrder: string[];
  names: Set<string>;
  localReorderedBase: boolean;
  remoteReorderedBase: boolean;
}): string[] | null {
  const baseNames = new Set(baseOrder);
  const edges = new Map<string, Set<string>>(
    [...names].map((name) => [name, new Set<string>()]),
  );
  const indegree = new Map([...names].map((name) => [name, 0]));

  const addConstraints = (order: string[], ignoreBaseOrder: boolean) => {
    const projected = projectOrder(order, names);
    for (let index = 1; index < projected.length; index += 1) {
      const before = projected[index - 1];
      const after = projected[index];
      if (ignoreBaseOrder && baseNames.has(before) && baseNames.has(after)) continue;
      const targets = edges.get(before)!;
      if (targets.has(after)) continue;
      targets.add(after);
      indegree.set(after, indegree.get(after)! + 1);
    }
  };

  // Quando apenas um lado reordena campos existentes, a ordem-base intacta do
  // outro lado não compete com essa edição. Posições de campos novos continuam
  // sendo restrições autoradas e entram no merge.
  addConstraints(localOrder, !localReorderedBase && remoteReorderedBase);
  addConstraints(remoteOrder, !remoteReorderedBase && localReorderedBase);

  const rank = (name: string): [number, number, number] => {
    const remoteIndex = remoteOrder.indexOf(name);
    const localIndex = localOrder.indexOf(name);
    const baseIndex = baseOrder.indexOf(name);
    return [
      remoteIndex < 0 ? Number.MAX_SAFE_INTEGER : remoteIndex,
      localIndex < 0 ? Number.MAX_SAFE_INTEGER : localIndex,
      baseIndex < 0 ? Number.MAX_SAFE_INTEGER : baseIndex,
    ];
  };
  const compareRank = (left: string, right: string) => {
    const leftRank = rank(left);
    const rightRank = rank(right);
    for (let index = 0; index < leftRank.length; index += 1) {
      if (leftRank[index] !== rightRank[index]) return leftRank[index] - rightRank[index];
    }
    return left.localeCompare(right);
  };

  const ready = [...names].filter((name) => indegree.get(name) === 0).sort(compareRank);
  const merged: string[] = [];
  while (ready.length > 0) {
    const name = ready.shift()!;
    merged.push(name);
    for (const after of edges.get(name)!) {
      const remaining = indegree.get(after)! - 1;
      indegree.set(after, remaining);
      if (remaining === 0) {
        ready.push(after);
        ready.sort(compareRank);
      }
    }
  }
  return merged.length === names.size ? merged : null;
}

/**
 * Mescla base, rascunho local e snapshot remoto por nome de campo. Alteracoes
 * independentes entram automaticamente; toda colisao permanece explicita e
 * usa o remoto apenas como preview ate receber uma resolucao.
 */
export function mergeSchemas(
  base: PydanticField[],
  local: PydanticField[],
  remote: PydanticField[],
  resolutions: SchemaMergeResolutions = {},
): SchemaMergeResult {
  const baseByName = fieldMap(base, "base");
  const localByName = fieldMap(local, "local");
  const remoteByName = fieldMap(remote, "remoto");
  const allNames = new Set([
    ...baseByName.keys(),
    ...localByName.keys(),
    ...remoteByName.keys(),
  ]);
  const mergedByName = new Map<string, PydanticField>();
  const conflicts: SchemaMergeConflict[] = [];

  for (const name of allNames) {
    const baseField = baseByName.get(name);
    const localField = localByName.get(name);
    const remoteField = remoteByName.get(name);
    const merged = baseField
      ? mergeExistingField(name, baseField, localField, remoteField, resolutions)
      : mergeAddedField(name, localField, remoteField, resolutions);
    if (merged.field) mergedByName.set(name, merged.field);
    conflicts.push(...merged.conflicts);
  }

  const mergedNames = new Set(mergedByName.keys());
  const localOrder = completeOrder(
    local.map((field) => field.name),
    remote.map((field) => field.name),
    mergedNames,
  );
  const remoteOrder = completeOrder(
    remote.map((field) => field.name),
    local.map((field) => field.name),
    mergedNames,
  );
  const sharedNames = new Set(
    [...localByName.keys()].filter((name) => remoteByName.has(name) && mergedNames.has(name)),
  );
  const baseSharedOrder = projectOrder(base.map((field) => field.name), sharedNames);
  const localSharedOrder = projectOrder(local.map((field) => field.name), sharedNames);
  const remoteSharedOrder = projectOrder(remote.map((field) => field.name), sharedNames);
  const localReorderedBase = !sameOrder(
    projectOrder(localSharedOrder, new Set(baseSharedOrder)),
    baseSharedOrder,
  );
  const remoteReorderedBase = !sameOrder(
    projectOrder(remoteSharedOrder, new Set(baseSharedOrder)),
    baseSharedOrder,
  );
  const mergedOrder = mergeOrderByPrecedence({
    baseOrder: base.map((field) => field.name),
    localOrder: local.map((field) => field.name),
    remoteOrder: remote.map((field) => field.name),
    names: mergedNames,
    localReorderedBase,
    remoteReorderedBase,
  });

  let selectedOrder = mergedOrder ?? remoteOrder;
  if (!mergedOrder) {
    const id = "order";
    const resolution = resolutionFor(id, resolutions);
    conflicts.push({
      id,
      kind: "order",
      baseOrder: base.map((field) => field.name),
      localOrder,
      remoteOrder,
      resolution,
    });
    if (resolution === "local") selectedOrder = localOrder;
  }

  return {
    fields: selectedOrder.map((name) => clone(mergedByName.get(name)!)),
    conflicts,
    unresolvedConflictIds: conflicts
      .filter((conflict) => conflict.resolution === null)
      .map((conflict) => conflict.id),
  };
}
