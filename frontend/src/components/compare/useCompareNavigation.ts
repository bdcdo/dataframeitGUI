"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { isDocComplete, findNextPendingDocIndex } from "@/lib/compare-divergence";
import { pinnedDocIndex } from "@/hooks/usePinnedDoc";
import type { ReviewsByDoc } from "@/lib/compare-reviews";
import type { PydanticField } from "@/lib/types";
import type { CompareDocument } from "./compare-types";

interface UseCompareNavigationParams {
  documents: CompareDocument[];
  divergentFields: Record<string, string[]>;
  fields: PydanticField[];
  localReviews: ReviewsByDoc;
}

export interface CompareNavigation {
  docIndex: number;
  currentDoc: CompareDocument | undefined;
  allDocDivergent: string[];
  docFields: string[];
  fieldIndex: number;
  setFieldIndex: (index: number) => void;
  filter: string;
  changeFilter: (value: string) => void;
  currentFieldName: string;
  currentField: PydanticField | undefined;
  isCurrentFieldDivergent: boolean;
  isCurrentDocComplete: boolean;
  reviewedDocsCount: number;
  hasNextDoc: boolean;
  handleDocNavigate: (newIndex: number) => void;
  handleNextDoc: () => void;
  goNextField: () => void;
  goPrevField: () => void;
}

/**
 * Seleção de documento/campo/filtro da Comparação + derivações e navegação.
 * Extraído de `ComparePage` para tirar 3 `useState` do container (mata
 * `prefer-useReducer`) e ~80 linhas de derivação (ajuda `no-giant-component`).
 */
export function useCompareNavigation({
  documents,
  divergentFields,
  fields,
  localReviews,
}: UseCompareNavigationParams): CompareNavigation {
  // O pin nasce já apontando para o doc exibido: se ficasse `null` até a
  // primeira navegação explícita (bug #73, caso residual), o fallback
  // "posição 0" faria o re-sort do servidor trocar o parecer sob o usuário
  // enquanto ele revisa o primeiro da fila.
  const [pinnedDocId, setPinnedDocId] = useState<string | null>(
    () => documents[0]?.id ?? null,
  );
  const [fieldIndex, setFieldIndex] = useState(0);
  const [filter, setFilter] = useState("all");

  // O parecer atual é derivado de `pinnedDocId` (o doc exibido, atualizado a
  // cada escolha explícita do usuário). `documents` é reordenado pelo Server
  // Component a cada `revalidatePath` (sort por pendências); rastrear por
  // índice numérico faria o parecer mudar sob o usuário a cada veredito.
  // Quando o ID atual some da lista (filtro mudou, etc.) caímos para
  // `documents[0]`.
  const docIndex = useMemo(
    () =>
      pinnedDocIndex(
        documents.map((d) => d.id),
        pinnedDocId,
      ),
    [documents, pinnedDocId],
  );

  // Mantém o pin colado no doc exibido quando ele não resolve mais: pin `null`
  // (lista estava vazia na montagem) ou doc pinado sumiu da lista (excluído,
  // filtro) — nos dois casos `docIndex` caiu para o fallback 0 e o doc exibido
  // deixou de ser o pinado. Sem a re-pinagem, esse fallback ficaria exposto ao
  // próximo re-sort e o parecer saltaria de novo. Ajuste condicional de estado
  // durante o render (padrão dos docs do React, "adjusting state when a prop
  // changes") em vez de effect — `set-state-in-effect` proíbe o setState
  // síncrono em effect.
  if (documents.length > 0 && documents[docIndex]?.id !== pinnedDocId) {
    setPinnedDocId(documents[0].id);
  }

  // Avisa quando o doc pinado some da lista. `lastValidPinnedRef` (atualizado
  // só aqui) guarda o último pin válido do render anterior: se ele deixou de
  // existir em `documents` e o pin corrente já é outro (a re-pinagem acima
  // aconteceu), houve a transição "estava lá → sumiu" — toast uma vez.
  const lastValidPinnedRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = lastValidPinnedRef.current;
    if (
      prev !== null &&
      prev !== pinnedDocId &&
      documents.length > 0 &&
      !documents.some((d) => d.id === prev)
    ) {
      toast.info("Documento removido da fila — voltando ao topo.");
    }
    lastValidPinnedRef.current = pinnedDocId;
  }, [pinnedDocId, documents]);

  const currentDoc = documents[docIndex];
  const allDocDivergent = useMemo(
    () => (currentDoc ? divergentFields[currentDoc.id] || [] : []),
    [currentDoc, divergentFields],
  );
  const divergentSet = useMemo(
    () => new Set(allDocDivergent),
    [allDocDivergent],
  );

  const docFields =
    filter === "all"
      ? allDocDivergent
      : allDocDivergent.filter((fn) => fn === filter);
  // `fieldIndex` pode ficar fora de range se `docFields` encolher sob o usuário
  // (ex.: um revalidate reduziu os campos divergentes do doc fixado) sem que o
  // filtro ou o doc — os únicos pontos que resetam `fieldIndex` — mudem. Clampa
  // na leitura para `currentFieldName` nunca cair em `undefined` havendo campos.
  const clampedFieldIndex =
    docFields.length > 0 ? Math.min(fieldIndex, docFields.length - 1) : 0;
  const currentFieldName = docFields[clampedFieldIndex];
  const currentField = fields.find((f) => f.name === currentFieldName);
  const isCurrentFieldDivergent = divergentSet.has(currentFieldName);

  const reviewedDocsCount = useMemo(
    () =>
      documents.filter((doc) =>
        isDocComplete(divergentFields[doc.id], localReviews[doc.id]),
      ).length,
    [documents, divergentFields, localReviews],
  );

  // Documento "concluído" = todos os campos divergentes têm veredito. Quando
  // verdadeiro, a UI mostra o botão "Próximo parecer" (com foco automático) em
  // vez de avançar por timer cego.
  const isCurrentDocComplete = useMemo(
    () =>
      !!currentDoc &&
      isDocComplete(allDocDivergent, localReviews[currentDoc.id]),
    [currentDoc, allDocDivergent, localReviews],
  );

  // `documents` é reordenado pelo servidor a cada revalidate (docs concluídos
  // afundam para o fim da fila), então o "próximo parecer" precisa ser o
  // próximo doc com pendências — não `docIndex + 1`, que apontaria para fora da
  // fila assim que o doc atual fosse concluído.
  const nextPendingDocIndex = useMemo(
    () =>
      findNextPendingDocIndex(
        documents.map((d) => d.id),
        divergentFields,
        localReviews,
        currentDoc?.id,
      ),
    [documents, divergentFields, localReviews, currentDoc],
  );

  const hasNextDoc = nextPendingDocIndex >= 0;

  const handleNextDoc = useCallback(() => {
    if (nextPendingDocIndex >= 0) {
      setPinnedDocId(documents[nextPendingDocIndex].id);
      setFieldIndex(0);
    }
  }, [nextPendingDocIndex, documents]);

  const handleDocNavigate = useCallback(
    (newIndex: number) => {
      if (documents.length === 0) return;
      const clamped = Math.max(0, Math.min(newIndex, documents.length - 1));
      setPinnedDocId(documents[clamped].id);
      setFieldIndex(0);
    },
    [documents],
  );

  // Parte do índice CLAMPADO (não do `idx` cru do estado): se o estado ficou
  // fora de range por um encolhimento de `docFields`, navegar a partir do índice
  // exibido evita ficar preso num índice morto.
  const docFieldsLength = docFields.length;
  const goNextField = useCallback(() => {
    setFieldIndex(
      clampedFieldIndex < docFieldsLength - 1
        ? clampedFieldIndex + 1
        : clampedFieldIndex,
    );
  }, [clampedFieldIndex, docFieldsLength]);
  const goPrevField = useCallback(() => {
    setFieldIndex(clampedFieldIndex > 0 ? clampedFieldIndex - 1 : clampedFieldIndex);
  }, [clampedFieldIndex]);

  const changeFilter = useCallback((value: string) => {
    setFilter(value);
    setFieldIndex(0);
  }, []);

  return {
    docIndex,
    currentDoc,
    allDocDivergent,
    docFields,
    fieldIndex: clampedFieldIndex,
    setFieldIndex,
    filter,
    changeFilter,
    currentFieldName,
    currentField,
    isCurrentFieldDivergent,
    isCurrentDocComplete,
    reviewedDocsCount,
    hasNextDoc,
    handleDocNavigate,
    handleNextDoc,
    goNextField,
    goPrevField,
  };
}
