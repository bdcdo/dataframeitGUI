"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import type { CompareQueueScope } from "./CompareQueueTabs";

interface UseCompareNavGuardParams {
  // Os dois estados em que navegar perderia trabalho: rascunho não confirmado
  // e salvamento em andamento (a ref síncrona de `useCompareVerdictFlow`).
  hasPendingVerdict: boolean;
  isSaveInFlight: () => boolean;
  // Navegação crua, que os wrappers abaixo embrulham no gate.
  handleDocNavigate: (index: number) => void;
  setFieldIndex: (index: number) => void;
  handleNextDoc: () => void;
  goNextField: () => void;
  goPrevField: () => void;
  changeFilter: (value: string) => void;
  changeQueue: (value: CompareQueueScope) => void;
}

/**
 * Ponto único de gate da navegação MANUAL (sidebar, nav de doc, nav de campo,
 * filtro de campo, aba de fila, teclado). Extraído de `ComparePage` na
 * decomposição do container (#564). Com rascunho não confirmado, navegar
 * descartaria a seleção em silêncio via guard de contexto — a perda de sessão
 * da issue #430. O avanço automático pós-confirmação usa `goNextField` cru
 * dentro de `handleVerdict` e não passa por aqui.
 *
 * Trocar o filtro de campo ou a aba de fila também muda o contexto (doc/campo
 * atual) e cairia no guard de render que descarta o rascunho — os dois vetores
 * que a primeira versão do #430 deixou de fora. Os filtros de fila
 * (`CompareFilters`) são o mesmo caso, mas fazem o próprio push de URL, então
 * recebem `guardNavigation` cru por prop via `CompareNav`.
 */
export function useCompareNavGuard({
  hasPendingVerdict,
  isSaveInFlight,
  handleDocNavigate,
  setFieldIndex,
  handleNextDoc,
  goNextField,
  goPrevField,
  changeFilter,
  changeQueue,
}: UseCompareNavGuardParams) {
  const guardNavigation = useCallback(() => {
    // In-flight: bloqueio silencioso (o botão já exibe "Salvando...").
    if (isSaveInFlight()) return false;
    if (hasPendingVerdict) {
      // `id` fixo: tentativas repetidas (tecla `n` segurada, onValueChange
      // duplo do Radix Tabs) atualizam o mesmo toast em vez de empilhar.
      toast.warning(
        "Seleção não confirmada — confirme ou descarte antes de avançar.",
        { id: "compare-nav-guard" },
      );
      return false;
    }
    return true;
  }, [hasPendingVerdict, isSaveInFlight]);

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
  const changeQueueGuarded = useCallback(
    (value: CompareQueueScope) => {
      if (guardNavigation()) changeQueue(value);
    },
    [changeQueue, guardNavigation],
  );

  return {
    guardNavigation,
    navigateDoc,
    navigateField,
    nextDoc,
    nextField,
    prevField,
    changeFieldFilter,
    changeQueue: changeQueueGuarded,
  };
}
