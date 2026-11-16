"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { useResetOnKeyChange } from "@/hooks/useResetOnKeyChange";
import {
  COMPARE_ORIGIN_MISMATCH_MESSAGE,
  verdictOriginMatches,
  type PendingVerdict,
  type VerdictOrigin,
} from "./compare-types";

type HandleVerdict = (
  origin: VerdictOrigin,
  verdict: string,
  chosenResponseId?: string,
) => Promise<boolean>;

interface UseCompareVerdictFlowParams {
  // Identidade do par (doc, campo, readOnly); `null` sem doc/campo. Trocar de
  // contexto descarta o rascunho, que pertence ao par anterior.
  ctxKey: string | null;
  // Origem do campo EXIBIDO; `null` sem doc/campo.
  currentOrigin: VerdictOrigin | null;
  // Escrita de `useCompareVerdicts`: sempre settla, inclusive no timeout de
  // `actionSucceeded` (issue #430), e resolve `true` só quando gravou.
  handleVerdict: HandleVerdict;
}

/**
 * Ciclo do veredito na Comparação: rascunho (`pendingVerdict`), confirmação,
 * descarte e o salvamento single-flight. Extraído de `ComparePage` na
 * decomposição do container (#564).
 *
 * A ref `inFlightRef` é a fonte síncrona da exclusão mútua, porque state só
 * atualiza no próximo render; `isSavingVerdict` existe apenas para o feedback
 * visual. `isSaveInFlight` expõe a ref para o gate de navegação
 * (`useCompareNavGuard`).
 */
export function useCompareVerdictFlow({
  ctxKey,
  currentOrigin,
  handleVerdict,
}: UseCompareVerdictFlowParams) {
  const [pendingVerdict, setPendingVerdict] = useState<PendingVerdict | null>(
    null,
  );
  const [isSavingVerdict, setIsSavingVerdict] = useState(false);
  const inFlightRef = useRef(false);

  // Guard de render: o rascunho é do par (doc, campo) em que foi tomado, e some
  // ao trocar de par — sem effect, para não pintar um frame com o rascunho do
  // campo anterior. A navegação manual com rascunho é barrada antes de chegar
  // aqui (`useCompareNavGuard`); o que sobra é o avanço automático
  // pós-confirmação e a troca de identidade da impersonação.
  useResetOnKeyChange(ctxKey ?? "", () => setPendingVerdict(null));

  const isSaveInFlight = useCallback(() => inFlightRef.current, []);

  const preparePendingVerdict = useCallback(
    (next: PendingVerdict) => {
      // Trava de in-flight: aceitar um rascunho novo (mouse ou teclado) durante
      // um salvamento em andamento seria descartado silenciosamente pelo
      // `setPendingVerdict(null)` que a confirmação roda ao concluir. Ignorar
      // aqui — ponto único — mantém o rascunho que está sendo salvo. O bloqueio
      // de somente-leitura vive nos controles (`disabled`), no teclado
      // (`useCompareKeyboard`) e no backstop de escrita (`useCompareVerdicts`)
      // — aqui não se repete.
      if (inFlightRef.current) {
        // Antes este `return` era mudo, e um save lento (até os 15s do watchdog
        // de #430) deixava a revisora clicando sem nenhum efeito visível.
        toast.info(
          "Salvando o veredito anterior — aguarde para escolher outra resposta.",
          { id: "compare-save-inflight" },
        );
        return;
      }
      // Recusa PRIMÁRIA de rascunho vindo de outro campo: acontece no clique, que
      // é onde a revisora consegue relacionar o aviso ao que acabou de fazer. A
      // mensagem diz o que fazer (recarregar), porque com conteúdo desmontado na
      // tela nenhum clique naquela região vai funcionar (#613).
      if (!currentOrigin || !verdictOriginMatches(next.origin, currentOrigin)) {
        console.error("compare: rascunho de outro campo recusado", {
          origin: next.origin,
          atual: currentOrigin,
        });
        toast.error(COMPARE_ORIGIN_MISMATCH_MESSAGE, {
          id: "compare-origin-mismatch",
        });
        return;
      }
      setPendingVerdict(next);
    },
    [currentOrigin],
  );

  // Único entrypoint para todo submit via handleVerdict: confirmação de
  // rascunho, campo multi e atalhos especiais. A ref torna um segundo save
  // impossível mesmo antes do rerender que desabilita os controles.
  const submitVerdictSingleFlight = useCallback(
    async (
      origin: VerdictOrigin,
      verdict: string,
      chosenResponseId?: string,
    ) => {
      if (inFlightRef.current) return false;
      inFlightRef.current = true;
      setIsSavingVerdict(true);
      try {
        return await handleVerdict(origin, verdict, chosenResponseId);
      } finally {
        inFlightRef.current = false;
        setIsSavingVerdict(false);
      }
    },
    [handleVerdict],
  );

  // `handleVerdict` sempre settla, então o `finally` acima é garantido e a
  // trava nunca fica presa. No timeout o rascunho é MANTIDO: a usuária
  // reconfirma sem re-selecionar.
  const confirmPendingVerdict = useCallback(async () => {
    if (!pendingVerdict) return;
    // A origem viaja com o rascunho: a confirmação grava no campo em que a
    // decisão foi TOMADA, não no que estiver em tela agora. `useCompareVerdicts`
    // recusa se os dois divergirem.
    const saved = await submitVerdictSingleFlight(
      pendingVerdict.origin,
      pendingVerdict.verdict,
      pendingVerdict.kind === "response"
        ? pendingVerdict.chosenResponseId
        : undefined,
    );
    if (saved) setPendingVerdict(null);
  }, [pendingVerdict, submitVerdictSingleFlight]);

  const discardPendingVerdict = useCallback(() => {
    // Durante o in-flight o rascunho é o que está sendo salvo — descartá-lo
    // deixaria a UI sem referente do save em andamento.
    if (!inFlightRef.current) setPendingVerdict(null);
  }, []);

  // Escrita sem rascunho, na origem do campo EXIBIDO: o campo multi e os
  // atalhos `a`/`s` de multi, que por construção só existem no render
  // corrente. Os caminhos com rascunho usam a origem carimbada no próprio
  // rascunho (`confirmPendingVerdict`).
  const submitCurrentVerdict = useCallback(
    (verdict: string, chosenResponseId?: string) => {
      if (!currentOrigin) return;
      void submitVerdictSingleFlight(currentOrigin, verdict, chosenResponseId);
    },
    [currentOrigin, submitVerdictSingleFlight],
  );

  // Adaptador `async () => Promise` → `() => void` para a assinatura síncrona
  // de `useCompareKeyboard`. Precisa de identidade estável: o hook recebe a
  // callback no array de deps do seu único effect, e um arrow inline religaria
  // o listener de `keydown` a cada render do container.
  const handleConfirmPending = useCallback(
    () => void confirmPendingVerdict(),
    [confirmPendingVerdict],
  );

  return {
    pendingVerdict,
    isSavingVerdict,
    isSaveInFlight,
    preparePendingVerdict,
    submitCurrentVerdict,
    handleConfirmPending,
    discardPendingVerdict,
  };
}
