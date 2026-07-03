import { saveResponse } from "@/actions/responses";
import { toast } from "sonner";

interface AutosaveDirtyDocParams {
  projectId: string;
  docId: string;
  answers: Record<string, unknown>;
  notes: string;
  markClean: (docId: string) => void;
  /** Executado só no sucesso, após `markClean` (ex.: bump otimista da lista). */
  onSuccess?: () => void;
}

/**
 * Autosave fire-and-forget de um doc sujo ao navegar (trocar de doc ou de
 * ordenação no modo Atribuídos). Salva com `isAutoSave: true`, limpa a sujeira
 * no sucesso e mostra toast no erro. O caller é responsável pelo guard de
 * `isDirty` antes de chamar.
 *
 * O back do modo Explorar NÃO usa este helper: lá o save é aguardado (`await`)
 * para manter o rascunho intacto se falhar (#257) — semântica diferente.
 */
export function autosaveDirtyDoc({
  projectId,
  docId,
  answers,
  notes,
  markClean,
  onSuccess,
}: AutosaveDirtyDocParams): void {
  saveResponse(projectId, docId, answers, { notes, isAutoSave: true })
    .then((result) => {
      if (result.success) {
        markClean(docId);
        onSuccess?.();
      } else {
        toast.error(result.error || "Erro ao salvar respostas");
      }
    })
    .catch(() => {
      toast.error("Erro ao salvar respostas");
    });
}
