import { PYDANTIC_FIELD_PROPERTY_KEYS } from "@/lib/pydantic-field";
import { snapshotOf, stableStringify } from "@/lib/schema-utils";
import type { PydanticField } from "@/lib/types";

export type SchemaMergeChoice = "local" | "remote";
export type SchemaMergeResolutions = Readonly<Record<string, SchemaMergeChoice>>;

interface ConflictBase {
  id: string;
  resolution: SchemaMergeChoice | null;
}

// `name` é a identidade do campo no merge, não uma propriedade a mesclar, e
// `hash` é metadado derivado que só o servidor escreve e que o save recalcula.
// Nenhum dos dois é conteúdo editável pelo usuário, então nenhum dos dois pode
// virar conflito para ele resolver — o tipo abaixo é o que garante isso.
const NON_MERGEABLE_PROPERTIES = new Set<string>(["name", "hash"]);

export type MergeableFieldProperty = Exclude<
  keyof PydanticField,
  "name" | "hash"
>;

export interface SchemaPropertyConflict extends ConflictBase {
  kind: "property";
  fieldName: string;
  property: MergeableFieldProperty;
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
}

export function unresolvedSchemaConflicts(
  merge: SchemaMergeResult,
): SchemaMergeConflict[] {
  return merge.conflicts.filter((conflict) => conflict.resolution === null);
}

function equal(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

// Igualdade de CONTEÚDO entre campos, que é o que decide conflito. Comparar o
// objeto inteiro incluiria `hash`, um metadado derivado que só o servidor
// escreve — e aí um campo legado sem hash viraria "editado remotamente" assim
// que o primeiro save injetasse o hash, fabricando um conflito que o usuário
// não causou. `snapshotOf` é a mesma serialização canônica usada pela detecção
// de dirty e pelo log de auditoria: fonte única, sem uma segunda noção de
// "campo igual" divergindo desta.
function sameFieldContent(left: PydanticField, right: PydanticField): boolean {
  return equal(snapshotOf(left), snapshotOf(right));
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
  property: MergeableFieldProperty,
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
  if (!remoteField || sameFieldContent(localField, remoteField)) {
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
    if (NON_MERGEABLE_PROPERTIES.has(rawProperty)) continue;
    const property = rawProperty as MergeableFieldProperty;
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
  if (sameFieldContent(remoteField, baseField)) return { field: null, conflicts: [] };
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
  if (sameFieldContent(localField, baseField)) return { field: null, conflicts: [] };
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

type OrderRelation = -1 | 1 | null;

interface OrderGraph {
  edges: Map<string, Set<string>>;
  indegree: Map<string, number>;
}

function orderRelation(
  order: string[],
  left: string,
  right: string,
): OrderRelation {
  const leftIndex = order.indexOf(left);
  const rightIndex = order.indexOf(right);
  if (leftIndex < 0 || rightIndex < 0) return null;
  return leftIndex < rightIndex ? -1 : 1;
}

function selectOrderRelation(
  base: OrderRelation,
  local: OrderRelation,
  remote: OrderRelation,
): OrderRelation | "conflict" {
  if (local === remote) return local;
  if (local === null) return remote;
  if (remote === null) return local;
  if (base !== null && local === base) return remote;
  if (base !== null && remote === base) return local;
  return "conflict";
}

function buildOrderGraph(
  baseOrder: string[],
  localOrder: string[],
  remoteOrder: string[],
  names: Set<string>,
): OrderGraph | null {
  const edges = new Map(
    [...names].map((name) => [name, new Set<string>()]),
  );
  const indegree = new Map([...names].map((name) => [name, 0]));
  const orderedNames = [...names];

  const addEdge = (before: string, after: string) => {
    const targets = edges.get(before)!;
    if (targets.has(after)) return;
    targets.add(after);
    indegree.set(after, indegree.get(after)! + 1);
  };

  for (let leftIndex = 0; leftIndex < orderedNames.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < orderedNames.length; rightIndex += 1) {
      const left = orderedNames[leftIndex];
      const right = orderedNames[rightIndex];
      const selected = selectOrderRelation(
        orderRelation(baseOrder, left, right),
        orderRelation(localOrder, left, right),
        orderRelation(remoteOrder, left, right),
      );
      if (selected === "conflict") return null;
      if (selected === -1) addEdge(left, right);
      if (selected === 1) addEdge(right, left);
    }
  }
  return { edges, indegree };
}

function orderRank(
  name: string,
  baseOrder: string[],
  localOrder: string[],
  remoteOrder: string[],
): [number, number, number] {
  return [remoteOrder, localOrder, baseOrder].map((order) => {
    const index = order.indexOf(name);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  }) as [number, number, number];
}

function topologicalOrder(
  graph: OrderGraph,
  names: Set<string>,
  baseOrder: string[],
  localOrder: string[],
  remoteOrder: string[],
): string[] | null {
  const compareRank = (left: string, right: string) => {
    const leftRank = orderRank(left, baseOrder, localOrder, remoteOrder);
    const rightRank = orderRank(right, baseOrder, localOrder, remoteOrder);
    for (let index = 0; index < leftRank.length; index += 1) {
      const difference = leftRank[index] - rightRank[index];
      if (difference !== 0) return difference;
    }
    return left.localeCompare(right);
  };
  const ready = [...names]
    .filter((name) => graph.indegree.get(name) === 0)
    .sort(compareRank);
  const merged: string[] = [];
  while (ready.length > 0) {
    const name = ready.shift()!;
    merged.push(name);
    for (const after of graph.edges.get(name)!) {
      const remaining = graph.indegree.get(after)! - 1;
      graph.indegree.set(after, remaining);
      if (remaining === 0) {
        ready.push(after);
        ready.sort(compareRank);
      }
    }
  }
  return merged.length === names.size ? merged : null;
}

function mergeOrderByPrecedence({
  baseOrder,
  localOrder,
  remoteOrder,
  names,
}: {
  baseOrder: string[];
  localOrder: string[];
  remoteOrder: string[];
  names: Set<string>;
}): string[] | null {
  const graph = buildOrderGraph(baseOrder, localOrder, remoteOrder, names);
  return graph
    ? topologicalOrder(graph, names, baseOrder, localOrder, remoteOrder)
    : null;
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
  const mergedOrder = mergeOrderByPrecedence({
    baseOrder: base.map((field) => field.name),
    localOrder: local.map((field) => field.name),
    remoteOrder: remote.map((field) => field.name),
    names: mergedNames,
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
  };
}
