import { isDeepStrictEqual } from "node:util";

// O banco aceita mudar `projects.pydantic_fields` só junto com
// `schema_revision` + 1, e recusa avançar a revisão sem mudança de schema
// ("schema_revision cannot change without a schema change"). Um gerador de
// fixture que regrava o schema a cada execução precisa, então, saber se os
// campos do código diferem dos gravados. A comparação é sobre o JSON: o jsonb
// devolve as chaves noutra ordem (o `isDeepStrictEqual` não liga para ordem de
// chave) e não guarda propriedade `undefined`, que o round-trip pelo JSON tira.
export function sameStoredFields(stored: unknown, fields: unknown): boolean {
  return isDeepStrictEqual(stored, JSON.parse(JSON.stringify(fields)));
}
