import { getAuthUser } from "@/lib/auth";
import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function PostLoginPage() {
  const { userId } = await auth();
  if (!userId) {
    redirect("/auth/login");
  }

  const user = await getAuthUser();

  if (user) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Nao foi possivel concluir seu acesso</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Sua sessao no Clerk existe, mas o vinculo com o Supabase ainda nao
            foi confirmado. Isso evita o loop entre login e dashboard.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href="/auth/login">
              <Button>Tentar login novamente</Button>
            </Link>
            <Link href="/api/debug-token" target="_blank">
              <Button variant="outline">Abrir debug do token</Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
