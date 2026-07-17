import {
  saveResponse,
  type SaveResponseOpts,
  type SaveResponseResult,
} from "@/actions/responses";
import { toast } from "sonner";

export const CODING_SAVE_TRANSPORT_ERROR =
  "Não foi possível salvar suas respostas. Suas alterações continuam nesta página. Tente novamente sem recarregar.";

// Server Actions rejeitam a Promise quando o transporte falha antes de o
// handler executar. Normalizar essa rejeição preserva um único contrato para
// todos os callers: o rascunho só é limpo quando `success` é true.
export async function saveCodingResponse(
  projectId: string,
  documentId: string,
  answers: Record<string, unknown>,
  opts: SaveResponseOpts = {},
): Promise<SaveResponseResult> {
  try {
    return await saveResponse(projectId, documentId, answers, opts);
  } catch {
    return { success: false, error: CODING_SAVE_TRANSPORT_ERROR };
  }
}

interface AutosaveDirtyDocParams {
  projectId: string;
  docId: string;
  answers: Record<string, unknown>;
  notes: string;
  markClean: (docId: string) => void;
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
}: AutosaveDirtyDocParams): void {
  void saveCodingResponse(projectId, docId, answers, {
    notes,
    isAutoSave: true,
  }).then((result) => {
    if (result.success) {
      markClean(docId);
    } else {
      toast.error(result.error);
    }
  });
}
