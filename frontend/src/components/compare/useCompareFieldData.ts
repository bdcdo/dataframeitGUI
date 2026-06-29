"use client";

import { useMemo } from "react";
import { normalizeForComparison } from "@/lib/utils";
import { isFreeTextField } from "@/lib/compare-divergence";
import { buildResponseGroupKeys } from "@/lib/equivalence";
import type { PydanticField } from "@/lib/types";
import type {
  CompareDocument,
  CompareResponse,
  EquivalencePairWire,
  FieldResponse,
} from "./compare-types";

interface UseCompareFieldDataParams {
  currentDoc: CompareDocument | undefined;
  currentFieldName: string;
  currentField: PydanticField | undefined;
  responses: Record<string, CompareResponse[]>;
  fields: PydanticField[];
  projectPydanticHash: string | null;
  equivalencesByDocField: Record<
    string,
    Record<string, EquivalencePairWire[]>
  >;
}

export interface CompareFieldData {
  fieldResponses: FieldResponse[];
  answerGroups: FieldResponse[][];
  currentFieldEquivalences: EquivalencePairWire[];
  allowEquivalence: boolean;
}

/**
 * Derivações das respostas do campo atual (staleness por hash, versão de
 * schema, agrupamento por equivalência). Extraído de `ComparePage` para
 * reduzir o tamanho do container (`no-giant-component`).
 */
export function useCompareFieldData({
  currentDoc,
  currentFieldName,
  currentField,
  responses,
  fields,
  projectPydanticHash,
  equivalencesByDocField,
}: UseCompareFieldDataParams): CompareFieldData {
  const docResponses = currentDoc ? responses[currentDoc.id] || [] : [];

  const currentFieldHashes = useMemo(() => {
    const map: Record<string, string> = {};
    for (const f of fields) {
      if (f.hash) map[f.name] = f.hash;
    }
    return map;
  }, [fields]);

  const fieldResponses: FieldResponse[] = docResponses.map((r) => {
    let isFieldStale = false;
    if (r.answer_field_hashes) {
      const savedHash = r.answer_field_hashes[currentFieldName];
      const currentHash = currentFieldHashes[currentFieldName];
      isFieldStale = !savedHash || !currentHash || savedHash !== currentHash;
    } else {
      isFieldStale =
        !!projectPydanticHash && r.pydantic_hash !== projectPydanticHash;
    }
    const version =
      r.schema_version_major !== null
        ? `${r.schema_version_major}.${r.schema_version_minor ?? 0}.${r.schema_version_patch ?? 0}`
        : null;
    return {
      id: r.id,
      respondent_type: r.respondent_type,
      respondent_name: r.respondent_name,
      respondent_id: r.respondent_id,
      answer: Object.prototype.hasOwnProperty.call(r.answers, currentFieldName)
        ? r.answers[currentFieldName]
        : undefined,
      justification: r.justifications?.[currentFieldName],
      is_latest: r.is_latest,
      isFieldStale,
      schemaVersion: version,
    };
  });

  const currentFieldEquivalences = useMemo<EquivalencePairWire[]>(() => {
    if (!currentDoc || !currentFieldName) return [];
    return equivalencesByDocField[currentDoc.id]?.[currentFieldName] ?? [];
  }, [equivalencesByDocField, currentDoc, currentFieldName]);

  const allowEquivalence = useMemo(() => {
    return !!currentField && isFreeTextField(currentField);
  }, [currentField]);

  const answerGroups = useMemo(() => {
    const present = fieldResponses.filter((r) => r.answer !== undefined);
    const groupKeys = buildResponseGroupKeys(
      present,
      currentFieldEquivalences,
      (r) => normalizeForComparison(r.answer),
    );
    const map = new Map<string, FieldResponse[]>();
    for (const r of present) {
      const key = groupKeys.get(r.id) ?? r.id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return Array.from(map.values()).toSorted((a, b) => b.length - a.length);
  }, [fieldResponses, currentFieldEquivalences]);

  return {
    fieldResponses,
    answerGroups,
    currentFieldEquivalences,
    allowEquivalence,
  };
}
