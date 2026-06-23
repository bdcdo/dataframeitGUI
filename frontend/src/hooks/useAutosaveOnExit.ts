"use client";

import { useEffect, useRef } from "react";

export interface AutosavePayload {
  projectId: string;
  documentId: string;
  answers: Record<string, unknown>;
  notes: string;
}

interface UseAutosaveOnExitParams {
  /** id do documento ativo (assigned ou browse), ou null se nenhum. */
  activeDocId: string | null;
  /** true quando o documento ativo tem alterações não salvas. */
  isDirty: boolean;
  /** Snapshot do payload no momento do unload (chamado lazy). */
  getPayload: () => AutosavePayload | null;
  endpoint?: string;
}

/**
 * Auto-save ao sair da página (#28). LOAD-BEARING: preserva o comportamento
 * exato do mecanismo original de `CodingPage`.
 *
 * - `beforeunload`: exibe o aviso nativo do browser quando há doc ativo sujo.
 * - `visibilitychange` (hidden): salva via `navigator.sendBeacon` →, em falha
 *   (indisponível, fila cheia que lança, ou retorno `false`), fallback para
 *   `fetch(..., { keepalive: true })`. Ambos sobrevivem ao fechamento da aba,
 *   onde uma Server Action (POST comum) poderia ser abortada.
 *
 * Os listeners são registrados uma vez só (`[endpoint]`); `activeDocId`,
 * `isDirty` e `getPayload` são lidos via refs sempre atualizados, evitando
 * re-registrar o listener a cada keystroke.
 */
export function useAutosaveOnExit({
  activeDocId,
  isDirty,
  getPayload,
  endpoint = "/api/autosave",
}: UseAutosaveOnExitParams): void {
  const activeDocIdRef = useRef(activeDocId);
  const isDirtyRef = useRef(isDirty);
  const getPayloadRef = useRef(getPayload);

  // Mantém os refs com os valores mais recentes (atualizados após cada render,
  // antes de qualquer evento de unload disparar).
  useEffect(() => {
    activeDocIdRef.current = activeDocId;
    isDirtyRef.current = isDirty;
    getPayloadRef.current = getPayload;
  });

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (activeDocIdRef.current && isDirtyRef.current) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  useEffect(() => {
    const beaconSave = (payload: AutosavePayload) => {
      const body = JSON.stringify(payload);
      const blob = new Blob([body], { type: "application/json" });
      // sendBeacon pode lancar sincronamente em alguns browsers (ex.: payload
      // acima do limite da fila). Tratamos como "nao enfileirado" para cair no
      // fallback fetch keepalive em vez de estourar o handler de evento.
      let queued = false;
      try {
        queued =
          typeof navigator.sendBeacon === "function" &&
          navigator.sendBeacon(endpoint, blob);
      } catch (err) {
        console.error("[auto-save] sendBeacon falhou:", err);
      }
      if (!queued) {
        // Fallback: sendBeacon indisponivel ou fila cheia. keepalive tem o
        // mesmo efeito (sobrevive ao unload) mas permite headers.
        fetch(endpoint, {
          method: "POST",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body,
        }).catch((err) => console.error("[auto-save] exceção:", err));
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "hidden") return;
      if (!isDirtyRef.current) return;
      const payload = getPayloadRef.current();
      if (payload) beaconSave(payload);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [endpoint]);
}
