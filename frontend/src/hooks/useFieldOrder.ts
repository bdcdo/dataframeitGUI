"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getResearcherFieldOrder,
  saveResearcherFieldOrder,
} from "@/actions/field-order";
import { toast } from "sonner";

/**
 * Ordem custom das perguntas do pesquisador, com save debounced (500ms), flush
 * no unmount e guarda anti-corrida.
 *
 * A guarda `pendingOrderRef`: se o pesquisador arrasta antes do load do banco
 * resolver, o drag tem prioridade — o valor vindo do banco é descartado para
 * não sobrescrever a intenção recente do usuário.
 *
 * `applyFieldOrder(fields, fieldOrder)` fica no caller (precisa de `fields`).
 * `flushOrderSave` é exposto para teste; também roda no unmount.
 */
export function useFieldOrder(projectId: string): {
  fieldOrder: string[] | null;
  handleReorder: (newOrder: string[]) => void;
  flushOrderSave: () => void;
} {
  const [fieldOrder, setFieldOrder] = useState<string[] | null>(null);
  const reorderSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingOrderRef = useRef<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getResearcherFieldOrder(projectId).then(({ order }) => {
      // Se o pesquisador ja arrastou antes da load resolver, o drag tem
      // prioridade — descartamos o valor vindo do banco para nao sobrescrever
      // a intencao recente do usuario.
      if (cancelled || pendingOrderRef.current) return;
      setFieldOrder(order);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const doSave = useCallback(
    (order: string[]) => {
      saveResearcherFieldOrder(projectId, order).then((r) => {
        if (!r.success) {
          console.error("[field-order save]", r.error);
          toast.error("Não foi possível salvar a ordem das perguntas");
        }
      });
    },
    [projectId],
  );

  const flushOrderSave = useCallback(() => {
    if (reorderSaveTimer.current) {
      clearTimeout(reorderSaveTimer.current);
      reorderSaveTimer.current = null;
    }
    const pending = pendingOrderRef.current;
    if (!pending) return;
    pendingOrderRef.current = null;
    doSave(pending);
  }, [doSave]);

  const handleReorder = useCallback(
    (newOrder: string[]) => {
      setFieldOrder(newOrder);
      pendingOrderRef.current = newOrder;
      if (reorderSaveTimer.current) clearTimeout(reorderSaveTimer.current);
      reorderSaveTimer.current = setTimeout(() => {
        reorderSaveTimer.current = null;
        const pending = pendingOrderRef.current;
        if (!pending) return;
        pendingOrderRef.current = null;
        doSave(pending);
      }, 500);
    },
    [doSave],
  );

  useEffect(() => {
    return () => {
      flushOrderSave();
    };
  }, [flushOrderSave]);

  return { fieldOrder, handleReorder, flushOrderSave };
}
