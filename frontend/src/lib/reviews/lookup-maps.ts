import type { PydanticField } from "@/lib/types";

interface ReviewDocumentMetadata {
  id: string;
  title: string | null;
  external_id: string | null;
}

export function buildReviewLookupMaps(
  fields: PydanticField[],
  documents: ReviewDocumentMetadata[] | null,
) {
  return {
    fieldMap: new Map(fields.map((field) => [field.name, field])),
    docMap: new Map(
      documents?.map((document) => [
        document.id,
        document.title || document.external_id || document.id,
      ]) || [],
    ),
  };
}
