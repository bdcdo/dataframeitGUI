import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "GUI Análise Sistemática",
  description: "Plataforma de análise de conteúdo de documentos com LLM",
};

export default function Home() {
  redirect("/dashboard");
}
