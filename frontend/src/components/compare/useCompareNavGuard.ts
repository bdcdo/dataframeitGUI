"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import type { CompareQueueScope } from "./CompareQueueTabs";
import type { PendingVerdict } from "./compare-types";

interface UseCompareNavGuardParams {
  // Rascunho pendente e a trava síncrona de save — os dois estados que fazem a
  // navegação manual descartar seleção não confirmada (#430).
  pendingVerdict: PendingVerdict | null;
  isSaveInFlight: () => boolean;
  // Callbacks de navegação/filtro crus, envolvidos pelos wrappers guardados.
  handleDocNavigate: (index: number) => void;
  setFieldIndex: (index: number) => void;
  handleNextDoc: () => void;
  goNextField: () => void;
  goPrevField: () => void;
  changeFilter: (value: string) => void;
  handleQueueChange: (value: CompareQueueScope) => void;
}

export interface CompareNavGuard {
  // Ponto único de gate — exposto cru para `CompareFilters`, que faz o próprio
  // push de URL e precisa consultar o guard por prop.
  guardNavigation: () => boolean;
  navigateDoc: (index: number) => void;
  navigateField: (index: number) => void;
  nextDoc: () => void;
  nextField: () => void;
  prevField: () => void;
  changeFieldFilter: (value: string) => void;
  changeQueue: (value: CompareQueueScope) => void;
}

/**
 * Gate da navegação MANUAL (sidebar, nav de doc, nav de campo, filtro, aba de
 * fila, teclado). Extraído de `ComparePage` na decomposição do container
 * (`no-giant-component`, #564). Com rascunho não confirmado, navegar
 * descartaria a seleção em silêncio via guard de contexto — a perda de sessão
 * da issue #430. O avanço automático pós-confirmação usa `goNextField` cru
 * dentro de `handleVerdict` e NÃO passa por aqui.
 *
 * Trocar o filtro de campo ou a aba de fila também muda o contexto (doc/campo
 * atual) e cairia no guard de render — os dois vetores que a primeira versão do
 * #430 deixou de fora, por isso também passam pelo gate.
 */
export function useCompareNavGuard({
  pendingVerdict,
  isSaveInFlight,
  handleDocNavigate,
  setFieldIndex,
  handleNextDoc,
  goNextField,
  goPrevField,
  changeFilter,
  handleQueueChange,
}: UseCompareNavGuardParams): CompareNavGuard {
  const guardNavigation = useCallback(() => {
    // In-flight: bloqueio silencioso (o botão já exibe "Salvando...").
    if (isSaveInFlight()) return false;
    if (pendingVerdict) {
      // `id` fixo: tentativas repetidas (tecla `n` segurada, onValueChange
      // duplo do Radix Tabs) atualizam o mesmo toast em vez de empilhar.
      toast.warning(
        "Seleção não confirmada — confirme ou descarte antes de avançar.",
        { id: "compare-nav-guard" },
      );
      return false;
    }
    return true;
  }, [pendingVerdict, isSaveInFlight]);

  const navigateDoc = useCallback(
    (index: number) => {
      if (guardNavigation()) handleDocNavigate(index);
    },
    [guardNavigation, handleDocNavigate],
  );
  const navigateField = useCallback(
    (index: number) => {
      if (guardNavigation()) setFieldIndex(index);
    },
    [guardNavigation, setFieldIndex],
  );
  const nextDoc = useCallback(() => {
    if (guardNavigation()) handleNextDoc();
  }, [guardNavigation, handleNextDoc]);
  const nextField = useCallback(() => {
    if (guardNavigation()) goNextField();
  }, [goNextField, guardNavigation]);
  const prevField = useCallback(() => {
    if (guardNavigation()) goPrevField();
  }, [goPrevField, guardNavigation]);
  const changeFieldFilter = useCallback(
    (value: string) => {
      if (guardNavigation()) changeFilter(value);
    },
    [changeFilter, guardNavigation],
  );
  const changeQueue = useCallback(
    (value: CompareQueueScope) => {
      if (guardNavigation()) handleQueueChange(value);
    },
    [guardNavigation, handleQueueChange],
  );

  return {
    guardNavigation,
    navigateDoc,
    navigateField,
    nextDoc,
    nextField,
    prevField,
    changeFieldFilter,
    changeQueue,
  };
}
