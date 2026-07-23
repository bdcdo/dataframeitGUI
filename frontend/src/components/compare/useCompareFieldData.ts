"use client";

import { useMemo } from "react";
import { normalizeForComparison } from "@/lib/utils";
import {
  buildResponseGroupKeys,
  filterCurrentEquivalencePairs,
} from "@/lib/equivalence";
import { buildFieldHashMap, isFieldStale } from "@/lib/answer-staleness";
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

  const currentFieldHashes = useMemo(() => buildFieldHashMap(fields), [fields]);

  const fieldResponses: FieldResponse[] = docResponses.map((r) => {
    const stale = isFieldStale({
      answerFieldHashes: r.answer_field_hashes,
      pydanticHash: r.pydantic_hash,
      fieldName: currentFieldName,
      currentFieldHashes,
      projectPydanticHash,
    });
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
      isFieldStale: stale,
      schemaVersion: version,
    };
  });

  const fieldEquivalences = useMemo<EquivalencePairWire[]>(() => {
    if (!currentDoc || !currentFieldName) return [];
    return equivalencesByDocField[currentDoc.id]?.[currentFieldName] ?? [];
  }, [equivalencesByDocField, currentDoc, currentFieldName]);

  const currentFieldEquivalences = useMemo<EquivalencePairWire[]>(() => {
    const present = fieldResponses.filter(
      (response) => response.answer !== undefined,
    );
    return filterCurrentEquivalencePairs(
      present,
      fieldEquivalences,
      (response) => response.answer,
    );
  }, [fieldResponses, fieldEquivalences]);

  // Equivalência (fundir respostas distintas como iguais) vale para qualquer
  // campo NÃO-multi: texto, data e single (com ou sem opções). Todos renderizam
  // via AgreementGroup, cujos cards são selecionáveis. multi usa MultiOptionReview
  // (checkboxes), sem cards de equivalência. Antes restringia a free-text, o que
  // deixava de fora single-com-opções (ex.: NI ≡ N/A ≡ "não informado") — #247.
  const allowEquivalence = useMemo(() => {
    return !!currentField && currentField.type !== "multi";
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
