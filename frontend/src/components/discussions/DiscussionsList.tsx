"use client";

import { useState } from "react";
import Link from "next/link";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { CreateDiscussionDialog } from "./CreateDiscussionDialog";
import { MessageSquare, FileText } from "lucide-react";
import type { Profile } from "@/lib/types";

export interface DiscussionItem {
  id: string;
  title: string;
  body: string | null;
  status: "open" | "resolved";
  created_at: string;
  document_id: string | null;
  created_by: string;
  profiles: Pick<Profile, "first_name" | "last_name" | "email">;
  documents: { title: string | null; external_id: string | null } | null;
  comment_count: number;
}

interface DiscussionsListProps {
  projectId: string;
  discussions: DiscussionItem[];
  documents: { id: string; title: string | null; external_id: string | null }[];
}

export function DiscussionsList({
  projectId,
  discussions,
  documents,
}: DiscussionsListProps) {
  const [filter, setFilter] = useState<"all" | "open" | "resolved">("all");

  const filtered = discussions.filter((d) => {
    if (filter === "open") return d.status === "open";
    if (filter === "resolved") return d.status === "resolved";
    return true;
  });

  const openCount = discussions.filter((d) => d.status === "open").length;
  const resolvedCount = discussions.filter((d) => d.status === "resolved").length;

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Discussões</h2>
        <CreateDiscussionDialog projectId={projectId} documents={documents} />
      </div>

      <Tabs
        value={filter}
        onValueChange={(v) => setFilter(v as "all" | "open" | "resolved")}
      >
        <TabsList>
          <TabsTrigger value="all">
            Todas ({discussions.length})
          </TabsTrigger>
          <TabsTrigger value="open">
            Abertas ({openCount})
          </TabsTrigger>
          <TabsTrigger value="resolved">
            Resolvidas ({resolvedCount})
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
          <MessageSquare className="mb-2 h-10 w-10 opacity-50" />
          <p>Nenhuma discussão {filter === "open" ? "aberta" : filter === "resolved" ? "resolvida" : "ainda"}.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((d) => {
            const authorName =
              [d.profiles?.first_name, d.profiles?.last_name]
                .filter(Boolean)
                .join(" ") || d.profiles?.email || "Usuário";
            const docLabel =
              d.documents?.title || d.documents?.external_id || null;

            return (
              <Link
                key={d.id}
                href={`/projects/${projectId}/discussions/${d.id}`}
              >
                <Card className="flex items-start gap-3 p-4 transition-colors hover:bg-muted/50">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{d.title}</span>
                      <Badge
                        variant={d.status === "open" ? "default" : "secondary"}
                        className={
                          d.status === "open"
                            ? "bg-green-600 text-white hover:bg-green-600"
                            : ""
                        }
                      >
                        {d.status === "open" ? "Aberta" : "Resolvida"}
                      </Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>{authorName}</span>
                      <span>
                        {new Date(d.created_at).toLocaleDateString("pt-BR")}
                      </span>
                      {docLabel && (
                        <span className="flex items-center gap-1">
                          <FileText className="h-3 w-3" />
                          {docLabel}
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <MessageSquare className="h-3 w-3" />
                        {d.comment_count}
                      </span>
                    </div>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
