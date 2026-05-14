// Ordena documentos pelo timestamp de codificacao do proprio pesquisador
// (responses.updated_at), do mais recente para o mais antigo. Documentos ainda
// nao codificados vao para o fim, preservando a ordem original entre si.
//
// Os timestamps vem do PostgREST em formato ISO consistente, entao a comparacao
// lexicografica direta (`<`/`>`) ordena corretamente sem precisar de Date/parse.
export function sortByRecent<T extends { id: string }>(
  docs: T[],
  codedAtByDoc: Record<string, string>,
): T[] {
  return docs
    .map((doc, index) => ({ doc, index }))
    .sort((a, b) => {
      const ta = codedAtByDoc[a.doc.id];
      const tb = codedAtByDoc[b.doc.id];
      if (ta && tb) {
        if (ta === tb) return a.index - b.index;
        return tb < ta ? -1 : 1;
      }
      if (ta) return -1;
      if (tb) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.doc);
}
