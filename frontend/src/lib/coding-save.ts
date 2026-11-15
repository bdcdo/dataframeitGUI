import { isStaleActionError, withErrorCode } from "@/lib/server-error";
import {
  saveResponse,
  type SaveResponseOpts,
  type SaveResponseResult,
} from "@/actions/responses";

// Mensagem única desde o #608. Havia uma segunda, para o autosave de navegação,
// porque aquele save era fire-and-forget e a troca de documento já tinha
// acontecido quando o toast aparecia — "nesta página" apontaria para o lugar
// errado. Removidos os gatilhos automáticos, todo save é aguardado e o
// pesquisador continua no documento quando o toast chega.
export const CODING_SAVE_TRANSPORT_ERROR =
  "Não foi possível salvar suas respostas. Suas alterações continuam nesta página. Tente novamente sem recarregar.";

// Versão da codificação de `STALE_PAGE_ERROR` (ver `isStaleActionError`): diz
// também que, ao reabrir, o rascunho guardado neste navegador é oferecido de
// volta (#608).
export const CODING_SAVE_STALE_PAGE_ERROR =
  "Não foi possível salvar: o sistema foi atualizado depois que esta página abriu. Recarregue a página para voltar a salvar — as alterações guardadas neste navegador serão oferecidas de volta.";

// Server Actions rejeitam a Promise quando o transporte falha antes de o
// handler executar. Normalizar essa rejeição preserva um único contrato para
// todos os callers: o rascunho só é limpo quando `success` é true.
export async function saveCodingResponse(
  projectId: string,
  documentId: string,
  answers: Record<string, unknown>,
  opts: SaveResponseOpts,
): Promise<SaveResponseResult> {
  try {
    return await saveResponse(projectId, documentId, answers, opts);
  } catch (error) {
    return {
      success: false,
      error: isStaleActionError(error)
        ? CODING_SAVE_STALE_PAGE_ERROR
        : withErrorCode(error, CODING_SAVE_TRANSPORT_ERROR),
    };
  }
}
