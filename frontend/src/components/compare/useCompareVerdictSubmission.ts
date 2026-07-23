"use client";

import { useCallback, useRef, useState } from "react";
import { useResetOnKeyChange } from "@/hooks/useResetOnKeyChange";
import type { PendingVerdict } from "./compare-types";

interface UseCompareVerdictSubmissionParams {
  // Identidade do par (doc, campo, readOnly). Ao mudar, o rascunho pendente é
  // descartado por guard de render.
  ctxKey: string | null;
  // Submissão de veredito de `useCompareVerdicts`; resolve "salvou?".
  handleVerdict: (
    verdict: string,
    chosenResponseId?: string,
  ) => Promise<boolean>;
}

export interface CompareVerdictSubmission {
  pendingVerdict: PendingVerdict | null;
  isSavingVerdict: boolean;
  // Leitura SÍNCRONA da trava de save em andamento — a fonte de verdade da
  // exclusão mútua (o state `isSavingVerdict` só atualiza no próximo render, e
  // serve apenas para feedback visual). Identidade estável; o guard de
  // navegação a consulta no momento do evento.
  isSaveInFlight: () => boolean;
  preparePendingVerdict: (next: PendingVerdict) => void;
  submitVerdictSingleFlight: (
    verdict: string,
    chosenResponseId?: string,
  ) => Promise<boolean>;
  confirmPendingVerdict: () => Promise<void>;
  discardPendingVerdict: () => void;
}

/**
 * Ciclo de vida do rascunho de veredito da Comparação com trava single-flight.
 * Extraído de `ComparePage` na decomposição do container (`no-giant-component`,
 * #564). Dono de `pendingVerdict`, do feedback `isSavingVerdict`, da ref
 * síncrona de exclusão mútua e do guard de render que descarta o rascunho ao
 * trocar o par (doc, campo) — a perda de sessão da issue #430.
 *
 * A ref (`verdictSaveInFlightRef`) é a fonte síncrona porque state só atualiza
 * no próximo render; um segundo save (mouse ou teclado) fica impossível mesmo
 * antes do rerender que desabilita os controles.
 */
export function useCompareVerdictSubmission({
  ctxKey,
  handleVerdict,
}: UseCompareVerdictSubmissionParams): CompareVerdictSubmission {
  const [pendingVerdict, setPendingVerdict] = useState<PendingVerdict | null>(
    null,
  );
  const [isSavingVerdict, setIsSavingVerdict] = useState(false);
  // Trava síncrona de exclusão mútua. É um `useRef` legítimo — só lido/escrito
  // em callbacks (nunca no corpo do render), então não recai em
  // `react-hooks/refs`. `null` de `ctxKey` vira "null" (nenhuma chave real
  // colide, pois toda chave tem `|`).
  const verdictSaveInFlightRef = useRef(false);
  useResetOnKeyChange(String(ctxKey), () => setPendingVerdict(null));

  const isSaveInFlight = useCallback(() => verdictSaveInFlightRef.current, []);

  const preparePendingVerdict = useCallback((next: PendingVerdict) => {
    // Trava de in-flight: aceitar um rascunho novo durante um salvamento em
    // andamento seria descartado silenciosamente pelo `setPendingVerdict(null)`
    // que `confirmPendingVerdict` roda ao concluir. Ignorar aqui — ponto único
    // — mantém o rascunho que está sendo salvo. O bloqueio de somente-leitura
    // vive nos controles (`disabled`), no teclado e no backstop de escrita
    // (`useCompareVerdicts`) — aqui não se repete.
    if (verdictSaveInFlightRef.current) return;
    setPendingVerdict(next);
  }, []);

  // Único entrypoint para todo submit via handleVerdict: confirmação de
  // rascunho, campo multi e atalhos especiais.
  const submitVerdictSingleFlight = useCallback(
    async (verdict: string, chosenResponseId?: string) => {
      if (verdictSaveInFlightRef.current) return false;
      verdictSaveInFlightRef.current = true;
      setIsSavingVerdict(true);
      try {
        return await handleVerdict(verdict, chosenResponseId);
      } finally {
        // `handleVerdict` sempre settla (o timeout de `actionSucceeded` resolve
        // como erro a promise pendurada — #430), então o `finally` é garantido
        // e a trava nunca fica presa.
        verdictSaveInFlightRef.current = false;
        setIsSavingVerdict(false);
      }
    },
    [handleVerdict],
  );

  const confirmPendingVerdict = useCallback(async () => {
    if (!pendingVerdict) return;
    const saved = await submitVerdictSingleFlight(
      pendingVerdict.verdict,
      pendingVerdict.kind === "response"
        ? pendingVerdict.chosenResponseId
        : undefined,
    );
    // No timeout o rascunho é MANTIDO: a usuária reconfirma sem re-selecionar.
    if (saved) setPendingVerdict(null);
  }, [pendingVerdict, submitVerdictSingleFlight]);

  const discardPendingVerdict = useCallback(() => {
    // Durante o in-flight o rascunho é o que está sendo salvo — descartá-lo
    // deixaria a UI sem referente do save em andamento.
    if (!verdictSaveInFlightRef.current) setPendingVerdict(null);
  }, []);

  return {
    pendingVerdict,
    isSavingVerdict,
    isSaveInFlight,
    preparePendingVerdict,
    submitVerdictSingleFlight,
    confirmPendingVerdict,
    discardPendingVerdict,
  };
}
