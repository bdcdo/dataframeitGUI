"use client";

import { useState } from "react";
import { DocumentList } from "@/components/documents/DocumentList";
import { DocumentPreview } from "@/components/documents/DocumentPreview";
import type { Document } from "@/lib/types";

interface DocumentsPageClientProps {
  documents: (Document & { responseCount?: number })[];
}

export function DocumentsPageClient({ documents }: DocumentsPageClientProps) {
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);

  return (
    <>
      <DocumentList documents={documents} onSelect={setSelectedDoc} />
      <DocumentPreview
        document={selectedDoc}
        open={!!selectedDoc}
        onClose={() => setSelectedDoc(null)}
      />
    </>
  );
}
