"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { savePrompt } from "@/actions/schema";
import { toast } from "sonner";

const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), { ssr: false });

interface PromptEditorProps {
  projectId: string;
  initialPrompt: string | null;
}

export function PromptEditor({ projectId, initialPrompt }: PromptEditorProps) {
  const [prompt, setPrompt] = useState(initialPrompt || "");
  const [loading, setLoading] = useState(false);

  const handleSave = async () => {
    setLoading(true);
    try {
      await savePrompt(projectId, prompt);
      toast.success("Prompt salvo!");
    } catch (e: any) {
      toast.error(e.message);
    }
    setLoading(false);
  };

  return (
    <div className="flex h-[calc(100vh-140px)] flex-col">
      <div className="flex-1">
        <MonacoEditor
          height="100%"
          language="plaintext"
          theme="vs-light"
          value={prompt}
          onChange={(val) => setPrompt(val || "")}
          options={{ minimap: { enabled: false }, fontSize: 14, wordWrap: "on" }}
        />
      </div>
      <div className="flex items-center gap-2 border-t px-4 py-2">
        <Button size="sm" onClick={handleSave} disabled={loading} className="bg-brand hover:bg-brand/90 text-brand-foreground">
          Salvar
        </Button>
      </div>
    </div>
  );
}
