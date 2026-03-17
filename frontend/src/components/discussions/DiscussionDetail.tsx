"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { addComment, resolveDiscussion, reopenDiscussion } from "@/actions/discussions";
import { toast } from "sonner";
import { ArrowLeft, FileText, CheckCircle2, RotateCcw } from "lucide-react";
import type { Profile } from "@/lib/types";

interface DiscussionData {
  id: string;
  title: string;
  body: string | null;
  status: "open" | "resolved";
  created_at: string;
  document_id: string | null;
  profiles: Pick<Profile, "first_name" | "last_name" | "email">;
  documents: { title: string | null; external_id: string | null } | null;
}

interface CommentData {
  id: string;
  body: string;
  created_at: string;
  profiles: Pick<Profile, "first_name" | "last_name" | "email">;
}

interface DiscussionDetailProps {
  projectId: string;
  discussion: DiscussionData;
  comments: CommentData[];
  isCoordinator: boolean;
}

export function DiscussionDetail({
  projectId,
  discussion,
  comments: initialComments,
  isCoordinator,
}: DiscussionDetailProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const viewAsResearcher =
    isCoordinator && searchParams.get("viewAs") === "pesquisador";
  const effectiveIsCoordinator = isCoordinator && !viewAsResearcher;

  const [commentBody, setCommentBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState(discussion.status);

  const authorName =
    [discussion.profiles?.first_name, discussion.profiles?.last_name]
      .filter(Boolean)
      .join(" ") || discussion.profiles?.email || "Usuário";

  const docLabel =
    discussion.documents?.title || discussion.documents?.external_id || null;

  const handleComment = async () => {
    if (!commentBody.trim()) return;
    setSubmitting(true);
    const result = await addComment(discussion.id, commentBody.trim());
    setSubmitting(false);

    if (result.error) {
      toast.error(result.error);
    } else {
      toast.success("Comentário adicionado!");
      setCommentBody("");
      router.refresh();
    }
  };

  const handleResolve = async () => {
    const result = await resolveDiscussion(discussion.id);
    if (result.error) {
      toast.error(result.error);
    } else {
      toast.success("Discussão resolvida!");
      setStatus("resolved");
      router.refresh();
    }
  };

  const handleReopen = async () => {
    const result = await reopenDiscussion(discussion.id);
    if (result.error) {
      toast.error(result.error);
    } else {
      toast.success("Discussão reaberta!");
      setStatus("open");
      router.refresh();
    }
  };

  return (
    <div className="space-y-6 p-6">
      {/* Back link */}
      <Link
        href={`/projects/${projectId}/discussions`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Voltar para discussões
      </Link>

      {/* Header */}
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold">{discussion.title}</h2>
              <Badge
                variant={status === "open" ? "default" : "secondary"}
                className={
                  status === "open"
                    ? "bg-green-600 text-white hover:bg-green-600"
                    : ""
                }
              >
                {status === "open" ? "Aberta" : "Resolvida"}
              </Badge>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
              <span>{authorName}</span>
              <span>
                {new Date(discussion.created_at).toLocaleDateString("pt-BR", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
          </div>

          {effectiveIsCoordinator && (
            <div>
              {status === "open" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleResolve}
                  className="text-green-600"
                >
                  <CheckCircle2 className="mr-1 h-4 w-4" />
                  Resolver
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={handleReopen}>
                  <RotateCcw className="mr-1 h-4 w-4" />
                  Reabrir
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Linked document */}
        {discussion.document_id && docLabel && (
          <Link
            href={`/projects/${projectId}/code?doc=${discussion.document_id}`}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-muted/50"
          >
            <FileText className="h-4 w-4 text-muted-foreground" />
            {docLabel}
          </Link>
        )}

        {/* Body */}
        {discussion.body && (
          <p className="whitespace-pre-wrap text-sm">{discussion.body}</p>
        )}
      </div>

      <Separator />

      {/* Comments */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium">
          Comentários ({initialComments.length})
        </h3>

        {initialComments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nenhum comentário ainda.
          </p>
        ) : (
          <div className="space-y-3">
            {initialComments.map((c) => {
              const cAuthor =
                [c.profiles?.first_name, c.profiles?.last_name]
                  .filter(Boolean)
                  .join(" ") || c.profiles?.email || "Usuário";
              return (
                <Card key={c.id} className="p-4">
                  <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {cAuthor}
                    </span>
                    <span>
                      {new Date(c.created_at).toLocaleDateString("pt-BR", {
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm">{c.body}</p>
                </Card>
              );
            })}
          </div>
        )}

        {/* Add comment */}
        {status === "open" && (
          <div className="space-y-2">
            <Textarea
              placeholder="Escreva um comentário..."
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
              rows={3}
            />
            <Button
              onClick={handleComment}
              disabled={submitting || !commentBody.trim()}
              className="bg-brand hover:bg-brand/90 text-brand-foreground"
            >
              {submitting ? "Enviando..." : "Comentar"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
