"use client";

import { useCallback } from "react";
import { getDocumentForCoding } from "@/actions/documents";
import { useCachedResource } from "./useCachedResource";

/** Fatia de documento devolvida por `getDocumentForCoding`. Derivada da própria
 *  action para não driftar se o shape do retorno mudar. */
type CodingDocumentSlice = Awaited<
  ReturnType<typeof getDocumentForCoding>
>["document"];

export interface CodingDocument {
  document: CodingDocumentSlice;
  /** Respostas já existentes do pesquisador, saneadas contra o schema atual. */
  initialAnswers: Record<string, unknown>;
  /** Nota (`justifications._notes`) já existente, ou string vazia. */
  initialNotes: string;
}

/** Quantos docs de browse mantemos em cache por sessão. O modo Explorar percorre
 *  um conjunto ABERTO (potencialmente centenas de docs grandes); sem teto, o
 *  cache reteria o `text` integral de todo doc visitado pelo tempo de vida do
 *  `CodingPage`. O teto baixo cobre o ir-e-voltar imediato e limita o heap. */
const MAX_CACHED_DOCS = 3;

/**
 * Lazy-load do payload de codificação de um documento (texto + respostas +
 * notas existentes), com cache por id (com teto) e flag `loading` derivada.
 *
 * Wrapper de `useCachedResource`. O `fetcher` faz `catch → null` (erro como
 * valor), preservando o tri-state público: `undefined` (nada pedido / em voo),
 * `null` (fetch falhou — a UI oferece "tentar novamente" via `invalidate`), ou
 * o objeto `CodingDocument` carregado.
 *
 * ATENÇÃO — diferença crítica em relação a `useDocumentText`: aqui o cache
 * guarda respostas/notas MUTÁVEIS (o pesquisador edita e salva via
 * `saveResponse`), não texto imutável. O cache NÃO é invalidado sozinho: quem
 * salva (`handleBrowseSubmit`/`handleBrowseBack`) DEVE chamar `invalidate(docId)`,
 * senão reabrir o doc na mesma sessão re-semearia o estado pré-save (stale). O
 * código antigo evitava isso re-buscando a cada seleção.
 *
 * A chave de cache combina `projectId` e `documentId` (`projectId:documentId`),
 * não só o id do doc: assim um mesmo documentId em projetos distintos nunca
 * colide no cache. A API pública (`invalidate(docId)`) segue recebendo só o id —
 * o wrapper recompõe a chave internamente.
 */
export function useDocumentForCoding(
  projectId: string,
  documentId: string | null | undefined,
): {
  doc: CodingDocument | null | undefined;
  loading: boolean;
  invalidate: (docId: string) => void;
} {
  const fetcher = useCallback(
    async (key: string): Promise<CodingDocument | null> => {
      // `key` é `projectId:documentId`; o projectId já vem da closure, então só
      // precisamos do id (UUID, sem `:`) à direita do primeiro separador.
      const id = key.slice(key.indexOf(":") + 1);
      try {
        const result = await getDocumentForCoding(projectId, id);
        return {
          document: result.document,
          initialAnswers: result.existingAnswers ?? {},
          initialNotes:
            typeof result.existingJustifications?._notes === "string"
              ? (result.existingJustifications._notes as string)
              : "",
        };
      } catch (e) {
        console.error("Failed to load document:", e);
        return null;
      }
    },
    [projectId],
  );

  const cacheKey = documentId ? `${projectId}:${documentId}` : documentId;
  const {
    data,
    loading,
    invalidate: invalidateKey,
  } = useCachedResource(cacheKey, fetcher, {
    maxEntries: MAX_CACHED_DOCS,
  });
  const invalidate = useCallback(
    (docId: string) => invalidateKey(`${projectId}:${docId}`),
    [invalidateKey, projectId],
  );
  return { doc: data, loading, invalidate };
}
