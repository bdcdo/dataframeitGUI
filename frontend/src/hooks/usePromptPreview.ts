"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { fetchFastAPI } from "@/lib/api";

/**
 * Busca o preview do prompt final no backend (`/api/llm/preview-prompt`),
 * montado lá para não duplicar a lógica de `_build_prompt` no frontend.
 *
 * Debounce de 300ms porque `prompt` muda a cada tecla na textarea. Todo
 * `setState` acontece **dentro** do callback do `setTimeout` (postergado) — não
 * há reset síncrono de estado no corpo do effect, o que elimina o
 * `no-adjust-state-on-prop-change` que apontava o `setPreviewError(null)`
 * síncrono no componente. Durante a digitação o preview anterior continua
 * visível em vez de piscar "Carregando…" a cada tecla.
 */
export function usePromptPreview(
  projectDescription: string,
  prompt: string,
  enabled: boolean,
): {
  previewPrompt: string | null;
  previewLoading: boolean;
  previewError: string | null;
} {
  const { getToken } = useAuth();
  const [previewPrompt, setPreviewPrompt] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled) return;
      setPreviewError(null);
      setPreviewLoading(true);
      try {
        const token = await getToken({ template: "supabase" });
        const res = await fetchFastAPI<{ prompt: string }>(
          "/api/llm/preview-prompt",
          {
            method: "POST",
            body: JSON.stringify({
              project_description: projectDescription,
              prompt_template: prompt,
            }),
          },
          token ?? undefined,
        );
        if (!cancelled) setPreviewPrompt(res.prompt);
      } catch (e) {
        if (!cancelled)
          setPreviewError(
            e instanceof Error ? e.message : "Erro ao carregar preview",
          );
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, prompt, projectDescription, getToken]);

  return { previewPrompt, previewLoading, previewError };
}
