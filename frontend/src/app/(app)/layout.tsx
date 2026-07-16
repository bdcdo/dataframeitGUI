import { requirePageAuthUser } from "@/lib/page-auth";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // O helper preserva os estados recuperáveis e `resolveAuth` é cache()d, então
  // layouts e pages filhos compartilham uma única resolução por request.
  await requirePageAuthUser();

  return <>{children}</>;
}
