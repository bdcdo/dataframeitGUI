import type { Metadata } from "next";
import { SignIn } from "@clerk/nextjs";

export const metadata: Metadata = {
  title: "Entrar · GUI Análise Sistemática",
  description: "Acessar a plataforma de análise sistemática",
};

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <SignIn
        fallbackRedirectUrl="/auth/post-login"
        forceRedirectUrl="/auth/post-login"
      />
    </div>
  );
}
