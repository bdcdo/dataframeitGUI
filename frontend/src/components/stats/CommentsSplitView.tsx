"use client";

import { useState } from "react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { DocumentReader } from "@/components/coding/DocumentReader";
import { Loader2 } from "lucide-react";
import { useDocumentText } from "@/hooks/useDocumentText";
import { useDocGroupNavigation } from "./useDocGroupNavigation";
import { useCommentResolution } from "./useCommentResolution";
import { SplitViewNavBar } from "./SplitViewNavBar";
import { CommentListPanel } from "./CommentListPanel";
import type { ReviewComment } from "./comment-card-utils";

interface CommentsSplitViewProps {
  projectId: string;
  comments: ReviewComment[];
  initialDocId: string;
  onBack: () => void;
}

export function CommentsSplitView({
  projectId,
  comments,
  initialDocId,
  onBack,
}: CommentsSplitViewProps) {
  const [showResolved, setShowResolved] = useState(false);
  const { docGroups, docIndex, setDocIndex, currentGroup, currentDocId } =
    useDocGroupNavigation(comments, initialDocId);
  const { isPending, handleResolve, handleReopen } = useCommentResolution(projectId);
  const { text: currentText, loading: loadingText } = useDocumentText(
    projectId,
    currentDocId,
  );

  if (!currentGroup) return null;

  return (
    <div className="flex h-[calc(100vh-12rem)] flex-col">
      <SplitViewNavBar
        title={currentGroup.title}
        onBack={onBack}
        docIndex={docIndex}
        docCount={docGroups.length}
        onPrev={() => setDocIndex((i) => i - 1)}
        onNext={() => setDocIndex((i) => i + 1)}
      />

      <ResizablePanelGroup className="flex-1">
        <ResizablePanel defaultSize={55} minSize={25}>
          {loadingText || !currentText ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <DocumentReader text={currentText} />
          )}
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={45} minSize={25}>
          <CommentListPanel
            comments={currentGroup.comments}
            showResolved={showResolved}
            onShowResolvedChange={setShowResolved}
            isPending={isPending}
            onResolve={handleResolve}
            onReopen={handleReopen}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
