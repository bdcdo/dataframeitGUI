import { unstable_isUnrecognizedActionError } from "next/navigation";
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

// Server Action que o servidor não reconhece: a página foi aberta antes de um
// deploy que mudou os IDs das actions (rotação de
// NEXT_SERVER_ACTIONS_ENCRYPTION_KEY, ver README). Tentar de novo repete o ID
// antigo e falha igual; só recarregar traz os IDs novos. Ao reabrir, o rascunho
// guardado neste navegador é oferecido de volta (#608).
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
      error: unstable_isUnrecognizedActionError(error)
        ? CODING_SAVE_STALE_PAGE_ERROR
        : CODING_SAVE_TRANSPORT_ERROR,
    };
  }
}
