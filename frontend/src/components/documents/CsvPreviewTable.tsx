"use client";

import { useMemo } from "react";
import { makeId } from "@/lib/utils";

interface CsvPreviewTableProps {
  rows: Record<string, string>[];
  columns: string[];
}

const newRowId = () => makeId("csv-preview");

export function CsvPreviewTable({ rows, columns }: CsvPreviewTableProps) {
  // Assign a stable id per preview row once. The slice never reorders, but a
  // content/index key would either collide or trip no-array-index-as-key; an id
  // computed off the (stable) `rows` reference keeps the JSX key index-free.
  const previewRows = useMemo(
    () => rows.slice(0, 5).map((row) => ({ id: newRowId(), row })),
    [rows]
  );

  return (
    <div className="overflow-x-auto rounded border">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted/50">
            {columns.map((c) => <th key={c} className="px-2 py-1 text-left">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {previewRows.map(({ id, row }) => (
            <tr key={id} className="border-t">
              {columns.map((c) => <td key={c} className="max-w-xs truncate px-2 py-1">{row[c]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
