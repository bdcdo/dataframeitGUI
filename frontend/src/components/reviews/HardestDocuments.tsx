"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { HardestDocumentData } from "@/lib/reviews/types";

interface HardestDocumentsProps {
  hardestDocuments: HardestDocumentData[];
  projectId: string;
}

export function HardestDocuments({
  hardestDocuments,
  projectId,
}: HardestDocumentsProps) {
  if (hardestDocuments.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Nenhum documento com dados de revisão disponíveis.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b">
            <th className="px-2 py-2 text-left text-xs font-medium">#</th>
            <th className="px-2 py-2 text-left text-xs font-medium">
              Documento
            </th>
            <th className="px-2 py-2 text-center text-xs font-medium">
              Campos
            </th>
            <th className="px-2 py-2 text-center text-xs font-medium">
              Erros
            </th>
            <th className="px-2 py-2 text-center text-xs font-medium">
              Taxa de Erro
            </th>
            <th className="px-2 py-2 text-center text-xs font-medium" />
          </tr>
        </thead>
        <tbody>
          {hardestDocuments.map((doc, idx) => (
            <tr key={doc.documentId} className="border-b last:border-0">
              <td className="px-2 py-2 text-muted-foreground tabular-nums">
                {idx + 1}
              </td>
              <td className="max-w-[240px] truncate px-2 py-2 font-medium" title={doc.documentTitle}>
                {doc.documentTitle}
              </td>
              <td className="px-2 py-2 text-center tabular-nums">
                {doc.totalFieldsReviewed}
              </td>
              <td className="px-2 py-2 text-center tabular-nums">
                {doc.totalErrors}
              </td>
              <td className="px-2 py-2">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-16 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        doc.errorRate > 50
                          ? "bg-red-500"
                          : doc.errorRate > 30
                            ? "bg-amber-500"
                            : "bg-emerald-500",
                      )}
                      style={{ width: `${Math.min(doc.errorRate, 100)}%` }}
                    />
                  </div>
                  <span
                    className={cn(
                      "text-xs font-medium tabular-nums",
                      doc.errorRate > 50
                        ? "text-red-600"
                        : doc.errorRate > 30
                          ? "text-amber-600"
                          : "text-emerald-600",
                    )}
                  >
                    {doc.errorRate}%
                  </span>
                </div>
              </td>
              <td className="px-2 py-2">
                <Button variant="ghost" size="sm" asChild title="Ver comparação">
                  <Link href={`/projects/${projectId}/compare?doc=${doc.documentId}`}>
                    <FileText className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
